import { describe, expect, it } from 'vitest';
import {
  DISPATCH_MODEL_TIERS,
  DISPATCH_EFFORT_LEVELS,
  DISPATCH_LABEL_COLORS,
  ISSUE_QUALITY_GUIDANCE,
  DISPATCH_HINT_GUIDANCE,
  MANDATORY_DISPATCH_HINT_GUIDANCE,
  JIRA_DISPATCH_HINT_GUIDANCE,
  PORTOS_AREA_LABELS,
  PORTOS_AREA_LABEL_GUIDANCE,
  REPO_STUDY_LABEL_CONTRACT,
  GOOD_FIRST_ISSUE_LABEL,
  HELP_WANTED_LABEL,
  JIRA_GOOD_FIRST_ISSUE_LABEL,
  JIRA_HELP_WANTED_LABEL,
  isDispatchModel,
  isDispatchEffort,
  normalizeDispatchModel,
  normalizeDispatchEffort,
  forgeDispatchLabel,
  jiraDispatchLabel,
  forgeDispatchLabels,
  jiraDispatchLabels,
  forgeContributorLabels,
  jiraContributorLabels,
  forgeIssueLabels,
  jiraIssueLabels,
  dispatchLabelSpec,
  allDispatchLabelSpecs,
  formatLabelCreateCommand,
  IN_PROGRESS_LABEL,
  formatRepeatedLabelFlags,
  CONTRIBUTOR_LABELS,
  JIRA_CONTRIBUTOR_LABELS,
  formatContributorLabelReleaseCommands,
  formatVolunteerClaimCommands,
  volunteerClaimLabels,
  PLANNER_LABEL_COLOR,
  normalizePlannerId,
  resolvePlannerId,
  forgePlannerLabel,
  jiraPlannerLabel,
  isPlannerLabel,
  plannerLabelSpec,
  formatPlannerLabelGuidance,
  OPTIONAL_ISSUE_LABEL_FLAG_SLOTS,
  formatOptionalIssueLabelFlags,
} from './dispatchLabels.js';

