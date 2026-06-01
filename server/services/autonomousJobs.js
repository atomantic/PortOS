/**
 * Autonomous Jobs Service
 *
 * Manages recurring scheduled jobs that the CoS executes proactively
 * on behalf of the user, using their digital twin identity to make decisions.
 *
 * Jobs are different from tasks:
 * - Tasks are one-shot work items (TASKS.md)
 * - Jobs are recurring schedules that generate tasks when due
 *
 * Job types:
 * - github-maintenance: Audit and maintain user's GitHub repositories
 * - brain-processing: Process and act on brain ideas/inbox
 * - Custom user-defined jobs
 */

import { writeFile, rename, readdir, stat, rm } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import { v4 as uuidv4 } from '../lib/uuid.js'
import { spawn } from 'child_process'
import { cosEvents } from './cosEvents.js'
import { DAY, ensureDir, HOUR, PATHS, readJSONFile, atomicWrite, tryReadFile } from '../lib/fileUtils.js'
import { createMutex } from '../lib/asyncMutex.js'
import { checkAndPrompt as autobiographyCheckAndPrompt } from './autobiography.js'
import { runGoalCheckIn } from './goalCheckIn.js'
import { validateCommand, redactOutput, ALLOWED_COMMANDS_SORTED } from '../lib/commandSecurity.js'
import { getUserTimezone, getLocalParts, nextLocalTime } from '../lib/timezone.js'
import { parseCronToNextRun } from './eventScheduler.js'
import { cleanupOrphanedWorktrees, reapMergedWorktrees } from './worktreeManager.js'
import { getActiveAgentIds } from './agentState.js'

/**
 * Run the moltworld-explore.mjs script as a child process (no AI agent needed).
 * Returns a summary object when the script exits.
 */
function runMoltworldExploration() {
  const scriptPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'moltworld-explore.mjs')
  const durationMinutes = process.env.MOLTWORLD_DURATION_MINUTES || '30'

  return new Promise((resolve, reject) => {
    const child = spawn('node', [scriptPath, durationMinutes], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }
    })

    const output = []
    child.stdout.on('data', (chunk) => {
      const line = chunk.toString().trim()
      if (line) {
        output.push(line)
        console.log(`🌍 ${line}`)
      }
    })
    child.stderr.on('data', (chunk) => {
      const line = chunk.toString().trim()
      if (line) console.error(`🌍 ${line}`)
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, lines: output.length })
      } else {
        reject(new Error(`moltworld-explore.mjs exited with code ${code}`))
      }
    })

    child.on('error', (err) => reject(err))
  })
}

/**
 * Registry of script handlers for jobs that execute functions directly
 * instead of spawning AI agents. Key is the scriptHandler name, value is the function.
 */
/**
 * Remove completed agent data directories older than 7 days, and reap leaked
 * CoS agent worktrees (dirs whose agent is no longer live).
 *
 * The worktree sweep lives here, on the daily scheduled cadence, rather than on
 * the 15-min CoS health-check hot path — running it that often gave it a wide
 * window to remove a human's in-flight `/claim` worktree mid-review.
 * `cleanupOrphanedWorktrees` itself also skips `claim-*` worktrees outright, so
 * the daily cadence is purely about reaping abandoned `agent-*` trees.
 */
async function agentDataCleanup() {
  // Active agent IDs so we never delete data / worktrees for running agents.
  // `getActiveAgentIds` lives in the side-effect-free `agentState.js`, so this
  // script job doesn't pull in the heavier `subAgentSpawner.js` orchestrator
  // (which re-exports the whole agent-lifecycle module graph) just to read the maps.
  const activeIds = new Set(getActiveAgentIds())

  // Also protect PAUSED agents. Pausing intentionally preserves the agent's
  // worktree + data dir as resume context, but a paused agent is removed from
  // the in-memory active/runner maps (so `getActiveAgentIds()` omits it) and —
  // critically — those maps are empty after a server restart while the agent's
  // `status: 'paused'` survives in state.json. Read the persisted status so a
  // paused agent's worktree/transcript is never reaped or rm'd out from under a
  // later resume. (readJSONFile keeps this off the subAgentSpawner import path.)
  const cosState = await readJSONFile(join(PATHS.cos, 'state.json'), null)
  if (cosState?.agents && typeof cosState.agents === 'object') {
    for (const [id, agent] of Object.entries(cosState.agents)) {
      if (agent?.status === 'paused') activeIds.add(id)
    }
  }

  const agentsDir = join(PATHS.cos, 'agents')
  let cleaned = 0
  if (existsSync(agentsDir)) {
    const entries = await readdir(agentsDir)
    const cutoff = Date.now() - 7 * DAY

    for (const entry of entries) {
      if (activeIds.has(entry)) continue
      const entryPath = join(agentsDir, entry)
      const info = await stat(entryPath).catch(() => null)
      if (!info?.isDirectory()) continue
      if (info.mtimeMs < cutoff) {
        const removed = await rm(entryPath, { recursive: true, force: true }).then(() => true, (err) => {
          console.warn(`⚠️ Failed to clean agent dir ${entry}: ${err.message}`)
          return false
        })
        if (removed) cleaned++
      }
    }
  }

  // First pass — SAFE reap: remove any worktree (CoS or `.claude/worktrees/`) whose
  // branch is fully merged into the default branch AND whose working tree is clean.
  // This is the bulk of the cleanup and cannot lose work (merged+clean ⇒ nothing
  // pending). It guards active agents and human `claim-*` worktrees.
  const merged = await reapMergedWorktrees(PATHS.root, { activeAgentIds: activeIds }).catch((err) => {
    console.warn(`⚠️ Merged-worktree reap failed: ${err.message}`)
    return { reaped: [] }
  })

  // Second pass — orphan integration: for inactive CoS worktrees that were NOT
  // merged (e.g. an agent died after committing but before its PR landed), attempt
  // to merge their commits back so the work isn't stranded. The helper guards
  // `claim-*` worktrees, so this can't touch a human's in-flight claim.
  const worktreesReaped = await cleanupOrphanedWorktrees(PATHS.root, activeIds).catch((err) => {
    console.warn(`⚠️ Orphaned worktree cleanup failed: ${err.message}`)
    return 0
  })

  const mergedCount = merged?.reaped?.length || 0
  console.log(`🧹 Agent data cleanup: removed ${cleaned} dir(s) older than 7 days, reaped ${mergedCount} merged + ${worktreesReaped} orphaned worktree(s)`)
  return { cleaned, mergedReaped: mergedCount, worktreesReaped }
}

