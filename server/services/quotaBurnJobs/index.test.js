import { describe, expect, it } from 'vitest';
import { JOB_MODULES, countJobPending, runBurnJob } from './index.js';
import { QUOTA_BURN_JOB_CATALOG, QUOTA_BURN_JOB_TYPES } from '../../lib/quotaBurnConfig.js';

describe('burn job registry', () => {
  it('registers a module for every declared job type, and nothing else', () => {
    // A job type is declared in two places — the alphabet + catalog in
    // lib/quotaBurnConfig.js, and JOB_MODULES here. Without this guard, an
    // enum/catalog entry with no module gives a job type the config page happily
    // offers and that fails at dispatch with `unknown job type`, surfaced only in
    // the run log AFTER a burnable window was already selected and consumed.
    expect(Object.keys(JOB_MODULES).sort()).toEqual([...QUOTA_BURN_JOB_TYPES].sort());
    expect(QUOTA_BURN_JOB_CATALOG.map((entry) => entry.id).sort()).toEqual([...QUOTA_BURN_JOB_TYPES].sort());
  });

  it('every module exports the two hooks the runner calls', async () => {
    for (const load of Object.values(JOB_MODULES)) {
      const mod = await load();
      expect(typeof mod.countPending).toBe('function');
      expect(typeof mod.run).toBe('function');
    }
  });

  it('fails closed on an unknown job type rather than throwing', async () => {
    await expect(countJobPending({ job: { jobType: 'rm-rf' } }))
      .resolves.toEqual({ count: 0, detail: 'unknown job type: rm-rf' });
    await expect(runBurnJob({ job: { jobType: 'rm-rf' } }))
      .resolves.toEqual({ dispatched: false, reason: 'unknown job type: rm-rf' });
  });

  it('does not resolve an inherited Object.prototype key as a module', async () => {
    // `Object.hasOwn`, not a truthiness check — 'constructor' would otherwise
    // resolve to a function and be invoked as a lazy import.
    await expect(countJobPending({ job: { jobType: 'constructor' } }))
      .resolves.toMatchObject({ count: 0 });
  });
});
