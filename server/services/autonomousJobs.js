/**
 * Autonomous Jobs Service — public barrel.
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
 *
 * The implementation is split across the `autonomousJobs/` directory; this file
 * re-exports the public API so every importer keeps working unchanged:
 * - `autonomousJobs/constants.js`     — shared paths, mutex, field contracts
 * - `autonomousJobs/scriptHandlers.js`— `type: 'script'` handlers + registry
 * - `autonomousJobs/defaults.js`      — DEFAULT_JOBS + defaults-merge logic
 * - `autonomousJobs/store.js`         — load/save/init/migrate persistence
 * - `autonomousJobs/scheduler.js`     — due/next-due + interval helpers
 * - `autonomousJobs/crud.js`          — accessors + lock-guarded mutators
 * - `autonomousJobs/skillTemplates.js`— skill templates + effective prompt
 * - `autonomousJobs/execution.js`     — direct script/shell execution
 */

import { validateCommand } from '../lib/commandSecurity.js'
import { agentDataCleanup } from './autonomousJobs/scriptHandlers.js'
import { JOB_SKILL_MAP, INTERVAL_OPTIONS } from './autonomousJobs/constants.js'
import { initJobs, syncSkillTemplatesFromSample } from './autonomousJobs/store.js'
import {
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
} from './autonomousJobs/crud.js'
import {
  isWeekday,
  getDueJobs,
  getNextDueJob
} from './autonomousJobs/scheduler.js'
import {
  loadJobSkillTemplate,
  saveJobSkillTemplate,
  listJobSkillTemplates,
  getJobEffectivePrompt,
  generateTaskFromJob
} from './autonomousJobs/skillTemplates.js'
import {
  isScriptJob,
  executeScriptJob,
  isShellJob,
  executeShellJob,
  getAllowedCommands
} from './autonomousJobs/execution.js'

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