const SCRIPT_HANDLERS = {
  'autobiography-prompt': autobiographyCheckAndPrompt,
  'moltworld-exploration': runMoltworldExploration,
  'agent-data-cleanup': agentDataCleanup,
  'goal-check-in': runGoalCheckIn
}

const DATA_DIR = PATHS.cos
const JOBS_FILE = join(DATA_DIR, 'autonomous-jobs.json')
const JOBS_SKILLS_DIR = PATHS.promptSkillsJobs
const withLock = createMutex()
// Fields that are code contracts — always overwrite on restart so runtime
// stays consistent with the shipped implementation.
const JOB_STRUCTURAL_FIELDS = ['type', 'scriptHandler']

// Fields that ship with a default but are user-editable via PUT /api/cos/jobs/:id.
// Only written when the field is absent on the stored job (first-time population).
const JOB_ADDITIVE_FIELDS = [
  'name',
  'description',
  'category',
  'interval',
  'intervalMs',
  'scheduledTime',
  'cronExpression',
  'priority',
  'autonomyLevel',
  'promptTemplate',
  'command',
  'triggerAction'
]

/**
 * Map job IDs to their skill template filenames
 */
const JOB_SKILL_MAP = {
  'job-daily-briefing': 'daily-briefing',
  'job-github-repo-maintenance': 'github-repo-maintenance',
  'job-brain-review': 'brain-review',
  'job-datadog-error-monitor': 'datadog-error-monitor',
  'job-autobiography-prompt': 'autobiography-prompt'
}

const WEEK = 7 * DAY

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

let initPromise = null

/**
 * Initialize jobs — called once at startup. Handles migration and default merging.
 * Guarded by initPromise to prevent concurrent init from parallel requests.
 */
async function initJobs() {
  await ensureDir(DATA_DIR)
  await syncSkillTemplatesFromSample()

  const loaded = await readJSONFile(JOBS_FILE, null)
  if (!loaded) {
    const initial = createDefaultJobsData()
    await migrateScriptsState(initial)
    await saveJobs(initial)
    return initial
  }

  const { data: merged, dirty } = mergeWithDefaults(loaded)
  const migrated = await migrateScriptsState(merged)
  if (migrated || dirty) {
    await saveJobs(merged)
  }
  return merged
}

async function syncSkillTemplatesFromSample() {
  if (!PATHS.root) return
  const sampleDir = join(PATHS.root, 'data.reference', 'prompts', 'skills', 'jobs')
  if (!existsSync(sampleDir)) return
  await ensureDir(JOBS_SKILLS_DIR)
  const shippedDir = join(JOBS_SKILLS_DIR, '.shipped')
  await ensureDir(shippedDir)
  const files = await readdir(sampleDir).catch(() => [])
  for (const file of files) {
    if (!file.endsWith('.md')) continue
    const destPath = join(JOBS_SKILLS_DIR, file)
    const shippedPath = join(shippedDir, file)
    const sampleContent = await tryReadFile(join(sampleDir, file))
    if (!sampleContent) continue
    const existingContent = await tryReadFile(destPath)
    if (!existingContent) {
      // Case a: fresh install — seed file and record shipped snapshot
      await writeFile(destPath, sampleContent)
      await writeFile(shippedPath, sampleContent)
      console.log(`📝 Seeded missing skill template: ${file}`)
      continue
    }
    if (existingContent === sampleContent) {
      // Case b: file already matches sample — ensure .shipped is current
      const shippedContent = await tryReadFile(shippedPath)
      if (shippedContent !== sampleContent) await writeFile(shippedPath, sampleContent)
      continue
    }
    const shippedContent = await tryReadFile(shippedPath)
    if (existingContent === shippedContent) {
      // Case c: file matches last-shipped snapshot but sample has changed — safe to update
      await writeFile(destPath, sampleContent)
      await writeFile(shippedPath, sampleContent)
      console.log(`🔄 Updated unmodified skill template: ${file}`)
    } else {
      // Case d: for installs upgrading from a pre-.shipped release, any existing
      // skill file that doesn't match the current sample lands here. In reality
      // the file might just be the previous shipped version — we can't tell without
      // history. We choose preservation: the user's file (whether intentional
      // customization or a stale shipped copy) stays in place. Users who want the
      // new template can delete the file and restart so the seeder re-creates it
      // from data.reference/.
      console.log(`ℹ️ Preserving user-modified skill template: ${file}`)
    }
  }
}

