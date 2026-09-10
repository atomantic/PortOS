/**
 * Characterization matrix for `buildReviewLoopFollowUpSection` (#6846).
 *
 * The section is agent-facing INSTRUCTION text rendered for three mutually
 * exclusive phases — the pre-PR local review (`localOnly`), the inline PR-side
 * step (`inlineExitStep`), and the standalone follow-up — crossed with two
 * forges, `leaveOpen`, and verbose/compact output. A wrong-phase sentence is an
 * agent that pushes when it must not, or that runs the other forge's command,
 * and nothing else in the suite pins the phase matrix. So this file renders
 * every combination against one fixed fixture and pins the exact bytes.
 *
 * Snapshots are FILE snapshots (`__snapshots__/reviewLoopMatrix/*.txt`) rather
 * than an inline `.snap`: the payload IS prose, and a raw file stays readable
 * (and diffable) as the prompt an agent will actually receive, where a `.snap`
 * would escape every one of its several hundred backticks.
 *
 * The `describe` blocks below the matrix assert the load-bearing lines by
 * phrase — the diff command, the merge command, the view/confirm command, the
 * comment command, the "Do NOT push" rule, the exit step and the hard stop — so
 * a snapshot update can never silently bless a sentence from the wrong phase.
 */

import { describe, it, expect, vi } from 'vitest';

// The section embeds two agent-facing `curl` commands aimed at this install's
// own API. Pin the origin so the matrix is byte-stable regardless of the host's
// HTTPS state or port env; `reviewLifecycle.test.js` owns that contract.
vi.mock('../../lib/networkExposure.js', () => ({
  localApiBaseUrl: () => 'http://127.0.0.1:5555',
}));

import { buildReviewLoopFollowUpSection } from './reviewLifecycle.js';

const SNAP = (name) => `./__snapshots__/reviewLoopMatrix/${name}.txt`;

// A stand-in for slashdo's `lib/local-agent-review-loop.md`. Short, but shaped
// so both body transforms fire: `prepareSandboxedReviewLoopBody` neutralizes
// the bypass flag, and `prepareLocalReviewLoopBody` (local phase only) replaces
// the numbered push step.
const CLI_REVIEW_RECIPE = [
  '## Local agent review loop',
  '',
  '1. **Prepare the prompt**: build `$LOCAL_PROMPT` from the diff.',
  '2. **Invoke the reviewer**: `claude -p "$LOCAL_PROMPT" --dangerously-skip-permissions`',
  '3. **Parse findings**: read the reviewer output.',
  '4. **Apply fixes**: edit the files yourself.',
  '5. **Push verified changes**:',
  '   git pull --rebase --autostash && git push',
  '6. **Re-loop or stop**: repeat until clean.',
  '',
].join('\n');

// Zero-based configured order: the one local-phase reviewer leads every PR-side
// one, so the inline phase's cross-phase stop-mode skip is ENABLED here.
const REVIEWER_POSITIONS = [
  { reviewer: 'mtplx', position: 0 },
  { reviewer: 'ollama', position: 1 },
  { reviewer: 'copilot', position: 2 },
  { reviewer: 'codex', position: 3 },
  { reviewer: '@example-user', position: 4 },
];

const INLINE_EXIT_STEP = 'Return to the **Completion Workflow** above and write the completion sentinel — the run is not done until you have. Do NOT open a second PR.';

/**
 * One fixture for every cell: `copilot` + a CLI reviewer + a tool-free local-LLM
 * reviewer + a `@username`, so all four reviewer-kind bullets render, with a
 * model pin, an effort pin, a round cap and an optional reviewer on top.
 */
const fixture = (overrides = {}) => ({
  reviewLoopFollowUp: true,
  reviewLoopPRUrl: 'https://github.com/example-org/example-repo/pull/42',
  reviewLoopPRBranch: 'feature/example',
  reviewLoopPRNumber: 42,
  reviewLoopPROwner: 'example-org',
  reviewLoopPRRepo: 'example-repo',
  reviewLoopPRHost: 'github.com',
  reviewLoopReviewers: ['copilot', 'codex', 'ollama'],
  reviewLoopReviewerUsernames: ['example-user'],
  reviewLoopOptionalReviewers: ['ollama'],
  reviewLoopReviewerMaxRounds: { codex: 3 },
  reviewLoopReviewerModels: { codex: 'gpt-5.6-sol', ollama: 'qwen3-coder' },
  reviewLoopReviewerEfforts: { codex: 'high' },
  reviewLoopStopMode: 'all',
  sourceTaskId: 'task-example',
  ...overrides,
});

