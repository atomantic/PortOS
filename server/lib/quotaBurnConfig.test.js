import { describe, expect, it } from 'vitest';
import {
  QUOTA_BURN_FAMILIES,
  QUOTA_BURN_JOB_CATALOG,
  QUOTA_BURN_JOB_TYPES,
  familyIsActionable,
  normalizeQuotaBurnConfig,
  normalizeQuotaBurnJob,
} from './quotaBurnConfig.js';

describe('normalizeQuotaBurnConfig', () => {
  it('materializes every family so absent is never confused with off', () => {
    const config = normalizeQuotaBurnConfig(undefined);
    expect(Object.keys(config.families).sort()).toEqual([...QUOTA_BURN_FAMILIES].sort());
    expect(config.enabled).toBe(false);
    expect(Object.values(config.families).every((family) => family.enabled === false)).toBe(true);
  });

  it('drops unknown family keys and clamps out-of-range window settings', () => {
    const config = normalizeQuotaBurnConfig({
      families: {
        grok: { enabled: true, resetWithinHours: 999, reservePercent: -5, maxDispatchesPerWindow: 0, priority: 1e6 },
        nonsense: { enabled: true },
      },
    });
    expect(config.families.nonsense).toBeUndefined();
    expect(config.families.grok).toMatchObject({
      resetWithinHours: 168, reservePercent: 0, maxDispatchesPerWindow: 1, priority: 100,
    });
  });

  it('clamps the check interval into the polling bounds', () => {
    expect(normalizeQuotaBurnConfig({ checkIntervalMinutes: 1 }).checkIntervalMinutes).toBe(5);
    expect(normalizeQuotaBurnConfig({ checkIntervalMinutes: 99999 }).checkIntervalMinutes).toBe(720);
    expect(normalizeQuotaBurnConfig({ checkIntervalMinutes: 'nope' }).checkIntervalMinutes).toBe(30);
  });
});

describe('normalizeQuotaBurnJob', () => {
  it('drops a job whose type is unknown rather than substituting a default', () => {
    // Substituting would run DIFFERENT work than configured and spend real
    // subscription quota on it — strictly worse than the job disappearing.
    expect(normalizeQuotaBurnJob({ jobType: 'delete-everything' })).toBeNull();
    expect(normalizeQuotaBurnJob({ jobType: 'agent-prompt' })).toMatchObject({ jobType: 'agent-prompt', enabled: true });
  });

  it('mints a stable id for a job written before ids existed', () => {
    expect(normalizeQuotaBurnJob({ jobType: 'agent-prompt' }, 2).id).toBe('job-3');
  });

  it('keeps scalar params and strips nested blobs and prototype keys', () => {
    const job = normalizeQuotaBurnJob({
      jobType: 'agent-prompt',
      params: { appId: 'a1', maxEntries: 5, openPR: false, mode: null, nested: { a: 1 }, __proto__: { polluted: true } },
    });
    expect(job.params).toEqual({ appId: 'a1', maxEntries: 5, openPR: false, mode: null });
  });
});

describe('familyIsActionable', () => {
  it('requires an enabled family AND at least one enabled job', () => {
    expect(familyIsActionable({ enabled: false, jobs: [{ enabled: true }] })).toBe(false);
    expect(familyIsActionable({ enabled: true, jobs: [] })).toBe(false);
    expect(familyIsActionable({ enabled: true, jobs: [{ enabled: false }] })).toBe(false);
    expect(familyIsActionable({ enabled: true, jobs: [{ enabled: true }] })).toBe(true);
  });
});

describe('QUOTA_BURN_JOB_CATALOG', () => {
  it('describes exactly the registered job types', () => {
    expect(QUOTA_BURN_JOB_CATALOG.map((entry) => entry.id).sort()).toEqual([...QUOTA_BURN_JOB_TYPES].sort());
  });

  it('gives every param a key and a renderable kind', () => {
    // The client builds its form from these descriptors alone, so a param
    // without a kind would render as nothing and silently stay unconfigurable.
    for (const entry of QUOTA_BURN_JOB_CATALOG) {
      for (const param of entry.params) {
        expect(typeof param.key).toBe('string');
        expect(['app', 'text', 'boolean', 'universe', 'enum', 'number', 'imageMode']).toContain(param.kind);
      }
    }
  });
});
