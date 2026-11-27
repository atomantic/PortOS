import { mockSchedule, PAUSED_SHIPPED_DRAINS, cronDueNow, cronNotDueYet, installScheduleHooks } from './taskSchedule.test.fixture.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  INTERVAL_TYPES,
  SELF_IMPROVEMENT_TASK_TYPES,
  loadSchedule,
  getTaskInterval,
  updateTaskInterval,
  recordExecution,
  recordRecommendedAudits,
  shouldRunTask,
  getDueTasks,
  getNextTaskType,
  resetExecutionHistory,
  triggerOnDemandTask,
  getOnDemandRequests,
  clearOnDemandRequest,
  getScheduleStatus,
  applyOnDemandRunResets,
  queuePerpetualRefill,
  acknowledgeSwarmCleanupRefill,
  ON_DEMAND_ORIGINS,
  PROMPT_VERSIONS,
  DEFAULT_TASK_INTERVALS,
  getTaskTypeInvocation,
  REFERENCE_WATCH_AUDITED_VERSION,
} from './taskSchedule.js';
import { isRefillRequest } from './taskScheduleConstants.js';
import { TASK_TYPE_DESCRIPTIONS, TASK_TYPE_INVOCATION } from './taskScheduleRegistry.js';
import { annotateMissingCheckouts, getBranchReconcileOutcome } from './branchReconcileOutcome.js';
import { cosEvents } from './cos/cosEvents.js';
import { recordUserAction } from './userActions.js'
import { DEFAULT_TASK_PROMPTS } from './taskPromptDefaults.js'
import { RETIRED_CONSOLE_ERRORS_PROMPT } from './taskPromptDefaults/retiredPromptFixtures.js'
import { loadState } from './cos/cosState.js'
import { readJSONFile } from '../lib/fileUtils.js'
import { writeFile } from 'fs/promises'
import {
  isTaskTypeEnabledForApp,
  getAppById,
  getAppTaskTypeInterval,
  clearAllPrWatcherState,
  clearAllIssueWatcherState,
} from './apps.js';
import { reconcileInventoryRows } from './branchReconcileInventoryPrune.js'
import { getLocalParts } from '../lib/timezone.js'
import { parseCronToNextRun } from './eventScheduler.js'
import { isInstanceFeatureEnabled } from './instanceFeatures.js'
import { inputsUnchangedSince } from './taskInputGate.js'

// Resolve "the most recent 9 AM in the past, local time." Bare
// `setHours(9, 0, 0, 0)` flakes in CI when the runner's wall-clock is
// before 9 AM local (UTC CI fires at ~04:00 UTC daily) — today's 9 AM
// would be in the future. Subtract a day when needed.
const recentNineAm = () => {
  const d = new Date()
  d.setHours(9, 0, 0, 0)
  if (d.getTime() > Date.now()) d.setDate(d.getDate() - 1)
  return d
}

