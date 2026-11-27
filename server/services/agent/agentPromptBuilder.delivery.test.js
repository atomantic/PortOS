import { homeStub, makeTask, installPromptBuilderHooks } from './agentPromptBuilder.test.fixture.js';
import { mandatoryDispatchHintGuidance } from '../../lib/dispatchLabels.js';
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { join } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { execFileSync, spawnSync } from 'child_process';
import { PATHS } from '../../lib/fileUtils.js';
import { resolveBashBinary } from '../../lib/bashResolver.js';
import { resolveCompletionMode } from '../../lib/agent/agentCompletionMode.js';
import { buildLightContextPrompt, buildAgentPrompt } from './agentPromptBuilder.js';
import { getAgentInstructionsContext } from '../promptSections/instructions.js';
import { buildCompletionGuidelineBullet } from '../promptSections/completion.js';
import { getCodeReviewDefaults } from '../codeReview.js';
import { getMemorySection } from '../memoryRetriever.js';
import { getDigitalTwinForPrompt } from '../digital-twin.js';
import { getToolsSummaryForPrompt } from '../tools.js';
import { writeResolvedSlashdoBody } from '../../lib/slashdoLoader.js';
import { composeClaimIssuePrompt } from '../taskPromptDefaults/prompts.js';
import { buildClaimEpicSection, buildClaimGithubHandoff, buildClaimCheckRecovery, buildClaimLinkedScreen, buildClaimMergeSection, buildClaimCleanupSection, buildClaimPrSideReview, buildClaimReleasePaths } from '../promptSections/claimOnDemand.js';
import { CLAIM_GITHUB_COMMENT_FALLBACK, CLAIM_GITLAB_COMMENT_FALLBACK } from '../taskPromptDefaults/catalog/claimEvidence.js';
import { ISSUE_BLOCKER_RECONCILIATION_GH, REQUIRED_CI_LATE_REGISTRATION_NOTE } from '../taskPromptDefaults/catalog/guidance.js';
import { PROGRAMMATIC_OUTPUT_COMPLETION_HEADING } from '../../lib/agent/agentSentinel.js';

installPromptBuilderHooks();

