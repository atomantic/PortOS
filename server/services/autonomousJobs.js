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

import { writeFile, readFile, rename, readdir, stat, rm } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import { v4 as uuidv4 } from '../lib/uuid.js'
import { spawn } from 'child_process'
import { cosEvents } from './cosEvents.js'
import { DAY, ensureDir, HOUR, PATHS, readJSONFile } from '../lib/fileUtils.js'
import { createMutex } from '../lib/asyncMutex.js'
import { checkAndPrompt as autobiographyCheckAndPrompt } from './autobiography.js'
import { runGoalCheckIn } from './goalCheckIn.js'
import { validateCommand, redactOutput, ALLOWED_COMMANDS_SORTED } from '../lib/commandSecurity.js'
import { getUserTimezone, getLocalParts, nextLocalTime } from '../lib/timezone.js'
import { parseCronToNextRun } from './eventScheduler.js'

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
 * Remove completed agent data directories older than 7 days.
 */
async function agentDataCleanup() {
  const agentsDir = join(PATHS.cos, 'agents')
  if (!existsSync(agentsDir)) return { cleaned: 0 }

  const entries = await readdir(agentsDir)
  const cutoff = Date.now() - 7 * DAY
  let cleaned = 0

  // Get active agent IDs so we never delete data for running agents
  const { getActiveAgentIds } = await import('./subAgentSpawner.js')
  const activeIds = new Set(getActiveAgentIds())

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

  console.log(`🧹 Agent data cleanup: removed ${cleaned} directories older than 7 days`)
  return { cleaned }
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
    scheduledTime: '00:00',
    enabled: false,
    priority: 'MEDIUM',
    autonomyLevel: 'manager',
    promptTemplate: `[Autonomous Job] DataDog Error Monitor

You are acting as my Chief of Staff, monitoring DataDog for new application errors.

Phase 1 — Discover:
1. Call GET /api/apps to get all managed apps
2. Filter for apps with datadog.enabled = true and datadog.instanceId + datadog.serviceName set
3. Skip archived apps

Phase 2 — Check Errors:
4. For each DataDog-enabled app:
   - Call POST /api/datadog/instances/:instanceId/search-errors with serviceName, environment, and fromTime (24h ago)
   - Compare results against the error cache in /data/cos/datadog-errors.json
   - Identify new errors (by fingerprint/message hash)

Phase 3 — Act on New Errors:
5. For each new error:
   - Create a CoS task describing the error and the app it affects
   - If the app also has jira.enabled = true, create a JIRA ticket for the error
   - Update the error cache with the new error fingerprint

Phase 4 — Report:
6. Generate a summary report covering:
   - Apps checked and error counts
   - New errors found and tasks/tickets created
   - Recurring errors that are increasing in frequency`,
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
    description: 'Remove completed agent data older than 7 days.',
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
]

let initPromise = null

/**
 * Initialize jobs — called once at startup. Handles migration and default merging.
 * Guarded by initPromise to prevent concurrent init from parallel requests.
 */
async function initJobs() {
  await ensureDir(DATA_DIR)

  const loaded = await readJSONFile(JOBS_FILE, null)
  if (!loaded) {
    const initial = createDefaultJobsData()
    await migrateScriptsState(initial)
    await saveJobs(initial)
    return initial
  }

  const jobCountBefore = loaded.jobs.length
  const merged = mergeWithDefaults(loaded)
  const migrated = await migrateScriptsState(merged)
  if (!migrated && merged.jobs.length !== jobCountBefore) {
    await saveJobs(merged)
  }
  return merged
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
  return mergeWithDefaults(loaded)
}

/**
 * Migrate scripts-state.json entries into jobs (one-time migration)
 */
async function migrateScriptsState(jobsData) {
  const scriptsFile = join(DATA_DIR, 'scripts-state.json')
  const raw = await readFile(scriptsFile, 'utf-8').catch(() => null)
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
      createdAt: now,
      updatedAt: now
    }))
  }
}

/**
 * Merge loaded data with defaults (add any missing default jobs)
 */
function mergeWithDefaults(loaded) {
  // Migration: remove jobs moved to Schedule system
  loaded.jobs = loaded.jobs.filter(j => j.id !== 'job-pr-reviewer' && j.id !== 'job-jira-sprint-manager')

  const existingById = new Map(loaded.jobs.map(j => [j.id, j]))
  const now = new Date().toISOString()

  for (const defaultJob of DEFAULT_JOBS) {
    const existing = existingById.get(defaultJob.id)
    if (!existing) {
      loaded.jobs.push({
        ...defaultJob,
        createdAt: now,
        updatedAt: now
      })
    } else {
      // Sync type/scriptHandler from defaults so persisted jobs become script jobs
      if (defaultJob.type && existing.type !== defaultJob.type) {
        existing.type = defaultJob.type
        existing.scriptHandler = defaultJob.scriptHandler
      }
    }
  }

  return loaded
}

/**
 * Save jobs to disk
 */
async function saveJobs(data) {
  await ensureDir(DATA_DIR)
  data.lastUpdated = new Date().toISOString()
  const tmp = JOBS_FILE + '.tmp'
  await writeFile(tmp, JSON.stringify(data, null, 2))
  await rename(tmp, JOBS_FILE)
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
      'command', 'triggerAction'
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
  const content = await readFile(filePath, 'utf-8').catch(() => null)
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
 * Get the effective prompt for a job, using skill template if available
 * Extracts the prompt from the skill template's structured format
 * @param {Object} job - The job object
 * @returns {Promise<string>} The effective prompt template
 */
async function getJobEffectivePrompt(job) {
  const skillName = JOB_SKILL_MAP[job.id]
  if (!skillName) return job.promptTemplate

  const template = await loadJobSkillTemplate(skillName)
  if (!template) return job.promptTemplate

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
  validateCommand
}