// `gh`: no caller override, host resolves to GitHub.
// `glab`: the caller override the two ladders disagree about — a self-managed
// GitLab whose host does NOT contain `gitlab.`, so `detectForgeCli` maps it to
// `gh` while `normalizeForgeCli(forgeCli)` says `glab`.
const FORGES = {
  gh: { host: 'github.com', forgeCli: null },
  glab: { host: 'git.example.com', forgeCli: 'glab' },
};

const PHASES = {
  local: {
    opts: {
      localOnly: true,
      baseBranch: 'main',
      localPhaseReviewRequired: true,
    },
  },
  inline: {
    opts: {
      inlineExitStep: INLINE_EXIT_STEP,
      baseBranch: 'main',
      localPhaseReviewers: ['mtplx'],
      localPhaseCanShortCircuit: true,
      localPhaseReviewRequired: true,
    },
  },
  followUp: {
    opts: { baseBranch: 'main' },
  },
};

const render = ({ phase, forge, leaveOpen, verbose }) => buildReviewLoopFollowUpSection(
  fixture({ reviewLoopPRHost: FORGES[forge].host, reviewLoopLeaveOpen: leaveOpen }),
  {
    verbose,
    forgeCli: FORGES[forge].forgeCli,
    localAgentLoopBody: CLI_REVIEW_RECIPE,
    reviewerPositions: REVIEWER_POSITIONS,
    ...PHASES[phase].opts,
  },
);

const CELL = (phase, forge, leaveOpen, verbose) => ({ phase, forge, leaveOpen, verbose });

describe('buildReviewLoopFollowUpSection — phase × forge × leaveOpen × verbosity matrix', () => {
  // The pre-PR local phase never merges, never comments on a PR and never emits
  // the verbose variant (`verbose && !localOnly`), so `leaveOpen` and `verbose`
  // are no-ops for it. Asserting that equality is strictly stronger than
  // snapshotting four identical files, and it fails loudly if either flag ever
  // starts leaking into the local phase.
  for (const forge of Object.keys(FORGES)) {
    it(`renders the local phase on ${forge}`, async () => {
      await expect(render(CELL('local', forge, false, false))).toMatchFileSnapshot(SNAP(`local-${forge}`));
    });

    it(`ignores leaveOpen and verbose in the local phase on ${forge}`, () => {
      const base = render(CELL('local', forge, false, false));
      expect(render(CELL('local', forge, true, false))).toBe(base);
      expect(render(CELL('local', forge, false, true))).toBe(base);
      expect(render(CELL('local', forge, true, true))).toBe(base);
    });
  }

  for (const phase of ['inline', 'followUp']) {
    for (const forge of Object.keys(FORGES)) {
      for (const leaveOpen of [false, true]) {
        for (const verbose of [false, true]) {
          const name = `${phase}-${forge}-${leaveOpen ? 'leaveopen' : 'merge'}-${verbose ? 'verbose' : 'compact'}`;
          it(`renders ${name}`, async () => {
            await expect(render(CELL(phase, forge, leaveOpen, verbose))).toMatchFileSnapshot(SNAP(name));
          });
        }
      }
    }
  }

  // Copilot leading the configured order is the one arrangement where the
  // system pre-requests the initial review, so the follow-up says "wait" rather
  // than "request". `prioritizeToolFreeReviewers` puts `ollama` first in the
  // main fixture, which renders the other arm everywhere above.
  it('renders the follow-up phase with copilot leading the order', async () => {
    const section = buildReviewLoopFollowUpSection(
      fixture({ reviewLoopReviewers: ['copilot', 'codex'], reviewLoopOptionalReviewers: [] }),
      { verbose: false, localAgentLoopBody: CLI_REVIEW_RECIPE, reviewerPositions: REVIEWER_POSITIONS, baseBranch: 'main' },
    );
    await expect(section).toMatchFileSnapshot(SNAP('followup-copilot-first'));
  });

  // The merge-only variant (Review Loop off) returns from `buildMergeFollowUpSection`
  // before any reviewer defaulting, and carries the SECOND forge ladder: its
  // inline arm reads the caller's override while its non-inline arm re-derives
  // from the PR host.
  for (const forge of Object.keys(FORGES)) {
    for (const phase of ['inline', 'followUp']) {
      const name = `mergeonly-${phase}-${forge}`;
      it(`renders ${name}`, async () => {
        const section = buildReviewLoopFollowUpSection(
          fixture({ reviewLoopPRHost: FORGES[forge].host, reviewLoopMergeOnly: true }),
          {
            verbose: false,
            forgeCli: FORGES[forge].forgeCli,
            ...(phase === 'inline' ? { inlineExitStep: INLINE_EXIT_STEP } : {}),
          },
        );
        await expect(section).toMatchFileSnapshot(SNAP(name));
      });
    }
  }
});

