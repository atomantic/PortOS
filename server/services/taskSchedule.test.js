import { mockSchedule, PAUSED_SHIPPED_DRAINS, cronDueNow, installScheduleHooks } from './taskSchedule.test.fixture.js';
import { getDefaultTaskPrompt } from './taskPromptDefaults/prompts.js';
import { describe, it, expect } from 'vitest';
import {
  INTERVAL_TYPES,
  INSTALL_WIDE_TASK_TYPES,
  SELF_IMPROVEMENT_TASK_TYPES,
  loadSchedule,
  getTaskInterval,
  updateTaskInterval,
  shouldRunTask,
  getDueTasks,
  getScheduleStatus,
  PROMPT_VERSIONS,
  DEFAULT_TASK_INTERVALS,
  stripManagedAgentOptionsFromOverride,
  requiresManagedAppTarget,
  requiresInstallWideTarget,
} from './taskSchedule.js';
import {
  MANAGED_APP_TARGET_TASK_TYPES,
  MANAGED_AGENT_OPTIONS,
  TASK_TYPE_DESCRIPTIONS,
  TASK_TYPE_PROMPT_INFO,
  getTaskTypePromptInfo,
  PROGRAMMATIC_SCHEDULED_TASK_TYPES,
} from './taskScheduleRegistry.js';
import {
  getTaskPrompt
} from './taskPromptService.js'
import { DEFAULT_TASK_PROMPTS } from './taskPromptDefaults.js'
import { RETIRED_CONSOLE_ERRORS_PROMPT } from './taskPromptDefaults/retiredPromptFixtures.js'
import { NON_COMMITTING_COORDINATOR_TASK_TYPES } from './taskTypeHooks.js'
import { enforceManagedAgentOptions } from './taskScheduleRegistry.js'
import { modeContractFor, defaultFileIssuesFor, auditDoWorkRequiresWorktree, AUDIT_TASK_TYPE_LIST, isAuditTaskType } from '../lib/auditCatalog.js'
import { NO_CHANGE_SCHEDULED_TYPES } from '../lib/noChangeCompletion.js'
import { readJSONFile } from '../lib/fileUtils.js'
import { writeFile } from 'fs/promises'