describe('dispatch label vocabulary', () => {
  it('is the exact slashdo model/effort set', () => {
    expect(DISPATCH_MODEL_TIERS).toEqual(['light', 'medium', 'heavy']);
    expect(DISPATCH_EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('prescribes slashdo colors for every forge label', () => {
    expect(DISPATCH_LABEL_COLORS).toEqual({
      'model:light': 'D4C5F9',
      'model:medium': 'A371F7',
      'model:heavy': '6F42C1',
      'effort:low': 'BFE5E5',
      'effort:medium': '76C7C7',
      'effort:high': '1D7874',
      'effort:xhigh': '0E4F4C',
      'effort:max': '05403D',
    });
  });

  it('accepts only the known enum values', () => {
    expect(isDispatchModel('light')).toBe(true);
    expect(isDispatchModel('heavy')).toBe(true);
    expect(isDispatchModel('none')).toBe(false);
    expect(isDispatchModel('model:light')).toBe(false);
    expect(isDispatchModel('')).toBe(false);
    expect(isDispatchModel(null)).toBe(false);

    expect(isDispatchEffort('xhigh')).toBe(true);
    expect(isDispatchEffort('max')).toBe(true);
    expect(isDispatchEffort('none')).toBe(false);
    expect(isDispatchEffort('effort:low')).toBe(false);
  });

  it('normalizes unknown/absent values to null instead of inventing a default', () => {
    expect(normalizeDispatchModel('medium')).toBe('medium');
    expect(normalizeDispatchModel('Medium')).toBe(null);
    expect(normalizeDispatchModel(undefined)).toBe(null);
    expect(normalizeDispatchEffort('low')).toBe('low');
    expect(normalizeDispatchEffort('')).toBe(null);
  });
});

describe('forge vs Jira label formatting', () => {
  it('formats independent axes and omits an unjustified one', () => {
    expect(forgeDispatchLabel('model', 'light')).toBe('model:light');
    expect(forgeDispatchLabel('effort', 'max')).toBe('effort:max');
    expect(forgeDispatchLabel('model', 'nope')).toBe(null);
    expect(forgeDispatchLabel('complexity', 'trivial')).toBe(null);

    expect(jiraDispatchLabel('model', 'heavy')).toBe('model-heavy');
    expect(jiraDispatchLabel('effort', 'xhigh')).toBe('effort-xhigh');
    expect(jiraDispatchLabel('effort', null)).toBe(null);
    expect(jiraDispatchLabel('model', 'heavy')).not.toContain(':');
  });

  it('does not derive one axis from the other or invent medium', () => {
    expect(forgeDispatchLabels({})).toEqual([]);
    expect(forgeDispatchLabels({ model: 'light' })).toEqual(['model:light']);
    expect(forgeDispatchLabels({ effort: 'high' })).toEqual(['effort:high']);
    expect(forgeDispatchLabels({ model: 'heavy', effort: 'low' })).toEqual(['model:heavy', 'effort:low']);
    expect(forgeDispatchLabels({ model: 'epic', effort: 'yes' })).toEqual([]);
    expect(jiraDispatchLabels({ model: 'light', effort: 'max' })).toEqual(['model-light', 'effort-max']);
  });
});

describe('label specs and CLI formatting', () => {
  it('returns a spec only for known dispatch labels', () => {
    expect(dispatchLabelSpec('model:light')).toEqual({
      name: 'model:light',
      color: 'D4C5F9',
      description: 'Dispatch capability: cheapest capable coding model',
    });
    expect(dispatchLabelSpec('plan')).toBe(null);
    expect(dispatchLabelSpec('model-light')).toBe(null);
  });

  it('resolves the in-progress workflow marker so it can be lazily created', () => {
    // The claim marker is state every claim/reconcile flow reads, so it must be
    // creatable on a repo (or fork) that has never defined it.
    expect(dispatchLabelSpec(IN_PROGRESS_LABEL)).toEqual({
      name: 'in-progress',
      color: 'FFA500',
      description: 'Claimed and being worked',
    });
    expect(formatLabelCreateCommand(IN_PROGRESS_LABEL)).toContain('gh label create in-progress');
  });

  it('lists all eight specs without dropping an axis', () => {
    const specs = allDispatchLabelSpecs();
    expect(specs).toHaveLength(8);
    expect(specs.map((s) => s.name)).toEqual(Object.keys(DISPATCH_LABEL_COLORS));
    expect(specs.every((s) => /^[0-9A-F]{6}$/.test(s.color))).toBe(true);
  });

  it('formats idempotent gh / glab create commands with slashdo colors', () => {
    expect(formatLabelCreateCommand('model:light')).toBe(
      "gh label create model:light --color D4C5F9 --description 'Dispatch capability: cheapest capable coding model' 2>/dev/null || true",
    );
    expect(formatLabelCreateCommand('effort:max', { cli: 'glab' })).toBe(
      "glab label create --name effort:max --color '#05403D' --description 'Dispatch reasoning effort: maximum' 2>/dev/null || true",
    );
    expect(formatLabelCreateCommand('plan')).toBe(null);
    expect(formatLabelCreateCommand(GOOD_FIRST_ISSUE_LABEL)).toBe(
      "gh label create 'good first issue' --color 7057FF --description 'Self-contained work a new contributor can ship without deep repo context' 2>/dev/null || true",
    );
  });

  it('applies contributor labels only on an explicit true, never from model:light', () => {
    expect(forgeContributorLabels({})).toEqual([]);
    expect(forgeContributorLabels({ goodFirstIssue: true })).toEqual([GOOD_FIRST_ISSUE_LABEL]);
    expect(forgeContributorLabels({ helpWanted: true })).toEqual([HELP_WANTED_LABEL]);
    expect(forgeContributorLabels({ goodFirstIssue: 'yes', helpWanted: 1 })).toEqual([]);
    expect(jiraContributorLabels({ goodFirstIssue: true, helpWanted: true }))
      .toEqual([JIRA_GOOD_FIRST_ISSUE_LABEL, JIRA_HELP_WANTED_LABEL]);
    expect(forgeIssueLabels({ model: 'light', goodFirstIssue: true }))
      .toEqual(['model:light', GOOD_FIRST_ISSUE_LABEL]);
    expect(forgeIssueLabels({ model: 'light' })).toEqual(['model:light']);
    expect(jiraIssueLabels({ effort: 'low', helpWanted: true }))
      .toEqual(['effort-low', JIRA_HELP_WANTED_LABEL]);
  });

  // A claim holds the issue, so the invitation to a human contributor is stale.
  // The commands must stay SEPARATE and best-effort: a forge fails the whole edit
  // when any named label is absent, so one combined call on an issue carrying
  // only `help wanted` would remove neither — and an issue carrying neither is
  // the common case, which must never abort a claim.
  it('releases both contributor labels one best-effort command at a time', () => {
    expect(CONTRIBUTOR_LABELS).toEqual([GOOD_FIRST_ISSUE_LABEL, HELP_WANTED_LABEL]);
    expect(JIRA_CONTRIBUTOR_LABELS).toEqual([JIRA_GOOD_FIRST_ISSUE_LABEL, JIRA_HELP_WANTED_LABEL]);
    expect(formatContributorLabelReleaseCommands('"${NUM}"')).toEqual([
      `gh issue edit "\${NUM}" --remove-label 'good first issue' 2>/dev/null`,
      `gh issue edit "\${NUM}" --remove-label 'help wanted' 2>/dev/null`,
    ]);
    expect(formatContributorLabelReleaseCommands('"${NUM}"', { cli: 'glab' })).toEqual([
      `glab issue update "\${NUM}" --unlabel 'good first issue' 2>/dev/null`,
      `glab issue update "\${NUM}" --unlabel 'help wanted' 2>/dev/null`,
    ]);
  });

  // ONE policy for a volunteer claim, shared by the deterministic issue-watcher
  // (which reads the labels) and the claim prompt (which renders the commands).
  // Before this, the watcher stamped `in-progress` and kept the invitations up
  // while the prompt did the exact opposite, so whichever path resolved a claim
  // comment first decided the forge state (#6112).
  it('states one volunteer-claim policy: in-progress on, invitations off', () => {
    expect(volunteerClaimLabels()).toEqual({
      add: [IN_PROGRESS_LABEL],
      remove: [GOOD_FIRST_ISSUE_LABEL, HELP_WANTED_LABEL],
    });
  });

  // A fresh mutation of the frozen CONTRIBUTOR_LABELS would let a caller that
  // splices its own list corrupt every later caller's policy.
  it('hands back a mutable copy, never the shared contributor list', () => {
    const first = volunteerClaimLabels();
    first.remove.push('bogus');
    first.add.push('bogus');
    expect(volunteerClaimLabels()).toEqual({
      add: [IN_PROGRESS_LABEL],
      remove: [GOOD_FIRST_ISSUE_LABEL, HELP_WANTED_LABEL],
    });
    expect(CONTRIBUTOR_LABELS).toEqual([GOOD_FIRST_ISSUE_LABEL, HELP_WANTED_LABEL]);
  });

  // The lazy create must precede the add — `--add-label` fails the whole call on
  // a repo (a fresh fork) that has never defined `in-progress`, which would drop
  // the marker silently. Add before release so the issue is never momentarily
  // both un-advertised and unclaimed.
  it('renders the volunteer-claim handoff as create → add → release', () => {
    expect(formatVolunteerClaimCommands('"${CANDIDATE}"')).toEqual([
      `gh label create in-progress --color FFA500 --description 'Claimed and being worked' 2>/dev/null || true`,
      `gh issue edit "\${CANDIDATE}" --add-label in-progress 2>/dev/null`,
      `gh issue edit "\${CANDIDATE}" --remove-label 'good first issue' 2>/dev/null`,
      `gh issue edit "\${CANDIDATE}" --remove-label 'help wanted' 2>/dev/null`,
    ]);
    expect(formatVolunteerClaimCommands('"${CANDIDATE}"', { cli: 'glab' })).toEqual([
      `glab label create --name in-progress --color '#FFA500' --description 'Claimed and being worked' 2>/dev/null || true`,
      `glab issue update "\${CANDIDATE}" --label in-progress 2>/dev/null`,
      `glab issue update "\${CANDIDATE}" --unlabel 'good first issue' 2>/dev/null`,
      `glab issue update "\${CANDIDATE}" --unlabel 'help wanted' 2>/dev/null`,
    ]);
  });

  it('emits repeated --label flags, never a comma list', () => {
    expect(formatRepeatedLabelFlags(['plan', 'model:light', 'effort:max']))
      .toBe('--label plan --label model:light --label effort:max');
    expect(formatRepeatedLabelFlags(['ux', '', null, 'plan'])).toBe('--label ux --label plan');
    expect(formatRepeatedLabelFlags([])).toBe('');
    expect(formatRepeatedLabelFlags([GOOD_FIRST_ISSUE_LABEL, HELP_WANTED_LABEL]))
      .toBe("--label 'good first issue' --label 'help wanted'");
  });
});

describe('shared guidance', () => {
  it('names both vocabularies and the omit-rather-than-guess rule', () => {
    expect(ISSUE_QUALITY_GUIDANCE).toContain('current, evidenced work');
    expect(ISSUE_QUALITY_GUIDANCE).toContain('future-only/speculative refactors');
    expect(ISSUE_QUALITY_GUIDANCE).toContain('current refactors that pay off now are valid');
    expect(DISPATCH_HINT_GUIDANCE).toContain('model:light|medium|heavy');
    expect(DISPATCH_HINT_GUIDANCE).toContain('effort:low|medium|high|xhigh|max');
    expect(DISPATCH_HINT_GUIDANCE).toContain('Omit an axis rather than guessing');
    expect(DISPATCH_HINT_GUIDANCE).toContain('Do NOT stamp `medium` on both');
    expect(DISPATCH_HINT_GUIDANCE).toContain('repeated `--label`');
    expect(DISPATCH_HINT_GUIDANCE).toContain('Never relabel a deduplicated existing issue');
    expect(DISPATCH_HINT_GUIDANCE).toContain('good first issue');
    expect(DISPATCH_HINT_GUIDANCE).toContain('help wanted');
    expect(DISPATCH_HINT_GUIDANCE).toContain('NOT a good first issue');
    expect(DISPATCH_HINT_GUIDANCE).toContain('glab label create');
    expect(DISPATCH_HINT_GUIDANCE).toContain('Issue-quality gate');
    expect(JIRA_DISPATCH_HINT_GUIDANCE).toContain('model-light|model-medium|model-heavy');
    expect(JIRA_DISPATCH_HINT_GUIDANCE).toContain('effort-low|effort-medium|effort-high|effort-xhigh|effort-max');
    expect(JIRA_DISPATCH_HINT_GUIDANCE).toContain('good-first-issue');
    expect(JIRA_DISPATCH_HINT_GUIDANCE).toContain('help-wanted');
    expect(JIRA_DISPATCH_HINT_GUIDANCE).toContain('Issue-quality gate');
    expect(JIRA_DISPATCH_HINT_GUIDANCE).not.toMatch(/model:light/);
  });

  it('keeps the mandatory variant on the same vocabulary but inverts the obligation', () => {
    // Same axes, same colors, same label-create idiom — the ONLY difference is
    // that both axes are required. A drifted second copy of the vocabulary is
    // exactly what this module exists to prevent.
    expect(MANDATORY_DISPATCH_HINT_GUIDANCE).toContain('model:light|medium|heavy');
    expect(MANDATORY_DISPATCH_HINT_GUIDANCE).toContain('effort:low|medium|high|xhigh|max');
    expect(MANDATORY_DISPATCH_HINT_GUIDANCE).toContain('good first issue');
    expect(MANDATORY_DISPATCH_HINT_GUIDANCE).toContain('help wanted');
    expect(MANDATORY_DISPATCH_HINT_GUIDANCE).toContain('Issue-quality gate');
    for (const name of Object.keys(DISPATCH_LABEL_COLORS)) {
      expect(MANDATORY_DISPATCH_HINT_GUIDANCE).toContain(`${name} ${DISPATCH_LABEL_COLORS[name]}`);
    }
    expect(MANDATORY_DISPATCH_HINT_GUIDANCE).toContain('REQUIRED on every issue you file');
    expect(MANDATORY_DISPATCH_HINT_GUIDANCE).not.toContain('Omit an axis rather than guessing');
    // Contributor labels stay optional in BOTH forms — requiring them would
    // advertise unattended-agent work to humans who never asked for it.
    expect(MANDATORY_DISPATCH_HINT_GUIDANCE).toContain('stay OPTIONAL');
  });

  it('keeps the PortOS area vocabulary and repo-study complete-label contract explicit', () => {
    expect(PORTOS_AREA_LABELS).toContain('area:cos-agents');
    expect(PORTOS_AREA_LABELS).toContain('area:media');
    expect(PORTOS_AREA_LABEL_GUIDANCE).toContain('area:*');
    expect(PORTOS_AREA_LABEL_GUIDANCE).toContain('gh label list --search area:');
    expect(REPO_STUDY_LABEL_CONTRACT.forgeFlags)
      .toBe('--label area:<area> --label model:<tier> --label effort:<level>');
    expect(REPO_STUDY_LABEL_CONTRACT.jiraFlags).toContain('model-<tier>');
    expect(REPO_STUDY_LABEL_CONTRACT.instructions).toContain('complete-label contract (mandatory)');
  });
});

// The planner axis records WHO wrote a plan. It is the only open-ended label
// vocabulary here, so its risks are different from the enumerated axes: a bad
// slug produces a junk label the forge happily creates, and a fallback that
// guesses would attribute a plan to a model that never saw it.
describe('planner attribution labels', () => {
  it('slugs a model id down to the identity a human recognizes', () => {
    expect(normalizePlannerId('claude-opus-5')).toBe('opus-5');
    expect(normalizePlannerId('  Claude-Sonnet-5  ')).toBe('sonnet-5');
    expect(normalizePlannerId('anthropic/claude-haiku-4-5-20251001')).toBe('haiku-4-5');
    expect(normalizePlannerId('gemini-3.7-flash')).toBe('gemini-3-7-flash');
    expect(normalizePlannerId('grok')).toBe('grok');
  });

  // `claude-code` is a PROVIDER id, not a model — stripping `claude-` off it
  // would file every plan as `planner:code`.
  it('strips the claude- prefix only when a model family follows', () => {
    expect(normalizePlannerId('claude-code')).toBe('claude-code');
    expect(normalizePlannerId('claude-opus-5')).toBe('opus-5');
  });

  it('returns null rather than an empty or unusable label', () => {
    expect(normalizePlannerId('')).toBe(null);
    expect(normalizePlannerId('   ')).toBe(null);
    expect(normalizePlannerId('///')).toBe(null);
    expect(normalizePlannerId(null)).toBe(null);
    expect(normalizePlannerId(42)).toBe(null);
    expect(forgePlannerLabel('!!!')).toBe(null);
    expect(jiraPlannerLabel(undefined)).toBe(null);
  });

  it('prefers the model that ran and falls back to the provider, never to a guess', () => {
    expect(resolvePlannerId({ providerId: 'claude-code', model: 'claude-opus-5' })).toBe('opus-5');
    expect(resolvePlannerId({ providerId: 'grok', model: '' })).toBe('grok');
    expect(resolvePlannerId({ providerId: 'grok' })).toBe('grok');
    expect(resolvePlannerId({})).toBe(null);
    expect(resolvePlannerId()).toBe(null);
  });

  it('uses the colon form on a forge and the hyphen form on Jira', () => {
    expect(forgePlannerLabel('claude-opus-5')).toBe('planner:opus-5');
    expect(jiraPlannerLabel('claude-opus-5')).toBe('planner-opus-5');
    expect(jiraPlannerLabel('grok')).not.toContain(':');
  });

  // Prefix-matched, so `formatLabelCreateCommand` / `ensureForgeLabels` can
  // create a planner label they have never seen before — the whole point of an
  // open-ended axis.
  it('resolves a spec by prefix so an unseen planner label still creates lazily', () => {
    expect(plannerLabelSpec('planner:opus-5')).toEqual({
      name: 'planner:opus-5',
      color: PLANNER_LABEL_COLOR,
      description: 'Plan authored by the opus-5 model',
    });
    expect(dispatchLabelSpec('planner:gemini-3-7-flash')?.color).toBe(PLANNER_LABEL_COLOR);
    expect(formatLabelCreateCommand('planner:opus-5')).toBe(
      "gh label create planner:opus-5 --color C2185B --description 'Plan authored by the opus-5 model' 2>/dev/null || true",
    );
    expect(isPlannerLabel('planner:opus-5')).toBe(true);
    expect(isPlannerLabel('planner:')).toBe(false);
    expect(plannerLabelSpec('planner:')).toBe(null);
    expect(plannerLabelSpec('plan')).toBe(null);
    expect(dispatchLabelSpec('planner-opus-5')).toBe(null);
  });

  // The axis must never crowd out the dispatch hints — it answers a different
  // question (author vs. how to run it).
  it('rides alongside the dispatch and contributor axes rather than replacing them', () => {
    expect(forgeIssueLabels({ model: 'heavy', effort: 'max', planner: 'claude-opus-5' }))
      .toEqual(['model:heavy', 'effort:max', 'planner:opus-5']);
    expect(forgeIssueLabels({ planner: 'grok' })).toEqual(['planner:grok']);
    expect(forgeIssueLabels({ model: 'light' })).toEqual(['model:light']);
    expect(jiraIssueLabels({ effort: 'low', planner: 'claude-opus-5' }))
      .toEqual(['effort-low', 'planner-opus-5']);
  });

  it('emits an unattributable run no guidance at all instead of a blank label', () => {
    expect(formatPlannerLabelGuidance(null)).toBe('');
    expect(formatPlannerLabelGuidance('   ')).toBe('');
    const guidance = formatPlannerLabelGuidance('claude-opus-5');
    expect(guidance).toContain('--label planner:opus-5');
    expect(guidance).toContain('gh label create planner:opus-5');
    expect(formatPlannerLabelGuidance('claude-opus-5', { cli: 'glab' }))
      .toContain('glab label create --name planner:opus-5');
  });

  // A model cannot reliably name itself, so the standing guidance must send it
  // to the injected value rather than inviting it to self-identify.
  it('tells every planner prompt to take the label from its run, not from itself', () => {
    for (const guidance of [DISPATCH_HINT_GUIDANCE, MANDATORY_DISPATCH_HINT_GUIDANCE]) {
      expect(guidance).toContain('planner:<model>');
      expect(guidance).toContain('Planner attribution');
      expect(guidance).toContain('Never guess it');
    }
    expect(JIRA_DISPATCH_HINT_GUIDANCE).toContain('planner-<model>');
    expect(JIRA_DISPATCH_HINT_GUIDANCE).not.toMatch(/planner:</);
  });
});

// The rendered `issue create` example is what an agent actually copies. It used
// to be a literal per prompt template, which is how a new axis could reach the
// guidance prose while being absent from every command an agent runs.
describe('optional issue-label flag slots', () => {
  it('offers every conditional axis, planner included', () => {
    expect(formatOptionalIssueLabelFlags()).toBe(
      '[--label model:<tier>] [--label effort:<level>] [--label planner:<model>] [--label "good first issue"] [--label "help wanted"]',
    );
    expect(OPTIONAL_ISSUE_LABEL_FLAG_SLOTS).toContain('[--label planner:<model>]');
  });

  // A contract that already REQUIRES an axis must not have it offered a second
  // time as optional — an example listing `--label model:<tier>` twice reads as
  // two different labels.
  it('suppresses a slot the caller already spells out as required', () => {
    const rendered = formatOptionalIssueLabelFlags(REPO_STUDY_LABEL_CONTRACT.forgeFlags);
    expect(rendered.startsWith(REPO_STUDY_LABEL_CONTRACT.forgeFlags)).toBe(true);
    expect(rendered).not.toContain('[--label model:<tier>]');
    expect(rendered).not.toContain('[--label effort:<level>]');
    expect(rendered).toContain('[--label planner:<model>]');
    expect(rendered).toContain('[--label "help wanted"]');
  });

  it('tolerates a missing or non-string contract', () => {
    expect(formatOptionalIssueLabelFlags(null)).toBe(formatOptionalIssueLabelFlags());
    expect(formatOptionalIssueLabelFlags(undefined)).toBe(formatOptionalIssueLabelFlags());
  });
});
