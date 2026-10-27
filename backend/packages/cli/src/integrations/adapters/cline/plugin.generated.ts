/**
 * Embedded Cline lifecycle plugin (committed embed output, D-011/D-022 pattern).
 *
 * Cline 3.x loads an AgentExtension module that default-exports
 * `{ name, manifest, setup?, hooks? }`. The plugin is installed as a package
 * directory under `~/.cline/plugins/workjournal/` (or the project's
 * `.cline/plugins/`) with `package.json` marking it as ESM.
 *
 * Cline's runtime event stream is the source of lifecycle signals:
 * `run-started`, `run-finished`, and `run-failed`. The `afterTool` hook adds
 * one `agent_tool_call` per completed tool call; the run summary rides on
 * `agent_session_ended`.
 */

export const clinePluginVersion = '3';

export const clinePluginSource = String.raw`
/**
 * WorkJournal lifecycle plugin for Cline.
 *
 * Posts canonical ledger envelopes to Core's POST /api/ingest/events. Events
 * are project-scoped by matching the session workspace against Core's project
 * list. Delivery uses a bounded queue with backoff; the plugin never starts
 * Core itself. Tool calls are recorded as one agent_tool_call each with a
 * bounded, secret-redacted target; the aggregate run summary is attached to
 * agent_session_ended.
 */

const AGENT_ID = 'cline';
const SOURCE = 'agent:cline';
const CORE_URL = ((typeof process !== 'undefined' && process.env && process.env.WORKJOURNAL_CORE_URL) || 'http://127.0.0.1:3737').replace(/\/+$/, '');
const INGEST_PATH = '/api/ingest/events';
const PROJECTS_PATH = '/api/projects?available=true';
const MAX_QUEUE = 500;
const BATCH_SIZE = 50;
const RETRY_MS = 5000;
const MAX_TARGET = 1024;
const MAX_FILES = 100;

let workspaceRoot = '';

/** Diagnostics sink: setup() swaps in the host logger when one is provided. */
let report = function report(message) {
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

/**
 * Tool targets come from model-supplied inputs (paths, commands, queries), so
 * they can contain credentials. The same secret shapes Core's export filter
 * masks are redacted here before the value ever leaves the process, then the
 * result is truncated to the payload bound.
 */
const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/g,
  /ghp_[a-zA-Z0-9]{20,}/g,
  /github_pat_[a-zA-Z0-9_]{20,}/g,
  /AKIA[A-Z0-9]{16}/g,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/g,
  /(?:password|passwd|pwd|token|secret|api[_-]?key)\s*[=:]\s*[^\s'"]+/gi,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/g,
];

function bounded(value, max) {
  const text = String(value);
  return text.length > max ? text.slice(0, max) : text;
}

function redactSecrets(value) {
  let text = String(value);
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[REDACTED]');
  return text;
}

/** First recognizable file path / command / query in the tool input. */
function toolTarget(input) {
  if (typeof input === 'string') {
    const text = input.trim();
    return text ? bounded(redactSecrets(text), MAX_TARGET) : undefined;
  }
  if (!input || typeof input !== 'object') return undefined;
  const keys = ['path', 'file_path', 'filePath', 'filepath', 'target_file', 'targetFile', 'filename', 'command', 'cmd', 'query', 'pattern', 'url'];
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return bounded(redactSecrets(value.trim()), MAX_TARGET);
    }
  }
  return undefined;
}

function isFileEdit(tool) {
  return /write|edit|apply|replace|insert|delete|move|rename|patch/i.test(tool);
}

function looksLikePath(target) {
  return /[/\\]/.test(target) || /\.[a-zA-Z0-9]{1,8}$/.test(target);
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

const queue = new DeliveryQueue();
const started = new Set();
const ended = new Set();
const sessions = new Map();

function statsFor(sessionId) {
  let stats = sessions.get(sessionId);
  if (!stats) {
    stats = { startedAt: Date.now(), toolCalls: 0, failedToolCalls: 0, files: new Set() };
    sessions.set(sessionId, stats);
  }
  return stats;
}

/** Aggregate run summary attached to agent_session_ended (D-027). */
function summaryFields(sessionId, snapshot, result) {
  const stats = statsFor(sessionId);
  const usage = (result && result.usage) || (snapshot && snapshot.usage) || {};
  const fields = {
    duration_ms: Math.max(0, Date.now() - stats.startedAt),
    tool_call_count: stats.toolCalls,
    failed_tool_call_count: stats.failedToolCalls,
  };
  const iterations = result && result.iterations;
  if (Number.isInteger(iterations) && iterations >= 0) fields.iterations = iterations;
  if (Number.isInteger(usage.inputTokens) && usage.inputTokens >= 0) {
    fields.input_tokens = usage.inputTokens;
  }
  if (Number.isInteger(usage.outputTokens) && usage.outputTokens >= 0) {
    fields.output_tokens = usage.outputTokens;
  }
  if (stats.files.size > 0) fields.files_touched = Array.from(stats.files).slice(0, MAX_FILES);
  return fields;
}

function sessionIdOf(snapshot) {
  if (!snapshot) return undefined;
  return snapshot.conversationId || snapshot.runId;
}

function emit(type, payload) {
  queue.push({ directory: workspaceRoot, envelope: envelope(type, payload) });
}

function endReasonOf(status) {
  if (status === 'completed') return 'completed';
  if (status === 'aborted') return 'interrupted';
  return 'failed';
}

const plugin = {
  name: 'workjournal',
  manifest: { capabilities: ['hooks'] },

  setup(_api, ctx) {
    if (ctx && ctx.logger && typeof ctx.logger.log === 'function') {
      const logger = ctx.logger;
      report = function reportWithLogger(message) {
        logger.log(message);
      };
    }
    if (ctx && typeof ctx.onDispose === 'function') {
      ctx.onDispose(function () {
        return queue.dispose();
      });
    }
    workspaceRoot =
      (ctx && ctx.workspaceInfo && ctx.workspaceInfo.rootPath) ||
      (ctx && ctx.cwd) ||
      (typeof process !== 'undefined' ? process.cwd() : '');
  },

  hooks: {
    afterTool(context) {
      if (!context) return;
      const sessionId = sessionIdOf(context.snapshot);
      if (!sessionId) return;

      const tool = bounded(
        (context.tool && context.tool.name) ||
          (context.toolCall && context.toolCall.toolName) ||
          'unknown',
        200,
      );
      const failed = Boolean(context.result && context.result.isError);
      const input = context.input !== undefined ? context.input : context.toolCall && context.toolCall.input;
      const target = toolTarget(input);
      const stats = statsFor(sessionId);
      stats.toolCalls += 1;
      if (failed) stats.failedToolCalls += 1;
      if (target && isFileEdit(tool) && looksLikePath(target) && stats.files.size < MAX_FILES) {
        stats.files.add(target);
      }

      const payload = {
        agent_id: AGENT_ID,
        session_id: sessionId,
        tool: tool,
        status: failed ? 'failed' : 'succeeded',
        duration_ms: Math.max(0, Math.round(Number(context.durationMs) || 0)),
      };
      if (target) payload.target = target;
      const toolCallId = context.toolCall && context.toolCall.toolCallId;
      if (typeof toolCallId === 'string' && toolCallId.length > 0) {
        payload.tool_call_id = bounded(toolCallId, 200);
      }
      emit('agent_tool_call', payload);
    },

    onEvent(event) {
      if (!event) return;
      const snapshot = event.snapshot;
      const sessionId = sessionIdOf(snapshot);
      if (!sessionId) return;

      if (event.type === 'run-started') {
        if (started.has(sessionId)) return;
        started.add(sessionId);
        statsFor(sessionId);
        emit('agent_session_started', { agent_id: AGENT_ID, session_id: sessionId });
        return;
      }

      if (event.type === 'run-finished') {
        if (ended.has(sessionId)) return;
        ended.add(sessionId);
        const status = event.result && event.result.status;
        emit(
          'agent_session_ended',
          Object.assign(
            { agent_id: AGENT_ID, session_id: sessionId, reason: endReasonOf(status) },
            summaryFields(sessionId, snapshot, event.result),
          ),
        );
        sessions.delete(sessionId);
        return;
      }

      if (event.type === 'run-failed') {
        if (ended.has(sessionId)) return;
        ended.add(sessionId);
        emit(
          'agent_session_ended',
          Object.assign(
            { agent_id: AGENT_ID, session_id: sessionId, reason: 'failed' },
            summaryFields(sessionId, snapshot, undefined),
          ),
        );
        sessions.delete(sessionId);
        return;
      }

      if (event.type === 'status-notice' && /idle/i.test(String(event.message || ''))) {
        emit('agent_idle', { agent_id: AGENT_ID, session_id: sessionId });
      }
    },
  },
};

export default plugin;
`;
