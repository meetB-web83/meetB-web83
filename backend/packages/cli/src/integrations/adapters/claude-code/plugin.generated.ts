/**
 * Embedded Claude Code hook handler (committed embed output, D-011/D-022 pattern).
 *
 * Claude Code invokes command-type hooks by spawning a process and passing the
 * hook event JSON on stdin. This handler reads the event, maps Claude Code's
 * PascalCase lifecycle events to canonical ledger types, and POSTs envelopes
 * to Core's POST /api/ingest/events. It never starts Core itself.
 */

export const claudeCodePluginVersion = '1';

export const claudeCodeHookHandlerSource = String.raw`
/**
 * WorkJournal hook handler for Claude Code.
 *
 * Reads Claude Code hook event JSON from stdin, maps the event to a canonical
 * ledger type, and POSTs the envelope to Core's POST /api/ingest/events.
 */

const AGENT_ID = 'claude-code';
const SOURCE = 'agent:claude-code';
const CORE_URL = ((typeof process !== 'undefined' && process.env && process.env.WORKJOURNAL_CORE_URL) || 'http://127.0.0.1:3737').replace(/\/+$/, '');
const INGEST_PATH = '/api/ingest/events';
const MAX_TARGET = 1024;

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

/** Read the full stdin payload as a string. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
  }
  return chunks.join('');
}

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

async function postEnvelope(envelope) {
  try {
    const res = await fetch(CORE_URL + INGEST_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    if (res.ok) return;
    if (res.status >= 400 && res.status < 500) {
      console.warn('[workjournal] ingest rejected with status ' + res.status);
      return;
    }
  } catch (_error) {
    /* Core may be down; the event is dropped for this synchronous hook. */
  }
}

function mapEventType(hookEventName) {
  switch (hookEventName) {
    case 'SessionStart': return 'agent_session_started';
    case 'SessionEnd': return 'agent_session_ended';
    case 'PreToolUse': return 'agent_tool_call';
    case 'PostToolUse': return 'agent_tool_call';
    case 'Stop': return 'agent_session_ended';
    case 'Notification': return 'agent_idle';
    default: return 'agent_event';
  }
}

function buildPayload(eventName, input) {
  const sessionId = input && input.session_id ? input.session_id : input && input.conversationId ? input.conversationId : undefined;
  const payload = { agent_id: AGENT_ID };
  if (sessionId) payload.session_id = sessionId;

  if (eventName === 'PreToolUse' || eventName === 'PostToolUse') {
    const tool = bounded((input && input.tool && input.tool.name) || (input && input.tool_name) || 'unknown', 200);
    const failed = eventName === 'PostToolUse' && Boolean(input && input.result && input.result.is_error);
    payload.tool = tool;
    payload.status = failed ? 'failed' : 'succeeded';
    const target = toolTarget(input && input.tool_input ? input.tool_input : input);
    if (target) payload.target = target;
    payload.duration_ms = Math.max(0, Math.round(Number(input && input.duration_ms) || 0));
  }

  if (eventName === 'SessionEnd' || eventName === 'Stop') {
    payload.reason = eventName === 'Stop' ? 'interrupted' : 'completed';
  }

  return payload;
}

async function main() {
  const raw = await readStdin();
  let input;
  try {
    input = raw.trim().length > 0 ? JSON.parse(raw) : {};
  } catch (_error) {
    input = {};
  }

  const hookEventName = process.env.CLAUDE_HOOK_EVENT || (input && input.hook_event_name) || 'unknown';
  const type = mapEventType(hookEventName);
  const payload = buildPayload(hookEventName, input);

  await postEnvelope(envelope(type, payload));
}

main().catch((err) => {
  console.warn('[workjournal] hook handler error: ' + (err && err.message ? err.message : String(err)));
});
`;
