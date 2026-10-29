import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  it('distinguishes an operator-parked claim attempt from resolving the open issue', () => {
    const section = render();
    expect(section).toContain('Use no-action-needed for this verified stand-down, not blocked');
    expect(section).toContain('An operator-parked issue stays open for its documented unblock condition');
    expect(section).toContain('clean checkout fully contained in the live default branch');
  });

  it('waits for current-head CI and re-runs review after a changed head', () => {
    const section = render();

    expect(section).toContain('4. **Wait for CI to finish**');
    expect(section).not.toContain('portos_check_merge_admission');
    expect(section).toContain('gh pr checks "<PR_URL>" --watch --fail-fast --interval 30');
    expect(section).toContain('repeat the configured review loop for `copilot` against the new HEAD');
    expect(section).toContain('gh pr merge "<PR_URL>" --merge --match-head-commit <verified-head>');
    expect(section).toContain('By default stay responsible');
    expect(section).toContain('mergeHandoffMinQueuedRuns');
    expect(section).toContain('Unknown backlog, refused handoff');
    expect(section).not.toContain('--auto --merge');
    expect(section).toContain('8. Write the structured completion JSON envelope');
  });

  it('keeps local review completed across CI fixes while hosted review stays current-head', () => {
    const section = render('gh', ['codex', 'copilot']);
    expect(section).toContain('feedback or CI commits do not restart a completed local phase');
    expect(section).toContain('repeat the configured review loop for `copilot` against the new HEAD');
    expect(section).not.toContain('repeat the pre-PR local review phase');
    expect(section).toContain('local-review-lifecycle.mjs');
    const claim = buildClaimFlowCompletionSection({ reviewersCsv: 'codex', agentId: 'parent' });
    expect(claim).toContain('One-time local review lifecycle');
    expect(claim).toContain('Keep each successful reviewer');
  });

  it('executes publication guards against legacy and distinct-inspection completion receipts', () => {
    const section = buildTuiCompletionSection({ willOpenPR: true, simplifyEnabled: false, mode: COMPLETION_MODES.TUI_SLASHDO_FREE,
      rendersInlinePrLifecycle: true, localReviewSection: 'Local review', branchName: 'delivery', baseBranch: 'main',
      reviewPolicy: resolveReviewPolicy({ reviewers: ['codex'] }, null, null) });
    const command = section.split('\n').find(line => line.includes('LOCAL_REMEDIATED_HEAD_SHA=$(node'));
    const cwd = mkdtempSync(join(tmpdir(), 'publication-head-'));
    const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    try {
      git('init', '-q', '-b', 'delivery');
      git('remote', 'add', 'origin', 'https://example.com/repo.git');
      const commit = () => git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'change');
      commit();
      const inspectedHead = git('rev-parse', 'HEAD');
      commit();
      const completedHead = git('rev-parse', 'HEAD');
      const receiptPath = join(cwd, '.git/portos-local-review-lifecycle');
      for (const revision of [{ version: 1, reviewedHead: completedHead },
        { version: 2, completedHead, reviewedHead: inspectedHead, inspectionProvenance: 'recorded' }]) {
        const receipt = { ...revision, branch: 'delivery', origin: 'https://example.com/repo.git', base: 'main', status: 'partial', prUrl: '' };
        writeFileSync(receiptPath, JSON.stringify(receipt));
        const env = { ...process.env, LOCAL_OVERALL_STATUS: 'partial' };
        expect(execFileSync('bash', ['-c', command + '\nprintf %s "$LOCAL_REMEDIATED_HEAD_SHA"'], { cwd, env, encoding: 'utf8' })).toBe(completedHead);
        expect(JSON.parse(readFileSync(receiptPath, 'utf8'))).toEqual(receipt);
        writeFileSync(receiptPath, JSON.stringify({ ...receipt, branch: 'other-delivery' }));
        expect(() => execFileSync('bash', ['-c', command], { cwd, env, stdio: 'pipe' })).toThrow();
      }
    } finally { rmSync(cwd, { recursive: true, force: true }); }
    expect(section).not.toContain('if [ "$LOCAL_REVIEWED_HEAD_SHA" != "$CURRENT_HEAD_SHA" ]');
  });

  it('allows provider auto-merge while retaining responsibility until confirmed delivery', () => {
    const section = buildClaimFlowCompletionSection({ agentId: 'parent-example' });
    expect(section).toContain('Native provider auto-merge is allowed when the API accepts it');
    expect(section).toContain('Enabled/queued is pending, not MERGED');
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
    expect(section).toContain('A recorded `LOCAL_OVERALL_STATUS=review-blocked` or unresolved accepted finding still blocks merge');
  });
});


describe('claim ownership binding instructions (#10089)', () => {
  it('binds every branch the run checks out before its worktree exists, whatever the completion policy', () => {
    for (const prStaysOpen of [false, true]) {
      const prompt = buildClaimFlowCompletionSection({ agentId: 'parent-example', prStaysOpen });
      expect(prompt).toContain('"agentId":"parent-example","action":"bind","branch":"BRANCH"');
      expect(prompt).toContain('a tracking epic');
      expect(prompt).toContain('Immediately after creating that worktree, repeat the same bind command');
      expect(prompt).toContain('BEFORE editing or running work there');
      expect(prompt).toContain('do not create or enter that worktree');
      expect(prompt).toContain('"action":"release"');
    }
    expect(buildClaimFlowCompletionSection()).toContain('possibly yours until this run ends');
  });
});