describe('taskSchedule', () => {
  installScheduleHooks();

  describe('INTERVAL_TYPES', () => {
    it('is exactly the two cadence variants — perpetual is a flag, not a type', () => {
      expect(INTERVAL_TYPES).toEqual({ ON_DEMAND: 'on-demand', CRON: 'cron' })
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

  })

  it('folds legacy schedule changes, pending requests and history beneath one active domain', async () => {
    const first = { type: 'cron', cronExpression: '0 5 * * 2', prompt: 'Custom simplify mission', model: 'fixture-one' }
    const second = { type: 'cron', cronExpression: '0 9 * * 4', prompt: 'Custom complexity mission', model: 'fixture-two' }
    mockSchedule({
      tasks: {
        'code-simplification': DEFAULT_TASK_INTERVALS['code-simplification'],
        simplify: first, 'better-complexity': second,
        security: { runAfter: ['simplify', 'better-complexity'] },
      },
      onDemandRequests: [{ id: 'fixture-a', taskType: 'simplify' }, { id: 'fixture-b', taskType: 'better-complexity' }],
      executions: {
        'task:simplify': { count: 3, perApp: {} }, 'task:better-complexity': { count: 5, perApp: {} },
      },
    })
    const schedule = await loadSchedule()
    expect(schedule.tasks['code-simplification']).toMatchObject({ ...first, promptCustomized: true })
    expect(schedule.tasks).not.toHaveProperty('simplify')
    expect(schedule.tasks).not.toHaveProperty('better-complexity')
    expect(schedule.tasks.security.runAfter).toEqual(['code-simplification'])
    expect(schedule.retiredAuditConfigs).toEqual({ 'better-complexity': second })
    expect(schedule.onDemandRequests).toEqual([
      { id: 'fixture-a', taskType: 'code-simplification' }, { id: 'fixture-b', taskType: 'code-simplification' },
    ])
    expect(schedule.executions).toEqual({ 'task:code-simplification': { count: 8, perApp: {} } })
  })

  it('keeps the effective fix mode and inherited delivery of a customized retired schedule', async () => {
    mockSchedule({
      tasks: {
        'performance-efficiency': DEFAULT_TASK_INTERVALS['performance-efficiency'],
        performance: { type: 'cron', cronExpression: '0 5 * * 2', taskMetadata: { fileIssues: false, openPR: true } },
      },
    })
    const { tasks } = await loadSchedule()
    expect(tasks['performance-efficiency']).toMatchObject({
      type: 'cron', cronExpression: '0 5 * * 2',
      taskMetadata: { fileIssues: false, useWorktree: null, openPR: true },
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
      // install-wide operator-action ledger; error-log-triage reads PortOS's own
      // PM2 logs — none is a per-app run.
      expect([...INSTALL_WIDE_TASK_TYPES]).toEqual(['repo-sync', 'user-action-review', 'model-comparison-refresh', 'error-log-triage'])
    })

    it('every install-wide type is a registered task type', () => {
      for (const t of INSTALL_WIDE_TASK_TYPES) {
        expect(SELF_IMPROVEMENT_TASK_TYPES).toContain(t)
      }
    })
  })

  describe('managed-app target task types', () => {
    it('keeps app-required scope explicit and separate from install-wide scope', () => {
      expect([...MANAGED_APP_TARGET_TASK_TYPES]).toEqual(['private-security-assessment', 'pr-reviewer', 'issue-watcher', 'pr-watcher', 'issue-reconcile', 'branch-reconcile'])
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
        (t) => !Object.hasOwn(TASK_TYPE_DESCRIPTIONS, t)
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
    it('is registered install-wide with an on-demand + enabled default and a v2 prompt', () => {
      expect(SELF_IMPROVEMENT_TASK_TYPES).toContain('user-action-review');
      expect(INSTALL_WIDE_TASK_TYPES.has('user-action-review')).toBe(true);
      expect(TASK_TYPE_DESCRIPTIONS['user-action-review']).toContain('propose automations');
      expect(DEFAULT_TASK_INTERVALS['user-action-review']).toMatchObject({ type: INTERVAL_TYPES.ON_DEMAND, enabled: true });
      expect(PROMPT_VERSIONS['user-action-review']).toBe(3);
      expect(DEFAULT_TASK_PROMPTS['user-action-review']).toContain('{userActionDelivery}');
      expect(DEFAULT_TASK_PROMPTS['user-action-review']).toContain('{userActionDetectors}');
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

  describe('programmatic scheduled handlers (universe bible)', () => {
    it('ships both as enabled ON_DEMAND tasks with no interval and no cron', () => {
      for (const taskType of PROGRAMMATIC_SCHEDULED_TASK_TYPES) {
        expect(SELF_IMPROVEMENT_TASK_TYPES, taskType).toContain(taskType);
        expect(TASK_TYPE_DESCRIPTIONS[taskType], taskType).toBeTruthy();
        const shipped = DEFAULT_TASK_INTERVALS[taskType];
        expect(shipped, taskType).toMatchObject({ type: INTERVAL_TYPES.ON_DEMAND, enabled: true });
        // No cadence of any kind: a clock-due default would spend the user's
        // provider quota on a fresh install before they ever asked for it.
        expect(shipped, taskType).not.toHaveProperty('intervalMs');
        expect(shipped, taskType).not.toHaveProperty('cronExpression');
        expect(shipped, taskType).not.toHaveProperty('recheckCron');
        expect(shipped.perpetual, taskType).toBeUndefined();
      }
    });

    it('never becomes due on the clock, however much time has passed', async () => {
      // The acceptance guarantee for #6376: enabled + runnable from Run Now, yet
      // never picked up by the scheduler. `cronDueNow` puts the clock where a
      // cron task WOULD fire, so a passing assertion here is about the cadence,
      // not about the time of day.
      cronDueNow();
      mockSchedule({
        tasks: {
          ...PAUSED_SHIPPED_DRAINS,
          ...Object.fromEntries(PROGRAMMATIC_SCHEDULED_TASK_TYPES.map((t) => [t, { type: 'on-demand', enabled: true }])),
        },
        executions: Object.fromEntries(PROGRAMMATIC_SCHEDULED_TASK_TYPES.map((t) => [
          `task:${t}`, { lastRun: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(), count: 1 }
        ])),
      });

      for (const taskType of PROGRAMMATIC_SCHEDULED_TASK_TYPES) {
        expect(await shouldRunTask(taskType), taskType).toMatchObject({ shouldRun: false, reason: 'on-demand-only' });
      }
      const due = await getDueTasks();
      expect(due.map((t) => t.taskType)).not.toEqual(expect.arrayContaining([...PROGRAMMATIC_SCHEDULED_TASK_TYPES]));
    });

    it('refuses a managed-app target — a universe is not a repo', async () => {
      for (const taskType of PROGRAMMATIC_SCHEDULED_TASK_TYPES) {
        expect(requiresInstallWideTarget(taskType), taskType).toBe(true);
        expect(await shouldRunTask(taskType, 'app-1'), taskType)
          .toMatchObject({ shouldRun: false, reason: 'requires-install-wide-target' });
      }
      // The gate is per type, not "everything install-wide" — repo-sync's
      // whole point is that it CAN be pointed at one app.
      expect(requiresInstallWideTarget('repo-sync')).toBe(false);
    });

    it('has no prompt template and is surfaced as programmatic, not runtime-generated', () => {
      for (const taskType of PROGRAMMATIC_SCHEDULED_TASK_TYPES) {
        // PortOS performs the work itself: there is no prompt for a hook to
        // render, so the prompt-version machinery must find nothing to migrate.
        expect(DEFAULT_TASK_PROMPTS[taskType], taskType).toBeUndefined();
        expect(getTaskTypePromptInfo(taskType).mode, taskType).toBe('programmatic');
      }
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

    it('decodes a legacy per-app custom+intervalMs override into an hourly cron', async () => {
      const { getAppTaskTypeInterval, getAppTaskTypeIntervalMs } = await import('./apps.js');
      cronDueNow();
      mockSchedule({
        tasks: { 'layered-intelligence': { type: 'on-demand', enabled: true, providerId: null, model: null, prompt: null } },
        executions: { 'task:layered-intelligence': { lastRun: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), count: 1, perApp: { 'app-1': { lastRun: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), count: 1 } } } }
      });
      getAppTaskTypeInterval.mockResolvedValue('custom');
      getAppTaskTypeIntervalMs.mockResolvedValue(60 * 60 * 1000);
      const res = await shouldRunTask('layered-intelligence', 'app-1');
      expect(res).toMatchObject({ shouldRun: true, reason: 'cron-due', cronExpression: '0 * * * *' });
      getAppTaskTypeInterval.mockResolvedValue(null);
      getAppTaskTypeIntervalMs.mockResolvedValue(null);
    });

    it('reads a per-app cron override string directly, overriding the global cadence', async () => {
      const { getAppTaskTypeInterval } = await import('./apps.js');
      cronDueNow();
      mockSchedule({
        tasks: { 'layered-intelligence': { type: 'on-demand', enabled: true, providerId: null, model: null, prompt: null } }
      });
      getAppTaskTypeInterval.mockResolvedValue('*/30 * * * *');
      const res = await shouldRunTask('layered-intelligence', 'app-1');
      expect(res).toMatchObject({ shouldRun: true, cronExpression: '*/30 * * * *' });
      getAppTaskTypeInterval.mockResolvedValue(null);
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

    it('locks the direct no-checkout reasoning posture', () => {
      expect(MANAGED_AGENT_OPTIONS['issue-watcher']).toEqual(['useWorktree', 'openPR', 'readOnly', 'worktreeChangesExpected']);
      const config = { taskMetadata: { useWorktree: false, openPR: true, discardWorktree: false } };
      expect(enforceManagedAgentOptions('issue-watcher', config)).toBe(true);
      expect(config.taskMetadata).toMatchObject({ useWorktree: false, openPR: false, readOnly: true, worktreeChangesExpected: false });
    });
  });

  describe('dependency-updates isolation posture', () => {
    // Rationale lives on the registry entry: installs are never safe in the live checkout.
    it('ships worktree + PR delivery with the no-change marker and locks only useWorktree', () => {
      expect(DEFAULT_TASK_INTERVALS['dependency-updates'].taskMetadata).toEqual({ useWorktree: true, openPR: true, noChangeSuccess: true });
      expect(MANAGED_AGENT_OPTIONS['dependency-updates']).toEqual(['useWorktree']);
    });

    it('loadSchedule re-isolates an install whose stored config predates the lock', async () => {
      mockSchedule({
        tasks: {
          'dependency-updates': { type: 'cron', cronExpression: '0 6 * * 1', enabled: true, providerId: null, model: null, prompt: null, taskMetadata: { useWorktree: false } }
        }
      })
      const meta = (await loadSchedule()).tasks['dependency-updates'].taskMetadata
      expect(meta.useWorktree).toBe(true)
      // Backfilled from the defaults by the taskMetadata deep-merge.
      expect(meta.openPR).toBe(true)
      expect(meta.noChangeSuccess).toBe(true)
    })

    // The finalizer admits a non-audit scheduled type to the no-change exemption by
    // name (lib/noChangeCompletion.js), while the schedule default is what tells the
    // agent a clean exit is allowed. Keep the two in parity so a type cannot carry
    // the marker without the exemption, or the exemption without the marker.
    it('keeps the no-change allowlist in parity with the shipped noChangeSuccess defaults', () => {
      const marked = Object.entries(DEFAULT_TASK_INTERVALS)
        .filter(([type, interval]) => !isAuditTaskType(type) && interval.taskMetadata?.noChangeSuccess === true)
        .map(([type]) => type)
      expect(new Set(marked)).toEqual(NO_CHANGE_SCHEDULED_TYPES)
    })
  });

  describe('pr-reviewer (layered public-content review task)', () => {
    it('describes the preflight-owned prompt and ships the optional three-stage pipeline read-only', () => {
      expect(TASK_TYPE_PROMPT_INFO['pr-reviewer']).toMatchObject({ mode: 'runtime-generated' });
      expect(TASK_TYPE_PROMPT_INFO['pr-reviewer'].description).toContain('tool-free eligibility gate');
      expect(DEFAULT_TASK_INTERVALS['pr-reviewer'].taskMetadata.pipeline.stages).toEqual([
        expect.objectContaining({ name: 'Security Scan', role: 'security', readOnly: true, managed: true }),
        expect.objectContaining({ name: 'Eligibility Gate', role: 'eligibility', readOnly: true, executionProfile: 'public-review-gate' }),
        expect.objectContaining({ name: 'Code Review & Validated Actions', role: 'actions', readOnly: true, executionProfile: 'public-review-gate' }),
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
      const prompt = getDefaultTaskPrompt('do-replan')
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

  describe('basic-task prompt genericization (PortOS → {appName})', () => {
    // Installs created before the Jan→Feb 2026 genericization stored a default that
    // hardcoded "PortOS" as the target app. These tasks were never versioned, so
    // they never auto-upgraded — and worse, an install that upgraded past the
    // promptVersion introduction got the old PortOS default mis-flagged
    // promptCustomized:true. The fix: version the basic tasks, keep the retired
    // defaults recognizable (by hash, in integrity.snapshot.json), and self-heal
    // the mis-flag in loadSchedule so every install converges on the generic
    // {appName} body. RETIRED_CONSOLE_ERRORS_PROMPT is one such retired default
    // — see taskPromptDefaults/retiredPromptFixtures.js.

    it('versions every active audit so deployed installs can auto-upgrade', () => {
      for (const type of AUDIT_TASK_TYPE_LIST) expect(PROMPT_VERSIONS[type]).toBeGreaterThanOrEqual(1)
    })

    it('the current documentation default no longer hardcodes PortOS', () => {
      expect(DEFAULT_TASK_PROMPTS['documentation-content']).not.toContain('PortOS')
      expect(DEFAULT_TASK_PROMPTS['documentation-content']).toContain('{appName}')
    })

    it('upgrades a stale, non-customized retired default (promptVersion: 1) to the current body', async () => {
      mockSchedule({
        tasks: { 'console-errors': { type: 'once', enabled: false, providerId: null, model: null, prompt: RETIRED_CONSOLE_ERRORS_PROMPT, promptVersion: 1 } }
      })
      const schedule = await loadSchedule()
      const task = schedule.tasks['ui-runtime-bugs']
      expect(task.prompt).toBe(DEFAULT_TASK_PROMPTS['ui-runtime-bugs'])
      expect(task.promptVersion).toBe(PROMPT_VERSIONS['ui-runtime-bugs'])
    })

    it('upgrades a pre-versioning retired default (promptVersion undefined) via the legacy-migration path', async () => {
      mockSchedule({
        tasks: { 'console-errors': { type: 'once', enabled: false, providerId: null, model: null, prompt: RETIRED_CONSOLE_ERRORS_PROMPT } }
      })
      const schedule = await loadSchedule()
      expect(schedule.tasks['ui-runtime-bugs'].prompt).toBe(DEFAULT_TASK_PROMPTS['ui-runtime-bugs'])
      expect(schedule.tasks['ui-runtime-bugs'].promptCustomized).not.toBe(true)
    })

    it('self-heals a mis-flagged promptCustomized that actually matches a retired default, then upgrades', async () => {
      mockSchedule({
        tasks: { 'console-errors': { type: 'once', enabled: false, providerId: null, model: null, prompt: RETIRED_CONSOLE_ERRORS_PROMPT, promptVersion: 1, promptCustomized: true } }
      })
      const schedule = await loadSchedule()
      const task = schedule.tasks['ui-runtime-bugs']
      expect(task.promptCustomized).not.toBe(true)
      expect(task.prompt).toBe(DEFAULT_TASK_PROMPTS['ui-runtime-bugs'])
      expect(task.promptVersion).toBe(PROMPT_VERSIONS['ui-runtime-bugs'])
    })

    it('preserves a genuine user customization even when it mentions PortOS', async () => {
      const custom = 'My own documentation prompt that happens to mention PortOS but matches no shipped default.'
      mockSchedule({
        tasks: { 'documentation-content': { type: 'once', enabled: false, providerId: null, model: null, prompt: custom, promptCustomized: true } }
      })
      const schedule = await loadSchedule()
      expect(schedule.tasks['documentation-content'].prompt).toBe(custom)
      expect(schedule.tasks['documentation-content'].promptCustomized).toBe(true)
    })
  })

  describe('promptSource provenance (issue #5432)', () => {
    // The self-heal above clears promptCustomized whenever the stored prompt
    // matches ANY shipped default (current or retired). That is right for a
    // flag the legacy migration guessed at, but it cannot tell that apart from a
    // user who deliberately pasted an older SHIPPED body into Settings →
    // Scheduled Tasks — that pin was cleared on the next load and the next
    // PROMPT_VERSIONS bump silently overwrote their chosen text. promptSource
    // records which of the two wrote the flag.
    const loadStored = async (config) => {
      mockSchedule({
        tasks: { 'console-errors': { type: 'once', enabled: false, providerId: null, model: null, ...config } }
      })
      return (await loadSchedule()).tasks['ui-runtime-bugs']
    }

    it('keeps a user-pinned retired default pinned instead of self-healing it', async () => {
      const task = await loadStored({
        prompt: RETIRED_CONSOLE_ERRORS_PROMPT,
        promptVersion: 1,
        promptCustomized: true,
        promptSource: 'user'
      })
      expect(task.promptCustomized).toBe(true)
      expect(task.prompt).toBe(RETIRED_CONSOLE_ERRORS_PROMPT)
    })

    it('still self-heals a legacy-inferred flag on a retired default', async () => {
      const task = await loadStored({
        prompt: RETIRED_CONSOLE_ERRORS_PROMPT,
        promptVersion: 1,
        promptCustomized: true,
        promptSource: 'legacy-inferred'
      })
      expect(task.promptCustomized).not.toBe(true)
      expect(task.prompt).toBe(DEFAULT_TASK_PROMPTS['ui-runtime-bugs'])
    })

    // Every install that upgrades into this field carries no promptSource at all.
    // Absent must keep behaving exactly as it does today, or the upgrade itself
    // would freeze thousands of mis-flagged prompts on their retired bodies.
    it('treats an absent promptSource as legacy-inferred (self-heals, as today)', async () => {
      const task = await loadStored({
        prompt: RETIRED_CONSOLE_ERRORS_PROMPT,
        promptVersion: 1,
        promptCustomized: true
      })
      expect(task.promptSource).toBeUndefined()
      expect(task.promptCustomized).not.toBe(true)
      expect(task.prompt).toBe(DEFAULT_TASK_PROMPTS['ui-runtime-bugs'])
    })

    it('stamps legacy-inferred when the legacy migration flags an unrecognized body', async () => {
      const custom = 'A console-errors prompt that matches no shipped default at all.'
      // No promptVersion → the legacy-migration branch runs.
      const task = await loadStored({ prompt: custom })
      expect(task.promptCustomized).toBe(true)
      expect(task.promptSource).toBe('legacy-inferred')
    })

    it('drops a stale promptSource when the config has no prompt to pin', async () => {
      const task = await loadStored({ prompt: null, promptSource: 'user' })
      expect(task.prompt).toBe(DEFAULT_TASK_PROMPTS['ui-runtime-bugs'])
      expect(task.promptSource).toBeFalsy()
    })

    it('survives a PROMPT_VERSIONS bump when the pin is user-sourced', async () => {
      const original = PROMPT_VERSIONS['ui-runtime-bugs']
      PROMPT_VERSIONS['ui-runtime-bugs'] = original + 1
      try {
        const task = await loadStored({
          prompt: RETIRED_CONSOLE_ERRORS_PROMPT,
          promptVersion: original,
          promptCustomized: true,
          promptSource: 'user'
        })
        expect(task.prompt).toBe(RETIRED_CONSOLE_ERRORS_PROMPT)
        expect(task.promptVersion).toBe(original)
      } finally {
        PROMPT_VERSIONS['ui-runtime-bugs'] = original
      }
    })

    it('upgrades the same body across a bump when the pin is legacy-inferred', async () => {
      const original = PROMPT_VERSIONS['ui-runtime-bugs']
      PROMPT_VERSIONS['ui-runtime-bugs'] = original + 1
      try {
        const task = await loadStored({
          prompt: RETIRED_CONSOLE_ERRORS_PROMPT,
          promptVersion: original,
          promptCustomized: true,
          promptSource: 'legacy-inferred'
        })
        expect(task.prompt).toBe(DEFAULT_TASK_PROMPTS['ui-runtime-bugs'])
        expect(task.promptVersion).toBe(original + 1)
      } finally {
        PROMPT_VERSIONS['ui-runtime-bugs'] = original
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
    // Their hashes are in the snapshot's history now; the fixture is the
    // `[Self-Improvement]` console-errors body.
    const loadOne = async (taskType, prompt, promptVersion) => {
      mockSchedule({
        tasks: { [taskType]: { type: 'once', enabled: false, providerId: null, model: null, prompt, promptVersion, promptCustomized: true } }
      })
      return (await loadSchedule()).tasks['ui-runtime-bugs']
    }

    // Runs under BOTH version stamps a frozen install can carry. The legacy
    // migration wrote `promptVersion = PROMPT_VERSIONS[taskType]` alongside the
    // customized flag, so an install flagged after its type was versioned holds
    // the CURRENT version with a RETIRED body — and clearing the flag alone
    // leaves `storedVersion < current` false, so the upgrade never fires.
    // Testing only the version-1 stamp misses that entirely.
    it.each([
      ['pre-versioning', 1],
      ['current-version', PROMPT_VERSIONS['ui-runtime-bugs']],
    ])('self-heals and upgrades a stored pre-unification prompt (%s stamp)', async (_label, storedVersion) => {
      const task = await loadOne('console-errors', RETIRED_CONSOLE_ERRORS_PROMPT, storedVersion)
      expect(task.promptCustomized).not.toBe(true)
      expect(task.prompt).toBe(DEFAULT_TASK_PROMPTS['ui-runtime-bugs'])
      expect(task.promptVersion).toBe(PROMPT_VERSIONS['ui-runtime-bugs'])
    })

    it('preserves a genuine user customization that merely mimics a retired header', async () => {
      const custom = '[App Improvement: {appName}] My own audit that matches no shipped default.'
      const task = await loadOne('console-errors', custom, 1)
      expect(task.prompt).toBe(custom)
      expect(task.promptCustomized).toBe(true)
    })
  })

  describe('router-reached prompt types ride the same auto-upgrade walk (issue #3998)', () => {
    // Router-reached prompts (claim-issue-gitlab, claim-issue-jira) have no
    // DEFAULT_TASK_INTERVALS entry, but loadSchedule still walks them once an
    // install has STORED one: the merge loop preserves task types absent from the
    // defaults, and the upgrade loop iterates every stored key. Whether a stored
    // RETIRED body of theirs is recognized is the predicate's own contract
    // (taskPromptDefaults.test.js) — the bodies are no longer in the tree — so
    // this pins only that the walk reaches a stored-only key.
    it.each([
      'claim-issue-gitlab',
      'claim-issue-jira',
    ])('%s: a stored, behind-version default is walked and upgraded', async (taskType) => {
      mockSchedule({
        tasks: { [taskType]: { type: 'once', enabled: false, providerId: null, model: null, prompt: DEFAULT_TASK_PROMPTS[taskType], promptVersion: 1 } }
      })
      const task = (await loadSchedule()).tasks[taskType]
      expect(task.promptCustomized).not.toBe(true)
      expect(task.prompt).toBe(DEFAULT_TASK_PROMPTS[taskType])
      expect(task.promptVersion).toBe(PROMPT_VERSIONS[taskType])
    })
  })

  describe('getDefaultTaskPrompt', () => {
    it('should return prompt for known task type', () => {
      const prompt = getDefaultTaskPrompt('security')
      expect(prompt).toBeDefined()
      expect(prompt).toContain('Security')
    })

    it('should return null for unknown task type', () => {
      const prompt = getDefaultTaskPrompt('nonexistent')
      expect(prompt).toBeNull()
    })
  })

  describe('execution field write safety', () => {
    it('keeps a persisted custom prompt readable after rejecting malformed updates', async () => {
      mockSchedule();
      await updateTaskInterval('documentation-content', { prompt: 'Example custom prompt', providerId: 'example-provider', model: 'example-model' });
      const saved = JSON.parse(writeFile.mock.calls.at(-1)[1]);
      const original = saved.tasks['documentation-content'];
      readJSONFile.mockResolvedValue(saved);
      writeFile.mockClear();
      for (const field of ['prompt', 'providerId', 'model']) {
        for (const value of [{ text: 'Example malformed prompt' }, ['example'], true, 42]) {
          await expect(updateTaskInterval('documentation-content', { [field]: value })).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
        }
      }
      expect(writeFile).not.toHaveBeenCalled();
      expect(saved.tasks['documentation-content']).toEqual(original);
      expect(await getTaskPrompt('documentation-content')).toBe('Example custom prompt');
      expect(original).toMatchObject({ promptSource: 'user', providerId: 'example-provider', model: 'example-model' });
    });
  });

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

    it('do-release delegates to slashdo release and requires a named release heading', async () => {
      const prompt = await getTaskPrompt('do-release')
      expect(prompt).toContain('/do:release')
      expect(prompt).toContain('{reviewers}')
      expect(prompt).toContain('# Release vX.Y.Z - <Fun Name>')
      expect(prompt).toContain('one or two biggest user-visible wins')
      expect(prompt).toContain('GitHub release title')
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
        if (taskType === 'do-release') {
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
        if (taskType === 'do-release') expect(meta.slashdoCommand).toBe('release')
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

  it('ships the design and usability domain as an on-demand filing audit with rendered evidence', async () => {
    const type = 'design-usability'
    expect(DEFAULT_TASK_INTERVALS[type]).toMatchObject({
      type: INTERVAL_TYPES.ON_DEMAND, enabled: true,
      taskMetadata: { fileIssues: true, useWorktree: false, openPR: false },
    })
    expect(MANAGED_AGENT_OPTIONS[type]).toBeUndefined()
    const prompt = await getTaskPrompt(type)
    expect(prompt).toContain('{modeInstructions}')
    expect(prompt).toContain('six screenshots')
    expect(prompt).toContain('authored theme')
    expect(modeContractFor(true)).toContain('deliverable is tracker items, not code')
  })

  describe('media-render-research defaults', () => {
    it('is an on-demand tracker-filing research task that files labelled media issues', async () => {
      expect(SELF_IMPROVEMENT_TASK_TYPES).toContain('media-render-research')
      expect(DEFAULT_TASK_INTERVALS['media-render-research']).toMatchObject({
        type: INTERVAL_TYPES.ON_DEMAND,
        enabled: true,
        taskMetadata: { useWorktree: false, openPR: false, readOnly: false },
      })
      const { resolveTrackerFilingBlock } = await import('../lib/workTracker.js')
      const block = await resolveTrackerFilingBlock({ repoPath: '/tmp/example-repo', workTracker: 'github' }, 'media-render-research')
      expect(block.trackerInstructions).toContain('--label media-research --label area:media --label plan')
    })
  })

  describe('plan-feature defaults', () => {
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
      expect(block.trackerInstructions).toContain('The issue number is its ID')
      expect(block.trackerInstructions).not.toContain('ID beginning with `plan-feature-`')
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
    // Every file-issues-by-default lane, in ONE table: the posture is a single
    // product decision ("an unattended scheduled run must not land code"), so
    // asserting it in two places 20 lines apart just means a future flag gets
    // added to one of them. Every audit includes open issues; some also preload
    // PRs to dedup against work in flight without spending forge calls. Every
    // audit also preloads its recent slices so runs rotate coverage (#12090)
    // and its lane health so it does not re-file a rejected finding (#12088).
    const FILE_ISSUES_LANES = AUDIT_TASK_TYPE_LIST.filter(defaultFileIssuesFor)
    it('ships open issues, the slice rotation record and lane health for every scheduled quality audit', () => {
      for (const taskType of AUDIT_TASK_TYPE_LIST) {
        expect(DEFAULT_TASK_INTERVALS[taskType]?.dataInputs, taskType).toContain('open-issues')
        expect(DEFAULT_TASK_INTERVALS[taskType]?.dataInputs, taskType).toContain('audit-slice-history')
        expect(DEFAULT_TASK_INTERVALS[taskType]?.dataInputs, taskType).toContain('lane-health')
      }
    })

    it.each(FILE_ISSUES_LANES)('registers %s as an enabled on-demand file-issues audit', (taskType) => {
      expect(SELF_IMPROVEMENT_TASK_TYPES).toContain(taskType)
      expect(TASK_TYPE_DESCRIPTIONS[taskType]).toBeTruthy()
      expect(DEFAULT_TASK_PROMPTS[taskType]).toBeTruthy()
      const cfg = DEFAULT_TASK_INTERVALS[taskType]
      expect(cfg.type).toBe(INTERVAL_TYPES.ON_DEMAND)
      expect(cfg.enabled).toBe(true)
      expect(cfg.taskMetadata.fileIssues).toBe(true)
      expect(cfg.taskMetadata.useWorktree).toBe(false)
      expect(cfg.taskMetadata.openPR).toBe(false)
      expect(cfg.dataInputs).toContain('open-issues')
      // The file-issues posture is enforced at dispatch, so the user can still
      // flip the toggle and implement.
      expect(MANAGED_AGENT_OPTIONS[taskType]).toBeUndefined()
    })

    it('requires worktree isolation for the lanes whose remediation restructures code', () => {
      expect(AUDIT_TASK_TYPE_LIST.filter(auditDoWorkRequiresWorktree)).toEqual([
        'better-dependency-freedom', 'architecture-maintainability', 'code-simplification',
      ])
    })

    it('backfills audit-slice-history and lane-health once on persisted v2 schedules lacking auditDataInputsVersion', async () => {
      mockSchedule({
        version: 2,
        tasks: {
          security: { type: 'on-demand', enabled: true, dataInputs: ['open-issues'] },
          privacy: { type: 'on-demand', enabled: true, dataInputs: ['open-issues', 'open-pull-requests'] },
          'plan-feature': { type: 'on-demand', enabled: true, dataInputs: ['open-issues'] },
        },
      })
      const loaded = await loadSchedule()
      expect(loaded.auditDataInputsVersion).toBe(1)
      expect(loaded.tasks.security.dataInputs).toEqual(['open-issues', 'audit-slice-history', 'lane-health'])
      expect(loaded.tasks.privacy.dataInputs).toEqual(['open-issues', 'open-pull-requests', 'audit-slice-history', 'lane-health'])
      // Non-audit tasks are untouched.
      expect(loaded.tasks['plan-feature'].dataInputs).toEqual(['open-issues'])

      // Once auditDataInputsVersion: 1 is stamped, an explicit user removal is respected.
      mockSchedule({
        version: 2,
        auditDataInputsVersion: 1,
        tasks: {
          security: { type: 'on-demand', enabled: true, dataInputs: ['open-issues'] },
        },
      })
      const respected = await loadSchedule()
      expect(respected.tasks.security.dataInputs).toEqual(['open-issues'])
    })

    it('surfaces fileIssuesCapable on audit types in getScheduleStatus', async () => {
      mockSchedule()
      const status = await getScheduleStatus()
      expect(status.tasks.security).toMatchObject({ fileIssuesCapable: true, defaultFileIssues: false })
      expect(status.tasks['design-usability']).toMatchObject({ fileIssuesCapable: true, defaultFileIssues: true })
      expect(status.tasks['architecture-maintainability']).toMatchObject({
        fileIssuesCapable: true, defaultFileIssues: true, doWorkRequiresWorktree: true,
      })
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
})
