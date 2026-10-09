import { describe, expect, it } from 'vitest';
import { COMPLETION_MODES } from '../../lib/agentCompletionMode.js';
import { PR_COMPLETIONS } from '../../lib/prDisposition.js';
import { resolveReviewPolicy } from '../../lib/reviewerConfig.js';
import { buildTuiCompletionSection, buildClaimFlowCompletionSection } from './completion.js';

const render = (forgeCli = 'gh', reviewers = ['copilot']) => buildTuiCompletionSection({
  willOpenPR: true,
  prCompletion: PR_COMPLETIONS.REVIEW_THEN_MERGE,
  simplifyEnabled: false,
  sentinelPath: '/tmp/example-agent-done',
  mode: COMPLETION_MODES.TUI,
  reviewPolicy: resolveReviewPolicy({ reviewers }, null, null),
  forgeCli,
});

describe('review-enabled completion merge gate', () => {
  it('waits for current-head CI and re-runs review after a changed head', () => {
    const section = render();

    expect(section).toContain('4. **Wait for CI to finish**');
    expect(section).toContain('gh pr checks "<PR_URL>" --watch --fail-fast --interval 30');
    expect(section).toContain('repeat the configured review loop for `copilot` against the new HEAD');
    expect(section).toContain('Base movement alone does not require rebasing or restarting CI');
    expect(section).toContain('gh pr merge "<PR_URL>" --merge --delete-branch');
    expect(section.indexOf('4. **Wait for CI to finish**')).toBeLessThan(section.indexOf('gh pr merge'));
    expect(section).toContain('8. Write a short markdown summary');
  });

  it('uses GitLab CI and merge commands when the completion forge is GitLab', () => {
    const section = render('glab');

    expect(section).toContain('4. **Wait for CI to finish**: `glab ci status`');
    expect(section).toContain('glab mr merge <MR_NUMBER> --yes --remove-source-branch');
    expect(section).not.toContain('gh pr merge');
  });

  it('keeps required local-review state fail-closed before CI or merge', () => {
    const section = render('gh', ['codex']);

    expect(section).toContain('**Required local-review merge gate:**');
    expect(section).toContain('If `LOCAL_OVERALL_STATUS=review-blocked`, do NOT run this merge path');
  });
});


describe('claim ownership binding instructions (#10089)', () => {
  it('binds every branch the run checks out before its worktree exists, whatever the completion policy', () => {
    for (const leavePrOpen of [false, true]) {
      const prompt = buildClaimFlowCompletionSection({ agentId: 'parent-example', leavePrOpen });
      expect(prompt).toContain('"agentId":"parent-example","action":"bind","branch":"BRANCH"');
      expect(prompt).toContain('a tracking epic');
      expect(prompt).toContain('do not create or enter that worktree');
      expect(prompt).toContain('"action":"release"');
    }
    expect(buildClaimFlowCompletionSection()).toContain('possibly yours until this run ends');
  });
});

describe('claim parent merge admission instructions', () => {
  it('keeps CI concurrent and holds parent admission only for the merge attempt and readback', () => {
    const prompt = buildClaimFlowCompletionSection({ agentId: 'parent-example' });
    expect(prompt).toContain('"agentId":"parent-example","action":"acquire"');
    expect(prompt).toContain('"action":"check"');
    expect(prompt).toContain('"action":"release"');
    expect(prompt).toContain('Authorization: Bearer');
    expect(prompt).toContain('never a fan-out child');
    expect(prompt).toContain('at most 30 minutes');
    expect(prompt).toContain('current-head CI BEFORE acquiring admission');
    expect(prompt).toContain('Base movement alone does not require a rebase or another CI run');
    expect(prompt).toContain('first release with outcome leave-open');
    expect(prompt).toContain('rerun affected validation and required reviews/checks on the resulting head');
    expect(prompt).not.toContain('if it moved, sync again');
    expect(prompt).toContain('outcome leave-open');
    expect(prompt).toContain('never permission to proceed');
    expect(buildClaimFlowCompletionSection()).toContain('do not merge');
    expect(buildClaimFlowCompletionSection({ agentId: 'parent-example', leavePrOpen: true })).not.toContain('/merge-admission');
  });
});
