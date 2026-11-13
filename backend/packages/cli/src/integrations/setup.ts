/**
 * `workjournal setup` command (plan §10.6, D-021, D-024).
 *
 * Interactive terminal UI for agent integration setup, powered by
 * `@clack/prompts` (the same library Vite's `create-vite` uses).
 * Supports --agent, --global|--project, --dry-run, --yes, --force,
 * --uninstall, --status flags.
 *
 * Exit codes are meaningful: a failed write, a plan the adapter refuses to
 * apply (unparseable or conflicting config), or a post-apply validation
 * failure all exit non-zero. "Success" is only printed after both the apply
 * and the validation step pass.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  cancel,
  confirm,
  intro,
  isCancel,
  outro,
  select,
  log,
} from '@clack/prompts';
import { emitKeypressEvents } from 'node:readline';
import type { SetupContext, SetupEnv } from './types.js';
import { AGENT_INTEGRATIONS, findIntegration } from './registry.js';
import { installSkillsForAgents, printSkillsSummary } from './skills/index.js';

// ── ANSI color helpers (zero-dependency, SEA-safe) ─────────────────────────

const supportsColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (str: string, code: string) => (supportsColor ? `${code}${str}\x1b[0m` : str);
const color = {
  red: (s: string) => c(s, '\x1b[31m'),
  green: (s: string) => c(s, '\x1b[32m'),
  yellow: (s: string) => c(s, '\x1b[33m'),
  blue: (s: string) => c(s, '\x1b[34m'),
  magenta: (s: string) => c(s, '\x1b[35m'),
  cyan: (s: string) => c(s, '\x1b[36m'),
  gray: (s: string) => c(s, '\x1b[90m'),
  bold: (s: string) => c(s, '\x1b[1m'),
} as const;

const success = (s: string) => color.green(`✓ ${s}`);
const error = (s: string) => color.red(`✕ ${s}`);
const warning = (s: string) => color.yellow(`⚠ ${s}`);
const info = (s: string) => color.blue(`ℹ ${s}`);

export interface SetupOptions {
  agent?: string;
  global?: boolean;
  project?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
  uninstall?: boolean;
  status?: boolean;
}

function buildEnv(opts: SetupOptions): SetupEnv {
  return {
    cwd: process.cwd(),
    platform: process.platform as SetupEnv['platform'],
    workjournalHome: process.env.WORKJOURNAL_HOME ?? join(homedir(), '.workjournal'),
    homeDir: homedir(),
    scope: opts.project ? 'project' : 'global',
  };
}

function buildContext(agentId: string, opts: SetupOptions, env: SetupEnv): SetupContext {
  return {
    ...env,
    agentId,
    scope: env.scope ?? 'global',
    yes: !!opts.yes,
    force: !!opts.force,
    dryRun: !!opts.dryRun,
  };
}

export async function setupCommand(opts: SetupOptions): Promise<void> {
  if (opts.global && opts.project) {
    console.error(`${color.red('Error:')} --global and --project are mutually exclusive.`);
    process.exitCode = 1;
    return;
  }

  const env = buildEnv(opts);

  // ── Header ───────────────────────────────────────────────────────────────
  intro(`${color.blue('WorkJournal Setup')} — configure agent integrations (OpenCode, Cline, etc.)`);

  // --status: show discovery state and the config files that were inspected.
  if (opts.status) {
    log.step('Agent integration status');
    for (const integration of AGENT_INTEGRATIONS) {
      const result = await integration.discover(env);
      console.log(`\n  ${color.cyan(integration.displayName)} (${integration.id}): ${result.state}`);
      for (const e of result.evidence) {
        console.log(`    ${color.gray('•')} ${e}`);
      }
      if (result.paths.length > 0) {
        console.log(`    ${color.gray('checked:')}`);
        for (const p of result.paths) console.log(`      ${color.gray(p)}`);
      }
      if (result.parseError) {
        console.log(`    ${color.red('parse error')} in ${result.parseError.file}: ${result.parseError.message}`);
      }
    }
    console.log();
    outro();
    return;
  }

  // --uninstall: uninstall the specified agent integration.
  if (opts.uninstall) {
    const integration = opts.agent ? findIntegration(opts.agent) : undefined;
    if (!integration) {
      console.error(opts.agent ? `${color.red(`Unknown agent: ${opts.agent}`)}` : `${color.red('--uninstall requires --agent <id>')}`);
      process.exitCode = 1;
      return;
    }
    const ctx = buildContext(integration.id, opts, env);
    const result = await integration.uninstall(ctx);
    if (!result.success) {
      console.error(`${color.red(`Uninstall failed: ${result.error ?? 'unknown error'}`)}`);
      process.exitCode = 1;
      return;
    }
    if (result.filesModified.length === 0) {
      console.log(`${integration.id} was not configured — nothing to remove.`);
    } else {
      console.log(`Uninstalled ${integration.id}:`);
      for (const f of result.filesModified) console.log(`  ${color.gray('modified:')} ${f}`);
    }
    if (result.backups && result.backups.length > 0) {
      for (const b of result.backups) console.log(`  ${color.gray('backup:')} ${b}`);
    }
    outro();
    return;
  }

  // ── Interactive or agent-selected setup ──────────────────────────────────
  const selectedAgents = opts.agent ? [opts.agent] : await selectAgents(env);

  const results: Array<{
    agentId: string;
    displayName: string;
    state: 'ok' | 'skipped' | 'failed';
    error?: string;
    filesModified: string[];
    backups: string[];
  }> = [];

  for (const agentId of selectedAgents) {
    const integration = findIntegration(agentId);
    if (!integration) {
      console.error(`${color.red(`Unknown agent: ${agentId}`)}`);
      results.push({ agentId, displayName: agentId, state: 'failed', error: 'unknown agent', filesModified: [], backups: [] });
      continue;
    }

    const discovery = await integration.discover(env);
    log.step(`${integration.displayName} (${agentId}) — ${discovery.state}`);
    for (const e of discovery.evidence) {
      console.log(`    ${color.gray('•')} ${e}`);
    }

    if (discovery.state === 'not_installed') {
      log.message(`${color.yellow('⚠')} ${integration.displayName} is not installed or not on PATH — skipping. Install it first, then re-run setup. No files were written.`);
      results.push({ agentId, displayName: integration.displayName, state: 'skipped', error: 'not_installed', filesModified: [], backups: [] });
      continue;
    }
    if (discovery.state === 'configuration_error') {
      const where = discovery.parseError?.file ?? 'the existing config';
      log.message(`${color.yellow('⚠')} ${integration.displayName} cannot be configured: ${where} is not valid JSON/JSONC — skipping. Fix or remove it, then re-run setup. No files were written.`);
      results.push({ agentId, displayName: integration.displayName, state: 'skipped', error: 'configuration_error', filesModified: [], backups: [] });
      continue;
    }

    const ctx = buildContext(agentId, opts, env);
    const plan = await integration.plan(ctx);
    if (plan.error) {
      log.message(`${color.red(`Cannot configure ${agentId}: ${plan.error}`)} — skipping.`);
      results.push({ agentId, displayName: integration.displayName, state: 'failed', error: plan.error, filesModified: [], backups: [] });
      continue;
    }

    console.log(`\n${color.blue('Planned changes')} for ${agentId} (scope: ${ctx.scope}):`);
    for (const file of plan.files) {
      const mark = file.action === 'noop' ? color.gray('·') : file.action === 'create' ? color.green('+') : color.blue('~');
      console.log(`  ${mark} ${file.path}`);
    }
    for (const entry of plan.managedEntries) {
      console.log(`  ${color.gray('set:')} ${entry.key} = ${entry.value}  (${entry.file})`);
    }
    for (const warn of plan.warnings ?? []) {
      console.log(`  ${color.yellow('note:')} ${warn}`);
    }

    if (opts.dryRun) {
      results.push({ agentId, displayName: integration.displayName, state: 'ok', filesModified: [], backups: [] });
      continue;
    }

    if (!opts.yes && !opts.force) {
      const shouldApply = await confirm({
        message: `Apply changes for ${agentId}?`,
        initialValue: true,
      });
      if (isCancel(shouldApply)) {
        cancel('Setup cancelled.');
        process.exitCode = 0;
        return;
      }
      if (!shouldApply) {
        log.message(`${color.yellow('⚠')} Skipped ${agentId}.`);
        results.push({ agentId, displayName: integration.displayName, state: 'skipped', filesModified: [], backups: [] });
        continue;
      }
    }

    const result = await integration.apply(plan, ctx);
    if (!result.success) {
      console.error(`${color.red(`Setup failed for ${agentId}: ${result.error ?? 'unknown error'}`)}`);
      if (result.backups && result.backups.length > 0) {
        console.error(`${color.gray('Restored from backups:')}`);
        for (const b of result.backups) console.error(`  ${color.gray(b)}`);
      }
      results.push({ agentId, displayName: integration.displayName, state: 'failed', error: result.error, filesModified: result.filesModified, backups: result.backups ?? [] });
      continue;
    }

    const validation = await integration.validate(ctx);
    if (!validation.valid) {
      console.error(`${color.red(`${agentId} was written but validation failed:`)}`);
      for (const d of validation.details) console.error(`  ${color.gray('•')} ${d}`);
      results.push({ agentId, displayName: integration.displayName, state: 'failed', error: 'validation failed', filesModified: result.filesModified, backups: result.backups ?? [] });
      continue;
    }

    results.push({
      agentId,
      displayName: integration.displayName,
      state: 'ok',
      filesModified: result.filesModified,
      backups: result.backups ?? [],
    });

    if (result.filesModified.length === 0) {
      log.message(`${color.green('✓')} ${integration.displayName} is already configured — no changes made.`);
    } else {
      log.message(`${color.green('✓')} ${integration.displayName} configured successfully.`);
      for (const f of result.filesModified) console.log(`  ${color.gray('wrote:')} ${f}`);
    }
    for (const b of result.backups ?? []) console.log(`  ${color.gray('backup:')} ${b}`);
    if (validation.details.length > 0) {
      log.message(`${color.blue('Validation:')}`);
      for (const d of validation.details) console.log(`  ${color.gray('•')} ${d}`);
    }
  }

  // ── Skills installation prompt ──────────────────────────────────────────────
  // Only prompt if we have successfully configured agents and not in dry-run mode
  const successfulAgents = results.filter((r) => r.state === 'ok').map((r) => r.agentId);
  if (successfulAgents.length > 0 && !opts.dryRun) {
    const shouldInstallSkills = await confirm({
      message: 'Install WorkJournal skills for selected agents globally?',
      initialValue: true,
    });
    if (!isCancel(shouldInstallSkills) && shouldInstallSkills) {
      const skillsSummary = await installSkillsForAgents(
        successfulAgents,
        env.workjournalHome,
        env.homeDir ?? homedir(),
        false
      );
      printSkillsSummary(skillsSummary);
    }
  }

  if (opts.dryRun) {
    log.message(`${color.yellow('⚠')} Dry run complete — no changes made.`);
    outro();
    return;
  }

  // ── Consolidated summary ─────────────────────────────────────────────────
  outro(`${color.green(String(results.filter((r) => r.state === 'ok').length))} configured, ${color.yellow(String(results.filter((r) => r.state === 'skipped').length))} skipped, ${color.red(String(results.filter((r) => r.state === 'failed').length))} failed.`);

  for (const r of results) {
    const mark = r.state === 'ok' ? color.green('✓') : r.state === 'skipped' ? color.yellow('⚠') : color.red('✕');
    console.log(`  ${mark} ${color.cyan(r.displayName)} (${r.agentId}): ${r.state}${r.error ? ` — ${color.red(r.error)}` : ''}`);
  }

  const failed = results.filter((r) => r.state === 'failed').length;
  if (failed > 0) process.exitCode = 1;
}

async function selectAgents(env: SetupEnv): Promise<string[]> {
  // Discover all integrations first so we can show their state in the menu.
  const discoveries = await Promise.all(
    AGENT_INTEGRATIONS.map((integration) => integration.discover(env).then((result) => ({ integration, result }))),
  );

  const selectable = discoveries.filter(
    (d) => d.result.state !== 'not_installed' && d.result.state !== 'configuration_error',
  );

  if (selectable.length === 0) {
    console.error(`${color.red('No installable agents found.')} Install an agent (OpenCode, Cline, etc.) first, then re-run setup.`);
    process.exitCode = 1;
    return [];
  }

  const options = discoveries.map((d) => {
    const installed = d.result.state !== 'not_installed' && d.result.state !== 'configuration_error';
    return {
      label: `${d.integration.displayName} (${d.integration.id}) — ${d.result.state}`,
      value: d.integration.id,
      hint: installed ? '' : d.result.state === 'not_installed' ? 'not installed on PATH' : 'invalid config',
      disabled: !installed,
    };
  });

  return runMultiselect(options);
}

/**
 * Custom multiselect TUI that renders a `>` prefix before the active (highlighted)
 * item so the current position is obvious on every terminal, not just via color.
 */
