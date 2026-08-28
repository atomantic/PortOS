import { describe, expect, it } from 'vitest';
import {
  QUOTA_BURN_FAMILIES,
  QUOTA_BURN_JOB_CATALOG,
  QUOTA_BURN_JOB_TYPES,
  QUOTA_BURN_UNLIMITED_DISPATCHES,
  familyHasRunnableJobs,
  familyIsConfigured,
  isUnlimitedDispatchCap,
  jobIsSpent,
  normalizeQuotaBurnConfig,
  normalizeQuotaBurnJob,
  quotaBurnJobKey,
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

  it('drops the retired per-family providerId / scope keys from an older plan', () => {
    // Both were removed from the family shape; a config file written before that
    // must still load, minus the keys, rather than carrying dead state forward.
    const family = normalizeQuotaBurnConfig({
      families: { grok: { enabled: true, providerId: 'grok-cli', scope: 'session' } },
    }).families.grok;
    expect(family.enabled).toBe(true);
    expect(family).not.toHaveProperty('providerId');
    expect(family).not.toHaveProperty('scope');
  });

  it('defaults the dispatch cap to unlimited', () => {
    const config = normalizeQuotaBurnConfig({ families: { grok: { enabled: true } } });
    expect(config.families.grok.maxDispatchesPerWindow).toBe(QUOTA_BURN_UNLIMITED_DISPATCHES);
    expect(normalizeQuotaBurnConfig(undefined).families.claude.maxDispatchesPerWindow)
      .toBe(QUOTA_BURN_UNLIMITED_DISPATCHES);
  });

  it('preserves the unlimited sentinel instead of clamping it up to the minimum', () => {
    // The sentinel sits BELOW the field's own minimum, so the generic clamp
    // would fold -1 to 1 and silently reinstate a cap of one burn per window.
    const config = normalizeQuotaBurnConfig({
      families: { grok: { enabled: true, maxDispatchesPerWindow: -1 }, codex: { maxDispatchesPerWindow: -99 } },
    });
    expect(config.families.grok.maxDispatchesPerWindow).toBe(-1);
    expect(config.families.codex.maxDispatchesPerWindow).toBe(-1);
  });

  it('keeps a real cap the user set', () => {
    const config = normalizeQuotaBurnConfig({ families: { grok: { maxDispatchesPerWindow: 3 } } });
    expect(config.families.grok.maxDispatchesPerWindow).toBe(3);
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

  it('treats an absent runOnce as repeating so an older plan keeps its meaning', () => {
    // Opt-IN. Every plan written before this field existed is standing work, and
    // coercing those to one-shot would silently retire someone's whole rotation.
    expect(normalizeQuotaBurnJob({ jobType: 'agent-prompt' }).runOnce).toBe(false);
    expect(normalizeQuotaBurnJob({ jobType: 'agent-prompt', runOnce: 'yes' }).runOnce).toBe(false);
    expect(normalizeQuotaBurnJob({ jobType: 'agent-prompt', runOnce: true }).runOnce).toBe(true);
  });

  it('normalizes effort and model strings', () => {
    expect(normalizeQuotaBurnJob({ jobType: 'agent-prompt', model: '  claude-sonnet-4  ', effort: '  high  ' }))
      .toMatchObject({ model: 'claude-sonnet-4', effort: 'high' });
    expect(normalizeQuotaBurnJob({ jobType: 'agent-prompt', model: '', effort: '' }))
      .toMatchObject({ model: null, effort: null });
  });
});

describe('jobIsSpent', () => {
  const ran = { 'grok:j1': '2026-08-01T00:00:00.000Z' };

  it('only retires a job that opted into running once', () => {
    // A completion is kept even after the checkbox is cleared, so the flag — not
    // the ledger entry — is what decides whether the job still runs.
    expect(jobIsSpent({ id: 'j1', runOnce: true }, 'grok', ran)).toBe(true);
    expect(jobIsSpent({ id: 'j1', runOnce: false }, 'grok', ran)).toBe(false);
  });

  it('scopes the completion to the family, so two plans cannot retire each other', () => {
    expect(jobIsSpent({ id: 'j1', runOnce: true }, 'claude', ran)).toBe(false);
    expect(quotaBurnJobKey('grok', 'j1')).toBe('grok:j1');
  });

  it('reads an unrecorded job as unspent, including with no ledger at all', () => {
    expect(jobIsSpent({ id: 'j2', runOnce: true }, 'grok', ran)).toBe(false);
    expect(jobIsSpent({ id: 'j1', runOnce: true }, 'grok')).toBe(false);
  });

  it('keeps scalar params and strips nested blobs and prototype keys', () => {
    // `JSON.parse`, not an object literal: `{ __proto__: … }` in a literal sets
    // [[Prototype]] rather than creating an own property, so Object.entries
    // never sees it and the assertion would pass with the guard deleted. This
    // is the shape the config file actually arrives in.
    const params = JSON.parse('{"appId":"a1","maxEntries":5,"openPR":false,"mode":null,"__proto__":"x","constructor":"y","prototype":"z","nested":{"a":1}}');
    const job = normalizeQuotaBurnJob({ jobType: 'agent-prompt', params });
    expect(job.params).toEqual({ appId: 'a1', maxEntries: 5, openPR: false, mode: null });
    expect(Object.prototype.polluted).toBeUndefined();
  });
});

describe('familyIsConfigured', () => {
  it('requires an enabled family AND at least one enabled job', () => {
    expect(familyIsConfigured({ enabled: false, jobs: [{ enabled: true }] })).toBe(false);
    expect(familyIsConfigured({ enabled: true, jobs: [] })).toBe(false);
    expect(familyIsConfigured({ enabled: true, jobs: [{ enabled: false }] })).toBe(false);
    expect(familyIsConfigured({ enabled: true, jobs: [{ enabled: true }] })).toBe(true);
  });
});

describe('familyHasRunnableJobs', () => {
  const family = {
    id: 'grok',
    enabled: true,
    jobs: [{ id: 'j1', enabled: true, runOnce: true }, { id: 'j2', enabled: false }],
  };
  const ran = { 'grok:j1': '2026-08-01T00:00:00.000Z' };

  it('stops being runnable once every enabled job is a spent one-shot', () => {
    // `familyIsConfigured` still answers "you configured something" — the runner
    // and the page report those as two different verdicts, because a finished
    // plan wants Re-arm and an unset one wants a job added.
    expect(familyIsConfigured(family)).toBe(true);
    expect(familyHasRunnableJobs(family, ran)).toBe(false);
    // One repeating job is enough to keep the plan alive.
    expect(familyHasRunnableJobs({ ...family, jobs: [...family.jobs, { id: 'j3', enabled: true }] }, ran)).toBe(true);
  });

  it('is safe to pass straight to some/filter/map', () => {
    // The reason this is a second named predicate rather than an optional second
    // argument: array callbacks pass the INDEX as arg two, which on an
    // arity-overloaded predicate silently becomes the completion ledger.
    expect([family].some(familyHasRunnableJobs)).toBe(true);
    expect([family].filter(familyIsConfigured)).toHaveLength(1);
  });
});

describe('isUnlimitedDispatchCap', () => {
  it('reads any negative cap as unlimited and a real cap as bounded', () => {
    expect(isUnlimitedDispatchCap(QUOTA_BURN_UNLIMITED_DISPATCHES)).toBe(true);
    expect(isUnlimitedDispatchCap(-5)).toBe(true);
    expect(isUnlimitedDispatchCap(1)).toBe(false);
    expect(isUnlimitedDispatchCap(50)).toBe(false);
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
