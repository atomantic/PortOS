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

// Cadence vocabulary + resolver live in lib so lib/cosValidation.js can validate
// against the same list without importing a service. Re-exported here because
// the submodules (and autonomousJobs.js) have always imported them from this
// leaf module.
export {
  WEEK,
  ON_DEMAND_INTERVAL,
  INTERVAL_OPTIONS,
  JOB_INTERVAL_VALUES,
  resolveIntervalMs,
  isOnDemandJob
} from '../../lib/autonomousJobIntervals.js'

// Re-export the time units used across submodules so callers import from one place.
export { DAY, HOUR }

// Fields that are code contracts — always overwrite on restart so runtime
// stays consistent with the shipped implementation.
export const JOB_STRUCTURAL_FIELDS = ['type', 'scriptHandler', 'appId']

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
