import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TASK_INTERVALS,
  PROGRAMMATIC_SCHEDULED_TASK_TYPES,
  isProgrammaticScheduledTaskType,
} from './taskScheduleRegistry.js';
import { SCHEDULED_HANDLER_MODULES } from './scheduledHandlers/index.js';
import { QUOTA_BURN_JOB_TYPES } from '../lib/quotaBurnConfig.js';
import { planQuotaBurnStepConversion } from '../lib/quotaBurnLegacyConversion.js';
import { QUOTA_BURN_JOB_CATALOG } from '../lib/quotaBurnConfig.js';
import { sanitizeTaskMetadata } from '../lib/cosValidation.js';

// The catalog row Quota Burn renders its job form from, keyed by param.
const catalogParams = (taskType) => Object.fromEntries(
  (QUOTA_BURN_JOB_CATALOG.find((row) => row.id === taskType)?.params || []).map((p) => [p.key, p])
);

describe('programmatic scheduled handlers — registration parity', () => {
  // The task-type list is written out in taskScheduleRegistry rather than
  // derived from the handler module map, so that a registry reached by most of
  // the server suite doesn't take on an import for two strings (server/AGENTS.md,
  // "Import scoping"). This is the assertion that makes the split safe.
  it('names exactly the registered handler modules', () => {
    expect([...PROGRAMMATIC_SCHEDULED_TASK_TYPES].sort())
      .toEqual(Object.keys(SCHEDULED_HANDLER_MODULES).sort());
    for (const taskType of PROGRAMMATIC_SCHEDULED_TASK_TYPES) {
      expect(isProgrammaticScheduledTaskType(taskType), taskType).toBe(true);
    }
    expect(isProgrammaticScheduledTaskType('security')).toBe(false);
    // An inherited key must not resolve to a handler.
    expect(isProgrammaticScheduledTaskType('constructor')).toBe(false);
  });

  it('is what a legacy programmatic burn step converts INTO — one implementation, not two', () => {
    // #6376 moved these out of quotaBurnJobs/ and #6381 retired that registry
    // entirely: a legacy programmatic step now converts to a reference to the
    // registered handler. A conversion naming anything else would resurrect the
    // second implementation the move existed to remove.
    for (const taskType of PROGRAMMATIC_SCHEDULED_TASK_TYPES) {
      const outcome = planQuotaBurnStepConversion({ id: 's1', jobType: taskType, params: { maxEntries: 3 } }, { familyId: 'grok' });
      expect(outcome.taskRef, taskType).toEqual({ kind: 'builtin', taskType, appId: null });
      expect(outcome.customJob, taskType).toBeNull();
      expect(SCHEDULED_HANDLER_MODULES[taskType], taskType).toBeTypeOf('function');
    }
    // Every legacy job type has a conversion rule — the guard the retired
    // registry's own parity test used to provide. A type with none would leave a
    // stored step permanently un-migrated and permanently unavailable.
    for (const jobType of QUOTA_BURN_JOB_TYPES) {
      expect(planQuotaBurnStepConversion({ id: 's1', jobType, params: { appId: 'a1', prompt: 'do the thing' } }, { familyId: 'grok' }), jobType)
        .not.toBeNull();
    }
    expect(QUOTA_BURN_JOB_CATALOG.map((entry) => entry.id).sort()).toEqual([...QUOTA_BURN_JOB_TYPES].sort());
  });

  it('exports the countPending/run contract from every handler module', async () => {
    for (const taskType of PROGRAMMATIC_SCHEDULED_TASK_TYPES) {
      const mod = await SCHEDULED_HANDLER_MODULES[taskType]();
      expect(typeof mod.countPending, taskType).toBe('function');
      expect(typeof mod.run, taskType).toBe('function');
    }
  });
});

describe('programmatic scheduled handlers — shipped params', () => {
  it('ships the same defaults the Quota Burn job form advertises', () => {
    // Two doors onto one handler: a scheduled default that disagreed with the
    // burn form would make the same action do different work depending on where
    // it was started from.
    for (const taskType of PROGRAMMATIC_SCHEDULED_TASK_TYPES) {
      const params = catalogParams(taskType);
      expect(Object.keys(params).length, taskType).toBeGreaterThan(0);
      const expected = Object.fromEntries(
        Object.entries(params)
          // A null catalog default means "unset — the handler resolves it"
          // (the image job's render backend), which is not a stored value.
          .filter(([, p]) => p.default !== null && p.default !== undefined)
          .map(([key, p]) => [key, p.default])
      );
      expect(DEFAULT_TASK_INTERVALS[taskType].taskMetadata, taskType).toEqual(expected);
    }
  });

  it('survives task-metadata sanitization unchanged', () => {
    // taskMetadata is allow-listed (lib/cosValidation.js). A param the sanitizer
    // doesn't know is silently dropped on the first save, so the shipped default
    // would quietly stop being what the handler runs.
    for (const taskType of PROGRAMMATIC_SCHEDULED_TASK_TYPES) {
      const shipped = DEFAULT_TASK_INTERVALS[taskType].taskMetadata;
      expect(sanitizeTaskMetadata(shipped), taskType).toEqual(shipped);
    }
  });

  it('drops out-of-contract param values instead of storing them', () => {
    // A hand-edited schedule must not put a path segment where a universe id
    // belongs, an unbounded batch size where the cap belongs, or a backend that
    // batch rendering rejects downstream.
    expect(sanitizeTaskMetadata({
      universeId: '../../etc', scope: 'nonsense', depth: 'deep', maxEntries: 5000, mode: 'external',
    })).toBeNull();
    expect(sanitizeTaskMetadata({ universeId: 'u1', scope: 'canon', depth: 'core', maxEntries: 5, mode: 'codex' }))
      .toEqual({ universeId: 'u1', scope: 'canon', depth: 'core', maxEntries: 5, mode: 'codex' });
    // 'all' is a value, not an absence — it must survive.
    expect(sanitizeTaskMetadata({ universeId: 'all' })).toEqual({ universeId: 'all' });
  });
});
