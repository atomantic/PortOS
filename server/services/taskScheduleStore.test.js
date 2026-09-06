import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  persisted: null,
  writes: []
}));

vi.mock('./cosEvents.js', () => ({
  cosEvents: { emit: vi.fn() },
  emitLog: vi.fn()
}));

vi.mock('./taskLearning.js', () => ({
  getAdaptiveCooldownMultiplier: vi.fn().mockResolvedValue({
    multiplier: 1,
    reason: 'insufficient-data',
    skip: false,
    successRate: null,
    completed: 0
  })
}));

vi.mock('./apps.js', () => ({
  isTaskTypeEnabledForApp: vi.fn().mockResolvedValue(true),
  getAppTaskTypeInterval: vi.fn().mockResolvedValue(null),
  getAppTaskTypeIntervalMs: vi.fn().mockResolvedValue(null),
  getActiveApps: vi.fn().mockResolvedValue([]),
  getAppTaskTypeOverrides: vi.fn().mockResolvedValue({}),
  clearAllPrWatcherState: vi.fn().mockResolvedValue({ changed: false })
}));

vi.mock('../lib/timezone.js', () => ({
  getLocalParts: vi.fn(() => ({ dayOfWeek: 3 }))
}));

vi.mock('./userTimezone.js', () => ({
  getUserTimezone: vi.fn().mockResolvedValue('America/Los_Angeles')
}));

vi.mock('./eventScheduler.js', () => ({
  parseCronToNextRun: vi.fn(),
  parseCronToPrevRun: vi.fn()
}));

vi.mock('./cosState.js', async () => {
  const actual = await vi.importActual('./cosState.js');
  return {
    ...actual,
    loadState: vi.fn().mockResolvedValue({ config: { improvementEnabled: true } })
  };
});

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return {
    ...actual,
    PATHS: { ...actual.PATHS, cos: '/mock/data/cos' },
    ensureDir: vi.fn().mockResolvedValue(),
    readJSONFile: vi.fn(async () => state.persisted === null ? null : structuredClone(state.persisted)),
    atomicWrite: vi.fn(async (_filePath, schedule) => {
      await new Promise(resolve => setTimeout(resolve, 5));
      state.persisted = structuredClone(schedule);
      state.writes.push(structuredClone(schedule));
    })
  };
});

import { loadSchedule, updateSchedule } from './taskScheduleStore.js';
import { updateTaskInterval } from './taskSchedule.js';
import { recordTaskTypeFailure } from './taskScheduleBackoff.js';

describe('taskScheduleStore', () => {
  beforeEach(() => {
    state.persisted = {
      version: 2,
      tasks: {
        security: { type: 'weekly', enabled: false, prompt: null }
      },
      executions: {},
      templates: []
    };
    state.writes = [];
  });

  it('preserves concurrent task settings and execution backoff updates', async () => {
    const settingsUpdate = updateSchedule(async (schedule) => {
      schedule.tasks.security.enabled = true;
      return { result: schedule.tasks.security, changed: true };
    });
    const failureUpdate = updateSchedule(async (schedule) => {
      schedule.executions['task:security'] = {
        lastRun: null,
        count: 0,
        perApp: {},
        consecutiveFailures: 1,
        lastErrorCategory: 'provider'
      };
      return { result: schedule.executions['task:security'], changed: true };
    });

    await Promise.all([settingsUpdate, failureUpdate]);

    expect(state.persisted.tasks.security.enabled).toBe(true);
    expect(state.persisted.executions['task:security'].consecutiveFailures).toBe(1);
    expect(state.persisted.executions['task:security'].lastErrorCategory).toBe('provider');
    expect(state.writes).toHaveLength(2);
  });

  it('serializes updateTaskInterval and recordTaskTypeFailure together', async () => {
    const settingsUpdate = updateTaskInterval('security', { enabled: true });
    const failureUpdate = recordTaskTypeFailure('security', null, { errorCategory: 'provider' });

    await Promise.all([settingsUpdate, failureUpdate]);

    expect(state.persisted.tasks.security.enabled).toBe(true);
    expect(state.persisted.executions['task:security'].consecutiveFailures).toBe(1);
    expect(state.persisted.executions['task:security'].lastErrorCategory).toBe('provider');
  });

  it('migrates the former two-stage pr-reviewer schedule to the gated pipeline', async () => {
    state.persisted = {
      version: 2,
      tasks: {
        'pr-reviewer': {
          type: 'on-demand',
          enabled: true,
          prompt: null,
          taskMetadata: {
            pipeline: {
              stages: [
                { name: 'Security Scan', promptKey: 'pr-reviewer-security', readOnly: true },
                { name: 'Code Review & Actions', promptKey: 'pr-reviewer-review', providerId: 'codex-cli', model: 'gpt-5.6' },
              ],
            },
          },
        },
      },
      executions: {},
      templates: [],
    };

    const schedule = await loadSchedule();
    const stages = schedule.tasks['pr-reviewer'].taskMetadata.pipeline.stages;

    expect(stages).toHaveLength(3);
    expect(stages[1]).toMatchObject({ role: 'eligibility', promptKey: 'pr-reviewer-eligibility', executionProfile: 'public-review-gate' });
    expect(stages[2]).toMatchObject({ role: 'actions', providerId: 'codex-cli', model: 'gpt-5.6', executionProfile: 'public-review-gate' });
    expect(state.writes.at(-1).tasks['pr-reviewer'].taskMetadata.pipeline.stages).toHaveLength(3);
  });
});
