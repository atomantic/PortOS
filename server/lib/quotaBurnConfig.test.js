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
import { QUOTA_BURN_UNAVAILABLE, quotaBurnStepIsDispatchable } from './quotaBurnTaskRef.js';

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

describe('normalizeQuotaBurnJob — scheduled-task references', () => {
  const ref = { kind: 'builtin', taskType: 'ux', appId: 'app-1' };

  it('round-trips a reference step through save and reload unchanged', () => {
    // The whole point of the reference model: identity survives a reload, so a
    // step stays the step the user configured — no prompt-text re-derivation.
    const stored = {
      enabled: true,
      jobs: [{
        id: 'step-1', enabled: false, label: 'Nightly UX sweep', runOnce: true,
        taskRef: ref,
        overrides: { providerId: 'claude-code-tui', model: 'opus', effort: 'high', params: { fileIssues: true, maxEntries: 3 } },
      }],
    };
    const once = normalizeQuotaBurnConfig({ families: { claude: stored } }).families.claude;
    const twice = normalizeQuotaBurnConfig({ families: { claude: once } }).families.claude;
    expect(twice).toEqual(once);
    expect(once.jobs[0]).toMatchObject({
      id: 'step-1', enabled: false, label: 'Nightly UX sweep', runOnce: true, jobType: null, unavailable: null,
      taskRef: ref,
      overrides: { providerId: 'claude-code-tui', model: 'opus', effort: 'high', params: { fileIssues: true, maxEntries: 3 } },
    });
  });

  it('drops a payload that names neither a reference nor a known legacy type', () => {
    expect(normalizeQuotaBurnJob({ label: 'orphan' })).toBeNull();
    expect(normalizeQuotaBurnJob({ taskRef: { kind: 'nonsense', taskType: 'ux' } })).toBeNull();
  });

  it('mirrors the overrides bag onto the fields the shipped editor still writes', () => {
    const job = normalizeQuotaBurnJob({ taskRef: ref, overrides: { model: 'opus', effort: 'high', params: { a: 1 } } });
    expect(job).toMatchObject({ model: 'opus', effort: 'high', params: { a: 1 } });
  });

  it('lets a top-level clear win over a stale override rather than resurrecting it', () => {
    // The editor spreads the whole step and edits the top-level field, so a
    // truthiness test would put the old pin back every time the user cleared it.
    const job = normalizeQuotaBurnJob({
      taskRef: ref, model: null, providerId: null, effort: null, params: {},
      overrides: { model: 'opus', providerId: 'claude-code-tui', effort: 'high', params: { stale: true } },
    });
    expect(job.overrides).toEqual({ model: null, providerId: null, effort: null, params: {} });
    expect(job.model).toBeNull();
  });
});

describe('normalizeQuotaBurnJob — legacy compatibility', () => {
  it('loads an un-migrated legacy step but marks it for migration', () => {
    const job = normalizeQuotaBurnJob({
      id: 'legacy-1', label: 'UX audit', runOnce: true, jobType: 'agent-prompt',
      model: 'opus', providerId: 'claude-code-tui', effort: 'high',
      params: { appId: 'app-1', prompt: 'audit the UX' },
    });
    // Every stored setting survives — a migration that loses the user's prompt
    // or their one-shot state is worse than one that has not run yet.
    expect(job).toMatchObject({
      id: 'legacy-1', label: 'UX audit', runOnce: true, jobType: 'agent-prompt', taskRef: null,
      overrides: { model: 'opus', providerId: 'claude-code-tui', effort: 'high', params: { appId: 'app-1', prompt: 'audit the UX' } },
    });
    expect(job.unavailable.code).toBe(QUOTA_BURN_UNAVAILABLE.LEGACY_UNMIGRATED);
    expect(quotaBurnStepIsDispatchable(job)).toBe(false);
  });

  it('never rewrites a legacy step into a reference, and never duplicates it', () => {
    const family = normalizeQuotaBurnConfig({
      families: { grok: { jobs: [{ id: 'legacy-1', jobType: 'agent-prompt', params: { appId: 'app-1', prompt: 'x' } }] } },
    }).families.grok;
    expect(family.jobs).toHaveLength(1);
    expect(family.jobs[0].taskRef).toBeNull();
    // Re-normalizing is idempotent: a repeated load cannot mint a second step.
    expect(normalizeQuotaBurnConfig({ families: { grok: family } }).families.grok).toEqual(family);
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