describe('taskSchedule', () => {
  installScheduleHooks();

  describe('loadSchedule', () => {
    it('should return default schedule when no file exists', async () => {
      readJSONFile.mockResolvedValue(null)
      const schedule = await loadSchedule()
      expect(schedule.version).toBe(2)
      expect(schedule.tasks).toBeDefined()
      expect(schedule.executions).toBeDefined()
    })

    it('returns independent schedule instances on consecutive no-file reads without polluting defaults', async () => {
      readJSONFile.mockResolvedValue(null)
      const first = await loadSchedule()
      first.executions['task:security'] = { lastRun: '2026-10-18T00:00:00.000Z', count: 1 }
      first.templates.push({ name: 'polluted' })
      first.tasks['security'].enabled = false

      const second = await loadSchedule()
      expect(second.executions['task:security']).toBeUndefined()
      expect(second.templates).toEqual([])
      expect(second.tasks['security'].enabled).toBe(true)
      expect(DEFAULT_TASK_INTERVALS['security'].enabled).toBe(true)
    })

    it('does not mutate DEFAULT_TASK_INTERVALS during v1 to v2 migration', async () => {
      const originalSecurityPrompt = DEFAULT_TASK_INTERVALS['security'].prompt
      const originalSecurityMeta = DEFAULT_TASK_INTERVALS['security'].taskMetadata

      readJSONFile.mockResolvedValue({
        version: 1,
        selfImprovement: {
          security: {
            prompt: 'custom v1 prompt',
            taskMetadata: { fileIssues: true }
          }
        }
      })

      const migrated = await loadSchedule()
      expect(migrated.tasks['security'].prompt).toBe('custom v1 prompt')
      expect(DEFAULT_TASK_INTERVALS['security'].prompt).toBe(originalSecurityPrompt)
      expect(DEFAULT_TASK_INTERVALS['security'].taskMetadata).toEqual(originalSecurityMeta)
    })

    it('installs tasks on demand and keeps model research disabled until configured', async () => {
      const schedule = await loadSchedule()

      for (const taskType of SELF_IMPROVEMENT_TASK_TYPES) {
        expect(schedule.tasks[taskType], taskType).toMatchObject({
          type: INTERVAL_TYPES.ON_DEMAND,
          enabled: taskType !== 'model-comparison-refresh'
        })
      }
    })

    it('carries pre-rename v1 task config onto the renamed task', async () => {
      readJSONFile.mockResolvedValue({
        selfImprovement: { 'release-check': { enabled: false, prompt: 'custom release prompt' } },
        executions: { 'self-improve:release-check': { count: 2, lastRun: '2026-09-01T00:00:00.000Z' } },
      })
      const schedule = await loadSchedule()
      expect(schedule.tasks['do-release']).toMatchObject({ enabled: false, prompt: 'custom release prompt' })
      expect(schedule.tasks).not.toHaveProperty('release-check')
      expect(schedule.executions['task:do-release']).toMatchObject({ count: 2 })
    })

    it('turns the stall nudge off for a stored do-release schedule that never set it, and keeps an explicit choice', async () => {
      mockSchedule({
        tasks: { 'do-release': { type: 'on-demand', enabled: true, taskMetadata: { slashdoCommand: 'release', finishInFlight: true } } }
      })
      expect((await loadSchedule()).tasks['do-release'].taskMetadata).toMatchObject({ stallNudge: false, finishInFlight: true })

      mockSchedule({
        tasks: { 'do-release': { type: 'on-demand', enabled: true, taskMetadata: { slashdoCommand: 'release', stallNudge: true } } }
      })
      expect((await loadSchedule()).tasks['do-release'].taskMetadata.stallNudge).toBe(true)
    })

    it('should load and return existing v2 schedule', async () => {
      mockSchedule({
        tasks: { 'security': { type: 'weekly', enabled: true, providerId: 'p1', model: 'm1', prompt: null } }
      })

      const schedule = await loadSchedule()
      expect(schedule.version).toBe(2)
      expect(schedule.tasks['security'].enabled).toBe(true)
      expect(schedule.tasks['security'].providerId).toBe('p1')
    })

    it('normalizes a legacy cadence on read while preserving the paused state', async () => {
      mockSchedule({
        tasks: { security: { type: 'weekly', enabled: false, providerId: null, model: null, prompt: null } }
      })

      const schedule = await loadSchedule()

      // 'weekly' collapses to a Monday-07:00 cron; `enabled: false` is untouched.
      expect(schedule.tasks.security).toMatchObject({
        type: INTERVAL_TYPES.CRON, cronExpression: '0 7 * * 1', perpetual: false, enabled: false
      })
    })

    it('collapses every retired cadence and keeps the perpetual flag orthogonal', async () => {
      mockSchedule({
        tasks: {
          security: { type: 'rotation', enabled: true },
          'code-quality': { type: 'once', enabled: true },
          'test-coverage': { type: 'custom', intervalMs: 15 * 60 * 1000, enabled: true },
          documentation: { type: 'perpetual', recheckCron: '0 3 * * *', enabled: true },
          'api-contract': { type: 'cron', cronExpression: '30 8 * * 2', perpetual: true, enabled: true },
        }
      })

      const { tasks } = await loadSchedule()
      expect(tasks.security).toMatchObject({ type: 'cron', cronExpression: '0 7 * * *', perpetual: false })
      expect(tasks['architecture-maintainability']).toMatchObject({ type: 'on-demand', perpetual: false })
      expect(tasks['architecture-maintainability'].cronExpression).toBeFalsy()
      expect(tasks['test-quality-coverage']).toMatchObject({ type: 'cron', cronExpression: '*/15 * * * *' })
      expect(tasks['documentation-content']).toMatchObject({ type: 'on-demand', perpetual: true, recheckCron: '0 3 * * *' })
      // Already on the new model: left exactly as stored.
      expect(tasks['api-contract']).toMatchObject({ type: 'cron', cronExpression: '30 8 * * 2', perpetual: true })
    })

    it('should merge defaults for missing task types', async () => {
      mockSchedule({
        tasks: { 'security': { type: 'weekly', enabled: true, providerId: null, model: null, prompt: null } }
      })

      const schedule = await loadSchedule()
      // Should have all default task types even though only security was saved
      expect(schedule.tasks['architecture-maintainability']).toBeDefined()
      expect(schedule.tasks['test-quality-coverage']).toBeDefined()
    })
  })

  describe('getTaskInterval', () => {
    it('should return interval for known task type', async () => {
      const interval = await getTaskInterval('security')
      expect(interval.type).toBe(INTERVAL_TYPES.ON_DEMAND)
      expect(interval.enabled).toBe(true)
    })

    it('should return disabled defaults for unknown task type', async () => {
      const interval = await getTaskInterval('unknown-task')
      expect(interval.enabled).toBe(false)
    })

    it('reference-watch default is writable so the v4 prompt can record proposals (PLAN.md commit or gh/glab issue create)', async () => {
      // The v4 reference-watch prompt records proposals in the app's resolved
      // work tracker: PLAN.md commits its checklist items; GitHub/GitLab use
      // the shared `gh`/`glab` issue instructions. Both need a writable agent —
      // if `readOnly` flips back to true,
      // agentPromptBuilder injects the "## Read-Only Task" guard and the agent
      // refuses to write/commit/shell, silently breaking the flow. Pin the
      // contract so a future "default to read-only" refactor surfaces here.
      const interval = await getTaskInterval('reference-watch')
      expect(interval.taskMetadata?.readOnly).toBe(false)
    })

    // Tripwire for issue #734: the reference-watch `readOnly` default is derived from
    // what the prompt VERSION does. When PROMPT_VERSIONS['reference-watch'] is bumped,
    // this test fails until someone re-audits the default and advances
    // REFERENCE_WATCH_AUDITED_VERSION to match — so a prompt change can't silently
    // leave the schedule default stale.
    it('reference-watch readOnly default has been audited against the current prompt version (issue #734)', () => {
      expect(PROMPT_VERSIONS['reference-watch']).toBe(REFERENCE_WATCH_AUDITED_VERSION)
    })

    it('reference-watch v5 prompt requires a writable default so it can record proposals (PLAN.md commit or gh/glab issue create) (issue #734)', () => {
      // The coupling the audit anchor protects: at the audited version (v5), the prompt
      // writes to the resolved tracker (PLAN.md commit, or `gh`/`glab issue create`), so the
      // raw default must be writable. If a future re-audit flips
      // REFERENCE_WATCH_AUDITED_VERSION to a propose-only version, update this expectation
      // alongside the default and the anchor.
      if (REFERENCE_WATCH_AUDITED_VERSION === 5) {
        expect(DEFAULT_TASK_INTERVALS['reference-watch'].taskMetadata.readOnly).toBe(false)
      }
    })
  })

  describe('updateTaskInterval', () => {
    it('should update and persist task interval settings', async () => {
      const result = await updateTaskInterval('security', {
        enabled: true,
        providerId: 'provider-1',
        model: 'claude-3'
      })

      expect(result.enabled).toBe(true)
      expect(result.providerId).toBe('provider-1')
      expect(result.model).toBe('claude-3')
    })

    it('should normalize empty prompt to null', async () => {
      const result = await updateTaskInterval('security', {
        prompt: '   '
      })
      expect(result.prompt).toBeNull()
    })

    it('should set promptCustomized when custom prompt provided', async () => {
      const result = await updateTaskInterval('security', {
        prompt: 'Custom security audit prompt'
      })
      expect(result.promptCustomized).toBe(true)
    })

    it('should clear promptCustomized when prompt set to null', async () => {
      const result = await updateTaskInterval('security', {
        prompt: null
      })
      expect(result.promptCustomized).toBe(false)
    })

    // An explicit prompt write is the ONE source of a 'user' pin (#5432) — it is
    // what makes the store's self-heal leave a retired-but-deliberate body alone.
    it('should stamp promptSource "user" when a custom prompt is written', async () => {
      const result = await updateTaskInterval('security', {
        prompt: 'Custom security audit prompt'
      })
      expect(result.promptSource).toBe('user')
    })

    // The prompt editor prefills from the stored body, so "open, click Save" sends
    // back the CURRENT default verbatim. That must not pin — a pin is checked by
    // the self-heal only when its provenance is inferred, so a 'user' stamp here
    // would freeze the type off every future prompt upgrade with no way back.
    it('should not pin a prompt that is byte-identical to the current default', async () => {
      const result = await updateTaskInterval('security', {
        prompt: DEFAULT_TASK_PROMPTS['security']
      })
      expect(result.promptCustomized).toBe(false)
      expect(result.promptSource).toBeNull()
    })

    // A RETIRED shipped body IS a deliberate choice — the #5432 case.
    it('should pin a retired shipped default written by the user', async () => {
      const result = await updateTaskInterval('console-errors', { prompt: RETIRED_CONSOLE_ERRORS_PROMPT })
      expect(result.promptCustomized).toBe(true)
      expect(result.promptSource).toBe('user')
    })

    it('should clear promptSource when the prompt is set to null', async () => {
      const result = await updateTaskInterval('security', {
        prompt: null
      })
      expect(result.promptSource).toBeNull()
    })

    it('should preserve an existing pin when the write does not touch the prompt', async () => {
      mockSchedule({
        tasks: {
          'security': {
            type: 'weekly', enabled: false, providerId: null, model: null,
            prompt: 'A pinned body that matches no shipped default.',
            promptVersion: 2, promptCustomized: true, promptSource: 'user'
          }
        }
      })
      const result = await updateTaskInterval('security', { enabled: true })
      expect(result.promptSource).toBe('user')
      expect(result.promptCustomized).toBe(true)
    })

    it('should create new task entry for unknown type', async () => {
      const result = await updateTaskInterval('custom-type', {
        type: 'daily',
        enabled: true
      })
      expect(result.type).toBe('daily')
      expect(result.enabled).toBe(true)
    })

    it('clears all pr-watcher state when pr-watcher is globally disabled', async () => {
      clearAllPrWatcherState.mockClear()
      await updateTaskInterval('pr-watcher', { enabled: false })
      expect(clearAllPrWatcherState).toHaveBeenCalledTimes(1)
    })

    it('does not clear pr-watcher state on enable or on other task disables', async () => {
      clearAllPrWatcherState.mockClear()
      await updateTaskInterval('pr-watcher', { enabled: true })
      await updateTaskInterval('security', { enabled: false })
      expect(clearAllPrWatcherState).not.toHaveBeenCalled()
    })

    it('clears all issue-watcher state when issue-watcher is globally disabled', async () => {
      clearAllIssueWatcherState.mockClear()
      await updateTaskInterval('issue-watcher', { enabled: false })
      expect(clearAllIssueWatcherState).toHaveBeenCalledTimes(1)
    })
  })

  describe('managed agent options', () => {
    it('forces plan-task useWorktree/openPR back to false when stored true (loadSchedule)', async () => {
      mockSchedule({
        tasks: {
          'plan-task': {
            type: 'cron',
            enabled: true,
            providerId: null,
            model: null,
            prompt: null,
            taskMetadata: { useWorktree: true, openPR: true, simplify: true }
          }
        }
      })

      const schedule = await loadSchedule()
      expect(schedule.tasks['plan-task'].taskMetadata.useWorktree).toBe(false)
      expect(schedule.tasks['plan-task'].taskMetadata.openPR).toBe(false)
      expect(schedule.tasks['plan-task'].taskMetadata.claimFlow).toBe(true)
      // Non-managed flags pass through untouched
      expect(schedule.tasks['plan-task'].taskMetadata.simplify).toBe(true)
    })

    it('exposes managedAgentOptions in getScheduleStatus for plan-task', async () => {
      mockSchedule()
      const status = await getScheduleStatus()
      expect(status.tasks['plan-task'].managedAgentOptions).toEqual(['useWorktree', 'openPR', 'claimFlow'])
      // Other tasks should not carry the field
      expect(status.tasks['security'].managedAgentOptions).toBeUndefined()
    })

    it('rejects PUT attempts to flip a managed flag — response echoes the locked value', async () => {
      mockSchedule()
      const result = await updateTaskInterval('plan-task', {
        taskMetadata: { useWorktree: true, openPR: true, simplify: true }
      })
      expect(result.taskMetadata.useWorktree).toBe(false)
      expect(result.taskMetadata.openPR).toBe(false)
      expect(result.taskMetadata.claimFlow).toBe(true)
      expect(result.taskMetadata.simplify).toBe(true)
    })

    it('repopulates managed flags when stored taskMetadata was cleared to null', async () => {
      mockSchedule({
        tasks: {
          'plan-task': {
            type: 'cron',
            enabled: true,
            providerId: null,
            model: null,
            prompt: null,
            taskMetadata: null
          }
        }
      })

      const schedule = await loadSchedule()
      expect(schedule.tasks['plan-task'].taskMetadata.useWorktree).toBe(false)
      expect(schedule.tasks['plan-task'].taskMetadata.openPR).toBe(false)
      expect(schedule.tasks['plan-task'].taskMetadata.claimFlow).toBe(true)
    })
  })

  describe('recordExecution', () => {
    it('should record global execution', async () => {
      mockSchedule()
      const result = await recordExecution('test-record-global')
      expect(result.lastRun).toBeDefined()
      expect(result.count).toBe(1)
    })

    it('should record per-app execution', async () => {
      mockSchedule()
      const result = await recordExecution('test-record-app', 'app-1')
      expect(result.perApp['app-1']).toBeDefined()
      expect(result.perApp['app-1'].count).toBe(1)
      expect(result.perApp['app-1'].lastRun).toBeDefined()
    })

    it('should increment count on repeated execution', async () => {
      mockSchedule({
        executions: { 'task:test-incr': { lastRun: '2025-01-01T00:00:00Z', count: 5, perApp: {} } }
      })
      const result = await recordExecution('test-incr')
      expect(result.count).toBe(6)
    })
  })

  describe('shouldRunTask', () => {
    it('keeps invalid cron verdicts one shape before and after cron parsing', async () => {
      mockSchedule({ tasks: { 'ui-runtime-bugs': { type: 'cron', enabled: true, cronExpression: 'not a cron' } } })
      const malformed = await shouldRunTask('ui-runtime-bugs')
      mockSchedule({ tasks: { 'ui-runtime-bugs': { type: 'cron', enabled: true, cronExpression: '0 7 * * *' } } })
      parseCronToNextRun.mockReturnValue(null)
      const unresolvable = await shouldRunTask('ui-runtime-bugs')
      expect(malformed).toEqual({ shouldRun: false, reason: 'invalid-cron', cronExpression: null })
      expect(unresolvable).toEqual({ shouldRun: false, reason: 'invalid-cron', cronExpression: '0 7 * * *' })
    })

    it('does not run a task whose required instance feature is disabled', async () => {
      isInstanceFeatureEnabled.mockResolvedValue(false)
      mockSchedule({ tasks: { 'jira-sprint-manager': { type: 'rotation', enabled: true } } })

      const result = await shouldRunTask('jira-sprint-manager')

      expect(result).toEqual({ shouldRun: false, reason: 'feature-disabled', feature: 'jira' })
    })

    it('should not run disabled task', async () => {
      mockSchedule({
        tasks: { 'disabled-task': { type: 'weekly', enabled: false, providerId: null, model: null, prompt: null } }
      })
      const result = await shouldRunTask('disabled-task')
      expect(result.shouldRun).toBe(false)
      expect(result.reason).toBe('disabled')
    })

    it('normalizes a retired rotation cadence to a daily cron on read', async () => {
      readJSONFile.mockResolvedValue({
        version: 2,
        tasks: {
          'architecture-maintainability': { type: 'rotation', enabled: true, providerId: null, model: null, prompt: null }
        },
        executions: {}
      })

      const interval = await getTaskInterval('architecture-maintainability')
      expect(interval).toMatchObject({ type: 'cron', cronExpression: '0 7 * * *', perpetual: false })
    })

    it('never auto-runs a plain on-demand task, but drains one carrying the perpetual flag', async () => {
      mockSchedule({
        tasks: {
          'ui-runtime-bugs': { type: 'on-demand', enabled: true, providerId: null, model: null, prompt: null },
          'claim-issue': { type: 'on-demand', perpetual: true, enabled: true, providerId: null, model: null, prompt: null }
        }
      })

      expect(await shouldRunTask('ui-runtime-bugs')).toMatchObject({ shouldRun: false, reason: 'on-demand-only' })
      expect(await shouldRunTask('claim-issue')).toMatchObject({ shouldRun: true, reason: 'perpetual-drain' })
    })

    it('should not run on-demand tasks automatically', async () => {
      mockSchedule({
        tasks: { 'ui-runtime-bugs': { type: 'on-demand', enabled: true, providerId: null, model: null, prompt: null } }
      })

      const result = await shouldRunTask('ui-runtime-bugs')
      expect(result.shouldRun).toBe(false)
      expect(result.reason).toBe('on-demand-only')
    })

    it('collapses a retired once cadence to a manual-only on-demand task, run count or not', async () => {
      mockSchedule({
        tasks: { 'accessibility': { type: 'once', enabled: true, providerId: null, model: null, prompt: null } },
        executions: { 'task:accessibility': { lastRun: '2025-01-01T00:00:00Z', count: 1, perApp: {} } }
      })

      const result = await shouldRunTask('accessibility')
      expect(result.shouldRun).toBe(false)
      // No 'once-completed' dead end — a manual trigger runs it again.
      expect(result.reason).toBe('on-demand-only')
    })

    it('should skip weekday-only tasks on weekends', async () => {
      getLocalParts.mockReturnValue({ dayOfWeek: 0 }) // Sunday

      mockSchedule({
        tasks: { 'pr-reviewer': { type: 'cron', cronExpression: '0 */2 * * *', enabled: true, weekdaysOnly: true, providerId: null, model: null, prompt: null } }
      })

      const result = await shouldRunTask('pr-reviewer')
      expect(result.shouldRun).toBe(false)
      expect(result.reason).toBe('weekday-only')
    })

    it('should not run when disabled for specific app', async () => {
      isTaskTypeEnabledForApp.mockResolvedValue(false)

      mockSchedule({
        tasks: { 'security': { type: 'weekly', enabled: true, providerId: null, model: null, prompt: null } }
      })

      const result = await shouldRunTask('security', 'app-1')
      expect(result.shouldRun).toBe(false)
      expect(result.reason).toBe('disabled-for-app')
    })

    it('runs a cron task once its slot has elapsed', async () => {
      cronDueNow()
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()

      // Explicit runAfter: [] overrides the feature-ideas default that depends on do-replan
      mockSchedule({
        tasks: { 'feature-ideas': { type: 'cron', cronExpression: '0 7 * * *', enabled: true, providerId: null, model: null, prompt: null, runAfter: [] } },
        executions: { 'task:feature-ideas': { lastRun: twoDaysAgo, count: 1, perApp: {} } }
      })

      const result = await shouldRunTask('feature-ideas')
      expect(result.shouldRun).toBe(true)
      expect(result.reason).toBe('cron-due')
    })

    it('holds a cron task until its next slot', async () => {
      cronNotDueYet()
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()

      mockSchedule({
        tasks: { 'feature-ideas': { type: 'cron', cronExpression: '0 7 * * *', enabled: true, providerId: null, model: null, prompt: null, runAfter: [] } },
        executions: { 'task:feature-ideas': { lastRun: oneHourAgo, count: 5, perApp: {} } }
      })

      const result = await shouldRunTask('feature-ideas')
      expect(result.shouldRun).toBe(false)
      expect(result.reason).toBe('cron-cooldown')
    })

    it('feature-ideas waits on do-replan when do-replan is enabled', async () => {
      cronDueNow()
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()

      // Default runAfter:['do-replan'] kicks in since the test doesn't override it
      mockSchedule({
        tasks: {
          'feature-ideas': { type: 'cron', cronExpression: '0 7 * * *', enabled: true, providerId: null, model: null, prompt: null },
          'do-replan':     { type: 'cron', cronExpression: '0 7 * * 1', enabled: true, providerId: null, model: null, prompt: null }
        },
        executions: { 'task:feature-ideas': { lastRun: twoDaysAgo, count: 1, perApp: {} } }
      })

      const result = await shouldRunTask('feature-ideas')
      expect(result.shouldRun).toBe(false)
      expect(result.reason).toBe('waiting-on-dependencies')
      expect(result.pendingDeps).toContain('do-replan')
    })

    it('feature-ideas runs when do-replan dependency is globally disabled', async () => {
      cronDueNow()
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()

      // do-replan is disabled — feature-ideas would otherwise wait forever, so the dep is skipped
      mockSchedule({
        tasks: {
          'feature-ideas': { type: 'cron', cronExpression: '0 7 * * *', enabled: true, providerId: null, model: null, prompt: null },
          'do-replan':     { type: 'cron', cronExpression: '0 7 * * 1', enabled: false, providerId: null, model: null, prompt: null }
        },
        executions: { 'task:feature-ideas': { lastRun: twoDaysAgo, count: 1, perApp: {} } }
      })

      const result = await shouldRunTask('feature-ideas')
      expect(result.shouldRun).toBe(true)
      expect(result.reason).toBe('cron-due')
    })

    it('feature-ideas runs when do-replan dependency is disabled for the app', async () => {
      cronDueNow()
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()

      mockSchedule({
        tasks: {
          'feature-ideas': { type: 'cron', cronExpression: '0 7 * * *', enabled: true, providerId: null, model: null, prompt: null },
          'do-replan':     { type: 'cron', cronExpression: '0 7 * * 1', enabled: true, providerId: null, model: null, prompt: null }
        },
        executions: {
          'task:feature-ideas': { lastRun: twoDaysAgo, count: 1, perApp: { 'app-1': { lastRun: twoDaysAgo, count: 1 } } }
        }
      })
      // do-replan is enabled globally but disabled for app-1; feature-ideas is enabled for app-1
      const originalIsTaskTypeEnabledForApp = isTaskTypeEnabledForApp.getMockImplementation()
      isTaskTypeEnabledForApp.mockImplementation(async (_appId, taskType) => taskType !== 'do-replan')

      try {
        const result = await shouldRunTask('feature-ideas', 'app-1')
        expect(result.shouldRun).toBe(true)
        expect(result.reason).toBe('cron-due')
      } finally {
        if (originalIsTaskTypeEnabledForApp) {
          isTaskTypeEnabledForApp.mockImplementation(originalIsTaskTypeEnabledForApp)
        } else {
          isTaskTypeEnabledForApp.mockReset()
        }
      }
    })

    it('feature-ideas ignores an enabled on-demand do-replan dependency', async () => {
      cronDueNow()
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()

      mockSchedule({
        tasks: {
          'feature-ideas': { type: 'cron', cronExpression: '0 7 * * *', enabled: true, providerId: null, model: null, prompt: null },
          'do-replan': { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null }
        },
        executions: { 'task:feature-ideas': { lastRun: twoDaysAgo, count: 1, perApp: {} } }
      })

      const result = await shouldRunTask('feature-ideas')
      expect(result.shouldRun).toBe(true)
      expect(result.reason).toBe('cron-due')
    })

    it('feature-ideas runs when do-replan has run since its last run', async () => {
      cronDueNow()
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

      mockSchedule({
        tasks: {
          'feature-ideas': { type: 'cron', cronExpression: '0 7 * * *', enabled: true, providerId: null, model: null, prompt: null },
          'do-replan':     { type: 'cron', cronExpression: '0 7 * * 1', enabled: true, providerId: null, model: null, prompt: null }
        },
        executions: {
          'task:feature-ideas': { lastRun: twoDaysAgo, count: 1, perApp: {} },
          'task:do-replan':     { lastRun: oneDayAgo, count: 1, perApp: {} }
        }
      })

      const result = await shouldRunTask('feature-ideas')
      expect(result.shouldRun).toBe(true)
      expect(result.reason).toBe('cron-due')
    })

    describe('cron slots without catch-up', () => {
      let savedImplementations
      beforeEach(async () => {
        const mocks = [parseCronToNextRun, getLocalParts, getAppTaskTypeInterval, isTaskTypeEnabledForApp]
        savedImplementations = mocks.map(mock => [mock, mock.getMockImplementation()])
        const actual = await vi.importActual('../lib/timezone.js')
        getLocalParts.mockImplementation(actual.getLocalParts)
        isTaskTypeEnabledForApp.mockResolvedValue(true)
      })
      afterEach(() => {
        for (const [mock, implementation] of savedImplementations) mock.mockImplementation(implementation)
      })

      it('waits after an inherited schedule edit, fires in the new slot, and does not repeat it', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-09-09T05:57:22Z'))
        const actual = await vi.importActual('./eventScheduler.js')
        parseCronToNextRun.mockImplementation(actual.parseCronToNextRun)
        getAppTaskTypeInterval.mockResolvedValue(null)
        const lastRun = '2026-09-08T05:01:00Z'
        const schedule = {
          tasks: { 'do-release': { type: 'cron', enabled: true, cronExpression: '30 4 * * *', runAfter: [] } },
          executions: { 'task:do-release': { perApp: { 'app-1': { lastRun, count: 1 } } } }
        }
        mockSchedule(schedule)

        expect(await shouldRunTask('do-release', 'app-1')).toMatchObject({
          shouldRun: false, reason: 'cron-cooldown', nextRunAt: '2026-09-09T11:30:00.000Z'
        })
        vi.setSystemTime(new Date('2026-09-09T11:30:20Z'))
        expect(await shouldRunTask('do-release', 'app-1')).toMatchObject({ shouldRun: true, reason: 'cron-due' })

        schedule.executions['task:do-release'].perApp['app-1'].lastRun = '2026-09-09T11:30:20Z'
        mockSchedule(schedule)
        expect(await shouldRunTask('do-release', 'app-1')).toMatchObject({
          shouldRun: false, nextRunAt: '2026-09-10T11:30:00.000Z'
        })
      })

      it('judges readiness against a pinned `now` instead of the wall clock', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-09-09T11:31:30Z'))
        const actual = await vi.importActual('./eventScheduler.js')
        parseCronToNextRun.mockImplementation(actual.parseCronToNextRun)
        getAppTaskTypeInterval.mockResolvedValue(null)
        mockSchedule({
          tasks: { 'do-release': { type: 'cron', enabled: true, cronExpression: '30 4 * * *', runAfter: [] } },
          executions: { 'task:do-release': { perApp: { 'app-1': { lastRun: '2026-09-08T05:01:00Z', count: 1 } } } }
        })
        const pinned = new Date('2026-09-09T11:30:20Z').getTime()
        expect(await shouldRunTask('do-release', 'app-1')).toMatchObject({ shouldRun: false, reason: 'cron-cooldown' })
        expect(await shouldRunTask('do-release', 'app-1', { now: pinned })).toMatchObject({ shouldRun: true, reason: 'cron-due' })
        expect((await getDueTasks('app-1', { now: pinned })).map(t => t.taskType)).toContain('do-release')
        expect((await getDueTasks('app-1')).map(t => t.taskType)).not.toContain('do-release')
      })

      it('waits for the next per-app slot after downtime, including never-run tasks', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-09-09T12:00:00Z'))
        const actual = await vi.importActual('./eventScheduler.js')
        parseCronToNextRun.mockImplementation(actual.parseCronToNextRun)
        getAppTaskTypeInterval.mockResolvedValue('30 4 * * *')
        mockSchedule({
          tasks: { 'do-release': { type: 'cron', enabled: true, cronExpression: '0 8 * * *', createdAt: '2026-09-01T00:00:00Z', runAfter: [] } }
        })
        expect(await shouldRunTask('do-release', 'app-1')).toMatchObject({
          shouldRun: false, nextRunAt: '2026-09-10T11:30:00.000Z'
        })
        getAppTaskTypeInterval.mockResolvedValue(null)
      })
    })
  })

  describe('getDueTasks', () => {
    it('should return empty array when no tasks are enabled', async () => {
      mockSchedule({
        tasks: { ...PAUSED_SHIPPED_DRAINS, 'security': { type: 'cron', cronExpression: '0 7 * * 1', enabled: false, providerId: null, model: null, prompt: null } }
      })
      const due = await getDueTasks()
      expect(due).toEqual([])
    })

    it('returns a due cron task and skips a disabled one', async () => {
      parseCronToNextRun.mockReturnValue(new Date(Date.now() - 60_000))
      mockSchedule({
        tasks: {
          ...PAUSED_SHIPPED_DRAINS,
          'architecture-maintainability': { type: 'cron', cronExpression: '0 7 * * *', enabled: true, providerId: null, model: null, prompt: null },
          'security': { type: 'cron', cronExpression: '0 7 * * 1', enabled: false, providerId: null, model: null, prompt: null }
        }
      })

      const due = await getDueTasks()
      expect(due.length).toBe(1)
      expect(due[0].taskType).toBe('architecture-maintainability')
    })
  })

  describe('getNextTaskType', () => {
    it('should return null when no tasks are enabled', async () => {
      mockSchedule({
        tasks: { ...PAUSED_SHIPPED_DRAINS, 'security': { type: 'cron', cronExpression: '0 7 * * 1', enabled: false, providerId: null, model: null, prompt: null } }
      })
      const result = await getNextTaskType()
      expect(result).toBeNull()
    })

    it('returns null when only on-demand tasks are enabled — nothing is auto-queued', async () => {
      mockSchedule({
        tasks: {
          ...PAUSED_SHIPPED_DRAINS,
          'architecture-maintainability': { type: 'on-demand', enabled: true, providerId: null, model: null, prompt: null },
          'error-handling': { type: 'on-demand', enabled: true, providerId: null, model: null, prompt: null }
        }
      })

      expect(await getNextTaskType()).toBeNull()
    })

    it('does not select a feature-disabled task', async () => {
      isInstanceFeatureEnabled.mockResolvedValue(false)
      parseCronToNextRun.mockReturnValue(new Date(Date.now() - 60_000))
      mockSchedule({ tasks: {
        ...PAUSED_SHIPPED_DRAINS,
        'jira-sprint-manager': { type: INTERVAL_TYPES.CRON, cronExpression: '0 7 * * *', enabled: true },
      } })

      expect(await getNextTaskType()).toBeNull()
    })

    it('prefers a due cron task over an always-ready perpetual drain', async () => {
      // A user-pinned wall-clock schedule must fire at its slot even while a
      // perpetual task is perpetually 'ready' (draining a backlog).
      const todayNineAm = recentNineAm()
      const yesterdayNineAm = new Date(todayNineAm.getTime() - 24 * 60 * 60 * 1000)

      cronDueNow()

      mockSchedule({
        tasks: {
          ...PAUSED_SHIPPED_DRAINS,
          'architecture-maintainability': { type: 'on-demand', perpetual: true, enabled: true, providerId: null, model: null, prompt: null, runAfter: [] },
          'plan-task':    { type: 'cron',   enabled: true, cronExpression: '0 9 * * *', providerId: null, model: null, prompt: null, createdAt: yesterdayNineAm.toISOString() }
        }
      })

      const result = await getNextTaskType()
      expect(result.taskType).toBe('plan-task')
      expect(result.reason).toBe('cron-due')
    })

    it('perpetualOnly returns the due perpetual task even when a higher-priority cron task is also due', async () => {
      // The mixed-schedule stall: an app on review cooldown has BOTH a due cron
      // task and a due perpetual drain. Unconstrained, getNextTaskType returns
      // the cron task (cron outranks perpetual) — but on cooldown only the
      // perpetual drain is eligible, so the caller passes perpetualOnly to get
      // the drain instead of being stranded behind the cooled-down cron pick.
      const todayNineAm = recentNineAm()
      const yesterdayNineAm = new Date(todayNineAm.getTime() - 24 * 60 * 60 * 1000)
      cronDueNow()

      mockSchedule({
        tasks: {
          ...PAUSED_SHIPPED_DRAINS,
          'pr-watcher':  { type: 'cron', enabled: true, cronExpression: '0 9 * * *', providerId: null, model: null, prompt: null, createdAt: yesterdayNineAm.toISOString() },
          'claim-issue': { type: 'on-demand', perpetual: true, enabled: true, providerId: null, model: null, prompt: null }
        }
      })

      // Unconstrained: cron wins.
      const unconstrained = await getNextTaskType()
      expect(unconstrained.taskType).toBe('pr-watcher')

      // perpetualOnly: the perpetual drain is returned instead.
      const constrained = await getNextTaskType(null, { perpetualOnly: true })
      expect(constrained).not.toBeNull()
      expect(constrained.taskType).toBe('claim-issue')
      expect(constrained.reason).toBe('perpetual-drain')
    })

    it('perpetualOnly returns null when no perpetual task is due (app stays throttled)', async () => {
      parseCronToNextRun.mockReturnValue(new Date(Date.now() - 60_000))
      mockSchedule({
        tasks: {
          ...PAUSED_SHIPPED_DRAINS,
          'architecture-maintainability':  { type: 'cron', cronExpression: '0 7 * * *', enabled: true, providerId: null, model: null, prompt: null },
          'error-handling': { type: 'on-demand', enabled: true, providerId: null, model: null, prompt: null }
        }
      })
      const result = await getNextTaskType(null, { perpetualOnly: true })
      expect(result).toBeNull()
    })
  })

  describe('resetExecutionHistory', () => {
    it('should reset global execution history', async () => {
      mockSchedule({
        executions: { 'task:reset-test': { lastRun: '2025-01-01T00:00:00Z', count: 5, perApp: {} } }
      })
      const result = await resetExecutionHistory('reset-test')
      expect(result.success).toBe(true)
    })

    it('should reset per-app execution history', async () => {
      mockSchedule({
        executions: {
          'task:reset-app-test': {
            lastRun: '2025-01-01T00:00:00Z', count: 3,
            perApp: { 'app-1': { lastRun: '2025-01-01T00:00:00Z', count: 2 } }
          }
        }
      })
      const result = await resetExecutionHistory('reset-app-test', 'app-1')
      expect(result.success).toBe(true)
    })
  })

  describe('triggerOnDemandTask', () => {
    beforeEach(() => {
      loadState.mockResolvedValue({ config: { improvementEnabled: true } })
    })

    describe('inputs-unchanged gate (#12907)', () => {
      const HEAD = 'a'.repeat(40)
      const gated = (lastCleanHead) => mockSchedule({
        tasks: { 'data-integrity-safety': { type: 'on-demand', enabled: true } },
        executions: { 'task:data-integrity-safety': { perApp: { 'app-1': { lastRun: null, count: 0, ...(lastCleanHead ? { lastCleanHead } : {}) } } } }
      })
      beforeEach(() => {
        getAppById.mockResolvedValue({ id: 'app-1', repoPath: '/repo' })
        isTaskTypeEnabledForApp.mockResolvedValue(true)
        inputsUnchangedSince.mockReset().mockResolvedValue(true)
      })

      it('declines unattended launches while no declared input changed since the clean baseline, but never a user Run', async () => {
        gated(HEAD)
        const refill = await triggerOnDemandTask('data-integrity-safety', 'app-1', { origin: ON_DEMAND_ORIGINS.REFILL })
        expect(refill).toMatchObject({ reason: 'inputs-unchanged' })
        expect(inputsUnchangedSince).toHaveBeenCalledWith(expect.objectContaining({ repoPath: '/repo', lastCleanHead: HEAD }))
        expect(await triggerOnDemandTask('data-integrity-safety', 'app-1')).toMatchObject({ taskType: 'data-integrity-safety', origin: ON_DEMAND_ORIGINS.USER })
      })

      it('launches when an input changed or no clean baseline exists', async () => {
        gated(HEAD)
        inputsUnchangedSince.mockResolvedValue(false)
        expect(await triggerOnDemandTask('data-integrity-safety', 'app-1', { origin: ON_DEMAND_ORIGINS.REFILL })).toMatchObject({ taskType: 'data-integrity-safety' })
        gated(null)
        inputsUnchangedSince.mockClear()
        expect(await triggerOnDemandTask('data-integrity-safety', 'app-1', { origin: ON_DEMAND_ORIGINS.REFILL })).toMatchObject({ taskType: 'data-integrity-safety' })
        expect(inputsUnchangedSince).not.toHaveBeenCalled()
      })

      it('reports inputs-unchanged from readiness instead of a due cron slot', async () => {
        mockSchedule({
          tasks: { 'data-integrity-safety': { type: 'cron', enabled: true, cronExpression: '* * * * *' } },
          executions: { 'task:data-integrity-safety': { perApp: { 'app-1': { lastRun: null, count: 0, lastCleanHead: HEAD } } } }
        })
        parseCronToNextRun.mockReturnValue(new Date(Date.now() - 1000))
        expect(await shouldRunTask('data-integrity-safety', 'app-1')).toMatchObject({ shouldRun: false, reason: 'inputs-unchanged' })
        inputsUnchangedSince.mockResolvedValue(false)
        expect(await shouldRunTask('data-integrity-safety', 'app-1')).toMatchObject({ shouldRun: true, reason: 'cron-due' })
      })
    })

    it('keeps model research global for both scheduled and manual dispatch', async () => {
      mockSchedule({ tasks: { 'model-comparison-refresh': { type: INTERVAL_TYPES.CRON, cronExpression: '* * * * *', enabled: true } } })
      parseCronToNextRun.mockReturnValue(new Date(Date.now() - 1000))

      expect(await shouldRunTask('model-comparison-refresh', 'app-1')).toMatchObject({ shouldRun: false, reason: 'requires-install-wide-target' })
      expect((await triggerOnDemandTask('model-comparison-refresh', 'app-1')).error).toMatch(/requires an install-wide target/i)
      expect((await getOnDemandRequests()).filter(r => r.taskType === 'model-comparison-refresh')).toHaveLength(0)
      expect((await shouldRunTask('model-comparison-refresh')).shouldRun).toBe(true)
      expect(await triggerOnDemandTask('model-comparison-refresh')).toMatchObject({ taskType: 'model-comparison-refresh', appId: null })
    })

    it('should reject and not persist when master Improve is disabled', async () => {
      mockSchedule({
        tasks: { 'feature-ideas': { type: 'weekly', enabled: true } }
      })
      loadState.mockResolvedValue({ config: { improvementEnabled: false } })

      const result = await triggerOnDemandTask('feature-ideas', 'critical-mass')

      expect(result.error).toMatch(/improvement is disabled/i)
      // Read schedule back: no on-demand request should have been written.
      const schedule = await loadSchedule()
      expect(schedule.onDemandRequests || []).toHaveLength(0)
    })

    it('rejects automated refills when the task type is disabled before reading state', async () => {
      mockSchedule({
        tasks: { 'feature-ideas': { type: 'weekly', enabled: false } }
      })

      const result = await triggerOnDemandTask('feature-ideas', 'app-1', { origin: ON_DEMAND_ORIGINS.REFILL })

      expect(result.error).toMatch(/'feature-ideas' is disabled/i)
      // loadState should not have been called — task-type check short-circuits before loadState.
      expect(loadState).not.toHaveBeenCalled()
    })

    it('rejects a manual run when the task feature is disabled', async () => {
      isInstanceFeatureEnabled.mockResolvedValue(false)
      mockSchedule({ tasks: { 'jira-sprint-manager': { type: INTERVAL_TYPES.ON_DEMAND, enabled: true } } })

      const result = await triggerOnDemandTask('jira-sprint-manager', 'app-1')

      expect(result.error).toMatch(/requires the 'jira' feature/i)
      expect(loadState).not.toHaveBeenCalled()
    })

    it('does not dispatch a queued request after its task feature is disabled', async () => {
      isInstanceFeatureEnabled.mockResolvedValue(false)
      mockSchedule({
        tasks: { 'jira-sprint-manager': { type: INTERVAL_TYPES.ON_DEMAND, enabled: true } },
        onDemandRequests: [{ id: 'demand-existing', taskType: 'jira-sprint-manager', appId: 'app-1' }],
      })

      expect(await getOnDemandRequests()).toEqual([])
    })

    it('should accept a manual run for an enabled on-demand task', async () => {
      mockSchedule({
        tasks: { 'security': { type: INTERVAL_TYPES.ON_DEMAND, enabled: true } }
      })

      const result = await triggerOnDemandTask('security', 'app-1')

      expect(result.error).toBeUndefined()
      expect(result.taskType).toBe('security')
      expect(result.appId).toBe('app-1')
      expect(result.origin).toBe(ON_DEMAND_ORIGINS.USER)
    })

    it('rejects an app-required task without a managed app target', async () => {
      mockSchedule({
        tasks: { 'pr-reviewer': { type: INTERVAL_TYPES.ON_DEMAND, enabled: true } }
      })

      const result = await triggerOnDemandTask('pr-reviewer')

      expect(result.error).toMatch(/requires a managed app target/i)
      expect(recordUserAction).not.toHaveBeenCalled()
      expect((await getOnDemandRequests()).filter(r => r.taskType === 'pr-reviewer')).toHaveLength(0)
    })

    it('carries a targeted PR number onto the queued request', async () => {
      mockSchedule({
        tasks: { 'pr-reviewer': { type: INTERVAL_TYPES.ON_DEMAND, enabled: true } }
      })

      const result = await triggerOnDemandTask('pr-reviewer', 'app-1', { targetPullRequest: 17 })

      expect(result.error).toBeUndefined()
      expect(result.targetPullRequest).toBe(17)
      const queued = (await getOnDemandRequests()).find(r => r.id === result.id)
      expect(queued.targetPullRequest).toBe(17)
    })

    it('drops a non-positive-integer PR target rather than queueing an unusable filter', async () => {
      mockSchedule({
        tasks: { 'pr-reviewer': { type: INTERVAL_TYPES.ON_DEMAND, enabled: true } }
      })

      const result = await triggerOnDemandTask('pr-reviewer', 'app-1', { targetPullRequest: 'all' })

      expect(result.error).toBeUndefined()
      expect('targetPullRequest' in result).toBe(false)
    })

    it('should reject unknown task types instead of silently queuing them', async () => {
      mockSchedule({
        tasks: { 'feature-ideas': { type: 'weekly', enabled: true } }
      })

      const result = await triggerOnDemandTask('not-a-real-type', 'critical-mass')

      expect(result.error).toMatch(/unknown task type 'not-a-real-type'/i)
      expect(loadState).not.toHaveBeenCalled()
    })

    it('should fall back to legacy split flags when improvementEnabled is undefined', async () => {
      mockSchedule({
        tasks: { 'feature-ideas': { type: 'weekly', enabled: true } }
      })
      loadState.mockResolvedValue({
        config: { selfImprovementEnabled: false, appImprovementEnabled: false }
      })

      const result = await triggerOnDemandTask('feature-ideas', 'critical-mass')

      expect(result.error).toMatch(/improvement is disabled/i)
    })

    it('should persist the request and emit event when improvement is enabled', async () => {
      mockSchedule({
        tasks: { 'feature-ideas': { type: 'weekly', enabled: true } }
      })

      const result = await triggerOnDemandTask('feature-ideas', 'critical-mass')

      expect(result.error).toBeUndefined()
      expect(result.taskType).toBe('feature-ideas')
      expect(result.appId).toBe('critical-mass')
      expect(result.id).toMatch(/^demand-/)
    })

    it('allocates distinct receipt IDs for mixed task types within one clock tick', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'))
      mockSchedule({ tasks: {
        security: { type: INTERVAL_TYPES.ON_DEMAND, enabled: true },
        'universe-bible-describe': { type: INTERVAL_TYPES.ON_DEMAND, enabled: true },
      } })

      const agentRequest = await triggerOnDemandTask('security', null, { emit: false })
      const programmaticRequest = await triggerOnDemandTask('universe-bible-describe', null, { emit: false })

      expect(agentRequest.id).toMatch(/^demand-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
      expect(programmaticRequest.id).toMatch(/^demand-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
      expect(agentRequest.id).not.toBe(programmaticRequest.id)
      expect(agentRequest.requestedAt).toBe('2026-01-02T03:04:05.000Z')
      expect(programmaticRequest.requestedAt).toBe(agentRequest.requestedAt)
    })

    it('keeps legacy timestamp receipt IDs cancellable', async () => {
      const legacyRequest = {
        id: 'demand-m5d4ruo0', taskType: 'security', appId: null,
        origin: ON_DEMAND_ORIGINS.USER, requestedAt: '2024-01-01T00:00:00.000Z',
      }
      mockSchedule({ onDemandRequests: [legacyRequest] })

      await expect(clearOnDemandRequest(legacyRequest.id)).resolves.toEqual(legacyRequest)

      const persisted = JSON.parse(writeFile.mock.calls.at(-1)[1])
      expect(persisted.onDemandRequests).toEqual([])
    })

    // The drain's completion refill re-issues itself through this same queue. It
    // must be distinguishable from a human "Run", because the engines clear the
    // park + convergence signature + dispatch counter for a human and MUST NOT for
    // a refill — that reset is what let branch-reconcile re-dispatch all night.
    it('stamps origin: user by default and refill when the drain re-issues itself', async () => {
      mockSchedule({ tasks: { 'branch-reconcile': { type: 'on-demand', perpetual: true, enabled: true } } })
      expect((await triggerOnDemandTask('branch-reconcile', 'app-1')).origin).toBe(ON_DEMAND_ORIGINS.USER)

      mockSchedule({ tasks: { 'branch-reconcile': { type: 'on-demand', perpetual: true, enabled: true } } })
      const refill = await triggerOnDemandTask('branch-reconcile', 'app-1', { emit: false, origin: ON_DEMAND_ORIGINS.REFILL })
      expect(refill.origin).toBe(ON_DEMAND_ORIGINS.REFILL)
    })

    it('queues a perpetual refill with its non-emitting automated origin', async () => {
      mockSchedule({ tasks: { 'branch-reconcile': { type: 'on-demand', perpetual: true, enabled: true } } })

      const refill = await queuePerpetualRefill('branch-reconcile', 'app-1')

      expect(refill).toMatchObject({
        taskType: 'branch-reconcile',
        appId: 'app-1',
        origin: ON_DEMAND_ORIGINS.REFILL,
      })
      expect(cosEvents.emit).not.toHaveBeenCalled()
      expect(recordUserAction).not.toHaveBeenCalled()
    })

    it('replays a cleanup refill without losing or duplicating its durable request', async () => {
      mockSchedule({ tasks: { 'claim-issue': { type: 'on-demand', perpetual: true, enabled: true } } })
      const first = await queuePerpetualRefill('claim-issue', 'app-1', { cleanupSourceAgentId: 'agent-old' })
      let saved = JSON.parse(writeFile.mock.calls.at(-1)[1])
      expect(saved.onDemandRequests).toEqual([expect.objectContaining({ id: first.id, cleanupSourceAgentId: 'agent-old' })])
      expect(saved.swarmCleanupRefillPending['agent-old'].id).toBe(first.id)
      // An interrupted enqueue with no handoff must replay the same request id.
      saved.onDemandRequests = []
      readJSONFile.mockResolvedValue(saved)
      const replay = await queuePerpetualRefill('claim-issue', 'app-1', { cleanupSourceAgentId: 'agent-old' })
      expect(replay).toMatchObject({ id: first.id, alreadyQueued: true })
      saved = JSON.parse(writeFile.mock.calls.at(-1)[1])
      expect(saved.onDemandRequests).toHaveLength(1)
      expect(saved.swarmCleanupRefillPending['agent-old'].id).toBe(first.id)
    })

    it('keeps an accepted refill receipt until its source has been recorded', async () => {
      mockSchedule({ tasks: { 'claim-issue': { type: 'on-demand', perpetual: true, enabled: true } } })
      const first = await queuePerpetualRefill('claim-issue', 'app-1', { cleanupSourceAgentId: 'agent-old' })
      const saved = JSON.parse(writeFile.mock.calls.at(-1)[1])
      saved.onDemandRequests = []
      saved.onDemandHandoffs = { [first.id]: { status: 'accepted' } }
      readJSONFile.mockResolvedValue(saved)
      const replay = await queuePerpetualRefill('claim-issue', 'app-1', { cleanupSourceAgentId: 'agent-old' })
      expect(replay).toMatchObject({ id: first.id, alreadyQueued: true })
      expect(saved.onDemandRequests).toEqual([])
      await acknowledgeSwarmCleanupRefill('agent-old')
      const acknowledged = JSON.parse(writeFile.mock.calls.at(-1)[1])
      expect(acknowledged.swarmCleanupRefillPending['agent-old']).toBeUndefined()
    })

    // Operator-action ledger (#5594). Only a human pressing Run Now is an
    // operator action; the perpetual drain re-issues itself through this same
    // lane, and logging that would fill the ledger with events nobody performed.
    it('records a cos.schedule.trigger row for a human Run Now, and none for a refill', async () => {
      mockSchedule({ tasks: { 'branch-reconcile': { type: 'on-demand', perpetual: true, enabled: true } } })
      const request = await triggerOnDemandTask('branch-reconcile', 'app-1')

      expect(recordUserAction).toHaveBeenCalledTimes(1)
      expect(recordUserAction).toHaveBeenCalledWith(expect.objectContaining({
        type: 'cos.schedule.trigger',
        target: 'branch-reconcile',
        targetName: 'app-1',
        dedupeKey: `cos.schedule.trigger:${request.id}`,
        payload: { taskType: 'branch-reconcile', appId: 'app-1', requestId: request.id },
      }))
      // actor defaults to 'user' in the recorder; the hook must not override it.
      expect(recordUserAction.mock.calls[0][0].actor).toBeUndefined()

      recordUserAction.mockClear()
      mockSchedule({ tasks: { 'branch-reconcile': { type: 'on-demand', perpetual: true, enabled: true } } })
      await triggerOnDemandTask('branch-reconcile', 'app-1', { emit: false, origin: ON_DEMAND_ORIGINS.REFILL })
      expect(recordUserAction).not.toHaveBeenCalled()
    })

    it('records nothing when the trigger is refused', async () => {
      mockSchedule({ tasks: {} })
      expect((await triggerOnDemandTask('unknown-task', 'app-1')).error).toMatch(/unknown/i)
      expect(recordUserAction).not.toHaveBeenCalled()
    })

    // The policy that used to be open-coded in each spawn engine — which is how the
    // loop got in. One home, so the three queue consumers can't drift on it.
    describe('applyOnDemandRunResets', () => {
      const parked = (extra = {}) => ({
        tasks: { 'branch-reconcile': { type: 'on-demand', perpetual: true, enabled: true } },
        executions: { 'task:branch-reconcile': { lastRun: null, count: 0, perApp: {
          'app-1': {
            lastRun: null, count: 0,
            parkedUntil: new Date(Date.now() + 3600000).toISOString(), parkReason: 'no-progress',
            lastActionableSignature: 'a:NEEDS_PR:none', perpetualDispatchCount: 3,
            ...extra
          }
        } } }
      })

      it('clears the drain state for a human "Run" and reports it as user-initiated', async () => {
        mockSchedule(parked())
        expect(await applyOnDemandRunResets({ taskType: 'branch-reconcile', origin: ON_DEMAND_ORIGINS.USER }, 'app-1')).toBe(true)
        const rec = JSON.parse(writeFile.mock.calls.at(-1)[1]).executions['task:branch-reconcile'].perApp['app-1']
        expect(rec.parkedUntil).toBeUndefined()
        expect(rec.lastActionableSignature).toBeUndefined()
        expect(rec.perpetualDispatchCount).toBeUndefined()
      })

      it('clears NOTHING for an automated drain refill — the brakes must survive the hop', async () => {
        mockSchedule(parked())
        expect(await applyOnDemandRunResets({ taskType: 'branch-reconcile', origin: ON_DEMAND_ORIGINS.REFILL }, 'app-1')).toBe(false)
        expect(writeFile).not.toHaveBeenCalled()
      })

      it('clears NOTHING for a quota burn either — it is automation, not a human Run', async () => {
        // A burn that cleared the park would re-run a converged drain every time
        // its window opened, which is the opposite of "invoke this once".
        mockSchedule(parked())
        expect(await applyOnDemandRunResets({ taskType: 'branch-reconcile', origin: ON_DEMAND_ORIGINS.QUOTA_BURN }, 'app-1')).toBe(false)
        expect(writeFile).not.toHaveBeenCalled()
      })

      it('treats a pre-origin request as user-initiated (safe default for a human-filled queue)', async () => {
        mockSchedule(parked())
        expect(await applyOnDemandRunResets({ taskType: 'branch-reconcile' }, 'app-1')).toBe(true)
      })
    })

    // A quota burn asks the schedule to run a task the user already owns. The
    // request has to carry enough to attribute the burn later — acceptance is
    // asynchronous, so nothing else can reconstruct it — and it must face the
    // same invocation-eligibility gate a human Run does.
    describe('quota-burn origin', () => {
      // `overrides.params` rides along because a migrated issues-only step pins
      // `fileIssues` there, and the generator has to see it BEFORE it renders the
      // prompt (#6381).
      const burn = { family: 'grok', stepId: 'step-1', limitingResetAt: 1700000000000, overrides: { providerId: 'grok-tui', model: null, effort: null, params: { fileIssues: true } } }
      const trigger = (options) => triggerOnDemandTask('security', null, { emit: false, origin: ON_DEMAND_ORIGINS.QUOTA_BURN, ...options })

      it('persists the burn provenance on the queued request', async () => {
        mockSchedule({ tasks: { security: { type: 'on-demand', enabled: true } } })
        const request = await trigger({ burn })
        expect(request.origin).toBe(ON_DEMAND_ORIGINS.QUOTA_BURN)
        expect(request.burn).toEqual(burn)
        // And it survives the write, so an engine draining it after a restart
        // still knows which family and step to credit.
        const written = JSON.parse(writeFile.mock.calls.at(-1)[1]).onDemandRequests.at(-1)
        expect(written.burn).toEqual(burn)
      })

      it('refuses a burn request that cannot be attributed, before touching the schedule', async () => {
        mockSchedule({ tasks: { security: { type: 'on-demand', enabled: true } } })
        expect((await trigger({ burn: { family: 'grok' } })).error).toMatch(/must name the burning family and its burn step/)
        expect(writeFile).not.toHaveBeenCalled()
      })

      it('is not written to the operator-action ledger', async () => {
        mockSchedule({ tasks: { security: { type: 'on-demand', enabled: true } } })
        await trigger({ burn })
        expect(recordUserAction).not.toHaveBeenCalled()
      })

      it('faces the same gates a human Run does', async () => {
        mockSchedule({ tasks: { security: { type: 'on-demand', enabled: false } } })
        expect((await trigger({ burn })).error).toMatch(/disabled/i)
        mockSchedule({ tasks: { security: { type: 'on-demand', enabled: true } } })
        expect((await triggerOnDemandTask('not-a-task', null, { emit: false, origin: ON_DEMAND_ORIGINS.QUOTA_BURN, burn })).error)
          .toMatch(/Unknown task type/)
      })

      // The invocation-eligibility gate is the one that cannot be exercised
      // behaviorally: `TASK_TYPE_INVOCATION` is deliberately empty today, so no
      // shipped type is subsidiary and there is nothing to refuse. The rule still
      // has to hold the day one is added, and the failure mode is silent — an
      // unattended burn commandeering a task another automation owns — so the
      // shape is pinned here. Only REFILL (that automation re-issuing itself) is
      // exempt; a burn is gated exactly like a human Run.
      it('exempts only a drain refill from the invocation-eligibility gate', async () => {
        // `fs` is doubled for this suite, so read through the real one.
        const { readFileSync } = await vi.importActual('node:fs')
        const src = readFileSync(new URL('./taskSchedule.js', import.meta.url), 'utf8')
        // The rung itself lives in `evaluateOnDemandEligibility`; what this file
        // still owns is which origins are exempt, so that is what is pinned.
        expect(src).toMatch(/eligible: origin === ON_DEMAND_ORIGINS\.REFILL \|\| getTaskTypeInvocation\(taskType\)\.userInvokable !== false/)
        // Probe: the previous, narrower gate must be gone, or the assertion above
        // could pass on a file that still only checks USER somewhere else.
        expect(src).not.toMatch(/origin === ON_DEMAND_ORIGINS\.USER && !invocation\.userInvokable/)
      })
    })

    it('isRefillRequest only matches an explicit refill origin', () => {
      expect(isRefillRequest({ origin: ON_DEMAND_ORIGINS.REFILL })).toBe(true)
      expect(isRefillRequest({ origin: ON_DEMAND_ORIGINS.USER })).toBe(false)
      // A request queued before `origin` existed reads as user-initiated — the safe
      // default for a queue that is otherwise human-filled.
      expect(isRefillRequest({ taskType: 'branch-reconcile' })).toBe(false)
      expect(isRefillRequest(null)).toBe(false)
    })
  })

  describe('getScheduleStatus', () => {
    it('reports the configured schedule with no learning adjustment fields', async () => {
      mockSchedule({ tasks: { security: { type: 'cron', cronExpression: '* * * * *', intervalMs: 60000, enabled: true } } })
      const status = await getScheduleStatus()
      expect(status.tasks.security.intervalMs).toBe(60000)
      expect(Object.keys(status.tasks.security).filter(k => k.startsWith('learning'))).toEqual([])
      expect(status.tasks.security).not.toHaveProperty('adjustedIntervalMs')
    })

    it('shows a legacy global execution with no per-app history and accepts its first app run', async () => {
      mockSchedule({ executions: { 'task:security': { lastRun: null, count: 3 } } })
      const status = await getScheduleStatus()
      expect(status.tasks.security).toMatchObject({ globalRunCount: 3, perAppCount: 0 })
      const execution = await recordExecution('security', 'app-1')
      expect(execution).toMatchObject({ count: 4, perApp: { 'app-1': { count: 1 } } })
    })

    it('refreshes missing inventory in the schedule response and persists current rows', async () => {
      const row = { branch: 'fix/example', path: '/example/gone', head: 'a'.repeat(40), reason: 'checkout-retained' };
      mockSchedule({ executions: { 'task:branch-reconcile': { perApp: { 'app-1': { branchReconcileOutcome: { status: 'incomplete', remaining: [row] } } } } } });
      getAppById.mockResolvedValue({ id: 'app-1', repoPath: '/example' });
      reconcileInventoryRows.mockResolvedValueOnce([]);
      const status = await annotateMissingCheckouts(await getScheduleStatus());
      expect(status.tasks['branch-reconcile'].reconcileOutcomes['app-1'].remaining).toEqual([]);
      expect((await getBranchReconcileOutcome('app-1')).remaining).toEqual([]);
    });

    beforeEach(() => {
      loadState.mockResolvedValue({ config: { improvementEnabled: true } })
    })

    it('should include improvementEnabled: true when master flag is on', async () => {
      mockSchedule({ tasks: { 'security': { type: 'weekly', enabled: true } } })

      const status = await getScheduleStatus()

      expect(status.improvementEnabled).toBe(true)
    })

    it('should include improvementEnabled: false when master flag is off', async () => {
      mockSchedule({ tasks: { 'security': { type: 'weekly', enabled: true } } })
      loadState.mockResolvedValue({ config: { improvementEnabled: false } })

      const status = await getScheduleStatus()

      expect(status.improvementEnabled).toBe(false)
    })

    it('upgrades audit presentation without renaming stored schedule identities', async () => {
      mockSchedule({ tasks: { security: { type: 'on-demand', enabled: false, labels: ['backend'], description: 'Custom summary' } } })
      const status = await getScheduleStatus()
      expect(status.tasks.security).toMatchObject({ displayName: 'better-security', labels: ['backend'], description: 'Custom summary', enabled: false })
      expect(status.tasks.security.defaultLabels).toEqual(expect.arrayContaining(['slashdo', 'codebase-improvement', 'security']))
      expect(status.tasks['better-security']).toBeUndefined()
      expect(status.tasks['code-simplification'].suggestedAfter).toEqual(['architecture-maintainability', 'feature-completeness'])
      expect(status.tasks['code-simplification'].runGuidance).toContain('Simplify code')
      expect(status.tasks['claim-issue']).toMatchObject({ displayName: 'claim-issue', defaultLabels: [] })
      expect(status.tasks['music-video-autopilot']).toMatchObject({ displayName: 'Autonomous run' })
    })

    it('distinguishes task-local settings from the task’s shipped defaults', async () => {
      mockSchedule({ tasks: {
        'claim-issue': {
          type: 'on-demand',
          enabled: true,
          taskMetadata: { issueAuthorFilter: 'self', issueExcludeLabels: ['manual-review'], simplify: false },
        },
        'code-simplification': {
          type: 'on-demand',
          enabled: true,
          suggestedAfter: [],
        },
      } });

      const { tasks } = await getScheduleStatus();
      expect(tasks['claim-issue'].globalOverrideFields).toEqual(expect.arrayContaining([
        'taskMetadata.issueExcludeLabels', 'taskMetadata.simplify',
      ]));
      expect(tasks['claim-issue'].globalOverrideFields).not.toContain('taskMetadata.issueAuthorFilter');
      expect(tasks['code-simplification'].globalOverrideFields).toContain('suggestedAfter');
    });

    it('projects task summaries and explains hook-owned prompts', async () => {
      mockSchedule()

      const status = await getScheduleStatus()

      expect(status.tasks['issue-watcher']).toMatchObject({
        description: TASK_TYPE_DESCRIPTIONS['issue-watcher'],
        promptMode: 'runtime-generated',
        promptDescription: expect.stringContaining('Three enforced server phases'),
        invocation: { kind: 'direct', visibility: 'visible', userInvokable: true },
      })
      expect(status.tasks.security).toMatchObject({
        description: TASK_TYPE_DESCRIPTIONS.security,
        promptMode: 'template',
        invocation: { kind: 'direct', visibility: 'visible', userInvokable: true },
      })
    })

    it('keeps subsidiary-task visibility explicit instead of inferring it from task names', () => {
      expect(Object.keys(TASK_TYPE_INVOCATION)).toEqual([])
      for (const taskType of SELF_IMPROVEMENT_TASK_TYPES) {
        expect(getTaskTypeInvocation(taskType), taskType).toEqual({
          kind: 'direct', visibility: 'visible', userInvokable: true
        })
      }
    })

    it('hides shipped tasks whose required instance feature is disabled', async () => {
      isInstanceFeatureEnabled.mockResolvedValue(false)
      mockSchedule({ tasks: { 'jira-sprint-manager': { type: INTERVAL_TYPES.ON_DEMAND, enabled: true } } })

      const status = await getScheduleStatus()

      expect(status.tasks).not.toHaveProperty('jira-sprint-manager')
      expect(status.tasks).not.toHaveProperty('jira-status-report')
    })
  })
})

