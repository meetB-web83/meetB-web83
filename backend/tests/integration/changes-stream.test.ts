import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer, type Config } from '@workjournal/core';
import { createRegistryDb } from '../helpers/registry-factory.js';

/**
 * Phase 6 test: SSE /changes/stream stays open, delivers `: connected`,
 * and pushes prompt change events after PromptService.create().
 */
describe('SSE /changes/stream', () => {
  let registry: ReturnType<typeof createRegistryDb>;
  let server: ReturnType<typeof buildServer>;
  let coreUrl: string;

  const config: Config = {
    workjournalHome: '~/.workjournal-test',
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    nodeEnv: 'test',
  };

  beforeEach(async () => {
    registry = createRegistryDb();
    server = buildServer(registry.db, config);
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address();
    if (address === null || typeof address === 'string') throw new Error('no core port');
    coreUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await server.close();
    registry.cleanup();
  });

  it('stays open, prints : connected, and delivers a create event', async () => {
    const res = await fetch(`${coreUrl}/changes/stream`, {
      headers: { Accept: 'text/event-stream' },
    });
    expect(res.ok).toBe(true);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.body).toBeDefined();

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const events: any[] = [];
    let sawConnected = false;
    let gotCreateEvent = false;

    const collect = (async () => {
      try {
        while (true) {
          const { done: d, value } = await reader.read();
          if (d) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (line.startsWith(': connected')) sawConnected = true;
            if (line.startsWith('data: ')) {
              try {
                const ev = JSON.parse(line.slice(6));
                events.push(ev);
                if (ev.type === 'prompt' && ev.action === 'create') gotCreateEvent = true;
              } catch {
                // skip malformed
              }
            }
          }
          if (gotCreateEvent) break;
        }
      } finally {
        try { reader.releaseLock(); } catch {}
        try { res.body!.cancel(); } catch {}
      }
    })();

    // Wait for : connected (should arrive immediately)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for : connected')), 5_000);
      const check = () => {
        if (sawConnected) { clearTimeout(timer); resolve(); }
        else setTimeout(check, 30);
      };
      check();
    });

    // Create a prompt — this triggers a change bus publish → SSE event.
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/prompts',
      payload: { name: 'sse_test_prompt', template: 'Hi {{name}}', idempotency_key: 'sse-test-001' },
    });
    expect(createRes.statusCode).toBe(201);

    // Wait for the create event to arrive on the SSE stream.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for SSE create event')), 5_000);
      const check = () => {
        if (gotCreateEvent) { clearTimeout(timer); resolve(); }
        else setTimeout(check, 30);
      };
      check();
    });

    expect(sawConnected).toBe(true);
    expect(gotCreateEvent).toBe(true);
    const createEvents = events.filter((e: any) => e.type === 'prompt' && e.action === 'create');
    expect(createEvents.length).toBeGreaterThan(0);
    expect(createEvents[0].promptId).toBeDefined();
    expect(createEvents[0].projectId).toBeNull();
  });
});