describe('hosting-provider merge instructions', () => {
  it('keeps assigned scope and provider authority without a second admission ceremony', () => {
    const prompt = buildClaimFlowCompletionSection({ agentId: 'parent-example' });
    expect(prompt).toContain('This run is parent-example');
    expect(prompt).toContain('exact repository/PR assigned to this task');
    expect(prompt).toContain('--match-head-commit');
    expect(prompt).toContain('API errors or unreadable state never establish success');
    expect(prompt).toContain('Do not rebase, push, repeat CI or restart review merely because the base advanced');
    expect(prompt).not.toContain('/api/cos/merge-admission');
    expect(prompt).not.toContain('portos_check_merge_admission');
    expect(prompt).not.toContain('--guards-only --merged-with');
    expect(buildClaimFlowCompletionSection({ prStaysOpen: true })).not.toContain('## Hosting-provider merge authority');
  });
});

describe('pending-merge handoff instructions (#12247)', () => {
  it('offers the server handoff before the CI wait and stops on a receipt without merging', () => {
    const prompt = buildClaimFlowCompletionSection({ agentId: 'parent-example' });
    expect(prompt).toContain('/api/cos/merge-handoff');
    expect(prompt).toContain('"agentId":"parent-example","prUrl":"PR_URL","headSha":"HEAD_SHA","worktreePath":"WORKTREE_PATH"');
    expect(prompt.indexOf('/api/cos/merge-handoff')).toBeLessThan(prompt.indexOf('## Hosting-provider merge authority'));
    expect(prompt).toContain('NOT yet merged');
    expect(prompt).toContain('A refused optional handoff does not create an additional merge requirement');
    expect(buildClaimFlowCompletionSection({ agentId: 'parent-example', prStaysOpen: true })).not.toContain('/merge-handoff');
  });

  it.skipIf(process.platform === 'win32')('records optional inconclusive evidence only for the attempted head and preserves blocked evidence', () => {
    const prompt = buildClaimFlowCompletionSection({ agentId: 'parent-example' });
    expect(prompt).toContain('before each local review attempt capture `REVIEW_ATTEMPTED_HEAD=$(git rev-parse HEAD)`');
    expect(prompt).toContain('nonempty all-optional roster');
    expect(prompt).toContain('accepted unresolved findings or rejection');
    const command = prompt.split('\n').find((line) => line.includes('printf "REVIEW_STATUS=optional-inconclusive'));
    const repo = mkdtempSync(join(tmpdir(), 'optional-review-head-'));
    try {
      const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
      git('init', '-q');
      git('-c', 'user.name=Example', '-c', 'user.email=example@example.com', 'commit', '-q', '--allow-empty', '-m', 'example');
      const head = git('rev-parse', 'HEAD');
      const statusFile = join(repo, git('rev-parse', '--git-path', 'portos-review-status'));
      const run = (attempted) => execFileSync('sh', ['-c', command], { cwd: repo, env: { ...process.env, REVIEW_ATTEMPTED_HEAD: attempted } });
      for (const blocked of ['review-blocked', 'findings', 'pending']) {
        writeFileSync(statusFile, `REVIEW_STATUS=${blocked}\n`);
        expect(() => run(head)).toThrow();
        expect(readFileSync(statusFile, 'utf8')).toBe(`REVIEW_STATUS=${blocked}\n`);
      }
      writeFileSync(statusFile, 'REVIEW_STATUS=clean\n');
      expect(() => run('f'.repeat(40))).toThrow();
      expect(readFileSync(statusFile, 'utf8')).toBe('REVIEW_STATUS=clean\n');
      run(head);
      expect(readFileSync(statusFile, 'utf8')).toBe(`REVIEW_STATUS=optional-inconclusive\nREVIEW_HEAD=${head}\n`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // The recorded line must be the one shape cosMergeHandoff reads: REVIEW_STATUS
  // kept, exactly one REVIEW_HEAD naming the reviewed commit.
  it.skipIf(process.platform === 'win32')('records exactly one REVIEW_HEAD for the reviewed commit beside REVIEW_STATUS', () => {
    const prompt = buildClaimFlowCompletionSection({ agentId: 'parent-example' });
    const command = prompt.split('\n').find((line) => line.includes('REVIEW_HEAD=%s'));
    const repo = mkdtempSync(join(tmpdir(), 'review-head-'));
    try {
      const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
      git('init', '-q');
      git('-c', 'user.name=Example', '-c', 'user.email=example@example.com', 'commit', '-q', '--allow-empty', '-m', 'example');
      const statusFile = join(repo, git('rev-parse', '--git-path', 'portos-review-status'));
      // No reviewers ran: the record must not invent a status file the server would read as unreadable.
      execFileSync('sh', ['-c', command], { cwd: repo });
      expect(existsSync(statusFile)).toBe(false);
      writeFileSync(statusFile, `REVIEW_STATUS=clean\nREVIEW_HEAD=${'f'.repeat(40)}\n`);
      execFileSync('sh', ['-c', command], { cwd: repo });
      expect(readFileSync(statusFile, 'utf8')).toBe(`REVIEW_STATUS=clean\nREVIEW_HEAD=${git('rev-parse', 'HEAD')}\n`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
