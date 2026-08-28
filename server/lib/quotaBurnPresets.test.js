import { describe, expect, it } from 'vitest';
import {
  AUDIT_CONTRACT_HEADING,
  QUOTA_BURN_PROMPT_PRESETS,
  findQuotaBurnPreset,
  upgradeStoredAuditPrompt,
} from './quotaBurnPresets.js';
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

  it('requires both dispatch axes on every issue an audit files', () => {
    // The optional form of this guidance ("omit an axis rather than guessing")
    // is right for producers filing from thin evidence and wrong here: an audit
    // that traced the failure and chose the fix already knows how the work
    // should run, and omitting the axes strands the issue with no routing —
    // which is what shipped a whole backlog of unlabeled audit issues.
    for (const preset of QUOTA_BURN_PROMPT_PRESETS) {
      const prompt = preset.params.prompt;
      expect(prompt).toContain('REQUIRED on every issue you file');
      expect(prompt).toContain('model:light|medium|heavy');
      expect(prompt).toContain('effort:low|medium|high|xhigh|max');
      expect(prompt).not.toContain('Omit an axis rather than guessing');
      expect(prompt).toContain('repeated `--label`');
      expect(prompt).toContain('gh label create');
      expect(prompt).toContain('Do not relabel an existing issue');
      expect(prompt).toContain('good first issue');
      expect(prompt).toContain('help wanted');
      expect(prompt).toContain('Issue-quality gate');
      expect(prompt).toContain('current refactors that pay off now are valid');
    }
  });

  it('spends the window on research and demands a traced trigger and a decided fix', () => {
    for (const preset of QUOTA_BURN_PROMPT_PRESETS) {
      const prompt = preset.params.prompt;
      expect(prompt).toContain('Most of this window belongs to RESEARCH');
      expect(prompt).toContain('Research each candidate before you judge it');
      expect(prompt).toContain('Prove the trigger');
      expect(prompt).toContain('Decide the fix before you file it');
      expect(prompt).toContain('the tests to add or change');
    }
  });

  it('keeps real headroom under the param length bound', () => {
    // Not a duplicate of the truncation assertion above: that one passed at
    // 7999/8000, one character from silently slicing the redaction and
    // "change no code" rules off the END of every stored preset job. A bound a
    // sentence away from binding is a bound that will bind on the next edit.
    for (const preset of QUOTA_BURN_PROMPT_PRESETS) {
      expect(preset.params.prompt.length).toBeLessThanOrEqual(QUOTA_BURN_BOUNDS.paramLength.max * 0.8);
    }
  });
});

describe('upgradeStoredAuditPrompt', () => {
  const preset = QUOTA_BURN_PROMPT_PRESETS[0];
  const current = preset.params.prompt;
  const mission = current.slice(0, current.indexOf(AUDIT_CONTRACT_HEADING));

  it('refreshes a stale shipped contract while keeping the mission', () => {
    const stale = `${mission}${AUDIT_CONTRACT_HEADING}
1. **Pick a bounded slice and say so first.** Audit one area.
2. \`gh issue create --title "..."\`. Suggested labels: \`ux\`, \`plan\`.
3. **Change no code.**
4. **Report at the end**: each issue number.
`;
    expect(upgradeStoredAuditPrompt(stale)).toBe(current);
  });

  it('returns null for an already-current prompt, so callers count real upgrades', () => {
    expect(upgradeStoredAuditPrompt(current)).toBeNull();
  });

  it('returns null when the user replaced the How-to-run section', () => {
    expect(upgradeStoredAuditPrompt(`${mission}${AUDIT_CONTRACT_HEADING}\n\nJust report findings in chat.\n`)).toBeNull();
  });

  it('returns null when the user ADDED a step to an otherwise-shipped contract', () => {
    // The anchor gate alone passes here — every shipped sentence is still
    // present — so without the heading subset check the refresh would replace
    // the whole contract and silently delete the user's own step.
    const withExtraStep = current.replace(
      '9. **Redact before you publish.**',
      '9. **Always check the billing module first.** It is our riskiest area.\n10. **Redact before you publish.**'
    );
    expect(withExtraStep).not.toBe(current);
    expect(upgradeStoredAuditPrompt(withExtraStep)).toBeNull();
  });

  it('still upgrades a stale contract whose headings are all ones we shipped', () => {
    // Guards the subset check from the opposite failure: a retired step title
    // dropped from the known set turns into a silent refusal to upgrade every
    // job still carrying it, which is the bug migration 294 already had.
    const retiredTitles = `${mission}${AUDIT_CONTRACT_HEADING}
1. **Pick a bounded slice and say so first.** Audit one area.
2. **Read the actual code.** Cite file:line.
3. \`gh issue create --title "..."\` with **Problem**, **Impact**, **Fix**, and **Acceptance criteria**.
4. **Cap yourself at 5 issues.**
5. **Change no code.**
6. **Report at the end**: each issue number.
`;
    expect(upgradeStoredAuditPrompt(retiredTitles)).toBe(current);
  });

  it('returns null for a prompt that is not a preset render at all', () => {
    expect(upgradeStoredAuditPrompt('Refactor the billing module and open a PR.')).toBeNull();
    expect(upgradeStoredAuditPrompt(undefined)).toBeNull();
    expect(upgradeStoredAuditPrompt(null)).toBeNull();
  });
});

describe('findQuotaBurnPreset', () => {
  it('finds a known preset and returns null for anything else', () => {
    expect(findQuotaBurnPreset(QUOTA_BURN_PROMPT_PRESETS[0].id)).toBe(QUOTA_BURN_PROMPT_PRESETS[0]);
    expect(findQuotaBurnPreset('nope')).toBeNull();
    expect(findQuotaBurnPreset(undefined)).toBeNull();
  });
});