describe('tool-free public-review stage completion', () => {
  // The Eligibility Gate runs with every tool removed. The No-Code contract
  // (deliver via an API call, then write the sentinel) sent the model narrating
  // "I will now update PortOS" instead of printing the JSON envelope.
  const gateTask = () => makeTask({
    metadata: {
      context: 'Security scan status: passed.', noCodeOutput: true, discardWorktree: true, openPR: false,
      executionProfile: 'public-review-gate',
    },
  });

  it('tells the model its reply is the deliverable and never mentions a sentinel or API action', () => {
    const prompt = buildLightContextPrompt(gateTask(), '/repo', null, {
      providerId: 'claude-ollama', providerCommand: 'claude',
    });
    expect(prompt).toMatch(/## Completion \(Tool-Free Reasoning\)/);
    expect(prompt).toMatch(/final message of this reply/);
    expect(prompt).not.toMatch(/## Completion \(No Code Output\)/);
    expect(prompt).not.toMatch(/\.agent-done/);
    expect(prompt).not.toMatch(/API request or command/);
  });
});

describe('sandboxed public-review actions stage completion', () => {
  // Stage 3 has tools and a discarded worktree; its deliverable is the JSON
  // payload in the sentinel, which the No-Code contract explicitly disclaims.
  it('gets the programmatic-output sentinel contract, not the API-action one', () => {
    const task = makeTask({
      metadata: { noCodeOutput: true, discardWorktree: true, openPR: false, executionProfile: 'public-review-actions' },
    });
    const prompt = buildLightContextPrompt(task, '/repo', null, {
      providerId: 'codex-tui', providerCommand: 'codex',
    });
    expect(prompt).toMatch(/exact payload format described in your task instructions/);
    expect(prompt).not.toMatch(/## Completion \(No Code Output\)/);
    expect(prompt).not.toMatch(/## Completion \(Tool-Free Reasoning\)/);
  });

  // #6062 made this stage attachable on a TUI provider whose vendor declares an
  // attachable recipe. A TUI run finalizes on the `.agent-done` watcher and
  // `dispatchTaskOutputHook` reads the payload from that same file, so the
  // contract only holds if the posture — not the provider type — decides it.
  // Were the TUI arm to win here, an attachable Stage 3 would be told to run
  // `/simplify` + `/do:pr` in a discarded worktree and its decision payload
  // would have to be scraped back out of repaint-heavy PTY output.
  it('gives the same sentinel-payload contract on a TUI provider as on a headless one', () => {
    const task = () => makeTask({
      metadata: { noCodeOutput: true, discardWorktree: true, openPR: false, executionProfile: 'public-review-actions' },
    });
    // Same provider record, spawned two ways — so the ONLY variable is the
    // spawn mode, which is exactly the thing that must not move the contract.
    const headless = buildLightContextPrompt(task(), '/repo', null, {
      providerType: 'cli', providerId: 'claude-code', providerCommand: 'claude',
    });
    const tui = buildLightContextPrompt(task(), '/repo', null, {
      providerType: 'tui', providerId: 'claude-code', providerCommand: 'claude',
    });
    expect(tui).toMatch(/exact payload format described in your task instructions/);
    expect(tui).toMatch(/\.agent-done/);
    // The TUI push/PR workflow must stay suppressed — the worktree is discarded.
    expect(tui).not.toMatch(/## Completion Workflow/);
    expect(tui).not.toMatch(/YOU run the Completion Workflow/);
    expect(tui).toBe(headless);
  });
});

describe('no-code / API-action task completion (CD agents must NOT be told to /do:push)', () => {
  // A Creative Director agent's deliverable is an HTTP PATCH described in its
  // prompt, not a commit — so it must get the No-Code completion section, never
  // the /do:push "Completion Workflow" (which just makes it load that skill for
  // nothing and contradicts its "on a 200 your task is complete" instructions).
  const cdTask = () => makeTask({
    metadata: { context: 'PATCH /api/creative-director/x/plan with the plan', noCodeOutput: true, openPR: false },
  });

  it('a no-code TUI task gets the No-Code completion section, not the /do:push Completion Workflow', () => {
    const prompt = buildLightContextPrompt(cdTask(), '/repo', null, {
      providerId: 'claude-code-tui', providerCommand: 'claude',
    });
    expect(prompt).toMatch(/## Completion \(No Code Output\)/);
    expect(prompt).toMatch(/there is nothing to push/);
    expect(prompt).toMatch(/\.agent-done/); // still writes the sentinel so it finalizes promptly
    // The /do:push "Completion Workflow" section must be absent (the only literal
    // `/do:push` left is inside the "do NOT run /do:push" instruction itself).
    expect(prompt).not.toMatch(/## Completion Workflow/);
  });

  it('recognizes a legacy CD task by its creativeDirector marker (pre-upgrade pending, no explicit flag)', () => {
    // A CD task queued before the noCodeOutput flag existed carries only the
    // creativeDirector marker — it must STILL skip the /do:push workflow.
    const legacyCdTask = makeTask({
      metadata: { context: 'PATCH the plan', creativeDirector: { projectId: 'p', kind: 'plan' }, openPR: false },
    });
    const prompt = buildLightContextPrompt(legacyCdTask, '/repo', null, {
      providerId: 'claude-code-tui', providerCommand: 'claude',
    });
    expect(prompt).toMatch(/## Completion \(No Code Output\)/);
    expect(prompt).not.toMatch(/## Completion Workflow/);
  });

  it('a normal code task on the same provider still gets the /do:push Completion Workflow', () => {
    const prompt = buildLightContextPrompt(
      makeTask({ metadata: { openPR: false } }), '/repo', null,
      { providerId: 'claude-code-tui', providerCommand: 'claude' },
    );
    expect(prompt).toMatch(/## Completion Workflow/);
    expect(prompt).toMatch(/\/do:push/);
    expect(prompt).not.toMatch(/## Completion \(No Code Output\)/);
  });
});

describe('draft review delivery', () => {
  it('puts the draft override in the system contract of a split provider prompt', async () => {
    const task = makeTask({ metadata: { useWorktree: true, openPR: true, reviewLoop: true, prCompletion: 'draft' } });
    const parts = await buildAgentPrompt(task, {}, '/repo', { worktreePath: '/worktree', branchName: 'audit/topic' }, {
      providerType: 'cli', providerId: 'claude-code', providerCommand: 'claude', split: true,
    });
    expect(parts.systemPrompt).toContain('DRAFT pull request for human review');
    expect(parts.systemPrompt).toContain('gh pr create --draft');
    expect(parts.systemPrompt).toContain('--no-merge');
    expect(parts.systemPrompt).not.toMatch(/gh pr merge|glab mr merge|--auto-merge/);
    expect(parts.userPrompt).not.toContain('## Draft pull request delivery');
  });

  it.each([true, false])('overrides merge defaults on the light/full path (%s)', async light => {
    const task = makeTask({ metadata: { useWorktree: true, openPR: true, reviewLoop: true, prCompletion: 'draft' } });
    const prompt = light
      ? buildLightContextPrompt(task, '/repo', { worktreePath: '/worktree', branchName: 'audit/topic' }, { isTui: true, providerId: 'codex-tui', providerCommand: 'codex' })
      : await buildAgentPrompt(task, {}, '/repo', { worktreePath: '/worktree', branchName: 'audit/topic' }, { providerType: 'api' });
    expect(prompt).toContain('DRAFT pull request for human review');
    expect(prompt).toContain('gh pr create --draft');
    expect(prompt).not.toMatch(/gh pr merge|--auto-merge/);
  });
});

describe('generic own-PR delivery retains assigned scope under provider merge authority', () => {
  const worktree = { worktreePath: '/worktree', branchName: 'cos/task-1/agent-1', baseBranch: 'main' };
  const ADMISSION = '## Hosting-provider merge authority';

  it.each([
    ['slashdo TUI', { isTui: true, providerId: 'claude-code-tui', providerCommand: 'claude' }, true],
    ['slashdo CLI', { isTui: false, providerId: 'claude-code', providerCommand: 'claude' }, true],
    ['inline harness', { isTui: true, providerId: 'codex-tui', providerCommand: 'codex' }, false],
  ])('a %s run that merges its own PR gets provider policy and reports the binding decision', (_label, provider, slashdo) => {
    const promptTrace = {};
    const prompt = buildLightContextPrompt(makeTask({ metadata: { openPR: true } }), '/repo', worktree,
      { ...provider, agentId: 'agent-1', promptTrace });
    expect(promptTrace.mergesOwnPr).toBe(true);
    expect(prompt).toContain(ADMISSION);
    expect(prompt).not.toContain('/api/cos/merge-admission');
    expect(prompt).toContain('agent-1');
    expect(prompt).toContain('--match-head-commit <sha>');
    expect(prompt).not.toContain('--delete-branch');
    expect(prompt).toContain('PortOS cleans up the managed worktree and branch automatically after completion');
    expect(prompt).toContain('do not report a cleanup hold or create checkout archives');
    expect(prompt).not.toContain('/api/cos/schedule/branch-reconcile/checkouts/review');
    expect(prompt).not.toContain('/api/cos/schedule/branch-reconcile/checkouts/retire');
    expect(prompt).not.toContain('git worktree remove');
    expect(prompt).not.toContain('git branch -d');
    expect(prompt).toMatch(/gh pr merge "[^"]+" --merge --match-head-commit <verified-head>/);
    // Read before the workflow whose TUI form ends on the sentinel write.
    expect(prompt.indexOf(ADMISSION)).toBeLessThan(prompt.search(/^## Completion/m));
    // Keep one explicit, head-pinned merge path after delegated publication.
    if (slashdo) expect(prompt).toContain('/do:pr --review-with none --no-merge');
  });

  it.each([
    ['a leave-open policy', { openPR: true, prCompletion: 'leave-open' }, worktree],
    ['a JIRA human handoff', { openPR: true, jiraTicketId: 'EX-1' }, worktree],
    ['a PortOS-merged branch', { openPR: false }, worktree],
    ['a run without a worktree', { openPR: true }, null],
  ])('%s neither acquires admission nor binds generic delivery', (_label, metadata, worktreeInfo) => {
    const promptTrace = {};
    const prompt = buildLightContextPrompt(makeTask({ metadata }), '/repo', worktreeInfo,
      { isTui: true, providerId: 'claude-code-tui', providerCommand: 'claude', agentId: 'agent-1', promptTrace });
    expect(promptTrace.mergesOwnPr).toBe(false);
    expect(prompt).not.toContain(ADMISSION);
  });

  it('keeps the claim flow on its own claim admission rather than the generic binding', () => {
    const promptTrace = {};
    const prompt = buildLightContextPrompt(makeTask({ metadata: { analysisType: 'claim-issue', claimFlow: true, useWorktree: false, openPR: false } }),
      '/repo', null, { isTui: true, providerId: 'claude-code-tui', providerCommand: 'claude', agentId: 'agent-1', promptTrace });
    expect(promptTrace.mergesOwnPr).toBe(false);
    expect(prompt.split(ADMISSION)).toHaveLength(2);
    expect(prompt).toContain('## Claim ownership binding');
    // A swarm parent frees each delivered branch, not only at run end (#15459).
    expect(prompt).toContain('Release a branch the moment its own PR/MR is confirmed MERGED');
  });

  it.each([true, false])('gives a repository-cleanup recovery with a parent PR target admission on the %s light/full path (#12251)', async (light) => {
    const recoveryOrigin = { parentAgentId: 'agent-0', parentTaskId: 'task-0', subsystem: 'repository-cleanup', attempt: 1, observation: 'a'.repeat(64), noProgress: false };
    const target = { url: 'https://github.com/example/repo/pull/7', branch: 'cos/task-0/agent-0' };
    const build = (metadata) => light
      ? buildLightContextPrompt(makeTask({ metadata }), '/repo', null, { isTui: true, providerId: 'claude-code-tui', providerCommand: 'claude', agentId: 'agent-1' })
      : buildAgentPrompt(makeTask({ metadata }), {}, '/repo', null, { providerType: 'api', agentId: 'agent-1' });
    const prompt = await build({ isRecovery: true, recoveryOrigin, recoveryMergeTarget: target });
    expect(prompt.split(ADMISSION)).toHaveLength(2);
    expect(prompt).toContain('--match-head-commit <sha>');
    // Copied prose or a target without the recovery lineage grants nothing.
    expect(await build({ recoveryMergeTarget: target })).not.toContain(ADMISSION);
    expect(await build({ isRecovery: true, recoveryOrigin })).not.toContain(ADMISSION);
  });

  it('leaves an API run, whose PR PortOS opens and a follow-up merges, unbound', async () => {
    const promptTrace = {};
    const prompt = await buildAgentPrompt(makeTask({ metadata: { openPR: true } }), {}, '/repo', worktree,
      { providerType: 'api', agentId: 'agent-1', promptTrace });
    expect(promptTrace.mergesOwnPr).not.toBe(true);
    expect(prompt).not.toContain(ADMISSION);
  });
});

describe('review-loop follow-up on a PR whose head is the default branch (#12855)', () => {
  const metadata = {
    reviewLoopFollowUp: true,
    reviewLoopReviewers: [],
    reviewLoopMergeOnly: true,
    reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
    reviewLoopPRBranch: 'main',
    reviewLoopPRNumber: 9,
    reviewLoopPROwner: 'o',
    reviewLoopPRRepo: 'r',
    sourceTaskId: 'task-src-release',
  };
  const detached = { branchName: 'main', worktreePath: '/tmp/wt', existingBranch: true, detached: true, headIsDefaultBranch: true };
  const build = (light, worktreeInfo) => light
    ? buildLightContextPrompt(makeTask({ metadata }), '/repo', worktreeInfo, { isTui: true, providerId: 'claude-code-tui', providerCommand: 'claude', agentId: 'agent-1' })
    : buildAgentPrompt(makeTask({ metadata }), {}, '/repo', worktreeInfo, { providerType: 'api', agentId: 'agent-1' });

  it.each([true, false])('forbids pushing to the head branch and routes a fix through a new PR on the %s light/full path', async (light) => {
    const prompt = await build(light, detached);
    expect(prompt).toContain('NEVER push to the head branch');
    expect(prompt).toContain('open its own PR against the default branch');
    expect(prompt).toContain('DETACHED at the PR head commit');
    // The ordinary existing-branch instruction would tell the agent to push review fixes to `main`.
    expect(prompt).not.toContain('Commit and **push** any review-fix commits to this branch');
  });

  it.each([true, false])('keeps the push-to-branch contract for an ordinary PR branch on the %s light/full path', async (light) => {
    const prompt = await build(light, { branchName: 'main', worktreePath: '/tmp/wt', existingBranch: true });
    expect(prompt).not.toContain('NEVER push to the head branch');
    expect(prompt).not.toContain('DETACHED at the PR head commit');
  });
});

describe('claim-flow completion handoff', () => {
  it.each([true, false])('honors leave-open on the %s light/full claim path', async (light) => {
    const task = makeTask({ metadata: { analysisType: 'claim-issue', claimFlow: true, useWorktree: false, openPR: false, prCompletion: 'leave-open' } });
    const prompt = light
      ? buildLightContextPrompt(task, '/repo', null, { isTui: true, providerId: 'codex-tui', providerCommand: 'codex' })
      : await buildAgentPrompt(task, {}, '/repo', null, { providerType: 'api' });
    expect(prompt).toContain('PR completion policy: LEAVE OPEN');
    expect(prompt).toContain('Complete implementation, configured reviews, publication, and CI checks as usual');
    expect(prompt).toContain('preserve the claim markers, issue state, branch, and worktree');
    expect(prompt).toContain('do not wait for a human or require MERGED status');
  });

  it('tells a relaunched claim to finish the worktree the previous run already started', () => {
    const prompt = buildLightContextPrompt(
      makeTask({
        description: 'Claim issue 42',
        metadata: {
          claimFlow: true,
          useWorktree: false,
          openPR: false,
          claimResumeInPlace: true,
          existingBranch: 'claim/issue-42',
          resumeWorktreePath: '/data/cos/worktrees/claim-portos-issue-42',
          resumedFromAgentId: 'agent-previous',
          prompt: 'if the issue is already in progress, exit cleanly',
        },
      }),
      '/repo',
      {
        worktreePath: '/data/cos/worktrees/claim-portos-issue-42',
        branchName: 'claim/issue-42',
        existingBranch: true,
        claimResumeInPlace: true,
      },
      { isTui: true, providerId: 'grok-tui', providerCommand: 'grok' },
    );

    const overrideAt = prompt.indexOf('## Relaunch — finish the claim already started');
    const exitAt = prompt.indexOf('if the issue is already in progress, exit cleanly');
    expect(overrideAt).toBeGreaterThan(-1);
    expect(exitAt).toBeGreaterThan(overrideAt);
    expect(prompt).toContain('`/data/cos/worktrees/claim-portos-issue-42`');
    expect(prompt).toContain('`claim/issue-42`');
    expect(prompt).toContain('`agent-previous`');
    expect(prompt).toContain('finish this task\'s existing claim');
  });

  it('keeps self-managed claim work out of the generic false/false handoff', () => {
    const prompt = buildLightContextPrompt(
      makeTask({ metadata: { claimFlow: true, useWorktree: false, openPR: false, simplify: true } }),
      '/repo', null,
      { isTui: true, providerId: 'codex-tui', providerCommand: 'codex' },
    );

    expect(prompt).toMatch(/## Claim Workflow Handoff/);
    expect(prompt).not.toContain('PR completion policy: LEAVE OPEN');
    expect(prompt).toMatch(/owns its worktree, branch, PR\/MR, review, merge or human-handoff, and cleanup/);
    expect(prompt).toMatch(/\.agent-done/);
    expect(prompt).not.toMatch(/PortOS will merge it back after completion/);
    expect(prompt).not.toMatch(/Do NOT push this worktree branch yourself/);
    expect(prompt).not.toMatch(/Commit and push using `\/do:push`/);
  });

  it('uses the claim handoff on the full API prompt path too', async () => {
    const prompt = await buildAgentPrompt(
      makeTask({ metadata: { claimFlow: true, useWorktree: false, openPR: false, simplify: true } }),
      {}, '/repo', null, { providerType: 'api' },
    );

    expect(prompt).toMatch(/## Claim Workflow Handoff/);
    expect(prompt).not.toContain('PR completion policy: LEAVE OPEN');
    expect(prompt).toMatch(/follow the claim workflow prompt above/i);
    expect(prompt).not.toMatch(/PortOS will merge it back after completion/);
  });

  it('renders merge-on-green PR completion policy for claim flow on light and full prompt paths', async () => {
    const lightPrompt = buildLightContextPrompt(
      makeTask({ metadata: { claimFlow: true, useWorktree: false, openPR: false, prCompletion: 'merge-on-green' } }),
      '/repo', null,
      { isTui: true, providerId: 'codex-tui', providerCommand: 'codex', agentId: 'parent-example' },
    );

    expect(lightPrompt).toMatch(/## Claim Workflow Handoff/);
    expect(lightPrompt).toContain('PR completion policy: MERGE ON GREEN (no code review)');
    expect(lightPrompt).not.toContain('## Reviewer pin');
    expect(lightPrompt).not.toContain('Required-review publication rule');

    const apiPrompt = await buildAgentPrompt(
      makeTask({ metadata: { claimFlow: true, useWorktree: false, openPR: false, prCompletion: 'merge-on-green' } }),
      {}, '/repo', null, { providerType: 'api', agentId: 'parent-example' },
    );

    expect(apiPrompt).toMatch(/## Claim Workflow Handoff/);
    expect(apiPrompt).toContain('PR completion policy: MERGE ON GREEN (no code review)');
    expect(apiPrompt).not.toContain('## Reviewer pin');
    expect(apiPrompt).not.toContain('Required-review publication rule');
    for (const prompt of [lightPrompt, apiPrompt]) {
      expect(prompt).toContain('This run is parent-example');
      expect(prompt).toContain('never invent a parent');
    }
  });

  it('keeps the full API no-change prompt coupled to the normal change workflow', async () => {
    const prompt = await buildAgentPrompt(
      makeTask({ metadata: {
        autonomousJob: true,
        noChangeSuccess: true,
        useWorktree: true,
        openPR: true,
        simplify: true,
      } }),
      {}, '/repo',
      { branchName: 'b', worktreePath: '/tmp/wt', baseBranch: 'origin/main' },
      { providerType: 'api' },
    );

    expect(prompt).toMatch(/leave the worktree clean/i);
    expect(prompt).toMatch(/If a change is needed, continue through the normal workflow/i);
    expect(prompt).toMatch(/## Simplify Step/);
    expect(prompt).toMatch(/system will push and open/i);
    expect(prompt).toMatch(/Only commit files YOU changed/);
  });

  it('recognizes a queued legacy claim task by analysisType', () => {
    const prompt = buildLightContextPrompt(
      makeTask({ metadata: { analysisType: 'claim-issue', useWorktree: false, openPR: false } }),
      '/repo', null,
      { isTui: true, providerId: 'codex-tui', providerCommand: 'codex' },
    );

    expect(prompt).toMatch(/## Claim Workflow Handoff/);
    expect(prompt).not.toMatch(/PortOS will merge it back after completion/);
  });

  // The reviewer pin used to be appended by each of three claim-prompt
  // generators; #4770 moved it here, off the task's persisted reviewer bundle,
  // so it covers all five claim task types from ONE call site.
  describe('reviewer pin', () => {
    const claimMeta = (extra = {}) => ({ claimFlow: true, useWorktree: false, openPR: false, ...extra });

    it('pins the reviewers the task persisted, exactly once', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: claimMeta({ reviewers: ['codex', 'claude'], usernames: ['alice'] }) }),
        '/repo', null,
        { isTui: true, providerId: 'codex-tui', providerCommand: 'codex' },
      );

      expect(prompt).toContain('## Reviewer pin — use the reviewers PortOS configured');
      expect(prompt).toContain('--review-with codex,claude,@alice');
      expect(prompt.match(/## Reviewer pin/g)).toHaveLength(1);
      // The pin leads the handoff rather than replacing it.
      expect(prompt.indexOf('## Reviewer pin')).toBeLessThan(prompt.indexOf('## Claim Workflow Handoff'));
    });

    it('carries the per-reviewer suffixes the task persisted into the pinned flag', () => {
      const prompt = buildLightContextPrompt(
        makeTask({
          metadata: claimMeta({
            reviewers: ['antigravity', 'ollama'],
            usernames: [],
            optionalReviewers: ['ollama'],
            reviewerMaxRounds: { antigravity: 1 },
            reviewerModels: { antigravity: 'gemini-3.7-flash' },
            reviewerEfforts: { antigravity: 'medium' },
          }),
        }),
        '/repo', null,
        { isTui: true, providerId: 'codex-tui', providerCommand: 'codex' },
      );

      expect(prompt).toContain('--review-with ollama~opt,antigravity[gemini-3.7-flash]~max=1~effort=medium');
    });

    it('emits the pin on the full API prompt path too', async () => {
      const prompt = await buildAgentPrompt(
        makeTask({ metadata: claimMeta({ reviewers: ['grok'], usernames: [] }) }),
        {}, '/repo', null, { providerType: 'api' },
      );

      expect(prompt).toContain('--review-with grok');
      expect(prompt.match(/## Reviewer pin/g)).toHaveLength(1);
    });

    it('never pins a bare copilot on a claim task — the claim agent has no CLI to run it', async () => {
      // A claim task queued before #4770 carries no reviewer metadata, so the
      // pin falls through to the install default. Routing that through the claim
      // resolver is what keeps an in-flight legacy task off the #2507 stall.
      vi.mocked(getCodeReviewDefaults).mockResolvedValueOnce({ reviewers: ['copilot'] });
      const prompt = await buildAgentPrompt(
        makeTask({ metadata: claimMeta() }), {}, '/repo', null, { providerType: 'api' },
      );

      expect(prompt).toContain('--review-with codex');
      expect(prompt).not.toContain('--review-with copilot');
    });

    it('does not emit the pin for a non-claim task', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: false, reviewers: ['codex'] } }),
        '/repo', null,
        { isTui: true, providerId: 'codex-tui', providerCommand: 'codex' },
      );

      expect(prompt).not.toContain('## Reviewer pin');
    });
  });
});

describe('buildLightContextPrompt', () => {
  describe('what it includes', () => {
    it('disables external review when a TUI task opens a PR without a Review Loop', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { mergeHandoffMinQueuedRuns: 3, simplify: true, openPR: true } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        { isTui: true });
      expect(prompt).toMatch(/## Completion Workflow/);
      expect(prompt).toMatch(/`\/simplify`/);
      expect(prompt).toMatch(/`\/do:pr --review-with none --no-merge`/);
      expect(prompt).toMatch(/external review is disabled/i);
      expect(prompt).not.toMatch(/Copilot review loop/i);
      expect(prompt).toMatch(/\.agent-done/);
      // The sentinel is the done signal — the agent must NOT be told to RUN
      // /quit (it's a UI command it can't invoke; PortOS closes the session on
      // poll). The prompt only mentions /quit to tell the agent NOT to run it.
      expect(prompt).not.toMatch(/^\s*\d+\.\s*`\/quit`/m);
      expect(prompt).toMatch(/NOT run `\/quit`/);
      // Without a Review Loop nothing else will ever merge this PR, so the agent
      // merges it itself — gated on CI instead of on a review verdict.
      expect(prompt).toMatch(/gh pr checks "<PR_URL>" --watch --fail-fast/);
      // A repo that disallows merge commits must not dead-end the flow.
      expect(prompt).toMatch(/mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed/);
      // "no checks reported" is ambiguous on a just-opened PR — merging on it races CI.
      expect(prompt).toMatch(/AMBIGUOUS/);
      expect(prompt).toMatch(/gh workflow list/);
      expect(prompt).toMatch(/gh pr merge "<PR_URL>" --merge --match-head-commit <verified-head>/);
      expect(prompt).not.toMatch(/gh pr merge[^`\n]*--auto --merge/);
      expect(prompt).toContain('mergeHandoffMinQueuedRuns');
      expect(prompt).toContain('explicit persisted PortOS pending-merge receipt');
      expect(prompt).toMatch(/gh pr view "<PR_URL>" --json state -q \.state/);
      expect(prompt).toContain('If it returns `MERGED`, publication succeeded even when the CLI failed during local cleanup');
      expect(prompt).toContain('Continue to the completion sentinel when this workflow requires one');
      expect(prompt).toContain('Only while the PR is still unmerged');
      // ...and the gate is CI, not a review-loop status.
      expect(prompt).not.toMatch(/review loop reports/);
    });

    it('a jira-sprint-manager TUI task leaves its PR open instead of merging', () => {
      // The task's prompt moves the ticket to "In Review" and a human lands both;
      // merging here would leave the work merged and the board stuck in review.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { simplify: true, openPR: true, analysisType: 'jira-sprint-manager' } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        { isTui: true });
      expect(prompt).toMatch(/Leave the PR open — do NOT merge it/);
      expect(prompt).toMatch(/tracked in JIRA/);
      // Overrides a saved slashdo `merge: true` default.
      expect(prompt).toMatch(/`\/do:pr --review-with none --no-merge`/);
      expect(prompt).not.toMatch(/gh pr merge/);
      expect(prompt).not.toMatch(/gh pr checks/);
    });

    it('leaves an explicitly leave-open TUI task without review or merge instructions', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { simplify: true, openPR: true, prCompletion: 'leave-open', reviewLoop: true } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        { isTui: true });
      expect(prompt).toMatch(/Leave the PR open — do NOT merge it/);
      expect(prompt).toMatch(/`\/do:pr --review-with none --no-merge`/);
      expect(prompt).not.toMatch(/gh pr merge/);
      expect(prompt).not.toMatch(/review loop/i);
    });

    it('a JIRA-ticketed Claude Code CLI task leaves its PR open instead of merging', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, jiraTicketId: 'PROJ-9' } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        { isTui: false, providerId: 'claude-code' });
      // `--no-merge` is required: a saved slashdo `merge: true` default would
      // otherwise merge the PR before the "leave it open" step is ever reached.
      expect(prompt).toMatch(/`\/do:pr --review-with none --no-merge`/);
      expect(prompt).toMatch(/Leave the PR open — do NOT merge it/);
      expect(prompt).not.toMatch(/gh pr merge/);
    });

    it('an OpenCode TUI JIRA task still hands its PR to PortOS — the agent opens one only when it also lands it', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, analysisType: 'jira-sprint-manager' } }),
        '/r',
        { branchName: 'claim/x', worktreePath: '/tmp/wt', baseBranch: 'main' },
        { isTui: true, providerId: 'opencode-ollama-tui', providerCommand: 'opencode' });
      // A JIRA-tracked PR is a human's to land, so there is no merge section for
      // the agent to drive — and an agent told to open a PR it will never land
      // just races PortOS's own `gh pr create` for the same branch.
      expect(prompt).not.toMatch(/gh pr create/);
      expect(prompt).toMatch(/JIRA-linked human handoff/);
      expect(prompt).not.toMatch(/## Review Loop/);
      expect(prompt).not.toMatch(/## Merge Gate/);
      expect(prompt).not.toMatch(/gh pr merge/);
      expect(prompt).not.toMatch(/glab mr merge/);
    });

    it('a non-worktree run never gets the PR steps — there is no branch name to put in them', () => {
      // The production shape is a JIRA-ticket run (agentWorkspacePrep skips
      // worktree creation when a jiraBranch is set). Emitting the steps anyway
      // rendered a literal `<branch>` placeholder for the agent to guess at.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['codex'] } }),
        '/r',
        null,
        { isTui: true, providerId: 'codex-tui', providerCommand: 'codex' });
      expect(prompt).not.toMatch(/gh pr create/);
      expect(prompt).not.toMatch(/git push -u origin/);
      // …and no dangling "step 4 of the Completion Workflow above" pointing at
      // a section that was never emitted.
      expect(prompt).not.toMatch(/## Review Loop/);
      expect(prompt).not.toMatch(/\$PR_URL/);
    });

    it.each([
      ['a read-only task', { openPR: true, readOnly: true }],
      ['a no-code-output task', { openPR: true, noCodeOutput: true }],
      ['a Creative Director task', { openPR: true, creativeDirector: true }],
      ['a discard-worktree reasoning task', { openPR: true, discardWorktree: true }],
    ])('%s is never told it owns a PR, and gets no inline loop', (_label, metadata) => {
      // These completion contracts never mention a PR. Claiming ownership for
      // them routed a reasoning run into cleanup's did-you-open-it net, which
      // opened a PR for it and filed a HIGH notification blaming the agent.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt', baseBranch: 'main' },
        { isTui: true, providerId: 'codex-tui', providerCommand: 'codex' });
      expect(prompt).not.toMatch(/gh pr create/);
      expect(prompt).not.toMatch(/## Review Loop/);
      expect(prompt).not.toMatch(/## Merge Gate/);
    });

    it('a leave-open review follow-up on a GitLab MR comments with glab, not gh', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopLeaveOpen: true,
          reviewLoopPRUrl: 'https://gitlab.com/g/p/-/merge_requests/5',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 5,
          reviewLoopPRHost: 'gitlab.com',
          reviewLoopReviewers: ['codex'],
          sourceTaskId: 'task-src-6',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' });
      expect(prompt).toMatch(/glab mr note 5 --message/);
      expect(prompt).not.toMatch(/gh pr comment/);
    });

    it('a review-loop follow-up on a JIRA PR reviews but does not merge', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          reviewLoopFollowUp: true,
          reviewLoopLeaveOpen: true,
          reviewLoopPRUrl: 'https://github.com/o/r/pull/9',
          reviewLoopPRBranch: 'b',
          reviewLoopPRNumber: 9,
          reviewLoopReviewers: ['codex'],
          sourceTaskId: 'task-src-5',
        }}),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' });
      expect(prompt).toMatch(/## Review-Loop Follow-up/);
      expect(prompt).not.toContain('## Hosting-provider merge authority');
      // The review still runs — only the merge is withheld.
      expect(prompt).toMatch(/codex/);
      expect(prompt).toMatch(/leave the PR open/i);
      expect(prompt).not.toMatch(/gh pr merge/);
    });

    it('TUI simplify step is provider-aware — non-Claude TUI (codex-tui) gets the inline equivalent, not /simplify', () => {
      // /simplify is a Claude Code TUI built-in; codex-tui / antigravity-tui can't run it.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { simplify: true, openPR: true } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        { isTui: true, providerId: 'codex-tui' });
      expect(prompt).toMatch(/## Completion Workflow/);
      expect(prompt).not.toMatch(/`\/simplify`/);
      expect(prompt).toMatch(/review your changed code for reuse, quality, and efficiency/i);
    });

    it('renders the Completion Workflow with /do:push when openPR is false and there is no worktree', () => {
      // No worktree: the agent stands on the branch it should push, and PortOS
      // merges nothing on exit — so /do:push is the right completion step.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { simplify: true, openPR: false } }),
        '/r', null, { isTui: true });
      expect(prompt).toMatch(/`\/do:push`/);
      expect(prompt).not.toMatch(/`\/do:pr`/);
      // /do:push doesn't open a PR — no merge step should be emitted.
      expect(prompt).not.toMatch(/gh pr merge/);
    });

    it('renders a commit-only Completion Workflow for a worktree with openPR false — PortOS merges it back', () => {
      // Worktree + no PR is the auto-merge posture: cleanup merges the branch
      // into the source checkout and deletes it. A push has no consumer there,
      // and the remote copy `/do:push` left behind is what the repo-state audit
      // reported as "never deleted" and filed recovery agents for (every
      // module-hygiene audit of 2026-09-06/07).
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { simplify: true, openPR: false } }),
        '/r',
        { branchName: 'cos/task-1/agent-a', worktreePath: '/tmp/wt', baseBranch: 'main' },
        { isTui: true });
      expect(prompt).toMatch(/## Completion Workflow/);
      expect(prompt).toMatch(/^1\. `\/simplify`/m);
      expect(prompt).toMatch(/^2\. Stage only the files you changed \(never `git add -A` \/ `git add \.`\) and commit with a conventional message/m);
      expect(prompt).toMatch(/Do NOT push and do NOT open a PR: PortOS merges this branch into `main` in the source checkout after you exit and deletes it/);
      expect(prompt).not.toMatch(/^\s*\d+\.\s+`\/do:push/m);
      expect(prompt).not.toMatch(/`\/do:pr`/);
      expect(prompt).not.toMatch(/gh pr merge/);
      // The sentinel template keeps its branch slot — that is the branch PortOS merges.
      expect(prompt).toMatch(/## Branch\n\s+<branch name>/);
    });

    describe('publication refspecs under a real shell (#11443)', () => {
      // Pulls the emitted fetch refspec and force-with-lease argument out of the
      // prompt, then expands them in a shell with no remote: only printf runs.
      const buildPublishPrompt = () => buildLightContextPrompt(
        makeTask({ metadata: { simplify: true, openPR: true, reviewLoop: true, reviewers: ['codex', 'copilot'] } }),
        '/r',
        { branchName: 'claim/issue-1', worktreePath: '/tmp/wt', baseBranch: 'main' },
        {
          isTui: true,
          providerId: 'opencode-ollama-tui',
          providerCommand: 'opencode',
          localAgentLoopBody: 'RECIPE: codex --sandbox read-only review --base <base>',
        });
      const expandUnderShell = (shell, prompt) => {
        const fetchLine = prompt.split('\n').find((l) => l.includes('git fetch "$PUBLISH_REMOTE"'));
        const leaseLine = prompt.split('\n').find((l) => l.includes('--force-with-lease="refs/heads/'));
        expect(fetchLine).toBeDefined();
        expect(leaseLine).toBeDefined();
        const refspec = fetchLine.match(/"(\+refs\/heads\/[^"]+)"/)[1];
        const lease = leaseLine.match(/--force-with-lease="([^"]+)"/)[1];
        const script = `BRANCH=cos/example; PUBLISH_REMOTE=origin; REMOTE_BRANCH_SHA=0123abc; printf '%s\\n' "${refspec}" "${lease}"`;
        const args = shell === 'zsh' ? ['-f', '-c', script] : ['--noprofile', '--norc', '-c', script];
        return execFileSync(shell, args, { encoding: 'utf8' }).split('\n');
      };
      const expected = [
        '+refs/heads/cos/example:refs/remotes/origin/cos/example',
        'refs/heads/cos/example:0123abc',
      ];
      const hasZsh = spawnSync('zsh', ['-f', '-c', 'exit 0']).status === 0;

      it('expands the emitted refspecs to the branch names under bash', () => {
        expect(expandUnderShell(resolveBashBinary(), buildPublishPrompt())).toEqual([...expected, '']);
      });

      it.runIf(hasZsh)('expands the emitted refspecs identically under zsh (a bare $BRANCH: is a zsh modifier)', () => {
        expect(expandUnderShell('zsh', buildPublishPrompt())).toEqual([...expected, '']);
      });
    });

    it('a slashdo-free OpenCode TUI with no reviewer gets the CI merge gate, not a review loop', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { simplify: true, openPR: true } }),
        '/r',
        { branchName: 'claim/issue-1', worktreePath: '/tmp/wt', baseBranch: 'main' },
        { isTui: true, providerId: 'opencode-ollama-tui', providerCommand: 'opencode' });
      expect(prompt).toMatch(/gh pr create/);
      expect(prompt).toMatch(/## Merge Gate/);
      expect(prompt).not.toMatch(/## Review Loop/);
      expect(prompt).toMatch(/gh pr checks/);
      expect(prompt).toMatch(/gh pr merge "\$PR_URL" --merge --match-head-commit <verified-head>/);
      expect(prompt).not.toMatch(/PortOS will push the branch/);
    });

    it('OpenCode TUI without openPR leaves the committed branch for PortOS to merge', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: false } }),
        '/r',
        { branchName: 'claim/issue-2', worktreePath: '/tmp/wt' },
        { isTui: true, providerId: 'opencode-ollama-tui', providerCommand: 'opencode' });
      expect(prompt).toMatch(/## Completion Workflow/);
      expect(prompt).not.toMatch(/`\/do:push`/);
      expect(prompt).not.toMatch(/git push/);
      expect(prompt).not.toMatch(/gh pr create/);
      expect(prompt).not.toMatch(/glab mr create/);
      expect(prompt).not.toMatch(/gh pr merge/);
      expect(prompt).toMatch(/\.agent-done/);
    });

    it('does not interpolate a branch ref into a shell command in the system-owned handoff', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: false } }),
        '/r',
        { branchName: 'weird;rm -rf', worktreePath: '/tmp/wt' },
        { isTui: true, providerId: 'opencode-ollama-tui', providerCommand: 'opencode' });
      expect(prompt).not.toMatch(/git push/);
      expect(prompt).not.toMatch(/git .*weird;rm -rf/);
    });

    // #3114 acceptance criteria — the completion gates derive from
    // `resolveSlashdoStyle`, so the two behaviors the old inline provider-id
    // allowlists got wrong are now asserted.
    it('a codex TUI gets the plain git/gh completion workflow, never /do:pr', () => {
      // codex installs slashdo as Agent Skills, not slash commands, so telling it
      // to run `/do:pr` handed it an uninvokable line. The old is-TUI-slashdo-free
      // check only recognized OpenCode + lean mode, so codex fell through to the
      // slashdo path.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, reviewers: ['copilot'] } }),
        '/r',
        { branchName: 'claim/x', worktreePath: '/tmp/wt', baseBranch: 'main' },
        { isTui: true, providerId: 'codex-tui', providerCommand: 'codex', defaultReviewers: ['copilot'] });
      expect(prompt).toMatch(/## Completion Workflow/);
      expect(prompt).toMatch(/does NOT have slashdo/);
      expect(prompt).not.toMatch(/`\/do:pr`/);
      expect(prompt).not.toMatch(/`\/do:push`/);
      // Plain git/gh equivalent of the whole slashdo workflow (#3733).
      expect(prompt).toMatch(/git commit -m/);
      expect(prompt).toContain('publish_reviewed_branch -u "$PUSH_REMOTE" "$BRANCH"');
      expect(prompt).toMatch(/gh pr create --base main --head "\$PR_HEAD"/);
      expect(prompt).toMatch(/## Review Loop/);
      expect(prompt).not.toMatch(/PortOS will push the branch/);
      expect(prompt).toMatch(/\.agent-done/);
    });

    it('quotes a hostile branch ref inert in the PR-create command line', () => {
      // Branch names are usually PortOS's own, but a JIRA-derived one is external
      // input — and this text is pasted straight into an agent's terminal, so it
      // goes through the canonical `shellQuote` rather than being dropped for a
      // placeholder the agent would have to guess at.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true } }),
        '/r',
        { branchName: 'weird;rm -rf /', worktreePath: '/tmp/wt', baseBranch: 'main' },
        { isTui: true, providerId: 'codex-tui', providerCommand: 'codex' });
      expect(prompt).toMatch(/BRANCH='weird;rm -rf \/'/);
      expect(prompt).toContain('publish_reviewed_branch -u "$PUSH_REMOTE" "$BRANCH"');
      expect(prompt).toMatch(/gh pr create --base main --head "\$PR_HEAD"/);
      // Never bare — that would be a command substitution waiting to happen.
      expect(prompt).not.toMatch(/origin weird;rm/);
    });

    it('leaves a readable branch unquoted, and falls back to a placeholder with no ref', () => {
      const readable = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true } }),
        '/r',
        { branchName: 'cos/task-1/agent-2', worktreePath: '/tmp/wt', baseBranch: 'main' },
        { isTui: true, providerId: 'codex-tui', providerCommand: 'codex' });
      expect(readable).toMatch(/BRANCH=cos\/task-1\/agent-2/);
      expect(readable).toContain('publish_reviewed_branch -u "$PUSH_REMOTE" "$BRANCH"');

      const noBase = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        { isTui: true, providerId: 'codex-tui', providerCommand: 'codex' });
      expect(noBase).toMatch(/git remote set-head origin --auto/);
      expect(noBase).toMatch(/BASE_BRANCH=\$\(git symbolic-ref --short refs\/remotes\/origin\/HEAD/);
      expect(noBase).toMatch(/gh pr create --base "\$BASE_BRANCH" --head "\$PR_HEAD"/);
    });

    it('a path-configured claude binary under a custom provider id gets the slashdo workflow', () => {
      // The old slashdo-capability gate was an id allowlist (`claude-code` /
      // `claude-code-bedrock`), so a renamed or path-configured claude provider
      // was denied `/simplify` + `/do:pr` even though it launches claude.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, simplify: true } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        { isTui: false, providerId: 'my-custom-agent', providerCommand: '/opt/homebrew/bin/claude' });
      expect(prompt).toMatch(/^## Completion$/m);
      expect(prompt).toMatch(/`\/simplify`/);
      expect(prompt).toMatch(/`\/do:pr/);
      expect(prompt).not.toMatch(/PortOS will push and open the PR/);
    });

    it('an antigravity TUI also drops out of the slashdo workflow', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: false } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        { isTui: true, providerId: 'antigravity-tui', providerCommand: 'agy' });
      expect(prompt).not.toMatch(/`\/do:push`/);
      expect(prompt).not.toMatch(/git push/);
      expect(prompt).toMatch(/PortOS will merge it back/);
    });

    it('a non-OpenCode TUI (claude-code-tui) keeps the slashdo /do:pr workflow', () => {
      // providerCommand is the gate — a claude TUI must NOT fall into the manual path.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        { isTui: true, providerId: 'claude-code-tui', providerCommand: 'claude' });
      expect(prompt).toMatch(/`\/do:pr --review-with none --no-merge`/);
      expect(prompt).toMatch(/external review is disabled/i);
      expect(prompt).not.toMatch(/gh pr create/);
    });

    it('emits a non-TUI "Completion" block (no slashdo) for non-Claude CLI agents', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        { isTui: false, providerId: 'codex', providerCommand: 'codex' });
      expect(prompt).toMatch(/^## Completion$/m);
      expect(prompt).not.toMatch(/`\/do:pr`/);
      expect(prompt).not.toMatch(/`\/quit`/);
      // Owns the lifecycle via plain git/gh instead of handing it to PortOS (#3733),
      // and — being a CLI, not a TUI — never mentions a completion sentinel.
      expect(prompt).toMatch(/gh pr create/);
      expect(prompt).not.toMatch(/PortOS will push and open the PR/);
      expect(prompt).not.toMatch(/\.agent-done/);
    });

    it('inlines a simplify-equivalent self-review (no /simplify command) for non-Claude CLI agents', () => {
      // /simplify is a Claude Code built-in; codex/antigravity can't run it. With
      // simplify enabled they must still get the reuse/quality/efficiency pass,
      // phrased inline so any CLI can perform it.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, simplify: true } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        { isTui: false, providerId: 'antigravity-cli', providerCommand: 'agy' });
      expect(prompt).toMatch(/^## Completion$/m);
      expect(prompt).not.toMatch(/`\/simplify`/);
      expect(prompt).toMatch(/review your changed code for reuse, quality, and efficiency/i);
      expect(prompt).toMatch(/gh pr create/);
      expect(prompt).not.toMatch(/PortOS will push and open the PR/);
    });

    it('offers no-change guidance only where finalize will honour it (marker alone is not enough)', () => {
      const build = (metadata) => buildLightContextPrompt(
        makeTask({ metadata: { noChangeSuccess: true, useWorktree: true, openPR: true, ...metadata } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        { isTui: false, providerId: 'codex', providerCommand: 'codex' });
      expect(build({})).not.toMatch(/no change is needed/i);
      expect(build({ autonomousJob: true })).toMatch(/no change is needed/i);
      expect(build({ isInvestigation: true })).toMatch(/no change is needed/i);
    });

    it('gives a marked catalog audit an explicit no-change exit while retaining the change workflow', () => {
      const task = makeTask({ metadata: {
        autonomousJob: true,
        noChangeSuccess: true,
        useWorktree: true,
        openPR: true,
        simplify: true,
      } });
      const prompt = buildLightContextPrompt(
        task,
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        { isTui: false, providerId: 'codex', providerCommand: 'codex' });
      expect(prompt).toMatch(/no change is needed/i);
      expect(prompt).toMatch(/leave the worktree clean/i);
      expect(prompt).toMatch(/exit without committing/i);
    expect(prompt).toMatch(/If a change is needed, continue through the normal workflow/i);
    expect(prompt).toMatch(/gh pr create/);
  });

  it('keeps the TUI no-change sentinel compatible with a real PR result', () => {
    const prompt = buildLightContextPrompt(
      makeTask({ metadata: {
        autonomousJob: true,
        noChangeSuccess: true,
        useWorktree: true,
        openPR: true,
        simplify: true,
      } }),
      '/r',
      { branchName: 'b', worktreePath: '/tmp/wt' },
      { isTui: true, providerId: 'claude-code-tui', providerCommand: 'claude' },
    );

      expect(prompt).toMatch(/`\/do:pr/);
      expect(prompt).toMatch(/<PR URL, or "No change needed; no PR opened\." if the audit made no change>/);
    });

    it('keeps a lean TUI no-change handoff on the branch sentinel', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: {
          autonomousJob: true,
          noChangeSuccess: true,
          useWorktree: true,
          openPR: true,
        } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        { isTui: true, providerId: 'claude-ollama-tui', providerCommand: 'claude', leanMode: true },
      );

      expect(prompt).toMatch(/## Branch\n\s+<branch name>/);
      expect(prompt).not.toMatch(/<PR URL/);
    });

  // #3114 — the gates now derive from `resolveSlashdoStyle` with the spawners'
    // blank-command posture, so a CLI provider with NO id and NO command reads as
    // Claude: `buildCliSpawnConfig`'s default branch launches `claude`, and the
    // session that actually runs does have `/do:pr` / `/simplify`.
    it('treats a blank CLI provider as Claude Code, matching what the spawner launches', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, simplify: true } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        { isTui: false });
      expect(prompt).toMatch(/`\/simplify`/);
      expect(prompt).toMatch(/`\/do:pr/);
    });

    it('emits a slashdo Completion block (/simplify + /do:pr) for Claude Code CLI + openPR', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { mergeHandoffMinQueuedRuns: 3, openPR: true, reviewLoop: true, simplify: true } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        { isTui: false, providerId: 'claude-code' });
      expect(prompt).toMatch(/^## Completion$/m);
      expect(prompt).toMatch(/`\/simplify`/);
      expect(prompt).toMatch(/`\/do:pr`/);
      expect(prompt).not.toMatch(/PortOS will NOT push/);
      expect(prompt).not.toMatch(/`\/quit`/);
      // After /do:pr drives the Copilot review loop clean, the agent must
      // merge and verify — without these steps the PR sits open after the
      // agent exits (the original "agent abandoned the PR" bug).
      expect(prompt).toMatch(/gh pr merge "<PR_URL>" --merge --match-head-commit <verified-head>/);
      expect(prompt).not.toMatch(/gh pr merge[^`\n]*--auto --merge/);
      expect(prompt).toContain('mergeHandoffMinQueuedRuns');
      expect(prompt).toContain('explicit persisted PortOS pending-merge receipt');
      expect(prompt).toMatch(/gh pr view "<PR_URL>" --json state -q \.state/);
      expect(prompt).toMatch(/MERGED/);
    });

    it('disables external review but merges on green CI for Claude Code CLI when Review Loop is off', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, simplify: false } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        { isTui: false, providerId: 'claude-code' });
      expect(prompt).toMatch(/`\/do:pr --review-with none --no-merge`/);
      expect(prompt).toMatch(/external review disabled/i);
      expect(prompt).not.toMatch(/Copilot review loop/i);
      // No review loop means nothing else merges the PR — the agent gates on CI.
      expect(prompt).toMatch(/gh pr checks "<PR_URL>" --watch --fail-fast/);
      expect(prompt).toMatch(/gh pr merge "<PR_URL>" --merge --match-head-commit <verified-head>/);
      expect(prompt).toMatch(/gh pr view "<PR_URL>" --json state -q \.state/);
      expect(prompt).not.toMatch(/review loop reports/);
    });

    it('skips /simplify in the slashdo Completion block when simplify is disabled', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, reviewLoop: true, simplify: false } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt' },
        { isTui: false, providerId: 'claude-code' });
      expect(prompt).toMatch(/`\/do:pr`/);
      expect(prompt).not.toMatch(/`\/simplify`/);
      // Merge guidance still applies when /simplify is skipped.
      expect(prompt).toMatch(/gh pr merge "<PR_URL>" --merge --match-head-commit <verified-head>/);
    });

    it('tells Claude Code CLI to commit only (no /do:push) when PortOS merges the worktree branch back', () => {
      // Same auto-merge posture as the TUI case above, on the CLI path.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: false, simplify: true } }),
        '/r',
        { branchName: 'b', worktreePath: '/tmp/wt', baseBranch: 'main' },
        { isTui: false, providerId: 'claude-code' });
      expect(prompt).toMatch(/^\s*\d+\.\s+Stage only the files you changed \(never `git add -A` \/ `git add \.`\) and commit with a conventional message/m);
      expect(prompt).toMatch(/Do NOT push and do NOT open a PR: PortOS merges this branch into `main` in the source checkout after you exit and deletes it/);
      expect(prompt).not.toMatch(/^\s*\d+\.\s+`\/do:push/m);
      expect(prompt).not.toMatch(/`\/do:pr`/);
      expect(prompt).not.toMatch(/gh pr merge/);
    });

    it('suppresses the PR completion workflow but still writes a sentinel when readOnly + TUI', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { readOnly: true } }),
        '/r', null, { isTui: true });
      expect(prompt).toMatch(/Read-Only Task/);
      expect(prompt).not.toMatch(/## Completion Workflow/);
      // A read-only TUI agent must still be told to write .agent-done — the
      // sentinel watcher is its only clean finalize/summary path (regression: the
      // read-only branch used to emit the bare notice with no sentinel, so
      // reference-watch runs never signaled completion).
      expect(prompt).toMatch(/\.agent-done/);
      expect(prompt).toMatch(/watches this sentinel/);
    });

    // #7405 — a run read its HOST's read-only role as covering the sentinel too
    // ("the edits/sentinel can't happen here"), then hunted for the path in
    // `runner-state.json` / `state.json` because a SIBLING run's agent id was
    // visible in the shared checkout's branch state. It stalled on a question
    // an unattended run has nobody to answer. The full account is on
    // SENTINEL_WRITE_PERMISSION_NOTE in promptSections/completion.js.
    describe('sentinel-write permission (#7405)', () => {
      const SENTINEL_PATH = '/shared-checkout/.agent-done-agent-07ddbb85';

      const completionPrompt = (metadata = {}) => buildLightContextPrompt(
        makeTask({ metadata }),
        '/shared-checkout', null,
        { isTui: true, agentId: 'agent-07ddbb85', providerId: 'opencode-mtplx-tui', providerCommand: 'opencode' });

      it('gives a worktree-less TUI completion run one canonical sentinel path, no read-only banner, and permission to write it', () => {
        const prompt = completionPrompt();
        // The path is agent-scoped and derived from THIS run's cwd + id, so a
        // sibling agent id elsewhere in the shared checkout cannot change it.
        expect(prompt).toContain(SENTINEL_PATH);
        // EXACTLY one — a second candidate is what sent the stalled run hunting
        // through state files instead of writing the file it was handed.
        expect([...new Set(prompt.match(/[\w/.-]*\.agent-done[\w.-]*/g))]).toEqual([SENTINEL_PATH]);
        expect(prompt).not.toMatch(/## Read-Only Task/);
        // No second place to look the path up.
        expect(prompt).toMatch(/Do NOT look one up in `runner-state\.json`, `state\.json`, a branch name, or a worktree name/);
      });

      // The boundary contract, not the section helper: every TUI task shape
      // that PRINTS a sentinel path must also say the write is permitted.
      // `buildAuditOutputCompletionSection` proves the hazard is real — it
      // interpolates a path and carries no note of its own, and is safe only
      // because it is appended after a section that does.
      it.each([
        ['plain completion', {}],
        ['read-only', { readOnly: true }],
        ['no-code / API action', { noCodeOutput: true }],
        ['reasoning-only worktree', { discardWorktree: true }],
        ['self-managed claim flow', { claimFlow: true }],
      ])('pairs the sentinel path with the write permission for a %s task', (_label, metadata) => {
        const prompt = completionPrompt(metadata);
        expect(prompt).toContain(SENTINEL_PATH);
        expect(prompt).toMatch(/Writing that one file is ALWAYS permitted/);
        // The carve-out has to name the rules it overrides, or a section whose
        // own banner forbids edits still reads as a contradiction.
        expect(prompt).toMatch(/no read-only, do-not-modify, or restricted-session rule applies to it/);
      });
    });

    it('read-only on a non-TUI (CLI) provider gets the bare notice, no sentinel', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { readOnly: true } }),
        '/r', null, { isTui: false, providerId: 'claude-code' });
      expect(prompt).toMatch(/Read-Only Task/);
      // CLI/API agents complete on process exit and never poll a sentinel.
      expect(prompt).not.toMatch(/\.agent-done/);
    });

    it('worktreeCommitGuidance: existing-branch wins over slashdo/PR — emits the review-fix push wording', () => {
      // When the worktree reuses a pre-existing PR branch (e.g. a review-loop
      // follow-up agent picking up where the prior agent left off), the agent
      // must push directly — the PR points at this branch and Copilot only
      // sees commits that are actually pushed. This branch is selected even
      // for a Claude Code CLI provider with `openPR: true`, because the PR
      // already exists; opening another one would be wrong.
      // `reviewLoopFollowUp` is what identifies this case — the PR-branch guidance
      // keys on that marker, not on bare `existingBranch`, so the OTHER producer of
      // `existingBranch` (a resume) can't inherit review-fix instructions for a PR
      // that may not exist.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, simplify: true, reviewLoopFollowUp: true } }),
        '/r',
        { branchName: 'feat-x', worktreePath: '/tmp/wt', existingBranch: true },
        { isTui: false, providerId: 'claude-code' });
      expect(prompt).toMatch(/## Git Worktree/);
      expect(prompt).toMatch(/\*\(pre-existing PR branch\)\*/);
      // The review-fix push wording — distinct from the slashdo/post-exit ones.
      expect(prompt).toMatch(/Commit and \*\*push\*\* any review-fix commits to this branch/);
      expect(prompt).toMatch(/git pull --rebase/);
      // And it must NOT emit the slashdo-driven Completion guidance for this branch.
      expect(prompt).not.toMatch(/the \*\*Completion\*\* section below drives the push and PR/);
    });

    it('a RESUMED worktree gets the resume briefing, not the PR-branch review-fix wording', () => {
      // A retry attached to a dead agent's branch rides the same `existingBranch`
      // mechanism but follows the task's ordinary push/PR flow — there may be no PR
      // at all. It must be told what is already done instead of being told to push
      // review fixes to a PR that doesn't exist.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, simplify: true, resumedFromAgentId: 'agent-dead' } }),
        '/r',
        { branchName: 'cos/task-1/agent-dead', worktreePath: '/tmp/wt', existingBranch: true },
        { isTui: false, providerId: 'claude-code' });
      expect(prompt).toMatch(/## Resuming Unfinished Work/);
      expect(prompt).toMatch(/agent-dead/);
      expect(prompt).not.toMatch(/\*\(pre-existing PR branch\)\*/);
      expect(prompt).not.toMatch(/review-fix commits/);
    });

    it('omits the resume briefing for an ordinary fresh worktree', () => {
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: true, simplify: true } }),
        '/r',
        { branchName: 'cos/task-1/agent-new', worktreePath: '/tmp/wt', baseBranch: 'main' },
        { isTui: false, providerId: 'claude-code' });
      expect(prompt).toMatch(/## Git Worktree/);
      expect(prompt).not.toMatch(/## Resuming Unfinished Work/);
    });

    it('worktreeCommitGuidance: canTypeSlashCommands + !willOpenPR says commit only — PortOS merges the branch back', () => {
      // Claude Code CLI with a worktree but no PR is the auto-merge posture: the
      // worktree guidance must not point the agent at a push nothing consumes.
      const prompt = buildLightContextPrompt(
        makeTask({ metadata: { openPR: false, simplify: true } }),
        '/r',
        { branchName: 'feat-x', worktreePath: '/tmp/wt' },
        { isTui: false, providerId: 'claude-code' });
      expect(prompt).toMatch(/## Git Worktree/);
      expect(prompt).toMatch(/Commit your changes here — do NOT push\. PortOS merges this branch back after you exit/);
      expect(prompt).not.toMatch(/drives the push/);
      // And NOT the post-exit handoff message (that's the codex/antigravity path).
      expect(prompt).not.toMatch(/The system will push and open a PR after you exit/);
    });
  });
});

describe('buildCompletionGuidelineBullet', () => {
  it('read-only short-circuits regardless of other flags', () => {
    const bullet = buildCompletionGuidelineBullet({
      mode: resolveCompletionMode({ isReadOnly: true, isTui: true, worktreeInfo: null, willOpenPR: true }),
      tuiCompletionCommand: '/do:pr', worktreeInfo: null, willOpenPR: true,
    });
    expect(bullet).toMatch(/read-only task/i);
  });

  it('slashdo TUI bullet references the slashdo command', () => {
    const bullet = buildCompletionGuidelineBullet({
      mode: resolveCompletionMode({ isTui: true, worktreeInfo: { worktreePath: '/wt' }, willOpenPR: true }),
      tuiCompletionCommand: '/do:pr', worktreeInfo: { worktreePath: '/wt' }, willOpenPR: true,
    });
    expect(bullet).toMatch(/`\/do:pr`/);
    expect(bullet).not.toMatch(/plain `git`\/`gh`/);
    expect(bullet).toMatch(/do NOT run `\/quit`/);
  });

  it('slashdo-free TUI bullet points at the commit + PortOS handoff, not a /do:* command', () => {
    const bullet = buildCompletionGuidelineBullet({
      mode: resolveCompletionMode({ isTui: true, canRunSlashCommands: false, worktreeInfo: { worktreePath: '/wt' }, willOpenPR: true }),
      tuiCompletionCommand: '/do:pr', worktreeInfo: { worktreePath: '/wt' }, willOpenPR: true,
    });
    expect(bullet).toMatch(/plain `git` commit \+ PortOS handoff/);
    expect(bullet).toMatch(/no slashdo commands/);
    expect(bullet).not.toMatch(/`\/do:pr`/);
    expect(bullet).toMatch(/do NOT run `\/quit`/);
  });

  it('non-TUI worktree+openPR bullet defers push/PR to the system, and read-only/null cases return null', () => {
    const prBullet = buildCompletionGuidelineBullet({
      mode: resolveCompletionMode({ worktreeInfo: { worktreePath: '/wt' }, willOpenPR: true }),
      tuiCompletionCommand: '/do:pr', worktreeInfo: { worktreePath: '/wt' }, willOpenPR: true,
    });
    expect(prBullet).toMatch(/the system will push your branch and open a pull request/);
    // Without a review loop, a follow-up merges on green CI...
    expect(prBullet).toMatch(/merges the PR once CI is green/);
    // ...unless the PR is a human's to land, where the bullet must not promise a merge.
    const jiraBullet = buildCompletionGuidelineBullet({
      mode: resolveCompletionMode({ worktreeInfo: { worktreePath: '/wt' }, willOpenPR: true }),
      tuiCompletionCommand: '/do:pr', worktreeInfo: { worktreePath: '/wt' }, willOpenPR: true, humanLandsPr: true,
    });
    expect(jiraBullet).toMatch(/left OPEN for a human/);
    expect(jiraBullet).not.toMatch(/merges the PR once CI is green/);
    // No worktree, not TUI, not read-only → no bullet.
    const none = buildCompletionGuidelineBullet({
      mode: resolveCompletionMode({ worktreeInfo: null, willOpenPR: false }),
      tuiCompletionCommand: '/do:push', worktreeInfo: null, willOpenPR: false,
    });
    expect(none).toBeNull();
  });

  it('marks a catalog audit no-op as a valid completion without weakening the change path', () => {
    const bullet = buildCompletionGuidelineBullet({
      mode: resolveCompletionMode({ worktreeInfo: { worktreePath: '/wt' }, willOpenPR: true }),
      tuiCompletionCommand: '/do:pr', worktreeInfo: { worktreePath: '/wt' }, willOpenPR: true, noChangeSuccess: true,
    });
    expect(bullet).toMatch(/no change is needed/i);
    expect(bullet).toMatch(/leave the worktree clean/i);
    expect(bullet).toMatch(/exit without committing/i);
    expect(bullet).toMatch(/If a change is needed, continue/);
  });

  it('discardWorktree short-circuits to the reasoning-only bullet (wins over TUI/openPR)', () => {
    const bullet = buildCompletionGuidelineBullet({
      mode: resolveCompletionMode({ isTui: true, worktreeInfo: { worktreePath: '/wt' }, willOpenPR: true, discardWorktree: true }),
      tuiCompletionCommand: '/do:pr', worktreeInfo: { worktreePath: '/wt' }, willOpenPR: true,
    });
    expect(bullet).toMatch(/reasoning-only task/i);
    expect(bullet).toMatch(/discarded on exit/);
    expect(bullet).not.toMatch(/`\/do:pr`/);
  });

  it('claimFlow short-circuits to the claim-owned lifecycle bullet', () => {
    const bullet = buildCompletionGuidelineBullet({
      mode: resolveCompletionMode({ isTui: true, worktreeInfo: null, willOpenPR: false, claimFlow: true }),
      tuiCompletionCommand: '/do:push', worktreeInfo: null, willOpenPR: false,
    });
    expect(bullet).toMatch(/self-managed claim flow/i);
    expect(bullet).toMatch(/Do NOT stop after committing/);
    expect(bullet).not.toMatch(/PortOS will merge/);
  });

  it('noCodeOutput wins over discardWorktree — the deliverable is the action, not the sentinel', () => {
    // The two flags answer different questions: discardWorktree decides what
    // happens to the checkout, noCodeOutput decides where the deliverable goes.
    // A task that does its work through an external action DURING the run (an
    // endpoint call, a filed issue) and also throws the tree away must not be
    // told "write your result to the sentinel" — that is how a run performs no
    // action and reports its findings into a file that is then discarded.
    const bullet = buildCompletionGuidelineBullet({
      mode: resolveCompletionMode({ isTui: true, worktreeInfo: { worktreePath: '/wt' }, willOpenPR: true, discardWorktree: true, noCodeOutput: true }),
      tuiCompletionCommand: '/do:pr', worktreeInfo: { worktreePath: '/wt' }, willOpenPR: true,
    });
    expect(bullet).toMatch(/produces no code output/i);
    expect(bullet).not.toMatch(/reasoning-only task/i);
    // It names /do:pr only to forbid it — the TUI arm would have INSTRUCTED it.
    expect(bullet).toMatch(/do NOT run `\/do:push`, `\/do:pr`/);
    expect(bullet).not.toMatch(/YOU run the Completion Workflow/);
  });
});

// A discardWorktree (reasoning-only) task — the layered-intelligence pattern —
// runs a normal agent in a worktree that is thrown away on exit. The completion
// contract is the `.agent-done` sentinel payload, NOT commit/push/PR. The prompt
// MUST NOT tell the agent to run /do:push, /do:pr, or open a PR, because (a) the
// worktree is discarded so any push is wasted, and (b) the generic markdown
// sentinel workflow would clobber the hook's structured-JSON sentinel contract.
// Regression for codex review of PR #2341.
describe('discardWorktree (reasoning-only) completion contract', () => {
  const wt = { branchName: 'cos/li-1', worktreePath: '/tmp/wt', baseBranch: 'origin/main' };
  const liTask = () => makeTask({ metadata: { discardWorktree: true, useWorktree: true, openPR: false, simplify: true } });

  const assertReasoningOnly = (prompt) => {
    expect(prompt).toMatch(/## Completion \(Reasoning-Only Task\)/);
    // Same heading via the exported constant: a pre-spawn task-type hook
    // (layered-intelligence) can't know the per-instance sentinel filename, so
    // its prompt points the agent at THIS section by name. Re-typing the
    // heading as a literal here would aim that pointer at a section the
    // briefing never emits.
    expect(prompt).toContain(`## ${PROGRAMMATIC_OUTPUT_COMPLETION_HEADING}`);
    expect(prompt).toMatch(/discarded on exit/);
    expect(prompt).toMatch(/\.agent-done/);
    // The whole point: no push/PR/merge instructions anywhere.
    expect(prompt).not.toMatch(/`\/do:push`\*\*/); // no "Use `/do:push`" hygiene bullet
    expect(prompt).not.toMatch(/## Completion Workflow/); // TUI push+PR workflow suppressed
    expect(prompt).not.toMatch(/gh pr merge/);
    expect(prompt).not.toMatch(/will push your branch and open a pull request/);
  };

  it('light TUI path emits the sentinel-only completion, not the /do:push workflow', () => {
    const prompt = buildLightContextPrompt(liTask(), '/r', wt, { isTui: true });
    assertReasoningOnly(prompt);
    // Worktree section carries the discard note, not commit/merge guidance.
    expect(prompt).toMatch(/discarded on exit/);
    expect(prompt).not.toMatch(/merged back/);
  });

  it('light CLI (non-TUI) path emits the sentinel-only completion', () => {
    const prompt = buildLightContextPrompt(liTask(), '/r', wt, { isTui: false, providerId: 'codex' });
    assertReasoningOnly(prompt);
  });

  // A discard task whose deliverable is an EXTERNAL action performed during the
  // run (a filed issue, an endpoint call) must get the no-code-output contract,
  // NOT "write your result to the sentinel" — otherwise it reports its findings
  // into a file the cleanup then throws away, and the window produces nothing.
  //
  // Asserted on the LIGHT path specifically: every `tui`/`cli` provider returns
  // from buildLightContextPrompt, so a quota-burn job (which only ever selects
  // CLI/TUI providers — it exists to spend a subscription window) never reaches
  // the full path. A unit test on buildCompletionGuidelineBullet alone passes
  // while production is unchanged; that false green is how this shipped broken
  // once already.
  describe('with noCodeOutput — the deliverable is the action, not the sentinel', () => {
    const auditTask = () => makeTask({ metadata: { discardWorktree: true, noCodeOutput: true, useWorktree: true, openPR: false } });

    const assertActionOutput = (prompt) => {
      expect(prompt).toMatch(/## Completion \(No Code Output\)/);
      expect(prompt).not.toMatch(/## Completion \(Reasoning-Only Task\)/);
      expect(prompt).not.toMatch(/in the exact payload format/);
      expect(prompt).not.toMatch(/## Completion Workflow/);
    };

    it('light TUI path', () => {
      const prompt = buildLightContextPrompt(auditTask(), '/r', wt, { isTui: true });
      assertActionOutput(prompt);
      // The sentinel is still the done-signal for a TUI run — just not the
      // place the deliverable goes.
      expect(prompt).toMatch(/\.agent-done/);
    });

    it('light CLI (non-TUI) path', () => {
      const prompt = buildLightContextPrompt(auditTask(), '/r', wt, { isTui: false, providerId: 'codex' });
      assertActionOutput(prompt);
    });

    it('full (api) path', async () => {
      const prompt = await buildAgentPrompt(auditTask(), {}, '/r', wt, { providerType: 'api' });
      assertActionOutput(prompt);
    });

    it('a no-code task with NO worktree is never told to commit to the branch it is on', async () => {
      // The dangerous shape: no worktree means the agent stands in the app's own
      // checkout, on its default branch. Git Hygiene's fallback arm ("Commit and
      // push using `/do:push`" + "Commit directly to the current branch") would
      // aim a push straight at that branch — and for a task that changes no code,
      // whatever it swept up would be the user's own uncommitted work.
      const task = makeTask({ metadata: { noCodeOutput: true, useWorktree: false, openPR: false } });
      const prompt = await buildAgentPrompt(task, {}, '/r', null, { providerType: 'api' });
      expect(prompt).toMatch(/## Completion \(No Code Output\)/);
      expect(prompt).toMatch(/Do NOT commit, push, or open a PR/);
      expect(prompt).not.toMatch(/Commit and push using/);
      expect(prompt).not.toMatch(/Commit directly to the current branch/);
      expect(prompt).not.toMatch(/Commit and push your changes/);
    });
  });

  it('full (api) path suppresses the commit/push instructions in Instructions + Git Hygiene', async () => {
    const prompt = await buildAgentPrompt(liTask(), {}, '/r', wt, { providerType: 'api' });
    assertReasoningOnly(prompt);
    // Fallback-template step 4 must not tell the agent to commit/push.
    expect(prompt).toMatch(/Write your result to the completion sentinel/);
    expect(prompt).not.toMatch(/Commit and push your changes/);
    // Git Hygiene commit/push bullet replaced with the do-NOT variant.
    expect(prompt).toMatch(/Do NOT commit, push, or open a PR/);
    // Simplify-before-commit step is suppressed (nothing gets committed).
    expect(prompt).not.toMatch(/## Simplify Step/);
  });

  // #3475 — The `not.toMatch(/gh pr merge/)` assertions above run with homedir
  // stubbed to a path that cannot exist, so the `## CLAUDE.md Instructions`
  // section is empty. That makes them deterministic, but on its own it can't
  // distinguish "the builder suppresses the merge instruction" from "no section
  // of this prompt could ever have contained it" — which is exactly the false
  // green CI has been shipping.
  //
  // This test closes that gap from the other side: it points homedir at a
  // fixture home whose global CLAUDE.md deliberately DOES contain `gh pr merge`,
  // then asserts (a) the fixture really is spliced into the prompt verbatim — so
  // the string is demonstrably reachable — and (b) every byte the BUILDER itself
  // generates still omits it on the discardWorktree path. Verified by probe: stub
  // buildAgentPrompt's `discardWorktree` to `false` (i.e. remove the suppression)
  // and (b) fails on `Commit and push your changes`.
  describe('suppression is positively pinned against a fixture global CLAUDE.md (#3475)', () => {
    // Obviously-fake stand-in for a contributor's personal global instructions.
    const FIXTURE_GLOBAL_CLAUDE_MD = [
      '# Example Global Instructions',
      '',
      '- When CI is green, land it with `gh pr merge <url> --merge --match-head-commit <verified-head>`.',
      '- Commit and push your changes before you stop.',
    ].join('\n');

    let fixtureHome;
    let priorHomeStub;

    beforeAll(() => {
      priorHomeStub = homeStub.dir;
      fixtureHome = mkdtempSync(join(tmpdir(), 'portos-claudemd-fixture-'));
      mkdirSync(join(fixtureHome, '.claude'), { recursive: true });
      writeFileSync(join(fixtureHome, '.claude', 'CLAUDE.md'), FIXTURE_GLOBAL_CLAUDE_MD);
      homeStub.dir = fixtureHome;
    });

    // Restore the nonexistent-home stub — every other test in the file depends on
    // the global CLAUDE.md section being empty.
    afterAll(() => {
      homeStub.dir = priorHomeStub;
      if (fixtureHome) rmSync(fixtureHome, { recursive: true, force: true });
    });

    it('splices the fixture verbatim yet still suppresses commit/push/merge in every builder-generated section', async () => {
      // Sanity: the fixture is live and carries the strings under test. Without
      // this the assertions below could pass because nothing was read at all.
      const claudeMdSection = await getAgentInstructionsContext('/r');
      expect(claudeMdSection).toMatch(/## Agent Instructions/);
      expect(claudeMdSection).toMatch(/gh pr merge/);
      expect(claudeMdSection).toMatch(/Commit and push your changes/);

      const prompt = await buildAgentPrompt(liTask(), {}, '/r', wt, { providerType: 'api' });
      // The verbatim splice is the production contract — the builder passes the
      // user's own instructions through untouched.
      expect(prompt).toContain(claudeMdSection);

      // Everything the builder authored. Removing the exact spliced section (rather
      // than regex-slicing around a heading) keeps the boundary unambiguous.
      const builderAuthored = prompt.replace(claudeMdSection, '');
      expect(builderAuthored).not.toMatch(/Example Global Instructions/); // strip really worked
      // Containment check, not merge coverage: this proves the fixture's own copy
      // of the string stays inside the spliced section and can't decide the
      // assertion — which is the exact confusion that made #3475 false-fail. The
      // api path never emits merge guidance anyway; that half of the contract is
      // pinned by the TUI sibling below.
      expect(builderAuthored).not.toMatch(/gh pr merge/);
      // Non-vacuous: drop the discardWorktree arm and step 4 of the fallback
      // template renders "Commit and push your changes" here.
      expect(builderAuthored).not.toMatch(/Commit and push your changes/);
      expect(builderAuthored).not.toMatch(/## Completion Workflow/);
      // …and the positive half of the same contract still renders.
      expect(builderAuthored).toMatch(/## Completion \(Reasoning-Only Task\)/);
      expect(builderAuthored).toMatch(/Do NOT commit, push, or open a PR/);
    });

    it('a Creative Director task on the full (api) path never splices CLAUDE.md — the fixture is reachable but irrelevant to a content-judging prompt', async () => {
      const cdTask = makeTask({
        metadata: { creativeDirector: { projectId: 'p', kind: 'evaluate' }, useWorktree: false, openPR: false },
      });
      const prompt = await buildAgentPrompt(cdTask, {}, '/r', null, { providerType: 'api' });
      expect(prompt).not.toMatch(/## CLAUDE\.md Instructions/);
      expect(prompt).not.toMatch(/Example Global Instructions/);
    });

    it('a Creative Director task on the full (api) path also omits memory, digital-twin, and onboard-tools sections (#4650)', async () => {
      // Distinctive sentinels so a skipped fetch cannot be confused with an
      // empty-but-called fetch. Restored after so sibling tests keep the empty
      // default (null/'') the rest of the file relies on.
      vi.mocked(getMemorySection).mockClear().mockResolvedValue('## Memory Context\nCD_MEMORY_SENTINEL');
      vi.mocked(getDigitalTwinForPrompt).mockClear().mockResolvedValue('## Digital Twin\nCD_TWIN_SENTINEL');
      vi.mocked(getToolsSummaryForPrompt).mockClear().mockResolvedValue('## Available Tools\nCD_TOOLS_SENTINEL');
      const cdTask = makeTask({
        metadata: { creativeDirector: { projectId: 'p', kind: 'evaluate' }, useWorktree: false, openPR: false },
      });
      const prompt = await buildAgentPrompt(cdTask, {}, '/r', null, { providerType: 'api' });
      expect(getMemorySection).not.toHaveBeenCalled();
      expect(getDigitalTwinForPrompt).not.toHaveBeenCalled();
      expect(getToolsSummaryForPrompt).not.toHaveBeenCalled();
      expect(prompt).not.toContain('CD_MEMORY_SENTINEL');
      expect(prompt).not.toContain('CD_TWIN_SENTINEL');
      expect(prompt).not.toContain('CD_TOOLS_SENTINEL');
      vi.mocked(getMemorySection).mockResolvedValue(null);
      vi.mocked(getDigitalTwinForPrompt).mockResolvedValue(null);
      vi.mocked(getToolsSummaryForPrompt).mockResolvedValue('');
    });

    it('keeps API briefing instructions when optional context retrieval fails, preserving budget fallbacks', async () => {
      vi.mocked(getMemorySection).mockRejectedValueOnce(new Error('memory unavailable'));
      vi.mocked(getDigitalTwinForPrompt).mockRejectedValueOnce(new Error('twin unavailable'));
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const prompt = await buildAgentPrompt(makeTask(), {
          memory: { maxContextTokens: 0 },
          digitalTwin: { maxContextTokens: 0 },
          soul: { maxContextTokens: 1200 },
        }, '/r', null, { providerType: 'api' });
        expect(prompt).toContain('Example Global Instructions');
        expect(prompt).toMatch(/^## Instructions$/m);
        expect(getMemorySection).toHaveBeenLastCalledWith(expect.anything(), { maxTokens: 2000, scopedToApp: true, limit: 3, onInjected: expect.any(Function) });
        expect(getDigitalTwinForPrompt).toHaveBeenLastCalledWith({ maxTokens: 1200, personaId: 'active' });
        expect(log).toHaveBeenCalledWith('⚠️ Memory retrieval failed: memory unavailable');
        expect(log).toHaveBeenCalledWith('⚠️ Digital twin context retrieval failed: twin unavailable');
      } finally {
        log.mockRestore();
      }
    });

    it('a non-CD api task renders memory, digital-twin, and onboard-tools sections', async () => {
      vi.mocked(getMemorySection).mockClear().mockResolvedValue('## Memory Context\nNONCD_MEMORY_SENTINEL');
      vi.mocked(getDigitalTwinForPrompt).mockClear().mockResolvedValue('## Digital Twin\nNONCD_TWIN_SENTINEL');
      vi.mocked(getToolsSummaryForPrompt).mockClear().mockResolvedValue('## Available Tools\nNONCD_TOOLS_SENTINEL');
      const prompt = await buildAgentPrompt(makeTask(), {}, '/r', null, { providerType: 'api' });
      expect(getMemorySection).toHaveBeenCalled();
      expect(getDigitalTwinForPrompt).toHaveBeenCalled();
      expect(getToolsSummaryForPrompt).toHaveBeenCalled();
      // #8200 — the twin reaches API agents; before, only a dead template carried it.
      expect(prompt).toContain('NONCD_TWIN_SENTINEL');
      expect(prompt).toContain('NONCD_MEMORY_SENTINEL');
      expect(prompt).toContain('NONCD_TOOLS_SENTINEL');
      vi.mocked(getMemorySection).mockResolvedValue(null);
      vi.mocked(getDigitalTwinForPrompt).mockResolvedValue(null);
      vi.mocked(getToolsSummaryForPrompt).mockResolvedValue('');
    });

    it('reports the memories retrieval injected through promptTrace for the run record (#10495)', async () => {
      const injected = [{ id: 'mem-1', version: null, relevance: 0.8 }];
      vi.mocked(getMemorySection).mockClear().mockImplementationOnce(async (_task, opts) => {
        opts.onInjected(injected);
        return '## Memory Context\nTRACE_MEMORY_SENTINEL';
      });
      const promptTrace = {};
      const prompt = await buildAgentPrompt(makeTask(), {}, '/r', null, { providerType: 'api', promptTrace });
      expect(prompt).toContain('TRACE_MEMORY_SENTINEL');
      expect(promptTrace.injectedMemories).toEqual(injected);

      const emptyTrace = {};
      await buildAgentPrompt(makeTask(), {}, '/r', null, { providerType: 'api', promptTrace: emptyTrace });
      expect(emptyTrace.injectedMemories).toEqual([]);
    });

    it('a CD scratch cwd does not leak repo AGENTS.md into getAgentInstructionsContext', async () => {
      // Mirrors the fixture-pinning in this block: a dir with no CLAUDE.md
      // (the CD scratch shape) must not surface content that lives in a sibling
      // "repo" fixture. Global ~/.claude/CLAUDE.md still splices here because
      // this describe points homedir at a live fixture — that is a different
      // channel than native project discovery from cwd.
      const repo = mkdtempSync(join(tmpdir(), 'portos-cd-repo-'));
      writeFileSync(join(repo, 'CLAUDE.md'), 'REPO_CLAUDE_MD_LEAK_SENTINEL');
      const scratch = mkdtempSync(join(tmpdir(), 'portos-cd-scratch-'));
      expect(await getAgentInstructionsContext(repo)).toContain('REPO_CLAUDE_MD_LEAK_SENTINEL');
      expect(await getAgentInstructionsContext(scratch)).not.toContain('REPO_CLAUDE_MD_LEAK_SENTINEL');
      rmSync(repo, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    });

    it('light TUI path suppresses the merge instruction and never splices the global CLAUDE.md at all', () => {
      // `openPR: true` on purpose: this is the shape where merge suppression has
      // to do work — the task metadata asks for a PR, and discardWorktree must
      // still win. Remove the discardWorktree arm and this prompt falls through to
      // buildTuiCompletionSection, which renders `gh pr merge … --merge
      // --match-head-commit <verified-head>`. (The `openPR: false` sibling above never reaches that
      // line at all, which is why its /gh pr merge/ check can't carry this.)
      const prTask = makeTask({ metadata: { discardWorktree: true, useWorktree: true, openPR: true, simplify: true } });
      const prompt = buildLightContextPrompt(prTask, '/r', wt, { isTui: true });
      expect(prompt).not.toMatch(/gh pr merge/);
      expect(prompt).toMatch(/## Completion \(Reasoning-Only Task\)/);
      // The light path targets agentic CLIs that load CLAUDE.md natively, so the
      // builder must not paste it in. The live fixture proves that positively; the
      // nonexistent-home stub the rest of the file uses could not.
      expect(prompt).not.toMatch(/## CLAUDE\.md Instructions/);
      expect(prompt).not.toMatch(/Example Global Instructions/);
    });
  });
});

// #6616 — The full (api) fallback template derives the completion contract in
// three independent places: step 4 of `## Instructions`, the `## Guidelines`
// completion bullet, and the `## Git Hygiene` bullet. Every other test in this
// file asserts one section at a time, so a prompt whose sections CONTRADICT
// each other reads as green. These two assert the agreement itself.
//
// Both shapes are reachable in production and both shipped a self-contradicting
// prompt: step 4's ladder tests neither `toolFreeReasoning` nor `readOnly`, so
// each fell through to "Commit and push your changes" while the sibling
// sections said the opposite.
describe('full (api) path: step 4 and Git Hygiene agree on the completion contract (#6616)', () => {
  // Every arm of step 4's ladder that forbids a commit; if the prompt carries
  // NONE of these, the ladder fell through to its commit-and-push default.
  const NO_COMMIT_STEP_4 = /4\. (Deliver your result the way the task describes|Write your result to the completion sentinel|Follow the claim workflow prompt above|Follow the follow-up section above|Answer in this reply|Do NOT commit, push, or modify)/;

  it('a tool-free public-review task is never told to commit — in step 4 or in Git Hygiene', async () => {
    // The Eligibility Gate posture: no tools at all, no worktree, and the
    // deliverable is the reply itself. `noCodeOutput` is deliberately absent —
    // that is the exact shape whose step 4 had no matching arm.
    const prompt = await buildAgentPrompt(
      makeTask({ metadata: { executionProfile: 'public-review-gate', useWorktree: false, openPR: false } }),
      {}, '/r', null, { providerType: 'api' });

    // The contract the other two sections already got right.
    expect(prompt).toMatch(/## Completion \(Tool-Free Reasoning\)/);
    expect(prompt).toMatch(/\*\*No git at all\.\*\*/);
    // …and the one that contradicted them.
    expect(prompt).not.toMatch(/Commit and push your changes/);
    expect(prompt).not.toMatch(/Commit and push using/);
    expect(prompt).toMatch(NO_COMMIT_STEP_4);
  });

  it('a read-only task is never told to commit — in step 4 or in Git Hygiene', async () => {
    const prompt = await buildAgentPrompt(
      makeTask({ metadata: { readOnly: true, useWorktree: false, openPR: false } }),
      {}, '/r', null, { providerType: 'api' });

    // The Guidelines bullet already resolved this correctly.
    expect(prompt).toMatch(/\*\*This is a read-only task\.\*\*/);
    // Step 4 and Git Hygiene must not send it to commit against that bullet —
    // and, with no worktree, "commit and push" aims at the app's own checkout.
    expect(prompt).not.toMatch(/Commit and push your changes/);
    expect(prompt).not.toMatch(/Commit and push using/);
    expect(prompt).not.toMatch(/Commit directly to the current branch/);
    expect(prompt).toMatch(NO_COMMIT_STEP_4);
  });
});

describe('auto-merge posture (worktree, no PR) is commit-only on every path', () => {
  // `portosMergesBranchOnExit` is the one decision the completion, hygiene and
  // worktree sections all key on. It is pinned through the rendered prompts
  // (here and in the TUI/CLI cases above) rather than as a truth table — a wrong
  // answer re-arms the `/do:push` that filed a recovery agent after every
  // module-hygiene audit on 2026-09-06/07, and the prompt is where that shows.
  it('api path: the simplify step, instructions and Git Hygiene all say commit only, never /do:push', async () => {
    const prompt = await buildAgentPrompt(
      makeTask({ metadata: { openPR: false, simplify: true } }),
      {}, '/r',
      { branchName: 'cos/task-1/agent-a', worktreePath: '/tmp/wt', baseBranch: 'main' },
      { providerType: 'api' });
    expect(prompt).toMatch(/Fix any issues found, then commit your changes \(do NOT push — PortOS merges this branch back into the source checkout after you exit/);
    expect(prompt).toMatch(/Commit your changes \(see Git Hygiene below\) — do NOT push, PortOS merges this branch back on exit/);
    expect(prompt).toMatch(/\*\*Commit only — do NOT push\.\*\* Stage specific files \(no `git add -A`\), use `feat:`\/`fix:`\/`breaking:` prefix in the commit message, no Co-Authored-By annotations\. PortOS merges this branch back into the source checkout after you exit and deletes it, so do NOT run `git push` or `\/do:push` yourself/);
    expect(prompt).not.toMatch(/Commit and push using `\/do:push`/);
    expect(prompt).not.toMatch(/Commit and push your changes/);
    // The Guidelines bullet already described the merge-back; it still does.
    expect(prompt).toMatch(/Your worktree branch will be automatically merged back to the source branch/);
  });

  it('api path: the same task WITHOUT a worktree keeps commit-and-push', async () => {
    const prompt = await buildAgentPrompt(
      makeTask({ metadata: { openPR: false, simplify: true } }),
      {}, '/r', null, { providerType: 'api' });
    expect(prompt).toMatch(/commit and push using `\/do:push`/);
    expect(prompt).toMatch(/Commit and push using `\/do:push`/);
    expect(prompt).not.toMatch(/PortOS merges this branch back/);
  });

  it('buildCompletionGuidelineBullet renders the commit-only TUI wording when there is no completion command', () => {
    const bullet = buildCompletionGuidelineBullet({
      mode: resolveCompletionMode({ isTui: true, worktreeInfo: { worktreePath: '/wt' }, willOpenPR: false }),
      tuiCompletionCommand: null, worktreeInfo: { worktreePath: '/wt' }, willOpenPR: false,
    });
    expect(bullet).toMatch(/commit only — no push; PortOS merges your branch back after you exit/);
    expect(bullet).not.toMatch(/`\/do:push`/);
  });
});

describe('buildAgentPrompt — claim procedures on demand', () => {
  const stagedPath = (name) => `/install/data/cos/slashdo-resolved/${name}-0123abcd.md`;
  const resolveRoot = (text) => text.replaceAll('{portosRoot}', () => PATHS.installRoot);
  const githubPrompt = resolveRoot(composeClaimIssuePrompt({ forge: 'github' }));
  const githubLocalReview = githubPrompt.match(/(?:^|\n)(## Phase 5 — Review locally \(BEFORE any PR exists\)\n[\s\S]*?)(?=\n## |$)/)[1];
  const githubSections = [
    ['claim-issue-filing-github', mandatoryDispatchHintGuidance({ cli: 'gh' })],
    ['claim-epic-github', buildClaimEpicSection('github', false)],
    ['claim-handoff-github', buildClaimGithubHandoff(false)],
    ['claim-release-paths-github', buildClaimReleasePaths('github', false)],
    ['claim-comment-fallback-github', CLAIM_GITHUB_COMMENT_FALLBACK],
    ['claim-blocked-reconcile', ISSUE_BLOCKER_RECONCILIATION_GH],
    ['claim-pr-side-review-github', buildClaimPrSideReview('github')],
    ['claim-ci-late-registration', REQUIRED_CI_LATE_REGISTRATION_NOTE],
    ['claim-linked-screen-github', resolveRoot(buildClaimLinkedScreen('github'))],
    ['claim-ci-recovery-github', buildClaimCheckRecovery('github', false)],
    ['claim-merge-github', buildClaimMergeSection('github')],
    ['claim-cleanup-github', buildClaimCleanupSection('github')],
    ['claim-local-review', githubLocalReview],
  ];
  const claimTask = (prompt, field) => makeTask(field === 'description'
    ? { description: prompt, metadata: { claimFlow: true } }
    : { description: 'Claim the next issue', metadata: { claimFlow: true, prompt } });
  const render = (prompt, providerType, field) => buildAgentPrompt(claimTask(prompt, field), {}, '/r', null,
    { providerType, providerId: 'codex', providerCommand: 'codex' });
  const stagedSections = () => vi.mocked(writeResolvedSlashdoBody).mock.calls.filter(([name]) => name.startsWith('claim-'));

  beforeEach(() => {
    vi.mocked(writeResolvedSlashdoBody).mockReset();
    vi.mocked(writeResolvedSlashdoBody).mockImplementation(async (name) => stagedPath(name));
  });

  it.each(['cli', 'tui'])('points a %s host at the exact procedures with conditional triggers', async (providerType) => {
    const prompt = await render(githubPrompt, providerType);
    expect(stagedSections()).toEqual(githubSections);
    for (const [name, body] of githubSections) {
      expect(prompt).toContain(`READ \`${stagedPath(name)}\``);
      expect(prompt).not.toContain(body);
    }
    expect(prompt).toContain('## Phase 1b — Decompose an epic (only when Phase 1 landed on one)');
    expect(prompt).toContain('When Phase 1 lands on an epic');
    expect(prompt).toContain('When the comment check prints a CLAIMANT');
    expect(prompt).toContain('When a linked PR is by a non-collaborator');
    expect(prompt).toContain('When a required check fails');
    expect(prompt).toContain('When no tool-free gate is present, READ');
    expect(prompt).toContain('When any open issue carries `blocked`, READ');
    expect(prompt).toContain('If it exits at once with `no required checks reported`, READ');
    expect(prompt).toContain('3. **PR-SIDE reviewers.** When the reviewer list names an `@<login>`');
    expect(prompt).toContain('- **Release paths.** When the issue is already fixed');
  });

  it('defers the GitLab procedures when the claim is carried in the description', async () => {
    const composed = resolveRoot(composeClaimIssuePrompt({ forge: 'gitlab', target: 42, prCompletion: 'leave-open' }));
    const gitlabLocalReview = composed.match(/(?:^|\n)(## Phase 5 — Review locally \(BEFORE any MR exists\)\n[\s\S]*?)(?=\n## |$)/)[1];
    const prompt = await render(composed, 'cli', 'description');
    expect(stagedSections()).toEqual([
      ['claim-issue-filing-gitlab', mandatoryDispatchHintGuidance({ cli: 'glab' })],
      ['claim-epic-gitlab', buildClaimEpicSection('gitlab', true)],
      ['claim-release-paths-gitlab', buildClaimReleasePaths('gitlab', true)],
      ['claim-comment-fallback-gitlab', CLAIM_GITLAB_COMMENT_FALLBACK],
      ['claim-pr-side-review-gitlab', buildClaimPrSideReview('gitlab')],
      ['claim-linked-screen-gitlab', resolveRoot(buildClaimLinkedScreen('gitlab'))],
      ['claim-ci-recovery-gitlab', buildClaimCheckRecovery('gitlab', true)],
      ['claim-local-review', gitlabLocalReview],
    ]);
    expect(prompt).toContain('When a linked MR is by a non-collaborator');
    expect(prompt).toContain('For a claimant, verify project assignment eligibility');
  });

  it('keeps each original procedure inline for an API provider', async () => {
    const prompt = await render(githubPrompt, 'api');
    expect(stagedSections()).toEqual([]);
    for (const [, body] of githubSections) expect(prompt).toContain(body);
  });

  it.each([
    ['rejects', () => Promise.reject(new Error('disk full'))],
    ['returns no path', () => Promise.resolve(null)],
  ])('keeps only the affected procedure inline when staging %s', async (_label, fail) => {
    vi.mocked(writeResolvedSlashdoBody).mockImplementation((name) => name === 'claim-linked-screen-github'
      ? fail() : Promise.resolve(stagedPath(name)));
    const prompt = await render(githubPrompt, 'cli');
    expect(stagedSections()).toEqual(githubSections);
    expect(prompt).not.toContain(stagedPath('claim-linked-screen-github'));
    expect(prompt).toContain(resolveRoot(buildClaimLinkedScreen('github')));
    expect(prompt).toContain(stagedPath('claim-ci-recovery-github'));
  });

  it('keeps edited procedures inline', async () => {
    const edited = githubPrompt.replace('Produce 2–8 slices', 'Produce 2–6 slices');
    const prompt = await render(edited, 'cli');
    expect(prompt).toContain('Produce 2–6 slices');
    expect(prompt).not.toContain('When Phase 1 lands on an epic');
    expect(stagedSections()).toEqual(githubSections.filter(([name]) => name !== 'claim-epic-github'));
  });

  it('defers advisory workflow scope instructions on file-tool hosts and keeps them inline on API hosts', async () => {
    const taskWithMissingScope = makeTask({
      description: 'Claim #42',
      metadata: {
        claimFlow: true,
        claimServerCheckout: true,
        prompt: githubPrompt,
        forgeWorkflowScope: { status: 'missing', remedy: 'gh auth refresh -h github.com -s workflow' },
      },
    });
    const cliPrompt = await buildAgentPrompt(taskWithMissingScope, {}, '/r', null,
      { providerType: 'cli', providerId: 'codex', providerCommand: 'codex', agentId: 'agent-1' });
    expect(cliPrompt).toContain(`READ \`${stagedPath('claim-workflow-scope')}\``);
    expect(cliPrompt).toContain('normal head-pinned merge or a confirmed permission-denial handoff');
    const stagedScope = vi.mocked(writeResolvedSlashdoBody).mock.calls.find(([name]) => name === 'claim-workflow-scope')?.[1];
    expect(stagedScope).toContain('one normal head-pinned merge attempt using the assigned credential');
    expect(stagedScope).not.toContain('skip every merge');
    expect(cliPrompt).not.toContain('## Claim ownership binding');
    expect(cliPrompt).toContain('do not call `/api/cos/claim-ownership` or `/api/cos/claim-selection`');

    vi.mocked(writeResolvedSlashdoBody).mockClear();
    const apiPrompt = await buildAgentPrompt(taskWithMissingScope, {}, '/r', null,
      { providerType: 'api', providerId: 'openai', agentId: 'agent-1' });
    expect(stagedSections()).toEqual([]);
    expect(apiPrompt).toContain('gh auth refresh -h github.com -s workflow');
    expect(apiPrompt).toContain('one normal head-pinned merge attempt using the assigned credential');
    expect(apiPrompt).toContain('If GitHub explicitly refuses the operation for missing workflow permission');
    expect(apiPrompt).not.toContain('skip every merge');
  });
});
