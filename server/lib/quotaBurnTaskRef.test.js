import { describe, expect, it } from 'vitest';
import {
  QUOTA_BURN_TASK_REF_KIND,
  QUOTA_BURN_UNAVAILABLE,
  applyQuotaBurnAvailability,
  normalizeQuotaBurnTaskRef,
  quotaBurnStepIsDispatchable,
  resolveQuotaBurnStepAvailability,
} from './quotaBurnTaskRef.js';
import { normalizeQuotaBurnConfig } from './quotaBurnConfig.js';

const builtin = (taskType, appId = null) => ({ kind: 'builtin', taskType, appId });

describe('normalizeQuotaBurnTaskRef', () => {
  it('never infers a kind from the fields that happen to be present', () => {
    // Guessing is the failure this model exists to remove: a payload that names
    // a task type but no kind is an unconverted legacy step, not a reference.
    expect(normalizeQuotaBurnTaskRef({ taskType: 'ux', appId: 'app-1' })).toBeNull();
    expect(normalizeQuotaBurnTaskRef({ kind: 'scheduled', taskType: 'ux' })).toBeNull();
    expect(normalizeQuotaBurnTaskRef({ kind: 'builtin' })).toBeNull();
    expect(normalizeQuotaBurnTaskRef({ kind: 'custom', jobId: '   ' })).toBeNull();
  });

  it('keeps a custom reference free of an app scope the job itself owns', () => {
    expect(normalizeQuotaBurnTaskRef({ kind: 'custom', jobId: 'job-7', appId: 'app-1' }))
      .toEqual({ kind: QUOTA_BURN_TASK_REF_KIND.CUSTOM, jobId: 'job-7' });
  });
});

describe('resolveQuotaBurnStepAvailability', () => {
  const catalog = {
    builtin: {
      ux: { enabled: true },
      security: { enabled: false },
      'stash-cleanup': { enabled: true, eligible: false },
      'pr-reviewer': { enabled: true, appIds: ['app-1'] },
      'model-comparison-refresh': { enabled: true },
    },
    custom: {
      'job-1': { enabled: true, appId: 'app-1' },
      'job-2': { enabled: false, appId: 'app-1' },
    },
  };
  const step = (taskRef) => ({ id: 's1', enabled: true, taskRef, unavailable: null });

  it('clears a healthy reference of either kind', () => {
    expect(resolveQuotaBurnStepAvailability(step(builtin('ux')), catalog)).toBeNull();
    expect(resolveQuotaBurnStepAvailability(step({ kind: 'custom', jobId: 'job-1' }), catalog)).toBeNull();
  });

  it('names why a step cannot run, one code per distinct cause', () => {
    const code = (ref) => resolveQuotaBurnStepAvailability(step(ref), catalog)?.code;
    expect(code(builtin('does-not-exist'))).toBe(QUOTA_BURN_UNAVAILABLE.UNKNOWN_TASK);
    expect(code(builtin('security'))).toBe(QUOTA_BURN_UNAVAILABLE.DISABLED);
    expect(code(builtin('stash-cleanup'))).toBe(QUOTA_BURN_UNAVAILABLE.INCOMPATIBLE);
    expect(code(builtin('pr-reviewer'))).toBe(QUOTA_BURN_UNAVAILABLE.MISSING_APP);
    expect(code(builtin('pr-reviewer', 'app-9'))).toBe(QUOTA_BURN_UNAVAILABLE.WRONG_SCOPE);
    expect(code(builtin('model-comparison-refresh', 'app-1'))).toBe(QUOTA_BURN_UNAVAILABLE.WRONG_SCOPE);
    expect(code({ kind: 'custom', jobId: 'job-gone' })).toBe(QUOTA_BURN_UNAVAILABLE.DANGLING_JOB);
    expect(code({ kind: 'custom', jobId: 'job-2' })).toBe(QUOTA_BURN_UNAVAILABLE.DISABLED);
  });

  it('withholds every catalog-dependent verdict when the catalog is missing', () => {
    // A caller reading the plan before the schedule store is up must not
    // declare every step dangling and wipe the page's plan.
    expect(resolveQuotaBurnStepAvailability(step(builtin('ux')), {})).toBeNull();
    expect(resolveQuotaBurnStepAvailability(step({ kind: 'custom', jobId: 'job-1' }), {})).toBeNull();
    // Scope is the exception: it is a property of the reference itself, so a
    // hand-edited step that dropped its required app is broken with or without
    // a catalog and still says so.
    expect(resolveQuotaBurnStepAvailability(step(builtin('pr-reviewer')), {})?.code)
      .toBe(QUOTA_BURN_UNAVAILABLE.MISSING_APP);
  });

  it('leaves an un-migrated legacy step on its migration reason', () => {
    const legacy = { id: 's1', enabled: true, taskRef: null, unavailable: { code: QUOTA_BURN_UNAVAILABLE.LEGACY_UNMIGRATED, reason: 'waiting' } };
    expect(resolveQuotaBurnStepAvailability(legacy, catalog)).toEqual(legacy.unavailable);
  });

  it('stamps a whole config without mutating it or reaching disk', () => {
    const config = normalizeQuotaBurnConfig({
      families: { claude: { enabled: true, jobs: [{ id: 'gone', taskRef: builtin('does-not-exist'), label: 'Nightly sweep', runOnce: true }] } },
    });
    const stamped = applyQuotaBurnAvailability(config, catalog);
    expect(stamped.families.claude.jobs[0]).toMatchObject({
      id: 'gone', label: 'Nightly sweep', runOnce: true,
      unavailable: { code: QUOTA_BURN_UNAVAILABLE.UNKNOWN_TASK },
    });
    expect(config.families.claude.jobs[0].unavailable).toBeNull();
    expect(quotaBurnStepIsDispatchable(stamped.families.claude.jobs[0])).toBe(false);
  });
});

describe('quotaBurnStepIsDispatchable', () => {
  it('requires a reference, an unavailability-free verdict, and the user switch', () => {
    const ok = { enabled: true, taskRef: builtin('ux'), unavailable: null };
    expect(quotaBurnStepIsDispatchable(ok)).toBe(true);
    expect(quotaBurnStepIsDispatchable({ ...ok, enabled: false })).toBe(false);
    expect(quotaBurnStepIsDispatchable({ ...ok, unavailable: { code: 'disabled' } })).toBe(false);
    expect(quotaBurnStepIsDispatchable({ ...ok, taskRef: null })).toBe(false);
  });
});
