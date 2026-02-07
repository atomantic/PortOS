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
 * - git-maintenance: Maintain user's git repositories
 * - brain-processing: Process and act on brain ideas/inbox
 * - Custom user-defined jobs
 */

import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { v4 as uuidv4 } from 'uuid'
import { cosEvents } from './cosEvents.js'
import { readJSONFile } from '../lib/fileUtils.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DATA_DIR = path.join(__dirname, '../../data/cos')
const JOBS_FILE = path.join(DATA_DIR, 'autonomous-jobs.json')

// Time constants
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const WEEK = 7 * DAY

/**
 * Default job definitions
 */
const DEFAULT_JOBS = [
  {
    id: 'job-git-maintenance',
    name: 'Git Repository Maintenance',
    description: 'Review and maintain my open source repositories on GitHub. Check for stale issues, outdated dependencies, and merge-worthy PRs.',
    category: 'git-maintenance',
    interval: 'weekly',
    intervalMs: WEEK,
    enabled: false,
    priority: 'MEDIUM',
    autonomyLevel: 'manager',
    promptTemplate: `[Autonomous Job] Git Repository Maintenance

You are acting as my Chief of Staff, maintaining my GitHub repositories.

Tasks to perform:
1. Check my local git repositories for uncommitted changes or stale branches
2. Look for repositories that haven't been updated recently
3. Review any obvious maintenance needs (outdated README, missing license, etc.)
4. If there are simple cleanups to make, create tasks for them

Focus on practical, actionable maintenance. Don't make changes directly — create CoS tasks for anything that needs doing.

Report a summary of the repository health status when done.`,
    lastRun: null,
    runCount: 0,
    createdAt: null,
    updatedAt: null
  },
  {
    id: 'job-brain-processing',
    name: 'Brain Inbox Processing',
    description: 'Review brain inbox items that need attention, process ideas into actionable tasks, and surface patterns.',
    category: 'brain-processing',
    interval: 'daily',
    intervalMs: DAY,
    enabled: false,
    priority: 'MEDIUM',
    autonomyLevel: 'manager',
    promptTemplate: `[Autonomous Job] Brain Inbox Processing

You are acting as my Chief of Staff, processing my brain inbox.

Tasks to perform:
1. Call GET /api/brain/inbox?status=needs_review to find items needing review
2. Call GET /api/brain/summary to understand the current brain state
3. For items in needs_review status, analyze the content and suggest classifications
4. Look for patterns across recent brain captures — recurring themes, related ideas
5. For high-value ideas that could become projects, create CoS tasks to explore them
6. Generate a brief summary of insights from the brain inbox

Focus on surfacing actionable insights. Don't just classify — think about what these ideas mean and how they connect.`,
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
    enabled: false,
    priority: 'LOW',
    autonomyLevel: 'assistant',
    promptTemplate: `[Autonomous Job] Daily Briefing

You are acting as my Chief of Staff, preparing a daily briefing.

Tasks to perform:
1. Review pending user tasks (GET /api/cos/tasks/user) and summarize priorities
2. Check brain digest (GET /api/brain/digest/latest) for recent thought patterns
3. Review CoS learning insights (GET /api/cos/learning/insights) for system health
4. Check which agents completed work recently (GET /api/cos/agents)
5. Suggest 2-3 focus areas for today based on open tasks and recent activity

Write the briefing in a concise, actionable format. Save it as a CoS report.`,
    lastRun: null,
    runCount: 0,
    createdAt: null,
    updatedAt: null
  },
  {
    id: 'job-project-review',
    name: 'Brain Project Review',
    description: 'Review active brain projects, check progress, suggest next actions, and identify stalled projects.',
    category: 'project-review',
    interval: 'weekly',
    intervalMs: WEEK,
    enabled: false,
    priority: 'LOW',
    autonomyLevel: 'assistant',
    promptTemplate: `[Autonomous Job] Brain Project Review

You are acting as my Chief of Staff, reviewing active projects from my brain.

Tasks to perform:
1. Call GET /api/brain/projects to get all active projects
2. For each active project:
   - Assess if the next action is still relevant
   - Check if there are related brain captures since last review
   - Suggest updated next actions if stale
3. Identify projects that might be stalled (no activity in 2+ weeks)
4. Look for connections between projects that could be leveraged
5. For any actionable suggestions, create CoS tasks

Report a project health summary when done.`,
    lastRun: null,
    runCount: 0,
    createdAt: null,
    updatedAt: null
  }
]

/**
 * Ensure data directory exists
 */
async function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    await fs.mkdir(DATA_DIR, { recursive: true })
  }
}

/**
 * Load jobs from disk
 * @returns {Promise<Object>} Jobs data
 */
