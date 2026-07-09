/**
 * Autonomous Jobs — default job definitions and the defaults-merge logic.
 *
 * `DEFAULT_JOBS` is the shipped catalog of built-in jobs. The merge helpers
 * (`createDefaultJobsData`, `applyAdditiveFields`, `mergeWithDefaults`)
 * reconcile a user's persisted jobs file against the shipped defaults on every
 * load: structural fields are always synced (code contracts), additive fields
 * are snapshot-aware so shipped updates flow to untouched fields while user
 * customizations are preserved.
 */

import { DAY, WEEK, JOB_STRUCTURAL_FIELDS, JOB_ADDITIVE_FIELDS } from './constants.js'

/**
 * Default job definitions
 */
const DEFAULT_JOBS = [
  {
    id: 'job-github-repo-maintenance',
    name: 'GitHub Repo Maintenance',
    description: 'Audit all GitHub repos for security alerts, stale dependencies, missing CI/README/license, uncommitted local changes, and stale branches.',
    category: 'github-maintenance',
    interval: 'weekly',
    intervalMs: WEEK,
    enabled: false,
    priority: 'MEDIUM',
    autonomyLevel: 'manager',
    promptTemplate: `[Autonomous Job] GitHub Repo Maintenance

You are acting as my Chief of Staff, performing automated maintenance checks across all my GitHub repositories.

My GitHub username is: atomantic

Use the \`gh\` CLI to query GitHub.

Tasks to perform:
1. Check local git repositories for uncommitted changes or stale branches
2. List all non-archived repos via gh repo list
3. Check for stale repos (no commits in 90+ days)
4. Check for Dependabot/security alerts per repo
5. Flag repos missing CI, README, or license
6. Generate a maintenance report grouped by severity
7. Create CoS tasks for actionable maintenance items

Focus on actionable findings. Don't make changes directly — create CoS tasks for anything that needs doing.

Save the report via the CoS report system.`,
    lastRun: null,
    runCount: 0,
    createdAt: null,
    updatedAt: null
  },
  {
    id: 'job-brain-review',
    name: 'Brain Review',
    description: 'Process brain inbox items, review active projects for staleness, surface patterns, and create actionable tasks.',
    category: 'brain-review',
    interval: 'daily',
    intervalMs: DAY,
    enabled: false,
    priority: 'MEDIUM',
    autonomyLevel: 'manager',
    promptTemplate: `[Autonomous Job] Brain Review

You are acting as my Chief of Staff, reviewing my brain inbox and active projects.

Phase 1 — Inbox Processing:
1. Call GET /api/brain/inbox?status=needs_review to find items needing review
2. Call GET /api/brain/summary to understand the current brain state
3. For items in needs_review status, analyze the content and suggest classifications
4. Look for patterns across recent brain captures — recurring themes, related ideas
5. For high-value active ideas (GET /api/brain/ideas?status=active) that could become projects, create CoS tasks to explore them. Skip ideas with status=done — they've already been ingested

Phase 2 — Project Review:
6. Call GET /api/brain/projects?status=active to get active projects (skip done/archived)
7. For each active project:
   - Assess if the next action is still relevant
   - Check if there are related brain captures since last review
   - Suggest updated next actions if stale
8. Identify projects that might be stalled (no activity in 2+ weeks)
9. Look for connections between projects and recent inbox items

Phase 3 — Actions:
10. Create CoS tasks for actionable items from both inbox and projects
11. Generate a summary report covering inbox insights and project health

Focus on surfacing actionable insights and moving projects forward. Don't just classify — think about what these ideas mean and how they connect.`,
    lastRun: null,
    runCount: 0,
    createdAt: null,
    updatedAt: null
  },
  {
    id: 'job-daily-briefing',
    name: 'Daily Briefing',
    description: 'Generate a morning briefing with task priorities, calendar awareness, and proactive suggestions.',
    category: 'daily-briefing',
    interval: 'daily',
    intervalMs: DAY,
    scheduledTime: '04:00',
    enabled: false,
    priority: 'LOW',
    autonomyLevel: 'assistant',
    config: {
      dailyJoke: false,
      dailyQuote: false,
      dailyImage: false
    },
    promptTemplate: `[Autonomous Job] Daily Briefing

You are acting as my Chief of Staff, preparing a daily briefing.

Tasks to perform:
1. Review pending user tasks (GET /api/cos/tasks/user) and summarize priorities
2. Check internal CoS tasks (GET /api/cos/tasks/internal) to see what's already queued
3. Check brain digest (GET /api/brain/digest/latest) for recent thought patterns
4. Review CoS learning insights (GET /api/cos/learning/insights) for system health
5. Check which agents completed work recently (GET /api/cos/agents)
6. Check Claude Code changelog for new releases (GET /api/cos/claude-changelog). If there are newEntries, include a "Claude Code Updates" section listing each new version with a brief summary. Link to the release page for details.
7. Suggest 2-3 focus areas for today based on open tasks and recent activity
8. For each agent-actionable focus area (coding tasks, GitHub maintenance, system fixes — NOT personal activities), create a CoS task via POST /api/cos/tasks if no equivalent task already exists in the pending tasks from steps 1-2. Use type "internal", appropriate priority, and include context about why it was flagged.

Write the briefing in a concise, actionable format. Save it as a CoS report. Note which tasks were created.`,
    lastRun: null,
    runCount: 0,
    createdAt: null,
    updatedAt: null
  },
  {
    id: 'job-moltworld-exploration',
    name: 'Moltworld Exploration',
    description: 'Explore the Moltworld voxel world — wander, think out loud, chat with nearby agents, and earn SIM tokens by staying online. Runs as a standalone script (no AI agent). Uses LM Studio for thought generation.',
    category: 'moltworld-exploration',
    interval: 'daily',
    intervalMs: DAY,
    enabled: false,
    priority: 'LOW',
    type: 'script',
    scriptHandler: 'moltworld-exploration',
    lastRun: null,
    runCount: 0,
    createdAt: null,
    updatedAt: null
  },
  {
    id: 'job-datadog-error-monitor',
    name: 'DataDog Error Monitor',
    description: 'Check DataDog for new errors in configured apps, create tasks for new errors, and optionally create JIRA tickets.',
    category: 'datadog-error-monitor',
    interval: 'daily',
    intervalMs: DAY,
    scheduledTime: '08:00',
    enabled: false,
    priority: 'MEDIUM',
    autonomyLevel: 'manager',
    promptTemplate: `[Autonomous Job] DataDog Error Monitor

You are acting as my Chief of Staff, monitoring DataDog for new application errors and orchestrating fixes.

Phase 1 — Discover:
1. Call GET /api/apps to get all managed apps
2. Filter for apps with datadog.enabled = true and datadog.instanceId + datadog.serviceName set
3. Skip archived apps

Phase 2 — Check Errors:
4. For each DataDog-enabled app:
   - Call POST /api/datadog/instances/:instanceId/search-errors with serviceName, environment, and fromTime (24h ago)
   - Compare results against the error cache in /data/cos/datadog-errors.json
   - Identify new errors (by fingerprint/message hash)

Phase 3 — File Issues and Queue Fixes:
5. For each genuinely new error:
   - Update the error cache with the new fingerprint (always, regardless of JIRA config)
   - If app has jira.enabled = true AND jira.instanceId AND jira.projectKey are set:
     Create a JIRA ticket with labels ["datadog-auto", "cos-detected"]:
     POST /api/jira/instances/:instanceId/tickets with projectKey, summary, description, issueType: "Bug", labels
   - Create a CoS task to fix the error in an isolated worktree:
     POST /api/cos/tasks with type: "internal", useWorktree: true, openPR: true, the error stack trace, JIRA ticket reference (if created), and instructions to implement fix + open PR

Phase 4 — Report:
6. Generate a summary report covering:
   - Apps checked and error counts
   - New errors vs already-known errors
   - JIRA tickets created
   - CoS fix tasks queued
   - Recurring errors increasing in frequency`,
    lastRun: null,
    runCount: 0,
    createdAt: null,
    updatedAt: null
  },
  {
    id: 'job-autobiography-prompt',
    name: 'Autobiography Story Prompt',
    description: 'Send a notification prompting the user to write a 5-minute autobiographical story based on a thematic prompt.',
    category: 'autobiography-prompt',
    interval: 'daily',
    intervalMs: DAY,
    enabled: false,
    priority: 'LOW',
    type: 'script',
    scriptHandler: 'autobiography-prompt',
    lastRun: null,
    runCount: 0,
    createdAt: null,
    updatedAt: null
  },
  {
    id: 'job-system-health-check',
    name: 'System Health Check',
    description: 'Check PM2 process status.',
    category: 'system-health',
    interval: 'custom',
    intervalMs: 15 * 60 * 1000,
    enabled: true,
    priority: 'LOW',
    type: 'shell',
    command: 'pm2 jlist',
    triggerAction: 'log-only',
    lastRun: null,
    runCount: 0,
    createdAt: null,
    updatedAt: null
  },
  {
    id: 'job-agent-data-cleanup',
    name: 'Agent Data Cleanup',
    description: 'Remove completed agent data older than 7 days, reap worktrees/branches fully merged into main (clean working tree only), and integrate orphaned agent worktrees.',
    category: 'agent-data-cleanup',
    interval: 'daily',
    intervalMs: DAY,
    enabled: true,
    priority: 'LOW',
    type: 'script',
    scriptHandler: 'agent-data-cleanup',
    lastRun: null,
    runCount: 0,
    createdAt: null,
    updatedAt: null
  },
  {
    id: 'job-goal-check-in',
    name: 'Goal Check-in',
    description: 'Weekly check-in on active goals with target dates. Computes progress, determines status, and sends assessment via Telegram.',
    category: 'goal-check-in',
    interval: 'weekly',
    intervalMs: WEEK,
    scheduledTime: '00:00',
    enabled: false,
    priority: 'MEDIUM',
    type: 'script',
    scriptHandler: 'goal-check-in',
    lastRun: null,
    runCount: 0,
    createdAt: null,
    updatedAt: null
  },
  // 'job-layered-intelligence' removed (#2322): Layered Intelligence is now a
  // per-app HANDLER-BACKED scheduled task (CoS → Schedule) rather than a global
  // autonomous-job sweep. Migration 184 tombstones the persisted job record and
  // moves each app's scheduling into taskTypeOverrides['layered-intelligence'].
  {
    id: 'job-wiki-maintenance',
    name: 'Wiki Maintenance',
    description: 'Audit the LLM Wiki for contradictions, orphan pages, missing cross-references, outdated claims, and structural issues.',
    category: 'wiki-maintenance',
    interval: 'weekly',
    intervalMs: WEEK,
    scheduledTime: '03:00',
    cronExpression: '0 3 * * 0',
    enabled: false,
    priority: 'MEDIUM',
    autonomyLevel: 'manager',
    type: 'agent',
    promptTemplate: `[Autonomous Job] Wiki Maintenance

You are acting as my Chief of Staff, performing a weekly health check on my LLM Wiki.

The wiki lives in an Obsidian vault. Read the schema file first:
  Read the file at: ~/Library/Mobile Documents/iCloud~md~obsidian/Documents/PortOS/WIKI.md

Then perform a full lint pass:

1. Read wiki/index.md and wiki/log.md to understand current state
2. Read every file in wiki/ (sources, entities, concepts, comparisons, synthesis, queries)
3. Read every file in raw/ to check for unprocessed sources
4. Check for:
   - Contradictions between wiki pages (conflicting claims about the same topic)
   - Orphan pages with no inbound wikilinks from other pages
   - Concepts or entities mentioned repeatedly in text but lacking their own dedicated page
   - Claims that appear outdated based on newer files in raw/
   - Missing cross-references (pages that should link to each other but don't)
   - Raw sources that have no corresponding wiki/sources/ summary page
   - Broken wikilinks (links to pages that don't exist)
   - Frontmatter inconsistencies (missing type, dates, sources, tags)
5. Write the health report to wiki/lint-report.md with:
   - Summary of findings grouped by severity (critical, warning, suggestion)
   - Specific fixes for each issue (which file, what to change)
   - Statistics (total pages, total links, orphan count, coverage %)
6. Append a log entry to wiki/log.md
7. Create CoS tasks for any critical issues that need manual attention

Focus on actionable findings. The goal is to keep the wiki healthy as it grows.`,
    lastRun: null,
    runCount: 0,
    createdAt: null,
    updatedAt: null
  },
]

