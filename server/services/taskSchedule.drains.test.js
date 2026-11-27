import { mockSchedule, PAUSED_SHIPPED_DRAINS, cronDueNow, cronNotDueYet, installScheduleHooks } from './taskSchedule.test.fixture.js';
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  updateTaskInterval,
  shouldRunTask,
  shouldContinuePerpetualDrain,
  getDueTasks,
  getNextTaskType,
  getUpcomingTasks,
  getScheduleStatus,
  computePerpetualRecheckAt,
  parkPerpetual,
  resetPerpetualForManualRun,
  getPerpetualParkInfo,
  recordPerpetualStall,
  isPerpetualParkActive,
  getPerpetualDrainState,
  recordPerpetualDispatch,
  recordTaskTypeFailure,
  recordTaskTypeSuccess,
  boundParkedUntil,
} from './taskSchedule.js';
import { clearTaskTypeFailurePark, computeFailureBackoffMs, FAILURE_BACKOFF_BASE_MS, FAILURE_BACKOFF_CAP_MS, FAILURE_PARK_THRESHOLD } from './taskScheduleBackoff.js';
import {
  getBranchReconcileOutcome,
  recordBranchReconcileOutcome,
  recordHeldCheckoutRetirement,
  recordWorkspaceCheckoutRetirement,
} from './branchReconcileOutcome.js';
import { cosEvents, emitLog } from './cos/cosEvents.js'
import { readJSONFile } from '../lib/fileUtils.js'
import { writeFile } from 'fs/promises'
import {
  isTaskTypeEnabledForApp,
  getAppById,
  getAppTaskTypeInterval,
  getAppTaskTypeOverrides,
  getActiveApps,
} from './apps.js';
import { getLocalParts } from '../lib/timezone.js'
import { parseCronToNextRun } from './eventScheduler.js'
import { addNotification, exists as notificationExists, removeByMetadata } from './notifications.js'

