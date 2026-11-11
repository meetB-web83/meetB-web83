/**
 * Embedded Cursor lifecycle plugin (committed embed output).
 *
 * Cursor plugins live in `~/.cursor/plugins/local/workjournal/` with a
 * `plugin.json` manifest. Cursor's hook system runs external commands (shell
 * scripts), not in-process JS callbacks like OpenCode/Cline. This module
 * embeds the ingest script and hooks config that `workjournal setup` writes
 * to the Cursor plugin directory.
 *
 * The ingest script is invoked by Cursor hooks on lifecycle events and POSTs
 * canonical ledger envelopes to Core's POST /api/ingest/events. Delivery uses
 * retry with backoff when Core is down; the plugin never starts Core itself.
 *
 * Hook -> event mapping:
 *   beforeSubmitPrompt  -> agent_session_started
 *   stop                -> agent_session_ended (with duration, tool counts)
 *   afterFileEdit       -> agent_tool_call (tool: 'edit')
 *
 * Source: agent:cursor, agent id: cursor_<project-id>.
 */

import { join } from 'node:path';

export const cursorPluginVersion = '1';

export const cursorPluginSource = String.raw`
#!/usr/bin/env node
/**
 * WorkJournal Cursor lifecycle ingest script.
 *
 * Invoked by Cursor's hooks/workjournal-hooks.json on hook
 * events. POSTs canonical ledger envelopes to Core's POST /api/ingest/events.
 *
 * Usage: node ingest.js <hook-type>
 *   session-started  -> agent_session_started
 *   session-ended    -> agent_session_ended
 *   tool-call        -> agent_tool_call
 */

const AGENT_ID = 'cursor';
const SOURCE = 'agent:cursor';
const CORE_URL = ((typeof process !== 'undefined' && process.env && process.env.WORKJOURNAL_CORE_URL) || 'http://127.0.0.1:3737').replace(/\/+$/, '');
const INGEST_PATH = '/api/ingest/events';
const PROJECTS_PATH = '/api/projects?available=true';
const MAX_QUEUE = 500;
const BATCH_SIZE = 50;
const RETRY_MS = 5000;
const MAX_TARGET = 1024;
const MAX_FILES = 100;

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
 * normalizeRootPath: git-bash /c/Users/... and WSL /mnt/c/Users/... become
 * c:/Users/..., backslashes become forward slashes, trailing slashes are
 * dropped, and Windows paths are case-folded.
 */
function canonicalPath(value) {
  if (typeof value !== 'string') return '';
  let path = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const drive = /^\/(?:mnt\/)?([A-Za-z])(?:\/(.*))?$/.exec(path);
  if (drive) path = drive[1] + ':' + (drive[2] ? '/' + drive[2] : '');
  if (typeof process !== 'undefined' && process.platform === 'win32') path = path.toLowerCase();
  return path;
}

function secretRedact(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/sk-[A-Za-z0-9]{20,}/g, '[REDACTED]')
    .replace(/ghp_[A-Za-z0-9]{36,}/g, '[REDACTED]')
    .replace(/AKIA[A-Z0-9]{16,}/g, '[REDACTED]')
    .replace(/(password|token|secret|api_key)=[^&\s]+/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/g, 'Bearer [REDACTED]')
    .replace(/-----BEGIN [A-Z ]+----- [\s\S]*?-----END [A-Z ]+-----/, '[REDACTED PRIVATE KEY]')
    .slice(0, MAX_TARGET);
}

/** Bounded delivery queue with backoff when Core is down. */
const queue = [];
let flushing = false;
let retryTimer = null;

function enqueue(env) {
  queue.push(env);
  if (queue.length > MAX_QUEUE) queue.shift();
  if (!flushing) flush();
}

async function flush() {
  if (flushing || queue.length === 0) return;
  flushing = true;
  try {
    while (queue.length > 0) {
      const batch = queue.splice(0, BATCH_SIZE);
      try {
        await fetch(CORE_URL + INGEST_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ events: batch }),
        });
      } catch (err) {
        queue.unshift(...batch);
        report('WorkJournal: delivery failed, retrying in ' + (RETRY_MS / 1000) + 's');
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(function () { flushing = false; flush(); }, RETRY_MS);
        return;
      }
    }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  } finally {
    flushing = false;
  }
}

async function resolveProjectId() {
  try {
    const res = await fetch(CORE_URL + PROJECTS_PATH);
    if (!res.ok) return null;
    const data = await res.json();
    const projects = Array.isArray(data) ? data : (data.projects || []);
    const workspace = canonicalPath(process.cwd());
    for (const i = 0; i < projects.length; i++) {
      const project = projects[i];
      const root = canonicalPath(project.root_path);
      if (root && (workspace === root || workspace.startsWith(root + '/'))) {
        return project.id;
      }
    }
  } catch {
    // Ignore, project stays unresolved.
  }
  return null;
}

function sessionState() {
  const s = globalThis.__wjSession || { startTime: Date.now(), toolCalls: 0, failedToolCalls: 0, filesTouched: new Set() };
  globalThis.__wjSession = s;
  return s;
}

async function sendEnvelope(type, payload) {
  const projectId = await resolveProjectId();
  const env = envelope(type, { ...payload, ...(projectId ? { project_id: projectId } : {}) });
  enqueue(env);
}

const hookType = process.argv[2];

switch (hookType) {
  case 'session-started': {
    const s = sessionState();
    s.startTime = Date.now();
    await sendEnvelope('agent_session_started', {
      agent_id: AGENT_ID,
      session_id: 'cursor_' + Date.now(),
    });
    break;
  }
  case 'session-ended': {
    const s = sessionState();
    const durationMs = Date.now() - s.startTime;
    await sendEnvelope('agent_session_ended', {
      agent_id: AGENT_ID,
      session_id: 'cursor_' + s.startTime,
      reason: 'completed',
      duration_ms: Math.round(durationMs),
      tool_call_count: s.toolCalls,
      failed_tool_call_count: s.failedToolCalls,
      files_touched: Array.from(s.filesTouched).slice(0, MAX_FILES),
    });
    break;
  }
  case 'tool-call': {
    let stdin = '';
    for await (const chunk of process.stdin) stdin += chunk;
    let toolData = {};
    try { toolData = JSON.parse(stdin); } catch { /* ignore */ }
    await sendEnvelope('agent_tool_call', {
      agent_id: AGENT_ID,
      session_id: 'cursor_' + sessionState().startTime,
      tool: toolData.tool || 'unknown',
      status: toolData.status || 'succeeded',
      duration_ms: toolData.duration_ms || 0,
      ...(toolData.target ? { target: secretRedact(toolData.target) } : {}),
      ...(toolData.tool_call_id ? { tool_call_id: toolData.tool_call_id } : {}),
    });
    break;
  }
  default:
    report('WorkJournal: unknown hook type: ' + hookType);
}
`;

/**
 * Create the Cursor hooks config with absolute paths to the ingest script.
 * Hook commands run from the Cursor workspace/project root, so relative paths
 * would not resolve to the plugin directory in the user's home.
 */
export function createCursorHooksConfig(pluginDir: string) {
  const ingest = join(pluginDir, 'hooks', 'ingest.js');
  return {
    version: 1,
    hooks: {
      'beforeSubmitPrompt': [
        {
          command: `node "${ingest}" session-started`,
          matcher: 'UserPromptSubmit',
          timeout: 5,
          failClosed: false,
        },
      ],
      stop: [
        {
          command: `node "${ingest}" session-ended`,
          timeout: 10,
          loop_limit: 1,
          failClosed: false,
        },
      ],
      'afterFileEdit': [
        {
          command: `node "${ingest}" tool-call`,
          timeout: 5,
          failClosed: false,
        },
      ],
    },
  };
}

export const cursorPluginManifest = {
  name: 'workjournal',
  displayName: 'WorkJournal',
  description: 'Task progress tracking across agent sessions',
  version: '1.0.0',
  hooks: './hooks/workjournal-hooks.json',
};