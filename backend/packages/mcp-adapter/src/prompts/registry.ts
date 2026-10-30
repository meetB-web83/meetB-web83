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

const promptsLogger = createLogger({ component: 'mcp-adapter', module: 'prompts-registry' });

/**
 * Names of prompts currently registered on the McpServer.
 * registerPrompt throws on duplicate names, so we track what's already
 * registered and only add new prompts on re-sync.
 */
const registeredNames = new Set<string>();

export function getRegisteredNames(): Set<string> {
  return registeredNames;
}

/**
 * Fetch and register enabled prompts from Core.
 * Skips prompts already registered (by name) to avoid duplicate registration errors.
 * Returns the set of registered names after sync.
 */
export async function syncPrompts(server: McpServer, coreUrl: string, projectId?: string): Promise<Set<string>> {
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
    return registeredNames;
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
    return registeredNames;
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
    return registeredNames;
  }

  let added = 0;
  let skipped = 0;
  let disabled = 0;

  for (const p of prompts) {
    if (!p.enabled) {
      disabled++;
      continue;
    }
    if (registeredNames.has(p.name)) {
      skipped++;
      continue;
    }
    server.registerPrompt(p.name, {
      description: p.name,
      argsSchema: {
        request: z.string().optional(),
      },
    }, async (args: any) => {
      // re-fetch current row to get latest template
      const r = await fetch(`${coreUrl}/api/prompts/${p.id}`);
      if (!r.ok) {
        promptsLogger.warn(
          {
            component: 'mcp-adapter',
            module: 'prompts-registry',
            promptName: p.name,
            promptId: p.id,
            status: r.status,
          },
          'prompt no longer available at execution time',
        );
        return { messages: [{ role: 'user', content: { type: 'text', text: `Prompt "${p.name}" is no longer available.` } }] };
      }
      const row = (await r.json()) as PromptRow;
      if (!row.enabled) {
        promptsLogger.warn(
          { component: 'mcp-adapter', module: 'prompts-registry', promptName: p.name, promptId: p.id },
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
    registeredNames.add(p.name);
    added++;
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
      totalRegistered: registeredNames.size,
    },
    'prompt sync complete',
  );

  return registeredNames;
}