/**
 * Load jobs from disk. On first call, runs one-time init (migration + defaults).
 * Subsequent calls are read-only with in-memory default merging.
 * @returns {Promise<Object>} Jobs data
 */
async function loadJobs() {
  if (!initPromise) {
    initPromise = initJobs()
  }
  await initPromise
  const loaded = await readJSONFile(JOBS_FILE, null)
  if (!loaded) return createDefaultJobsData()
  const { data } = mergeWithDefaults(loaded)
  return data
}

/**
 * Migrate scripts-state.json entries into jobs (one-time migration)
 */
async function migrateScriptsState(jobsData) {
  const scriptsFile = join(DATA_DIR, 'scripts-state.json')
  const raw = await tryReadFile(scriptsFile)
  if (!raw) return false

  let scriptsState
  try {
    scriptsState = JSON.parse(raw)
  } catch (err) {
    console.warn(`⚠️ scripts-state.json is corrupted, skipping migration: ${err.message}`)
    const failedSuffix = `.failed-${Date.now()}`
    await rename(scriptsFile, scriptsFile + failedSuffix)
    return false
  }
  const scripts = scriptsState.scripts ? Object.values(scriptsState.scripts) : []
  if (scripts.length === 0) {
    const migrateSuffix = `.migrated-${Date.now()}`
    await rename(scriptsFile, scriptsFile + migrateSuffix)
    return false
  }

  const now = new Date().toISOString()
  const existingIds = new Set(jobsData.jobs.map(j => j.id))

  // Map legacy schedule values to valid interval values
  const VALID_INTERVALS = new Set(['hourly', 'every-2-hours', 'every-4-hours', 'every-8-hours', 'daily', 'weekly', 'biweekly', 'monthly', 'custom'])
  const LEGACY_SCHEDULE_MAP = {
    'every-5-min': 'hourly',
    'every-10-min': 'hourly',
    'every-15-min': 'hourly',
    'every-30-min': 'hourly',
    'every-hour': 'hourly',
    'every-3-hours': 'every-4-hours',
    'every-6-hours': 'every-8-hours',
    'every-12-hours': 'daily',
    'twice-daily': 'daily'
  }
  const mapLegacySchedule = (schedule, scriptName) => {
    if (!schedule || schedule === 'on-demand' || schedule === 'startup') return 'daily'
    if (VALID_INTERVALS.has(schedule)) return schedule
    if (LEGACY_SCHEDULE_MAP[schedule]) {
      console.log(`📦 Mapped legacy schedule '${schedule}' for '${scriptName}' to '${LEGACY_SCHEDULE_MAP[schedule]}'`)
      return LEGACY_SCHEDULE_MAP[schedule]
    }
    console.warn(`⚠️ Legacy schedule '${schedule}' for script '${scriptName}' not recognized, defaulting to 'daily'`)
    return 'daily'
  }

  const existingNames = new Set(jobsData.jobs.map(j => j.name.toLowerCase()))

  for (const script of scripts) {
    const jobId = `job-migrated-${script.id}`
    if (existingIds.has(jobId)) continue
    if (existingNames.has(script.name.toLowerCase())) continue

    const mappedInterval = mapLegacySchedule(script.schedule, script.name)
    if (script.cronExpression) {
      console.warn(`⚠️ Legacy cron expression '${script.cronExpression}' for script '${script.name}' not supported by job scheduler, using interval '${mappedInterval}' instead`)
    }
    const isOnDemandOrStartup = script.schedule === 'on-demand' || script.schedule === 'startup'

    // Validate command against allowlist — disable jobs with invalid commands
    let commandValid = true
    if (script.command) {
      const cmdValidation = validateCommand(script.command)
      if (!cmdValidation.valid) {
        console.warn(`⚠️ Migrated script '${script.name}' has invalid command, disabling: ${cmdValidation.error}`)
        commandValid = false
      }
    }

    jobsData.jobs.push({
      id: jobId,
      name: script.name,
      description: script.description || '',
      category: 'migrated-script',
      type: 'shell',
      command: commandValid ? script.command : null,
      interval: mappedInterval,
      intervalMs: resolveIntervalMs(mappedInterval),
      enabled: commandValid ? (isOnDemandOrStartup ? false : (script.enabled || false)) : false,
      priority: script.triggerPriority || 'MEDIUM',
      triggerAction: 'log-only',
      lastRun: script.lastRun || null,
      runCount: script.runCount || 0,
      createdAt: script.createdAt || now,
      updatedAt: now
    })
  }

  await saveJobs(jobsData)
  const migrateSuffix = `.migrated-${Date.now()}`
  await rename(scriptsFile, scriptsFile + migrateSuffix)
  console.log(`📦 Migrated ${scripts.length} scripts to jobs`)
  return true
}

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
  // Migration: remove jobs moved to Schedule system
  const countBefore = loaded.jobs.length
  loaded.jobs = loaded.jobs.filter(j => j.id !== 'job-pr-reviewer' && j.id !== 'job-jira-sprint-manager')
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