describe('buildReviewLoopFollowUpSection — load-bearing lines stay with their phase', () => {
  it('keeps the pre-PR local phase off every publishing action', () => {
    const section = render(CELL('local', 'gh', false, false));

    expect(section).toContain('### Local Review Before Opening the PR/MR');
    // Local reviewers diff the worktree against the remote base, never the PR.
    expect(section).toContain('`git diff origin/main...HEAD`');
    expect(section).not.toContain('gh pr diff');
    // #5106, twice over: a local reviewer must not push or publish.
    expect(section).toContain('**Pre-PR rule:** keep reviewer fixes committed locally. Do NOT push or open a PR/MR here');
    expect(section).toContain('Do NOT push or open a PR/MR yet.');
    expect(section).toContain('**Hard stop:** if a required reviewer\'s loop is not converged after 10 rounds, do NOT push or open a PR/MR when substantive findings remain');
    // …and must not carry any merge, comment or exit step.
    expect(section).not.toContain('gh pr merge');
    expect(section).not.toContain('glab mr merge');
    expect(section).not.toContain('gh pr comment');
    expect(section).not.toContain('6. Exit.');
    expect(section).not.toContain('Return to the **Completion Workflow** above and write the completion sentinel');
    // The local body transform removed slashdo's push step.
    expect(section).toContain('5. **Keep verified changes local**:');
    expect(section).not.toContain('git pull --rebase --autostash && git push');
    // …and the public-content sanitizer neutralized the recipe's bypass flag.
    expect(section).toContain('2. **Invoke the reviewer**: `claude -p "$LOCAL_PROMPT" [unsafe bypass disabled for public review]`');
  });

  it('hands the inline phase back to its completion workflow instead of exiting', () => {
    const section = render(CELL('inline', 'gh', false, false));

    expect(section).toContain('## Review Loop');
    expect(section).toContain('Nothing has reviewed this PR yet');
    expect(section).toContain('**Cross-phase stop-mode gate:**');
    expect(section).toContain('**Required local-review merge gate:**');
    expect(section).toContain('gh pr merge "https://github.com/example-org/example-repo/pull/42" --merge --delete-branch');
    expect(section).toContain(`6. ${INLINE_EXIT_STEP}`);
    expect(section).not.toContain('6. Exit. Do **not** run `/do:push`');
    expect(section).not.toContain('### Local Review Before Opening the PR/MR');
  });

  it('exits the standalone follow-up after the merge it verifies', () => {
    const section = render(CELL('followUp', 'gh', false, false));

    expect(section).toContain('## Review-Loop Follow-up (PRIMARY OBJECTIVE)');
    expect(section).toContain('Drive the review-and-fix loop to completion and merge.');
    expect(section).toContain('on GitHub `gh pr diff 42` also works');
    expect(section).toContain('HTTP_STATUS=$(gh pr diff 42 | jq');
    expect(section).toContain('gh pr merge "https://github.com/example-org/example-repo/pull/42" --merge --delete-branch');
    expect(section).toContain('(Equivalent: `gh pr merge 42 --repo example-org/example-repo --merge --delete-branch`.)');
    expect(section).toContain('`gh pr view "https://github.com/example-org/example-repo/pull/42" --json state -q .state` must return `MERGED`');
    expect(section).toContain('6. Exit. Do **not** run `/do:push` or open a new PR — the merge handles everything.');
    expect(section).not.toContain('**Cross-phase stop-mode gate:**');
    expect(section).not.toContain('Do NOT push or open a PR/MR');
  });

  it('replaces the merge steps with a comment when the PR is a human\'s to land', () => {
    const section = render(CELL('followUp', 'gh', true, false));

    expect(section).toContain('**leave the PR open** — do NOT merge it, and do NOT delete the branch.');
    expect(section).toContain('5. Post a short comment on the PR summarising what the reviewers raised and what you fixed');
    expect(section).toContain('`gh pr comment "https://github.com/example-org/example-repo/pull/42" --body "<summary>"`');
    expect(section).toContain('6. Exit. Do **not** run `/do:push` or open a new PR. The system will clean up your worktree on exit.');
    expect(section).not.toContain('gh pr merge');
    expect(section).not.toContain('must return `MERGED`');
  });

  it('routes every forge command through the caller override on a self-managed GitLab', () => {
    const section = render(CELL('followUp', 'glab', false, false));

    expect(section).toContain('HTTP_STATUS=$(glab mr diff 42 | jq');
    expect(section).toContain('glab mr merge "42" --yes --remove-source-branch');
    expect(section).toContain('`glab mr view "42"` must show it merged');
    expect(section).toContain('request `@example-user` as MR reviewer using the GitLab project UI or API');
    expect(section).not.toContain('gh pr merge');
    expect(section).not.toContain('gh pr view');
  });

  /**
   * The ONE behavior change #6846 authorizes, and the regression guard for it.
   * `reviewForgeCli` resolves the caller's override first and only then the PR
   * host, but the `leaveOpen` closing steps re-derived their comment command
   * from `detectForgeCli(host)` — which returns `gh` for any host that is
   * neither `github.com` nor `*gitlab.*`, i.e. exactly the self-managed GitLab
   * the override exists for. A run that diffed with `glab mr diff` was told to
   * comment with `gh pr comment`, which fails outright on an MR URL.
   *
   * Both PR-side phases share those closing steps, so the fix moves the same
   * line in four matrix cells (inline/follow-up x verbose/compact) and nothing
   * else in the whole matrix.
   */
  it('routes the leaveOpen comment command through the caller override too', () => {
    for (const phase of ['inline', 'followUp']) {
      const section = render(CELL(phase, 'glab', true, false));

      expect(section).toContain('HTTP_STATUS=$(glab mr diff 42 | jq');
      expect(section).toContain('5. Post a short comment on the MR summarising');
      expect(section).toContain('`glab mr note 42 --message "<summary>"`');
      expect(section).not.toContain('gh pr comment');
    }
  });

  /**
   * The same disagreement in `buildMergeFollowUpSection`: its INLINE arm read
   * the caller's override while its non-inline arm re-derived from the PR host,
   * so a merge-only follow-up on a self-managed GitLab was handed `gh pr merge`.
   * Both arms now read the one resolved forge.
   */
  it('reads the caller override for the merge-only gate in both phases', () => {
    for (const opts of [{ inlineExitStep: INLINE_EXIT_STEP }, {}]) {
      const section = buildReviewLoopFollowUpSection(
        fixture({ reviewLoopPRHost: FORGES.glab.host, reviewLoopMergeOnly: true }),
        { verbose: false, forgeCli: 'glab', ...opts },
      );
      expect(section).toContain('glab mr merge 42 --yes --remove-source-branch');
      expect(section).toContain('`glab mr view 42` must show it merged');
      expect(section).not.toContain('gh pr merge');
      expect(section).not.toContain('gh pr checks');
    }
  });

  /**
   * The mirror-image disagreement, and the reason ONE resolution has to read
   * both signals. `manualForgeCli` bottoms out at `gh`, so the light path hands
   * a follow-up driving somebody else's GitLab MR `forgeCli: 'gh'` — an override
   * that overrode nothing. Resolving the override first therefore used to hand
   * `gh pr diff` / `gh pr merge` to a run whose PR host says `gitlab.com`, while
   * the comment command and merge gate re-derived from that host and said glab.
   */
  it('follows a GitLab PR host that a defaulted gh override cannot contradict', () => {
    const hostGlab = (over, opts) => buildReviewLoopFollowUpSection(
      fixture({ reviewLoopPRHost: 'gitlab.com', ...over }),
      { verbose: false, forgeCli: 'gh', localAgentLoopBody: CLI_REVIEW_RECIPE, baseBranch: 'main', ...opts },
    );

    const merging = hostGlab({}, {});
    expect(merging).toContain('HTTP_STATUS=$(glab mr diff 42 | jq');
    expect(merging).toContain('glab mr merge "42" --yes --remove-source-branch');
    expect(merging).toContain('`glab mr view "42"` must show it merged');
    expect(merging).toContain('request `@example-user` as MR reviewer using the GitLab project UI or API');
    expect(merging).not.toContain('gh pr merge');
    expect(merging).not.toContain('gh pr view');

    const leaveOpen = hostGlab({ reviewLoopLeaveOpen: true }, {});
    expect(leaveOpen).toContain('5. Post a short comment on the MR summarising');
    expect(leaveOpen).toContain('`glab mr note 42 --message "<summary>"`');
    expect(leaveOpen).not.toContain('gh pr comment');

    const mergeOnly = hostGlab({ reviewLoopMergeOnly: true }, {});
    expect(mergeOnly).toContain('glab mr merge 42 --yes --remove-source-branch');
    expect(mergeOnly).not.toContain('gh pr checks');
  });

  // A GitHub host with no override must still get every `gh` command — the fix
  // above follows the RESOLVED forge, not "prefer glab".
  it('keeps the merge-only gate on gh when nothing overrides a GitHub host', () => {
    const section = buildReviewLoopFollowUpSection(
      fixture({ reviewLoopMergeOnly: true }),
      { verbose: false },
    );
    expect(section).toContain('gh pr merge "https://github.com/example-org/example-repo/pull/42" --merge --delete-branch');
    expect(section).not.toContain('glab mr merge');
  });
});
