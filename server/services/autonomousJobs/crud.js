/**
 * Autonomous Jobs — CRUD and accessors.
 *
 * Reads (`getAllJobs`, `getJob`, `getEnabledJobs`, `getJobStats`) and the
 * lock-guarded mutators (`createJob`, `updateJob`, `deleteJob`, `toggleJob`,
 * `recordJobExecution`, `recordJobGateSkip`). Mutators serialize through the
 * shared `withLock` mutex and emit `cosEvents` so the UI updates reactively.
 */

import { v4 as uuidv4 } from '../../lib/uuid.js'
import { validateCommand } from '../../lib/commandSecurity.js'
import { cosEvents } from '../cosEvents.js'
import { withLock, resolveIntervalMs } from './constants.js'
import { loadJobs, saveJobs } from './store.js'
import { getNextDueJob } from './scheduler.js'

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
      // Optional managed-app scope. When set, the spawned agent targets the
      // app's repoPath (via task.metadata.app → prepareAgentWorkspace) instead
      // of the PortOS root. Absent/null = global job (historical behavior).
      appId: jobData.appId || null,
      // Optional git-workflow options forwarded into the generated task's
      // metadata (useWorktree/openPR/simplify) so an app-scoped custom task can
      // do isolated work and open a PR like the built-in task types.
      taskMetadata: jobData.taskMetadata || null,
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
      // Optional per-job AI provider + model override. Null = use the active
      // provider / its default model (historical behavior). generateTaskFromJob
      // forwards these into the task metadata the agent runner resolves.
      providerId: jobData.providerId || null,
      model: jobData.model || null,
      // Optional reasoning-effort override (claude/codex). Null = provider
      // default. generateTaskFromJob forwards it into task metadata as `effort`.
      effort: jobData.effort || null,
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
      'command', 'triggerAction', 'config', 'appId', 'taskMetadata', 'providerId', 'model', 'effort'
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

export {
  getAllJobs,
  getJob,
  getEnabledJobs,
  createJob,
  updateJob,
  deleteJob,
  recordJobExecution,
  recordJobGateSkip,
  toggleJob,
  getJobStats
}
