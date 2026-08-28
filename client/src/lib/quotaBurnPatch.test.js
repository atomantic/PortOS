import { describe, it, expect } from 'vitest';
import {
  applyQuotaBurnPreset,
  dispatchCapInput,
  getAvailablePresetsForJobs,
  isPresetInJobs,
  isUnlimitedDispatchCap,
  jobFromPreset,
  mergeQuotaBurnPatch,
  quotaBurnJobIsSpent,
  UNLIMITED_DISPATCHES,
} from './quotaBurnPatch';

describe('quotaBurnJobIsSpent', () => {
  const ranAt = '2026-08-01T00:00:00.000Z';

  it('gates on the step\'s own run-once flag, not on the completion alone', () => {
    // A completion is kept even after the checkbox is cleared, so `ranAt` alone
    // would keep a step the user switched back to repeating looking retired.
    expect(quotaBurnJobIsSpent({ runOnce: true }, ranAt)).toBe(true);
    expect(quotaBurnJobIsSpent({ runOnce: false }, ranAt)).toBe(false);
    expect(quotaBurnJobIsSpent({ runOnce: true }, null)).toBe(false);
  });

  it('reads a missing job or flag as unspent', () => {
    expect(quotaBurnJobIsSpent(undefined, ranAt)).toBe(false);
    expect(quotaBurnJobIsSpent({}, ranAt)).toBe(false);
  });
});

describe('mergeQuotaBurnPatch', () => {
  it('merges top-level keys and leaves families untouched', () => {
    expect(mergeQuotaBurnPatch({ enabled: false, checkIntervalMinutes: 30 }, { enabled: true }))
      .toEqual({ enabled: true, checkIntervalMinutes: 30 });
  });

  it('merges per-family keys without dropping the rest of the plan', () => {
    const base = { families: { grok: { enabled: true, reservePercent: 10 }, codex: { enabled: false } } };
    expect(mergeQuotaBurnPatch(base, { families: { grok: { reservePercent: 40 } } })).toEqual({
      families: { grok: { enabled: true, reservePercent: 40 }, codex: { enabled: false } },
    });
  });

  it('REPLACES a family\'s jobs array', () => {
    // Ordered list: a positional merge would make reordering and deletion
    // inexpressible — the same rule the server's save applies.
    const base = { families: { grok: { jobs: [{ id: 'a' }, { id: 'b' }] } } };
    expect(mergeQuotaBurnPatch(base, { families: { grok: { jobs: [{ id: 'b' }] } } }))
      .toEqual({ families: { grok: { jobs: [{ id: 'b' }] } } });
  });

  it('accumulates successive edits into one patch body', () => {
    // The page folds debounced edits this way, so the trailing PUT carries every
    // change rather than only the last field touched.
    const first = mergeQuotaBurnPatch(null, { families: { grok: { reservePercent: 40 } } });
    const second = mergeQuotaBurnPatch(first, { enabled: true });
    const third = mergeQuotaBurnPatch(second, { families: { grok: { priority: 2 }, codex: { enabled: true } } });
    expect(third).toEqual({
      enabled: true,
      families: { grok: { reservePercent: 40, priority: 2 }, codex: { enabled: true } },
    });
  });

  it('omits families entirely for a top-level-only edit', () => {
    expect(mergeQuotaBurnPatch(null, { enabled: true })).toEqual({ enabled: true });
  });
});

const preset = {
  id: 'ux-audit',
  label: 'UX issues',
  summary: 'Audit the UI.',
  jobType: 'agent-prompt',
  params: { prompt: 'Audit the UI and file issues.', useWorktree: true, openPR: false, simplify: false },
};

