import { describe, it, expect } from 'vitest';
import { extractSessionId, OPENCODE_SESSION_META_KEY } from '../../packages/mcp-adapter/src/tools/session-meta.js';
import { projectIdFromAgentId } from '@workjournal/shared';

/**
 * WS-2.5: the adapter's _meta → session_id extraction and the agent-id →
 * project-id derivation used by the agent-reporting tools.
 */
describe('session correlation helpers', () => {
  it('extracts the OpenCode session id from tool-call _meta', () => {
    expect(extractSessionId({ [OPENCODE_SESSION_META_KEY]: 'sess-abc' })).toBe('sess-abc');
  });

  it('returns null for absent, empty or malformed _meta', () => {
    expect(extractSessionId(undefined)).toBeNull();
    expect(extractSessionId(null)).toBeNull();
    expect(extractSessionId({})).toBeNull();
    expect(extractSessionId({ [OPENCODE_SESSION_META_KEY]: '' })).toBeNull();
    expect(extractSessionId({ [OPENCODE_SESSION_META_KEY]: 42 })).toBeNull();
    expect(extractSessionId('nope')).toBeNull();
  });

  it('derives the project id from the agent-id suffix (last underscore)', () => {
    expect(projectIdFromAgentId('mimo_e405de72-89a5-4151-931c-248fb6b8ef87')).toBe(
      'e405de72-89a5-4151-931c-248fb6b8ef87',
    );
    expect(projectIdFromAgentId('foo_bar_myproj')).toBe('myproj');
    expect(projectIdFromAgentId('nosuffix')).toBeNull();
    expect(projectIdFromAgentId('_leading')).toBeNull();
    expect(projectIdFromAgentId('trailing_')).toBeNull();
  });
});
