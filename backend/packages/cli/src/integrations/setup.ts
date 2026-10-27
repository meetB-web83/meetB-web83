/**
 * `workjournal setup` command (plan §10.6, D-021, D-024).
 *
 * Interactive zero-dependency `node:readline` multiselect for agent integration
 * setup. Supports --agent, --global|--project, --dry-run, --yes, --force,
 * --uninstall, --status flags.
 *
 * Exit codes are meaningful: a failed write, a plan the adapter refuses to
 * apply (unparseable or conflicting config), or a post-apply validation
 * failure all exit non-zero. "Success" is only printed after both the apply
 * and the validation step pass.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { SetupContext, SetupEnv } from './types.js';
import { AGENT_INTEGRATIONS, findIntegration } from './registry.js';

/** Minimal readline wrapper (no external deps, SEA-safe). */
function ask(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

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
    console.error('--global and --project are mutually exclusive.');
    process.exitCode = 1;
    return;
  }

  const env = buildEnv(opts);

  // --status: show discovery state and the config files that were inspected.
  if (opts.status) {
    console.log('Agent integration status:');
    for (const integration of AGENT_INTEGRATIONS) {
      const result = await integration.discover(env);
      console.log(`\n  ${integration.id} (${integration.displayName}): ${result.state}`);
      for (const e of result.evidence) {
        console.log(`    - ${e}`);
      }
      if (result.paths.length > 0) {
        console.log('    checked:');
        for (const p of result.paths) console.log(`      ${p}`);
      }
      if (result.parseError) {
        console.log(`    parse error in ${result.parseError.file}: ${result.parseError.message}`);
      }
    }
    console.log('');
    return;
  }

  // --uninstall: uninstall the specified agent integration.
  if (opts.uninstall) {
    const integration = opts.agent
      ? findIntegration(opts.agent)
      : undefined;
    if (!integration) {
      console.error(opts.agent ? `Unknown agent: ${opts.agent}` : '--uninstall requires --agent <id>');
      process.exitCode = 1;
      return;
    }
    const ctx = buildContext(integration.id, opts, env);
    const result = await integration.uninstall(ctx);
    if (!result.success) {
      console.error(`Uninstall failed: ${result.error ?? 'unknown error'}`);
      process.exitCode = 1;
      return;
    }
    if (result.filesModified.length === 0) {
      console.log(`${integration.id} was not configured — nothing to remove.`);
    } else {
      console.log(`Uninstalled ${integration.id}:`);
      for (const f of result.filesModified) console.log(`  modified: ${f}`);
    }
    if (result.backups && result.backups.length > 0) {
      for (const b of result.backups) console.log(`  backup: ${b}`);
    }
    return;
  }

  // Interactive or agent-selected setup.
  const selectedAgent = opts.agent || (await selectAgent());
  const integration = findIntegration(selectedAgent);
  if (!integration) {
    console.error(`Unknown agent: ${selectedAgent}`);
    process.exitCode = 1;
    return;
  }

  const discovery = await integration.discover(env);
  console.log(`\n${integration.displayName} (${integration.id}) — ${discovery.state}`);
  for (const e of discovery.evidence) {
    console.log(`  - ${e}`);
  }

  if (discovery.state === 'not_installed') {
    console.error(
      `\n${integration.displayName} is not installed or not on PATH. ` +
        'Install it first, then re-run setup. No files were written.',
    );
    process.exitCode = 1;
    return;
  }
  if (discovery.state === 'configuration_error') {
    const where = discovery.parseError?.file ?? 'the existing config';
    console.error(
      `\nCannot configure ${integration.displayName}: ${where} is not valid JSON/JSONC. ` +
        'Fix or remove it, then re-run setup. No files were written.',
    );
    process.exitCode = 1;
    return;
  }

  const ctx = buildContext(selectedAgent, opts, env);
  const plan = await integration.plan(ctx);
  if (plan.error) {
    console.error(`\nCannot configure ${selectedAgent}: ${plan.error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nPlanned changes for ${selectedAgent} (scope: ${ctx.scope}):`);
  for (const file of plan.files) {
    console.log(`  ${file.action}: ${file.path}`);
  }
  for (const entry of plan.managedEntries) {
    console.log(`  set ${entry.key} = ${entry.value}  (${entry.file})`);
  }
  for (const warning of plan.warnings ?? []) {
    console.log(`  note: ${warning}`);
  }

  if (opts.dryRun) {
    console.log('\nDry run complete — no changes made.');
    return;
  }

  if (!opts.yes && !opts.force) {
    const confirm = await ask('\nApply these changes? (y/N) ');
    if (confirm.trim().toLowerCase() !== 'y') {
      console.log('Cancelled.');
      return;
    }
  }

  const result = await integration.apply(plan, ctx);
  if (!result.success) {
    console.error(`\nSetup failed: ${result.error ?? 'unknown error'}`);
    if (result.backups && result.backups.length > 0) {
      console.error('Restored from backups:');
      for (const b of result.backups) console.error(`  ${b}`);
    }
    process.exitCode = 1;
    return;
  }

  // Validation runs against what is actually on disk, not the plan.
  const validation = await integration.validate(ctx);
  if (!validation.valid) {
    console.error(`\n${selectedAgent} was written but validation failed:`);
    for (const d of validation.details) console.error(`  - ${d}`);
    process.exitCode = 1;
    return;
  }

  if (result.filesModified.length === 0) {
    console.log(`\n${selectedAgent} is already configured — no changes made.`);
  } else {
    console.log(`\n${selectedAgent} configured successfully.`);
    for (const f of result.filesModified) console.log(`  wrote: ${f}`);
  }
  if (result.backups && result.backups.length > 0) {
    for (const b of result.backups) console.log(`  backup: ${b}`);
  }
  if (validation.details.length > 0) {
    console.log('Validation:');
    for (const d of validation.details) console.log(`  - ${d}`);
  }
}

async function selectAgent(): Promise<string> {
  console.log('\nSelect an agent to configure:');
  let i = 1;
  for (const integration of AGENT_INTEGRATIONS) {
    console.log(`  ${i++}. ${integration.displayName} (${integration.id})`);
  }
  const answer = await ask('\nEnter number: ');
  const idx = parseInt(answer.trim(), 10) - 1;
  if (idx < 0 || idx >= AGENT_INTEGRATIONS.length) {
    console.error('Invalid selection.');
    process.exit(1);
  }
  return AGENT_INTEGRATIONS[idx].id;
}