describe('applyQuotaBurnPreset', () => {
  const job = { id: 'j1', enabled: true, label: '', jobType: 'agent-prompt', model: null, providerId: null, params: {} };

  it('copies the preset prompt and its recommended flags in', () => {
    expect(applyQuotaBurnPreset(job, preset).params).toEqual(preset.params);
  });

  it('keeps the app the step already targets', () => {
    // The preset cannot know which managed app this plan points at; wiping it
    // would leave a step that silently cannot run.
    const targeted = { ...job, params: { appId: 'a1', prompt: '' } };
    expect(applyQuotaBurnPreset(targeted, preset).params.appId).toBe('a1');
  });

  it('names an unnamed step but never renames one the user named', () => {
    expect(applyQuotaBurnPreset(job, preset).label).toBe('UX issues');
    expect(applyQuotaBurnPreset({ ...job, label: 'Nightly sweep' }, preset).label).toBe('Nightly sweep');
  });

  it('switches the step to the job type the preset needs', () => {
    expect(applyQuotaBurnPreset({ ...job, jobType: 'universe-bible-images' }, preset).jobType).toBe('agent-prompt');
  });

  it('returns the job untouched when there is no preset', () => {
    expect(applyQuotaBurnPreset(job, null)).toBe(job);
  });

  it('preserves the step\'s run-once choice', () => {
    // The presets are standing audits, but the user may have marked this step
    // one-shot for their own reasons — re-picking a preset must not quietly put
    // it back into a rotation that spends quota on every lap.
    expect(applyQuotaBurnPreset({ ...job, runOnce: true }, preset).runOnce).toBe(true);
  });
});

describe('jobFromPreset', () => {
  it('mints a runnable job with the caller\'s id and app', () => {
    expect(jobFromPreset(preset, { id: 'job-x', appId: 'a1' })).toEqual({
      id: 'job-x', enabled: true, label: 'UX issues', jobType: 'agent-prompt', model: null, providerId: null, effort: null,
      // Standing work: an audit dimension is worth re-running as the code moves.
      runOnce: false,
      params: { ...preset.params, appId: 'a1' },
    });
  });

  it('omits appId entirely when none is known, rather than storing an empty one', () => {
    // `appId: ''` would read as a configured-but-blank app; absent is the honest
    // shape, and the row's own status line then says the app is unset.
    expect(jobFromPreset(preset, { id: 'job-x' }).params).not.toHaveProperty('appId');
  });
});

describe('dispatch cap helpers', () => {
  it('reads any negative cap as unlimited and a real cap as bounded', () => {
    expect(isUnlimitedDispatchCap(UNLIMITED_DISPATCHES)).toBe(true);
    expect(isUnlimitedDispatchCap(1)).toBe(false);
    expect(isUnlimitedDispatchCap(50)).toBe(false);
  });

  it('collapses anything below the real minimum to the sentinel the PUT accepts', () => {
    // 0 is what a spinner step down from 1 produces, and the schema rejects it —
    // sending it would 400 and take every co-pending edit with it.
    expect(dispatchCapInput(0)).toBe(UNLIMITED_DISPATCHES);
    expect(dispatchCapInput(-4)).toBe(UNLIMITED_DISPATCHES);
    expect(dispatchCapInput(1)).toBe(1);
    expect(dispatchCapInput(50)).toBe(50);
  });
});

describe('isPresetInJobs and getAvailablePresetsForJobs', () => {
  const p1 = { id: 'ux-audit', label: 'UX issues', jobType: 'agent-prompt', params: { prompt: 'Audit UX.' } };
  const p2 = { id: 'a11y-audit', label: 'A11y issues', jobType: 'agent-prompt', params: { prompt: 'Audit A11y.' } };
  const p3 = { id: 'perf-audit', label: 'Perf issues', jobType: 'agent-prompt', params: { prompt: 'Audit Perf.' } };

  it('matches a preset in jobs by prompt text', () => {
    const jobs = [{ id: 'j1', params: { prompt: 'Audit UX.' } }];
    expect(isPresetInJobs(p1, jobs)).toBe(true);
    expect(isPresetInJobs(p2, jobs)).toBe(false);
  });

  it('filters presets to only those not already in jobs', () => {
    const jobs = [{ id: 'j1', params: { prompt: 'Audit UX.' } }];
    const available = getAvailablePresetsForJobs([p1, p2, p3], jobs);
    expect(available).toEqual([p2, p3]);
  });

  it('returns all presets when jobs list is empty', () => {
    expect(getAvailablePresetsForJobs([p1, p2], [])).toEqual([p1, p2]);
  });

  it('returns empty list when all presets are in jobs', () => {
    const jobs = [
      { id: 'j1', params: { prompt: 'Audit UX.' } },
      { id: 'j2', params: { prompt: 'Audit A11y.' } },
    ];
    expect(getAvailablePresetsForJobs([p1, p2], jobs)).toEqual([]);
  });

  it('handles null/undefined gracefully', () => {
    expect(isPresetInJobs(null, [])).toBe(false);
    expect(getAvailablePresetsForJobs(null, null)).toEqual([]);
  });
});

// @vitest-environment node


