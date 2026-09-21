import { describe, expect, it } from 'vitest';
import { COMPLETION_MODES } from '../../lib/agentCompletionMode.js';
import { PR_COMPLETIONS } from '../../lib/prDisposition.js';
import { buildTuiCompletionSection } from './completion.js';

const render = (forgeCli = 'gh', reviewers = ['copilot']) => buildTuiCompletionSection({
  willOpenPR: true,
  prCompletion: PR_COMPLETIONS.REVIEW_THEN_MERGE,
  simplifyEnabled: false,
  sentinelPath: '/tmp/example-agent-done',
  mode: COMPLETION_MODES.TUI,
  reviewers,
  forgeCli,
});

describe('review-enabled completion merge gate', () => {
  it('waits for current-head CI and re-runs review after a changed head', () => {
    const section = render();

    expect(section).toContain('4. **Wait for CI to finish**');
    expect(section).toContain('gh pr checks "<PR_URL>" --watch --fail-fast --interval 30');
    expect(section).toContain('repeat the configured review loop for `copilot` against the new HEAD');
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
