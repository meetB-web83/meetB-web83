import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createLogger } from '@workjournal/shared';

export interface PromptRow {
  id: string;
  name: string;
  template: string;
  arguments?: any[];
  project_id?: string | null;
  enabled?: boolean;
}

let _promptsLogger: ReturnType<typeof createLogger> | null = null;
const promptsLogger = new Proxy({} as ReturnType<typeof createLogger>, {
  get(_, prop: string) {
    if (!_promptsLogger) _promptsLogger = createLogger({ component: 'mcp-adapter', module: 'prompts-registry' });
    return Reflect.get(_promptsLogger, prop);
  },
}) as ReturnType<typeof createLogger>;

/**
 * Prompts currently registered on each McpServer, keyed by server then by name.
 * Uses a WeakMap keyed by McpServer so each server instance (e.g. each HTTP
 * session) has its own registry — a module-global Map would be shared by every
 * server in the process and break HTTP transport where each session has its
 * own server.
 *
 * Tracks the Core promptId so we can detect when a prompt was deleted
 * and recreated with the same name (different ID) or deleted entirely.
 *
 * registerPrompt throws on duplicate names, so we track what's already
 * registered and only add new prompts on re-sync. When a prompt's Core
 * ID changes or the prompt disappears from Core, we remove the stale
 * registration from the MCP server via the registeredPrompt.remove()
 * method (which deletes from the server's internal _registeredPrompts
 * map and sends prompts/list_changed).
 */
type RegisteredEntry = { promptId: string; registered: ReturnType<McpServer['registerPrompt']> };
const registry = new WeakMap<McpServer, Map<string, RegisteredEntry>>();

function entriesFor(server: McpServer): Map<string, RegisteredEntry> {
  let entries = registry.get(server);
  if (!entries) {
    entries = new Map();
    registry.set(server, entries);
  }
  return entries;
}

export function getRegisteredNames(server: McpServer): Set<string> {
  return new Set(entriesFor(server).keys());
}

/**
 * Fetch and register enabled prompts from Core.
 * On re-sync: registers new prompts, re-registers prompts whose Core ID
 * changed (deleted and recreated), and removes prompts that no longer
 * exist in Core.
 */
export async function syncPrompts(
  server: McpServer,
  coreUrl: string,
  projectId?: string,
): Promise<Set<string>> {
  const entries = entriesFor(server);
  const url = projectId
    ? `${coreUrl}/api/prompts?resolved=true&project_id=${encodeURIComponent(projectId)}`
    : `${coreUrl}/api/prompts?scope=global`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    promptsLogger.error(
      { component: 'mcp-adapter', module: 'prompts-registry', url, projectId, error: String(err) },
      'failed to fetch prompts from core',
    );
    return getRegisteredNames(server);
  }

  if (!res.ok) {
    promptsLogger.warn(
      {
        component: 'mcp-adapter',
        module: 'prompts-registry',
        url,
        projectId,
        status: res.status,
      },
      'core returned non-OK status for prompts list',
    );
    return getRegisteredNames(server);
  }

  let prompts: PromptRow[];
  try {
    prompts = (await res.json()) as PromptRow[];
  } catch (err) {
    promptsLogger.error(
      {
        component: 'mcp-adapter',
        module: 'prompts-registry',
        url,
        projectId,
        error: String(err),
      },
      'failed to parse prompts response from core',
    );
    return getRegisteredNames(server);
  }

  let added = 0;
  let skipped = 0;
  let disabled = 0;
  let removed = 0;
  let reRegistered = 0;

  const currentNames = new Set<string>();

  for (const p of prompts) {
    if (!p.enabled) {
      disabled++;
      continue;
    }
    currentNames.add(p.name);

    const existing = entries.get(p.name);
    if (existing) {
      if (existing.promptId === p.id) {
        skipped++;
        continue;
      }
      // Same name, different Core ID — prompt was deleted and recreated.
      // Remove the stale registration (old callback had the old promptId)
      // and register fresh with the new ID.
      existing.registered.remove();
      entries.delete(p.name);
      reRegistered++;
      promptsLogger.info(
        {
          component: 'mcp-adapter',
          module: 'prompts-registry',
          promptName: p.name,
          oldPromptId: existing.promptId,
          newPromptId: p.id,
          projectId,
        },
        'prompt re-registered (Core ID changed)',
      );
    }

    // Build argsSchema from declared arguments plus `request`, so
    // {{placeholders}} in the template are accepted as arguments.
    const argProperties: Record<string, z.ZodTypeAny> = {
      request: z.string().optional(),
    };
    for (const arg of p.arguments || []) {
      if (arg && typeof arg === 'object' && arg.name) {
        argProperties[String(arg.name)] = z.string().optional();
      }
    }

    const registered = server.registerPrompt(p.name, {
      description: p.name,
      argsSchema: argProperties as Record<string, z.ZodTypeAny>,
    }, async (args: any) => {
      // Resolve the prompt id at execution time so the callback is immune
      // to stale ids after a delete + recreate with the same name.
      const entry = entries.get(p.name);
      const id = entry?.promptId ?? p.id;
      // re-fetch current row to get latest template
      const r = await fetch(`${coreUrl}/api/prompts/${id}`);
      if (!r.ok) {
        promptsLogger.warn(
          {
            component: 'mcp-adapter',
            module: 'prompts-registry',
            promptName: p.name,
            promptId: id,
            status: r.status,
          },
          'prompt no longer available at execution time',
        );
        return { messages: [{ role: 'user', content: { type: 'text', text: `Prompt "${p.name}" is no longer available.` } }] };
      }
      const row = (await r.json()) as PromptRow;
      if (!row.enabled) {
        promptsLogger.warn(
          { component: 'mcp-adapter', module: 'prompts-registry', promptName: p.name, promptId: id },
          'prompt is disabled at execution time',
        );
        return { messages: [{ role: 'user', content: { type: 'text', text: `Prompt "${p.name}" is disabled.` } }] };
      }
      let text = row.template;
      for (const [k, v] of Object.entries(args || {})) {
        text = text.replace(new RegExp(`{{\\s*${k}\\s*}}`, 'g'), String(v));
      }
      // Append trailing request text if provided
      if (args?.request) {
        text += `\n\n---\n\nUser request: ${args.request}`;
      }
      return { messages: [{ role: 'user', content: { type: 'text', text } }] };
    });

    entries.set(p.name, { promptId: p.id, registered });
    added++;
  }

  // Remove prompts that are registered on the MCP server but no longer
  // exist in Core (deleted prompts).
  for (const [name, { registered }] of entries) {
    if (!currentNames.has(name)) {
      registered.remove();
      entries.delete(name);
      removed++;
      promptsLogger.info(
        { component: 'mcp-adapter', module: 'prompts-registry', promptName: name, projectId },
        'prompt removed from registry',
      );
    }
  }

  promptsLogger.info(
    {
      component: 'mcp-adapter',
      module: 'prompts-registry',
      projectId,
      totalFetched: prompts.length,
      added,
      skipped,
      disabled,
      removed,
      reRegistered,
      totalRegistered: entries.size,
    },
    'prompt sync complete',
  );

  return getRegisteredNames(server);
}
