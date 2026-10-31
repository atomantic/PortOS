import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ tracker: 'github', prompts: {} }));
vi.mock('./taskSchedule.js', async (importActual) => ({
  ...(await importActual()),
  getTaskInterval: vi.fn(async (key) => ({ prompt: null, taskMetadata: {}, ...state.prompts[key] })),
}));
vi.mock('./apps.js', async (importActual) => ({
  ...(await importActual()),
  getAppTaskTypeOverrides: vi.fn(async () => ({})),
}));
vi.mock('../lib/workTracker.js', async (importActual) => ({
  ...(await importActual()),
  resolveAppWorkTracker: vi.fn(async () => ({ resolved: state.tracker, source: 'test' })),
}));
vi.mock('./codeReview.js', async (importActual) => ({
  ...(await importActual()),
  getCodeReviewDefaults: vi.fn(async () => ({ reviewers: ['codex'], usernames: ['alice'] })),
}));
vi.mock('./claimReviewerPreflight.js', () => ({ preflightClaimReviewers: vi.fn(async () => '') }));

import { buildClaimWorkTask } from './cosTaskClaimWork.js';
import { buildLightContextPrompt } from './agentPromptBuilder.js';
import { getTaskPrompt, DEFAULT_TASK_PROMPTS } from './taskPromptService.js';
import { buildImprovementTaskDescription } from './cosTaskPreStepBlocks.js';
import { preflightClaimReviewers } from './claimReviewerPreflight.js';

const app = { id: 'fixture', name: 'Fixture', repoPath: '/fixture' };
const issueContext = { number: 42, title: 'A target issue', body: 'User-visible issue body.\n'.repeat(400) };

const renderAgent = (claim, resume = false) => buildLightContextPrompt({
  id: 'task-fixture', description: 'Claim the selected issue',
  metadata: {
    ...claim.taskMetadata, prompt: claim.prompt,
    ...(resume ? { claimResumeInPlace: true, existingBranch: 'claim/issue-42',
      resumeWorktreePath: '/fixture/worktree', resumedFromAgentId: 'agent-prior' } : {}),
  },
}, '/fixture', resume ? { worktreePath: '/fixture/worktree', branchName: 'claim/issue-42' } : null,
{ isTui: true, providerId: 'codex-tui', providerCommand: 'codex', agentId: 'agent-fixture' });

beforeEach(() => { state.tracker = 'github'; state.prompts = {}; });