async function loadJobs() {
  await ensureDataDir()

  const loaded = await readJSONFile(JOBS_FILE, null)
  if (!loaded) {
    const initial = createDefaultJobsData()
    await saveJobs(initial)
    return initial
  }

  // Merge with defaults to ensure all default jobs exist
  const merged = mergeWithDefaults(loaded)
  return merged
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
  const existingIds = new Set(loaded.jobs.map(j => j.id))
  const now = new Date().toISOString()

  for (const defaultJob of DEFAULT_JOBS) {
    if (!existingIds.has(defaultJob.id)) {
      loaded.jobs.push({
        ...defaultJob,
        createdAt: now,
        updatedAt: now
      })
    }
  }

  return loaded
}

/**
 * Save jobs to disk
 */
async function saveJobs(data) {
  await ensureDataDir()
  data.lastUpdated = new Date().toISOString()
  await fs.writeFile(JOBS_FILE, JSON.stringify(data, null, 2))
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
 * Get jobs that are due to run
 * @returns {Promise<Array>} Due jobs with reason
 */
async function getDueJobs() {
  const enabledJobs = await getEnabledJobs()
  const now = Date.now()
  const due = []

  for (const job of enabledJobs) {
    const lastRun = job.lastRun ? new Date(job.lastRun).getTime() : 0
    const timeSinceLastRun = now - lastRun

    if (timeSinceLastRun >= job.intervalMs) {
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
  const data = await loadJobs()
  const now = new Date().toISOString()

  const job = {
    id: jobData.id || `job-${uuidv4().slice(0, 8)}`,
    name: jobData.name,
    description: jobData.description || '',
    category: jobData.category || 'custom',
    interval: jobData.interval || 'weekly',
    intervalMs: resolveIntervalMs(jobData.interval, jobData.intervalMs),
    enabled: jobData.enabled !== undefined ? jobData.enabled : false,
    priority: jobData.priority || 'MEDIUM',
    autonomyLevel: jobData.autonomyLevel || 'manager',
    promptTemplate: jobData.promptTemplate || '',
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
}

/**
 * Update an existing job
 * @param {string} jobId
 * @param {Object} updates
 * @returns {Promise<Object|null>} Updated job or null
 */
async function updateJob(jobId, updates) {
  const data = await loadJobs()
  const job = data.jobs.find(j => j.id === jobId)
  if (!job) return null

  const updatableFields = [
    'name', 'description', 'category', 'interval', 'intervalMs',
    'enabled', 'priority', 'autonomyLevel', 'promptTemplate'
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

  job.updatedAt = new Date().toISOString()
  await saveJobs(data)

  console.log(`🤖 Autonomous job updated: ${job.name}`)
  cosEvents.emit('jobs:updated', { id: job.id, updates })

  return job
}

/**
 * Delete a job
 * @param {string} jobId
 * @returns {Promise<boolean>}
 */
async function deleteJob(jobId) {
  const data = await loadJobs()
  const idx = data.jobs.findIndex(j => j.id === jobId)
  if (idx === -1) return false

  const deleted = data.jobs.splice(idx, 1)[0]
  await saveJobs(data)

  console.log(`🗑️ Autonomous job deleted: ${deleted.name}`)
  cosEvents.emit('jobs:deleted', { id: jobId })

  return true
}

/**
 * Record a job execution
 * @param {string} jobId
 * @returns {Promise<Object|null>} Updated job
 */
async function recordJobExecution(jobId) {
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
}

/**
 * Toggle a job's enabled state
 * @param {string} jobId
 * @returns {Promise<Object|null>}
 */
async function toggleJob(jobId) {
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
}

/**
 * Generate a CoS task from a due job
 * @param {Object} job - The job to generate a task for
 * @returns {Object} Task data suitable for cos.addTask()
 */
function generateTaskFromJob(job) {
  return {
    id: `${job.id}-${Date.now().toString(36)}`,
    description: job.promptTemplate,
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

  let earliest = null
  let earliestTime = Infinity

  for (const job of enabledJobs) {
    const lastRun = job.lastRun ? new Date(job.lastRun).getTime() : 0
    const nextDue = lastRun + job.intervalMs

    if (nextDue < earliestTime) {
      earliestTime = nextDue
      earliest = {
        jobId: job.id,
        jobName: job.name,
        nextDueAt: new Date(nextDue).toISOString(),
        isDue: Date.now() >= nextDue
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
  { value: 'every-4-hours', label: 'Every 4 Hours', ms: 4 * HOUR },
  { value: 'every-8-hours', label: 'Every 8 Hours', ms: 8 * HOUR },
  { value: 'daily', label: 'Daily', ms: DAY },
  { value: 'weekly', label: 'Weekly', ms: WEEK },
  { value: 'biweekly', label: 'Every 2 Weeks', ms: 2 * WEEK },
  { value: 'monthly', label: 'Monthly', ms: 30 * DAY }
]

export {
  getAllJobs,
  getJob,
  getEnabledJobs,
  getDueJobs,
  createJob,
  updateJob,
  deleteJob,
  recordJobExecution,
  toggleJob,
  generateTaskFromJob,
  getJobStats,
  getNextDueJob,
  INTERVAL_OPTIONS
}
