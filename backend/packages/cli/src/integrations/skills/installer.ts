/**
 * WorkJournal Skills Installer (Addendum A).
 *
 * Installs WorkJournal skills into each agent's global skills directory
 * and maintains a mirror copy in ~/.workjournal/skills/.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import type { Skill, SkillsInstallResult, SkillsInstallSummary, AgentSkillTarget } from './types.js';
import { AGENT_SKILL_PATHS, resolveGlobalSkillsDir, workjournalSkillsDir, AgentId } from './agent-paths.js';
import { WORKJOURNAL_SKILLS, getAllSkillIds } from './registry.js';
import {
  atomicWrite,
  backupFile,
  fileExists,
  readConfigFile,
  writeManagedFile,
} from '../safe-config.js';

/** ANSI color helpers (same as setup.ts). */
const supportsColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (str: string, code: string) => (supportsColor ? `${code}${str}\x1b[0m` : str);
const color = {
  red: (s: string) => c(s, '\x1b[31m'),
  green: (s: string) => c(s, '\x1b[32m'),
  yellow: (s: string) => c(s, '\x1b[33m'),
  blue: (s: string) => c(s, '\x1b[34m'),
  cyan: (s: string) => c(s, '\x1b[36m'),
  gray: (s: string) => c(s, '\x1b[90m'),
  bold: (s: string) => c(s, '\x1b[1m'),
} as const;

const success = (s: string) => color.green(`✓ ${s}`);
const error = (s: string) => color.red(`✕ ${s}`);
const warning = (s: string) => color.yellow(`⚠ ${s}`);
const info = (s: string) => color.blue(`ℹ ${s}`);

/** Format skill content for a specific agent. */
function formatSkillForAgent(skill: Skill, agentId: string): string {
  // All agents currently use Markdown with frontmatter
  // Agent-specific formatting can be added here later
  const frontmatter = `---
id: ${skill.id}
name: ${skill.name}
description: ${skill.description}
source: workjournal
---`;

  return `${frontmatter}\n\n${skill.content}`;
}

/** Ensure directory exists. */
async function ensureDir(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true });
}

/** Install skills for a single agent. */
async function installSkillsForAgent(
  agentId: string,
  agentDisplayName: string,
  workjournalHome: string,
  homeDir: string,
  skillsToInstall: readonly Skill[],
  dryRun: boolean = false
): Promise<SkillsInstallResult> {
  const skillsInstalled: Array<{ skillId: string; path: string }> = [];
  const skillsSkipped: Array<{ skillId: string; reason: string }> = [];

  try {
    // Resolve global skills directory
    const { path: globalDir, isFallback } = await resolveGlobalSkillsDir(
      agentId as AgentId,
      homeDir,
      { existsSync }
    );

    // WorkJournal mirror directory
    const mirrorDir = workjournalSkillsDir(workjournalHome, agentId as AgentId);

    if (!dryRun) {
      await ensureDir(globalDir);
      await ensureDir(mirrorDir);
    }

    const config = AGENT_SKILL_PATHS[agentId as AgentId];
    const extension = config?.extension ?? '.md';

    // Log the target directory
    console.log(`  ${color.cyan('Target:')} ${globalDir}${isFallback ? color.yellow(' (fallback)') : ''}`);
    console.log(`  ${color.cyan('Mirror:')} ${mirrorDir}`);

    for (const skill of skillsToInstall) {
      const filename = `${skill.filename}${extension}`;
      const targetPath = join(globalDir, filename);
      const mirrorPath = join(mirrorDir, filename);
      const content = formatSkillForAgent(skill, agentId);

      // Check if already exists with same content
      let skip = false;
      if (await fileExists(targetPath)) {
        const existing = await fs.readFile(targetPath, 'utf-8');
        if (existing === content) {
          skillsSkipped.push({ skillId: skill.id, reason: 'already up to date' });
          skip = true;
        }
      }

      if (!skip) {
        if (!dryRun) {
          // Write to agent's global skills directory
          await writeManagedFile(targetPath, content);
          // Write to WorkJournal mirror
          await writeManagedFile(mirrorPath, content);
        }
        skillsInstalled.push({ skillId: skill.id, path: targetPath });
        console.log(`  ${color.green('+')} ${filename} → ${targetPath}`);
      } else {
        console.log(`  ${color.gray('·')} ${filename} (unchanged)`);
      }
    }

    return {
      agentId,
      agentDisplayName,
      success: true,
      skillsInstalled,
      skillsSkipped,
      workjournalMirrorPath: mirrorDir,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      agentId,
      agentDisplayName,
      success: false,
      skillsInstalled,
      skillsSkipped,
      error: msg,
      workjournalMirrorPath: workjournalSkillsDir(workjournalHome, agentId as AgentId),
    };
  }
}

/**
 * Install WorkJournal skills for multiple agents.
 * Called from setup.ts after agent configuration.
 */
export async function installSkillsForAgents(
  agentIds: string[],
  workjournalHome: string,
  homeDir: string,
  dryRun: boolean = false
): Promise<SkillsInstallSummary> {
  const results: SkillsInstallResult[] = [];

  console.log(`\n${color.blue('◆')} Installing WorkJournal skills globally...`);

  for (const agentId of agentIds) {
    const config = AGENT_SKILL_PATHS[agentId as AgentId];
    const displayName = config?.agentId ?? agentId;

    console.log(`\n  ${color.bold(displayName)} (${agentId}):`);

    const result = await installSkillsForAgent(
      agentId,
      displayName,
      workjournalHome,
      homeDir,
      WORKJOURNAL_SKILLS,
      dryRun
    );

    results.push(result);

    if (result.success) {
      console.log(`    ${success(`${result.skillsInstalled.length} installed, ${result.skillsSkipped.length} skipped`)}`);
    } else {
      console.log(`    ${error(`Failed: ${result.error}`)}`);
    }
  }

  const successfulAgents = results.filter((r) => r.success).length;
  const failedAgents = results.filter((r) => !r.success).length;

  return {
    totalAgents: results.length,
    successfulAgents,
    failedAgents,
    results,
  };
}

/** Print skills installation summary. */
export function printSkillsSummary(summary: SkillsInstallSummary): void {
  console.log(`\n${color.blue('Skills Installation Summary:')}`);
  console.log(`  ${color.green(`${summary.successfulAgents} successful`)}, ${color.red(`${summary.failedAgents} failed`)}`);

  for (const result of summary.results) {
    const mark = result.success ? color.green('✓') : color.red('✕');
    console.log(`  ${mark} ${color.cyan(result.agentDisplayName)} (${result.agentId}): ${result.skillsInstalled.length} installed, ${result.skillsSkipped.length} skipped`);
    if (result.error) {
      console.log(`    ${color.red(result.error)}`);
    }
    console.log(`    ${color.gray('Mirror:')} ${result.workjournalMirrorPath}`);
  }
}