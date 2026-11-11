/**
 * Agent integration setup tests (D-021/D-024).
 *
 * These exercise the real OpenCode/Cline adapters against temp config roots —
 * no mocks. They cover the failure modes that made the old setup report
 * success without writing artifacts: wrong config schema, missing plugin
 * files, conflicts, legacy migration, idempotent re-runs, and uninstall.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { SetupContext } from '../../packages/cli/src/integrations/types.js';
import { opencodeIntegration } from '../../packages/cli/src/integrations/adapters/opencode/index.js';
import { clineIntegration } from '../../packages/cli/src/integrations/adapters/cline/index.js';
import { cursorIntegration } from '../../packages/cli/src/integrations/adapters/cursor/index.js';
import { geminiCliIntegration } from '../../packages/cli/src/integrations/adapters/gemini-cli/index.js';
import { claudeCodeIntegration } from '../../packages/cli/src/integrations/adapters/claude-code/index.js';
import { antigravityCliIntegration } from '../../packages/cli/src/integrations/adapters/antigravity-cli/index.js';
import { resolveOpencodePaths } from '../../packages/cli/src/integrations/adapters/opencode/discovery.js';
import { resolveClinePaths } from '../../packages/cli/src/integrations/adapters/cline/discovery.js';
import { resolveCursorPaths } from '../../packages/cli/src/integrations/adapters/cursor/discovery.js';
import { resolveGeminiCliPaths } from '../../packages/cli/src/integrations/adapters/gemini-cli/discovery.js';
import { resolveClaudeCodePaths } from '../../packages/cli/src/integrations/adapters/claude-code/discovery.js';
import { resolveAntigravityCliPaths } from '../../packages/cli/src/integrations/adapters/antigravity-cli/discovery.js';
import { clinePluginVersion } from '../../packages/cli/src/integrations/adapters/cline/plugin.generated.js';
import { opencodePluginVersion } from '../../packages/cli/src/integrations/adapters/opencode/plugin.generated.js';
import { geminiCliPluginVersion } from '../../packages/cli/src/integrations/adapters/gemini-cli/plugin.generated.js';
import { claudeCodePluginVersion } from '../../packages/cli/src/integrations/adapters/claude-code/plugin.generated.js';
import { antigravityCliPluginVersion } from '../../packages/cli/src/integrations/adapters/antigravity-cli/plugin.generated.js';
import { parseJsonc } from '../../packages/cli/src/integrations/safe-config.js';

const COMMAND = ['workjournal', 'mcp', '--with-ui'];
const originalPath = process.env.PATH;
const originalMcpCommand = process.env.WORKJOURNAL_MCP_COMMAND;

let root: string;
let home: string;
let cwd: string;
let binDir: string;

function ctx(overrides: Partial<SetupContext> = {}): SetupContext {
  return {
    agentId: 'opencode',
    scope: 'global',
    cwd,
    platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
    workjournalHome: join(home, '.workjournal'),
    homeDir: home,
    yes: true,
    force: false,
    dryRun: false,
    ...overrides,
  };
}

async function fakeBinary(name: string): Promise<void> {
  const candidates =
    process.platform === 'win32' ? [`${name}.CMD`, `${name}.EXE`] : [name];
  for (const file of candidates) {
    await writeFile(join(binDir, file), '', 'utf8');
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wj-integrations-'));
  home = join(root, 'home');
  cwd = join(root, 'workspace');
  binDir = join(root, 'bin');
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(binDir, { recursive: true });
  process.env.WORKJOURNAL_MCP_COMMAND = JSON.stringify(COMMAND);
  process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`;
});

afterEach(async () => {
  process.env.PATH = originalPath;
  if (originalMcpCommand === undefined) delete process.env.WORKJOURNAL_MCP_COMMAND;
  else process.env.WORKJOURNAL_MCP_COMMAND = originalMcpCommand;
  await rm(root, { recursive: true, force: true });
});

describe('opencode integration', () => {
  it('writes the mcp.servers.<name> schema and auto-loaded plugin', async () => {
    await fakeBinary('opencode');
    const context = ctx();

    const plan = await opencodeIntegration.plan(context);
    expect(plan.error).toBeUndefined();
    const result = await opencodeIntegration.apply(plan, context);
    expect(result.success).toBe(true);

    const paths = resolveOpencodePaths(context);
    const config = JSON.parse(await readFile(paths.configPath, 'utf8'));
    expect(config.mcp.servers.workjournal).toEqual({ type: 'local', command: COMMAND });
    expect(config.mcp.workjournal).toBeUndefined();
    expect(config.plugins).toBeUndefined();

    const plugin = await readFile(paths.pluginPath, 'utf8');
    expect(plugin).toContain("id: 'workjournal'");
    expect(plugin).toContain('/api/ingest/events');
    await expect(readFile(join(context.workjournalHome, 'integrations', 'opencode', 'plugin', 'index.js'), 'utf8'))
      .resolves.toBe(plugin);
    const opencodeManifest = JSON.parse(
      await readFile(join(context.workjournalHome, 'integrations', 'opencode', 'plugin', 'manifest.json'), 'utf8'),
    );
    expect(opencodeManifest.version).toBe(opencodePluginVersion);

    const validation = await opencodeIntegration.validate(context);
    expect(validation.valid).toBe(true);
  });

  it('is idempotent — a second plan is all noop', async () => {
    await fakeBinary('opencode');
    const context = ctx();
    const first = await opencodeIntegration.plan(context);
    expect((await opencodeIntegration.apply(first, context)).success).toBe(true);

    const second = await opencodeIntegration.plan(context);
    expect(second.files.every((file) => file.action === 'noop')).toBe(true);
    const rerun = await opencodeIntegration.apply(second, context);
    expect(rerun.filesModified).toEqual([]);
  });

  it('preserves unrelated keys and comments', async () => {
    await fakeBinary('opencode');
    const context = ctx();
    const paths = resolveOpencodePaths(context);
    await mkdir(join(home, '.config', 'opencode'), { recursive: true });
    await writeFile(
      paths.configPath,
      '// keep this comment\n{\n  "theme": "dark",\n  "mcp": {}\n}\n',
      'utf8',
    );

    const plan = await opencodeIntegration.plan(context);
    const result = await opencodeIntegration.apply(plan, context);
    expect(result.success).toBe(true);

    const text = await readFile(paths.configPath, 'utf8');
    expect(text).toContain('// keep this comment');
    expect(text).toContain('"theme": "dark"');
    expect((parseJsonc(text).data as any).mcp.servers.workjournal.command).toEqual(COMMAND);
  });

  it('migrates the flat mcp.workjournal and legacy plugins entry', async () => {
    await fakeBinary('opencode');
    const context = ctx();
    const paths = resolveOpencodePaths(context);
    await mkdir(join(home, '.config', 'opencode'), { recursive: true });
    await writeFile(
      paths.configPath,
      JSON.stringify(
        {
          mcp: {
            workjournal: { type: 'local', command: ['workjournal', 'mcp'], enabled: true },
            servers: { other: { command: ['x'] } },
          },
          plugins: ['C:/Users/me/.workjournal/integrations/opencode/plugin/index.js'],
        },
        null,
        2,
      ),
      'utf8',
    );

    const plan = await opencodeIntegration.plan(context);
    expect((await opencodeIntegration.apply(plan, context)).success).toBe(true);

    const config = JSON.parse(await readFile(paths.configPath, 'utf8'));
    expect(config.mcp.workjournal).toBeUndefined();
    expect(config.mcp.servers.other).toEqual({ command: ['x'] });
    expect(config.mcp.servers.workjournal).toEqual({ type: 'local', command: COMMAND });
    expect(config.plugins).toBeUndefined();
  });

  it('refuses to clobber a different command unless forced', async () => {
    await fakeBinary('opencode');
    const context = ctx();
    const paths = resolveOpencodePaths(context);
    await mkdir(join(home, '.config', 'opencode'), { recursive: true });
    await writeFile(
      paths.configPath,
      JSON.stringify(
        { mcp: { servers: { workjournal: { type: 'local', command: ['node', 'other.js'] } } } },
        null,
        2,
      ),
      'utf8',
    );

    const refused = await opencodeIntegration.plan(context);
    expect(refused.error).toMatch(/--force/);
    expect(refused.files).toEqual([]);

    const forced = await opencodeIntegration.plan(ctx({ force: true }));
    expect(forced.error).toBeUndefined();
    expect((await opencodeIntegration.apply(forced, context)).success).toBe(true);
  });

  it('reports invalid JSON instead of writing', async () => {
    await fakeBinary('opencode');
    const context = ctx();
    const paths = resolveOpencodePaths(context);
    await mkdir(join(home, '.config', 'opencode'), { recursive: true });
    await writeFile(paths.configPath, '{ not json', 'utf8');

    const plan = await opencodeIntegration.plan(context);
    expect(plan.error).toMatch(/not valid JSONC/i);
    const result = await opencodeIntegration.apply(plan, context);
    expect(result.success).toBe(false);
    expect(await readFile(paths.configPath, 'utf8')).toBe('{ not json');
  });

  it('supports project scope paths', async () => {
    await fakeBinary('opencode');
    const context = ctx({ scope: 'project' });
    const paths = resolveOpencodePaths(context);
    expect(paths.configPath).toBe(join(cwd, 'opencode.json'));
    expect(paths.pluginPath).toBe(join(cwd, '.opencode', 'plugins', 'workjournal.js'));

    const plan = await opencodeIntegration.plan(context);
    expect(plan.files.map((file) => file.path)).not.toContain(paths.pluginPath);
    expect(plan.warnings?.[0]).toMatch(/--global/);
    expect((await opencodeIntegration.apply(plan, context)).success).toBe(true);
    const config = JSON.parse(await readFile(paths.configPath, 'utf8'));
    expect(config.mcp.servers.workjournal.command).toEqual(COMMAND);
  });

  it('resolves project config at the repository root, matching OpenCode', async () => {
    await fakeBinary('opencode');
    await mkdir(join(root, '.git'));
    const nested = join(cwd, 'packages', 'app');
    await mkdir(nested, { recursive: true });

    const paths = resolveOpencodePaths(ctx({ scope: 'project', cwd: nested }));
    expect(paths.configPath).toBe(join(root, 'opencode.json'));
    expect(paths.pluginPath).toBe(join(root, '.opencode', 'plugins', 'workjournal.js'));
  });

  it('uninstalls only the managed entry and plugin', async () => {
    await fakeBinary('opencode');
    const context = ctx();
    const paths = resolveOpencodePaths(context);
    await mkdir(join(home, '.config', 'opencode'), { recursive: true });
    await writeFile(
      paths.configPath,
      JSON.stringify({ theme: 'dark', mcp: { servers: { other: { command: ['x'] } } } }, null, 2),
      'utf8',
    );
    const plan = await opencodeIntegration.plan(context);
    expect((await opencodeIntegration.apply(plan, context)).success).toBe(true);

    const result = await opencodeIntegration.uninstall(context);
    expect(result.success).toBe(true);
    expect(result.filesModified).toContain(paths.configPath);
    const config = JSON.parse(await readFile(paths.configPath, 'utf8'));
    expect(config.mcp.servers.workjournal).toBeUndefined();
    expect(config.mcp.servers.other).toEqual({ command: ['x'] });
    expect(config.theme).toBe('dark');
  });
});

describe('cline integration', () => {
  it('writes mcpServers plus an ESM plugin package', async () => {
    await fakeBinary('cline');
    const context = ctx({ agentId: 'cline' });

    const plan = await clineIntegration.plan(context);
    expect(plan.error).toBeUndefined();
    const result = await clineIntegration.apply(plan, context);
    expect(result.success).toBe(true);

    const paths = resolveClinePaths(context);
    const settings = JSON.parse(await readFile(paths.settingsPath, 'utf8'));
    expect(settings.mcpServers.workjournal).toEqual({
      command: COMMAND[0],
      args: COMMAND.slice(1),
      disabled: false,
      autoApprove: [],
    });

    const manifest = JSON.parse(await readFile(paths.pluginManifest, 'utf8'));
    expect(manifest.type).toBe('module');
    expect(manifest.cline.plugins).toEqual([{ paths: ['index.js'] }]);
    await expect(readFile(paths.pluginEntry, 'utf8')).resolves.toContain('run-started');
    const installManifest = JSON.parse(
      await readFile(join(context.workjournalHome, 'integrations', 'cline', 'plugin', 'manifest.json'), 'utf8'),
    );
    expect(installManifest.version).toBe(clinePluginVersion);

    const validation = await clineIntegration.validate(context);
    expect(validation.valid).toBe(true);
  });

  it('is idempotent — a second plan is all noop', async () => {
    await fakeBinary('cline');
    const context = ctx({ agentId: 'cline' });
    const first = await clineIntegration.plan(context);
    expect((await clineIntegration.apply(first, context)).success).toBe(true);

    const second = await clineIntegration.plan(context);
    expect(second.files.every((file) => file.action === 'noop')).toBe(true);
    expect((await clineIntegration.apply(second, context)).filesModified).toEqual([]);
  });

  it('refuses to clobber a different command unless forced', async () => {
    await fakeBinary('cline');
    const context = ctx({ agentId: 'cline' });
    const paths = resolveClinePaths(context);
    await mkdir(join(home, '.cline', 'data', 'settings'), { recursive: true });
    await writeFile(
      paths.settingsPath,
      JSON.stringify({ mcpServers: { workjournal: { command: 'node', args: ['other.js'] } } }, null, 2),
      'utf8',
    );

    const refused = await clineIntegration.plan(context);
    expect(refused.error).toMatch(/--force/);
    expect((await clineIntegration.apply(refused, context)).success).toBe(false);

    const forced = await clineIntegration.plan(ctx({ agentId: 'cline', force: true }));
    expect((await clineIntegration.apply(forced, context)).success).toBe(true);
  });

  it('installs the plugin package globally, not per project', async () => {
    await fakeBinary('cline');
    const context = ctx({ agentId: 'cline', scope: 'project' });
    const paths = resolveClinePaths(context);

    const plan = await clineIntegration.plan(context);
    expect(plan.files.map((file) => file.path)).not.toContain(paths.pluginEntry);
    expect(plan.warnings?.[0]).toMatch(/--global/);
    expect((await clineIntegration.apply(plan, context)).success).toBe(true);
    await expect(readFile(paths.settingsPath, 'utf8')).resolves.toContain('"workjournal"');
    await expect(readFile(paths.pluginEntry, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uninstalls the entry and plugin package', async () => {
    await fakeBinary('cline');
    const context = ctx({ agentId: 'cline' });
    const paths = resolveClinePaths(context);
    await mkdir(join(home, '.cline', 'data', 'settings'), { recursive: true });
    await writeFile(paths.settingsPath, JSON.stringify({ mcpServers: { other: { command: 'x' } } }), 'utf8');

    const plan = await clineIntegration.plan(context);
    expect((await clineIntegration.apply(plan, context)).success).toBe(true);
    const result = await clineIntegration.uninstall(context);
    expect(result.success).toBe(true);

    const settings = JSON.parse(await readFile(paths.settingsPath, 'utf8'));
    expect(settings.mcpServers.workjournal).toBeUndefined();
    expect(settings.mcpServers.other).toEqual({ command: 'x' });
    await expect(readFile(paths.pluginEntry, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('cursor integration', () => {
  it('writes mcpServers.workjournal as a stdio entry', async () => {
    await fakeBinary('cursor-agent');
    const context = ctx({ agentId: 'cursor' });

    const plan = await cursorIntegration.plan(context);
    expect(plan.error).toBeUndefined();
    const result = await cursorIntegration.apply(plan, context);
    expect(result.success).toBe(true);

    const paths = resolveCursorPaths(context);
    const settings = JSON.parse(await readFile(paths.settingsPath, 'utf8'));
    expect(settings.mcpServers.workjournal).toEqual({
      type: 'stdio',
      command: COMMAND[0],
      args: COMMAND.slice(1),
    });

    const validation = await cursorIntegration.validate(context);
    expect(validation.valid).toBe(true);
  });

  it('is idempotent — a second plan is all noop', async () => {
    await fakeBinary('cursor-agent');
    const context = ctx({ agentId: 'cursor' });
    const first = await cursorIntegration.plan(context);
    expect((await cursorIntegration.apply(first, context)).success).toBe(true);

    const second = await cursorIntegration.plan(context);
    expect(second.files.every((file) => file.action === 'noop')).toBe(true);
    expect((await cursorIntegration.apply(second, context)).filesModified).toEqual([]);
  });

  it('refuses to clobber a different command unless forced', async () => {
    await fakeBinary('cursor-agent');
    const context = ctx({ agentId: 'cursor' });
    const paths = resolveCursorPaths(context);
    await mkdir(join(home, '.cursor'), { recursive: true });
    await writeFile(
      paths.settingsPath,
      JSON.stringify({ mcpServers: { workjournal: { command: 'node', args: ['other.js'] } } }),
      'utf8',
    );

    const refused = await cursorIntegration.plan(context);
    expect(refused.error).toMatch(/--force/);
    expect((await cursorIntegration.apply(refused, context)).success).toBe(false);

    const forced = await cursorIntegration.plan(ctx({ agentId: 'cursor', force: true }));
    expect((await cursorIntegration.apply(forced, context)).success).toBe(true);
  });

  it('supports project scope paths', async () => {
    await fakeBinary('cursor-agent');
    const context = ctx({ agentId: 'cursor', scope: 'project' });
    const paths = resolveCursorPaths(context);
    expect(paths.settingsPath).toBe(join(cwd, '.cursor', 'mcp.json'));

    const plan = await cursorIntegration.plan(context);
    expect((await cursorIntegration.apply(plan, context)).success).toBe(true);
    const settings = JSON.parse(await readFile(paths.settingsPath, 'utf8'));
    expect(settings.mcpServers.workjournal.command).toEqual(COMMAND[0]);
  });

  it('uninstalls only the managed entry', async () => {
    await fakeBinary('cursor-agent');
    const context = ctx({ agentId: 'cursor' });
    const paths = resolveCursorPaths(context);
    await mkdir(join(home, '.cursor'), { recursive: true });
    await writeFile(
      paths.settingsPath,
      JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } }, null, 2),
      'utf8',
    );
    const plan = await cursorIntegration.plan(context);
    expect((await cursorIntegration.apply(plan, context)).success).toBe(true);

    const result = await cursorIntegration.uninstall(context);
    expect(result.success).toBe(true);
    expect(result.filesModified).toContain(paths.settingsPath);
    const settings = JSON.parse(await readFile(paths.settingsPath, 'utf8'));
    expect(settings.mcpServers.workjournal).toBeUndefined();
    expect(settings.mcpServers.other).toEqual({ command: 'x' });
    expect(settings.theme).toBe('dark');
  });
});

describe('gemini-cli integration', () => {
  it('writes mcpServers plus an extension', async () => {
    await fakeBinary('gemini');
    const context = ctx({ agentId: 'gemini-cli' });

    const plan = await geminiCliIntegration.plan(context);
    expect(plan.error).toBeUndefined();
    const result = await geminiCliIntegration.apply(plan, context);
    expect(result.success).toBe(true);

    const paths = resolveGeminiCliPaths(context);
    const settings = JSON.parse(await readFile(paths.settingsPath, 'utf8'));
    expect(settings.mcpServers.workjournal).toEqual({
      command: COMMAND[0],
      args: COMMAND.slice(1),
      disabled: false,
    });

    const manifest = JSON.parse(await readFile(paths.pluginManifest, 'utf8'));
    expect(manifest.name).toBe('workjournal');
    await expect(readFile(paths.pluginEntry, 'utf8')).resolves.toContain('/api/ingest/events');
    const installManifest = JSON.parse(
      await readFile(join(context.workjournalHome, 'integrations', 'gemini-cli', 'extension', 'manifest.json'), 'utf8'),
    );
    // Note: gemini-cli stores extensions inline, not under workjournalHome.
    expect(manifest.version).toBe(geminiCliPluginVersion);

    const validation = await geminiCliIntegration.validate(context);
    expect(validation.valid).toBe(true);
  });

  it('is idempotent — a second plan is all noop', async () => {
    await fakeBinary('gemini');
    const context = ctx({ agentId: 'gemini-cli' });
    const first = await geminiCliIntegration.plan(context);
    expect((await geminiCliIntegration.apply(first, context)).success).toBe(true);

    const second = await geminiCliIntegration.plan(context);
    expect(second.files.every((file) => file.action === 'noop')).toBe(true);
    expect((await geminiCliIntegration.apply(second, context)).filesModified).toEqual([]);
  });

  it('refuses to clobber a different command unless forced', async () => {
    await fakeBinary('gemini');
    const context = ctx({ agentId: 'gemini-cli' });
    const paths = resolveGeminiCliPaths(context);
    await mkdir(join(home, '.gemini'), { recursive: true });
    await writeFile(
      paths.settingsPath,
      JSON.stringify({ mcpServers: { workjournal: { command: 'node', args: ['other.js'] } } }, null, 2),
      'utf8',
    );

    const refused = await geminiCliIntegration.plan(context);
    expect(refused.error).toMatch(/--force/);
    expect((await geminiCliIntegration.apply(refused, context)).success).toBe(false);

    const forced = await geminiCliIntegration.plan(ctx({ agentId: 'gemini-cli', force: true }));
    expect((await geminiCliIntegration.apply(forced, context)).success).toBe(true);
  });

  it('installs the extension globally, not per project', async () => {
    await fakeBinary('gemini');
    const context = ctx({ agentId: 'gemini-cli', scope: 'project' });
    const paths = resolveGeminiCliPaths(context);

    const plan = await geminiCliIntegration.plan(context);
    expect(plan.files.map((file) => file.path)).not.toContain(paths.pluginEntry);
    expect(plan.warnings?.[0]).toMatch(/--global/);
    expect((await geminiCliIntegration.apply(plan, context)).success).toBe(true);
    await expect(readFile(paths.settingsPath, 'utf8')).resolves.toContain('"workjournal"');
    await expect(readFile(paths.pluginEntry, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uninstalls the entry and extension', async () => {
    await fakeBinary('gemini');
    const context = ctx({ agentId: 'gemini-cli' });
    const paths = resolveGeminiCliPaths(context);
    await mkdir(join(home, '.gemini'), { recursive: true });
    await writeFile(paths.settingsPath, JSON.stringify({ mcpServers: { other: { command: 'x' } } }), 'utf8');

    const plan = await geminiCliIntegration.plan(context);
    expect((await geminiCliIntegration.apply(plan, context)).success).toBe(true);
    const result = await geminiCliIntegration.uninstall(context);
    expect(result.success).toBe(true);

    const settings = JSON.parse(await readFile(paths.settingsPath, 'utf8'));
    expect(settings.mcpServers.workjournal).toBeUndefined();
    expect(settings.mcpServers.other).toEqual({ command: 'x' });
    await expect(readFile(paths.pluginEntry, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('claude-code integration', () => {
  it('writes mcpServers plus hook handler', async () => {
    await fakeBinary('claude');
    const context = ctx({ agentId: 'claude-code' });

    const plan = await claudeCodeIntegration.plan(context);
    expect(plan.error).toBeUndefined();
    const result = await claudeCodeIntegration.apply(plan, context);
    expect(result.success).toBe(true);

    const paths = resolveClaudeCodePaths(context);
    const settings = JSON.parse(await readFile(paths.mcpPath, 'utf8'));
    expect(settings.mcpServers.workjournal).toEqual({
      command: COMMAND[0],
      args: COMMAND.slice(1),
      disabled: false,
    });

    await expect(readFile(paths.hookHandler, 'utf8')).resolves.toContain('/api/ingest/events');

    const validation = await claudeCodeIntegration.validate(context);
    expect(validation.valid).toBe(true);
  });

  it('is idempotent — a second plan is all noop', async () => {
    await fakeBinary('claude');
    const context = ctx({ agentId: 'claude-code' });
    const first = await claudeCodeIntegration.plan(context);
    expect((await claudeCodeIntegration.apply(first, context)).success).toBe(true);

    const second = await claudeCodeIntegration.plan(context);
    expect(second.files.every((file) => file.action === 'noop')).toBe(true);
    expect((await claudeCodeIntegration.apply(second, context)).filesModified).toEqual([]);
  });

  it('refuses to clobber a different command unless forced', async () => {
    await fakeBinary('claude');
    const context = ctx({ agentId: 'claude-code' });
    const paths = resolveClaudeCodePaths(context);
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      paths.mcpPath,
      JSON.stringify({ mcpServers: { workjournal: { command: 'node', args: ['other.js'] } } }, null, 2),
      'utf8',
    );

    const refused = await claudeCodeIntegration.plan(context);
    expect(refused.error).toMatch(/--force/);
    expect((await claudeCodeIntegration.apply(refused, context)).success).toBe(false);

    const forced = await claudeCodeIntegration.plan(ctx({ agentId: 'claude-code', force: true }));
    expect((await claudeCodeIntegration.apply(forced, context)).success).toBe(true);
  });

  it('supports project scope paths', async () => {
    await fakeBinary('claude');
    const context = ctx({ agentId: 'claude-code', scope: 'project' });
    const paths = resolveClaudeCodePaths(context);
    expect(paths.mcpPath).toBe(join(cwd, '.mcp.json'));

    const plan = await claudeCodeIntegration.plan(context);
    expect((await claudeCodeIntegration.apply(plan, context)).success).toBe(true);
    const settings = JSON.parse(await readFile(paths.mcpPath, 'utf8'));
    expect(settings.mcpServers.workjournal.command).toEqual(COMMAND[0]);
  });

  it('uninstalls the entry and hook handler', async () => {
    await fakeBinary('claude');
    const context = ctx({ agentId: 'claude-code' });
    const paths = resolveClaudeCodePaths(context);
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(paths.mcpPath, JSON.stringify({ mcpServers: { other: { command: 'x' } } }), 'utf8');

    const plan = await claudeCodeIntegration.plan(context);
    expect((await claudeCodeIntegration.apply(plan, context)).success).toBe(true);
    const result = await claudeCodeIntegration.uninstall(context);
    expect(result.success).toBe(true);

    const settings = JSON.parse(await readFile(paths.mcpPath, 'utf8'));
    expect(settings.mcpServers.workjournal).toBeUndefined();
    expect(settings.mcpServers.other).toEqual({ command: 'x' });
    await expect(readFile(paths.hookHandler, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('antigravity-cli integration', () => {
  it('writes mcpServers in mcp_config.json plus a plugin', async () => {
    await fakeBinary('agy');
    const context = ctx({ agentId: 'antigravity-cli' });

    const plan = await antigravityCliIntegration.plan(context);
    expect(plan.error).toBeUndefined();
    const result = await antigravityCliIntegration.apply(plan, context);
    expect(result.success).toBe(true);

    const paths = resolveAntigravityCliPaths(context);
    const config = JSON.parse(await readFile(paths.mcpConfigPath, 'utf8'));
    expect(config.mcpServers.workjournal).toEqual({
      command: COMMAND[0],
      args: COMMAND.slice(1),
      disabled: false,
    });

    await expect(readFile(paths.pluginEntry, 'utf8')).resolves.toContain('/api/ingest/events');
    const stagedManifest = JSON.parse(
      await readFile(
        join(context.workjournalHome, 'integrations', 'antigravity-cli', 'plugin', 'manifest.json'),
        'utf8',
      ),
    );
    expect(stagedManifest.version).toBe(antigravityCliPluginVersion);

    const validation = await antigravityCliIntegration.validate(context);
    expect(validation.valid).toBe(true);
  });

  it('is idempotent — a second plan is all noop', async () => {
    await fakeBinary('agy');
    const context = ctx({ agentId: 'antigravity-cli' });
    const first = await antigravityCliIntegration.plan(context);
    expect((await antigravityCliIntegration.apply(first, context)).success).toBe(true);

    const second = await antigravityCliIntegration.plan(context);
    expect(second.files.every((file) => file.action === 'noop')).toBe(true);
    expect((await antigravityCliIntegration.apply(second, context)).filesModified).toEqual([]);
  });

  it('refuses to clobber a different command unless forced', async () => {
    await fakeBinary('agy');
    const context = ctx({ agentId: 'antigravity-cli' });
    const paths = resolveAntigravityCliPaths(context);
    await mkdir(join(home, '.gemini', 'config'), { recursive: true });
    await writeFile(
      paths.mcpConfigPath,
      JSON.stringify({ mcpServers: { workjournal: { command: 'node', args: ['other.js'] } } }, null, 2),
      'utf8',
    );

    const refused = await antigravityCliIntegration.plan(context);
    expect(refused.error).toMatch(/--force/);
    expect((await antigravityCliIntegration.apply(refused, context)).success).toBe(false);

    const forced = await antigravityCliIntegration.plan(ctx({ agentId: 'antigravity-cli', force: true }));
    expect((await antigravityCliIntegration.apply(forced, context)).success).toBe(true);
  });

  it('supports project scope paths', async () => {
    await fakeBinary('agy');
    const context = ctx({ agentId: 'antigravity-cli', scope: 'project' });
    const paths = resolveAntigravityCliPaths(context);
    expect(paths.mcpConfigPath).toBe(join(cwd, '.agents', 'mcp_config.json'));
    expect(paths.pluginEntry).toBe(join(cwd, '.agents', 'plugins', 'workjournal'));

    const plan = await antigravityCliIntegration.plan(context);
    expect(plan.files.map((file) => file.path)).not.toContain(paths.pluginEntry);
    expect(plan.warnings?.[0]).toMatch(/--global/);
    expect((await antigravityCliIntegration.apply(plan, context)).success).toBe(true);
    const config = JSON.parse(await readFile(paths.mcpConfigPath, 'utf8'));
    expect(config.mcpServers.workjournal.command).toEqual(COMMAND[0]);
  });

  it('uninstalls the entry and plugin', async () => {
    await fakeBinary('agy');
    const context = ctx({ agentId: 'antigravity-cli' });
    const paths = resolveAntigravityCliPaths(context);
    await mkdir(join(home, '.gemini', 'config'), { recursive: true });
    await writeFile(paths.mcpConfigPath, JSON.stringify({ mcpServers: { other: { command: 'x' } } }), 'utf8');

    const plan = await antigravityCliIntegration.plan(context);
    expect((await antigravityCliIntegration.apply(plan, context)).success).toBe(true);
    const result = await antigravityCliIntegration.uninstall(context);
    expect(result.success).toBe(true);

    const config = JSON.parse(await readFile(paths.mcpConfigPath, 'utf8'));
    expect(config.mcpServers.workjournal).toBeUndefined();
    expect(config.mcpServers.other).toEqual({ command: 'x' });
    await expect(readFile(paths.pluginEntry, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('discovery', () => {
  it('reports not_installed when the binary is absent', async () => {
    process.env.PATH = binDir;
    const result = await opencodeIntegration.discover(ctx());
    expect(result.state).toBe('not_installed');
  });

  it('reports installed_not_configured before setup and configured after', async () => {
    await fakeBinary('opencode');
    const context = ctx();
    expect((await opencodeIntegration.discover(context)).state).toBe('installed_not_configured');

    const plan = await opencodeIntegration.plan(context);
    await opencodeIntegration.apply(plan, context);
    expect((await opencodeIntegration.discover(context)).state).toBe('configured');
  });

  it('surfaces configuration_error for unparseable config', async () => {
    await fakeBinary('cline');
    const context = ctx({ agentId: 'cline' });
    const paths = resolveClinePaths(context);
    await mkdir(join(home, '.cline', 'data', 'settings'), { recursive: true });
    await writeFile(paths.settingsPath, '{ bad', 'utf8');

    const result = await clineIntegration.discover(context);
    expect(result.state).toBe('configuration_error');
    expect(result.parseError?.file).toBe(paths.settingsPath);
  });

  it('reports not_installed for cursor when cursor-agent is absent', async () => {
    process.env.PATH = binDir;
    const result = await cursorIntegration.discover(ctx({ agentId: 'cursor' }));
    expect(result.state).toBe('not_installed');
  });

  it('reports installed_not_configured before setup and configured after for cursor', async () => {
    await fakeBinary('cursor-agent');
    const context = ctx({ agentId: 'cursor' });
    expect((await cursorIntegration.discover(context)).state).toBe('installed_not_configured');

    const plan = await cursorIntegration.plan(context);
    await cursorIntegration.apply(plan, context);
    expect((await cursorIntegration.discover(context)).state).toBe('configured');
  });

  it('reports not_installed for gemini-cli when gemini is absent', async () => {
    process.env.PATH = binDir;
    const result = await geminiCliIntegration.discover(ctx({ agentId: 'gemini-cli' }));
    expect(result.state).toBe('not_installed');
  });

  it('reports installed_not_configured before setup and configured after for gemini-cli', async () => {
    await fakeBinary('gemini');
    const context = ctx({ agentId: 'gemini-cli' });
    expect((await geminiCliIntegration.discover(context)).state).toBe('installed_not_configured');

    const plan = await geminiCliIntegration.plan(context);
    await geminiCliIntegration.apply(plan, context);
    expect((await geminiCliIntegration.discover(context)).state).toBe('configured');
  });

  it('reports not_installed for claude-code when claude is absent', async () => {
    process.env.PATH = binDir;
    const result = await claudeCodeIntegration.discover(ctx({ agentId: 'claude-code' }));
    expect(result.state).toBe('not_installed');
  });

  it('reports installed_not_configured before setup and configured after for claude-code', async () => {
    await fakeBinary('claude');
    const context = ctx({ agentId: 'claude-code' });
    expect((await claudeCodeIntegration.discover(context)).state).toBe('installed_not_configured');

    const plan = await claudeCodeIntegration.plan(context);
    await claudeCodeIntegration.apply(plan, context);
    expect((await claudeCodeIntegration.discover(context)).state).toBe('configured');
  });

  it('reports not_installed for antigravity-cli when agy is absent', async () => {
    process.env.PATH = binDir;
    const result = await antigravityCliIntegration.discover(ctx({ agentId: 'antigravity-cli' }));
    expect(result.state).toBe('not_installed');
  });

  it('reports installed_not_configured before setup and configured after for antigravity-cli', async () => {
    await fakeBinary('agy');
    const context = ctx({ agentId: 'antigravity-cli' });
    expect((await antigravityCliIntegration.discover(context)).state).toBe('installed_not_configured');

    const plan = await antigravityCliIntegration.plan(context);
    await antigravityCliIntegration.apply(plan, context);
    expect((await antigravityCliIntegration.discover(context)).state).toBe('configured');
  });
});