/**
 * Create initial jobs data with defaults
 */
function createDefaultJobsData() {
  const now = new Date().toISOString()
  return {
    version: 1,
    lastUpdated: now,
    jobs: DEFAULT_JOBS.map(j => ({
      ...j,
      _shippedDefaults: Object.fromEntries(
        JOB_ADDITIVE_FIELDS
          .filter(f => Object.hasOwn(j, f))
          .map(f => [f, j[f]])
      ),
      createdAt: now,
      updatedAt: now
    }))
  }
}

/**
 * Apply additive fields from a default job onto an existing persisted job using a
 * shipped-defaults snapshot so that un-customized fields receive future updates
 * while user customizations are always preserved.
 *
 * Returns true if any field (including _shippedDefaults) changed.
 */
function applyAdditiveFields(existing, defaultJob) {
  if (!existing._shippedDefaults) existing._shippedDefaults = {}
  let changed = false

  for (const field of JOB_ADDITIVE_FIELDS) {
    if (!Object.hasOwn(defaultJob, field)) continue

    if (!Object.hasOwn(existing, field)) {
      // Brand-new field — set value and snapshot
      existing[field] = defaultJob[field]
      existing._shippedDefaults[field] = defaultJob[field]
      changed = true
      continue
    }

    const snapshot = existing._shippedDefaults[field]
    if (snapshot === undefined) {
      // Pre-snapshot bootstrap: this job predates the _shippedDefaults mechanism,
      // so we have no way to distinguish "user customized this field" from "user
      // matches the previous shipped default". We bootstrap _shippedDefaults to
      // the CURRENT shipped value as a one-shot transition: existing installs hold
      // whatever value they had until the user explicitly edits the field via the UI
      // (which preserves customization) or until a future release ships a new default
      // — at which point the snapshot comparison works normally.
      //
      // Trade-off: existing installs may hold older defaults indefinitely. Users who
      // want fresh shipped defaults can edit + revert the field via the UI, or delete
      // the job entirely so the next merge re-seeds it from scratch.
      existing._shippedDefaults[field] = defaultJob[field]
      changed = true
      continue
    }

    if (existing[field] === snapshot && existing[field] !== defaultJob[field]) {
      // User hasn't touched this field — propagate the new shipped default
      existing[field] = defaultJob[field]
      existing._shippedDefaults[field] = defaultJob[field]
      changed = true
    }
    // else: value already matches new default (no-op), or user customized (preserve)
  }
  return changed
}