describe('taskSchedule', () => {
  installScheduleHooks();

  describe('perpetual (drain-until-done)', () => {
    describe('computePerpetualRecheckAt', () => {
      it('uses recheckIntervalMs when no cron is set', async () => {
        const at = await computePerpetualRecheckAt({ recheckIntervalMs: 3600000 }, 0)
        expect(at).toBe(new Date(3600000).toISOString())
      })

      it('defaults to a daily (24h) recheck when nothing is configured', async () => {
        const at = await computePerpetualRecheckAt({}, 0)
        expect(at).toBe(new Date(24 * 60 * 60 * 1000).toISOString())
      })

      it('prefers a 5-field recheckCron over the interval', async () => {
        const cronNext = new Date('2999-01-02T09:00:00.000Z')
        parseCronToNextRun.mockReturnValue(cronNext)
        const at = await computePerpetualRecheckAt({ recheckCron: '0 9 * * *', recheckIntervalMs: 1000 }, 0)
        expect(at).toBe(cronNext.toISOString())
        expect(parseCronToNextRun).toHaveBeenCalled()
      })

      it('falls back to the interval when recheckCron is not a 5-field expression', async () => {
        const at = await computePerpetualRecheckAt({ recheckCron: 'not-a-cron', recheckIntervalMs: 5000 }, 0)
        expect(at).toBe(new Date(5000).toISOString())
      })
    })

    describe('shouldRunTask', () => {
      it('is due (drain) when enabled and not parked', async () => {
        mockSchedule({ tasks: { 'claim-issue': { type: 'on-demand', perpetual: true, enabled: true } } })
        const result = await shouldRunTask('claim-issue')
        expect(result.shouldRun).toBe(true)
        expect(result.reason).toBe('perpetual-drain')
      })

      it('is NOT due while parked in the future', async () => {
        const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
        mockSchedule({
          tasks: { 'claim-issue': { type: 'on-demand', perpetual: true, enabled: true } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: {}, parkedUntil: future, parkReason: 'no-actionable-issues', parkActionableCount: 0 } }
        })
        const result = await shouldRunTask('claim-issue')
        expect(result.shouldRun).toBe(false)
        expect(result.reason).toBe('perpetual-parked')
        expect(result.nextRunAt).toBe(future)
        expect(result.parkReason).toBe('no-actionable-issues')
      })

      it('becomes due again (recheck) once the park elapses', async () => {
        const past = new Date(Date.now() - 60 * 1000).toISOString()
        mockSchedule({
          tasks: { 'claim-issue': { type: 'on-demand', perpetual: true, enabled: true } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: {}, parkedUntil: past } }
        })
        const result = await shouldRunTask('claim-issue')
        expect(result.shouldRun).toBe(true)
        expect(result.reason).toBe('perpetual-recheck')
      })

      it('reads per-app park state', async () => {
        isTaskTypeEnabledForApp.mockResolvedValue(true)
        const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
        mockSchedule({
          tasks: { 'claim-issue': { type: 'on-demand', perpetual: true, enabled: true } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: { 'app-1': { lastRun: null, count: 0, parkedUntil: future } } } }
        })
        const result = await shouldRunTask('claim-issue', 'app-1')
        expect(result.shouldRun).toBe(false)
        expect(result.reason).toBe('perpetual-parked')
      })
    })

    describe('shouldContinuePerpetualDrain', () => {
      it('only continues an explicitly started manual drain and never schedules its recheck', async () => {
        mockSchedule({ tasks: {
          ...PAUSED_SHIPPED_DRAINS,
          'claim-issue': { type: 'on-demand', perpetual: true, autoStart: false, enabled: true }
        } })
        expect(await shouldRunTask('claim-issue')).toMatchObject({ shouldRun: false, reason: 'on-demand-only' })
        expect(await shouldContinuePerpetualDrain('claim-issue')).toMatchObject({ shouldRun: true, reason: 'perpetual-drain' })
        expect(await getDueTasks()).not.toEqual(expect.arrayContaining([expect.objectContaining({ taskType: 'claim-issue' })]))
        expect(await getDueTasks(null, { continuingTaskType: 'claim-issue' })).toEqual(expect.arrayContaining([expect.objectContaining({ taskType: 'claim-issue' })]))
        await parkPerpetual('claim-issue', null, { reason: 'no-actionable-work', actionableCount: 0 })
        expect(await shouldContinuePerpetualDrain('claim-issue')).toMatchObject({ shouldRun: false, reason: 'perpetual-parked' })
        expect(await getUpcomingTasks()).not.toEqual(expect.arrayContaining([expect.objectContaining({ taskType: 'claim-issue' })]))
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 86400000)
        expect(await shouldRunTask('claim-issue')).toMatchObject({ shouldRun: false, reason: 'on-demand-only' })
        vi.restoreAllMocks()
      })

      it('does not force a non-perpetual task past its normal cadence', async () => {
        cronNotDueYet()
        mockSchedule({
          tasks: {
            ...PAUSED_SHIPPED_DRAINS,
            security: { type: 'cron', cronExpression: '0 7 * * *', enabled: true }
          }
        })

        expect(await shouldContinuePerpetualDrain('security'))
          .toMatchObject({ shouldRun: false, reason: 'cron-cooldown' })
      })

      it('keeps continuation behind feature and runAfter gates', async () => {
        cronNotDueYet()
        const featureEnabled = vi.fn().mockResolvedValue(false)
        mockSchedule({
          tasks: {
            // Feature ownership comes from the task registry, not stored overrides.
            'jira-sprint-manager': {
              type: 'cron', cronExpression: '0 7 * * *', perpetual: true,
              enabled: true
            }
          }
        })

        expect(await shouldContinuePerpetualDrain('jira-sprint-manager', null, { featureEnabled }))
          .toEqual({ shouldRun: false, reason: 'feature-disabled', feature: 'jira' })

        featureEnabled.mockResolvedValue(true)
        mockSchedule({
          tasks: {
            'claim-issue': {
              type: 'cron', cronExpression: '0 7 * * *', perpetual: true,
              enabled: true, runAfter: ['security']
            },
            security: { type: 'cron', cronExpression: '0 6 * * *', enabled: true }
          },
          executions: {
            'task:claim-issue': { lastRun: new Date().toISOString(), count: 1, perApp: {} },
            'task:security': { lastRun: null, count: 0, perApp: {} }
          }
        })
        expect(await shouldContinuePerpetualDrain('claim-issue', null, { featureEnabled }))
          .toEqual({ shouldRun: false, reason: 'waiting-on-dependencies', pendingDeps: ['security'] })
      })
    })

    describe('getNextTaskType', () => {
      it('picks a draining perpetual task when no cron task is due', async () => {
        cronNotDueYet()
        mockSchedule({
          tasks: {
            ...PAUSED_SHIPPED_DRAINS,
            'claim-issue': { type: 'on-demand', perpetual: true, enabled: true },
            'security': { type: 'cron', cronExpression: '0 7 * * *', enabled: true }
          }
        })
        const next = await getNextTaskType()
        expect(next.taskType).toBe('claim-issue')
        expect(next.reason).toBe('perpetual-drain')
      })

      it('does not pick a parked perpetual task — yields to the due cron task', async () => {
        cronDueNow()
        const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
        mockSchedule({
          tasks: {
            ...PAUSED_SHIPPED_DRAINS,
            'claim-issue': { type: 'on-demand', perpetual: true, enabled: true },
            'security': { type: 'cron', cronExpression: '0 7 * * *', enabled: true }
          },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: {}, parkedUntil: future } }
        })
        const next = await getNextTaskType()
        expect(next.taskType).toBe('security')
      })

      it('a cron+perpetual task parks on its own expression and stays out of the pick', async () => {
        cronDueNow()
        const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
        mockSchedule({
          tasks: {
            ...PAUSED_SHIPPED_DRAINS,
            'claim-issue': { type: 'cron', cronExpression: '0 7 * * *', perpetual: true, enabled: true }
          },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: {}, parkedUntil: future } }
        })
        // The cron slot is due, but the park outranks it — the drain is idle.
        expect(await shouldRunTask('claim-issue')).toMatchObject({ shouldRun: false, reason: 'perpetual-parked' })
        expect(await getNextTaskType()).toBeNull()
      })

      it('continues only the completed cron drain after its initiating slot is consumed', async () => {
        cronNotDueYet()
        mockSchedule({
          tasks: {
            ...PAUSED_SHIPPED_DRAINS,
            'claim-issue': { type: 'cron', cronExpression: '0 7 * * *', perpetual: true, enabled: true },
            security: { type: 'cron', cronExpression: '0 7 * * *', enabled: true }
          },
          executions: { 'task:claim-issue': { lastRun: new Date().toISOString(), count: 1, perApp: {} } }
        })
        expect(await shouldRunTask('claim-issue')).toMatchObject({ shouldRun: false, reason: 'cron-cooldown' })
        expect(await shouldContinuePerpetualDrain('claim-issue'))
          .toEqual({ shouldRun: true, reason: 'perpetual-drain' })
        expect(await getNextTaskType()).toBeNull()
        expect(await getNextTaskType(null, { continuingTaskType: 'security' })).toBeNull()
        expect(await getNextTaskType(null, { continuingTaskType: 'claim-issue', perpetualOnly: true }))
          .toEqual({ taskType: 'claim-issue', reason: 'perpetual-drain' })
      })

      it.each(['parkedUntil', 'failureParkedAt'])('keeps continuation behind %s', async (field) => {
        cronNotDueYet()
        mockSchedule({
          tasks: {
            ...PAUSED_SHIPPED_DRAINS,
            'claim-issue': { type: 'cron', cronExpression: '0 7 * * *', perpetual: true, enabled: true }
          },
          executions: { 'task:claim-issue': {
            lastRun: new Date().toISOString(), count: 1, perApp: {},
            [field]: new Date(Date.now() + 3600000).toISOString()
          } }
        })
        expect(await getNextTaskType(null, { continuingTaskType: 'claim-issue' })).toBeNull()
      })

      it('an ELAPSED park makes a cron+perpetual task due immediately, without waiting for the next slot', async () => {
        cronNotDueYet()
        const past = new Date(Date.now() - 60 * 1000).toISOString()
        mockSchedule({
          tasks: {
            ...PAUSED_SHIPPED_DRAINS,
            'claim-issue': { type: 'cron', cronExpression: '0 7 * * *', perpetual: true, enabled: true }
          },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: {}, parkedUntil: past } }
        })
        expect(await shouldRunTask('claim-issue')).toMatchObject({ shouldRun: true, reason: 'perpetual-recheck' })
      })
    })

    // Perpetual tasks park PER-APP, so the global shouldRunTask always reads
    // 'perpetual-drain'. getUpcomingTasks must instead surface the per-app recheck
    // boundary as a 'scheduled' upcoming task — otherwise scheduleNextImprovementCheck
    // (which only shortens its wake-up for 'scheduled' tasks) never wakes the daemon
    // at the recheck cadence (e.g. a 9am recheckCron), and the parked drain resumes
    // only on the ≤1h fallback poll.
    describe('getUpcomingTasks — perpetual recheck boundary', () => {
      it('reports a perpetual task PARKED on every app as scheduled at the soonest recheck', async () => {
        // Clock frozen (#3693): this case compares two ABSOLUTE park timestamps,
        // so on a real clock its verdict depended on when the suite ran — the
        // next 9am is >30m out at 10am but only 15m out at 08:45, which flips
        // which park is soonest and fails the assertion below.
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T12:00:00Z'))
        const nineAm = new Date('2026-01-02T09:00:00Z') // next 9am (future, well past `soon`)
        const soon = new Date(Date.now() + 30 * 60 * 1000).toISOString() // 30m out
        mockSchedule({
          tasks: { 'claim-issue': { type: 'on-demand', perpetual: true, enabled: true, recheckCron: '0 9 * * *' } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: {
            'app-1': { lastRun: null, count: 0, parkedUntil: nineAm.toISOString() },
            'app-2': { lastRun: null, count: 0, parkedUntil: soon }
          } } }
        })
        const upcoming = await getUpcomingTasks(50)
        const claim = upcoming.find(t => t.taskType === 'claim-issue')
        expect(claim).toBeTruthy()
        expect(claim.status).toBe('scheduled')
        // Soonest of the two per-app parks (app-2, 30m out).
        expect(claim.eligibleAt).toBe(new Date(soon).getTime())
        expect(claim.eligibleIn).toBeGreaterThan(0)
      })

      it('reports the perpetual task ready when any app park has already elapsed', async () => {
        const past = new Date(Date.now() - 60 * 1000).toISOString()
        const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
        mockSchedule({
          tasks: { 'claim-issue': { type: 'on-demand', perpetual: true, enabled: true, recheckCron: '0 9 * * *' } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: {
            'app-1': { lastRun: null, count: 0, parkedUntil: past },   // recheck due now
            'app-2': { lastRun: null, count: 0, parkedUntil: future }
          } } }
        })
        const upcoming = await getUpcomingTasks(50)
        const claim = upcoming.find(t => t.taskType === 'claim-issue')
        expect(claim.status).toBe('ready')
        expect(claim.eligibleIn).toBeLessThanOrEqual(0)
      })

      it('treats an app mid-drain (park cleared) as ready even if a sibling app is parked', async () => {
        const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
        mockSchedule({
          tasks: { 'claim-issue': { type: 'on-demand', perpetual: true, enabled: true } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: {
            'app-1': { lastRun: null, count: 0 },                      // no park → draining
            'app-2': { lastRun: null, count: 0, parkedUntil: future }
          } } }
        })
        const upcoming = await getUpcomingTasks(50)
        const claim = upcoming.find(t => t.taskType === 'claim-issue')
        expect(claim.status).toBe('ready')
      })

      it('keeps the global ready default for a never-run perpetual task (no per-app records)', async () => {
        mockSchedule({ tasks: { 'claim-issue': { type: 'on-demand', perpetual: true, enabled: true } } })
        const upcoming = await getUpcomingTasks(50)
        const claim = upcoming.find(t => t.taskType === 'claim-issue')
        expect(claim.status).toBe('ready')
      })
    })

    describe('getUpcomingTasks — per-app cron overrides', () => {
      it.each([false, true])('preserves a future deadline alongside a ready app (reverse=%s)', async (reverse) => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T16:00:00Z'))
        const actual = await vi.importActual('./eventScheduler.js')
        const actualTimezone = await vi.importActual('../lib/timezone.js')
        parseCronToNextRun.mockImplementation(actual.parseCronToNextRun)
        getLocalParts.mockImplementation(actualTimezone.getLocalParts)
        const apps = [{ id: 'ready' }, { id: 'future' }]
        getActiveApps.mockResolvedValueOnce(reverse ? apps.reverse() : apps)
        const cron = id => id === 'ready' ? '0 8 * * *' : '5 8 * * *'
        for (const app of apps) {
          getAppTaskTypeInterval.mockResolvedValueOnce(cron(app.id))
          getAppTaskTypeOverrides.mockResolvedValueOnce({
            'do-release': { enabled: true, interval: cron(app.id) }
          })
        }
        mockSchedule({ tasks: { 'do-release': { type: 'on-demand', enabled: true, runAfter: [] } } })
        const upcoming = await getUpcomingTasks(50)
        expect(upcoming.find(t => t.taskType === 'do-release')).toMatchObject({
          status: 'ready', nextScheduledAt: new Date('2026-01-01T16:05:00Z').getTime()
        })
      })

      it('surfaces an enabled app cron boundary even when the global task is on-demand', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T16:00:00Z')) // 08:00 in the mocked America/Los_Angeles zone
        const actual = await vi.importActual('./eventScheduler.js')
        const actualTimezone = await vi.importActual('../lib/timezone.js')
        parseCronToNextRun.mockImplementation(actual.parseCronToNextRun)
        getLocalParts.mockImplementation(actualTimezone.getLocalParts)
        getActiveApps.mockResolvedValueOnce([{ id: 'app-1', name: 'Acme' }])
        isTaskTypeEnabledForApp.mockResolvedValueOnce(true)
        getAppTaskTypeInterval.mockResolvedValueOnce('15 9 * * *')
        getAppTaskTypeOverrides.mockResolvedValueOnce({
          'do-release': { enabled: true, interval: '15 9 * * *' }
        })
        mockSchedule({
          tasks: { 'do-release': { type: 'on-demand', enabled: true, runAfter: [] } }
        })
        const upcoming = await getUpcomingTasks(50)
        const release = upcoming.find(t => t.taskType === 'do-release')

        expect(release).toMatchObject({
          status: 'scheduled',
          eligibleAt: new Date('2026-01-01T17:15:00Z').getTime()
        })
      })
    })

    // #7527: a rejected app inventory/override/readiness read used to be
    // swallowed into [] / {} / null, which read as "no apps configured" or
    // "not ready" rather than "the calculation is unavailable" — hiding the
    // failure from cosJobScheduler.scheduleNextImprovementCheck (which then
    // armed its 1h fallback and could sleep through a cron minute). Assert
    // the rejection now propagates out of getUpcomingTasks instead.
    describe('getUpcomingTasks — propagates input failures instead of swallowing them (#7527)', () => {
      it('propagates a rejected active-apps read instead of treating it as no apps', async () => {
        getActiveApps.mockRejectedValueOnce(new Error('app inventory unavailable'))
        mockSchedule({ tasks: { 'do-release': { type: 'on-demand', enabled: true, runAfter: [] } } })
        await expect(getUpcomingTasks(50)).rejects.toThrow('app inventory unavailable')
      })

      it('propagates a rejected app-override read instead of treating it as no overrides', async () => {
        getActiveApps.mockResolvedValueOnce([{ id: 'app-1', name: 'Acme' }])
        getAppTaskTypeOverrides.mockRejectedValueOnce(new Error('app overrides unavailable'))
        mockSchedule({ tasks: { 'do-release': { type: 'on-demand', enabled: true, runAfter: [] } } })
        await expect(getUpcomingTasks(50)).rejects.toThrow('app overrides unavailable')
      })

      it('propagates a rejected per-app readiness read instead of treating the app as not-ready', async () => {
        getActiveApps.mockResolvedValueOnce([{ id: 'app-1', name: 'Acme' }])
        getAppTaskTypeOverrides.mockResolvedValueOnce({
          'do-release': { enabled: true, interval: '15 9 * * *' }
        })
        isTaskTypeEnabledForApp.mockRejectedValueOnce(new Error('app readiness unavailable'))
        mockSchedule({ tasks: { 'do-release': { type: 'on-demand', enabled: true, runAfter: [] } } })
        await expect(getUpcomingTasks(50)).rejects.toThrow('app readiness unavailable')
      })
    })

    describe('getScheduleStatus — appSchedules', () => {
      it('rejects an unavailable registry and recovers with a valid empty registry', async () => {
        mockSchedule({ tasks: { 'do-release': { type: 'on-demand', enabled: true, runAfter: [] } } })
        getActiveApps.mockRejectedValueOnce(new Error('app registry unavailable'))

        await expect(getScheduleStatus()).rejects.toThrow('app registry unavailable')

        getActiveApps.mockResolvedValue([])
        const task = (await getScheduleStatus()).tasks['do-release']
        expect(task).toMatchObject({ totalAppCount: 0, enabledAppCount: 0, appOverrides: {}, appSchedules: [] })
        expect(task.status).toMatchObject({ shouldRun: false, reason: 'on-demand-only' })
      })

      it('rejects unavailable app cadence instead of reporting a not-due row, then recovers', async () => {
        await withRealCron()
        getActiveApps.mockResolvedValue([{ id: 'app-1', name: 'Example App' }])
        getAppTaskTypeOverrides.mockResolvedValue({ 'do-release': { enabled: true, interval: '15 9 * * *' } })
        getAppTaskTypeInterval.mockRejectedValueOnce(new Error('app cadence unavailable'))
        mockSchedule({ tasks: { 'do-release': { type: 'on-demand', enabled: true, runAfter: [] } } })

        await expect(getScheduleStatus()).rejects.toThrow('app cadence unavailable')

        getAppTaskTypeInterval.mockResolvedValue('15 9 * * *')
        expect((await getScheduleStatus()).tasks['do-release'].appSchedules).toEqual([
          expect.objectContaining({ appId: 'app-1', nextRunAt: '2026-01-01T17:15:00.000Z', reason: 'cron-cooldown' })
        ])
      })

      // vi.clearAllMocks() keeps a mockResolvedValue, so these cases restore the
      // apps.js factory defaults rather than leaking an app roster into the
      // suites that follow.
      afterEach(() => {
        vi.useRealTimers()
        isTaskTypeEnabledForApp.mockResolvedValue(true)
        getAppTaskTypeInterval.mockResolvedValue(null)
        getActiveApps.mockResolvedValue([])
        getAppTaskTypeOverrides.mockResolvedValue({})
      })

      const withRealCron = async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T16:00:00Z')) // 08:00 in the mocked America/Los_Angeles zone
        const actual = await vi.importActual('./eventScheduler.js')
        const actualTimezone = await vi.importActual('../lib/timezone.js')
        parseCronToNextRun.mockImplementation(actual.parseCronToNextRun)
        getLocalParts.mockImplementation(actualTimezone.getLocalParts)
      }

      // The reported bug: a task left on-demand globally while one app puts it
      // on a cron read as "manual trigger only" everywhere, and the Schedule
      // Timeline dropped it into the unpinned bucket.
      it('lists an app cron on a task that is on-demand globally, with that app\'s next slot', async () => {
        await withRealCron()
        getActiveApps.mockResolvedValue([{ id: 'app-1', name: 'Acme' }])
        isTaskTypeEnabledForApp.mockResolvedValue(true)
        getAppTaskTypeInterval.mockResolvedValue('15 9 * * *')
        getAppTaskTypeOverrides.mockResolvedValue({ 'do-release': { enabled: true, interval: '15 9 * * *' } })
        mockSchedule({ tasks: { 'do-release': { type: 'on-demand', enabled: true, runAfter: [] } } })

        const status = await getScheduleStatus()
        expect(getAppTaskTypeOverrides).toHaveBeenCalledTimes(1)
        expect(status.tasks['do-release'].appSchedules).toEqual([{
          appId: 'app-1',
          appName: 'Acme',
          cronExpression: '15 9 * * *',
          nextRunAt: '2026-01-01T17:15:00.000Z',
          shouldRun: false,
          reason: 'cron-cooldown',
          missedSlot: null
        }])
      })

      it('omits an app that merely inherits the global cadence', async () => {
        await withRealCron()
        getActiveApps.mockResolvedValue([{ id: 'app-1', name: 'Acme' }])
        isTaskTypeEnabledForApp.mockResolvedValue(true)
        getAppTaskTypeInterval.mockResolvedValue(null)
        getAppTaskTypeOverrides.mockResolvedValue({ 'do-release': { enabled: true } })
        mockSchedule({ tasks: { 'do-release': { type: 'cron', cronExpression: '15 9 * * *', enabled: true, runAfter: [] } } })

        expect((await getScheduleStatus()).tasks['do-release'].appSchedules).toEqual([])
      })

      // An app restating the task's own expression adds no schedule the global
      // row cannot already show, so counting it would make "N apps scheduled"
      // mean something different per task.
      it('omits an app that restates the global expression', async () => {
        await withRealCron()
        getActiveApps.mockResolvedValue([{ id: 'app-1', name: 'Acme' }])
        isTaskTypeEnabledForApp.mockResolvedValue(true)
        getAppTaskTypeInterval.mockResolvedValue('15 9 * * *')
        getAppTaskTypeOverrides.mockResolvedValue({ 'do-release': { enabled: true, interval: '15 9 * * *' } })
        mockSchedule({ tasks: { 'do-release': { type: 'cron', cronExpression: '15 9 * * *', enabled: true, runAfter: [] } } })

        expect((await getScheduleStatus()).tasks['do-release'].appSchedules).toEqual([])
      })

      it('omits an app that is disabled for the task', async () => {
        await withRealCron()
        getActiveApps.mockResolvedValue([{ id: 'app-1', name: 'Acme' }])
        isTaskTypeEnabledForApp.mockResolvedValue(false)
        getAppTaskTypeInterval.mockResolvedValue('15 9 * * *')
        getAppTaskTypeOverrides.mockResolvedValue({ 'do-release': { enabled: false, interval: '15 9 * * *' } })
        mockSchedule({ tasks: { 'do-release': { type: 'on-demand', enabled: true, runAfter: [] } } })

        expect((await getScheduleStatus()).tasks['do-release'].appSchedules).toEqual([])
      })
    })

    describe('parkPerpetual / perpetual park state', () => {
      it('parkPerpetual stamps parkedUntil + reason on the per-app record', async () => {
        mockSchedule({ tasks: { 'claim-issue': { type: 'on-demand', perpetual: true, enabled: true, recheckIntervalMs: 3600000 } } })
        const record = await parkPerpetual('claim-issue', 'app-1', { reason: 'no-actionable-issues', actionableCount: 0, counts: { open: 40, inFlight: 2, filtered: 38 } })
        expect(record.parkedUntil).toBeTruthy()
        expect(record.parkReason).toBe('no-actionable-issues')
        expect(record.parkActionableCount).toBe(0)
        expect(record.parkCounts).toEqual({ open: 40, inFlight: 2, filtered: 38 })
      })

      // A park on a non-empty queue must carry its WHY: the per-cause skip
      // attribution ("49 needs-input, 17 blocked") is what tells the operator
      // their work is waiting on decisions, not that the task is broken — the
      // exact confusion behind reading a bare `no-actionable-issues` in PM2
      // output next to 88 open issues.
      it('parkPerpetual persists the per-cause skip attribution and names the top causes in its log line', async () => {
        mockSchedule({ tasks: { 'claim-issue': { type: 'on-demand', perpetual: true, enabled: true, recheckIntervalMs: 3600000 } } })
        const record = await parkPerpetual('claim-issue', 'app-1', {
          reason: 'no-actionable-issues', actionableCount: 0,
          counts: { open: 88, inFlight: 10, filtered: 78 },
          skipCauses: { 'needs-input': 49, blocked: 17, 'decomposed-epic': 12, assigned: 2 }
        })
        expect(record.parkSkipCauses).toEqual({ 'needs-input': 49, blocked: 17, 'decomposed-epic': 12, assigned: 2 })
        // The log line the operator reads in PM2 names the top 3 causes inline.
        const logged = emitLog.mock.calls.at(-1);
        expect(logged[1]).toMatch(/no-actionable-issues — 49 needs-input, 17 blocked, 12 decomposed-epic/);
        expect(logged[1]).not.toMatch(/2 assigned/);
      })

      it('parkPerpetual leaves parkSkipCauses absent when the detector reports no attribution', async () => {
        mockSchedule({ tasks: { 'branch-reconcile': { type: 'on-demand', perpetual: true, enabled: true } } })
        const record = await parkPerpetual('branch-reconcile', 'app-1', { reason: 'no-in-flight-branches', actionableCount: 0, counts: null, skipCauses: null })
        expect(record.parkSkipCauses).toBeUndefined()
      })

      it.each(['branches-blocked', 'no-progress', 'drain-cap'])('names every retained branch and its reason when parking for %s', async reason => {
        const remaining = [
          { branch: 'fix/one', reason: 'review-task-missing', nextAction: 'Restore trusted task history.' },
          { branch: 'fix/two', reason: 'actionable' },
        ];
        mockSchedule({ tasks: { 'branch-reconcile': { type: 'on-demand', perpetual: true, enabled: true } },
          executions: { 'task:branch-reconcile': { perApp: { 'app-1': { branchReconcileOutcome: { status: 'running', remaining } } } } },
        });
        const record = await parkPerpetual('branch-reconcile', 'app-1', { reason });
        expect(record.branchReconcileOutcome).toMatchObject({ status: 'incomplete', reason, remaining });
        expect(emitLog.mock.calls.some(([, message]) => message.includes('retained fix/one: review-task-missing — Restore trusted task history.'))).toBe(true);
        expect(emitLog.mock.calls.some(([, message]) => message.includes('retained fix/two: actionable'))).toBe(true);
      });

      it('getPerpetualParkInfo reads back the park record (and null when not parked)', async () => {
        const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
        mockSchedule({
          tasks: { 'claim-issue': { type: 'on-demand', perpetual: true, enabled: true } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: {
            'app-1': { lastRun: null, count: 0, parkedUntil: future, parkReason: 'no-actionable-issues', parkActionableCount: 0, parkCounts: { open: 40, inFlight: 2, filtered: 38 }, parkSkipCauses: { 'needs-input': 30, blocked: 8 } },
            'app-2': { lastRun: null, count: 0 }
          } } }
        })
        const info = await getPerpetualParkInfo('claim-issue', 'app-1')
        expect(info).toMatchObject({ parkedUntil: future, parkReason: 'no-actionable-issues', parkActionableCount: 0, parkCounts: { open: 40, inFlight: 2, filtered: 38 }, parkSkipCauses: { 'needs-input': 30, blocked: 8 } })
        expect(await getPerpetualParkInfo('claim-issue', 'app-2')).toBeNull()
        expect(await getPerpetualParkInfo('claim-issue', 'unknown-app')).toBeNull()
      })

      // The elapse-aware question the completion refill asks (#3848). It must differ
      // from getPerpetualParkInfo's "is there a park record": an ELAPSED park is
      // deliberately left on disk (it reads as "due right now"), so treating its
      // presence as a stop signal would wedge the drain until something cleared it.
      it('isPerpetualParkActive is true only while parkedUntil is in the future', async () => {
        const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
        const past = new Date(Date.now() - 60 * 60 * 1000).toISOString()
        mockSchedule({
          tasks: { 'claim-issue': { type: 'on-demand', perpetual: true, enabled: true } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: {
            'app-parked': { lastRun: null, count: 0, parkedUntil: future },
            'app-elapsed': { lastRun: null, count: 0, parkedUntil: past },
            'app-unparked': { lastRun: null, count: 0 }
          } } }
        })
        expect(await isPerpetualParkActive('claim-issue', 'app-parked')).toBe(true)
        expect(await isPerpetualParkActive('claim-issue', 'app-elapsed')).toBe(false)
        expect(await isPerpetualParkActive('claim-issue', 'app-unparked')).toBe(false)
        expect(await isPerpetualParkActive('claim-issue', 'unknown-app')).toBe(false)
        expect(await isPerpetualParkActive('unknown-type', 'app-parked')).toBe(false)
      })

      // branch-reconcile knows exactly when a claim worktree's grace window lapses.
      // Sleeping past it stacked the hold and the recheck cadence into a stall
      // several times longer than either — the shape that made a task with four
      // stale claim branches queued behind it look like it had stopped running.
      // (parseCronToNextRun is pinned off so the interval path is what runs; a
      // sibling test leaves it returning a year-2999 date.)
      it('parkPerpetual honours notLaterThan when the hold lifts before the recheck', async () => {
        parseCronToNextRun.mockReturnValue(null)
        mockSchedule({ tasks: { 'branch-reconcile': { type: 'on-demand', perpetual: true, enabled: true, recheckIntervalMs: 7 * 24 * 3600000 } } })
        const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString()
        const record = await parkPerpetual('branch-reconcile', 'app-1', {
          reason: 'merged-branches-held-back', actionableCount: 0, signature: null,
          counts: { heldBackMerged: 4 }, notLaterThan: soon
        })
        expect(record.parkedUntil).toBe(soon)
        expect(record.parkReason).toBe('merged-branches-held-back')
        expect(record.parkCounts).toEqual({ heldBackMerged: 4 })
      })

      // The record and the log line read from one value. Bounding only the record's copy would keep publishing the
      // un-shortened time — a "parked until" the task no longer honours.
      it('parkPerpetual records the SHORTENED time, not the raw cadence', async () => {
        parseCronToNextRun.mockReturnValue(null)
        cosEvents.emit.mockClear()
        mockSchedule({ tasks: { 'branch-reconcile': { type: 'on-demand', perpetual: true, enabled: true, recheckIntervalMs: 7 * 24 * 3600000 } } })
        const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString()
        const record = await parkPerpetual('branch-reconcile', 'app-1', {
          reason: 'merged-branches-held-back', actionableCount: 0, signature: null, notLaterThan: soon
        })
        expect(record.parkedUntil).toBe(soon)
      })

      // A cadence edit restamps every un-elapsed park. Without the bound
      // remembered ON the record, that edit stretches a correctly-shortened park
      // back out — the stacking this option exists to remove, reintroduced by an
      // unrelated settings change.
      it('a shortened park survives a recheck-cadence edit', async () => {
        parseCronToNextRun.mockReturnValue(null)
        const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString()
        mockSchedule({
          tasks: { 'branch-reconcile': { type: 'on-demand', perpetual: true, enabled: true, recheckIntervalMs: 3600000 } },
          executions: { 'task:branch-reconcile': { lastRun: null, count: 0, perApp: {
            'app-1': { lastRun: null, count: 0, parkedUntil: soon, parkNotLaterThan: soon, parkReason: 'merged-branches-held-back' }
          } } }
        })
        await updateTaskInterval('branch-reconcile', { recheckIntervalMs: 30 * 24 * 3600000 })
        const info = await getPerpetualParkInfo('branch-reconcile', 'app-1')
        expect(info.parkedUntil).toBe(soon)
      })

      it('parkPerpetual drops parkNotLaterThan when no bound is given', async () => {
        parseCronToNextRun.mockReturnValue(null)
        mockSchedule({ tasks: { 'branch-reconcile': { type: 'on-demand', perpetual: true, enabled: true, recheckIntervalMs: 3600000 } } })
        const record = await parkPerpetual('branch-reconcile', 'app-1', { reason: 'no-in-flight-branches', actionableCount: 0, signature: null })
        expect(record.parkNotLaterThan).toBeUndefined()
      })

      it('parkPerpetual ignores a notLaterThan that is later than the recheck', async () => {
        parseCronToNextRun.mockReturnValue(null)
        mockSchedule({ tasks: { 'branch-reconcile': { type: 'on-demand', perpetual: true, enabled: true, recheckIntervalMs: 3600000 } } })
        const far = new Date(Date.now() + 30 * 24 * 3600000).toISOString()
        const record = await parkPerpetual('branch-reconcile', 'app-1', {
          reason: 'merged-branches-held-back', actionableCount: 0, signature: null, notLaterThan: far
        })
        // The configured hourly cadence stands — a distant hold must not stretch it.
        expect(Date.parse(record.parkedUntil)).toBeLessThanOrEqual(Date.now() + 3600000)
        expect(Date.parse(record.parkedUntil)).toBeGreaterThan(Date.now())
      })

      it('derives retry eligibility from the app cadence and enabled switches, not a stale park', async () => {
        const future = new Date(Date.now() + 3_600_000).toISOString();
        const task = { type: 'on-demand', perpetual: false, autoStart: false, enabled: true };
        const execution = { perApp: { 'app-1': { parkedUntil: future } } };
        mockSchedule({ tasks: { 'branch-reconcile': task }, executions: { 'task:branch-reconcile': execution } });
        expect(await shouldRunTask('branch-reconcile', 'app-1')).toMatchObject({ shouldRun: false, reason: 'on-demand-only' });
        getAppTaskTypeInterval.mockResolvedValueOnce('0 3 * * *');
        parseCronToNextRun.mockReturnValueOnce(new Date(future));
        expect(await shouldRunTask('branch-reconcile', 'app-1')).toMatchObject({ shouldRun: false, reason: 'cron-cooldown', nextRunAt: future });
        isTaskTypeEnabledForApp.mockResolvedValue(false);
        expect(await shouldRunTask('branch-reconcile', 'app-1')).toEqual({ shouldRun: false, reason: 'disabled-for-app' });
        isTaskTypeEnabledForApp.mockResolvedValue(true);
        mockSchedule({ tasks: { 'branch-reconcile': { ...task, enabled: false } }, executions: { 'task:branch-reconcile': execution } });
        expect(await shouldRunTask('branch-reconcile', 'app-1')).toEqual({ shouldRun: false, reason: 'disabled' });
      });

      it('normalizes old schedule ledgers once without requiring their evidence', async () => {
        const row = { branch: 'fix/old', path: '/example/old', head: 'a'.repeat(40), reason: 'retirement-provenance-unverified' };
        const old = { status: 'incomplete', reason: 'retirement-provenance-unverified', remaining: [],
          retirementObligations: [row], retirementReceiptIdentities: { old: 'time' }, retirementReceiptEvidence: {},
          initializedRetirements: [{}], legacyRetirementTransition: { observations: ['old'] },
          retired: Array.from({ length: 25 }, (_, n) => ({ branch: `fix/${n}`, settledObservations: [{}] })) };
        let saved = { version: 2, tasks: {}, executions: { 'task:branch-reconcile': { perApp: { 'app-1': { branchReconcileOutcome: old } } } } };
        readJSONFile.mockImplementation(async () => structuredClone(saved));
        writeFile.mockImplementation(async (_path, contents) => { saved = JSON.parse(contents); });
        const current = await getBranchReconcileOutcome('app-1');
        expect(current.remaining).toEqual([row]);
        expect(current.reason).toBe('inventory-refresh-required');
        for (const key of ['retirementObligations', 'retirementReceiptIdentities', 'retirementReceiptEvidence', 'initializedRetirements', 'legacyRetirementTransition']) expect(current).not.toHaveProperty(key);
        expect(current.retired).toHaveLength(20);
        expect(current.retired.every(row => !Object.hasOwn(row, 'settledObservations'))).toBe(true);
        const writes = writeFile.mock.calls.length;
        expect(await getBranchReconcileOutcome('app-1')).toEqual(current);
        expect(writeFile.mock.calls.length).toBe(writes);
      });

      it('persists incomplete sweep evidence and exposes it when recurring dispatch is off', async () => {
        let saved = { version: 2, tasks: { 'branch-reconcile': { enabled: true, type: 'on-demand', perpetual: false } }, executions: {}, templates: [] };
        readJSONFile.mockImplementation(async () => structuredClone(saved));
        writeFile.mockImplementation(async (_path, contents) => { saved = JSON.parse(contents); });
        const remaining = [{ branch: 'fix/example', path: '/example/checkout', reason: 'worktree-locked' }];
        await recordBranchReconcileOutcome('app-1', { status: 'running', reason: 'batch-pending', remaining, nextAction: 'Continue.' });
        const observedAt = saved.executions['task:branch-reconcile'].perApp['app-1'].branchReconcileOutcome.observedAt;
        await recordBranchReconcileOutcome('app-1', { status: 'incomplete', reason: 'agent-failed', nextAction: 'Resolve the provider failure and run again.' });
        expect(saved.executions['task:branch-reconcile'].perApp['app-1'].branchReconcileOutcome)
          .toMatchObject({ status: 'incomplete', reason: 'agent-failed', remaining, observedAt });
        expect((await getScheduleStatus()).tasks['branch-reconcile'].reconcileOutcomes['app-1'])
          .toMatchObject({ status: 'incomplete', reason: 'agent-failed', remaining, observedAt });
      });

      it('routes workspace retirement only to the matching repository and exact checkout tuple', async () => {
        let saved = { version: 2, tasks: {}, executions: {}, templates: [] };
        readJSONFile.mockImplementation(async () => structuredClone(saved));
        writeFile.mockImplementation(async (_path, contents) => { saved = JSON.parse(contents); });
        const row = { branch: 'fix/example', path: '/example/checkout', head: 'a'.repeat(40),
          checkoutIdentity: 'original', reason: 'worktree-locked' };
        await recordBranchReconcileOutcome('matching', { status: 'incomplete', remaining: [row] });
        await recordBranchReconcileOutcome('different-head', { status: 'incomplete', remaining: [{ ...row, head: 'b'.repeat(40) }] });
        await recordBranchReconcileOutcome('different-repo', { status: 'incomplete', remaining: [row] });
        getAppById.mockImplementation(async id => ({ repoPath: id === 'different-repo' ? '/other/repo' : '/example/repo' }));
        await recordWorkspaceCheckoutRetirement('/example/repo', { ...row, branchDeleted: true, archiveDir: '/example/archive' });
        const perApp = saved.executions['task:branch-reconcile'].perApp;
        expect(perApp.matching.branchReconcileOutcome.remaining).toEqual([]);
        expect(perApp['different-head'].branchReconcileOutcome).toMatchObject({ remaining: [{ ...row, head: 'b'.repeat(40) }] });
        expect(perApp['different-head'].branchReconcileOutcome.retired).toBeUndefined();
        expect(perApp['different-repo'].branchReconcileOutcome.remaining).toEqual([row]);
        expect(perApp['different-repo'].branchReconcileOutcome.retired).toBeUndefined();
      });

      it('keeps a current inventory observation when a different-head retirement arrives at the same path', async () => {
        let saved = { version: 2, tasks: {}, executions: {}, templates: [] };
        readJSONFile.mockImplementation(async () => structuredClone(saved));
        writeFile.mockImplementation(async (_path, contents) => { saved = JSON.parse(contents); });
        const current = { branch: 'fix/example', path: '/example/checkout', head: 'b'.repeat(40),
          checkoutIdentity: 'recreated', reason: 'worktree-locked' };
        await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [current] });
        const result = await recordHeldCheckoutRetirement('app-1', { ...current, head: 'a'.repeat(40),
          checkoutIdentity: 'original', branchDeleted: true, archiveDir: '/example/archive' });
        expect(result.remaining).toEqual([current]);
      });

      it('persists branch attempts through cap parks and manual resets, clearing only on sweep exhaustion', async () => {
        let saved = { version: 2, tasks: { 'branch-reconcile': { enabled: true, type: 'on-demand', perpetual: true } }, executions: {}, templates: [] };
        readJSONFile.mockImplementation(async () => JSON.parse(JSON.stringify(saved)));
        writeFile.mockImplementation(async (_path, contents) => { saved = JSON.parse(contents); });
        const branchAttempts = { 'fix/first': 'fix/first:IN_REVIEW:1:head' };
        await recordPerpetualDispatch('branch-reconcile', 'app-1', 'batch', { branchAttempts });
        await parkPerpetual('branch-reconcile', 'app-1', { reason: 'drain-cap', signature: null });
        await resetPerpetualForManualRun('branch-reconcile', 'app-1');
        expect(await getPerpetualDrainState('branch-reconcile', 'app-1')).toEqual({ signature: null, dispatchCount: 0, branchAttempts });
        const counts = { heldBranches: 2, heldDetached: 1 };
        const skipCauses = { 'draft-review-required': 1, 'claim-owner-active': 1, 'worktree-locked': 1 };
        await parkPerpetual('branch-reconcile', 'app-1', { reason: 'branches-blocked', counts, skipCauses, branchAttempts: null });
        expect((await getPerpetualDrainState('branch-reconcile', 'app-1')).branchAttempts).toBeUndefined();
        expect(await getPerpetualParkInfo('branch-reconcile', 'app-1')).toMatchObject({ parkReason: 'branches-blocked', parkCounts: counts, parkSkipCauses: skipCauses });
      });

      it('parkPerpetual omits parkCounts when no breakdown is provided', async () => {
        mockSchedule({ tasks: { 'branch-reconcile': { type: 'on-demand', perpetual: true, enabled: true, recheckIntervalMs: 3600000 } } })
        const record = await parkPerpetual('branch-reconcile', 'app-1', { reason: 'no-in-flight-branches', actionableCount: 0, signature: null })
        expect(record.parkCounts).toBeUndefined()
      })

      // The mid-drain unpark is recordPerpetualDispatch's job (it clears the park
      // fields in the same write it spends a dispatch) — there is no separate
      // clear-only path any more, so a resumed drain can never forget to spend
      // one and slip the cap.
      it('recordPerpetualDispatch clears an existing park as it spends a dispatch', async () => {
        const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
        mockSchedule({
          tasks: { 'claim-issue': { type: 'on-demand', perpetual: true, enabled: true } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: {
            'app-1': { lastRun: null, count: 0, parkedUntil: future, parkReason: 'no-actionable-issues', perpetualDispatchCount: 2 }
          } } }
        })
        expect(await recordPerpetualDispatch('claim-issue', 'app-1', null)).toBe(3)
        expect(await isPerpetualParkActive('claim-issue', 'app-1')).toBe(false)
        expect(await getPerpetualParkInfo('claim-issue', 'app-1')).toBeNull()
      })

      it('resetPerpetualForManualRun drops the park, the convergence signature, AND the dispatch count', async () => {
        const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
        mockSchedule({
          tasks: { 'branch-reconcile': { type: 'on-demand', perpetual: true, enabled: true } },
          executions: { 'task:branch-reconcile': { lastRun: null, count: 0, perApp: {
            'app-1': { lastRun: null, count: 0, parkedUntil: future, parkReason: 'no-progress', lastActionableSignature: 'a:NEEDS_PR:none', perpetualDispatchCount: 4 }
          } } }
        })
        expect(await resetPerpetualForManualRun('branch-reconcile', 'app-1')).toBe(true)
        const saved = JSON.parse(writeFile.mock.calls.at(-1)[1])
        const rec = saved.executions['task:branch-reconcile'].perApp['app-1']
        expect(rec.parkedUntil).toBeUndefined()
        expect(rec.parkReason).toBeUndefined()
        expect(rec.lastActionableSignature).toBeUndefined()
        // A human asking to re-run gets a full dispatch budget, not the tail of the
        // previous window — otherwise a drain that just hit the cap would park again
        // on its first cycle.
        expect(rec.perpetualDispatchCount).toBeUndefined()
      })

      it('getPerpetualDrainState reads both brakes in one pass (and defaults them)', async () => {
        mockSchedule({
          tasks: { 'branch-reconcile': { type: 'on-demand', perpetual: true, enabled: true } },
          executions: { 'task:branch-reconcile': { lastRun: null, count: 0, perApp: {
            'app-1': { lastRun: null, count: 0, lastActionableSignature: 'sig-1', perpetualDispatchCount: 3 }
          } } }
        })
        expect(await getPerpetualDrainState('branch-reconcile', 'app-1')).toEqual({ signature: 'sig-1', dispatchCount: 3 })
        // An app with no record yet is "fresh drain", not undefined.
        expect(await getPerpetualDrainState('branch-reconcile', 'app-9')).toEqual({ signature: null, dispatchCount: 0 })
      })

      it('recordPerpetualDispatch drops the park, records the signature, and spends one dispatch in ONE write', async () => {
        const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
        mockSchedule({
          tasks: { 'branch-reconcile': { type: 'on-demand', perpetual: true, enabled: true } },
          executions: { 'task:branch-reconcile': { lastRun: null, count: 0, perApp: {
            'app-1': { lastRun: null, count: 0, parkedUntil: future, parkReason: 'no-progress', perpetualDispatchCount: 2 }
          } } }
        })
        expect(await recordPerpetualDispatch('branch-reconcile', 'app-1', 'sig-2')).toBe(3)
        const rec = JSON.parse(writeFile.mock.calls.at(-1)[1]).executions['task:branch-reconcile'].perApp['app-1']
        expect(rec.parkedUntil).toBeUndefined()
        expect(rec.parkReason).toBeUndefined()
        expect(rec.lastActionableSignature).toBe('sig-2')
        expect(rec.perpetualDispatchCount).toBe(3)
        // The three facts land TOGETHER: no persisted state exists in which the new
        // signature is recorded without the park cleared and the dispatch counted.
        // (loadSchedule may itself write once for prompt self-heal, so this asserts
        // the invariant rather than a raw write count.)
        const partial = writeFile.mock.calls
          .map((c) => JSON.parse(c[1]).executions['task:branch-reconcile']?.perApp?.['app-1'])
          .filter((r) => r?.lastActionableSignature === 'sig-2')
          .filter((r) => r.parkedUntil !== undefined || r.perpetualDispatchCount !== 3)
        expect(partial).toEqual([])
      })

      // The churn detector (agentChurn.js) parks a coordinator when a local
      // signal fires. A dispatch that leaves a stale count behind makes the next
      // park over-report "same finding again". A dispatch only happens on a
      // CHANGED set, so it resets to 1.
      it('recordPerpetualDispatch resets signatureRepeatCount for the new signature', async () => {
        mockSchedule({
          tasks: { 'branch-reconcile': { type: 'on-demand', perpetual: true, enabled: true } },
          executions: { 'task:branch-reconcile': { lastRun: null, count: 0, perApp: {
            'app-1': { lastRun: null, count: 0, lastActionableSignature: 'old-sig', signatureRepeatCount: 4 }
          } } }
        })
        await recordPerpetualDispatch('branch-reconcile', 'app-1', 'new-sig')
        const rec = JSON.parse(writeFile.mock.calls.at(-1)[1]).executions['task:branch-reconcile'].perApp['app-1']
        expect(rec.lastActionableSignature).toBe('new-sig')
        expect(rec.signatureRepeatCount).toBe(1)
      })

      // The park has to land the zeroed budget itself: a second await is a step a
      // future park path can forget, and a stale count caps the NEXT drain early.
      it('parkPerpetual clears the dispatch budget when handed dispatchCount: 0', async () => {
        mockSchedule({
          tasks: { 'branch-reconcile': { type: 'on-demand', perpetual: true, enabled: true, recheckIntervalMs: 3600000 } },
          executions: { 'task:branch-reconcile': { lastRun: null, count: 0, perApp: { 'app-1': { lastRun: null, count: 0, perpetualDispatchCount: 4 } } } }
        })
        await parkPerpetual('branch-reconcile', 'app-1', { reason: 'drain-cap', actionableCount: 2, signature: null, dispatchCount: 0 })
        const rec = JSON.parse(writeFile.mock.calls.at(-1)[1]).executions['task:branch-reconcile'].perApp['app-1']
        expect(rec.perpetualDispatchCount).toBeUndefined()
        expect(rec.lastActionableSignature).toBeUndefined()
        expect(rec.parkReason).toBe('drain-cap')
      })

      // Inverted deliberately (#3848): omitting the option used to PRESERVE the
      // count. A park ends the drain window by definition, so zeroing the budget is
      // the invariant, not something each call site has to opt into — the churn
      // detector's park (agentChurn.js) is exactly the caller that forgot, leaving
      // the next window to cap early on a spend it never made.
      it('parkPerpetual zeroes the dispatch budget even when the caller omits dispatchCount', async () => {
        mockSchedule({
          tasks: { 'claim-issue': { type: 'on-demand', perpetual: true, enabled: true, recheckIntervalMs: 3600000 } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: { 'app-1': { lastRun: null, count: 0, perpetualDispatchCount: 4 } } } }
        })
        await parkPerpetual('claim-issue', 'app-1', { reason: 'churn-detected', actionableCount: 12 })
        const rec = JSON.parse(writeFile.mock.calls.at(-1)[1]).executions['task:claim-issue'].perApp['app-1']
        expect(rec.perpetualDispatchCount).toBeUndefined()
      })

      it('resetPerpetualForManualRun is a no-op (false) when nothing is cached', async () => {
        mockSchedule({
          tasks: { 'claim-issue': { type: 'on-demand', perpetual: true, enabled: true } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: { 'app-1': { lastRun: null, count: 0 } } } }
        })
        expect(await resetPerpetualForManualRun('claim-issue', 'app-1')).toBe(false)
      })

      it('parkPerpetual stores the actionable signature it parked on', async () => {
        mockSchedule({ tasks: { 'branch-reconcile': { type: 'on-demand', perpetual: true, enabled: true, recheckIntervalMs: 3600000 } } })
        await parkPerpetual('branch-reconcile', 'app-1', { reason: 'no-progress', actionableCount: 2, signature: 'a:NEEDS_PR:none|b:IN_REVIEW:5' })
        const saved = JSON.parse(writeFile.mock.calls.at(-1)[1])
        expect(saved.executions['task:branch-reconcile'].perApp['app-1'].lastActionableSignature).toBe('a:NEEDS_PR:none|b:IN_REVIEW:5')
      })

      it('parkPerpetual with signature:null clears a prior signature (idle park)', async () => {
        mockSchedule({
          tasks: { 'branch-reconcile': { type: 'on-demand', perpetual: true, enabled: true, recheckIntervalMs: 3600000 } },
          executions: { 'task:branch-reconcile': { lastRun: null, count: 0, perApp: { 'app-1': { lastRun: null, count: 0, lastActionableSignature: 'old-sig' } } } }
        })
        await parkPerpetual('branch-reconcile', 'app-1', { reason: 'no-in-flight-branches', actionableCount: 0, signature: null })
        const saved = JSON.parse(writeFile.mock.calls.at(-1)[1])
        expect(saved.executions['task:branch-reconcile'].perApp['app-1'].lastActionableSignature).toBeUndefined()
      })

      it('parkPerpetual increments signatureRepeatCount when the same finding is parked again', async () => {
        mockSchedule({
          tasks: { 'branch-reconcile': { type: 'on-demand', perpetual: true, enabled: true, recheckIntervalMs: 3600000 } },
          executions: { 'task:branch-reconcile': { lastRun: null, count: 0, perApp: { 'app-1': { lastRun: null, count: 0, lastActionableSignature: 'a:NEEDS_PR:none' } } } }
        })
        await parkPerpetual('branch-reconcile', 'app-1', { reason: 'no-progress', actionableCount: 1, signature: 'a:NEEDS_PR:none' })
        const saved = JSON.parse(writeFile.mock.calls.at(-1)[1])
        expect(saved.executions['task:branch-reconcile'].perApp['app-1'].signatureRepeatCount).toBe(2)
        expect(saved.executions['task:branch-reconcile'].perApp['app-1'].lastActionableSignature).toBe('a:NEEDS_PR:none')
      })

      it('parkPerpetual resets signatureRepeatCount when the finding changes', async () => {
        mockSchedule({
          tasks: { 'branch-reconcile': { type: 'on-demand', perpetual: true, enabled: true, recheckIntervalMs: 3600000 } },
          executions: { 'task:branch-reconcile': { lastRun: null, count: 0, perApp: { 'app-1': { lastRun: null, count: 0, lastActionableSignature: 'old', signatureRepeatCount: 6 } } } }
        })
        await parkPerpetual('branch-reconcile', 'app-1', { reason: 'no-progress', actionableCount: 1, signature: 'new' })
        const saved = JSON.parse(writeFile.mock.calls.at(-1)[1])
        expect(saved.executions['task:branch-reconcile'].perApp['app-1'].lastActionableSignature).toBe('new')
        expect(saved.executions['task:branch-reconcile'].perApp['app-1'].signatureRepeatCount).toBe(1)
      })
    })

    describe('type-level failure ledger (#2616)', () => {
      it('computeFailureBackoffMs scales 2^n × base, capped, and 0 for n<=0', () => {
        expect(computeFailureBackoffMs(0)).toBe(0)
        expect(computeFailureBackoffMs(-3)).toBe(0)
        expect(computeFailureBackoffMs(1)).toBe(FAILURE_BACKOFF_BASE_MS * 2)
        expect(computeFailureBackoffMs(2)).toBe(FAILURE_BACKOFF_BASE_MS * 4)
        expect(computeFailureBackoffMs(3)).toBe(FAILURE_BACKOFF_BASE_MS * 8)
        // Large n saturates at the cap.
        expect(computeFailureBackoffMs(50)).toBe(FAILURE_BACKOFF_CAP_MS)
      })

      it('recordTaskTypeFailure increments consecutiveFailures + stamps category', async () => {
        mockSchedule({ tasks: { security: { type: 'rotation', enabled: true } } })
        const rec = await recordTaskTypeFailure('security', 'app-1', { errorCategory: 'timeout' })
        expect(rec.consecutiveFailures).toBe(1)
        expect(rec.lastErrorCategory).toBe('timeout')
        expect(rec.lastFailureAt).toBeTruthy()
        expect(rec.failureParkedAt).toBeUndefined()
        const saved = JSON.parse(writeFile.mock.calls.at(-1)[1])
        expect(saved.executions['task:security'].perApp['app-1'].consecutiveFailures).toBe(1)
      })

      it('records a task queued under a retired type name on the renamed ledger', async () => {
        // A release-check task queued before migration 417 finishes after it.
        mockSchedule({
          tasks: { 'do-release': { type: 'on-demand', enabled: true } },
          executions: { 'task:do-release': { lastRun: null, count: 0, perApp: {
            'app-1': { lastRun: null, count: 0, consecutiveFailures: 1, lastFailureAt: new Date().toISOString() }
          } } }
        })
        const rec = await recordTaskTypeFailure('release-check', 'app-1', { errorCategory: 'timeout' })
        expect(rec.consecutiveFailures).toBe(2)
        const saved = JSON.parse(writeFile.mock.calls.at(-1)[1])
        expect(saved.executions).not.toHaveProperty('task:release-check')
      })

      it('auto-parks + notifies after FAILURE_PARK_THRESHOLD consecutive failures', async () => {
        mockSchedule({
          tasks: { security: { type: 'rotation', enabled: true } },
          executions: { 'task:security': { lastRun: null, count: 0, perApp: {
            'app-1': { lastRun: null, count: 0, consecutiveFailures: FAILURE_PARK_THRESHOLD - 1, lastFailureAt: new Date().toISOString() }
          } } }
        })
        const rec = await recordTaskTypeFailure('security', 'app-1', { errorCategory: 'auth-error' })
        expect(rec.consecutiveFailures).toBe(FAILURE_PARK_THRESHOLD)
        expect(rec.failureParkedAt).toBeTruthy()
        expect(rec.failureParkReason).toBe('auth-error')
        expect(addNotification).toHaveBeenCalledTimes(1)
        expect(addNotification.mock.calls[0][0]).toMatchObject({
          type: 'agent_warning',
          metadata: { taskType: 'security', appId: 'app-1', failureParkKey: 'security:app-1' }
        })
      })

      it('does not re-notify (deduped) when a park already exists', async () => {
        notificationExists.mockResolvedValueOnce(true)
        mockSchedule({
          tasks: { security: { type: 'rotation', enabled: true } },
          executions: { 'task:security': { lastRun: null, count: 0, perApp: {
            'app-1': { lastRun: null, count: 0, consecutiveFailures: FAILURE_PARK_THRESHOLD - 1, lastFailureAt: new Date().toISOString() }
          } } }
        })
        await recordTaskTypeFailure('security', 'app-1', { errorCategory: 'auth-error' })
        expect(addNotification).not.toHaveBeenCalled()
      })

      it('recordTaskTypeSuccess prunes the stale park notification (so a re-park re-notifies)', async () => {
        mockSchedule({
          tasks: { security: { type: 'rotation', enabled: true } },
          executions: { 'task:security': { lastRun: null, count: 0, perApp: {
            'app-1': { lastRun: null, count: 0, consecutiveFailures: 5, failureParkedAt: new Date().toISOString(), failureParkReason: 'auth-error' }
          } } }
        })
        await recordTaskTypeSuccess('security', 'app-1')
        expect(removeByMetadata).toHaveBeenCalledWith('failureParkKey', 'security:app-1')
      })

      it('recordTaskTypeSuccess does NOT prune when the type was not parked', async () => {
        mockSchedule({
          tasks: { security: { type: 'rotation', enabled: true } },
          executions: { 'task:security': { lastRun: null, count: 0, perApp: {
            'app-1': { lastRun: null, count: 0, consecutiveFailures: 2 }
          } } }
        })
        await recordTaskTypeSuccess('security', 'app-1')
        expect(removeByMetadata).not.toHaveBeenCalled()
      })

      it('recordTaskTypeSuccess resets the ledger and returns false when already clean', async () => {
        mockSchedule({
          tasks: { security: { type: 'rotation', enabled: true } },
          executions: { 'task:security': { lastRun: null, count: 0, perApp: {
            'app-1': { lastRun: null, count: 0, consecutiveFailures: 3, lastFailureAt: new Date().toISOString(), failureParkedAt: new Date().toISOString(), failureParkReason: 'x' }
          } } }
        })
        expect(await recordTaskTypeSuccess('security', 'app-1')).toBe(true)
        const saved = JSON.parse(writeFile.mock.calls.at(-1)[1])
        const rec = saved.executions['task:security'].perApp['app-1']
        expect(rec.consecutiveFailures).toBeUndefined()
        expect(rec.failureParkedAt).toBeUndefined()
        // Second call: nothing left to clear.
        mockSchedule({ tasks: { security: { type: 'rotation', enabled: true } }, executions: { 'task:security': { lastRun: null, count: 0, perApp: { 'app-1': { lastRun: null, count: 0 } } } } })
        expect(await recordTaskTypeSuccess('security', 'app-1')).toBe(false)
      })

      it('a delayed cleanup success clears older failures but preserves newer or undated failures', async () => {
        const record = lastFailureAt => ({ lastRun: null, count: 0, consecutiveFailures: 2, lastFailureAt })
        const schedule = lastFailureAt => ({ tasks: { security: { type: 'rotation', enabled: true } },
          executions: { 'task:security': { lastRun: null, count: 0, perApp: { 'app-1': record(lastFailureAt) } } } })
        const notAfter = '2026-10-28T10:00:00.000Z'
        mockSchedule(schedule('2026-10-28T09:00:00.000Z'))
        expect(await recordTaskTypeSuccess('security', 'app-1', { notAfter })).toBe(true)
        mockSchedule(schedule('2026-10-28T11:00:00.000Z'))
        expect(await recordTaskTypeSuccess('security', 'app-1', { notAfter })).toBe(false)
        mockSchedule(schedule(undefined))
        expect(await recordTaskTypeSuccess('security', 'app-1', { notAfter })).toBe(false)
      })

      it('clearTaskTypeFailurePark(appId=null) clears ONLY the global record, not other apps', async () => {
        mockSchedule({
          tasks: { security: { type: 'rotation', enabled: true } },
          executions: { 'task:security': {
            lastRun: null, count: 0, consecutiveFailures: 4, failureParkedAt: new Date().toISOString(),
            perApp: {
              'app-1': { lastRun: null, count: 0, consecutiveFailures: 5, failureParkedAt: new Date().toISOString() }
            }
          } }
        })
        expect(await clearTaskTypeFailurePark('security')).toBe(true)
        const saved = JSON.parse(writeFile.mock.calls.at(-1)[1])
        const top = saved.executions['task:security']
        // Global record cleared...
        expect(top.consecutiveFailures).toBeUndefined()
        expect(top.failureParkedAt).toBeUndefined()
        // ...but app-1's independent ledger is untouched (its cause was never addressed).
        expect(top.perApp['app-1'].consecutiveFailures).toBe(5)
        expect(top.perApp['app-1'].failureParkedAt).toBeTruthy()
      })

      it('clearTaskTypeFailurePark(appId) clears ONLY that app, not the global record', async () => {
        mockSchedule({
          tasks: { security: { type: 'rotation', enabled: true } },
          executions: { 'task:security': {
            lastRun: null, count: 0, consecutiveFailures: 4, failureParkedAt: new Date().toISOString(),
            perApp: { 'app-1': { lastRun: null, count: 0, consecutiveFailures: 5, failureParkedAt: new Date().toISOString() } }
          } }
        })
        expect(await clearTaskTypeFailurePark('security', 'app-1')).toBe(true)
        const saved = JSON.parse(writeFile.mock.calls.at(-1)[1])
        const top = saved.executions['task:security']
        expect(top.perApp['app-1'].failureParkedAt).toBeUndefined()
        expect(top.consecutiveFailures).toBe(4)
        expect(removeByMetadata).toHaveBeenCalledWith('failureParkKey', 'security:app-1')
      })

      it('shouldRunTask returns failure-parked for a parked type', async () => {
        mockSchedule({
          tasks: { security: { type: 'on-demand', perpetual: true, enabled: true } },
          executions: { 'task:security': { lastRun: null, count: 0, perApp: {
            'app-1': { lastRun: null, count: 0, consecutiveFailures: FAILURE_PARK_THRESHOLD, failureParkedAt: new Date().toISOString(), failureParkReason: 'auth-error' }
          } } }
        })
        const res = await shouldRunTask('security', 'app-1')
        expect(res.shouldRun).toBe(false)
        expect(res.reason).toBe('failure-parked')
        expect(res.failureParkReason).toBe('auth-error')
      })

      it('shouldRunTask applies escalating failure-cooldown to an otherwise always-run perpetual drain', async () => {
        // 2 consecutive failures → backoff = base*4; last failure just now → in cooldown.
        mockSchedule({
          tasks: { security: { type: 'on-demand', perpetual: true, enabled: true } },
          executions: { 'task:security': { lastRun: null, count: 0, perApp: {
            'app-1': { lastRun: null, count: 0, consecutiveFailures: 2, lastFailureAt: new Date().toISOString(), lastErrorCategory: 'timeout' }
          } } }
        })
        const res = await shouldRunTask('security', 'app-1')
        expect(res.shouldRun).toBe(false)
        expect(res.reason).toBe('failure-cooldown')
        expect(res.consecutiveFailures).toBe(2)
        expect(res.failureBackoffMs).toBe(FAILURE_BACKOFF_BASE_MS * 4)
      })

      it('shouldRunTask lets a perpetual drain run once the failure-cooldown has elapsed', async () => {
        // 1 failure → backoff = base*2; last failure long ago → cooldown elapsed.
        const longAgo = new Date(Date.now() - (FAILURE_BACKOFF_CAP_MS + 60_000)).toISOString()
        mockSchedule({
          tasks: { security: { type: 'on-demand', perpetual: true, enabled: true } },
          executions: { 'task:security': { lastRun: null, count: 0, perApp: {
            'app-1': { lastRun: null, count: 0, consecutiveFailures: 1, lastFailureAt: longAgo }
          } } }
        })
        const res = await shouldRunTask('security', 'app-1')
        expect(res.shouldRun).toBe(true)
        expect(res.reason).toBe('perpetual-drain')
      })

      it('updateTaskInterval clears the failure ledger (config-change unpark)', async () => {
        mockSchedule({
          tasks: { security: { type: 'rotation', enabled: true } },
          executions: { 'task:security': {
            lastRun: null, count: 0, consecutiveFailures: 5, failureParkedAt: new Date().toISOString(),
            perApp: { 'app-1': { lastRun: null, count: 0, consecutiveFailures: 5, failureParkedAt: new Date().toISOString() } }
          } }
        })
        await updateTaskInterval('security', { enabled: true })
        const saved = JSON.parse(writeFile.mock.calls.at(-1)[1])
        const top = saved.executions['task:security']
        expect(top.consecutiveFailures).toBeUndefined()
        expect(top.failureParkedAt).toBeUndefined()
        expect(top.perApp['app-1'].failureParkedAt).toBeUndefined()
      })
    })

    describe('updateTaskInterval recompute-on-cadence-change', () => {
      it('re-derives an existing park when the recheck cadence changes', async () => {
        const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        mockSchedule({
          tasks: { 'claim-issue': { type: 'on-demand', perpetual: true, enabled: true, recheckIntervalMs: 30 * 24 * 60 * 60 * 1000 } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: { 'app-1': { lastRun: null, count: 0, parkedUntil: farFuture } } } }
        })
        await updateTaskInterval('claim-issue', { recheckIntervalMs: 1000 })
        const saved = JSON.parse(writeFile.mock.calls.at(-1)[1])
        const newParked = saved.executions['task:claim-issue'].perApp['app-1'].parkedUntil
        // Recomputed from the shortened cadence (now + 1s), far earlier than the old 30-day park.
        expect(new Date(newParked).getTime()).toBeLessThan(new Date(farFuture).getTime())
        expect(new Date(newParked).getTime()).toBeLessThan(Date.now() + 60_000)
      })

      it('does not create a park when none exists', async () => {
        mockSchedule({
          tasks: { 'claim-issue': { type: 'on-demand', perpetual: true, enabled: true } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: { 'app-1': { lastRun: null, count: 0 } } } }
        })
        await updateTaskInterval('claim-issue', { recheckIntervalMs: 1000 })
        const saved = JSON.parse(writeFile.mock.calls.at(-1)[1])
        expect(saved.executions['task:claim-issue'].perApp['app-1'].parkedUntil).toBeUndefined()
      })

      // #3590: an elapsed park is never cleared when it expires — shouldRunTask
      // reports `perpetual-recheck` and the dispatch gate clears it — so a record
      // whose parkedUntil is in the past is DUE RIGHT NOW. Restamping it from a
      // LENGTHENED cadence would silently delay work the user is already waiting on.
      it('leaves an already-elapsed park alone while re-deriving a future one', async () => {
        isTaskTypeEnabledForApp.mockResolvedValue(true)
        const soon = new Date(Date.now() + 60 * 1000).toISOString()
        const elapsed = new Date(Date.now() - 60 * 1000).toISOString()
        mockSchedule({
          tasks: { 'claim-issue': { type: 'on-demand', perpetual: true, enabled: true, recheckIntervalMs: 60 * 1000 } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: {
            'app-future': { lastRun: null, count: 0, parkedUntil: soon },
            'app-elapsed': { lastRun: null, count: 0, parkedUntil: elapsed }
          } } }
        })
        // Cadence LENGTHENED from 1 minute to 30 days.
        await updateTaskInterval('claim-issue', { recheckIntervalMs: 30 * 24 * 60 * 60 * 1000 })
        const saved = JSON.parse(writeFile.mock.calls.at(-1)[1])
        const perApp = saved.executions['task:claim-issue'].perApp
        // The future park is rewritten from the new (longer) cadence.
        expect(new Date(perApp['app-future'].parkedUntil).getTime())
          .toBeGreaterThan(new Date(soon).getTime())
        // The elapsed park is untouched, so the recheck it was owed still fires now.
        expect(perApp['app-elapsed'].parkedUntil).toBe(elapsed)

        readJSONFile.mockResolvedValue(saved)
        const result = await shouldRunTask('claim-issue', 'app-elapsed')
        expect(result.shouldRun).toBe(true)
        expect(result.reason).toBe('perpetual-recheck')
      })
    })

    describe('getScheduleStatus per-app park aggregate', () => {
      it('aggregates per-app parks into taskStatus.perpetualStatus', async () => {
        const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
        mockSchedule({
          tasks: { 'claim-issue': { type: 'on-demand', perpetual: true, enabled: true } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: {
            'app-1': {
              lastRun: null,
              count: 0,
              parkedUntil: future,
              parkReason: 'no-actionable-issues',
              parkCounts: { open: 88, inFlight: 2, filtered: 86 },
              parkSkipCauses: { 'needs-input': 49, blocked: 17 }
            },
            'app-2': { lastRun: null, count: 0 }
          } } }
        })
        const status = await getScheduleStatus()
        const p = status.tasks['claim-issue'].perpetualStatus
        expect(p).toMatchObject({
          parkedAppCount: 1,
          trackedAppCount: 2,
          globalParked: false,
          nextRecheckAt: future,
          parkReason: 'no-actionable-issues',
          parkCounts: { open: 88, inFlight: 2, filtered: 86 },
          parkSkipCauses: { 'needs-input': 49, blocked: 17 }
        })
      })
    })

    // The escalated-stall diagnostic (#7551): a perpetual gate that skips
    // WITHOUT parking (a broken forge CLI) has no park record to hang its
    // reason on, so it needs its own persisted channel — one that survives a
    // process restart the same way a park does, and that coexists with a
    // "draining" (not parked) status.
    describe('recordPerpetualStall + getScheduleStatus stall surfacing', () => {
      it('stamps a stall on the per-app record without touching the park fields', async () => {
        mockSchedule({
          tasks: { 'claim-issue': { type: 'on-demand', perpetual: true, enabled: true } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: { 'app-1': { lastRun: null, count: 0 } } } }
        })
        await recordPerpetualStall('claim-issue', 'app-1', { cli: 'gh', reason: 'gh-list-failed', detail: 'gh: authentication failed', consecutive: 3 })
        const status = await getScheduleStatus()
        const p = status.tasks['claim-issue'].perpetualStatus
        expect(p.stall).toMatchObject({ cli: 'gh', reason: 'gh-list-failed', detail: 'gh: authentication failed', consecutive: 3 })
        expect(p.globalParked).toBe(false)
        expect(p.parkedAppCount).toBe(0)
      })

      it('clears the stall when recorded with a null verdict', async () => {
        mockSchedule({
          tasks: { 'claim-issue': { type: 'on-demand', perpetual: true, enabled: true } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: { 'app-1': { lastRun: null, count: 0 } } } }
        })
        await recordPerpetualStall('claim-issue', 'app-1', { cli: 'gh', reason: 'gh-list-failed', consecutive: 3 })
        await recordPerpetualStall('claim-issue', 'app-1', null)
        const status = await getScheduleStatus()
        expect(status.tasks['claim-issue'].perpetualStatus.stall).toBeNull()
      })

      it('survives being re-read as if from a process restart (persisted, not in-memory)', async () => {
        mockSchedule({
          tasks: { 'claim-issue': { type: 'on-demand', perpetual: true, enabled: true } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: { 'app-1': { lastRun: null, count: 0 } } } }
        })
        await recordPerpetualStall('claim-issue', 'app-1', { cli: 'gh', reason: 'gh-list-failed', consecutive: 5 })
        // A fresh getScheduleStatus() call re-reads the persisted schedule from
        // scratch rather than any in-process cache, standing in for a restart.
        const status = await getScheduleStatus()
        expect(status.tasks['claim-issue'].perpetualStatus.stall).toMatchObject({ consecutive: 5 })
      })
    })

    // getScheduleStatus (UI rollup) and getUpcomingTasks (daemon wake-up) both
    // project the shared aggregatePerpetualParks rollup. These fixtures pin them
    // to the SAME park semantics — including the global-record inclusion rule
    // the two used to disagree on (status only ever folded in a global park that
    // hadn't elapsed; eligibility folded in any global record carrying a park).
    describe('perpetual park aggregate — getScheduleStatus and getUpcomingTasks agree', () => {
      const perpetualOf = async (taskType = 'claim-issue') =>
        (await getScheduleStatus()).tasks[taskType].perpetualStatus
      const upcomingOf = async (taskType = 'claim-issue') =>
        (await getUpcomingTasks(50)).find(t => t.taskType === taskType)

      it('every app parked: the status nextRecheckAt IS the upcoming eligibleAt', async () => {
        const soon = new Date(Date.now() + 30 * 60 * 1000).toISOString()
        const later = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
        mockSchedule({
          tasks: { 'claim-issue': { type: 'on-demand', perpetual: true, enabled: true } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: {
            'app-1': { lastRun: null, count: 0, parkedUntil: later, parkReason: 'no-actionable-issues' },
            'app-2': { lastRun: null, count: 0, parkedUntil: soon, parkReason: 'no-progress' }
          } } }
        })
        const p = await perpetualOf()
        const claim = await upcomingOf()
        expect(p).toMatchObject({ parkedAppCount: 2, trackedAppCount: 2, globalParked: false, nextRecheckAt: soon })
        expect(claim.status).toBe('scheduled')
        expect(new Date(claim.eligibleAt).toISOString()).toBe(p.nextRecheckAt)
      })

      it('an ELAPSED app park counts as due for both: ready upcoming, not parked in status', async () => {
        const past = new Date(Date.now() - 60 * 1000).toISOString()
        const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
        mockSchedule({
          tasks: { 'claim-issue': { type: 'on-demand', perpetual: true, enabled: true } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: {
            'app-1': { lastRun: null, count: 0, parkedUntil: past, parkReason: 'stale' },
            'app-2': { lastRun: null, count: 0, parkedUntil: future, parkReason: 'no-actionable-issues' }
          } } }
        })
        const p = await perpetualOf()
        const claim = await upcomingOf()
        expect(p).toMatchObject({ parkedAppCount: 1, trackedAppCount: 2, nextRecheckAt: future, parkReason: 'no-actionable-issues' })
        expect(claim.status).toBe('ready')
      })

      it('an own-parked GLOBAL record (no per-app) is a tracked scope for both', async () => {
        const future = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
        mockSchedule({
          tasks: { 'claim-issue': { type: 'on-demand', perpetual: true, enabled: true } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: {}, parkedUntil: future, parkReason: 'no-actionable-issues' } }
        })
        const p = await perpetualOf()
        const claim = await upcomingOf()
        expect(p).toMatchObject({ globalParked: true, parkedAppCount: 0, trackedAppCount: 0, nextRecheckAt: future, parkReason: 'no-actionable-issues' })
        expect(claim.status).toBe('scheduled')
        expect(new Date(claim.eligibleAt).toISOString()).toBe(p.nextRecheckAt)
      })

      it('an ELAPSED global park is due now for both (no lingering nextRecheckAt)', async () => {
        const past = new Date(Date.now() - 60 * 1000).toISOString()
        mockSchedule({
          tasks: { 'claim-issue': { type: 'on-demand', perpetual: true, enabled: true } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: {}, parkedUntil: past, parkReason: 'no-actionable-issues' } }
        })
        const p = await perpetualOf()
        const claim = await upcomingOf()
        expect(p).toMatchObject({ globalParked: false, nextRecheckAt: null, parkReason: null })
        expect(claim.status).toBe('ready')
      })

      it('a global park is folded in alongside per-app parks when it is the soonest', async () => {
        const globalPark = new Date(Date.now() + 10 * 60 * 1000).toISOString()
        const appPark = new Date(Date.now() + 60 * 60 * 1000).toISOString()
        mockSchedule({
          tasks: { 'claim-issue': { type: 'on-demand', perpetual: true, enabled: true } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, parkedUntil: globalPark, parkReason: 'global-idle', perApp: {
            'app-1': { lastRun: null, count: 0, parkedUntil: appPark, parkReason: 'no-actionable-issues' }
          } } }
        })
        const p = await perpetualOf()
        const claim = await upcomingOf()
        // parkReason still prefers the first parked APP over the global one.
        expect(p).toMatchObject({ globalParked: true, parkedAppCount: 1, trackedAppCount: 1, nextRecheckAt: globalPark, parkReason: 'no-actionable-issues' })
        expect(claim.status).toBe('scheduled')
        expect(new Date(claim.eligibleAt).toISOString()).toBe(p.nextRecheckAt)
      })

      it('no tracked scope at all: status reports nothing parked and upcoming stays ready', async () => {
        mockSchedule({ tasks: { 'claim-issue': { type: 'on-demand', perpetual: true, enabled: true } } })
        const p = await perpetualOf()
        const claim = await upcomingOf()
        expect(p).toMatchObject({ globalParked: false, parkedAppCount: 0, trackedAppCount: 0, nextRecheckAt: null, parkReason: null })
        expect(claim.status).toBe('ready')
      })
    })
  })
})

