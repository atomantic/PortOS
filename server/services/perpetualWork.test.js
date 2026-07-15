import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('./cosEvents.js', () => ({
  cosEvents: { emit: vi.fn() },
  emitLog: vi.fn()
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from 'child_process';
import {
  isActionableIssue,
  issueNumberFromRef,
  detectActionableWork,
  detectGithubIssues,
  detectGitlabIssues,
  registerWorkDetector,
  getWorkDetector,
  hasWorkDetector,
  NON_ACTIONABLE_ISSUE_LABELS
} from './perpetualWork.js';

// A fake child process that emits canned stdout then closes — enough for the
// best-effort runCli() in perpetualWork.js (stdout/close/error + kill).
function fakeChild(stdout, code = 0) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', code);
  });
  return child;
}

// Route spawn calls to canned output by command + first arg.
function routeSpawn(routes) {
  spawn.mockImplementation((cmd, args = []) => {
    const key = `${cmd} ${args[0] || ''}`;
    const r = routes[key];
    return fakeChild(r?.stdout ?? '', r?.code ?? 0);
  });
}

describe('perpetualWork', () => {
  describe('isActionableIssue', () => {
    const base = { number: 7, title: 'Fix the thing', assignees: [], labels: [] };

    it('accepts a plain open unassigned issue', () => {
      expect(isActionableIssue(base)).toBe(true);
    });

    it('rejects an assigned issue', () => {
      expect(isActionableIssue({ ...base, assignees: [{ login: 'someone' }] })).toBe(false);
    });

    it('rejects an in-flight issue number', () => {
      expect(isActionableIssue(base, new Set([7]))).toBe(false);
    });

    it.each([...NON_ACTIONABLE_ISSUE_LABELS])('rejects a %s-labelled issue', (label) => {
      expect(isActionableIssue({ ...base, labels: [{ name: label }] })).toBe(false);
    });

    it('treats the needs-input park label as non-actionable (drain convergence)', () => {
      expect(isActionableIssue({ ...base, labels: [{ name: 'needs-input' }] })).toBe(false);
    });

    it('rejects an epic by label or by "(epic)" title', () => {
      expect(isActionableIssue({ ...base, labels: [{ name: 'epic' }] })).toBe(false);
      expect(isActionableIssue({ ...base, title: 'Big rollup (epic)' })).toBe(false);
    });

    it('accepts a plan-labelled issue (plan is the claimable queue, not a skip)', () => {
      expect(isActionableIssue({ ...base, labels: [{ name: 'plan' }] })).toBe(true);
    });

    it('handles string labels as well as objects', () => {
      expect(isActionableIssue({ ...base, labels: ['blocked'] })).toBe(false);
    });

    it('rejects malformed issues', () => {
      expect(isActionableIssue(null)).toBe(false);
      expect(isActionableIssue({ title: 'no number' })).toBe(false);
    });
  });

  describe('issueNumberFromRef', () => {
    it('extracts from a claim/issue-<num> ref', () => {
      expect(issueNumberFromRef('claim/issue-123')).toBe(123);
      expect(issueNumberFromRef('origin/claim/issue-99')).toBe(99);
    });

    it('extracts from a cos/<task>/issue-<num>/<agent> ref', () => {
      expect(issueNumberFromRef('cos/claim-issue/issue-45/agent-x')).toBe(45);
    });

    it('returns null for non-claim refs', () => {
      expect(issueNumberFromRef('feature/foo')).toBe(null);
      expect(issueNumberFromRef('main')).toBe(null);
      expect(issueNumberFromRef('claim/some-slug')).toBe(null); // slug, not issue-<num>
    });
  });

  describe('registry', () => {
    it('claim-issue, claim-issue-gitlab and plan-task are registered by default', () => {
      expect(hasWorkDetector('claim-issue')).toBe(true);
      expect(hasWorkDetector('claim-issue-gitlab')).toBe(true);
      expect(hasWorkDetector('plan-task')).toBe(true);
      expect(typeof getWorkDetector('claim-issue')).toBe('function');
    });

    it('detectActionableWork reports no-detector for an unregistered type (e.g. JIRA)', async () => {
      const out = await detectActionableWork('claim-issue-jira', { id: 'a' });
      expect(out).toEqual({ actionable: false, count: 0, reason: 'no-detector', hasDetector: false });
    });

    it('detectActionableWork normalizes a registered detector result', async () => {
      registerWorkDetector('__test-type__', async () => ({ actionable: true, count: 3, reason: 'actionable-issues' }));
      const out = await detectActionableWork('__test-type__', { id: 'a' });
      expect(out).toMatchObject({ actionable: true, count: 3, reason: 'actionable-issues', hasDetector: true });
    });

    it('detectActionableWork catches a detector throw as a transient failure', async () => {
      registerWorkDetector('__throwing__', async () => { throw new Error('boom'); });
      const out = await detectActionableWork('__throwing__', { id: 'a' });
      expect(out.actionable).toBe(false);
      expect(out.transient).toBe(true);
      expect(out.reason).toContain('boom');
    });
  });

  describe('detectGithubIssues (spawn-mocked)', () => {
    beforeEach(() => { spawn.mockReset(); });
    const app = { id: 'a', repoPath: '/repo' };

    it('counts actionable issues, excluding labelled/assigned/in-flight', async () => {
      routeSpawn({
        'gh issue': { stdout: JSON.stringify([
          { number: 1, title: 'plain', assignees: [], labels: [] },
          { number: 2, title: 'needs a decision', assignees: [], labels: [{ name: 'needs-input' }] },
          { number: 3, title: 'taken', assignees: [{ login: 'x' }], labels: [] },
          { number: 4, title: 'in flight', assignees: [], labels: [] },
          { number: 5, title: 'also plain', assignees: [], labels: [{ name: 'plan' }] }
        ]) },
        'git branch': { stdout: 'main\norigin/claim/issue-4\n' },
        'gh pr': { stdout: '' }
      });
      const out = await detectGithubIssues(app, { issueAuthorFilter: 'any' });
      expect(out.actionable).toBe(true);
      expect(out.count).toBe(2); // #1 and #5 (plan is claimable); #2 #3 #4 excluded
      expect(out.sample).toEqual([1, 5]);
      // Breakdown surfaced for the UI: 5 open, 1 in-flight (#4), 2 filtered
      // (#2 needs-input, #3 assigned), 2 actionable.
      expect(out.total).toBe(5);
      expect(out.inFlightCount).toBe(1);
      expect(out.filteredCount).toBe(2);
    });

    it('reports the open/in-flight breakdown when nothing is claimable (the "40 open but parked" case)', async () => {
      routeSpawn({
        'gh issue': { stdout: JSON.stringify([
          { number: 1, title: 'shipped, stale branch', assignees: [], labels: [] },
          { number: 2, title: 'shipped, stale branch', assignees: [], labels: [] },
          { number: 3, title: 'blocked', assignees: [], labels: [{ name: 'blocked' }] }
        ]) },
        'git branch': { stdout: 'main\norigin/claim/issue-1\norigin/claim/issue-2\n' },
        'gh pr': { stdout: '' }
      });
      const out = await detectGithubIssues(app, { issueAuthorFilter: 'any' });
      expect(out).toMatchObject({ actionable: false, count: 0, reason: 'no-actionable-issues' });
      expect(out.total).toBe(3);
      expect(out.inFlightCount).toBe(2); // #1 + #2 held by stale claim branches
      expect(out.filteredCount).toBe(1); // #3 blocked
    });

    it('parks (no-open-issues) on an empty list', async () => {
      routeSpawn({ 'gh issue': { stdout: '[]' } });
      const out = await detectGithubIssues(app, { issueAuthorFilter: 'any' });
      expect(out).toMatchObject({ actionable: false, reason: 'no-open-issues', total: 0, inFlightCount: 0 });
    });

    it('reports no-authored-issues (not no-open-issues) when the author filter hides an otherwise non-empty queue', async () => {
      // The author-filtered probe finds nothing (e.g. self/@me is the wrong forge
      // identity); the unfiltered re-probe sees 3 open. Must NOT flatten to
      // "no open issues" — surface the real count + the actionable reason.
      spawn.mockImplementation((cmd, args = []) => {
        if (cmd === 'gh' && args[0] === 'issue') {
          const filtered = args.includes('--author');
          return fakeChild(filtered ? '[]' : JSON.stringify([
            { number: 1, title: 'a', assignees: [], labels: [] },
            { number: 2, title: 'b', assignees: [], labels: [] },
            { number: 3, title: 'c', assignees: [], labels: [] }
          ]));
        }
        return fakeChild('');
      });
      const out = await detectGithubIssues(app, { issueAuthorFilter: 'self' });
      expect(out).toMatchObject({
        actionable: false, count: 0, total: 3, filteredCount: 3, inFlightCount: 0,
        reason: 'no-authored-issues', authorFilter: 'self'
      });
      // Exactly two `gh issue` calls: the filtered probe + the unfiltered re-probe.
      const issueCalls = spawn.mock.calls.filter(([cmd, a]) => cmd === 'gh' && a[0] === 'issue');
      expect(issueCalls.some(([, a]) => a.includes('--author'))).toBe(true);
      expect(issueCalls.some(([, a]) => !a.includes('--author'))).toBe(true);
    });

    it('owner filter that resolves to an org (never an issue author) reports no-authored-issues with the real open count', async () => {
      // The exact aix-university trap: `gh repo view` owner is the ORG, so
      // `--author <org>` matches nothing even though the repo has open issues.
      spawn.mockImplementation((cmd, args = []) => {
        if (cmd === 'gh' && args[0] === 'repo') return fakeChild('AcmeOrg\n'); // owner login → org
        if (cmd === 'gh' && args[0] === 'issue') {
          const filtered = args.includes('--author');
          return fakeChild(filtered ? '[]' : JSON.stringify([
            { number: 5, title: 'x', assignees: [], labels: [] }
          ]));
        }
        return fakeChild('');
      });
      const out = await detectGithubIssues(app, { issueAuthorFilter: 'owner' });
      expect(out).toMatchObject({ reason: 'no-authored-issues', total: 1, authorFilter: 'owner' });
    });

    it('still reports no-open-issues when the repo is genuinely empty under an author filter', async () => {
      // Both the filtered probe AND the unfiltered re-probe are empty → truly nothing.
      spawn.mockImplementation((cmd, args = []) => {
        if (cmd === 'gh' && args[0] === 'issue') return fakeChild('[]');
        return fakeChild('');
      });
      const out = await detectGithubIssues(app, { issueAuthorFilter: 'self' });
      expect(out).toMatchObject({ actionable: false, reason: 'no-open-issues', total: 0 });
    });

    it('does not run a fallback re-probe under the "any" filter (no author was applied)', async () => {
      let issueCalls = 0;
      spawn.mockImplementation((cmd, args = []) => {
        if (cmd === 'gh' && args[0] === 'issue') { issueCalls++; return fakeChild('[]'); }
        return fakeChild('');
      });
      const out = await detectGithubIssues(app, { issueAuthorFilter: 'any' });
      expect(out.reason).toBe('no-open-issues');
      expect(issueCalls).toBe(1); // no second, unfiltered probe
    });

    it('falls back to no-open-issues when the unfiltered re-probe itself fails (safe, not a phantom count)', async () => {
      spawn.mockImplementation((cmd, args = []) => {
        if (cmd === 'gh' && args[0] === 'issue') {
          if (args.includes('--author')) return fakeChild('[]', 0); // filtered: clean empty
          return fakeChild('', 1); // unfiltered re-probe errors
        }
        return fakeChild('');
      });
      const out = await detectGithubIssues(app, { issueAuthorFilter: 'self' });
      expect(out.reason).toBe('no-open-issues');
    });

    it('reports a transient failure when gh exits non-zero', async () => {
      routeSpawn({ 'gh issue': { stdout: '', code: 1 } });
      const out = await detectGithubIssues(app, { issueAuthorFilter: 'any' });
      expect(out).toMatchObject({ actionable: false, reason: 'gh-list-failed', transient: true });
    });

    it('self mode passes --author @me to the list (gh resolves @me natively, no extra lookup)', async () => {
      routeSpawn({
        'gh issue': { stdout: JSON.stringify([{ number: 1, title: 'mine', assignees: [], labels: [] }]) },
        'git branch': { stdout: 'main\n' },
        'gh pr': { stdout: '' }
      });
      const out = await detectGithubIssues(app, { issueAuthorFilter: 'self' });
      expect(out.actionable).toBe(true);
      const listCall = spawn.mock.calls.find(([cmd, args]) => cmd === 'gh' && args[0] === 'issue');
      expect(listCall[1]).toContain('--author');
      expect(listCall[1]).toContain('@me');
      // No `gh repo view` owner lookup is needed in self mode.
      expect(spawn.mock.calls.some(([cmd, args]) => cmd === 'gh' && args[0] === 'repo')).toBe(false);
    });

    it('an out-of-vocab filter value collapses to the @me self boundary (safe default)', async () => {
      // Defense-in-depth: callers feed sanitizeTaskMetadata-constrained values,
      // but if an unknown one ever reaches here it must fall to the @me security
      // boundary (matching resolveIssueAuthorFilterBlock), never to owner/any.
      routeSpawn({
        'gh issue': { stdout: JSON.stringify([{ number: 1, title: 'mine', assignees: [], labels: [] }]) },
        'git branch': { stdout: 'main\n' },
        'gh pr': { stdout: '' }
      });
      const out = await detectGithubIssues(app, { issueAuthorFilter: 'bogus' });
      expect(out.actionable).toBe(true);
      const listCall = spawn.mock.calls.find(([cmd, args]) => cmd === 'gh' && args[0] === 'issue');
      expect(listCall[1]).toContain('@me');
    });
  });

  describe('detectGitlabIssues (spawn-mocked)', () => {
    beforeEach(() => { spawn.mockReset(); });
    const app = { id: 'a', repoPath: '/repo' };

    it('normalizes iid + string labels and excludes MR-in-flight issues', async () => {
      routeSpawn({
        'glab issue': { stdout: JSON.stringify([
          { iid: 10, title: 'plain', assignees: [], labels: [] },
          { iid: 11, title: 'blocked', assignees: [], labels: ['blocked'] },
          { iid: 12, title: 'in flight via MR', assignees: [], labels: [] }
        ]) },
        'git branch': { stdout: 'main\n' },
        'glab mr': { stdout: JSON.stringify([{ source_branch: 'claim/issue-12' }]) }
      });
      const out = await detectGitlabIssues(app, { issueAuthorFilter: 'any' });
      expect(out.actionable).toBe(true);
      expect(out.count).toBe(1); // only #10 (#11 blocked label, #12 in-flight MR)
      expect(out.sample).toEqual([10]);
    });

    it('reports a transient failure when glab exits non-zero', async () => {
      routeSpawn({ 'glab issue': { stdout: '', code: 1 } });
      const out = await detectGitlabIssues(app, { issueAuthorFilter: 'any' });
      expect(out).toMatchObject({ actionable: false, reason: 'glab-list-failed', transient: true });
    });

    it('self mode resolves the authenticated glab username and filters the list by it', async () => {
      routeSpawn({
        'glab api': { stdout: 'octo\n' }, // glab api user -q .username
        'glab issue': { stdout: JSON.stringify([{ iid: 10, title: 'mine', assignees: [], labels: [] }]) },
        'git branch': { stdout: 'main\n' },
        'glab mr': { stdout: '[]' }
      });
      const out = await detectGitlabIssues(app, { issueAuthorFilter: 'self' });
      expect(out.actionable).toBe(true);
      const listCall = spawn.mock.calls.find(([cmd, args]) => cmd === 'glab' && args[0] === 'issue');
      expect(listCall[1]).toContain('--author');
      expect(listCall[1]).toContain('octo');
    });

    it('self mode reports a transient failure when glab api user fails (unauthenticated)', async () => {
      routeSpawn({ 'glab api': { stdout: '', code: 1 } });
      const out = await detectGitlabIssues(app, { issueAuthorFilter: 'self' });
      expect(out).toMatchObject({ actionable: false, reason: 'glab-unavailable', transient: true });
    });

    it('self mode reports no-authored-issues when the author filter hides a non-empty queue', async () => {
      spawn.mockImplementation((cmd, args = []) => {
        if (cmd === 'glab' && args[0] === 'api') return fakeChild('octo\n'); // glab api user
        if (cmd === 'glab' && args[0] === 'issue') {
          const filtered = args.includes('--author');
          return fakeChild(filtered ? '[]' : JSON.stringify([{ iid: 10, title: 'x', assignees: [], labels: [] }]));
        }
        return fakeChild('');
      });
      const out = await detectGitlabIssues(app, { issueAuthorFilter: 'self' });
      expect(out).toMatchObject({ actionable: false, reason: 'no-authored-issues', total: 1, authorFilter: 'self' });
    });
  });
});
