import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

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

// slashdoLoader mock: taskPromptService.js reads the bundled command body
// through loadSlashdoFile — stub it the same way the prior fileUtils mock did,
// now that the slashdo loaders live in their own module (#3110's home moved).
// Operator-action ledger (#5594). Stubbed so the origin gate in
// triggerOnDemandTask can be asserted directly (recorded vs not recorded)
// without this suite's minimal fileUtils stub having to grow a data root.
vi.mock('./userActions.js', () => ({ recordUserAction: vi.fn() }));

vi.mock('../lib/slashdoLoader.js', () => ({
  loadSlashdoFile: vi.fn().mockResolvedValue(''),
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
  clearAllPrWatcherState: vi.fn().mockResolvedValue({ changed: false }),
  clearAllIssueWatcherState: vi.fn().mockResolvedValue({ changed: false })
}))

vi.mock('./instanceFeatures.js', () => ({
  isInstanceFeatureEnabled: vi.fn().mockResolvedValue(true),
}))

vi.mock('../lib/ports.js', () => ({
  PORTOS_UI_URL: 'http://localhost:5554',
  PORTOS_API_URL: 'http://localhost:5555'
}))

vi.mock('../lib/timezone.js', () => ({
  getLocalParts: vi.fn(() => ({ dayOfWeek: 3 })),
}))
vi.mock('./userTimezone.js', () => ({
  getUserTimezone: vi.fn().mockResolvedValue('America/Los_Angeles'),
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
  INSTALL_WIDE_TASK_TYPES,
  SELF_IMPROVEMENT_TASK_TYPES,
  loadSchedule,
  getTaskInterval,
  updateTaskInterval,
  recordExecution,
  getExecutionHistory,
  shouldRunTask,
  getDueTasks,
  getNextTaskType,
  getUpcomingTasks,
  addTemplateTask,
  getTemplateTasks,
  deleteTemplateTask,
  resetExecutionHistory,
  triggerOnDemandTask,
  getOnDemandRequests,
  getScheduleStatus,
  computePerpetualRecheckAt,
  parkPerpetual,
  resetPerpetualForManualRun,
  getPerpetualParkInfo,
  isPerpetualParkActive,
  getPerpetualDrainState,
  recordPerpetualDispatch,
  applyOnDemandRunResets,
  isRefillRequest,
  ON_DEMAND_ORIGINS,
  recordTaskTypeFailure,
  recordTaskTypeSuccess,
  clearTaskTypeFailurePark,
  computeFailureBackoffMs,
  FAILURE_BACKOFF_BASE_MS,
  FAILURE_BACKOFF_CAP_MS,
  FAILURE_PARK_THRESHOLD,
  PROMPT_VERSIONS,
  DEFAULT_TASK_INTERVALS,
  MANAGED_APP_TARGET_TASK_TYPES,
  MANAGED_AGENT_OPTIONS,
  stripManagedAgentOptionsFromOverride,
  TASK_TYPE_DESCRIPTIONS,
  TASK_TYPE_INVOCATION,
  TASK_TYPE_PROMPT_INFO,
  getTaskTypeInvocation,
  requiresManagedAppTarget,
  REFERENCE_WATCH_AUDITED_VERSION,
  boundParkedUntil
} from './taskSchedule.js'
import { cosEvents } from './cosEvents.js'
import { recordUserAction } from './userActions.js'

// Prompt getters moved to taskPromptService.js (issue #744 split, #1083 cycle
// break). taskSchedule.js re-exports the version constants but not the getters.
import {
  getDefaultPrompt,
  getTaskPrompt
} from './taskPromptService.js'

import { DEFAULT_TASK_PROMPTS, PREVIOUS_DEFAULT_PROMPTS } from './taskPromptDefaults.js'

// The source of truth for "this type's deliverable is a side effect, not a commit"
// — the posture guard below iterates it so the two can't drift apart.
import { NON_COMMITTING_COORDINATOR_TASK_TYPES } from './taskTypeHooks.js'
import { enforceManagedAgentOptions } from './taskScheduleRegistry.js'

import { loadState } from './cosState.js'

import { readJSONFile } from '../lib/fileUtils.js'
import { writeFile } from 'fs/promises'
import { isTaskTypeEnabledForApp, getAppTaskTypeInterval, clearAllPrWatcherState, clearAllIssueWatcherState } from './apps.js'
import { getLocalParts } from '../lib/timezone.js'
import { getAdaptiveCooldownMultiplier } from './taskLearning.js'
import { parseCronToNextRun, parseCronToPrevRun } from './eventScheduler.js'
import { addNotification, exists as notificationExists, removeByMetadata } from './notifications.js'
import { isInstanceFeatureEnabled } from './instanceFeatures.js'

const mockSchedule = ({ tasks = {}, executions = {}, templates = [], onDemandRequests = [] } = {}) => {
  readJSONFile.mockResolvedValue({ version: 2, tasks, executions, templates, onDemandRequests })
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
    isInstanceFeatureEnabled.mockResolvedValue(true)
    // Default: no saved schedule → use defaults
    readJSONFile.mockResolvedValue(null)
  })

  // Cases that freeze the clock restore it here, so a failed assertion inside a
  // faked-timer block can't leak fake time into every case that follows.
  afterEach(() => {
    vi.useRealTimers()
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

  describe('feature-gated shipped tasks', () => {
    it('associates both shipped JIRA tasks with the JIRA instance feature', () => {
      expect(DEFAULT_TASK_INTERVALS['jira-sprint-manager'].feature).toBe('jira')
      expect(DEFAULT_TASK_INTERVALS['jira-status-report'].feature).toBe('jira')
    })

    it('keeps the shipped feature association authoritative over persisted state', async () => {
      mockSchedule({ tasks: {
        'jira-sprint-manager': { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, feature: 'post' },
        security: { type: INTERVAL_TYPES.WEEKLY, enabled: true, feature: 'jira' },
      } })

      const schedule = await loadSchedule()

      expect(schedule.tasks['jira-sprint-manager'].feature).toBe('jira')
      expect(schedule.tasks.security).not.toHaveProperty('feature')
    })
  })

  describe('INSTALL_WIDE_TASK_TYPES', () => {
    it('names only task types that really sweep the whole install', () => {
      // repo-sync sweeps every managed checkout; user-action-review reads the
      // install-wide operator-action ledger — neither is a per-app run.
      expect([...INSTALL_WIDE_TASK_TYPES]).toEqual(['repo-sync', 'user-action-review'])
    })

    it('every install-wide type is a registered task type', () => {
      for (const t of INSTALL_WIDE_TASK_TYPES) {
        expect(SELF_IMPROVEMENT_TASK_TYPES).toContain(t)
      }
    })
  })

  describe('managed-app target task types', () => {
    it('keeps app-required scope explicit and separate from install-wide scope', () => {
      expect([...MANAGED_APP_TARGET_TASK_TYPES]).toEqual(['pr-reviewer'])
      expect(requiresManagedAppTarget('pr-reviewer')).toBe(true)
      expect(requiresManagedAppTarget('security')).toBe(false)
      expect(requiresManagedAppTarget('repo-sync')).toBe(false)
    })

    it('only names registered task types', () => {
      for (const taskType of MANAGED_APP_TARGET_TASK_TYPES) {
        expect(SELF_IMPROVEMENT_TASK_TYPES).toContain(taskType)
      }
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

  describe('user-action-review (operator-ledger automation proposals)', () => {
    it('is registered install-wide with an on-demand + enabled default and a v1 prompt', () => {
      expect(SELF_IMPROVEMENT_TASK_TYPES).toContain('user-action-review');
      expect(INSTALL_WIDE_TASK_TYPES.has('user-action-review')).toBe(true);
      expect(TASK_TYPE_DESCRIPTIONS['user-action-review']).toContain('propose automations');
      expect(DEFAULT_TASK_INTERVALS['user-action-review']).toMatchObject({ type: INTERVAL_TYPES.ON_DEMAND, enabled: true });
      expect(PROMPT_VERSIONS['user-action-review']).toBe(1);
      expect(DEFAULT_TASK_PROMPTS['user-action-review']).toContain('{userActionDelivery}');
      // The prompt proposes; it must never instruct the agent to enact.
      expect(DEFAULT_TASK_PROMPTS['user-action-review']).toContain('NEVER change settings');
    });

    it('defaults to file-issues with the no-code posture', () => {
      expect(DEFAULT_TASK_INTERVALS['user-action-review'].taskMetadata).toMatchObject({
        fileIssues: true, useWorktree: false, openPR: false
      });
    });

    it('surfaces the fileIssues toggle on schedule status without joining the audit catalog', async () => {
      mockSchedule({ tasks: {}, executions: {} });
      const status = await getScheduleStatus();
      expect(status.tasks['user-action-review']).toMatchObject({
        installWide: true, fileIssuesCapable: true, defaultFileIssues: true
      });
    });
  });

  describe('layered-intelligence (programmatic-I/O agent task)', () => {
    it('is registered as a self-improvement task with a description and an on-demand default', () => {
      expect(SELF_IMPROVEMENT_TASK_TYPES).toContain('layered-intelligence');
      expect(TASK_TYPE_DESCRIPTIONS['layered-intelligence']).toContain('performance metrics');
      expect(TASK_TYPE_DESCRIPTIONS['layered-intelligence']).toContain('visibility gap');
      expect(DEFAULT_TASK_INTERVALS['layered-intelligence']).toMatchObject({ type: INTERVAL_TYPES.ON_DEMAND, enabled: true });
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

  describe('issue-watcher (programmatic-I/O agent task)', () => {
    it('ships as an enabled on-demand task with a 30-minute fallback and a runtime-generated prompt', () => {
      expect(SELF_IMPROVEMENT_TASK_TYPES).toContain('issue-watcher');
      expect(DEFAULT_TASK_INTERVALS['issue-watcher']).toMatchObject({
        type: INTERVAL_TYPES.ON_DEMAND, intervalMs: 30 * 60 * 1000, enabled: true, prompt: null
      });
      expect(DEFAULT_TASK_PROMPTS['issue-watcher']).toBeUndefined();
      expect(TASK_TYPE_PROMPT_INFO['issue-watcher']).toMatchObject({ mode: 'runtime-generated' });
    });

    it('locks the reasoning-only throwaway-worktree posture', () => {
      expect(MANAGED_AGENT_OPTIONS['issue-watcher']).toEqual(['useWorktree', 'openPR', 'discardWorktree']);
      const config = { taskMetadata: { useWorktree: false, openPR: true, discardWorktree: false } };
      expect(enforceManagedAgentOptions('issue-watcher', config)).toBe(true);
      expect(config.taskMetadata).toMatchObject({ useWorktree: true, openPR: false, discardWorktree: true });
    });
  });

  describe('pr-reviewer (layered public-content review task)', () => {
    it('describes the preflight-owned prompt and ships the optional three-stage pipeline read-only', () => {
      expect(TASK_TYPE_PROMPT_INFO['pr-reviewer']).toMatchObject({ mode: 'runtime-generated' });
      expect(TASK_TYPE_PROMPT_INFO['pr-reviewer'].description).toContain('tool-free eligibility gate');
      expect(DEFAULT_TASK_INTERVALS['pr-reviewer'].taskMetadata.pipeline.stages).toEqual([
        expect.objectContaining({ name: 'Security Scan', role: 'security', readOnly: true, managed: true }),
        expect.objectContaining({ name: 'Eligibility Gate', role: 'eligibility', readOnly: true, executionProfile: 'public-review-gate' }),
        expect.objectContaining({ name: 'Code Review & Actions', role: 'actions', readOnly: true, executionProfile: 'public-review-actions' }),
      ]);
      expect(MANAGED_AGENT_OPTIONS['pr-reviewer']).toEqual(['useWorktree', 'openPR', 'worktreeChangesExpected']);
    });
  });

  describe('do-replan task type', () => {
    it('should default to on-demand and enabled, with worktree+PR metadata', async () => {
      const interval = await getTaskInterval('do-replan')
      expect(interval.type).toBe(INTERVAL_TYPES.ON_DEMAND)
      expect(interval.enabled).toBe(true)
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
      expect(prompt).toContain('Issue-quality gate')
      expect(prompt).toContain('useful to do now')
      expect(prompt).toContain('let a later audit rediscover it')
      expect(prompt).toContain('A refactor is valid when current evidence shows it pays off now')
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

    it('installs every registered task as an enabled on-demand action', async () => {
      const schedule = await loadSchedule()

      for (const taskType of SELF_IMPROVEMENT_TASK_TYPES) {
        expect(schedule.tasks[taskType], taskType).toMatchObject({
          type: INTERVAL_TYPES.ON_DEMAND,
          enabled: true
        })
      }
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

    it('preserves an existing paused cadence when loading new defaults', async () => {
      mockSchedule({
        tasks: { security: { type: INTERVAL_TYPES.WEEKLY, enabled: false, providerId: null, model: null, prompt: null } }
      })

      const schedule = await loadSchedule()

      expect(schedule.tasks.security).toMatchObject({ type: INTERVAL_TYPES.WEEKLY, enabled: false })
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

  describe('promptSource provenance (issue #5432)', () => {
    // The self-heal above clears promptCustomized whenever the stored prompt
    // byte-matches ANY shipped default (current or retired). That is right for a
    // flag the legacy migration guessed at, but it cannot tell that apart from a
    // user who deliberately pasted an older SHIPPED body into Settings →
    // Scheduled Tasks — that pin was cleared on the next load and the next
    // PROMPT_VERSIONS bump silently overwrote their chosen text. promptSource
    // records which of the two wrote the flag.
    const portosDocPrompt = PREVIOUS_DEFAULT_PROMPTS['documentation'].find((p) => p.includes('PortOS'))

    const loadDocumentation = async (config) => {
      mockSchedule({
        tasks: { 'documentation': { type: 'once', enabled: false, providerId: null, model: null, ...config } }
      })
      return (await loadSchedule()).tasks['documentation']
    }

    it('keeps a user-pinned retired default pinned instead of self-healing it', async () => {
      const task = await loadDocumentation({
        prompt: portosDocPrompt,
        promptVersion: 1,
        promptCustomized: true,
        promptSource: 'user'
      })
      expect(task.promptCustomized).toBe(true)
      expect(task.prompt).toBe(portosDocPrompt)
    })

    it('still self-heals a legacy-inferred flag on a retired default', async () => {
      const task = await loadDocumentation({
        prompt: portosDocPrompt,
        promptVersion: 1,
        promptCustomized: true,
        promptSource: 'legacy-inferred'
      })
      expect(task.promptCustomized).toBe(false)
      expect(task.prompt).toBe(DEFAULT_TASK_PROMPTS['documentation'])
    })

    // Every install that upgrades into this field carries no promptSource at all.
    // Absent must keep behaving exactly as it does today, or the upgrade itself
    // would freeze thousands of mis-flagged prompts on their retired bodies.
    it('treats an absent promptSource as legacy-inferred (self-heals, as today)', async () => {
      const task = await loadDocumentation({
        prompt: portosDocPrompt,
        promptVersion: 1,
        promptCustomized: true
      })
      expect(task.promptSource).toBeUndefined()
      expect(task.promptCustomized).toBe(false)
      expect(task.prompt).toBe(DEFAULT_TASK_PROMPTS['documentation'])
    })

    it('stamps legacy-inferred when the legacy migration flags an unrecognized body', async () => {
      const custom = 'A documentation prompt that matches no shipped default at all.'
      // No promptVersion → the legacy-migration branch runs.
      const task = await loadDocumentation({ prompt: custom })
      expect(task.promptCustomized).toBe(true)
      expect(task.promptSource).toBe('legacy-inferred')
    })

    it('drops a stale promptSource when the config has no prompt to pin', async () => {
      const task = await loadDocumentation({ prompt: null, promptSource: 'user' })
      expect(task.prompt).toBe(DEFAULT_TASK_PROMPTS['documentation'])
      expect(task.promptSource).toBeNull()
    })

    it('survives a PROMPT_VERSIONS bump when the pin is user-sourced', async () => {
      const original = PROMPT_VERSIONS['documentation']
      PROMPT_VERSIONS['documentation'] = original + 1
      try {
        const task = await loadDocumentation({
          prompt: portosDocPrompt,
          promptVersion: original,
          promptCustomized: true,
          promptSource: 'user'
        })
        expect(task.prompt).toBe(portosDocPrompt)
        expect(task.promptVersion).toBe(original)
      } finally {
        PROMPT_VERSIONS['documentation'] = original
      }
    })

    it('upgrades the same body across a bump when the pin is legacy-inferred', async () => {
      const original = PROMPT_VERSIONS['documentation']
      PROMPT_VERSIONS['documentation'] = original + 1
      try {
        const task = await loadDocumentation({
          prompt: portosDocPrompt,
          promptVersion: original,
          promptCustomized: true,
          promptSource: 'legacy-inferred'
        })
        expect(task.prompt).toBe(DEFAULT_TASK_PROMPTS['documentation'])
        expect(task.promptVersion).toBe(original + 1)
      } finally {
        PROMPT_VERSIONS['documentation'] = original
      }
    })
  })

  describe('pre-unification prompt generations (self- + app-improvement split)', () => {
    // Before the two improvement schedules were unified, every basic task
    // shipped up to two bodies with different headers — `[Self-Improvement] …`
    // and `[App Improvement: {appName}] …`. Unification replaced both with a
    // single `[Improvement: {appName}] …` body but preserved neither, so an
    // install carrying either generation stopped matching any shipped default,
    // was stamped promptCustomized by the legacy migration, and has been frozen
    // out of every prompt upgrade since — nine task types on a real install.
    const fromEra = (taskType, header) =>
      PREVIOUS_DEFAULT_PROMPTS[taskType].find((p) => p.startsWith(header))

    const loadOne = async (taskType, prompt, promptVersion) => {
      mockSchedule({
        tasks: { [taskType]: { type: 'once', enabled: false, providerId: null, model: null, prompt, promptVersion, promptCustomized: true } }
      })
      return (await loadSchedule()).tasks[taskType]
    }

    // One case per shape the freeze took: header-only drift, a body that also
    // changed, a type whose ONLY revision was the split (so it had no
    // PROMPT_VERSIONS entry at all), and the older self-improvement generation.
    //
    // Each runs under BOTH version stamps a frozen install can carry. The
    // legacy migration wrote `promptVersion = PROMPT_VERSIONS[taskType]`
    // alongside the customized flag, so an install flagged after its type was
    // versioned holds the CURRENT version with a RETIRED body — and clearing
    // the flag alone leaves `storedVersion < current` false, so the upgrade
    // never fires. Testing only the version-1 stamp misses that entirely.
    const ERAS = [
      ['console-errors', '[App Improvement: '],
      ['security', '[App Improvement: '],
      ['typing', '[App Improvement: '],
      ['console-errors', '[Self-Improvement] '],
      ['feature-ideas', '[Self-Improvement] '],
    ]
    it.each(ERAS.flatMap(([taskType, header]) => [
      [taskType, header, 'pre-versioning', 1],
      [taskType, header, 'current-version', PROMPT_VERSIONS[taskType]],
    ]))('self-heals and upgrades a stored %s prompt from the %s generation (%s stamp)', async (taskType, header, _label, storedVersion) => {
      const prompt = fromEra(taskType, header)
      expect(prompt, `no ${header} body registered for ${taskType}`).toBeDefined()
      const task = await loadOne(taskType, prompt, storedVersion)
      expect(task.promptCustomized).toBe(false)
      expect(task.prompt).toBe(DEFAULT_TASK_PROMPTS[taskType])
      expect(task.promptVersion).toBe(PROMPT_VERSIONS[taskType])
    })

    it('preserves a genuine user customization that merely mimics a retired header', async () => {
      const custom = '[App Improvement: {appName}] My own audit that matches no shipped default.'
      const task = await loadOne('console-errors', custom, 1)
      expect(task.prompt).toBe(custom)
      expect(task.promptCustomized).toBe(true)
    })

    // Pins the provenance of the frozen feature-ideas body: it is the one that
    // sent every run to `data/COS-GOALS.md`, a file the same unification folded
    // into the root GOALS.md. The upgrade itself is covered above.
    it('pins the frozen feature-ideas body as the COS-GOALS.md-era default', () => {
      expect(fromEra('feature-ideas', '[Self-Improvement] ')).toContain('data/COS-GOALS.md')
      expect(DEFAULT_TASK_PROMPTS['feature-ideas']).not.toContain('COS-GOALS.md')
    })
  })

  describe('changelog-fragment prompt revision (issue #3998)', () => {
    // Pins that each task type touched by this revision actually participates in
    // the auto-upgrade path: it is in PROMPT_VERSIONS, loadSchedule walks it, and
    // a stored body listed in PREVIOUS_DEFAULT_PROMPTS resolves to the current
    // default rather than being stamped promptCustomized (which would pin the
    // stale body on that install forever).
    //
    // NOT a byte-copy check: the fixture is read from the same array the
    // recognition set is read from, so a mis-copied body would agree with itself.
    // Copy fidelity is verified against the COMMITTED integrity snapshot — the
    // pre-change DEFAULT_TASK_PROMPTS hash for each key must reappear in the
    // post-change PREVIOUS_DEFAULT_PROMPTS hashes, which is visible in the diff.
    //
    // Router-reached prompts (claim-issue-gitlab, claim-issue-jira) have no
    // DEFAULT_TASK_INTERVALS entry, but loadSchedule still walks them once an
    // install has STORED one: the merge loop preserves task types absent from the
    // defaults, and the upgrade loop iterates every stored key. So they belong in
    // this walk too — which is where a migration is pinned behaviorally rather
    // than by restating the constants.
    it.each([
      'do-replan',
      'documentation',
      'plan-task',
      'claim-issue',
      'release-check',
      'refresh-local-llm-catalog',
      // glab-flag revision (issue #4685): dependency-updates v3 → v4 and
      // claim-issue-gitlab v15 → v16. Same contract, so they ride the same walk
      // rather than a parallel describe.
      'dependency-updates',
      'claim-issue-gitlab',
    ])('%s: an install on the outgoing default auto-upgrades instead of being flagged customized', async (taskType) => {
      const previous = PREVIOUS_DEFAULT_PROMPTS[taskType]
      const outgoing = previous[previous.length - 1]
      // A stored prompt with NO promptVersion takes the legacy-migration path,
      // which is where an unrecognized body gets stamped promptCustomized.
      mockSchedule({
        tasks: { [taskType]: { type: 'once', enabled: false, providerId: null, model: null, prompt: outgoing } }
      })
      const task = (await loadSchedule()).tasks[taskType]
      expect(task.promptCustomized).not.toBe(true)
      expect(task.prompt).toBe(DEFAULT_TASK_PROMPTS[taskType])
      expect(task.promptVersion).toBe(PROMPT_VERSIONS[taskType])
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
      const retired = PREVIOUS_DEFAULT_PROMPTS['security'][0]
      const result = await updateTaskInterval('security', { prompt: retired })
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

    it('feature-ideas ignores an enabled on-demand do-replan dependency', async () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()

      mockSchedule({
        tasks: {
          'feature-ideas': { type: 'daily', enabled: true, providerId: null, model: null, prompt: null },
          'do-replan': { type: INTERVAL_TYPES.ON_DEMAND, enabled: true, providerId: null, model: null, prompt: null }
        },
        executions: { 'task:feature-ideas': { lastRun: twoDaysAgo, count: 1, perApp: {} } }
      })

      const result = await shouldRunTask('feature-ideas')
      expect(result.shouldRun).toBe(true)
      expect(result.reason).toContain('daily-due')
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

    it('does not select a feature-disabled rotation task', async () => {
      isInstanceFeatureEnabled.mockResolvedValue(false)
      mockSchedule({ tasks: {
        'jira-sprint-manager': { type: INTERVAL_TYPES.ROTATION, enabled: true },
      } })

      expect(await getNextTaskType()).toBeNull()
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
      const { loadSlashdoFile } = await import('../lib/slashdoLoader.js')
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

    it('release-check delegates to slashdo release and has no hardcoded reviewer', async () => {
      const prompt = await getTaskPrompt('release-check')
      expect(prompt).toContain('/do:release')
      expect(prompt).toContain('{reviewers}')
      expect(prompt.toLowerCase()).not.toContain('copilot')
      expect(prompt).not.toContain('reviewThreads')
    })
  })

  // The gh/git coordinator types deliver their work as a SIDE EFFECT (a deleted
  // branch, a merged PR, a relabeled issue, a posted report) in the app's live
  // checkout — never as a commit in a CoS-managed worktree. Two code-shipping
  // criteria have to be switched off for them or every successful run is recorded
  // as a failure: `openPR` (→ `pr-missing` at finalization, since there is no code
  // to open a PR for) and `worktreeChangesExpected` (→ `idle-no-changes` at the TUI
  // idle-complete gate, since a clean tree IS the success shape).
  describe('non-committing coordinator posture', () => {
    // Driven off NON_COMMITTING_COORDINATOR_TASK_TYPES — the same set that grants
    // these types their commit-criterion exemption — rather than a hand-typed list,
    // so a FUTURE coordinator type added there can't silently ship without the
    // posture. That drift is exactly how `branch-cleanup` shipped with no
    // taskMetadata at all, letting an app-level `defaultOpenPR: true` attach a
    // worktree + PR expectation to a task that only runs `git branch -d`.
    // branch-cleanup remains in the coordinator exemption only for archived
    // tasks from before migration 274; it is no longer a shipped schedule type.
    it.each([...NON_COMMITTING_COORDINATOR_TASK_TYPES].filter((type) => DEFAULT_TASK_INTERVALS[type]))(
      '%s declares no worktree/PR, expects a clean tree, and locks both flags',
      (taskType) => {
        const meta = DEFAULT_TASK_INTERVALS[taskType].taskMetadata
        // Explicitly false, NOT merely absent — applyAppWorktreeDefault fills these
        // from the app's defaults on an `=== undefined` check, so an absent key is
        // the bug, not a pass.
        expect(meta.openPR).toBe(false)
        expect(meta.useWorktree).toBe(false)
        expect(meta.worktreeChangesExpected).toBe(false)
        // Locked, so a per-app override can't re-attach what the defaults cleared.
        // worktreeChangesExpected is managed too — see MANAGED_AGENT_OPTIONS.
        const managed = ['useWorktree', 'openPR', 'worktreeChangesExpected']
        if (taskType === 'release-check') {
          managed.push('slashdoCommand')
          expect(meta.slashdoCommand).toBe('release')
        }
        expect(MANAGED_AGENT_OPTIONS[taskType]).toEqual(managed)
      }
    )

    // An explicit `taskMetadata: null` (accepted by PUT /api/cos/schedule as "clear
    // it") makes loadSchedule SKIP the defaults deep-merge, so enforceManagedAgentOptions
    // is the only thing that rebuilds the bag — and it rebuilds MANAGED fields only.
    // Before worktreeChangesExpected was managed, it went absent here and a successful
    // clean-tree run was scored `idle-no-changes` all over again.
    it.each([...NON_COMMITTING_COORDINATOR_TASK_TYPES].filter((type) => DEFAULT_TASK_INTERVALS[type]))(
      '%s keeps the full posture when stored taskMetadata was cleared to null',
      async (taskType) => {
        mockSchedule({
          tasks: {
            [taskType]: { type: 'cron', enabled: true, providerId: null, model: null, prompt: null, taskMetadata: null }
          }
        })

        const meta = (await loadSchedule()).tasks[taskType].taskMetadata
        expect(meta.useWorktree).toBe(false)
        expect(meta.openPR).toBe(false)
        expect(meta.worktreeChangesExpected).toBe(false)
        if (taskType === 'release-check') expect(meta.slashdoCommand).toBe('release')
        if (taskType === 'branch-reconcile') expect(meta.branchesPerAgent).toBe(3)
      }
    )

    it('forces branch-reconcile useWorktree/openPR back off when stored true (loadSchedule)', async () => {
      mockSchedule({
        tasks: {
          'branch-reconcile': {
            type: 'cron',
            enabled: true,
            providerId: null,
            model: null,
            prompt: null,
            taskMetadata: { useWorktree: true, openPR: true }
          }
        }
      })

      const schedule = await loadSchedule()
      expect(schedule.tasks['branch-reconcile'].taskMetadata.useWorktree).toBe(false)
      expect(schedule.tasks['branch-reconcile'].taskMetadata.openPR).toBe(false)
      // Backfilled from the defaults for installs whose stored config predates it.
      expect(schedule.tasks['branch-reconcile'].taskMetadata.worktreeChangesExpected).toBe(false)
      expect(schedule.tasks['branch-reconcile'].taskMetadata.branchesPerAgent).toBe(3)
    })

    it('keeps the legacy branch-cleanup safety posture until migration 274 runs', async () => {
      mockSchedule({
        tasks: {
          'branch-cleanup': {
            type: 'weekly',
            enabled: true,
            providerId: null,
            model: null,
            prompt: null,
            taskMetadata: { useWorktree: true, openPR: true, worktreeChangesExpected: true }
          }
        }
      })

      const meta = (await loadSchedule()).tasks['branch-cleanup'].taskMetadata
      expect(meta.useWorktree).toBe(false)
      expect(meta.openPR).toBe(false)
      expect(meta.worktreeChangesExpected).toBe(false)
    })

    it('strips a per-app branch-reconcile worktree/PR override', () => {
      expect(stripManagedAgentOptionsFromOverride('branch-reconcile', { useWorktree: true, openPR: true })).toBeNull()
    })
  })

  describe('claim-issue defaults', () => {
    it('is registered as a self-improvement task type', () => {
      expect(SELF_IMPROVEMENT_TASK_TYPES).toContain('claim-issue')
    })

    it('defaults to self-filed issues with worktree/PR managed by the agent', () => {
      const cfg = DEFAULT_TASK_INTERVALS['claim-issue']
      expect(cfg.type).toBe(INTERVAL_TYPES.ON_DEMAND)
      expect(cfg.enabled).toBe(true)
      // Default is the slashdo /do:next --self security boundary.
      expect(cfg.taskMetadata.issueAuthorFilter).toBe('self')
      // Mirrors plan-task: the agent creates its own worktree + opens the PR,
      // so CoS must keep both off (and lock them).
      expect(cfg.taskMetadata.useWorktree).toBe(false)
      expect(cfg.taskMetadata.openPR).toBe(false)
      expect(cfg.taskMetadata.claimFlow).toBe(true)
      expect(MANAGED_AGENT_OPTIONS['claim-issue']).toEqual(['useWorktree', 'openPR', 'claimFlow'])
    })
  })

  describe('branch-reconcile defaults', () => {
    it('is the single hygiene task and defaults to a three-branch coordinator batch', () => {
      expect(SELF_IMPROVEMENT_TASK_TYPES).toContain('branch-reconcile')
      expect(SELF_IMPROVEMENT_TASK_TYPES).not.toContain('branch-cleanup')
      expect(DEFAULT_TASK_INTERVALS['branch-reconcile'].taskMetadata.branchesPerAgent).toBe(3)
      expect(DEFAULT_TASK_INTERVALS['do-replan'].runAfter).toContain('branch-reconcile')
    })
  })

  describe('ux defaults (#3273)', () => {
    it('is registered as a self-improvement task type with a description', () => {
      expect(SELF_IMPROVEMENT_TASK_TYPES).toContain('ux')
      expect(TASK_TYPE_DESCRIPTIONS['ux']).toBe('UX/design audit — file issues (default) or implement fixes')
    })

    it('defaults to on-demand + enabled with file-issues on (worktree/PR off)', () => {
      const cfg = DEFAULT_TASK_INTERVALS['ux']
      expect(cfg.type).toBe(INTERVAL_TYPES.ON_DEMAND)
      // Manual Run is explicit consent; choosing a cadence opts into scheduling.
      expect(cfg.enabled).toBe(true)
      expect(cfg.taskMetadata.fileIssues).toBe(true)
      expect(cfg.taskMetadata.useWorktree).toBe(false)
      expect(cfg.taskMetadata.openPR).toBe(false)
      // File-issues posture is enforced at dispatch, not via a static lock, so
      // the user can flip fileIssues off and implement.
      expect(MANAGED_AGENT_OPTIONS['ux']).toBeUndefined()
      expect(cfg.taskMetadata.readOnly).toBe(false)
    })

    it('ships a prompt that files findings to the tracker and never edits source', async () => {
      const prompt = await getTaskPrompt('ux')
      // The tracker block is injected at dispatch, so the token must survive here.
      expect(prompt).toContain('{trackerInstructions}')
      expect(prompt).toContain('[ux-…]')
      // Read-only on source; the issues ARE the deliverable.
      expect(prompt).toContain('do NOT create branches or PRs')
      // Named checklist, not vibes.
      expect(prompt).toContain('above the fold')
      expect(prompt).toContain('1440x900')
      expect(prompt).toContain('375x812')
      // Explicitly defers to the sibling task types it would otherwise duplicate.
      expect(prompt).toContain('ui-bugs')
      expect(prompt).toContain('mobile-responsive')
      expect(prompt).toContain('accessibility')
    })
  })

  describe('plan-feature defaults', () => {
    it('is registered as a self-improvement task type with a description', () => {
      expect(SELF_IMPROVEMENT_TASK_TYPES).toContain('plan-feature')
      expect(TASK_TYPE_DESCRIPTIONS['plan-feature']).toBeTruthy()
    })

    it('defaults to on-demand + enabled, grounded on do-replan, with no worktree/PR', () => {
      const cfg = DEFAULT_TASK_INTERVALS['plan-feature']
      expect(cfg.type).toBe(INTERVAL_TYPES.ON_DEMAND)
      // Manual Run is explicit consent; choosing a cadence opts into scheduling.
      expect(cfg.enabled).toBe(true)
      // Refresh the configured work tracker before filing a new proposal.
      expect(cfg.runAfter).toEqual(['do-replan'])
      expect(cfg.dataInputs).toEqual([
        'product-requirements',
        'project-goals',
        'open-issues',
        'open-pull-requests',
        'closed-unmerged-pull-requests',
      ])
      expect(cfg.taskMetadata.useWorktree).toBe(false)
      expect(cfg.taskMetadata.openPR).toBe(false)
      // Writable: a file-based tracker path commits checklist items.
      expect(cfg.taskMetadata.readOnly).toBe(false)
      // Filing posture comes from TRACKER_FILING_PRESETS membership at dispatch,
      // not a static lock.
      expect(MANAGED_AGENT_OPTIONS['plan-feature']).toBeUndefined()
    })

    it('always files its plan via the tracker-filing machinery', async () => {
      const { resolveTrackerFilingBlock } = await import('../lib/workTracker.js')
      const app = { repoPath: '/tmp/example-repo', workTracker: 'github' }
      const block = await resolveTrackerFilingBlock(app, 'plan-feature')
      expect(block.workTracker).toBe('github')
      expect(block.trackerInstructions).toContain('[plan-feature-…]')
    })

    it('ships a prompt that plans without implementing', async () => {
      const prompt = await getTaskPrompt('plan-feature')
      expect(prompt).toContain('{appName}')
      expect(prompt).toContain('{repoPath}')
      // The tracker block is injected at dispatch, so the token must survive here.
      expect(prompt).toContain('{trackerInstructions}')
      // Product intent is specific-first, with repository documentation as the
      // fallback when a project has neither a PRD nor goals document.
      expect(prompt).toContain('PRD.md')
      expect(prompt).toContain('GOALS.md')
      expect(prompt).toContain('README.md')
      expect(prompt).toContain('docs/README.md')
      expect(prompt).not.toContain('PLAN.md')
      expect(prompt).not.toContain('REJECTED.md')
      expect(prompt).toContain('Closed unmerged pull requests')
      // Never implements — the plan IS the deliverable.
      expect(prompt).toContain('no branches, no PRs')
      expect(prompt).toContain('Acceptance criteria')
      expect(prompt).toContain('Non-goals')
    })
  })

  describe('audit file-issues types', () => {
    it('registers data-safety, simplify, and module-hygiene as enabled on-demand file-issues audits', () => {
      for (const taskType of ['data-safety', 'simplify', 'module-hygiene']) {
        expect(SELF_IMPROVEMENT_TASK_TYPES).toContain(taskType)
        expect(TASK_TYPE_DESCRIPTIONS[taskType]).toBeTruthy()
        const cfg = DEFAULT_TASK_INTERVALS[taskType]
        expect(cfg.type).toBe(INTERVAL_TYPES.ON_DEMAND)
        expect(cfg.enabled).toBe(true)
        expect(cfg.taskMetadata.fileIssues).toBe(true)
        expect(cfg.taskMetadata.useWorktree).toBe(false)
        expect(cfg.taskMetadata.openPR).toBe(false)
        expect(MANAGED_AGENT_OPTIONS[taskType]).toBeUndefined()
      }
      expect(DEFAULT_TASK_INTERVALS['module-hygiene'].dataInputs).toEqual([
        'open-issues',
        'open-pull-requests',
      ])
    })

    it('surfaces fileIssuesCapable on audit types in getScheduleStatus', async () => {
      mockSchedule()
      const status = await getScheduleStatus()
      expect(status.tasks['security'].fileIssuesCapable).toBe(true)
      expect(status.tasks['security'].defaultFileIssues).toBe(false)
      expect(status.tasks['ux'].fileIssuesCapable).toBe(true)
      expect(status.tasks['ux'].defaultFileIssues).toBe(true)
      expect(status.tasks['data-safety'].fileIssuesCapable).toBe(true)
      expect(status.tasks['module-hygiene'].fileIssuesCapable).toBe(true)
      expect(status.tasks['module-hygiene'].defaultFileIssues).toBe(true)
      expect(status.tasks['module-hygiene'].doWorkRequiresWorktree).toBe(true)
      expect(status.tasks['simplify'].doWorkRequiresWorktree).toBeUndefined()
      expect(status.tasks['claim-issue'].fileIssuesCapable).toBeUndefined()
    })

    // A per-app provider/model pin outranks the task's own pin at spawn for EVERY
    // task type (#4783). The Schedule page needs to show what each app pinned, on
    // every row, or it advertises a provider the run never used. The retired
    // `providerOverrideCapable` stamp must not come back — it existed only while
    // the generic spawn path declined to read the pin.
    it('carries each app\'s provider/model pin into appOverrides, with no capability stamp', async () => {
      mockSchedule()
      const apps = await import('./apps.js')
      apps.getActiveApps.mockResolvedValueOnce([{ id: 'app-1', name: 'Acme' }])
      apps.getAppTaskTypeOverrides.mockResolvedValue({
        'layered-intelligence': { enabled: true, providerId: 'claude-ollama-tui', model: 'qwen-b' },
        security: { enabled: true }
      })
      const status = await getScheduleStatus()
      expect(status.tasks['layered-intelligence'].appOverrides['app-1']).toMatchObject({
        providerId: 'claude-ollama-tui',
        model: 'qwen-b'
      })
      // A non-LI type surfaces the SAME pin — the capability flag is gone.
      expect(status.tasks['layered-intelligence']).not.toHaveProperty('providerOverrideCapable')
      expect(status.tasks['security']).not.toHaveProperty('providerOverrideCapable')
      // An app that pinned nothing carries no provider keys at all — absent must
      // stay distinguishable from "explicitly pinned".
      expect(status.tasks['security'].appOverrides['app-1']).not.toHaveProperty('providerId')
      apps.getAppTaskTypeOverrides.mockResolvedValue({})
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

    // The drain's completion refill re-issues itself through this same queue. It
    // must be distinguishable from a human "Run", because the engines clear the
    // park + convergence signature + dispatch counter for a human and MUST NOT for
    // a refill — that reset is what let branch-reconcile re-dispatch all night.
    it('stamps origin: user by default and refill when the drain re-issues itself', async () => {
      mockSchedule({ tasks: { 'branch-reconcile': { type: 'perpetual', enabled: true } } })
      expect((await triggerOnDemandTask('branch-reconcile', 'app-1')).origin).toBe(ON_DEMAND_ORIGINS.USER)

      mockSchedule({ tasks: { 'branch-reconcile': { type: 'perpetual', enabled: true } } })
      const refill = await triggerOnDemandTask('branch-reconcile', 'app-1', { emit: false, origin: ON_DEMAND_ORIGINS.REFILL })
      expect(refill.origin).toBe(ON_DEMAND_ORIGINS.REFILL)
    })

    // Operator-action ledger (#5594). Only a human pressing Run Now is an
    // operator action; the perpetual drain re-issues itself through this same
    // lane, and logging that would fill the ledger with events nobody performed.
    it('records a cos.schedule.trigger row for a human Run Now, and none for a refill', async () => {
      mockSchedule({ tasks: { 'branch-reconcile': { type: 'perpetual', enabled: true } } })
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
      mockSchedule({ tasks: { 'branch-reconcile': { type: 'perpetual', enabled: true } } })
      await triggerOnDemandTask('branch-reconcile', 'app-1', { emit: false, origin: ON_DEMAND_ORIGINS.REFILL })
      expect(recordUserAction).not.toHaveBeenCalled()
    })

    it('records nothing when the trigger is refused', async () => {
      mockSchedule({ tasks: { 'branch-reconcile': { type: 'perpetual', enabled: false } } })
      expect((await triggerOnDemandTask('branch-reconcile', 'app-1')).error).toMatch(/disabled/i)
      expect(recordUserAction).not.toHaveBeenCalled()
    })

    // The policy that used to be open-coded in each spawn engine — which is how the
    // loop got in. One home, so the three queue consumers can't drift on it.
    describe('applyOnDemandRunResets', () => {
      const parked = (extra = {}) => ({
        tasks: { 'branch-reconcile': { type: 'perpetual', enabled: true } },
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

      it('treats a pre-origin request as user-initiated (safe default for a human-filled queue)', async () => {
        mockSchedule(parked())
        expect(await applyOnDemandRunResets({ taskType: 'branch-reconcile' }, 'app-1')).toBe(true)
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

    it('projects task summaries and explains hook-owned prompts', async () => {
      mockSchedule()

      const status = await getScheduleStatus()

      expect(status.tasks['issue-watcher']).toMatchObject({
        description: TASK_TYPE_DESCRIPTIONS['issue-watcher'],
        promptMode: 'runtime-generated',
        promptDescription: expect.stringContaining('deterministic GitHub gathering'),
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
          tasks: { 'claim-issue': { type: 'perpetual', enabled: true, recheckCron: '0 9 * * *' } },
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
          tasks: { 'claim-issue': { type: 'perpetual', enabled: true, recheckCron: '0 9 * * *' } },
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
          tasks: { 'claim-issue': { type: 'perpetual', enabled: true } },
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
        mockSchedule({ tasks: { 'claim-issue': { type: 'perpetual', enabled: true } } })
        const upcoming = await getUpcomingTasks(50)
        const claim = upcoming.find(t => t.taskType === 'claim-issue')
        expect(claim.status).toBe('ready')
      })
    })

    describe('parkPerpetual / perpetual park state', () => {
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

      // The elapse-aware question the completion refill asks (#3848). It must differ
      // from getPerpetualParkInfo's "is there a park record": an ELAPSED park is
      // deliberately left on disk (it reads as "due right now"), so treating its
      // presence as a stop signal would wedge the drain until something cleared it.
      it('isPerpetualParkActive is true only while parkedUntil is in the future', async () => {
        const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
        const past = new Date(Date.now() - 60 * 60 * 1000).toISOString()
        mockSchedule({
          tasks: { 'claim-issue': { type: 'perpetual', enabled: true } },
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
        mockSchedule({ tasks: { 'branch-reconcile': { type: 'perpetual', enabled: true, recheckIntervalMs: 7 * 24 * 3600000 } } })
        const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString()
        const record = await parkPerpetual('branch-reconcile', 'app-1', {
          reason: 'merged-branches-held-back', actionableCount: 0, signature: null,
          counts: { heldBackMerged: 4 }, notLaterThan: soon
        })
        expect(record.parkedUntil).toBe(soon)
        expect(record.parkReason).toBe('merged-branches-held-back')
        expect(record.parkCounts).toEqual({ heldBackMerged: 4 })
      })

      // The record, the log line and the schedule:perpetual-parked event all read
      // from one value. Bounding only the record's copy would keep publishing the
      // un-shortened time — a "parked until" the task no longer honours.
      it('parkPerpetual publishes the SHORTENED time on the parked event, not the raw cadence', async () => {
        parseCronToNextRun.mockReturnValue(null)
        cosEvents.emit.mockClear()
        mockSchedule({ tasks: { 'branch-reconcile': { type: 'perpetual', enabled: true, recheckIntervalMs: 7 * 24 * 3600000 } } })
        const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString()
        const record = await parkPerpetual('branch-reconcile', 'app-1', {
          reason: 'merged-branches-held-back', actionableCount: 0, signature: null, notLaterThan: soon
        })
        const parked = cosEvents.emit.mock.calls.find(([name]) => name === 'schedule:perpetual-parked')
        expect(parked?.[1].parkedUntil).toBe(soon)
        expect(parked[1].parkedUntil).toBe(record.parkedUntil)
      })

      // A cadence edit restamps every un-elapsed park. Without the bound
      // remembered ON the record, that edit stretches a correctly-shortened park
      // back out — the stacking this option exists to remove, reintroduced by an
      // unrelated settings change.
      it('a shortened park survives a recheck-cadence edit', async () => {
        parseCronToNextRun.mockReturnValue(null)
        const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString()
        mockSchedule({
          tasks: { 'branch-reconcile': { type: 'perpetual', enabled: true, recheckIntervalMs: 3600000 } },
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
        mockSchedule({ tasks: { 'branch-reconcile': { type: 'perpetual', enabled: true, recheckIntervalMs: 3600000 } } })
        const record = await parkPerpetual('branch-reconcile', 'app-1', { reason: 'no-in-flight-branches', actionableCount: 0, signature: null })
        expect(record.parkNotLaterThan).toBeUndefined()
      })

      it('parkPerpetual ignores a notLaterThan that is later than the recheck', async () => {
        parseCronToNextRun.mockReturnValue(null)
        mockSchedule({ tasks: { 'branch-reconcile': { type: 'perpetual', enabled: true, recheckIntervalMs: 3600000 } } })
        const far = new Date(Date.now() + 30 * 24 * 3600000).toISOString()
        const record = await parkPerpetual('branch-reconcile', 'app-1', {
          reason: 'merged-branches-held-back', actionableCount: 0, signature: null, notLaterThan: far
        })
        // The configured hourly cadence stands — a distant hold must not stretch it.
        expect(Date.parse(record.parkedUntil)).toBeLessThanOrEqual(Date.now() + 3600000)
        expect(Date.parse(record.parkedUntil)).toBeGreaterThan(Date.now())
      })

      it('parkPerpetual omits parkCounts when no breakdown is provided', async () => {
        mockSchedule({ tasks: { 'branch-reconcile': { type: 'perpetual', enabled: true, recheckIntervalMs: 3600000 } } })
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
          tasks: { 'claim-issue': { type: 'perpetual', enabled: true } },
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
          tasks: { 'branch-reconcile': { type: 'perpetual', enabled: true } },
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
          tasks: { 'branch-reconcile': { type: 'perpetual', enabled: true } },
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
          tasks: { 'branch-reconcile': { type: 'perpetual', enabled: true } },
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
          tasks: { 'branch-reconcile': { type: 'perpetual', enabled: true } },
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
          tasks: { 'branch-reconcile': { type: 'perpetual', enabled: true, recheckIntervalMs: 3600000 } },
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
          tasks: { 'claim-issue': { type: 'perpetual', enabled: true, recheckIntervalMs: 3600000 } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: { 'app-1': { lastRun: null, count: 0, perpetualDispatchCount: 4 } } } }
        })
        await parkPerpetual('claim-issue', 'app-1', { reason: 'churn-detected', actionableCount: 12 })
        const rec = JSON.parse(writeFile.mock.calls.at(-1)[1]).executions['task:claim-issue'].perApp['app-1']
        expect(rec.perpetualDispatchCount).toBeUndefined()
      })

      it('resetPerpetualForManualRun is a no-op (false) when nothing is cached', async () => {
        mockSchedule({
          tasks: { 'claim-issue': { type: 'perpetual', enabled: true } },
          executions: { 'task:claim-issue': { lastRun: null, count: 0, perApp: { 'app-1': { lastRun: null, count: 0 } } } }
        })
        expect(await resetPerpetualForManualRun('claim-issue', 'app-1')).toBe(false)
      })

      it('parkPerpetual stores the actionable signature it parked on', async () => {
        mockSchedule({ tasks: { 'branch-reconcile': { type: 'perpetual', enabled: true, recheckIntervalMs: 3600000 } } })
        await parkPerpetual('branch-reconcile', 'app-1', { reason: 'no-progress', actionableCount: 2, signature: 'a:NEEDS_PR:none|b:IN_REVIEW:5' })
        const saved = JSON.parse(writeFile.mock.calls.at(-1)[1])
        expect(saved.executions['task:branch-reconcile'].perApp['app-1'].lastActionableSignature).toBe('a:NEEDS_PR:none|b:IN_REVIEW:5')
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

      it('parkPerpetual increments signatureRepeatCount when the same finding is parked again', async () => {
        mockSchedule({
          tasks: { 'branch-reconcile': { type: 'perpetual', enabled: true, recheckIntervalMs: 3600000 } },
          executions: { 'task:branch-reconcile': { lastRun: null, count: 0, perApp: { 'app-1': { lastRun: null, count: 0, lastActionableSignature: 'a:NEEDS_PR:none' } } } }
        })
        await parkPerpetual('branch-reconcile', 'app-1', { reason: 'no-progress', actionableCount: 1, signature: 'a:NEEDS_PR:none' })
        const saved = JSON.parse(writeFile.mock.calls.at(-1)[1])
        expect(saved.executions['task:branch-reconcile'].perApp['app-1'].signatureRepeatCount).toBe(2)
        expect(saved.executions['task:branch-reconcile'].perApp['app-1'].lastActionableSignature).toBe('a:NEEDS_PR:none')
      })

      it('parkPerpetual resets signatureRepeatCount when the finding changes', async () => {
        mockSchedule({
          tasks: { 'branch-reconcile': { type: 'perpetual', enabled: true, recheckIntervalMs: 3600000 } },
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

      // #3590: an elapsed park is never cleared when it expires — shouldRunTask
      // reports `perpetual-recheck` and the dispatch gate clears it — so a record
      // whose parkedUntil is in the past is DUE RIGHT NOW. Restamping it from a
      // LENGTHENED cadence would silently delay work the user is already waiting on.
      it('leaves an already-elapsed park alone while re-deriving a future one', async () => {
        isTaskTypeEnabledForApp.mockResolvedValue(true)
        const soon = new Date(Date.now() + 60 * 1000).toISOString()
        const elapsed = new Date(Date.now() - 60 * 1000).toISOString()
        mockSchedule({
          tasks: { 'claim-issue': { type: 'perpetual', enabled: true, recheckIntervalMs: 60 * 1000 } },
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

    // getScheduleStatus (UI rollup) and getUpcomingTasks (daemon wake-up) both
    // project the shared aggregatePerpetualParks rollup. These fixtures pin them
    // to the SAME park semantics — including the global-record inclusion rule
    // the two used to disagree on (status only ever folded in a global park that
    // hadn't elapsed; eligibility folded in any global record carrying a park).
    describe('perpetual park aggregate — getScheduleStatus and getUpcomingTasks agree', () => {
      const perpetualOf = async (taskType = 'claim-issue') =>
        (await getScheduleStatus()).tasks[taskType].perpetual
      const upcomingOf = async (taskType = 'claim-issue') =>
        (await getUpcomingTasks(50)).find(t => t.taskType === taskType)

      it('every app parked: the status nextRecheckAt IS the upcoming eligibleAt', async () => {
        const soon = new Date(Date.now() + 30 * 60 * 1000).toISOString()
        const later = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
        mockSchedule({
          tasks: { 'claim-issue': { type: 'perpetual', enabled: true } },
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
          tasks: { 'claim-issue': { type: 'perpetual', enabled: true } },
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
          tasks: { 'claim-issue': { type: 'perpetual', enabled: true } },
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
          tasks: { 'claim-issue': { type: 'perpetual', enabled: true } },
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
          tasks: { 'claim-issue': { type: 'perpetual', enabled: true } },
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
        mockSchedule({ tasks: { 'claim-issue': { type: 'perpetual', enabled: true } } })
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