/**
 * Save jobs to disk
 */
async function saveJobs(data) {
  await ensureDir(DATA_DIR)
  data.lastUpdated = new Date().toISOString()
  await atomicWrite(JOBS_FILE, data)
}

/**
 * Get all jobs
 * @returns {Promise<Array>} All jobs
 */
async function getAllJobs() {
  const data = await loadJobs()
  return data.jobs
}

/**
 * Get a single job by ID
 * @param {string} jobId
 * @returns {Promise<Object|null>}
 */
async function getJob(jobId) {
  const data = await loadJobs()
  return data.jobs.find(j => j.id === jobId) || null
}

/**
 * Get enabled jobs
 * @returns {Promise<Array>} Enabled jobs
 */
async function getEnabledJobs() {
  const data = await loadJobs()
  return data.jobs.filter(j => j.enabled)
}

/**
 * Check if today is a weekday (Monday-Friday) in the user's timezone.
 * @param {string} timezone - IANA timezone string
 * @returns {boolean}
 */
function isWeekday(timezone) {
  const local = getLocalParts(new Date(), timezone)
  return local.dayOfWeek >= 1 && local.dayOfWeek <= 5
}

/**
 * Get jobs that are due to run
 * @returns {Promise<Array>} Due jobs with reason
 */
async function getDueJobs() {
  const enabledJobs = await getEnabledJobs()
  const now = Date.now()
  const timezone = await getUserTimezone()
  const due = []

  for (const job of enabledJobs) {
    // Cron-mode jobs: compute next run from cron expression
    if (job.cronExpression) {
      const from = job.lastRun ? new Date(job.lastRun) : new Date(now)
      const next = parseCronToNextRun(job.cronExpression, from, timezone)
      if (!next || next.getTime() > now) continue

      due.push({
        ...job,
        reason: job.lastRun ? 'cron-due' : 'never-run',
        overdueBy: now - next.getTime()
      })
      continue
    }

    // Interval-mode jobs
    const lastRun = job.lastRun ? new Date(job.lastRun).getTime() : 0
    const timeSinceLastRun = now - lastRun

    if (timeSinceLastRun >= job.intervalMs) {
      if (job.scheduledTime) {
        const match = String(job.scheduledTime).match(/^([01]\d|2[0-3]):([0-5]\d)$/)
        if (!match) continue // skip jobs with invalid scheduledTime format
        const hours = Number(match[1])
        const minutes = Number(match[2])
        // Compute today's scheduled UTC time in a DST-safe way.
        // nextLocalTime finds the next occurrence AFTER the reference point.
        // By searching from (now - 24h), we get today's occurrence if we haven't passed it yet,
        // or yesterday's occurrence if we have. We then verify the candidate is on today's local date.
        const nowFloored = now - (now % 60_000)
        const localNow = getLocalParts(new Date(nowFloored), timezone)
        let targetUtc = nextLocalTime(nowFloored - DAY, hours, minutes, timezone)
        const targetLocal = getLocalParts(new Date(targetUtc), timezone)
        // If the candidate landed on yesterday's date, advance to today's occurrence
        if (targetLocal.day !== localNow.day || targetLocal.month !== localNow.month || targetLocal.year !== localNow.year) {
          targetUtc = nextLocalTime(targetUtc + 1, hours, minutes, timezone)
        }
        if (now < targetUtc) continue
        if (lastRun >= targetUtc) continue
      }

      // If job is weekdaysOnly, skip weekends
      if (job.weekdaysOnly && !isWeekday(timezone)) continue

      due.push({
        ...job,
        reason: job.lastRun ? `${job.interval}-due` : 'never-run',
        overdueBy: timeSinceLastRun - job.intervalMs
      })
    }
  }

  // Sort by overdue time (most overdue first)
  due.sort((a, b) => b.overdueBy - a.overdueBy)

  return due
}

/**
 * Create a new job
 * @param {Object} jobData
 * @returns {Promise<Object>} Created job
 */
async function createJob(jobData) {
  return withLock(async () => {
    const data = await loadJobs()
    const now = new Date().toISOString()

    // Validate shell command at creation time
    if (jobData.type === 'shell') {
      if (!jobData.command || !jobData.command.trim()) {
        const err = new Error('Shell jobs require a non-empty command')
        err.status = 400
        throw err
      }
      const validation = validateCommand(jobData.command)
      if (!validation.valid) {
        const err = new Error(`Invalid command: ${validation.error}`)
        err.status = 400
        throw err
      }
    }

    const jobType = jobData.type || 'agent'

    // Strip agent-specific triggerAction values from shell jobs
    const agentOnlyActions = ['spawn-agent', 'create-task']
    const triggerAction = (jobType === 'shell' && agentOnlyActions.includes(jobData.triggerAction))
      ? 'log-only'
      : (jobData.triggerAction || null)

    const job = {
      id: jobData.id || `job-${uuidv4().slice(0, 8)}`,
      name: jobData.name,
      description: jobData.description || '',
      category: jobData.category || 'custom',
      cronExpression: jobData.cronExpression || null,
      type: jobType,
      interval: jobData.interval || 'weekly',
      intervalMs: resolveIntervalMs(jobData.interval || 'weekly', jobData.intervalMs),
      scheduledTime: jobData.scheduledTime || null,
      weekdaysOnly: jobData.weekdaysOnly || false,
      enabled: jobData.enabled !== undefined ? jobData.enabled : false,
      priority: jobData.priority || 'MEDIUM',
      autonomyLevel: jobData.autonomyLevel || 'manager',
      promptTemplate: jobData.promptTemplate || '',
      command: jobData.command || null,
      triggerAction,
      config: jobData.config || null,
      lastRun: null,
      runCount: 0,
      createdAt: now,
      updatedAt: now
    }

    data.jobs.push(job)
    await saveJobs(data)

    console.log(`🤖 Autonomous job created: ${job.name}`)
    cosEvents.emit('jobs:created', { id: job.id, name: job.name })

    return job
  })
}

