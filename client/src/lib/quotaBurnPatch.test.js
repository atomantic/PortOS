import { describe, it, expect } from 'vitest';
import { applyQuotaBurnPreset, jobFromPreset, mergeQuotaBurnPatch } from './quotaBurnPatch';

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
});

describe('jobFromPreset', () => {
  it('mints a runnable job with the caller\'s id and app', () => {
    expect(jobFromPreset(preset, { id: 'job-x', appId: 'a1' })).toEqual({
      id: 'job-x', enabled: true, label: 'UX issues', jobType: 'agent-prompt', model: null, providerId: null,
      params: { ...preset.params, appId: 'a1' },
    });
  });

  it('omits appId entirely when none is known, rather than storing an empty one', () => {
    // `appId: ''` would read as a configured-but-blank app; absent is the honest
    // shape, and the row's own status line then says the app is unset.
    expect(jobFromPreset(preset, { id: 'job-x' }).params).not.toHaveProperty('appId');
  });
});
