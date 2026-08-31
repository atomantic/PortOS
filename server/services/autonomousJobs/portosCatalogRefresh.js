/**
 * PortOS-owned custom job for maintaining the bundled local-LLM catalog.
 *
 * This is an autonomous job rather than a task-schedule type because its prompt
 * edits PortOS-specific files. Scoping it to the baseline PortOS app keeps it in
 * that app's Automation tab and out of every other managed app's task catalog.
 */

import { PORTOS_APP_ID } from '../../lib/appIdentity.js'
import { DEFAULT_TASK_PROMPTS, promptMatchesShippedDefault } from '../taskPromptDefaults.js'
import { isValidCron } from '../eventScheduler.js'
import { DAY, WEEK } from './constants.js'

export const PORTOS_CATALOG_REFRESH_JOB_ID = 'job-refresh-local-llm-catalog'
export const PORTOS_CATALOG_REFRESH_TASK_TYPE = 'refresh-local-llm-catalog'

/**
 * Scheduled-task prompts used app-template placeholders. Autonomous jobs run in
 * the app's prepared workspace, so repo-relative `.` is both portable and (when
 * worktree isolation is enabled) points at the branch the agent should edit.
 */
export function catalogRefreshPromptForCustomJob(prompt = DEFAULT_TASK_PROMPTS[PORTOS_CATALOG_REFRESH_TASK_TYPE]) {
  return String(prompt || '')
    .replaceAll('{appName}', 'PortOS')
    .replaceAll('{repoPath}', '.')
    .replaceAll('{defaultBranch}', 'the repository default branch')
}

export const PORTOS_CATALOG_REFRESH_JOB = Object.freeze({
  id: PORTOS_CATALOG_REFRESH_JOB_ID,
  name: 'Refresh Local LLM Catalog',
  description: "Research current local models and refresh PortOS's bundled catalog and editorial ranking.",
  category: 'portos-maintenance',
  appId: PORTOS_APP_ID,
  interval: 'weekly',
  intervalMs: WEEK,
  enabled: false,
  priority: 'MEDIUM',
  autonomyLevel: 'manager',
  type: 'agent',
  promptTemplate: catalogRefreshPromptForCustomJob(),
  taskMetadata: { useWorktree: true, openPR: true, simplify: true },
  providerId: null,
  model: null,
  effort: null,
  lastRun: null,
  runCount: 0,
  createdAt: null,
  updatedAt: null
})

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value)

/** Map the task scheduler's cadence vocabulary to autonomous-job fields. */
export function catalogRefreshJobScheduleFields(task = {}, appOverride = {}) {
  const overrideInterval = typeof appOverride.interval === 'string' ? appOverride.interval.trim() : ''
  const type = overrideInterval || task.type || 'weekly'
  const cronExpression = type.includes(' ')
    ? type
    : (type === 'cron' && typeof task.cronExpression === 'string' ? task.cronExpression.trim() : '')

  if (cronExpression) {
    return isValidCron(cronExpression)
      ? { interval: 'daily', intervalMs: DAY, cronExpression }
      : { interval: 'weekly', intervalMs: WEEK, unsupportedScheduleType: 'invalid-cron' }
  }
  if (type === 'daily') return { interval: 'daily', intervalMs: DAY }
  if (type === 'weekly') return { interval: 'weekly', intervalMs: WEEK }
  if (type === 'custom') {
    const overrideMs = Number(appOverride.intervalMs)
    const globalMs = Number(task.intervalMs)
    const intervalMs = overrideMs > 0 ? overrideMs : (globalMs > 0 ? globalMs : DAY)
    return { interval: 'custom', intervalMs }
  }

  // Rotation/once/on-demand/perpetual do not have faithful autonomous-job
  // equivalents. The migration disables these below and leaves a weekly cadence
  // visible for manual runs rather than silently turning one-shot work recurring.
  return { interval: 'weekly', intervalMs: WEEK, unsupportedScheduleType: type }
}

/**
 * Build the destination job from the effective PortOS schedule configuration.
 * Exported so migration tests can pin every preserved field without disk I/O.
 */
export function buildMigratedCatalogRefreshJob({ task = {}, appOverride = {}, execution = {}, now = new Date().toISOString() } = {}) {
  const scheduleFields = catalogRefreshJobScheduleFields(task, appOverride)
  const { unsupportedScheduleType, ...persistedScheduleFields } = scheduleFields
  const effectiveExecution = isObject(execution.perApp?.[PORTOS_APP_ID])
    ? execution.perApp[PORTOS_APP_ID]
    : execution
  const failureParked = Boolean(effectiveExecution.failureParkedAt)
  const globalMetadata = isObject(task.taskMetadata) ? task.taskMetadata : {}
  const appMetadata = isObject(appOverride.taskMetadata) ? appOverride.taskMetadata : {}
  const storedPrompt = task.prompt || DEFAULT_TASK_PROMPTS[PORTOS_CATALOG_REFRESH_TASK_TYPE]
  const promptWasShipped = promptMatchesShippedDefault(storedPrompt, PORTOS_CATALOG_REFRESH_TASK_TYPE)
  const prompt = promptWasShipped ? DEFAULT_TASK_PROMPTS[PORTOS_CATALOG_REFRESH_TASK_TYPE] : storedPrompt

  return {
    ...PORTOS_CATALOG_REFRESH_JOB,
    ...persistedScheduleFields,
    enabled: unsupportedScheduleType || failureParked
      ? false
      : task.enabled === true && appOverride.enabled === true,
    promptTemplate: catalogRefreshPromptForCustomJob(prompt),
    taskMetadata: {
      ...PORTOS_CATALOG_REFRESH_JOB.taskMetadata,
      ...globalMetadata,
      ...appMetadata
    },
    providerId: appOverride.providerId || task.providerId || null,
    model: appOverride.model || task.model || null,
    effort: task.effort || null,
    lastRun: effectiveExecution.lastRun || null,
    runCount: Number.isFinite(effectiveExecution.count) ? effectiveExecution.count : 0,
    createdAt: task.createdAt || now,
    updatedAt: now
  }
}