/**
 * Update an existing job
 * @param {string} jobId
 * @param {Object} updates
 * @returns {Promise<Object|null>} Updated job or null
 */
async function updateJob(jobId, updates) {
  return withLock(async () => {
    const data = await loadJobs()
    const job = data.jobs.find(j => j.id === jobId)
    if (!job) return null

    // Normalize falsy command values to empty string for consistent validation
    if (updates.command !== undefined && !updates.command) {
      updates.command = ''
    }

    // If type is being changed away from shell, allow clearing the command
    const effectiveType = updates.type ?? job.type
    if (effectiveType !== 'shell' && updates.command === '') {
      updates.command = null
    }

    const updatableFields = [
      'name', 'description', 'category', 'type', 'interval', 'intervalMs',
      'scheduledTime', 'cronExpression', 'weekdaysOnly', 'enabled', 'priority', 'autonomyLevel', 'promptTemplate',
      'command', 'triggerAction', 'config'
    ]

    for (const field of updatableFields) {
      if (updates[field] !== undefined) {
        job[field] = updates[field]
      }
    }

    // Recalculate intervalMs if interval changed
    if (updates.interval) {
      job.intervalMs = resolveIntervalMs(updates.interval, updates.intervalMs)
    }

    // Validate shell jobs have a valid command after all fields are applied
    if (job.type === 'shell') {
      if (!job.command || !job.command.trim()) {
        const err = new Error('Shell jobs require a non-empty command')
        err.status = 400
        throw err
      }
      const cmdValidation = validateCommand(job.command)
      if (!cmdValidation.valid) {
        const err = new Error(`Invalid command: ${cmdValidation.error}`)
        err.status = 400
        throw err
      }
    }

    // Strip agent-specific triggerAction values from shell jobs
    const agentOnlyActions = ['spawn-agent', 'create-task']
    if (job.type === 'shell' && agentOnlyActions.includes(job.triggerAction)) {
      job.triggerAction = 'log-only'
    }

    job.updatedAt = new Date().toISOString()
    await saveJobs(data)

    console.log(`🤖 Autonomous job updated: ${job.name}`)
    cosEvents.emit('jobs:updated', { id: job.id, updates })

    return job
  })
}

/**
 * Delete a job
 * @param {string} jobId
 * @returns {Promise<boolean>}
 */
async function deleteJob(jobId) {
  return withLock(async () => {
    const data = await loadJobs()
    const idx = data.jobs.findIndex(j => j.id === jobId)
    if (idx === -1) return false

    const deleted = data.jobs.splice(idx, 1)[0]
    await saveJobs(data)

    console.log(`🗑️ Autonomous job deleted: ${deleted.name}`)
    cosEvents.emit('jobs:deleted', { id: jobId })

    return true
  })
}

/**
 * Record a job execution
 * @param {string} jobId
 * @returns {Promise<Object|null>} Updated job
 */
async function recordJobExecution(jobId) {
  return withLock(async () => {
    const data = await loadJobs()
    const job = data.jobs.find(j => j.id === jobId)
    if (!job) return null

    job.lastRun = new Date().toISOString()
    job.runCount = (job.runCount || 0) + 1
    job.updatedAt = job.lastRun

    await saveJobs(data)

    console.log(`🤖 Job executed: ${job.name} (run #${job.runCount})`)
    cosEvents.emit('jobs:executed', { id: jobId, runCount: job.runCount })

    return job
  })
}

/**
 * Record a gate-skip: updates lastRun so the job reschedules at its normal interval,
 * but does NOT increment runCount since the job didn't actually execute.
 */
async function recordJobGateSkip(jobId) {
  return withLock(async () => {
    const data = await loadJobs()
    const job = data.jobs.find(j => j.id === jobId)
    if (!job) return null

    job.lastRun = new Date().toISOString()
    job.updatedAt = job.lastRun

    await saveJobs(data)
    return job
  })
}

/**
 * Toggle a job's enabled state
 * @param {string} jobId
 * @returns {Promise<Object|null>}
 */
async function toggleJob(jobId) {
  return withLock(async () => {
    const data = await loadJobs()
    const job = data.jobs.find(j => j.id === jobId)
    if (!job) return null

    job.enabled = !job.enabled
    job.updatedAt = new Date().toISOString()

    await saveJobs(data)

    const stateLabel = job.enabled ? 'enabled' : 'disabled'
    console.log(`🤖 Autonomous job ${stateLabel}: ${job.name}`)
    cosEvents.emit('jobs:toggled', { id: jobId, enabled: job.enabled })

    return job
  })
}

