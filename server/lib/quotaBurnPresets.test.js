import { describe, expect, it } from 'vitest';
import { QUOTA_BURN_PROMPT_PRESETS, findQuotaBurnPreset } from './quotaBurnPresets.js';
import { QUOTA_BURN_BOUNDS, QUOTA_BURN_JOB_CATALOG, QUOTA_BURN_JOB_TYPES, normalizeQuotaBurnJob } from './quotaBurnConfig.js';
import { quotaBurnConfigUpdateSchema } from './quotaBurnValidation.js';

const presetJob = (preset) => ({
  id: 'j1', enabled: true, label: preset.label, jobType: preset.jobType, model: null, providerId: null,
  params: { appId: 'app-1', ...preset.params },
});

describe('QUOTA_BURN_PROMPT_PRESETS', () => {
  it('exposes unique ids with a label, a summary, and a real prompt', () => {
    expect(QUOTA_BURN_PROMPT_PRESETS.length).toBeGreaterThan(0);
    const ids = QUOTA_BURN_PROMPT_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of QUOTA_BURN_PROMPT_PRESETS) {
      expect(preset.label.trim()).not.toBe('');
      expect(preset.summary.trim()).not.toBe('');
      expect(preset.params.prompt.trim().length).toBeGreaterThan(200);
    }
  });

  it('only seeds job types the catalog actually offers, with params that type declares', () => {
    for (const preset of QUOTA_BURN_PROMPT_PRESETS) {
      expect(QUOTA_BURN_JOB_TYPES).toContain(preset.jobType);
      const spec = QUOTA_BURN_JOB_CATALOG.find((type) => type.id === preset.jobType);
      const known = new Set(spec.params.map((descriptor) => descriptor.key));
      // A param the job type does not read is dead weight the runner ignores —
      // the preset would look configured and behave as if it were not.
      expect(Object.keys(preset.params).filter((key) => !known.has(key))).toEqual([]);
    }
  });

  it('survives job normalization with the prompt intact', () => {
    // The normalizer slices strings at `paramLength.max`. A preset that grew past
    // it would be stored truncated — mid-sentence, with nothing on screen saying
    // so — which is exactly the failure this bound makes silent.
    for (const preset of QUOTA_BURN_PROMPT_PRESETS) {
      expect(preset.params.prompt.length).toBeLessThanOrEqual(QUOTA_BURN_BOUNDS.paramLength.max);
      const normalized = normalizeQuotaBurnJob(presetJob(preset));
      expect(normalized).not.toBeNull();
      expect(normalized.params.prompt).toBe(preset.params.prompt);
    }
  });

  it('passes the config PUT schema, so a preset job can actually be saved', () => {
    const body = { families: { claude: { jobs: QUOTA_BURN_PROMPT_PRESETS.map(presetJob) } } };
    expect(() => quotaBurnConfigUpdateSchema.parse(body)).not.toThrow();
  });

  it('configures audit presets to read the app checkout in place and land nothing', () => {
    // These prompts read code and file issues — they write no file, so they need
    // no branch and no isolation. Asserted together because the combination is
    // the safety property, not any one flag: `useWorktree: true` +
    // `openPR: false` is the AUTO-MERGE posture (the agent's branch is merged
    // onto the app's default branch on success, unreviewed), so "isolating an
    // audit for safety" would actually hand it a way to land code.
    // `noCodeOutput` is what strips every commit/push/PR instruction from the
    // prompt — including the one that would otherwise tell a no-worktree task to
    // `/do:push` to the branch it is standing on.
    for (const preset of QUOTA_BURN_PROMPT_PRESETS) {
      expect(preset.params.useWorktree).toBe(false);
      expect(preset.params.noCodeOutput).toBe(true);
      expect(preset.params.openPR).toBe(false);
      expect(preset.params.simplify).toBe(false);
      expect(preset.params.discardWorktree).toBeUndefined();
    }
  });

  it('tells the agent to keep secrets and scratch files out of what it publishes', () => {
    for (const preset of QUOTA_BURN_PROMPT_PRESETS) {
      const prompt = preset.params.prompt;
      // An issue is world-readable the moment it is filed, and "quote the
      // evidence" plus "find committed secrets" is exactly how one gets
      // republished to a public repo by an unattended agent.
      expect(prompt).toMatch(/Redact before you publish/);
      // An untracked scratch file makes the run's worktree undeletable, so the
      // burn strands one full checkout per window.
      expect(prompt).toMatch(/mktemp/);
      // It runs in the user's live checkout, so "leave the tree as you found it"
      // is about their working copy, not a throwaway one.
      expect(prompt).toMatch(/live checkout/);
      expect(prompt).toMatch(/same branch it started on/);
    }
  });

  it('tells the agent to file issues, cap its output, and not change code', () => {
    for (const preset of QUOTA_BURN_PROMPT_PRESETS) {
      const prompt = preset.params.prompt;
      expect(prompt).toMatch(/gh issue create/);
      expect(prompt).toMatch(/gh issue list/);
      expect(prompt.toLowerCase()).toMatch(/no commits, no branches, no pull requests/);
      expect(prompt).toMatch(/Cap yourself at 5 issues/);
    }
  });
});

describe('findQuotaBurnPreset', () => {
  it('finds a known preset and returns null for anything else', () => {
    expect(findQuotaBurnPreset(QUOTA_BURN_PROMPT_PRESETS[0].id)).toBe(QUOTA_BURN_PROMPT_PRESETS[0]);
    expect(findQuotaBurnPreset('nope')).toBeNull();
    expect(findQuotaBurnPreset(undefined)).toBeNull();
  });
});