describe('boundParkedUntil', () => {
  const NOW = Date.parse('2026-01-10T00:00:00.000Z')
  const RECHECK = '2026-01-17T05:30:00.000Z' // a weekly cron fire

  it('shortens a park to a hold that lifts before the next recheck', () => {
    expect(boundParkedUntil(RECHECK, '2026-01-12T00:00:00.000Z', NOW)).toBe('2026-01-12T00:00:00.000Z')
  })

  it('keeps the recheck when the hold outlasts it', () => {
    // The bound only ever shortens — a later deadline must not stretch the park
    // past the cadence the user configured.
    expect(boundParkedUntil(RECHECK, '2026-02-01T00:00:00.000Z', NOW)).toBe(RECHECK)
  })

  it('ignores a bound that is absent or unparseable', () => {
    for (const bound of [null, undefined, '', 'soon', 42]) {
      expect(boundParkedUntil(RECHECK, bound, NOW)).toBe(RECHECK)
    }
  })

  it('ignores a bound that has already elapsed rather than parking in the past', () => {
    // A stale bound must not collapse the park to "retry immediately" — that
    // turns a converged drain into a hot loop against the same held branches.
    expect(boundParkedUntil(RECHECK, '2026-01-09T00:00:00.000Z', NOW)).toBe(RECHECK)
    expect(boundParkedUntil(RECHECK, new Date(NOW).toISOString(), NOW)).toBe(RECHECK)
  })

  it('returns the recheck unchanged when it is itself unparseable', () => {
    expect(boundParkedUntil('never', '2026-01-12T00:00:00.000Z', NOW)).toBe('never')
  })
})
