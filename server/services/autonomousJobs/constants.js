/**
 * Autonomous Jobs — shared constants and storage primitives.
 *
 * These are the lowest-level shared values for the autonomousJobs submodules:
 * on-disk paths, the per-file write mutex, time helpers, and the field-merge
 * contracts. Keeping them in their own module avoids import cycles between the
 * store, scheduler, defaults, and execution modules.
 */

import { join } from 'path'
import { DAY, HOUR, PATHS } from '../../lib/fileUtils.js'
import { createMutex } from '../../lib/asyncMutex.js'

export const DATA_DIR = PATHS.cos
export const JOBS_FILE = join(DATA_DIR, 'autonomous-jobs.json')
export const JOBS_SKILLS_DIR = PATHS.promptSkillsJobs

// Serializes writes to autonomous-jobs.json so two write paths can't clobber each other.
export const withLock = createMutex()

export const WEEK = 7 * DAY

// Re-export the time units used across submodules so callers import from one place.
export { DAY, HOUR }

/**
 * Resolve interval string to milliseconds. Pure (depends only on the time
 * units above), so it lives in this leaf module — keeping it out of scheduler.js
 * avoids the store→scheduler and crud→scheduler import cycles.
 */
export function resolveIntervalMs(interval, customMs) {
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
export const INTERVAL_OPTIONS = [
  { value: 'hourly', label: 'Every Hour', ms: HOUR },
  { value: 'every-2-hours', label: 'Every 2 Hours', ms: 2 * HOUR },
  { value: 'every-4-hours', label: 'Every 4 Hours', ms: 4 * HOUR },
  { value: 'every-8-hours', label: 'Every 8 Hours', ms: 8 * HOUR },
  { value: 'daily', label: 'Daily', ms: DAY },
  { value: 'weekly', label: 'Weekly', ms: WEEK },
  { value: 'biweekly', label: 'Every 2 Weeks', ms: 2 * WEEK },
  { value: 'monthly', label: 'Monthly', ms: 30 * DAY }
]

// Fields that are code contracts — always overwrite on restart so runtime
// stays consistent with the shipped implementation.
export const JOB_STRUCTURAL_FIELDS = ['type', 'scriptHandler']

// Fields that ship with a default but are user-editable via PUT /api/cos/jobs/:id.
// Only written when the field is absent on the stored job (first-time population).
export const JOB_ADDITIVE_FIELDS = [
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
export const JOB_SKILL_MAP = {
  'job-daily-briefing': 'daily-briefing',
  'job-github-repo-maintenance': 'github-repo-maintenance',
  'job-brain-review': 'brain-review',
  'job-datadog-error-monitor': 'datadog-error-monitor',
  'job-autobiography-prompt': 'autobiography-prompt'
}