describe('assembled forge claim prompts', () => {
  it.each(['github', 'gitlab'])('pins the %s target before safety checks and preserves complete supplied content', async (tracker) => {
    state.tracker = tracker;
    const guidance = `Keep the full guidance. ${'x'.repeat(3900)}`;
    const claim = await buildClaimWorkTask(app, { target: '42', issueContext, overrideContext: guidance, prCompletion: 'merge-on-green' });
    const prompt = renderAgent(claim);
    expect(claim.prompt.indexOf('issue #42')).toBeLessThan(100);
    expect(claim.prompt.indexOf('Effective PR completion policy: merge-on-green')).toBeLessThan(200);
    expect(prompt).not.toContain('gh issue list --state open');
    expect(prompt).not.toContain('glab issue list --state opened');
    expect(prompt).not.toContain('YOU pick the issue');
    expect(prompt).not.toContain('return to Phase 1');
    expect(prompt).toContain(issueContext.body);
    expect(prompt).toContain(guidance);
    expect(prompt).toContain('sole exception');
    expect(prompt).toContain('Repeat these checks for an epic child');
    expect(prompt).toContain('Before assigning a contributor or decomposing an epic');
    expect(prompt.indexOf('Before assigning a contributor')).toBeLessThan(prompt.indexOf('git worktree add --no-track'));
    expect(prompt).toContain('Repeat the binding and require bound:true');
    expect(prompt).toContain('PortOS cleans up the managed worktree and branch automatically after completion');
    expect(prompt).not.toContain('branch-reconcile/checkouts/retire');
    expect(prompt).not.toContain('Run each LOCAL reviewer');
    expect(prompt).not.toContain('REVIEW_ATTEMPTED_HEAD=');
    expect(prompt).not.toContain('Required-review publication rule');
    expect(prompt).toContain('If this workflow actually runs local pre-PR reviewers');
    expect(prompt).toContain('self-review');
    if (tracker === 'github') {
      expect(prompt.indexOf('Before assigning a contributor')).toBeLessThan(prompt.indexOf('gh issue edit "${CANDIDATE}" --add-assignee'));
      expect(prompt).toContain('commits endpoints');
      expect(prompt).toContain('--match-head-commit');
    } else {
      expect(prompt).toContain('If no claimant exists, set `NUM="$CANDIDATE"`');
      expect(prompt).toContain('ME="$(glab api user | jq -er .username)"');
      expect(prompt.indexOf('ME="$(glab api user | jq -er .username)"')).toBeLessThan(prompt.indexOf('CLAIMANT=$(jq'));
    }
  });

  it.each(['review-then-merge', 'leave-open', 'draft'])('renders only the %s publication policy on a resumed claim', async (policy) => {
    const claim = await buildClaimWorkTask(app, { target: '42', prCompletion: policy });
    const prompt = renderAgent(claim, true);
    expect(prompt).toContain('Relaunch — finish the claim already started');
    expect(prompt).toContain(`Effective PR completion policy: ${policy === 'draft' ? 'draft (leave open)' : policy}`);
    expect(prompt).toContain('Run each LOCAL reviewer');
    expect(prompt).toContain('REVIEW_STATUS=review-blocked');
    if (policy === 'review-then-merge') {
      expect(prompt).toContain('--match-head-commit');
      expect(prompt).toContain('PortOS cleans up the managed worktree and branch automatically after completion');
      expect(prompt).not.toContain('branch-reconcile/checkouts/retire');
    } else {
      expect(prompt).toContain('leave the PR open for human handoff');
      expect(prompt).not.toContain('gh pr merge');
      expect(prompt).not.toContain('gh issue close');
      expect(prompt).not.toContain('PortOS cleans up the managed worktree and branch automatically after completion');
      expect(prompt).not.toContain('branch-reconcile/checkouts/retire');
      if (policy === 'draft') {
        expect(prompt).toContain('gh pr create --draft');
        expect(prompt).toContain('gh pr view --json isDraft');
      }
    }
  });

  it('creates and verifies a GitLab draft explicitly', async () => {
    state.tracker = 'gitlab';
    const claim = await buildClaimWorkTask(app, { target: '42', prCompletion: 'draft' });
    expect(claim.prompt).toContain('--yes --draft');
    expect(claim.prompt).toContain('glab mr view --output json');
    expect(claim.prompt).toContain('draft: true');
  });

  it.each(['review-then-merge', 'leave-open', 'draft'])('keeps the selected GitLab epic child and its %s handoff policy', async (policy) => {
    state.tracker = 'gitlab';
    const { prompt } = await buildClaimWorkTask(app, { target: '42', prCompletion: policy });
    const epic = prompt.slice(prompt.indexOf('## Phase 1b'), prompt.indexOf('## Phase 2'));
    expect(prompt).toContain('set `CANDIDATE="$NUM"` and repeat the permitted contributor-comment check for that final issue');
    expect(prompt).toContain('Resolve every accepted finding before proceeding, regardless of severity.');
    if (policy === 'review-then-merge') {
      expect(epic).toContain('close #${EPIC} when it was the LAST open child');
    } else {
      expect(epic).toContain('leave the epic open for human reconciliation');
      expect(epic).not.toContain('close #${EPIC} when it was the LAST open child');
    }
  });

  it.each(['github', 'gitlab'])('keeps automatic %s selection while applying its effective policy', async (tracker) => {
    state.tracker = tracker;
    const type = tracker === 'github' ? 'claim-issue' : 'claim-issue-gitlab';
    const template = await getTaskPrompt(type, { claimFlow: true, claimIssueOptions: { prCompletion: 'merge-on-green' } });
    const prompt = await buildImprovementTaskDescription({ promptTemplate: template, app, promptTaskType: type,
      metadata: { prCompletion: 'merge-on-green' }, blocks: {} });
    expect(prompt).toContain(tracker === 'github' ? 'gh issue list --state open' : 'glab issue list');
    expect(prompt).toContain('Effective PR completion policy: merge-on-green');
    expect(prompt).not.toContain('Run each LOCAL reviewer');
    expect(prompt).toContain('Before assigning a contributor or decomposing an epic');
    if (tracker === 'github') expect(prompt).toContain('5. Before assigning a contributor');
  });

  it('keeps a customized workflow intact while providing the resolved target and policy', async () => {
    const custom = 'CUSTOM START\n## Phase 1 — Pick the target issue\nDo the user-defined work.\nCUSTOM END';
    state.prompts['claim-issue'] = { prompt: custom, promptSource: 'user', promptCustomized: true };
    const claim = await buildClaimWorkTask(app, { target: '42', prCompletion: 'leave-open' });
    expect(claim.prompt).toContain(custom);
    expect(claim.prompt.indexOf('Effective PR completion policy: leave-open')).toBeLessThan(claim.prompt.indexOf(custom));
    expect(claim.prompt).toContain('Target Issue Constraint');
    expect(claim.prompt).not.toContain('## Before claim mutation');
    expect(renderAgent(claim)).toContain('If this workflow actually runs local pre-PR reviewers');
  });

  it.each(['github', 'gitlab'])('renders the configured %s reviewer budget and no hardcoded three-round cap', async (tracker) => {
    state.tracker = tracker;
    const { prompt } = await buildClaimWorkTask(app, {
      target: '42', prCompletion: 'review-then-merge', reviewers: ['codex'], optionalReviewers: ['codex'], reviewerMaxRounds: { codex: 2 },
    });
    expect(prompt).toContain('`codex` → 2 rounds');
    expect(prompt).not.toMatch(/capped at 3 rounds|after 3 rounds/);
    expect(prompt).toContain('never blocks opening');
  });

  it('keeps the target and policy first when optional reviewer preflight emits a notice', async () => {
    vi.mocked(preflightClaimReviewers).mockResolvedValueOnce('\n\n## Reviewer identity preflight\nOptional reviewer unavailable.\n');
    const claim = await buildClaimWorkTask(app, { target: '42', prCompletion: 'review-then-merge' });
    expect(claim.prompt.indexOf('issue #42')).toBeLessThan(100);
    expect(claim.prompt.indexOf('Effective PR completion policy: review-then-merge')).toBeLessThan(claim.prompt.indexOf('Reviewer identity preflight'));
  });

  it('preserves a custom claim-work prompt instead of composing a tracker default', async () => {
    const custom = 'USER WORKFLOW\n## Phase 1 — Pick the target issue\nKeep this exact text.';
    state.prompts['claim-work'] = { prompt: custom, promptSource: 'user', promptCustomized: true };
    const claim = await buildClaimWorkTask(app, { target: '42', prCompletion: 'merge-on-green' });
    expect(claim.prompt).toContain(custom);
    expect(claim.prompt).toContain('Effective PR completion policy: merge-on-green');
    expect(claim.prompt).toContain('Target Issue Constraint');
    expect(renderAgent(claim)).toContain('If this workflow actually runs local pre-PR reviewers');
  });

  it('fetches the full issue when a direct claim snapshot is oversized', async () => {
    const body = `${'x'.repeat(12_001)}ACCEPTANCE_CRITERION_AT_TAIL`;
    const claim = await buildClaimWorkTask(app, { target: '42', issueContext: { ...issueContext, body } });
    expect(claim.prompt).toContain('Fetch the full live title and body of issue #42');
    expect(claim.prompt).not.toContain('## Prefetched Issue Context');
    expect(claim.prompt).not.toContain('ACCEPTANCE_CRITERION_AT_TAIL');
  });

  it('rejects oversized direct claim guidance instead of constructing a partial prompt', async () => {
    await expect(buildClaimWorkTask(app, { target: '42', overrideContext: 'x'.repeat(4_001) }))
      .rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
  });

  it('does not recompose an explicitly user-pinned body even if it equals the shipped default', async () => {
    state.prompts['claim-issue'] = { prompt: DEFAULT_TASK_PROMPTS['claim-issue'], promptSource: 'user', promptCustomized: true };
    const result = await getTaskPrompt('claim-issue', { claimFlow: true, withSource: true,
      claimIssueOptions: { target: '42', prCompletion: 'merge-on-green' } });
    expect(result.composed).toBe(false);
    expect(result.prompt).toContain('## Phase 1 — Pick the target issue');
    expect(result.prompt).toContain('Run each LOCAL reviewer');
  });
});
