import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMPLETION_MODES } from '../../lib/agent/agentCompletionMode.js';
import { PR_COMPLETIONS } from '../../lib/prDisposition.js';
import { resolveReviewPolicy } from '../../lib/reviewerConfig.js';
import { buildTuiCompletionSection, buildClaimFlowCompletionSection, buildMergeAdmissionSection } from './completion.js';

const render = (forgeCli = 'gh', reviewers = ['copilot'], extra = {}) => buildTuiCompletionSection({
  willOpenPR: true,
  prCompletion: PR_COMPLETIONS.REVIEW_THEN_MERGE,
  simplifyEnabled: false,
  sentinelPath: '/tmp/example-agent-done',
  mode: COMPLETION_MODES.TUI,
  reviewPolicy: resolveReviewPolicy({ reviewers }, null, null),
  forgeCli,
  ...extra,
});

describe('review-enabled completion merge gate', () => {
  it('gives unpinned pickers a selection transport before any claim mutation', () => {
    const section = buildClaimFlowCompletionSection({ agentId: 'example-picker' });
    expect(section).toContain('/api/cos/claim-selection');
    expect(section).toContain('"agentId":"example-picker","issueNumber":123');
    expect(section.indexOf('/api/cos/claim-selection')).toBeLessThan(section.indexOf('/api/cos/claim-ownership'));
    expect(section).toContain('recorded:true');
    expect(section).toContain('Bound child claims always take precedence');
    // A picker that parked its only candidate itself must still record it, or
    // the verifier has no selected issue and the task burns its retry budget.
    expect(section).toContain('an issue this run parked itself with `blocked` or `needs-input`');
    expect(section).toContain('`Blocked by #N` line');
  });

  it('distinguishes an operator-parked claim attempt from resolving the open issue', () => {
    const section = render();
    expect(section).toContain('Use no-action-needed for this verified stand-down, not blocked');
    expect(section).toContain('An operator-parked issue stays open for its documented unblock condition');
    expect(section).toContain('clean checkout fully contained in the live default branch');
  });

  it('keeps merged checkouts bound for completion cleanup unless another owner takes over', () => {
    const section = buildClaimFlowCompletionSection({ agentId: 'example-picker' });
    expect(section).toContain('Keep a merged branch bound if you are leaving its checkout for PortOS to clean up at completion.');
    expect(section).toContain('`checkout-present` is expected and needs no retry.');
    expect(section).toContain('Use `handoff: true` only when another owner is taking over the branch');
    expect(section).toContain('"action":"release","branch":"BRANCH","handoff":true');
  });

  it('waits for current-head CI and re-runs review after a changed head', () => {
    const section = render('gh', ['copilot'], { mergeHandoff: true });

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

// The completion section is the last thing a claim agent reads; when it let a
// merged slice end the run, multi-PR issues advanced one PR per manual launch.
describe('multi-slice claim completion', () => {
  it('keeps a merging claim working past its first merged slice', () => {
    const merging = buildClaimFlowCompletionSection({ agentId: 'parent-example', isTui: true, sentinelPath: '/tmp/example.json' });
    expect(merging).toContain('A merged slice is not the end of the claim');
    expect(merging).toContain('never to leave remaining scope for a later run');
    expect(merging).toContain('every PR or MR URL this run shipped');
    expect(buildClaimFlowCompletionSection({ agentId: 'parent-example', prStaysOpen: true }))
      .not.toContain('A merged slice is not the end of the claim');
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
    const prompt = buildClaimFlowCompletionSection({ agentId: 'parent-example', mergeHandoff: true });
    expect(prompt).toContain('/api/cos/merge-handoff');
    expect(prompt).toContain('"agentId":"parent-example","prUrl":"PR_URL","headSha":"HEAD_SHA","worktreePath":"WORKTREE_PATH"');
    expect(prompt.indexOf('/api/cos/merge-handoff')).toBeLessThan(prompt.indexOf('## Hosting-provider merge authority'));
    expect(prompt).toContain('NOT yet merged');
    expect(prompt).toContain('A refused optional handoff does not create an additional merge requirement');
    expect(buildClaimFlowCompletionSection({ agentId: 'parent-example', mergeHandoff: true, prStaysOpen: true })).not.toContain('/merge-handoff');
  });

  it('omits every pending-merge handoff instruction when the app sets no threshold', () => {
    const forbidden = ['/api/cos/merge-handoff', 'mergeHandoffMinQueuedRuns', 'pending-merge handoff', 'REVIEW_ATTEMPTED_HEAD'];
    const claim = buildClaimFlowCompletionSection({ agentId: 'parent-example' });
    const tui = render('gh', ['copilot']);
    for (const text of [claim, tui]) {
      for (const needle of forbidden) expect(text).not.toContain(needle);
    }
    // Merge authority and the in-session CI gate are unaffected.
    expect(claim).toContain('## Hosting-provider merge authority');
    expect(claim).toContain('By default stay responsible');
    expect(tui).toContain('Wait for CI to finish');
  });

  it.skipIf(process.platform === 'win32')('records optional inconclusive evidence only for the attempted head and preserves blocked evidence', () => {
    const prompt = buildClaimFlowCompletionSection({ agentId: 'parent-example', mergeHandoff: true });
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
    const prompt = buildClaimFlowCompletionSection({ agentId: 'parent-example', mergeHandoff: true });
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

describe('claim flow Use auto-merge', () => {
  it('enables GitHub auto-merge after reviews only when the claim merges its own PR', () => {
    const merging = buildClaimFlowCompletionSection({ agentId: 'example-claim', autoMerge: true });
    expect(merging).toContain('## Use auto-merge');
    expect(merging).toContain('Keep watching CI on that head until the PR reports MERGED');
    expect(buildClaimFlowCompletionSection({ agentId: 'example-claim' })).not.toContain('## Use auto-merge');
    expect(buildClaimFlowCompletionSection({ agentId: 'example-claim', autoMerge: true, prStaysOpen: true })).not.toContain('## Use auto-merge');
  });
});

describe('claim flow workflow-scope handoff', () => {
  it('treats a missing scope as advisory and hands off only a confirmed permission denial', () => {
    const missing = buildClaimFlowCompletionSection({ rawPrCompletion: 'merge-on-green', workflowScope: { status: 'missing', remedy: 'gh auth refresh -h github.com -s workflow' } });
    expect(missing).toContain('lacks the `workflow` scope');
    expect(missing).toContain('gh auth refresh -h github.com -s workflow');
    expect(missing).toContain('status "blocked"');
    expect(missing).toContain('"mode":"approval"');
    expect(missing).toContain('This is a warning, not a merge refusal.');
    expect(missing).toContain('After the configured review and required CI gates pass');
    expect(missing).toContain('one normal head-pinned merge attempt using the assigned credential');
    expect(missing).toContain('If GitHub explicitly refuses the operation for missing workflow permission');
    expect(missing).toContain('A generic branch-policy or merge conflict error is not proof');
    expect(missing).toContain('Only a confirmed merge for this exact PR and head');
    expect(missing).toContain('Never refresh credentials or retry a denied merge yourself.');
    expect(missing).not.toContain('skip every merge');
    for (const status of ['granted', 'unknown']) {
      expect(buildClaimFlowCompletionSection({ rawPrCompletion: 'merge-on-green', workflowScope: { status } })).not.toContain('lacks the `workflow` scope');
    }
  });

  it('does not offer a merge attempt when the claim policy leaves the PR open', () => {
    const prompt = buildClaimFlowCompletionSection({
      prStaysOpen: true,
      workflowScope: { status: 'missing', remedy: 'gh auth refresh -h github.com -s workflow' },
    });
    expect(prompt).toContain('PR completion policy: LEAVE OPEN');
    expect(prompt).not.toContain('one normal head-pinned merge attempt');
  });

  it('defers the advisory workflow-scope note behind a staged pointer when provided', () => {
    const staged = buildClaimFlowCompletionSection({
      rawPrCompletion: 'merge-on-green',
      workflowScope: { status: 'missing', remedy: 'gh auth refresh -h github.com -s workflow' },
      workflowScopeStagedPath: '/install/data/cos/slashdo-resolved/claim-workflow-scope-abc.md',
    });
    expect(staged).toContain('READ `/install/data/cos/slashdo-resolved/claim-workflow-scope-abc.md`');
    expect(staged).toContain('normal head-pinned merge or a confirmed permission-denial handoff');
    expect(staged).not.toContain('Never refresh credentials or retry a denied merge yourself.');
  });

  it('replaces the full claim ownership binding block with a concise note for server-provisioned checkouts', () => {
    const provisioned = buildClaimFlowCompletionSection({ agentId: 'agent-1', serverCheckout: true });
    expect(provisioned).toContain('## Claim ownership');
    expect(provisioned).toContain('do not call `/api/cos/claim-ownership` or `/api/cos/claim-selection`');
    expect(provisioned).not.toContain('## Claim ownership binding');
    expect(provisioned).not.toContain('curl -sS -X POST');
  });
});

describe('publish_reviewed_branch tag scope', () => {
  // The wrapper lives in a manual-completion template literal list; read the shipped line from source.
  const wrapper = readFileSync(new URL('./completion.js', import.meta.url), 'utf8').split('\n').find(line => line.includes('publish_reviewed_branch() {')).trim().replace(/^'/, '').replace(/',$/, '');
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'portos-publish-'));
    const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
    const remote = join(root, 'remote.git');
    const work = join(root, 'work');
    execFileSync('git', ['init', '--bare', '-q', remote]);
    execFileSync('git', ['init', '-q', '-b', 'feature', work]);
    git(work, 'config', 'push.followTags', 'true');
    writeFileSync(join(work, 'a.txt'), '1');
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'one');
    git(work, 'tag', '-a', 'unrelated-tag', '-m', 'tag');
    git(work, 'remote', 'add', 'origin', remote);
    return { root, work, remote, git };
  };
  const publish = (work, ...args) => execFileSync('bash', ['-c', `${wrapper}\nPUBLISH_ERROR=failed\npublish_reviewed_branch ${args.join(' ')}`], { cwd: work, encoding: 'utf8', stdio: 'pipe' });

  it('publishes only the branch despite ambient push.followTags=true', () => {
    const { root, work, remote, git } = setup();
    try {
      publish(work, 'origin', 'HEAD:refs/heads/feature');
      expect(git(remote, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/feature');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('still fails when the branch update itself is rejected', () => {
    const { root, work, remote, git } = setup();
    try {
      publish(work, 'origin', 'HEAD:refs/heads/feature');
      git(work, 'reset', '-q', '--hard', 'HEAD');
      writeFileSync(join(work, 'b.txt'), '2');
      git(work, 'add', '.');
      git(work, 'commit', '-qm', 'two');
      const diverged = git(work, 'rev-parse', 'HEAD');
      git(work, 'reset', '-q', '--hard', 'HEAD~1');
      writeFileSync(join(work, 'c.txt'), '3');
      git(work, 'add', '.');
      git(work, 'commit', '-qm', 'three');
      git(work, 'push', '-q', 'origin', `${diverged}:refs/heads/feature`);
      expect(() => publish(work, 'origin', 'HEAD:refs/heads/feature')).toThrow();
      expect(git(remote, 'rev-parse', 'feature')).toBe(diverged);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('code-owner-blocked merge options', () => {
  const base = buildMergeAdmissionSection('agent-1');

  it('adds nothing unless the task or app opted in', () => {
    expect(buildMergeAdmissionSection('agent-1', { autoApprove: false, adminMerge: false })).toBe(base);
    expect(base).not.toContain('--admin');
    expect(base).not.toContain('--approve');
  });

  it('auto-approve alone never mentions the admin override', () => {
    const out = buildMergeAdmissionSection('agent-1', { autoApprove: true });
    expect(out).toContain('gh pr review "<PR_URL>" --approve');
    expect(out).not.toContain('--admin');
  });

  it('admin merge is gated on green CI for the pinned head and review being the only blocker', () => {
    const out = buildMergeAdmissionSection('agent-1', { adminMerge: true });
    expect(out).toContain('--admin --merge --match-head-commit <verified-head>');
    expect(out).toContain('REVIEW_REQUIRED');
    expect(out).toMatch(/never use it while any required check is failing or pending/i);
    expect(out).not.toContain('--approve');
  });

  it('reaches the claim-flow merge section', () => {
    const out = buildClaimFlowCompletionSection({ agentId: 'agent-1', adminMerge: true, autoApprove: true });
    expect(out).toContain('--admin --merge');
    expect(out).toContain('--approve');
  });
});