/**
 * Load a job skill template from disk
 * @param {string} skillName - The skill template name (e.g., 'daily-briefing')
 * @returns {Promise<string|null>} Template content or null if not found
 */
async function loadJobSkillTemplate(skillName) {
  const filePath = join(JOBS_SKILLS_DIR, `${skillName}.md`)
  const content = await tryReadFile(filePath)
  if (content) {
    console.log(`🎯 Loaded job skill template: ${skillName}`)
  }
  return content
}

/**
 * Save a job skill template to disk
 * @param {string} skillName - The skill template name
 * @param {string} content - The template content
 */
async function saveJobSkillTemplate(skillName, content) {
  await ensureDir(JOBS_SKILLS_DIR)
  const filePath = join(JOBS_SKILLS_DIR, `${skillName}.md`)
  await writeFile(filePath, content)
  console.log(`💾 Saved job skill template: ${skillName}`)
}

/**
 * List all job skill templates
 * @returns {Promise<Array>} Array of { name, jobId, hasTemplate }
 */
async function listJobSkillTemplates() {
  const results = []
  for (const [jobId, skillName] of Object.entries(JOB_SKILL_MAP)) {
    const content = await loadJobSkillTemplate(skillName)
    results.push({
      name: skillName,
      jobId,
      hasTemplate: !!content
    })
  }
  return results
}

/**
 * Build additional prompt instructions based on daily briefing config options.
 * @param {Object} config - The briefing config object
 * @returns {string} Additional instructions to append, or empty string
 */
function buildBriefingConfigInstructions(config) {
  const parts = []

  if (config.dailyJoke) {
    parts.push('- Include a "Daily Joke" section with a short, clever joke to start the day on a light note.')
  }
  if (config.dailyQuote) {
    parts.push('- Include a "Daily Quote" section with an inspirational or thought-provoking quote relevant to the day\'s focus areas.')
  }
  if (config.dailyImage) {
    parts.push(
      '- Generate a "Daily Image" to accompany the briefing by calling POST /api/image-gen/generate with a creative prompt related to today\'s theme or focus areas. Use a cyberpunk or futuristic aesthetic. Include the resulting image path in the briefing. If the image gen API is unavailable (GET /api/image-gen/status returns connected: false), skip this section silently.'
    )
  }

  if (parts.length === 0) return ''
  return 'Optional enrichments (include these sections in the briefing):\n' + parts.join('\n')
}

/**
 * Append briefing config instructions to a prompt if this is the daily briefing job.
 */
function appendBriefingConfig(job, prompt) {
  if (job.id !== 'job-daily-briefing' || !job.config) return prompt
  const extras = buildBriefingConfigInstructions(job.config)
  return extras ? prompt + '\n\n' + extras : prompt
}

/**
 * Get the effective prompt for a job, using skill template if available
 * Extracts the prompt from the skill template's structured format
 * @param {Object} job - The job object
 * @returns {Promise<string>} The effective prompt template
 */
async function getJobEffectivePrompt(job) {
  const skillName = JOB_SKILL_MAP[job.id]
  if (!skillName) return appendBriefingConfig(job, job.promptTemplate)

  const template = await loadJobSkillTemplate(skillName)
  if (!template) return appendBriefingConfig(job, job.promptTemplate)

  // Extract structured sections from the skill template and build a prompt
  // The skill template has: Prompt Template header, Steps, Expected Outputs, Success Criteria
  const lines = template.split('\n')
  const sections = { prompt: '', steps: '', expectedOutputs: '', successCriteria: '' }
  let currentSection = null

  for (const line of lines) {
    if (line.startsWith('## Prompt Template')) { currentSection = 'prompt'; continue }
    if (line.startsWith('## Steps')) { currentSection = 'steps'; continue }
    if (line.startsWith('## Expected Outputs')) { currentSection = 'expectedOutputs'; continue }
    if (line.startsWith('## Success Criteria')) { currentSection = 'successCriteria'; continue }
    if (line.startsWith('## Job Metadata')) { currentSection = 'metadata'; continue }
    if (line.startsWith('# ')) { currentSection = null; continue }
    if (currentSection && currentSection !== 'metadata') {
      sections[currentSection] += line + '\n'
    }
  }

  // Build the effective prompt from structured sections
  let prompt = sections.prompt.trim()
  if (sections.steps.trim()) {
    prompt += '\n\nTasks to perform:\n' + sections.steps.trim()
  }

  prompt = appendBriefingConfig(job, prompt)

  if (sections.expectedOutputs.trim()) {
    prompt += '\n\nExpected outputs:\n' + sections.expectedOutputs.trim()
  }
  if (sections.successCriteria.trim()) {
    prompt += '\n\nSuccess criteria:\n' + sections.successCriteria.trim()
  }

  return prompt
}

/**
 * Generate a CoS task from a due job
 * @param {Object} job - The job to generate a task for
 * @returns {Promise<Object>} Task data suitable for cos.addTask()
 */
async function generateTaskFromJob(job) {
  const description = await getJobEffectivePrompt(job)
  return {
    id: `${job.id}-${Date.now().toString(36)}`,
    description,
    priority: job.priority,
    metadata: {
      autonomousJob: true,
      jobId: job.id,
      jobName: job.name,
      jobCategory: job.category,
      autonomyLevel: job.autonomyLevel
    },
    taskType: 'internal',
    autoApprove: job.autonomyLevel === 'yolo'
  }
}

