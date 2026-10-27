/**
 * Embedded OpenCode lifecycle plugin (committed embed output, D-011/D-022 pattern).
 *
 * Source of truth for the file `workjournal setup` writes to OpenCode's
 * auto-loaded plugin directory. It uses only the OpenCode plugin surface
 * verified against an installed plugin: default export `{ id, setup }`, an
 * async-iterable `ctx.event.subscribe({ signal })`, and `ctx.location.directory`.
 * Events are project-scoped by looking the workspace up in Core's project list;
 * Core's ingestion endpoint requires exactly one project per request.
 */

export const opencodePluginVersion = '2';

export const opencodePluginSource = String.raw`
/**
 * WorkJournal lifecycle plugin for OpenCode.
 *
 * Observes session lifecycle signals and POSTs canonical ledger envelopes to
 * Core's POST /api/ingest/events. Delivery uses a bounded in-memory queue with
 * backoff when Core is down; the plugin never starts Core itself. Tool-call
 * logging is intentionally absent: Core only ingests ledger event types.
 */

const AGENT_ID = 'opencode';
const SOURCE = 'agent:opencode';
const CORE_URL = ((typeof process !== 'undefined' && process.env && process.env.WORKJOURNAL_CORE_URL) || 'http://127.0.0.1:3737').replace(/\/+$/, '');
const INGEST_PATH = '/api/ingest/events';
const PROJECTS_PATH = '/api/projects?available=true';
const MAX_QUEUE = 100;
const BATCH_SIZE = 50;
const RETRY_MS = 5000;

/** Diagnostics sink; OpenCode has no logger on the plugin context. */
const report = function report(message) {
  console.warn(message);
};

function newEventId() {
  const cryptoApi = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return 'wj-' + cryptoApi.randomUUID();
  }
  return 'wj-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

function envelope(type, payload) {
  return {
    event_id: newEventId(),
    type: type,
    source: SOURCE,
    actor: AGENT_ID,
    payload: payload,
  };
}

/**
 * Canonical comparison form for a filesystem path. Mirrors Core's
 * normalizeRootPath: a git-bash /c/Users/... (or WSL /mnt/c/Users/...)
 * root becomes c:/Users/..., backslashes become forward slashes, trailing
 * slashes are dropped, and Windows paths are case-folded. Without this, a
 * project registered through a shell that reported a POSIX-style path never
 * matched the native workspace path and every event was dropped.
 */
function canonicalPath(value) {
  if (typeof value !== 'string') return '';
  let path = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const drive = /^\/(?:mnt\/)?([A-Za-z])(?:\/(.*))?$/.exec(path);
  if (drive) path = drive[1] + ':' + (drive[2] ? '/' + drive[2] : '');
  if (typeof process !== 'undefined' && process.platform === 'win32') path = path.toLowerCase();
  return path;
}

function matchProject(projects, directory) {
  const dir = canonicalPath(directory);
  if (!dir) return undefined;
  let best;
  for (const project of projects) {
    const root = canonicalPath(project.root_path);
    if (!root) continue;
    if (dir === root || dir.startsWith(root + '/')) {
      if (!best || root.length > canonicalPath(best.root_path).length) best = project;
    }
  }
  return best;
}

async function postBatch(events, projectId) {
  try {
    const res = await fetch(
      CORE_URL + INGEST_PATH + '?project_id=' + encodeURIComponent(projectId),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: events }),
      },
    );
    if (res.ok) return true;
    if (res.status >= 400 && res.status < 500) {
      console.warn('[workjournal] ingest rejected with status ' + res.status);
      return true;
    }
    return false;
  } catch (_error) {
    return false;
  }
}

class DeliveryQueue {
  constructor() {
    this.items = [];
    this.flushing = false;
    this.retryTimer = undefined;
    this.unmatched = new Set();
  }

  push(item) {
    if (this.items.length >= MAX_QUEUE) this.items.shift();
    this.items.push(item);
    void this.flush();
  }

  /**
   * A failed flush leaves the batch in the queue. Without a timer, those
   * events are only retried when the next event arrives, so a short Core
   * outage silently loses the tail of a session.
   */
  scheduleRetry() {
    if (this.retryTimer !== undefined || this.items.length === 0) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.flush();
    }, RETRY_MS);
  }

  reportUnmatched(directory, projects) {
    if (this.unmatched.has(directory)) return;
    this.unmatched.add(directory);
    const roots = projects
      .map((project) => project.root_path)
      .filter(Boolean)
      .slice(0, 5)
      .join(', ');
    report(
      '[workjournal] no registered project matches "' + directory + '" (registered roots: ' + (roots || 'none') + ')',
    );
  }

  async flush() {
    if (this.flushing || this.items.length === 0) return;
    this.flushing = true;
    try {
      let projects;
      try {
        const res = await fetch(CORE_URL + PROJECTS_PATH);
        if (res.ok) projects = await res.json();
      } catch (_error) {
        projects = undefined;
      }

      if (!Array.isArray(projects)) return;

      const groups = new Map();
      for (const item of this.items) {
        const project = matchProject(projects, item.directory);
        if (!project) {
          this.reportUnmatched(item.directory, projects);
          continue;
        }
        const list = groups.get(project.id) || [];
        list.push(item);
        groups.set(project.id, list);
      }

      const remaining = [];
      for (const entry of groups) {
        const projectId = entry[0];
        const items = entry[1];
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
          const batch = items.slice(i, i + BATCH_SIZE);
          const delivered = await postBatch(batch.map((item) => item.envelope), projectId);
          if (!delivered) remaining.push.apply(remaining, batch);
        }
      }

      this.items = remaining;
    } finally {
      this.flushing = false;
      this.scheduleRetry();
    }
  }

  dispose() {
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    return this.flush();
  }
}

const plugin = {
  id: 'workjournal',

  async setup(ctx) {
    const directory = (ctx && ctx.location && ctx.location.directory) || (typeof process !== 'undefined' ? process.cwd() : '');
    const queue = new DeliveryQueue();
    const unload = new AbortController();
    const ended = new Set();

    function emit(type, payload) {
      queue.push({ directory: directory, envelope: envelope(type, payload) });
    }

    const eventTask = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: unload.signal })) {
          const data = (event && event.data) || {};
          const sessionId = data.sessionID || data.session_id;
          if (!sessionId) continue;
          const payload = { agent_id: AGENT_ID, session_id: sessionId };

          switch (event.type) {
            case 'session.created':
              emit('agent_session_started', payload);
              break;
            case 'session.execution.succeeded':
            case 'session.execution.failed':
            case 'session.execution.interrupted': {
              if (ended.has(sessionId)) break;
              ended.add(sessionId);
              const reason =
                event.type === 'session.execution.succeeded'
                  ? 'completed'
                  : event.type === 'session.execution.interrupted'
                    ? 'interrupted'
                    : 'failed';
              emit('agent_session_ended', { agent_id: AGENT_ID, session_id: sessionId, reason: reason });
              break;
            }
            case 'session.deleted':
              if (!ended.has(sessionId)) {
                ended.add(sessionId);
                emit('agent_session_ended', { agent_id: AGENT_ID, session_id: sessionId, reason: 'completed' });
              }
              break;
            case 'session.idle':
              emit('agent_idle', payload);
              break;
            case 'session.error': {
              const raw = (data.error && data.error.message) || data.message || 'error';
              emit('agent_interrupted', {
                agent_id: AGENT_ID,
                session_id: sessionId,
                reason: String(raw).slice(0, 2000),
              });
              break;
            }
            default:
              break;
          }
        }
      } catch (error) {
        if (!unload.signal.aborted) console.warn('[workjournal] event stream failed', error);
      }
    })();

    return async () => {
      unload.abort();
      try {
        await eventTask;
      } catch (_error) {
        /* best-effort shutdown */
      }
      await queue.dispose();
    };
  },
};

export default plugin;
`;
