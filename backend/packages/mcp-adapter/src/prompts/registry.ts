import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface PromptRow {
  id: string;
  name: string;
  template: string;
  arguments?: any[];
  project_id?: string | null;
  enabled?: boolean;
}

export async function syncPrompts(server: McpServer, coreUrl: string, projectId?: string) {
  const url = projectId
    ? `${coreUrl}/api/prompts?resolved=true&project_id=${encodeURIComponent(projectId)}`
    : `${coreUrl}/api/prompts?scope=global`;
  const res = await fetch(url);
  if (!res.ok) return;
  const prompts = (await res.json()) as PromptRow[];
  for (const p of prompts) {
    if (!p.enabled) continue;
    server.registerPrompt(p.name, { description: p.name }, async (args: any) => {
      // re-fetch current row
      const r = await fetch(`${coreUrl}/api/prompts/${p.id}`);
      const row = r.ok ? ((await r.json()) as PromptRow) : p;
      let text = row.template;
      for (const [k, v] of Object.entries(args || {})) {
        text = text.replace(new RegExp(`{{\\s*${k}\\s*}}`, 'g'), String(v));
      }
      return { messages: [{ role: 'user', content: { type: 'text', text } }] };
    });
  }
}