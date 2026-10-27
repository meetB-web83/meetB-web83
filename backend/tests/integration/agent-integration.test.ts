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
import { resolveOpencodePaths } from '../../packages/cli/src/integrations/adapters/opencode/discovery.js';
import { resolveClinePaths } from '../../packages/cli/src/integrations/adapters/cline/discovery.js';
import { clinePluginVersion } from '../../packages/cli/src/integrations/adapters/cline/plugin.generated.js';
import { opencodePluginVersion } from '../../packages/cli/src/integrations/adapters/opencode/plugin.generated.js';
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
});
