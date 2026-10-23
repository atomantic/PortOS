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
    expect(section).toContain('8. Write a short markdown summary');
  });

  it('retains immediate merging for a registered claim requiring local admission', () => {
    const section = buildClaimFlowCompletionSection({ agentId: 'parent-example' });
    expect(section).toContain('Local admission forbids GitHub deferred auto-merge');
    expect(section).toContain('confirm MERGED, then release');
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
    for (const prStaysOpen of [false, true]) {
      const prompt = buildClaimFlowCompletionSection({ agentId: 'parent-example', prStaysOpen });
      expect(prompt).toContain('"agentId":"parent-example","action":"bind","branch":"BRANCH"');
      expect(prompt).toContain('a tracking epic');
      expect(prompt).toContain('do not create or enter that worktree');
      expect(prompt).toContain('"action":"release"');
    }
    expect(buildClaimFlowCompletionSection()).toContain('possibly yours until this run ends');
  });
});

describe('claim parent merge admission instructions', () => {
  it('acquires only after green CI, merges a CLEAN head pinned and resyncs outside the lease', () => {
    const prompt = buildClaimFlowCompletionSection({ agentId: 'parent-example' });
    expect(prompt).toContain('"agentId":"parent-example","action":"acquire"');
    expect(prompt).toContain('action:"check"');
    expect(prompt).toContain('"action":"release"');
    expect(prompt).toContain('Authorization: Bearer');
    expect(prompt).toContain('never a fan-out child');
    // Ordering: CI-verified head → acquire → final PR re-read → pinned merge.
    const order = ['WITHOUT admission', 'Once required CI is green', '"action":"acquire"', 'Inside the lease, re-read the PR', 'then merge pinned to the CI-verified head'];
    const positions = order.map((marker) => prompt.indexOf(marker));
    expect(positions.every((at) => at >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((x, y) => x - y));
    expect(prompt).toContain('does NOT require a resync or fresh CI');
    expect(prompt).toContain('node scripts/pregate.js --guards-only --merged-with origin/<default>');
    expect(prompt).toContain('single-issue claims and each swarm Phase C merge');
    expect(prompt).toContain('if either differs from the guard inputs');
    expect(prompt).toContain('release with outcome resync');
    expect(prompt).toContain('OUTSIDE the lease');
    expect(prompt).toContain('at most 10 minutes');
    expect(prompt).toContain('lease-expired');
    expect(prompt).toContain('overrides mandatory base-sync instructions in delegated slashdo workflows');
    expect(prompt).toContain('outcome leave-open');
    expect(prompt).toContain('never permission to proceed');
    expect(prompt).not.toMatch(/BEFORE the final base sync/i);
    expect(prompt).not.toMatch(/Keep admission through[^.]*CI/i);
    expect(prompt).not.toContain('if it moved, sync again');
    expect(buildClaimFlowCompletionSection()).toContain('do not merge');
    expect(buildClaimFlowCompletionSection({ agentId: 'parent-example', prStaysOpen: true })).not.toContain('/merge-admission');
  });
});

describe('pending-merge handoff instructions (#12247)', () => {
  it('offers the server handoff before the CI wait and stops on a receipt without merging', () => {
    const prompt = buildClaimFlowCompletionSection({ agentId: 'parent-example' });
    expect(prompt).toContain('/api/cos/merge-handoff');
    expect(prompt).toContain('"agentId":"parent-example","prUrl":"PR_URL","headSha":"HEAD_SHA","worktreePath":"WORKTREE_PATH"');
    expect(prompt.indexOf('/api/cos/merge-handoff')).toBeLessThan(prompt.indexOf('Once required CI is green'));
    expect(prompt).toContain('NOT yet merged');
    expect(prompt).toContain('A refusal never permits merging without admission');
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