function runMultiselect(options: Array<{ label: string; value: string; hint?: string; disabled: boolean }>): Promise<string[]> {
  return new Promise((resolve) => {
    let activeIndex = 0;
    const selected = new Set<string>();
    let renderedLineCount = 0;
    let done = false;

    const supportsColor = process.stdout.isTTY && !process.env.NO_COLOR;
    const c = (str: string, code: string) => (supportsColor ? `${code}${str}\x1b[0m` : str);
    const localColor = {
      red: (s: string) => c(s, '\x1b[31m'),
      green: (s: string) => c(s, '\x1b[32m'),
      yellow: (s: string) => c(s, '\x1b[33m'),
      blue: (s: string) => c(s, '\x1b[34m'),
      magenta: (s: string) => c(s, '\x1b[35m'),
      cyan: (s: string) => c(s, '\x1b[36m'),
      gray: (s: string) => c(s, '\x1b[90m'),
      bold: (s: string) => c(s, '\x1b[1m'),
    } as const;

    emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);

    const cleanup = () => {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.removeAllListeners('keypress');
      process.stdout.write('\x1b[?25h'); // show cursor
    };

    const render = () => {
      if (done) return;

      let output = '\x1b[?25l'; // hide cursor

      // Move cursor up to start of our list (skip on first render)
      if (renderedLineCount > 0) {
        output += `\x1b[${renderedLineCount}A`;
      }

      output += `${localColor.blue('◆')} Select the agent(s) to configure:\r\n`;

      for (let i = 0; i < options.length; i++) {
        const opt = options[i];
        const isActive = i === activeIndex;
        const isSelected = selected.has(opt.value);

        // Return to column 0, then clear the whole line
        output += '\r\x1b[2K';

        // Active indicator: `>` for the highlighted item, two spaces otherwise
        output += isActive ? localColor.cyan('> ') : '  ';

        // Checkbox state
        if (opt.disabled) {
          output += localColor.gray('[□] ');
        } else {
          output += isSelected ? localColor.green('[■] ') : localColor.gray('[□] ');
        }

        // Label
        if (opt.disabled) {
          output += localColor.gray(opt.label);
        } else {
          output += opt.label;
        }

        // Hint (shown for disabled items)
        if (opt.hint) {
          output += ` ${localColor.gray(opt.hint)}`;
        }

        output += '\r\n';
      }

      // Blank line + footer hint
      output += `\r\n${localColor.gray('↑/↓ to navigate • Space: select • Enter: confirm')}\r\n`;
      output += '\x1b[?25h'; // show cursor

      renderedLineCount = 1 + options.length + 2; // header + items + blank + footer
      process.stdout.write(output);
    };

    process.stdin.on('keypress', (_str, key) => {
      if (done) return;

      if (key.name === 'up') {
        activeIndex = (activeIndex - 1 + options.length) % options.length;
        render();
      } else if (key.name === 'down') {
        activeIndex = (activeIndex + 1) % options.length;
        render();
      } else if (key.name === 'space') {
        const opt = options[activeIndex];
        if (!opt.disabled) {
          if (selected.has(opt.value)) selected.delete(opt.value);
          else selected.add(opt.value);
        }
        render();
      } else if (key.name === 'return' || key.name === 'enter') {
        done = true;
        cleanup();
        resolve(Array.from(selected) as string[]);
      } else if (key.ctrl && key.name === 'c') {
        done = true;
        cleanup();
        cancel('Setup cancelled.');
        process.exitCode = 0;
        resolve([]);
      }
    });

    render();
  });
}
