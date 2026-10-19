export const PROTOCOL_VERSION = 1;
export const HANDOFF_FORMAT_VERSION = 1;
export const DEFAULT_CONTEXT_SIZE_LIMIT = 50_000;
export const MAX_PAYLOAD_SIZE = 1_048_576; // 1 MB
export const IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
export const AGENT_ID_PATTERN = /^[a-zA-Z0-9_-]+_[a-zA-Z0-9-]+$/;