// The code-quality lane's ranked triage output lives beside its execution
// record and surfaces on the Schedule card (#12085).
describe('recordRecommendedAudits', () => {
  it('stores the ranked list on the execution record and exposes it on schedule status', async () => {
    mockSchedule({ tasks: {}, executions: { 'task:architecture-maintainability': { lastRun: '2026-10-01T00:00:00Z', count: 2, perApp: {} } } })
    const recorded = await recordRecommendedAudits('architecture-maintainability', 'app-1', [
      'better-structural-drift — drifted registries: server/lib/navManifest.js',
      'ux — buried primary action: client/src/pages/Apps.jsx',
    ])
    expect(recorded).toMatchObject({ appId: 'app-1', items: [expect.stringContaining('better-structural-drift'), expect.stringContaining('ux —')] })
    expect(Date.parse(recorded.at)).toBeGreaterThan(0)
    const history = (await loadSchedule()).executions['task:architecture-maintainability']
    expect(history.count).toBe(2)
    expect(history.recommendedAudits.items).toHaveLength(2)
    const status = await getScheduleStatus()
    expect(status.tasks['architecture-maintainability'].recommendedAudits).toEqual(history.recommendedAudits)
    expect(status.tasks['security'].recommendedAudits).toBeNull()
  })

  it('keeps the previous recommendation when a run produced none', async () => {
    const previous = { at: '2026-10-01T00:00:00Z', appId: 'app-1', items: ['ux — one'] }
    mockSchedule({ tasks: {}, executions: { 'task:architecture-maintainability': { lastRun: '2026-10-01T00:00:00Z', count: 1, perApp: {}, recommendedAudits: previous } } })
    expect(await recordRecommendedAudits('architecture-maintainability', 'app-1', [])).toBeNull()
    expect((await loadSchedule()).executions['task:architecture-maintainability'].recommendedAudits).toEqual(previous)
  })
})