/**
 * Get job statistics
 * @returns {Promise<Object>}
 */
async function getJobStats() {
  const jobs = await getAllJobs()

  return {
    total: jobs.length,
    enabled: jobs.filter(j => j.enabled).length,
    disabled: jobs.filter(j => !j.enabled).length,
    byCategory: jobs.reduce((acc, j) => {
      acc[j.category] = (acc[j.category] || 0) + 1
      return acc
    }, {}),
    totalRuns: jobs.reduce((sum, j) => sum + (j.runCount || 0), 0),
    nextDue: await getNextDueJob()
  }
}

/**
 * Get the next job that will be due
 * @returns {Promise<Object|null>}
 */
async function getNextDueJob() {
  const enabledJobs = await getEnabledJobs()
  if (enabledJobs.length === 0) return null

  const timezone = await getUserTimezone()
  let earliest = null
  let earliestTime = Infinity

  for (const job of enabledJobs) {
    let nextDue

    if (job.cronExpression) {
      // Cron-mode: derive next due from cron expression
      const from = job.lastRun ? new Date(job.lastRun) : new Date()
      const next = parseCronToNextRun(job.cronExpression, from, timezone)
      if (!next) continue
      nextDue = next.getTime()
    } else {
      // Interval-mode
      const lastRun = job.lastRun ? new Date(job.lastRun).getTime() : 0
      nextDue = lastRun + job.intervalMs

      // If job has scheduledTime, find next occurrence in user's timezone
      if (job.scheduledTime) {
        const match = String(job.scheduledTime).match(/^([01]\d|2[0-3]):([0-5]\d)$/)
        if (match) {
          const candidate = nextLocalTime(nextDue, Number(match[1]), Number(match[2]), timezone)
          if (candidate > nextDue) nextDue = candidate
        }
      }
    }

    if (nextDue < earliestTime) {
      earliestTime = nextDue
      const isDue = Date.now() >= nextDue
      earliest = {
        jobId: job.id,
        jobName: job.name,
        nextDueAt: new Date(nextDue).toISOString(),
        scheduledTime: job.scheduledTime || null,
        isDue
      }
    }
  }

  return earliest
}

/**
 * Resolve interval string to milliseconds
 */
function resolveIntervalMs(interval, customMs) {
  switch (interval) {
    case 'hourly': return HOUR
    case 'every-2-hours': return 2 * HOUR
    case 'every-4-hours': return 4 * HOUR
    case 'every-8-hours': return 8 * HOUR
    case 'daily': return DAY
    case 'weekly': return WEEK
    case 'biweekly': return 2 * WEEK
    case 'monthly': return 30 * DAY
    case 'custom': return customMs || DAY
    default: return DAY
  }
}

/**
 * Available interval options for UI
 */
const INTERVAL_OPTIONS = [
  { value: 'hourly', label: 'Every Hour', ms: HOUR },
  { value: 'every-2-hours', label: 'Every 2 Hours', ms: 2 * HOUR },
  { value: 'every-4-hours', label: 'Every 4 Hours', ms: 4 * HOUR },
  { value: 'every-8-hours', label: 'Every 8 Hours', ms: 8 * HOUR },
  { value: 'daily', label: 'Daily', ms: DAY },
  { value: 'weekly', label: 'Weekly', ms: WEEK },
  { value: 'biweekly', label: 'Every 2 Weeks', ms: 2 * WEEK },
  { value: 'monthly', label: 'Monthly', ms: 30 * DAY }
]

/**
 * Check if a job is a script job (executes directly, no AI agent needed)
 * @param {Object} job - The job object
 * @returns {boolean}
 */
function isScriptJob(job) {
  return !!(job.type === 'script' && job.scriptHandler && SCRIPT_HANDLERS[job.scriptHandler])
}

/**
 * Execute a script job directly without spawning an AI agent
 * @param {Object} job - The script job to execute
 * @returns {Promise<Object>} Result of the script execution
 */
async function executeScriptJob(job) {
  if (!isScriptJob(job)) {
    throw new Error(`Job ${job.id} is not a script job`)
  }

  const handler = SCRIPT_HANDLERS[job.scriptHandler]
  console.log(`📜 Executing script job: ${job.name}`)

  const result = await handler()

  // Record the job execution
  await recordJobExecution(job.id)

  console.log(`✅ Script job completed: ${job.name}`)
  cosEvents.emit('jobs:script-executed', { id: job.id, result })

  return result
}

/**
 * Execute a shell job directly (no AI agent needed)
 */