/**
 * Merge loaded data with defaults (add any missing default jobs).
 * Returns { data, dirty } where dirty is true if any structural or additive change
 * was made that requires the caller to persist the result.
 */
function mergeWithDefaults(loaded) {
  // Migration: remove jobs moved to the Schedule system. `job-layered-intelligence`
  // is retired to a per-app handler-backed scheduled task (#2322) — migration 184
  // captures its enabled state + tombstones it (and runs at boot BEFORE this), so
  // this filter is defense-in-depth against a lingering orphan (which, lacking a
  // SCRIPT_HANDLERS entry, would otherwise error on every scheduler fire).
  const countBefore = loaded.jobs.length
  loaded.jobs = loaded.jobs.filter(j => j.id !== 'job-pr-reviewer' && j.id !== 'job-jira-sprint-manager' && j.id !== 'job-layered-intelligence')
  let dirty = loaded.jobs.length !== countBefore

  const existingById = new Map(loaded.jobs.map(j => [j.id, j]))
  const now = new Date().toISOString()

  for (const defaultJob of DEFAULT_JOBS) {
    const existing = existingById.get(defaultJob.id)
    if (!existing) {
      loaded.jobs.push({
        ...defaultJob,
        _shippedDefaults: Object.fromEntries(
          JOB_ADDITIVE_FIELDS
            .filter(f => Object.hasOwn(defaultJob, f))
            .map(f => [f, defaultJob[f]])
        ),
        createdAt: now,
        updatedAt: now
      })
      dirty = true
      continue
    }
    let changed = false
    // Structural fields: always sync — these are code contracts, not user prefs
    for (const field of JOB_STRUCTURAL_FIELDS) {
      if (Object.hasOwn(defaultJob, field) && existing[field] !== defaultJob[field]) {
        existing[field] = defaultJob[field]
        changed = true
      }
    }
    // Additive fields: snapshot-aware merge — propagates updates to untouched fields,
    // preserves user customizations
    if (applyAdditiveFields(existing, defaultJob)) changed = true
    if (changed) {
      existing.updatedAt = now
      dirty = true
    }
  }

  return { data: loaded, dirty }
}

export { DEFAULT_JOBS, createDefaultJobsData, applyAdditiveFields, mergeWithDefaults }
