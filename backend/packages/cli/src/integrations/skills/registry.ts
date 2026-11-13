/**
 * WorkJournal Skills Registry (Addendum A).
 *
 * Pre-defined skills that encode WorkJournal best practices.
 * Each skill is a Markdown document installed into agent skill directories.
 */

import { Skill } from './types.js';

/**
 * Core WorkJournal skills that every agent should have.
 * These teach agents how to use WorkJournal effectively.
 */
export const WORKJOURNAL_SKILLS: readonly Skill[] = [
  {
    id: 'session-start',
    name: 'Start a WorkJournal Session',
    description: 'How to properly start a WorkJournal session and claim a task',
    filename: 'workjournal-session-start',
    content: `# WorkJournal Session Start

## Purpose
This skill teaches you how to properly start a WorkJournal session when you begin working on a task.

## When to Use
Run this at the beginning of every work session, before you start any task work.

## Steps

1. **Start the session**
   \`\`\`
   workjournal_start_session
   \`\`\`
   This returns your in-progress tasks and a resume brief.

2. **Claim a task** (if you have one assigned)
   \`\`\`
   workjournal_start_session({ task_id: "<task-id>", claim: true })
   \`\`\`
   This changes the task status to "in_progress" and records you as the owner.

3. **Read the resume context**
   \`\`\`
   workjournal_get_resume_context({ task_id: "<task-id>", detail: "full" })
   \`\`\`
   This gives you the full context: objective, last checkpoint, active decisions, open issues.

## Key Points
- Always call \`workjournal_start_session\` first - it initializes your agent identity
- Use \`claim: true\` only when you're actually taking ownership of a task
- The resume context is deterministic - same records = same content every time
- Your agent ID format: \`<your-agent-string>_<project-id>\` (wait for user confirmation)

## Example Flow
\`\`\`
# 1. Start session
result = workjournal_start_session()
# Shows: "You have 1 in_progress task: fix-login-bug"

# 2. Claim the task (if not already yours)
workjournal_start_session({ task_id: "fix-login-bug", claim: true })

# 3. Get full context
context = workjournal_get_resume_context({ task_id: "fix-login-bug", detail: "full" })
# Now you have: objective, acceptance criteria, last checkpoint, decisions, issues
\`\`\`
`,
  },
  {
    id: 'task-workflow',
    name: 'Standard Task Workflow',
    description: 'The standard WorkJournal task workflow: claim → work → checkpoint → complete',
    filename: 'workjournal-task-workflow',
    content: `# WorkJournal Task Workflow

## Purpose
This skill defines the standard workflow for working on a WorkJournal task from start to finish.

## Workflow Phases

### 1. CLAIM - Take Ownership
\`\`\`
workjournal_start_session({ task_id: "<id>", claim: true })
\`\`\`
- Changes status: \`open\` → \`in_progress\`
- Records you as owner (enforced by idempotency)
- Creates initial checkpoint automatically

### 2. WORK - Do the Work
- Make code changes, run tests, etc.
- **Checkpoint regularly** (every ~10 edits or 20 minutes)

### 3. CHECKPOINT - Save Progress
\`\`\`
workjournal_checkpoint({
  task_id: "<id>",
  summary: "Implemented user authentication flow",
  next_steps: ["Add password reset", "Write integration tests"],
  done: ["Created auth middleware", "Added JWT validation"],
  findings: ["JWT secret must be rotated quarterly"],
  issues: ["Rate limiting not yet implemented"],
  files: ["src/auth/middleware.ts", "src/auth/jwt.ts"]
})
\`\`\`
- Creates a deterministic resume point
- Another agent can continue from here without this conversation
- Include enough detail for a different agent to continue

### 4. COMPLETE - Finish the Task
\`\`\`
workjournal_update_task({
  task_id: "<id>",
  status: "completed"
})
\`\`\`
- Changes status: \`in_progress\` → \`completed\`
- Requires all acceptance criteria met
- Final checkpoint recommended before completing

## Status Transitions (Enforced)
\`\`\`
open → in_progress → completed
  ↘️ blocked → in_progress (when unblocked)
  ↘️ interrupted → in_progress (when resumed)
  ↘️ cancelled (terminal)
\`\`\`

## Blocking/Interrupting
\`\`\`
workjournal_update_task({ task_id: "<id>", status: "blocked", reason: "Waiting for API key" })
workjournal_update_task({ task_id: "<id>", status: "interrupted", reason: "Session ended" })
\`\`\`

## Key Rules
- **One task at a time** - finish or checkpoint before switching
- **Checkpoint before stopping** - even if interrupted unexpectedly
- **Idempotency keys required** for all state changes
- **Events are append-only** - never modify history
`,
  },
  {
    id: 'handoff-guide',
    name: 'Creating Effective Handoffs',
    description: 'How to create proper handoffs between agents for seamless continuity',
    filename: 'workjournal-handoff-guide',
    content: `# WorkJournal Handoff Guide

## Purpose
This skill teaches you how to create effective handoffs so another agent (or you later) can continue seamlessly.

## What Makes a Good Handoff
A handoff is a **checkpoint with extra context** - it should answer:
- What was done?
- What's next?
- What decisions were made?
- What issues remain?
- What files were changed?

## Handoff Checklist (Use at Every Checkpoint)

### ✅ Progress Summary (1-3 sentences)
\`\`\`
summary: "Refactored the user service to use the new repository pattern. All CRUD operations now go through UserRepository. Tests pass."
\`\`\`

### ✅ Completed Work (bullet list)
\`\`\`
done: [
  "Created UserRepository interface",
  "Implemented UserRepositoryPostgres",
  "Updated UserService to use repository",
  "Migrated 15 existing tests"
]
\`\`\`

### ✅ Current Findings (technical details)
\`\`\`
findings: [
  "PostgreSQL connection pool should be 20 for this workload",
  "Repository pattern allows easy swap to MongoDB later"
]
\`\`\`

### ✅ Unresolved Issues (blockers, TODOs)
\`\`\`
issues: [
  "Need to add transaction support for bulk operations",
  "Soft delete not yet implemented"
]
\`\`\`

### ✅ Next Steps (actionable, ordered)
\`\`\`
next_steps: [
  "Add transaction support to repository",
  "Implement soft delete",
  "Add integration tests for bulk operations"
]
\`\`\`

### ✅ Relevant Files (paths relative to project root)
\`\`\`
files: [
  "src/users/user-repository.ts",
  "src/users/user-repository-postgres.ts",
  "src/users/user-service.ts",
  "tests/users/user-repository.test.ts"
]
\`\`\`

## Handoff vs Regular Checkpoint
- **Regular checkpoint**: Progress save during active work
- **Handoff checkpoint**: End of session, another agent taking over
- **Both use the same tool** - just more detail for handoffs

## Receiving a Handoff
When you receive a handoff:
1. \`workjournal_start_session({ task_id: "<id>", claim: true })\`
2. \`workjournal_get_resume_context({ task_id: "<id>", detail: "full", include_history: true })\`
3. Read the last checkpoint - it has everything you need
4. Continue from \`next_steps\`

## Anti-Patterns to Avoid
❌ Vague summaries: "Worked on user stuff"
❌ Missing next_steps: []
❌ No file references
❌ Skipping checkpoint before handoff
❌ Not claiming the task first
`,
  },
  {
    id: 'recovery-guide',
    name: 'Recovering Interrupted Sessions',
    description: 'How to recover work when a session is interrupted or crashes',
    filename: 'workjournal-recovery-guide',
    content: `# WorkJournal Recovery Guide

## Purpose
This skill teaches you how to recover your work when a session is interrupted, crashed, or you need to switch machines.

## Types of Interruption

### 1. Clean Interruption (You stopped gracefully)
- You ran a checkpoint before stopping
- Task status: \`interrupted\` or \`in_progress\`
- **Recovery**: Just resume normally

### 2. Dirty Interruption (Crash, power loss, forced close)
- No recent checkpoint
- Task status: \`in_progress\`
- **Recovery**: Use resume context + git status

### 3. Machine Switch (Different computer)
- WorkJournal data in \`~/.workjournal\` (global registry)
- Project data in \`<project>/.workjournal\` (project DB)
- **Recovery**: Copy both directories or re-register project

## Recovery Steps

### Step 1: Start Session
\`\`\`
workjournal_start_session()
\`\`\`
Shows your in-progress tasks and their status.

### Step 2: Get Resume Context
\`\`\`
workjournal_get_resume_context({ task_id: "<id>", detail: "full", include_history: true })
\`\`\`
Returns:
- Last checkpoint (progress, next_steps, findings, issues, files)
- All decisions made
- Full event history (if include_history)

### Step 3: Check Git Status
\`\`\`
git status
git diff
\`\`\`
Compare with checkpoint's \`files\` list to see what's uncommitted.

### Step 4: Claim & Continue
\`\`\`
workjournal_start_session({ task_id: "<id>", claim: true })
# Then continue from next_steps
\`\`\`

## If No Checkpoint Exists
1. Check \`git status\` and \`git diff\` for uncommitted changes
2. Check \`git log --oneline -10\` for recent commits
3. Reconstruct from memory + git history
4. Create a "recovery checkpoint" documenting what you know:
\`\`\`
workjournal_checkpoint({
  task_id: "<id>",
  summary: "RECOVERY: Reconstructed from git after crash. Last known work: implemented auth middleware.",
  next_steps: ["Verify tests pass", "Continue with JWT validation"],
  findings: ["Auth middleware at src/auth/middleware.ts", "Tests in tests/auth/"],
  issues: ["May have lost uncommitted changes in jwt.ts"],
  files: ["src/auth/middleware.ts", "src/auth/jwt.ts", "tests/auth/"]
})
\`\`\`

## Project Recovery (Different Machine)
1. Copy \`~/.workjournal\` (global registry) to new machine
2. Copy project's \`.workjournal/\` folder
3. Or re-register: \`workjournal init --root /path/to/project\`
4. Run \`workjournal start\` to start core service
5. Resume normally

## Key Principle
**Checkpoint frequently** - it's your insurance policy. The more you checkpoint, the less you lose.
`,
  },
  {
    id: 'mcp-usage',
    name: 'Using WorkJournal MCP Tools Effectively',
    description: 'Best practices for using WorkJournal MCP tools in your workflow',
    filename: 'workjournal-mcp-usage',
    content: `# WorkJournal MCP Usage Guide

## Purpose
This skill teaches you how to effectively use WorkJournal's MCP tools in your daily workflow.

## Available MCP Tools

### Task Management
- \`workjournal_create_task\` - Create new tasks
- \`workjournal_list_tasks\` - List/filter tasks
- \`workjournal_update_task\` - Change status, edit fields
- \`workjournal_get_resume_context\` - Get deterministic resume context

### Session & Continuity
- \`workjournal_start_session\` - Start/claim session (REQUIRED FIRST)
- \`workjournal_checkpoint\` - Save progress (DO REGULARLY)
- \`workjournal_record_decision\` - Record design decisions

### History & Knowledge
- \`workjournal_query\` - Query project history
- \`workjournal_recent\` - Recent activity
- \`workjournal_read_page\` - Read durable memory pages
- \`workjournal_write_page\` - Write durable memory pages

## Best Practices

### 1. Always Start with start_session
\`\`\`
# First thing in every session
const session = await workjournal_start_session();
// Check session.in_progress_tasks
// Check session.resume_brief (if resuming a task)
\`\`\`

### 2. Claim Before Working
\`\`\`
await workjournal_start_session({ task_id: "my-task", claim: true });
\`\`\`
- Establishes ownership (enforced by idempotency)
- Creates automatic checkpoint
- Other agents know you're working on it

### 3. Checkpoint Every 10 Edits / 20 Minutes
\`\`\`
await workjournal_checkpoint({
  task_id: "my-task",
  summary: "Added user validation logic",
  next_steps: ["Add integration tests", "Update API docs"],
  done: ["Created validation schema", "Added unit tests"],
  findings: ["Email regex should be RFC 5322 compliant"],
  issues: ["Password strength rules not finalized"],
  files: ["src/users/validation.ts", "tests/users/validation.test.ts"]
});
\`\`\`

### 4. Record Decisions Immediately
\`\`\`
await workjournal_record_decision({
  task_id: "my-task",
  decision: "Use Zod for validation instead of Joi",
  rationale: "Smaller bundle, better TypeScript inference, already in deps",
  alternatives: ["Joi (larger)", "Custom validators (maintenance burden)"]
});
\`\`\`

### 5. Get Full Context When Resuming
\`\`\`
const context = await workjournal_get_resume_context({
  task_id: "my-task",
  detail: "full",
  include_history: true
});
// context.checkpoint, context.decisions, context.events
\`\`\`

### 6. Use Idempotency Keys for Critical Operations
\`\`\`
// The tools handle this automatically, but know it exists
// Every state change requires a unique key per operation
\`\`\`

## Common Workflows

### Starting New Work
\`\`\`
1. workjournal_start_session()
2. workjournal_create_task({ title: "Add dark mode", ... })
3. workjournal_start_session({ task_id: "new-task-id", claim: true })
4. work (code, test)
5. workjournal_checkpoint({ ... })
6. workjournal_update_task({ task_id: "id", status: "completed" })
\`\`\`

### Resuming Interrupted Work
\`\`\`
1. workjournal_start_session()
2. workjournal_get_resume_context({ task_id: "id", detail: "full" })
3. workjournal_start_session({ task_id: "id", claim: true })
4. Continue from checkpoint.next_steps
\`\`\`

### Handoff to Another Agent
\`\`\`
1. workjournal_checkpoint({ task_id: "id", ... detailed handoff ... })
2. workjournal_update_task({ task_id: "id", status: "interrupted", reason: "Handoff to reviewer" })
3. Other agent: workjournal_start_session({ task_id: "id", claim: true })
\`\`\`

## Tips
- **Checkpoint content = Handoff content** - write for the next agent
- **File paths relative to project root** - helps others find files
- **Decisions are permanent** - use \`supersedes\` to update, not delete
- **Events are immutable** - they're the audit trail
- **No authentication** - runs on loopback, trust your local environment
`,
  },
] as const;

/** Get a skill by ID. */
export function getSkill(id: string): Skill | undefined {
  return WORKJOURNAL_SKILLS.find((s) => s.id === id);
}

/** Get all skill IDs. */
export function getAllSkillIds(): string[] {
  return WORKJOURNAL_SKILLS.map((s) => s.id);
}