async function executeShellJob(job) {
  const validation = validateCommand(job.command)
  if (!validation.valid) {
    throw new Error(`Invalid shell command: ${validation.error}`)
  }

  console.log(`🐚 Executing shell job: ${job.name}`)

  const SHELL_JOB_TIMEOUT_MS = 5 * 60 * 1000
  const timeoutMs = SHELL_JOB_TIMEOUT_MS

  return new Promise((resolve, reject) => {
    let killed = false
    const child = spawn(validation.baseCommand, validation.args || [], {
      cwd: PATHS.root,
      shell: false,
      windowsHide: true
    })

    const timer = setTimeout(() => {
      if (child.exitCode !== null) return
      killed = true
      child.kill('SIGKILL')
      console.error(`⏰ Shell job timed out after ${timeoutMs}ms: ${job.name}`)
    }, timeoutMs)

    const MAX_OUTPUT_BYTES = 512 * 1024 // 512KB buffer limit
    const outChunks = []
    const errChunks = []
    let outBytes = 0
    let errBytes = 0

    child.stdout.on('data', (data) => {
      if (outBytes < MAX_OUTPUT_BYTES) { outChunks.push(data.toString()); outBytes += data.length }
    })
    child.stderr.on('data', (data) => {
      if (errBytes < MAX_OUTPUT_BYTES) { errChunks.push(data.toString()); errBytes += data.length }
    })

    child.on('close', (rawCode, signal) => {
      const code = rawCode ?? (signal ? 128 : 1)
      clearTimeout(timer)
      if (killed) {
        const persistTimeout = async () => {
          await withLock(async () => {
            const data = await loadJobs()
            const j = data.jobs.find(x => x.id === job.id)
            if (j) {
              j.lastOutput = `Process killed after ${timeoutMs}ms timeout`
              j.lastExitCode = -1
              j.lastResult = 'timeout'
              await saveJobs(data)
            }
          })
          await recordJobExecution(job.id)
        }
        persistTimeout().then(() => {
          const err = new Error(`Shell job "${job.name}" timed out after ${timeoutMs}ms`)
          err.exitCode = -1
          reject(err)
        }).catch((persistErr) => {
          console.error(`❌ Shell job ${job.name} failed to persist timeout state: ${persistErr.message}`)
          const err = new Error(`Shell job "${job.name}" timed out after ${timeoutMs}ms`)
          err.exitCode = -1
          reject(err)
        })
        return
      }
      const output = outChunks.join('')
      const error = errChunks.join('')
      const fullOutput = output + (error ? `\n[stderr]\n${error}` : '')
      const redactedOutput = redactOutput(fullOutput)

      // Persist output/exit code and record execution in a single lock cycle
      const persist = async () => {
        await withLock(async () => {
          const data = await loadJobs()
          const j = data.jobs.find(x => x.id === job.id)
          if (j) {
            j.lastOutput = redactedOutput.substring(0, 10000)
            j.lastExitCode = code
            j.lastRun = new Date().toISOString()
            j.lastResult = code === 0 ? 'success' : 'failure'
            j.runCount = (j.runCount || 0) + 1
            j.updatedAt = j.lastRun
            await saveJobs(data)
            console.log(`🤖 Shell job executed: ${j.name} (run #${j.runCount})`)
            cosEvents.emit('jobs:executed', { id: job.id, runCount: j.runCount })
          }
        })
      }

      persist().then(() => {
        if (code !== 0) {
          console.error(`❌ Shell job failed: ${job.name} (exit ${code})`)
          cosEvents.emit('jobs:shell-executed', { id: job.id, exitCode: code })
          const err = new Error(`Shell job "${job.name}" exited with code ${code}: ${redactedOutput.substring(0, 500)}`)
          err.exitCode = code
          reject(err)
          return
        }

        console.log(`✅ Shell job completed: ${job.name} (exit ${code})`)
        cosEvents.emit('jobs:shell-executed', { id: job.id, exitCode: code })
        resolve({ success: true, exitCode: code, output: redactedOutput })
      }).catch((persistErr) => {
        console.error(`❌ Shell job ${job.name} failed to persist state: ${persistErr.message}`)
        reject(persistErr)
      })
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      console.error(`❌ Shell job ${job.name} error: ${err.message}`)
      const persistError = async () => {
        await withLock(async () => {
          const data = await loadJobs()
          const j = data.jobs.find(x => x.id === job.id)
          if (j) {
            j.lastOutput = err.message
            j.lastExitCode = -1
            j.lastRun = new Date().toISOString()
            j.lastResult = 'error'
            await saveJobs(data)
          }
        })
        await recordJobExecution(job.id)
      }
      persistError().then(() => {
        reject(new Error(`Shell job "${job.name}" spawn error: ${err.message}`))
      }).catch((persistErr) => {
        console.error(`❌ Shell job ${job.name} failed to persist error state: ${persistErr.message}`)
        reject(new Error(`Shell job "${job.name}" spawn error: ${err.message}`))
      })
    })
  })
}

/**
 * Check if a job is a shell command job
 */
function isShellJob(job) {
  return job.type === 'shell'
}

/**
 * Get list of allowed commands for shell jobs
 */
function getAllowedCommands() {
  return ALLOWED_COMMANDS_SORTED
}

export {
  agentDataCleanup,
  getAllJobs,
  getJob,
  getEnabledJobs,
  getDueJobs,
  createJob,
  updateJob,
  deleteJob,
  recordJobExecution,
  recordJobGateSkip,
  toggleJob,
  generateTaskFromJob,
  getJobStats,
  getNextDueJob,
  isWeekday,
  INTERVAL_OPTIONS,
  loadJobSkillTemplate,
  saveJobSkillTemplate,
  listJobSkillTemplates,
  getJobEffectivePrompt,
  JOB_SKILL_MAP,
  isScriptJob,
  executeScriptJob,
  isShellJob,
  executeShellJob,
  getAllowedCommands,
  validateCommand,
  syncSkillTemplatesFromSample,
  initJobs
}
