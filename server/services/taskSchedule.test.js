import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('./cosEvents.js', () => ({
  cosEvents: { emit: vi.fn() },
  emitLog: vi.fn()
}))

// fileUtils mock: include every named export consumed by ./cosState.js too,
// so vi.importActual('./cosState.js') below resolves cleanly.
vi.mock('../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  ensureDir: vi.fn().mockResolvedValue(),
  ensureDirs: vi.fn().mockResolvedValue(),
  readJSONFile: vi.fn(),
  loadSlashdoFile: vi.fn().mockResolvedValue(''),
  safeJSONParse: (content, fallback) => { try { return JSON.parse(content); } catch { return fallback; } },
  // atomicWrite replaced the raw writeFile(JSON.stringify) schedule-save site (#1837);
  // route it through the mocked fs/promises.writeFile so the tests that read
  // writeFile.mock.calls.at(-1)[1] still observe the persisted schedule JSON.
  atomicWrite: vi.fn(async (filePath, data) => {
    const payload = (typeof data === 'string' || Buffer.isBuffer(data)) ? data : JSON.stringify(data, null, 2);
    const { writeFile } = await import('fs/promises');
    return writeFile(filePath, payload);
  }),
  PATHS: { cos: '/mock/data/cos', root: '/mock', reports: '/mock/reports', scripts: '/mock/scripts' },
  HOUR: 60 * 60 * 1000,
  DAY: 24 * 60 * 60 * 1000,
  safeDate: (d) => d ? new Date(d).getTime() : 0
}))

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(),
  readFile: vi.fn().mockRejectedValue(new Error('readFile not mocked')),
  readdir: vi.fn().mockResolvedValue([]),
  rm: vi.fn().mockResolvedValue()
}))

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true)
}))

vi.mock('./taskLearning.js', () => ({
  getAdaptiveCooldownMultiplier: vi.fn().mockResolvedValue({
    multiplier: 1.0,
    reason: 'insufficient-data',
    skip: false,
    successRate: null,
    completed: 0
  })
}))

vi.mock('./apps.js', () => ({
  isTaskTypeEnabledForApp: vi.fn().mockResolvedValue(true),
  getAppTaskTypeInterval: vi.fn().mockResolvedValue(null),
  getAppTaskTypeIntervalMs: vi.fn().mockResolvedValue(null),
  getActiveApps: vi.fn().mockResolvedValue([]),
  getAppTaskTypeOverrides: vi.fn().mockResolvedValue({}),
  clearAllPrWatcherState: vi.fn().mockResolvedValue({ changed: false })
}))

vi.mock('../lib/ports.js', () => ({
  PORTOS_UI_URL: 'http://localhost:5554',
  PORTOS_API_URL: 'http://localhost:5555'
}))

vi.mock('../lib/timezone.js', () => ({
  getUserTimezone: vi.fn().mockResolvedValue('America/Los_Angeles'),
  getLocalParts: vi.fn(() => ({ dayOfWeek: 3 }))
}))

vi.mock('./eventScheduler.js', () => ({
  parseCronToNextRun: vi.fn(),
  parseCronToPrevRun: vi.fn()
}))

// Failure-park auto-notification (#2616): recordTaskTypeFailure lazy-imports
// notifications.js and fires an AGENT_WARNING when a type auto-parks. Mock it so
// the ledger tests can assert the notification without touching the real store.
vi.mock('./notifications.js', () => ({
  addNotification: vi.fn().mockResolvedValue({}),
  exists: vi.fn().mockResolvedValue(false),
  removeByMetadata: vi.fn().mockResolvedValue({ success: true, removedIds: [] }),
  NOTIFICATION_TYPES: { AGENT_WARNING: 'agent_warning' },
  PRIORITY_LEVELS: { HIGH: 'high' }
}))

// Use the real isImprovementEnabled implementation; only stub loadState.
// Mocking the helper would let regressions in production logic slip through.
vi.mock('./cosState.js', async () => {
  const actual = await vi.importActual('./cosState.js')
  return {
    ...actual,
    loadState: vi.fn().mockResolvedValue({ config: { improvementEnabled: true } })
  }
})

import {
  INTERVAL_TYPES,
  SELF_IMPROVEMENT_TASK_TYPES,
  loadSchedule,
  getTaskInterval,
  updateTaskInterval,
  recordExecution,
  getExecutionHistory,
  shouldRunTask,
  getDueTasks,
  getNextTaskType,
  addTemplateTask,
  getTemplateTasks,
  deleteTemplateTask,
  resetExecutionHistory,
  triggerOnDemandTask,
  getScheduleStatus,
  computePerpetualRecheckAt,
  parkPerpetual,
  clearPerpetualPark,
  resetPerpetualForManualRun,
  getPerpetualParkInfo,
  getPerpetualSignature,
  setPerpetualSignature,
  recordTaskTypeFailure,
  recordTaskTypeSuccess,
  getTaskTypeFailureInfo,
  clearTaskTypeFailurePark,
  computeFailureBackoffMs,
  FAILURE_BACKOFF_BASE_MS,
  FAILURE_BACKOFF_CAP_MS,
  FAILURE_PARK_THRESHOLD,
  PROMPT_VERSIONS,
  DEFAULT_TASK_INTERVALS,
  MANAGED_AGENT_OPTIONS,
  TASK_TYPE_DESCRIPTIONS,
  REFERENCE_WATCH_AUDITED_VERSION
} from './taskSchedule.js'

// Prompt getters moved to taskPromptService.js (issue #744 split, #1083 cycle
// break). taskSchedule.js re-exports the version constants but not the getters.
import {
  getDefaultPrompt,
  getTaskPrompt
} from './taskPromptService.js'

import { DEFAULT_TASK_PROMPTS, PREVIOUS_DEFAULT_PROMPTS } from './taskPromptDefaults.js'

import { loadState } from './cosState.js'

import { readJSONFile } from '../lib/fileUtils.js'
import { writeFile } from 'fs/promises'
import { isTaskTypeEnabledForApp, getAppTaskTypeInterval, clearAllPrWatcherState } from './apps.js'
import { getLocalParts } from '../lib/timezone.js'
import { getAdaptiveCooldownMultiplier } from './taskLearning.js'
import { parseCronToNextRun, parseCronToPrevRun } from './eventScheduler.js'
import { addNotification, exists as notificationExists, removeByMetadata } from './notifications.js'

const mockSchedule = ({ tasks = {}, executions = {}, templates = [] } = {}) => {
  readJSONFile.mockResolvedValue({ version: 2, tasks, executions, templates })
}

// Resolve "the most recent 9 AM in the past, local time." Bare
// `setHours(9, 0, 0, 0)` flakes in CI when the runner's wall-clock is
// before 9 AM local (UTC CI fires at ~04:00 UTC daily) — today's 9 AM
// would be in the future and shouldRunTask's `prevRunMs <= now` guard
// correctly rejects a slot that hasn't happened yet, breaking these
// tests' premise. Subtract a day when needed.
const recentNineAm = () => {
  const d = new Date()
  d.setHours(9, 0, 0, 0)
  if (d.getTime() > Date.now()) d.setDate(d.getDate() - 1)
  return d
}

