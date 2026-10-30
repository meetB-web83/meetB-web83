/**
 * Embedded OpenCode lifecycle plugin (committed embed output, D-011/D-022 pattern).
 *
 * Source of truth for the file `workjournal setup` writes to OpenCode's
 * auto-loaded plugin directory. Uses only the OpenCode V2 plugin surface
 * verified against https://opencode.ai/docs/plugins/#events:
 * default export `{ id, setup }`, `ctx.event.subscribe({ signal })` for session
 * lifecycle events, and `tool.execute.before` / `tool.execute.after` hooks for
 * per-tool activity. Events are project-scoped by matching the workspace against
 * Core's registered project roots; Core's ingestion endpoint requires exactly
 * one project per request.
 */

export const opencodePluginVersion = '3';

export const opencodePluginSource = String.raw`
/**
 * WorkJournal lifecycle plugin for OpenCode.
 *
 * Observes OpenCode V2 session lifecycle events and tool execution hooks, and
 * POSTs canonical ledger envelopes to Core's POST /api/ingest/events. Delivery
 * uses a bounded in-memory queue with backoff when Core is down; the plugin
 * never starts Core itself.
 *
 * Session events (verified against OpenCode V2 plugin API):
 *   session.created        -> agent_session_started
 *   session.deleted        -> agent_session_ended (reason: completed)
 *   session.error          -> agent_interrupted
 *   session.idle           -> agent_idle
 *   session.status         -> agent_session_ended (from data.status)
 *   session.updated        -> agent_session_ended (from data.status)
 *
 * Tool hooks:
 *   tool.execute.before    -> track tool call, capture file path
 *   tool.execute.after     -> track success/failure, capture file path
 *
 * On session end, emits agent_session_ended with duration_ms,
 * tool_call_count, failed_tool_call_count, and files_touched.
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

/** Per-session state accumulated during the session for the run summary. */
const sessionState = new Map(); // sessionId -> { startTime, toolCalls, failedToolCalls, filesTouched, ended, activeTools }

function getSession(sessionId) {
  let s = sessionState.get(sessionId);
  if (!s) {
    s = { startTime: Date.now(), toolCalls: 0, failedToolCalls: 0, filesTouched: new Set(), ended: false, activeTools: new Map() };
    sessionState.set(sessionId, s);
  }
  return s;
}

function endSession(sessionId, reason, extra) {
  const s = sessionState.get(sessionId);
  if (!s || s.ended) return null;
  s.ended = true;
  const durationMs = Date.now() - s.startTime;
  sessionState.delete(sessionId);
  return {
    ...extra,
    agent_id: AGENT_ID,
    session_id: sessionId,
    reason: reason,
    duration_ms: Math.round(durationMs),
    tool_call_count: s.toolCalls,
    failed_tool_call_count: s.failedToolCalls,
    files_touched: Array.from(s.filesTouched).slice(0, 100),
  };
}

function captureFilePath(sessionId, args) {
  if (!args || typeof args !== 'object') return;
  const s = getSession(sessionId);
  const filePath = args.filePath || args.path || args.file;
  if (filePath && typeof filePath === 'string') {
    s.filesTouched.add(filePath);
  }
}

/** Extract a short target identifier (file path or command) from tool args, redacting secrets. */
function captureTarget(args) {
  if (!args || typeof args !== 'object') return undefined;
  const target = args.filePath || args.path || args.file || args.command || args.query;
  if (!target || typeof target !== 'string') return undefined;
  return redactSecrets(target).slice(0, 1024);
}

/** Redact known secret patterns from a string. Mirrors Core's export secret filter. */
function redactSecrets(text) {
  return String(text)
    .replace(/sk-[A-Za-z0-9]{20,}/g, '[REDACTED]')
    .replace(/ghp_[A-Za-z0-9]{36}/g, '[REDACTED]')
    .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED]')
    .replace(/(password|token|secret|api_key)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/-----BEGIN [A-Z ]+-----([\s\S]*?)-----END [A-Z ]+-----/g, '[REDACTED KEY]');
}

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

    function emit(type, payload) {
      queue.push({ directory: directory, envelope: envelope(type, payload) });
    }

    const eventTask = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: unload.signal })) {
          const data = (event && event.data) || {};
          const sessionId = data.sessionID || data.session_id;
          if (!sessionId) continue;

          switch (event.type) {
            case 'session.created': {
              getSession(sessionId);
              emit('agent_session_started', { agent_id: AGENT_ID, session_id: sessionId });
              break;
            }
            case 'session.deleted': {
              const ended = endSession(sessionId, 'completed');
              if (ended) emit('agent_session_ended', ended);
              break;
            }
            case 'session.status':
            case 'session.updated': {
              const status = data.status;
              if (!status) break;
              const ended = endSession(sessionId, status === 'timeout' ? 'timeout' : status === 'interrupted' ? 'interrupted' : status === 'failed' ? 'failed' : 'completed');
              if (ended) emit('agent_session_ended', ended);
              break;
            }
            case 'session.idle':
              emit('agent_idle', { agent_id: AGENT_ID, session_id: sessionId });
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

    const teardown = async () => {
      unload.abort();
      try {
        await eventTask;
      } catch (_error) {
        /* best-effort shutdown */
      }
      await queue.dispose();
    };

    // Tool execution hooks — registered by OpenCode from the returned object.
    teardown['tool.execute.before'] = async (input, output) => {
      const sessionId = (input && input.sessionID) || (input && input.session_id) || (output && output.sessionID) || (output && output.session_id) || 'unknown';
      const s = getSession(sessionId);
      s.toolCalls += 1;
      const toolName = input && input.tool ? String(input.tool) : 'unknown';
      s.activeTools.set(toolName + '_' + Date.now(), { startTime: Date.now(), tool: toolName, args: input && input.args });
      captureFilePath(sessionId, input && input.args);
      captureFilePath(sessionId, output && output.args);
    };

    teardown['tool.execute.after'] = async (input, output) => {
      const sessionId = (input && input.sessionID) || (input && input.session_id) || (output && output.sessionID) || (output && output.session_id) || 'unknown';
      const s = getSession(sessionId);
      if (output && output.error) s.failedToolCalls += 1;
      captureFilePath(sessionId, input && input.args);
      captureFilePath(sessionId, output && output.args);

      const toolName = input && input.tool ? String(input.tool) : 'unknown';
      const status = output && output.error ? 'failed' : 'succeeded';
      const target = captureTarget(input && input.args);
      const durationMs = Date.now() - s.startTime;

      emit('agent_tool_call', {
        agent_id: AGENT_ID,
        session_id: sessionId,
        tool: toolName,
        status: status,
        duration_ms: Math.max(0, Math.round(durationMs)),
        ...(target ? { target: target } : {}),
      });
    };

    return teardown;
  },
};

export default plugin;
`;
