import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('./cosEvents.js', () => ({
  cosEvents: { emit: vi.fn() },
  emitLog: vi.fn()
}))

// fileUtils mock: include every named export consumed by ./cosState.js too,
// so vi.importActual('./cosState.js') below resolves cleanly.
vi.mock('../lib/fileUtils.js', () => ({
  ensureDir: vi.fn().mockResolvedValue(),
  ensureDirs: vi.fn().mockResolvedValue(),
  readJSONFile: vi.fn(),
  loadSlashdoFile: vi.fn().mockResolvedValue(''),
  safeJSONParse: (content, fallback) => { try { return JSON.parse(content); } catch { return fallback; } },
  atomicWrite: vi.fn().mockResolvedValue(),
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
  getActiveApps: vi.fn().mockResolvedValue([]),
  getAppTaskTypeOverrides: vi.fn().mockResolvedValue({})
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
  parseCronToNextRun: vi.fn()
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
  getDefaultPrompt,
  getTaskPrompt,
  resetExecutionHistory,
  triggerOnDemandTask,
  getScheduleStatus
} from './taskSchedule.js'

import { loadState } from './cosState.js'

import { readJSONFile } from '../lib/fileUtils.js'
import { isTaskTypeEnabledForApp, getAppTaskTypeInterval } from './apps.js'
import { getLocalParts } from '../lib/timezone.js'
import { getAdaptiveCooldownMultiplier } from './taskLearning.js'

const mockSchedule = ({ tasks = {}, executions = {}, templates = [] } = {}) => {
  readJSONFile.mockResolvedValue({ version: 2, tasks, executions, templates })
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

  describe('getTaskInterval', () => {
    it('should return interval for known task type', async () => {
      const interval = await getTaskInterval('security')
      expect(interval.type).toBe('weekly')
    })

    it('should return disabled defaults for unknown task type', async () => {
      const interval = await getTaskInterval('unknown-task')
      expect(interval.enabled).toBe(false)
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

      mockSchedule({
        tasks: { 'feature-ideas': { type: 'daily', enabled: true, providerId: null, model: null, prompt: null } },
        executions: { 'task:feature-ideas': { lastRun: twoDaysAgo, count: 1, perApp: {} } }
      })

      const result = await shouldRunTask('feature-ideas')
      expect(result.shouldRun).toBe(true)
      expect(result.reason).toContain('daily-due')
    })

    it('should not run daily task when in cooldown', async () => {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()

      mockSchedule({
        tasks: { 'feature-ideas': { type: 'daily', enabled: true, providerId: null, model: null, prompt: null } },
        executions: { 'task:feature-ideas': { lastRun: oneHourAgo, count: 5, perApp: {} } }
      })

      const result = await shouldRunTask('feature-ideas')
      expect(result.shouldRun).toBe(false)
      expect(result.reason).toContain('daily-cooldown')
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
})