describe('taskSchedule', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: no saved schedule → use defaults
    readJSONFile.mockResolvedValue(null)
  })

  describe('INTERVAL_TYPES', () => {
    it('should define all expected interval types', () => {
      expect(INTERVAL_TYPES.ROTATION).toBe('rotation')
      expect(INTERVAL_TYPES.DAILY).toBe('daily')
      expect(INTERVAL_TYPES.WEEKLY).toBe('weekly')
      expect(INTERVAL_TYPES.ONCE).toBe('once')
      expect(INTERVAL_TYPES.ON_DEMAND).toBe('on-demand')
      expect(INTERVAL_TYPES.CUSTOM).toBe('custom')
      expect(INTERVAL_TYPES.CRON).toBe('cron')
      expect(INTERVAL_TYPES.PERPETUAL).toBe('perpetual')
    })
  })

  describe('SELF_IMPROVEMENT_TASK_TYPES', () => {
    it('should be an array of strings', () => {
      expect(Array.isArray(SELF_IMPROVEMENT_TASK_TYPES)).toBe(true)
      expect(SELF_IMPROVEMENT_TASK_TYPES.length).toBeGreaterThan(0)
      for (const t of SELF_IMPROVEMENT_TASK_TYPES) {
        expect(typeof t).toBe('string')
      }
    })

    it('should include core task types', () => {
      expect(SELF_IMPROVEMENT_TASK_TYPES).toContain('security')
      expect(SELF_IMPROVEMENT_TASK_TYPES).toContain('code-quality')
      expect(SELF_IMPROVEMENT_TASK_TYPES).toContain('test-coverage')
      expect(SELF_IMPROVEMENT_TASK_TYPES).toContain('performance')
      expect(SELF_IMPROVEMENT_TASK_TYPES).toContain('dependency-updates')
      expect(SELF_IMPROVEMENT_TASK_TYPES).toContain('do-replan')
    })
  })

  describe('TASK_TYPE_DESCRIPTIONS', () => {
    // Guards against the "orphaned task" bug: a task type with no description
    // entry falls back to a dasherized label ("claim work") in the schedule UI,
    // which reads as a legacy leftover. Every scheduled task type must carry an
    // explicit, human-readable blurb.
    it('has an explicit description for every SELF_IMPROVEMENT_TASK_TYPES entry', () => {
      const missing = SELF_IMPROVEMENT_TASK_TYPES.filter(
        (t) => !Object.prototype.hasOwnProperty.call(TASK_TYPE_DESCRIPTIONS, t)
      )
      expect(missing).toEqual([])
    })

    it('has no description keys that are not real task types', () => {
      const orphaned = Object.keys(TASK_TYPE_DESCRIPTIONS).filter(
        (t) => !SELF_IMPROVEMENT_TASK_TYPES.includes(t)
      )
      expect(orphaned).toEqual([])
    })

    it('every description is a non-empty string', () => {
      for (const [taskType, desc] of Object.entries(TASK_TYPE_DESCRIPTIONS)) {
        expect(typeof desc, taskType).toBe('string')
        expect(desc.trim().length, taskType).toBeGreaterThan(0)
      }
    })
  })

  describe('layered-intelligence (programmatic-I/O agent task)', () => {
    it('is registered as a self-improvement task with a description and a daily default', () => {
      expect(SELF_IMPROVEMENT_TASK_TYPES).toContain('layered-intelligence');
      expect(TASK_TYPE_DESCRIPTIONS['layered-intelligence']).toBeTruthy();
      expect(DEFAULT_TASK_INTERVALS['layered-intelligence']).toMatchObject({ type: 'daily', enabled: false });
    });

    it('has NO default prompt — the buildTaskInput hook renders it', () => {
      // LI runs as a normal reasoning agent with buildTaskInput/processTaskOutput
      // hooks (taskTypeHooks.js); the handler-backed dispatch was removed entirely.
      // The buildTaskInput hook renders the prompt, so there is no
      // DEFAULT_TASK_PROMPTS entry.
      expect(DEFAULT_TASK_PROMPTS['layered-intelligence']).toBeUndefined();
    });

    it('pins the throwaway-worktree posture so the reasoning agent can not land code', () => {
      expect(DEFAULT_TASK_INTERVALS['layered-intelligence'].taskMetadata).toMatchObject({
        useWorktree: true, openPR: false, discardWorktree: true
      });
    });

    it('honors a per-app numeric intervalMs override via the CUSTOM branch', async () => {
      const { getAppTaskTypeInterval, getAppTaskTypeIntervalMs } = await import('./apps.js');
      mockSchedule({
        tasks: { 'layered-intelligence': { type: 'daily', enabled: true, providerId: null, model: null, prompt: null } },
        executions: { 'task:layered-intelligence': { lastRun: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), count: 1, perApp: { 'app-1': { lastRun: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), count: 1 } } } }
      });
      getAppTaskTypeInterval.mockResolvedValue('custom');
      getAppTaskTypeIntervalMs.mockResolvedValue(60 * 60 * 1000); // hourly → 2h since last run ⇒ due
      const res = await shouldRunTask('layered-intelligence', 'app-1');
      expect(res.shouldRun).toBe(true);
      getAppTaskTypeInterval.mockResolvedValue(null);
      getAppTaskTypeIntervalMs.mockResolvedValue(null);
    });
  });

  describe('do-replan task type', () => {
    it('should default to weekly, disabled, with worktree+PR metadata', async () => {
      const interval = await getTaskInterval('do-replan')
      expect(interval.type).toBe('weekly')
      expect(interval.enabled).toBe(false)
      expect(interval.taskMetadata?.useWorktree).toBe(true)
      expect(interval.taskMetadata?.openPR).toBe(true)
    })

    it('should expose a default prompt that delegates to the slashdo command', () => {
      const prompt = getDefaultPrompt('do-replan')
      expect(prompt).toBeDefined()
      expect(prompt).toContain('Replan')
      expect(prompt).toContain('{appName}')
      expect(prompt).toContain('{repoPath}')
      expect(prompt).toContain('{slashdoReplan}')
    })
  })

  describe('loadSchedule', () => {
    it('should return default schedule when no file exists', async () => {
      readJSONFile.mockResolvedValue(null)
      const schedule = await loadSchedule()
      expect(schedule.version).toBe(2)
      expect(schedule.tasks).toBeDefined()
      expect(schedule.executions).toBeDefined()
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

    it('should merge defaults for missing task types', async () => {
      mockSchedule({
        tasks: { 'security': { type: 'weekly', enabled: true, providerId: null, model: null, prompt: null } }
      })

      const schedule = await loadSchedule()
      // Should have all default task types even though only security was saved
      expect(schedule.tasks['code-quality']).toBeDefined()
      expect(schedule.tasks['test-coverage']).toBeDefined()
    })
  })

  describe('basic-task prompt genericization (PortOS → {appName})', () => {
    // Installs created before the Jan→Feb 2026 genericization stored a default that
    // hardcoded "PortOS" as the target app. These tasks were never versioned, so
    // they never auto-upgraded — and worse, an install that upgraded past the
    // promptVersion introduction got the old PortOS default mis-flagged
    // promptCustomized:true. The fix: version the basic tasks, list the old
    // defaults in PREVIOUS_DEFAULT_PROMPTS, and self-heal the mis-flag in
    // loadSchedule so every install converges on the generic {appName} body.
    const portosDocPrompt = PREVIOUS_DEFAULT_PROMPTS['documentation'].find((p) => p.includes('PortOS'))

    it('versions the basic self-improvement tasks so deployed installs can auto-upgrade', () => {
      for (const t of ['security', 'code-quality', 'test-coverage', 'performance', 'accessibility',
        'dependency-updates', 'documentation', 'ui-bugs', 'mobile-responsive', 'release-check']) {
        expect(PROMPT_VERSIONS[t], `PROMPT_VERSIONS['${t}']`).toBeGreaterThanOrEqual(2)
      }
    })

    it('the current documentation default no longer hardcodes PortOS', () => {
      expect(DEFAULT_TASK_PROMPTS['documentation']).not.toContain('PortOS')
      expect(DEFAULT_TASK_PROMPTS['documentation']).toContain('{appName}')
    })

    it('upgrades a stale, non-customized PortOS default (promptVersion: 1) to the generic body', async () => {
      mockSchedule({
        tasks: { 'documentation': { type: 'once', enabled: false, providerId: null, model: null, prompt: portosDocPrompt, promptVersion: 1 } }
      })
      const schedule = await loadSchedule()
      const doc = schedule.tasks['documentation']
      expect(doc.prompt).toBe(DEFAULT_TASK_PROMPTS['documentation'])
      expect(doc.prompt).not.toContain('PortOS')
      expect(doc.promptVersion).toBe(PROMPT_VERSIONS['documentation'])
    })

    it('upgrades a pre-versioning PortOS default (promptVersion undefined) via the legacy-migration path', async () => {
      mockSchedule({
        tasks: { 'documentation': { type: 'once', enabled: false, providerId: null, model: null, prompt: portosDocPrompt } }
      })
      const schedule = await loadSchedule()
      expect(schedule.tasks['documentation'].prompt).toBe(DEFAULT_TASK_PROMPTS['documentation'])
      expect(schedule.tasks['documentation'].prompt).not.toContain('PortOS')
    })

    it('self-heals a mis-flagged promptCustomized that actually matches a known previous default, then upgrades', async () => {
      mockSchedule({
        tasks: { 'documentation': { type: 'once', enabled: false, providerId: null, model: null, prompt: portosDocPrompt, promptVersion: 1, promptCustomized: true } }
      })
      const schedule = await loadSchedule()
      const doc = schedule.tasks['documentation']
      expect(doc.promptCustomized).toBe(false)
      expect(doc.prompt).toBe(DEFAULT_TASK_PROMPTS['documentation'])
      expect(doc.promptVersion).toBe(PROMPT_VERSIONS['documentation'])
    })

    it('preserves a genuine user customization even when it mentions PortOS', async () => {
      const custom = 'My own documentation prompt that happens to mention PortOS but matches no shipped default.'
      mockSchedule({
        tasks: { 'documentation': { type: 'once', enabled: false, providerId: null, model: null, prompt: custom, promptCustomized: true } }
      })
      const schedule = await loadSchedule()
      expect(schedule.tasks['documentation'].prompt).toBe(custom)
      expect(schedule.tasks['documentation'].promptCustomized).toBe(true)
    })
  })

  describe('getTaskInterval', () => {
    it('should return interval for known task type', async () => {
      const interval = await getTaskInterval('security')
      expect(interval.type).toBe('weekly')
    })

    it('should return disabled defaults for unknown task type', async () => {
      const interval = await getTaskInterval('unknown-task')
      expect(interval.enabled).toBe(false)
    })

    it('reference-watch default is writable so the v3 prompt can record proposals (PLAN.md commit or gh/glab issue create)', async () => {
      // The v3 reference-watch prompt records proposals in the app's resolved
      // work tracker: the PLAN.md path appends slug-tagged checklist items and
      // commits them; the GitHub/GitLab paths shell out to `gh`/`glab issue
      // create`. Both need a writable agent — if `readOnly` flips back to true,
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

    it('reference-watch v3 prompt requires a writable default so it can record proposals (PLAN.md commit or gh/glab issue create) (issue #734)', () => {
      // The coupling the audit anchor protects: at the audited version (v3), the prompt
      // writes to the resolved tracker (PLAN.md commit, or `gh`/`glab issue create`), so the
      // raw default must be writable. If a future re-audit flips
      // REFERENCE_WATCH_AUDITED_VERSION to a propose-only version, update this expectation
      // alongside the default and the anchor.
      if (REFERENCE_WATCH_AUDITED_VERSION === 3) {
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
      // Non-managed flags pass through untouched
      expect(schedule.tasks['plan-task'].taskMetadata.simplify).toBe(true)
    })

    it('exposes managedAgentOptions in getScheduleStatus for plan-task', async () => {
      mockSchedule()
      const status = await getScheduleStatus()
      expect(status.tasks['plan-task'].managedAgentOptions).toEqual(['useWorktree', 'openPR'])
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

  describe('getExecutionHistory', () => {
    it('should return empty history for unexecuted task', async () => {
      mockSchedule()
      const history = await getExecutionHistory('never-ran-task')
      expect(history.lastRun).toBeNull()
      expect(history.count).toBe(0)
      expect(history.perApp).toEqual({})
    })

    it('should return existing execution data', async () => {
      mockSchedule({
        executions: { 'task:my-task': { lastRun: '2025-06-01T00:00:00Z', count: 3, perApp: {} } }
      })
      const history = await getExecutionHistory('my-task')
      expect(history.lastRun).toBe('2025-06-01T00:00:00Z')
      expect(history.count).toBe(3)
    })
  })

  describe('shouldRunTask', () => {
    it('should not run disabled task', async () => {
      mockSchedule({
        tasks: { 'disabled-task': { type: 'weekly', enabled: false, providerId: null, model: null, prompt: null } }
      })
      const result = await shouldRunTask('disabled-task')
      expect(result.shouldRun).toBe(false)
      expect(result.reason).toBe('disabled')
    })

    it('should run rotation tasks immediately', async () => {
      readJSONFile.mockResolvedValue({
        version: 2,
        tasks: {
          'code-quality': { type: 'rotation', enabled: true, providerId: null, model: null, prompt: null }
        },
        executions: {}
      })

      const result = await shouldRunTask('code-quality')
      expect(result.shouldRun).toBe(true)
      expect(result.reason).toBe('rotation')
    })

    it('should not run on-demand tasks automatically', async () => {
      mockSchedule({
        tasks: { 'ui-bugs': { type: 'on-demand', enabled: true, providerId: null, model: null, prompt: null } }
      })

      const result = await shouldRunTask('ui-bugs')
      expect(result.shouldRun).toBe(false)
      expect(result.reason).toBe('on-demand-only')
    })

    it('should run once-type task on first run', async () => {
      mockSchedule({
        tasks: { 'accessibility': { type: 'once', enabled: true, providerId: null, model: null, prompt: null } }
      })

      const result = await shouldRunTask('accessibility')
      expect(result.shouldRun).toBe(true)
      expect(result.reason).toBe('once-first-run')
    })

    it('should not run once-type task after completion', async () => {
      mockSchedule({
        tasks: { 'accessibility': { type: 'once', enabled: true, providerId: null, model: null, prompt: null } },
        executions: { 'task:accessibility': { lastRun: '2025-01-01T00:00:00Z', count: 1, perApp: {} } }
      })

      const result = await shouldRunTask('accessibility')
      expect(result.shouldRun).toBe(false)
      expect(result.reason).toBe('once-completed')
    })

    it('should skip weekday-only tasks on weekends', async () => {
      getLocalParts.mockReturnValue({ dayOfWeek: 0 }) // Sunday

      mockSchedule({
        tasks: { 'pr-reviewer': { type: 'custom', intervalMs: 7200000, enabled: true, weekdaysOnly: true, providerId: null, model: null, prompt: null } }
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

    it('should run daily task when enough time has passed', async () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()

      // Explicit runAfter: [] overrides the feature-ideas default that depends on do-replan
      mockSchedule({
        tasks: { 'feature-ideas': { type: 'daily', enabled: true, providerId: null, model: null, prompt: null, runAfter: [] } },
        executions: { 'task:feature-ideas': { lastRun: twoDaysAgo, count: 1, perApp: {} } }
      })

      const result = await shouldRunTask('feature-ideas')
      expect(result.shouldRun).toBe(true)
      expect(result.reason).toContain('daily-due')
    })

    it('should not run daily task when in cooldown', async () => {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()

      mockSchedule({
        tasks: { 'feature-ideas': { type: 'daily', enabled: true, providerId: null, model: null, prompt: null, runAfter: [] } },
        executions: { 'task:feature-ideas': { lastRun: oneHourAgo, count: 5, perApp: {} } }
      })

      const result = await shouldRunTask('feature-ideas')
      expect(result.shouldRun).toBe(false)
      expect(result.reason).toContain('daily-cooldown')
    })

    it('feature-ideas waits on do-replan when do-replan is enabled', async () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()

      // Default runAfter:['do-replan'] kicks in since the test doesn't override it
      mockSchedule({
        tasks: {
          'feature-ideas': { type: 'daily', enabled: true, providerId: null, model: null, prompt: null },
          'do-replan':     { type: 'weekly', enabled: true, providerId: null, model: null, prompt: null }
        },
        executions: { 'task:feature-ideas': { lastRun: twoDaysAgo, count: 1, perApp: {} } }
      })

      const result = await shouldRunTask('feature-ideas')
      expect(result.shouldRun).toBe(false)
      expect(result.reason).toBe('waiting-on-dependencies')
      expect(result.pendingDeps).toContain('do-replan')
    })

    it('feature-ideas runs when do-replan dependency is globally disabled', async () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()

      // do-replan is disabled — feature-ideas would otherwise wait forever, so the dep is skipped
      mockSchedule({
        tasks: {
          'feature-ideas': { type: 'daily', enabled: true, providerId: null, model: null, prompt: null },
          'do-replan':     { type: 'weekly', enabled: false, providerId: null, model: null, prompt: null }
        },
        executions: { 'task:feature-ideas': { lastRun: twoDaysAgo, count: 1, perApp: {} } }
      })

      const result = await shouldRunTask('feature-ideas')
      expect(result.shouldRun).toBe(true)
      expect(result.reason).toContain('daily-due')
    })

    it('feature-ideas runs when do-replan dependency is disabled for the app', async () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()

      mockSchedule({
        tasks: {
          'feature-ideas': { type: 'daily', enabled: true, providerId: null, model: null, prompt: null },
          'do-replan':     { type: 'weekly', enabled: true, providerId: null, model: null, prompt: null }
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
        expect(result.reason).toContain('daily-due')
      } finally {
        if (originalIsTaskTypeEnabledForApp) {
          isTaskTypeEnabledForApp.mockImplementation(originalIsTaskTypeEnabledForApp)
        } else {
          isTaskTypeEnabledForApp.mockReset()
        }
      }
    })

    it('feature-ideas runs when do-replan has run since its last run', async () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

      mockSchedule({
        tasks: {
          'feature-ideas': { type: 'daily', enabled: true, providerId: null, model: null, prompt: null },
          'do-replan':     { type: 'weekly', enabled: true, providerId: null, model: null, prompt: null }
        },
        executions: {
          'task:feature-ideas': { lastRun: twoDaysAgo, count: 1, perApp: {} },
          'task:do-replan':     { lastRun: oneDayAgo, count: 1, perApp: {} }
        }
      })

      const result = await shouldRunTask('feature-ideas')
      expect(result.shouldRun).toBe(true)
      expect(result.reason).toContain('daily-due')
    })

    describe('cron catch-up', () => {
      it('catches up a never-run cron when the missed slot elapsed after the task was created', async () => {
        // Cron: 0 9 * * * (daily 9 AM). The task was configured yesterday and the
        // daemon missed today's 9 AM slot — so the elapsed slot is genuinely missed
        // and should fire now. The catch-up bound is the task's createdAt.
        const todayNineAm = recentNineAm()
        const twoDaysAgo = new Date(todayNineAm.getTime() - 2 * 24 * 60 * 60 * 1000)

        parseCronToPrevRun.mockReturnValueOnce(todayNineAm) // most-recent past occurrence
        parseCronToNextRun.mockReturnValueOnce(new Date(todayNineAm.getTime() + 24 * 60 * 60 * 1000))

        mockSchedule({
          tasks: {
            'plan-task': { type: 'cron', enabled: true, cronExpression: '0 9 * * *', providerId: null, model: null, prompt: null, createdAt: twoDaysAgo.toISOString() }
          }
        })

        const result = await shouldRunTask('plan-task')
        expect(result.shouldRun).toBe(true)
        expect(result.reason).toBe('cron-catch-up')
        expect(result.missedSlot).toBe(todayNineAm.toISOString())
      })

      it('does NOT catch up a never-run cron whose most-recent slot predates the task', async () => {
        // The reported bug: a weekly "Sunday 09:00" task enabled mid-week must NOT
        // immediately fire for last Sunday's slot — that slot elapsed before the
        // task existed, so there was nothing to miss. It waits for the next Sunday.
        const now = Date.now()
        const lastSunday = new Date(now - 3 * 24 * 60 * 60 * 1000)      // slot before creation
        const nextSunday = new Date(now + 4 * 24 * 60 * 60 * 1000)
        const createdYesterday = new Date(now - 1 * 24 * 60 * 60 * 1000) // task created after last Sunday

        parseCronToPrevRun.mockReturnValueOnce(lastSunday)
        parseCronToNextRun.mockReturnValue(nextSunday)

        mockSchedule({
          tasks: {
            'branch-cleanup': { type: 'cron', enabled: true, cronExpression: '0 9 * * 0', providerId: null, model: null, prompt: null, createdAt: createdYesterday.toISOString() }
          }
        })

        const result = await shouldRunTask('branch-cleanup')
        expect(result.shouldRun).toBe(false)
        expect(result.reason).toBe('cron-cooldown')
      })

      it('catches up after the recorded lastRun even if the daemon missed the slot', async () => {
        // Cron fired yesterday, then daemon was down across today's 9 AM.
        // Catch-up bound is the recorded lastRun (yesterday), so today's 9 AM counts as missed.
        const todayNineAm = recentNineAm()
        const yesterdayNineAm = new Date(todayNineAm.getTime() - 24 * 60 * 60 * 1000)

        parseCronToPrevRun.mockReturnValueOnce(todayNineAm)
        parseCronToNextRun.mockReturnValueOnce(new Date(todayNineAm.getTime() + 24 * 60 * 60 * 1000))

        mockSchedule({
          tasks: {
            'plan-task': { type: 'cron', enabled: true, cronExpression: '0 9 * * *', providerId: null, model: null, prompt: null }
          },
          executions: {
            'task:plan-task': { lastRun: yesterdayNineAm.toISOString(), count: 1, perApp: {} }
          }
        })

        const result = await shouldRunTask('plan-task')
        expect(result.shouldRun).toBe(true)
        expect(result.reason).toBe('cron-catch-up')
      })

      it('does NOT catch up when lastRun already covers the most-recent slot', async () => {
        // Cron fired this morning at 9 AM; lastRun is at the same 9 AM.
        // prevRun == lastRun → not strictly greater → no catch-up.
        const todayNineAm = recentNineAm()
        const tomorrowNineAm = new Date(todayNineAm.getTime() + 24 * 60 * 60 * 1000)

        parseCronToPrevRun.mockReturnValueOnce(todayNineAm)
        parseCronToNextRun.mockReturnValueOnce(tomorrowNineAm)

        mockSchedule({
          tasks: {
            'plan-task': { type: 'cron', enabled: true, cronExpression: '0 9 * * *', providerId: null, model: null, prompt: null }
          },
          executions: {
            'task:plan-task': { lastRun: todayNineAm.toISOString(), count: 1, perApp: {} }
          }
        })

        const result = await shouldRunTask('plan-task')
        expect(result.shouldRun).toBe(false)
        expect(result.reason).toBe('cron-cooldown')
      })
    })
  })

  describe('getDueTasks', () => {
    it('should return empty array when no tasks are enabled', async () => {
      mockSchedule({
        tasks: { 'security': { type: 'weekly', enabled: false, providerId: null, model: null, prompt: null } }
      })
      const due = await getDueTasks()
      expect(due).toEqual([])
    })

    it('should return enabled rotation tasks', async () => {
      mockSchedule({
        tasks: {
          'code-quality': { type: 'rotation', enabled: true, providerId: null, model: null, prompt: null },
          'security': { type: 'weekly', enabled: false, providerId: null, model: null, prompt: null }
        }
      })

      const due = await getDueTasks()
      expect(due.length).toBe(1)
      expect(due[0].taskType).toBe('code-quality')
    })
  })

  describe('getNextTaskType', () => {
    it('should return null when no tasks are enabled', async () => {
      mockSchedule({
        tasks: { 'security': { type: 'weekly', enabled: false, providerId: null, model: null, prompt: null } }
      })
      const result = await getNextTaskType()
      expect(result).toBeNull()
    })

    it('should return rotation task', async () => {
      mockSchedule({
        tasks: {
          'code-quality': { type: 'rotation', enabled: true, providerId: null, model: null, prompt: null },
          'error-handling': { type: 'rotation', enabled: true, providerId: null, model: null, prompt: null }
        }
      })

      const result = await getNextTaskType()
      expect(result).toBeDefined()
      expect(result.reason).toBe('rotation')
    })

    it('should rotate to next task after last type', async () => {
      mockSchedule({
        tasks: {
          'code-quality': { type: 'rotation', enabled: true, providerId: null, model: null, prompt: null },
          'error-handling': { type: 'rotation', enabled: true, providerId: null, model: null, prompt: null }
        }
      })

      const result = await getNextTaskType(null, 'code-quality')
      expect(result.taskType).toBe('error-handling')
    })

    it('prefers a due cron task over a perpetually-ready weekly task', async () => {
      // A weekly task with no execution record is perpetually 'ready' (weekly-due).
      // A cron task firing right now should still win — explicit time-based schedules
      // shouldn't get masked by loose interval-based ones.
      const todayNineAm = recentNineAm()
      const tomorrowNineAm = new Date(todayNineAm.getTime() + 24 * 60 * 60 * 1000)
      const yesterdayNineAm = new Date(todayNineAm.getTime() - 24 * 60 * 60 * 1000)

      // shouldRunTask iterates both tasks. plan-task was created before its missed
      // slot (createdAt bound), so its elapsed 9 AM counts as a genuine catch-up.
      parseCronToPrevRun.mockReturnValueOnce(todayNineAm) // plan-task prevRun
      parseCronToNextRun.mockReturnValue(tomorrowNineAm)

      mockSchedule({
        tasks: {
          'code-quality': { type: 'weekly', enabled: true, providerId: null, model: null, prompt: null, runAfter: [] },
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
      const tomorrowNineAm = new Date(todayNineAm.getTime() + 24 * 60 * 60 * 1000)
      const yesterdayNineAm = new Date(todayNineAm.getTime() - 24 * 60 * 60 * 1000)
      parseCronToPrevRun.mockReturnValueOnce(todayNineAm)
      parseCronToNextRun.mockReturnValue(tomorrowNineAm)

      mockSchedule({
        tasks: {
          'pr-watcher':  { type: 'cron', enabled: true, cronExpression: '0 9 * * *', providerId: null, model: null, prompt: null, createdAt: yesterdayNineAm.toISOString() },
          'claim-issue': { type: 'perpetual', enabled: true, providerId: null, model: null, prompt: null }
        }
      })

      // Unconstrained: cron wins.
      const unconstrained = await getNextTaskType()
      expect(unconstrained.taskType).toBe('pr-watcher')

      // perpetualOnly: the perpetual drain is returned instead.
      const constrained = await getNextTaskType(null, '', { perpetualOnly: true })
      expect(constrained).not.toBeNull()
      expect(constrained.taskType).toBe('claim-issue')
      expect(constrained.reason).toBe('perpetual-drain')
    })

    it('perpetualOnly returns null when no perpetual task is due (app stays throttled)', async () => {
      mockSchedule({
        tasks: {
          'code-quality':  { type: 'rotation', enabled: true, providerId: null, model: null, prompt: null },
          'error-handling': { type: 'rotation', enabled: true, providerId: null, model: null, prompt: null }
        }
      })
      const result = await getNextTaskType(null, '', { perpetualOnly: true })
      expect(result).toBeNull()
    })
  })

  describe('templates', () => {
    it('should add a template task', async () => {
      const template = {
        name: 'Custom audit',
        prompt: 'Run custom audit',
        priority: 'HIGH'
      }

      const result = await addTemplateTask(template)
      expect(result.id).toBeDefined()
      expect(result.name).toBe('Custom audit')
    })

    it('should get template tasks', async () => {
      const templates = await getTemplateTasks()
      expect(Array.isArray(templates)).toBe(true)
    })

    it('should delete template task', async () => {
      const template = await addTemplateTask({ name: 'To delete', prompt: 'test' })
      const result = await deleteTemplateTask(template.id)
      expect(result.success).toBe(true)
    })
  })

  describe('getDefaultPrompt', () => {
    it('should return prompt for known task type', () => {
      const prompt = getDefaultPrompt('security')
      expect(prompt).toBeDefined()
      expect(prompt).toContain('Security')
    })

    it('should return null for unknown task type', () => {
      const prompt = getDefaultPrompt('nonexistent')
      expect(prompt).toBeNull()
    })
  })

  describe('getTaskPrompt', () => {
    it('should return default prompt when no custom prompt set', async () => {
      const prompt = await getTaskPrompt('security')
      expect(prompt).toBeDefined()
      expect(prompt).toContain('Security')
    })

    it('should return fallback prompt for unknown task type', async () => {
      const prompt = await getTaskPrompt('unknown-type')
      expect(prompt).toContain('unknown-type')
      expect(prompt).toContain('{repoPath}')
    })

    it('should substitute {slashdoReplan} with the bundled replan command body', async () => {
      const { loadSlashdoFile } = await import('../lib/fileUtils.js')
      loadSlashdoFile.mockResolvedValueOnce('# Replan Command\n\nSentinel body for substitution test.')
      const prompt = await getTaskPrompt('do-replan')
      expect(prompt).not.toContain('{slashdoReplan}')
      expect(prompt).toContain('Sentinel body for substitution test.')
      expect(loadSlashdoFile).toHaveBeenCalledWith('replan', { stripFrontmatter: true })
    })

    it('plan-task default self-picks like /claim — no scheduler pre-pick / Item Constraint', async () => {
      // The agent picks its own slug at execution time (Phase 1) rather than
      // accepting a slug the scheduler pre-reserved. Pin the absence of the
      // pre-pick scaffolding so a future edit can't quietly reintroduce the
      // dispatch-time reservation race (see cos.js PLAN_SELF_CLAIM_TASK_TYPES).
      const prompt = await getTaskPrompt('plan-task')
      expect(prompt).not.toContain('{planConstraint}')
      expect(prompt).not.toContain('Item Constraint')
      expect(prompt).not.toContain('scheduler pre-reserved')
      // It still drives the /claim flow: in-flight scan + claim/<slug> branch.
      expect(prompt).toContain('claim/<slug>')
      expect(prompt).toContain('in-flight set')
    })

    it('claim-issue drives the /claim --issues flow against GitHub issues', async () => {
      const prompt = await getTaskPrompt('claim-issue')
      // Work source is the GitHub issue tracker, not PLAN.md.
      expect(prompt).toContain('claim/issue-')
      expect(prompt).toContain('gh issue list')
      expect(prompt).toContain('Closes #')
      // The author-filter placeholder is substituted at dispatch time
      // (cosTaskGenerator), so it stays literal in the raw stored prompt.
      expect(prompt).toContain('{issueAuthorFilter}')
      // Issues mode ships GitHub issues only — it explicitly does not touch PLAN.md.
      expect(prompt).toContain('does NOT touch PLAN.md')
    })
  })

  describe('claim-issue defaults', () => {
    it('is registered as a self-improvement task type', () => {
      expect(SELF_IMPROVEMENT_TASK_TYPES).toContain('claim-issue')
    })

    it('defaults to self-filed issues with worktree/PR managed by the agent', () => {
      const cfg = DEFAULT_TASK_INTERVALS['claim-issue']
      expect(cfg.type).toBe(INTERVAL_TYPES.DAILY)
      expect(cfg.enabled).toBe(false)
      // Default is the slashdo /do:next --self security boundary.
      expect(cfg.taskMetadata.issueAuthorFilter).toBe('self')
      // Mirrors plan-task: the agent creates its own worktree + opens the PR,
      // so CoS must keep both off (and lock them).
      expect(cfg.taskMetadata.useWorktree).toBe(false)
      expect(cfg.taskMetadata.openPR).toBe(false)
      expect(MANAGED_AGENT_OPTIONS['claim-issue']).toEqual(['useWorktree', 'openPR'])
    })
  })

  describe('refresh-local-llm-catalog defaults', () => {
    it('is registered as a self-improvement task type', () => {
      expect(SELF_IMPROVEMENT_TASK_TYPES).toContain('refresh-local-llm-catalog')
    })

    it('defaults to weekly, disabled, with CoS-managed worktree + PR', () => {
      const cfg = DEFAULT_TASK_INTERVALS['refresh-local-llm-catalog']
      expect(cfg.type).toBe(INTERVAL_TYPES.WEEKLY)
      expect(cfg.enabled).toBe(false)
      // CoS manages the worktree + PR (like feature-ideas), so these are NOT
      // in MANAGED_AGENT_OPTIONS (the user could turn them off if they wanted).
      expect(cfg.taskMetadata.useWorktree).toBe(true)
      expect(cfg.taskMetadata.openPR).toBe(true)
      expect(MANAGED_AGENT_OPTIONS['refresh-local-llm-catalog']).toBeUndefined()
    })

    it('prompt guards on the PortOS catalog file and targets the catalog + ranking', async () => {
      const prompt = await getTaskPrompt('refresh-local-llm-catalog')
      // No-ops on any repo lacking the catalog file (so enabling on a non-PortOS app is safe).
      expect(prompt).toContain('server/lib/localLlmCatalog.js')
      expect(prompt).toContain('LOCAL_LLM_CATALOG')
      expect(prompt).toContain('EDITORIAL_FAMILY_RANK')
      // Must not open an empty PR when nothing changed (phrase may be line-wrapped).
      expect(prompt).toContain('empty PR')
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

    it('should reject when the task type is disabled (cheaper check runs first)', async () => {
      mockSchedule({
        tasks: { 'feature-ideas': { type: 'weekly', enabled: false } }
      })

      const result = await triggerOnDemandTask('feature-ideas', 'critical-mass')

      expect(result.error).toMatch(/'feature-ideas' is disabled/i)
      // loadState should not have been called — task-type check short-circuits before loadState.
      expect(loadState).not.toHaveBeenCalled()
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
  })

  describe('getScheduleStatus', () => {
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
  })

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
        mockSchedule({ tasks: { 'claim-issue': { type: 'perpetual', enabled: true } } })
        const result = await shouldRunTask('claim-issue')
        expect(result.shouldRun).toBe(true)
        expect(result.reason).toBe('perpetual-drain')
      })

      it('is NOT due while parked in the future', async () => {
        const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
        mockSchedule({
          tasks: { 'claim-issue': { type: 'perpetual', enabled: true } },
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
          tasks: { 'claim-issue': { type: 'perpetual', enabled: true } },
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
          tasks: { 'claim-issue': { type: 'perpetual', enabled: true } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: { 'app-1': { lastRun: null, count: 0, parkedUntil: future } } } }
        })
        const result = await shouldRunTask('claim-issue', 'app-1')
        expect(result.shouldRun).toBe(false)
        expect(result.reason).toBe('perpetual-parked')
      })
    })

    describe('getNextTaskType', () => {
      it('prioritizes a draining perpetual task over a due daily task', async () => {
        mockSchedule({
          tasks: {
            'claim-issue': { type: 'perpetual', enabled: true },
            'security': { type: 'daily', enabled: true }
          }
        })
        const next = await getNextTaskType()
        expect(next.taskType).toBe('claim-issue')
        expect(next.reason).toBe('perpetual-drain')
      })

      it('does not pick a parked perpetual task — yields to the daily', async () => {
        const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
        mockSchedule({
          tasks: {
            'claim-issue': { type: 'perpetual', enabled: true },
            'security': { type: 'daily', enabled: true }
          },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: {}, parkedUntil: future } }
        })
        const next = await getNextTaskType()
        expect(next.taskType).toBe('security')
      })
    })

    describe('parkPerpetual / clearPerpetualPark', () => {
      it('parkPerpetual stamps parkedUntil + reason on the per-app record', async () => {
        mockSchedule({ tasks: { 'claim-issue': { type: 'perpetual', enabled: true, recheckIntervalMs: 3600000 } } })
        const record = await parkPerpetual('claim-issue', 'app-1', { reason: 'no-actionable-issues', actionableCount: 0, counts: { open: 40, inFlight: 2, filtered: 38 } })
        expect(record.parkedUntil).toBeTruthy()
        expect(record.parkReason).toBe('no-actionable-issues')
        expect(record.parkActionableCount).toBe(0)
        expect(record.parkCounts).toEqual({ open: 40, inFlight: 2, filtered: 38 })
      })

      it('getPerpetualParkInfo reads back the park record (and null when not parked)', async () => {
        const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
        mockSchedule({
          tasks: { 'claim-issue': { type: 'perpetual', enabled: true } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: {
            'app-1': { lastRun: null, count: 0, parkedUntil: future, parkReason: 'no-actionable-issues', parkActionableCount: 0, parkCounts: { open: 40, inFlight: 2, filtered: 38 } },
            'app-2': { lastRun: null, count: 0 }
          } } }
        })
        const info = await getPerpetualParkInfo('claim-issue', 'app-1')
        expect(info).toMatchObject({ parkedUntil: future, parkReason: 'no-actionable-issues', parkActionableCount: 0, parkCounts: { open: 40, inFlight: 2, filtered: 38 } })
        expect(await getPerpetualParkInfo('claim-issue', 'app-2')).toBeNull()
        expect(await getPerpetualParkInfo('claim-issue', 'unknown-app')).toBeNull()
      })

      it('parkPerpetual omits parkCounts when no breakdown is provided', async () => {
        mockSchedule({ tasks: { 'branch-reconcile': { type: 'perpetual', enabled: true, recheckIntervalMs: 3600000 } } })
        const record = await parkPerpetual('branch-reconcile', 'app-1', { reason: 'no-in-flight-branches', actionableCount: 0, signature: null })
        expect(record.parkCounts).toBeUndefined()
      })

      it('clearPerpetualPark returns true when a park existed', async () => {
        const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
        mockSchedule({
          tasks: { 'claim-issue': { type: 'perpetual', enabled: true } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: { 'app-1': { lastRun: null, count: 0, parkedUntil: future } } } }
        })
        expect(await clearPerpetualPark('claim-issue', 'app-1')).toBe(true)
      })

      it('clearPerpetualPark is a no-op (false) when nothing is parked', async () => {
        mockSchedule({
          tasks: { 'claim-issue': { type: 'perpetual', enabled: true } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: {} } }
        })
        expect(await clearPerpetualPark('claim-issue', 'app-1')).toBe(false)
      })

      it('resetPerpetualForManualRun drops BOTH the park and the convergence signature', async () => {
        const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
        mockSchedule({
          tasks: { 'branch-reconcile': { type: 'perpetual', enabled: true } },
          executions: { 'task:branch-reconcile': { lastRun: null, count: 0, perApp: {
            'app-1': { lastRun: null, count: 0, parkedUntil: future, parkReason: 'no-progress', lastActionableSignature: 'a:NEEDS_PR:none' }
          } } }
        })
        expect(await resetPerpetualForManualRun('branch-reconcile', 'app-1')).toBe(true)
        const saved = JSON.parse(writeFile.mock.calls.at(-1)[1])
        const rec = saved.executions['task:branch-reconcile'].perApp['app-1']
        expect(rec.parkedUntil).toBeUndefined()
        expect(rec.parkReason).toBeUndefined()
        expect(rec.lastActionableSignature).toBeUndefined()
      })

      it('resetPerpetualForManualRun is a no-op (false) when nothing is cached', async () => {
        mockSchedule({
          tasks: { 'claim-issue': { type: 'perpetual', enabled: true } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: { 'app-1': { lastRun: null, count: 0 } } } }
        })
        expect(await resetPerpetualForManualRun('claim-issue', 'app-1')).toBe(false)
      })

      it('parkPerpetual stores an actionable signature and getPerpetualSignature reads it back', async () => {
        mockSchedule({ tasks: { 'branch-reconcile': { type: 'perpetual', enabled: true, recheckIntervalMs: 3600000 } } })
        await parkPerpetual('branch-reconcile', 'app-1', { reason: 'no-progress', actionableCount: 2, signature: 'a:NEEDS_PR:none|b:IN_REVIEW:5' })
        const saved = JSON.parse(writeFile.mock.calls.at(-1)[1])
        expect(saved.executions['task:branch-reconcile'].perApp['app-1'].lastActionableSignature).toBe('a:NEEDS_PR:none|b:IN_REVIEW:5')
      })

      it('getPerpetualSignature returns the stored signature (and null when absent)', async () => {
        mockSchedule({
          tasks: { 'branch-reconcile': { type: 'perpetual', enabled: true } },
          executions: { 'task:branch-reconcile': { lastRun: null, count: 0, perApp: { 'app-1': { lastRun: null, count: 0, lastActionableSignature: 'sig-1' } } } }
        })
        expect(await getPerpetualSignature('branch-reconcile', 'app-1')).toBe('sig-1')
        expect(await getPerpetualSignature('branch-reconcile', 'app-2')).toBeNull()
      })

      it('setPerpetualSignature writes it, and null clears it', async () => {
        mockSchedule({ tasks: { 'branch-reconcile': { type: 'perpetual', enabled: true } } })
        await setPerpetualSignature('branch-reconcile', 'app-1', 'sig-2')
        let saved = JSON.parse(writeFile.mock.calls.at(-1)[1])
        expect(saved.executions['task:branch-reconcile'].perApp['app-1'].lastActionableSignature).toBe('sig-2')

        mockSchedule({
          tasks: { 'branch-reconcile': { type: 'perpetual', enabled: true } },
          executions: { 'task:branch-reconcile': { lastRun: null, count: 0, perApp: { 'app-1': { lastRun: null, count: 0, lastActionableSignature: 'sig-2' } } } }
        })
        await setPerpetualSignature('branch-reconcile', 'app-1', null)
        saved = JSON.parse(writeFile.mock.calls.at(-1)[1])
        expect(saved.executions['task:branch-reconcile'].perApp['app-1'].lastActionableSignature).toBeUndefined()
      })

      it('parkPerpetual with signature:null clears a prior signature (idle park)', async () => {
        mockSchedule({
          tasks: { 'branch-reconcile': { type: 'perpetual', enabled: true, recheckIntervalMs: 3600000 } },
          executions: { 'task:branch-reconcile': { lastRun: null, count: 0, perApp: { 'app-1': { lastRun: null, count: 0, lastActionableSignature: 'old-sig' } } } }
        })
        await parkPerpetual('branch-reconcile', 'app-1', { reason: 'no-in-flight-branches', actionableCount: 0, signature: null })
        const saved = JSON.parse(writeFile.mock.calls.at(-1)[1])
        expect(saved.executions['task:branch-reconcile'].perApp['app-1'].lastActionableSignature).toBeUndefined()
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

      it('getTaskTypeFailureInfo reads back the ledger (0 defaults when absent)', async () => {
        mockSchedule({
          tasks: { security: { type: 'rotation', enabled: true } },
          executions: { 'task:security': { lastRun: null, count: 0, perApp: {
            'app-1': { lastRun: null, count: 0, consecutiveFailures: 2, lastErrorCategory: 'timeout' }
          } } }
        })
        expect(await getTaskTypeFailureInfo('security', 'app-1')).toMatchObject({ consecutiveFailures: 2, lastErrorCategory: 'timeout' })
        expect(await getTaskTypeFailureInfo('security', 'app-2')).toBeNull()
      })

      it('clearTaskTypeFailurePark(appId=null) clears global + every per-app record', async () => {
        mockSchedule({
          tasks: { security: { type: 'rotation', enabled: true } },
          executions: { 'task:security': {
            lastRun: null, count: 0, consecutiveFailures: 4, failureParkedAt: new Date().toISOString(),
            perApp: {
              'app-1': { lastRun: null, count: 0, consecutiveFailures: 5, failureParkedAt: new Date().toISOString() },
              'app-2': { lastRun: null, count: 0, consecutiveFailures: 1 }
            }
          } }
        })
        expect(await clearTaskTypeFailurePark('security')).toBe(true)
        const saved = JSON.parse(writeFile.mock.calls.at(-1)[1])
        const top = saved.executions['task:security']
        expect(top.consecutiveFailures).toBeUndefined()
        expect(top.failureParkedAt).toBeUndefined()
        expect(top.perApp['app-1'].consecutiveFailures).toBeUndefined()
        expect(top.perApp['app-1'].failureParkedAt).toBeUndefined()
        expect(top.perApp['app-2'].consecutiveFailures).toBeUndefined()
      })

      it('shouldRunTask returns failure-parked for a parked ROTATION type', async () => {
        mockSchedule({
          tasks: { security: { type: 'rotation', enabled: true } },
          executions: { 'task:security': { lastRun: null, count: 0, perApp: {
            'app-1': { lastRun: null, count: 0, consecutiveFailures: FAILURE_PARK_THRESHOLD, failureParkedAt: new Date().toISOString(), failureParkReason: 'auth-error' }
          } } }
        })
        const res = await shouldRunTask('security', 'app-1')
        expect(res.shouldRun).toBe(false)
        expect(res.reason).toBe('failure-parked')
        expect(res.failureParkReason).toBe('auth-error')
      })

      it('shouldRunTask applies escalating failure-cooldown to ROTATION (otherwise always-run)', async () => {
        // 2 consecutive failures → backoff = base*4; last failure just now → in cooldown.
        mockSchedule({
          tasks: { security: { type: 'rotation', enabled: true } },
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

      it('shouldRunTask lets ROTATION run once the failure-cooldown has elapsed', async () => {
        // 1 failure → backoff = base*2; last failure long ago → cooldown elapsed.
        const longAgo = new Date(Date.now() - (FAILURE_BACKOFF_CAP_MS + 60_000)).toISOString()
        mockSchedule({
          tasks: { security: { type: 'rotation', enabled: true } },
          executions: { 'task:security': { lastRun: null, count: 0, perApp: {
            'app-1': { lastRun: null, count: 0, consecutiveFailures: 1, lastFailureAt: longAgo }
          } } }
        })
        const res = await shouldRunTask('security', 'app-1')
        expect(res.shouldRun).toBe(true)
        expect(res.reason).toBe('rotation')
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
          tasks: { 'claim-issue': { type: 'perpetual', enabled: true, recheckIntervalMs: 30 * 24 * 60 * 60 * 1000 } },
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
          tasks: { 'claim-issue': { type: 'perpetual', enabled: true } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: { 'app-1': { lastRun: null, count: 0 } } } }
        })
        await updateTaskInterval('claim-issue', { recheckIntervalMs: 1000 })
        const saved = JSON.parse(writeFile.mock.calls.at(-1)[1])
        expect(saved.executions['task:claim-issue'].perApp['app-1'].parkedUntil).toBeUndefined()
      })
    })

    describe('getScheduleStatus per-app park aggregate', () => {
      it('aggregates per-app parks into taskStatus.perpetual', async () => {
        const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
        mockSchedule({
          tasks: { 'claim-issue': { type: 'perpetual', enabled: true } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: {
            'app-1': { lastRun: null, count: 0, parkedUntil: future, parkReason: 'no-actionable-issues' },
            'app-2': { lastRun: null, count: 0 }
          } } }
        })
        const status = await getScheduleStatus()
        const p = status.tasks['claim-issue'].perpetual
        expect(p).toMatchObject({ parkedAppCount: 1, trackedAppCount: 2, globalParked: false, nextRecheckAt: future, parkReason: 'no-actionable-issues' })
      })
    })
  })
})
