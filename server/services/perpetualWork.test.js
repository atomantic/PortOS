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
  titleMarksEpic,
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

    it('rejects an epic by label, by "(epic)" title suffix, or by "[epic]" title prefix', () => {
      expect(isActionableIssue({ ...base, labels: [{ name: 'epic' }] })).toBe(false);
      expect(isActionableIssue({ ...base, title: 'Big rollup (epic)' })).toBe(false);
      // The non-convergence case: an epic titled "[Epic] …" with NO `epic`
      // label kept reading as actionable, so the drain re-spawned a claim agent
      // that always skips it — never parking.
      expect(isActionableIssue({
        ...base,
        labels: [{ name: 'enhancement' }, { name: 'roadmap' }],
        title: '[Epic] Redesign the billing dashboard'
      })).toBe(false);
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

  describe('titleMarksEpic', () => {
    it.each([
      'Big rollup (epic)',
      'Big rollup (EPIC)',
      '[Epic] Redesign the billing dashboard',
      '[EPIC] all caps prefix',
      '[epic] lower prefix',
      '[Epic: theme] with a colon',
      '[ epic ] padded brackets',
      'Epic: Redesign the nav',         // unbracketed colon tag
      'EPIC: all caps colon'
    ])('recognizes %j as an epic', (title) => {
      expect(titleMarksEpic(title)).toBe(true);
    });

    it.each([
      'Fix the login bug',
      '[epicenter] telemetry module',  // `\b` guard: "epicenter" starts with "epic" but is a different word
      'Epicurean recipe importer',     // "epic" as a substring, no bracket/paren tag
      'Add an epic-scale test (not a tag)',
      'Epic rework of the nav',        // bare adjective — no bracket/colon terminator, not a tag
      '[epic vision that never closes', // unclosed bracket, no colon terminator
      '',
      null,
      undefined
    ])('does not flag %j as an epic', (title) => {
      expect(titleMarksEpic(title)).toBe(false);
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

    it('converges (0 actionable) on a queue whose only unblocked issue is a "[Epic]"-prefixed one with no epic label', async () => {
      // Regression for the perpetual-swarm churn: every open issue is either
      // needs-input/blocked OR a "[Epic] …" umbrella with no `epic` label. The
      // claim agent skips the epic; the detector MUST too, or the drain
      // re-spawns a no-op agent every tick and never parks.
      routeSpawn({
        'gh issue': { stdout: JSON.stringify([
          { number: 1, title: '[Epic] Redesign the billing dashboard', assignees: [], labels: [{ name: 'enhancement' }, { name: 'roadmap' }] },
          { number: 2, title: 'Add a dark-mode toggle', assignees: [], labels: [{ name: 'needs-input' }] },
          { number: 3, title: 'Document the export API', assignees: [], labels: [{ name: 'needs-input' }] },
          { number: 4, title: 'Record the onboarding walkthrough', assignees: [], labels: [{ name: 'needs-input' }] },
          { number: 5, title: 'Wire up the metrics pipeline', assignees: [], labels: [{ name: 'blocked' }] },
          { number: 6, title: 'Calibrate the ranking weights', assignees: [], labels: [{ name: 'needs-input' }] },
          { number: 7, title: 'Cache the aggregate query', assignees: [], labels: [{ name: 'needs-input' }] }
        ]) },
        'git branch': { stdout: 'main\n' },
        'gh pr': { stdout: '' }
      });
      const out = await detectGithubIssues(app, { issueAuthorFilter: 'any' });
      expect(out).toMatchObject({ actionable: false, count: 0, reason: 'no-actionable-issues' });
      expect(out.total).toBe(7);
      expect(out.inFlightCount).toBe(0);
      expect(out.filteredCount).toBe(7); // the epic (#1) + 6 needs-input/blocked
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
        actionable: false, count: 0, total: 3, filteredCount: 0, inFlightCount: 0,
        reason: 'no-authored-issues'
      });
      // Exactly two `gh issue` calls: the filtered probe + the unfiltered re-probe.
      const issueCalls = spawn.mock.calls.filter(([cmd, a]) => cmd === 'gh' && a[0] === 'issue');
      expect(issueCalls.some(([, a]) => a.includes('--author'))).toBe(true);
      expect(issueCalls.some(([, a]) => !a.includes('--author'))).toBe(true);
    });

    it('owner filter on an org-owned repo reports owner-is-org with the real open count (never queries --author <org>)', async () => {
      // The exact owner-filter trap: the repo owner is an ORG, and an org login
      // can never be an issue author, so `--author <org>` is guaranteed empty.
      // The detector short-circuits to `owner-is-org` and reports the true count.
      spawn.mockImplementation((cmd, args = []) => {
        if (cmd === 'gh' && args[0] === 'repo') {
          return fakeChild(JSON.stringify({ owner: { login: 'AcmeOrg' }, isInOrganization: true }));
        }
        if (cmd === 'gh' && args[0] === 'issue') {
          return fakeChild(JSON.stringify([{ number: 5, title: 'x', assignees: [], labels: [] }]));
        }
        return fakeChild('');
      });
      const out = await detectGithubIssues(app, { issueAuthorFilter: 'owner' });
      expect(out).toMatchObject({ reason: 'owner-is-org', total: 1, count: 0, filteredCount: 0 });
      // The guaranteed-empty `--author <org>` query is skipped entirely — only
      // the unfiltered count re-probe runs.
      const issueCalls = spawn.mock.calls.filter(([cmd, a]) => cmd === 'gh' && a[0] === 'issue');
      expect(issueCalls.every(([, a]) => !a.includes('--author'))).toBe(true);
    });

    it('owner filter on a user-owned repo passes --author <login> and detects normally', async () => {
      spawn.mockImplementation((cmd, args = []) => {
        if (cmd === 'gh' && args[0] === 'repo') {
          return fakeChild(JSON.stringify({ owner: { login: 'alice' }, isInOrganization: false }));
        }
        if (cmd === 'gh' && args[0] === 'issue') {
          return fakeChild(JSON.stringify([{ number: 5, title: 'x', assignees: [], labels: [] }]));
        }
        if (cmd === 'git' && args[0] === 'branch') return fakeChild('main\n');
        return fakeChild('');
      });
      const out = await detectGithubIssues(app, { issueAuthorFilter: 'owner' });
      expect(out.actionable).toBe(true);
      const listCall = spawn.mock.calls.find(([cmd, a]) => cmd === 'gh' && a[0] === 'issue');
      expect(listCall[1]).toContain('--author');
      expect(listCall[1]).toContain('alice');
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
      expect(out).toMatchObject({ actionable: false, reason: 'no-authored-issues', total: 1, filteredCount: 0 });
    });

    it('owner filter on a GROUP-owned project reports owner-is-group (probe 200) with the real open count', async () => {
      // The GitLab twin of the GitHub org trap: the namespace is a group, which
      // never authors issues. `glab api groups/<namespace>` returning 200 (code 0)
      // marks it a group → the shared owner-filter short-circuit parks with the
      // GitLab-flavored `owner-is-group` reason and never runs `--author <group>`.
      spawn.mockImplementation((cmd, args = []) => {
        if (cmd === 'git' && args[0] === 'remote') return fakeChild('git@gitlab.com:acme-group/widget.git\n');
        if (cmd === 'glab' && args[0] === 'api' && String(args[1]).startsWith('groups/')) return fakeChild('{"kind":"group"}');
        if (cmd === 'glab' && args[0] === 'issue') return fakeChild(JSON.stringify([{ iid: 7, title: 'x', assignees: [], labels: [] }]));
        return fakeChild('');
      });
      const out = await detectGitlabIssues(app, { issueAuthorFilter: 'owner' });
      expect(out).toMatchObject({ reason: 'owner-is-group', total: 1, count: 0, filteredCount: 0 });
      // The guaranteed-empty `--author <group>` query is never issued.
      const issueCalls = spawn.mock.calls.filter(([cmd, a]) => cmd === 'glab' && a[0] === 'issue');
      expect(issueCalls.every(([, a]) => !a.includes('--author'))).toBe(true);
    });

    it('owner filter on a nested SUBGROUP project resolves the full namespace and reports owner-is-group', async () => {
      // Nested subgroups are the common GitLab layout: parseGitRemoteUrl rejects a
      // >2-segment remote, so the namespace must be resolved from the raw path and
      // URL-encoded (`parent/subgroup` → `parent%2Fsubgroup`) before the group probe.
      spawn.mockImplementation((cmd, args = []) => {
        if (cmd === 'git' && args[0] === 'remote') return fakeChild('git@gitlab.com:parent/subgroup/widget.git\n');
        if (cmd === 'glab' && args[0] === 'api' && String(args[1]).startsWith('groups/')) return fakeChild('{"kind":"group"}');
        if (cmd === 'glab' && args[0] === 'issue') return fakeChild(JSON.stringify([{ iid: 9, title: 'x', assignees: [], labels: [] }]));
        return fakeChild('');
      });
      const out = await detectGitlabIssues(app, { issueAuthorFilter: 'owner' });
      expect(out).toMatchObject({ reason: 'owner-is-group', total: 1, count: 0 });
      const probeCall = spawn.mock.calls.find(([cmd, a]) => cmd === 'glab' && a[0] === 'api' && String(a[1]).startsWith('groups/'));
      expect(probeCall[1][1]).toBe('groups/parent%2Fsubgroup');
      // Never issues the guaranteed-empty `--author <group>` query.
      const issueCalls = spawn.mock.calls.filter(([cmd, a]) => cmd === 'glab' && a[0] === 'issue');
      expect(issueCalls.every(([, a]) => !a.includes('--author'))).toBe(true);
    });

    it('preserves a numeric namespace in an HTTPS remote (does not strip it as a port hop)', async () => {
      // Regression: an all-numeric top-level namespace (`/1234/widget`) must NOT be
      // mistaken for an SSH `:443/` port hop and dropped — GitLab numeric group/user
      // paths are valid, so the probe must target groups/1234.
      spawn.mockImplementation((cmd, args = []) => {
        if (cmd === 'git' && args[0] === 'remote') return fakeChild('https://gitlab.example/1234/widget.git\n');
        if (cmd === 'glab' && args[0] === 'api' && String(args[1]).startsWith('groups/')) return fakeChild('{"kind":"group"}');
        if (cmd === 'glab' && args[0] === 'issue') return fakeChild(JSON.stringify([{ iid: 3, title: 'x', assignees: [], labels: [] }]));
        return fakeChild('');
      });
      const out = await detectGitlabIssues(app, { issueAuthorFilter: 'owner' });
      expect(out).toMatchObject({ reason: 'owner-is-group', total: 1 });
      const probeCall = spawn.mock.calls.find(([cmd, a]) => cmd === 'glab' && a[0] === 'api' && String(a[1]).startsWith('groups/'));
      expect(probeCall[1][1]).toBe('groups/1234');
    });

    it('parses a bracketed IPv6 host without leaking the address into the namespace', async () => {
      // Regression: the host/path split must not trip on the colons inside a
      // bracketed IPv6 literal — the namespace is `group`, not part of the address.
      spawn.mockImplementation((cmd, args = []) => {
        if (cmd === 'git' && args[0] === 'remote') return fakeChild('https://[2001:db8::1]/group/widget.git\n');
        if (cmd === 'glab' && args[0] === 'api' && String(args[1]).startsWith('groups/')) return fakeChild('{"kind":"group"}');
        if (cmd === 'glab' && args[0] === 'issue') return fakeChild(JSON.stringify([{ iid: 4, title: 'x', assignees: [], labels: [] }]));
        return fakeChild('');
      });
      const out = await detectGitlabIssues(app, { issueAuthorFilter: 'owner' });
      expect(out).toMatchObject({ reason: 'owner-is-group', total: 1 });
      const probeCall = spawn.mock.calls.find(([cmd, a]) => cmd === 'glab' && a[0] === 'api' && String(a[1]).startsWith('groups/'));
      expect(probeCall[1][1]).toBe('groups/group');
    });

    it('owner filter on a USER-owned project passes --author <namespace> (groups probe 404)', async () => {
      // A user namespace: `glab api groups/<namespace>` 404s (non-zero exit) → not
      // a group, so owner-mode filters by the namespace login as before.
      spawn.mockImplementation((cmd, args = []) => {
        if (cmd === 'git' && args[0] === 'remote') return fakeChild('git@gitlab.com:alice/widget.git\n');
        if (cmd === 'git' && args[0] === 'branch') return fakeChild('main\n');
        if (cmd === 'glab' && args[0] === 'api' && String(args[1]).startsWith('groups/')) return fakeChild('', 22); // glab 404 → non-zero
        if (cmd === 'glab' && args[0] === 'issue') return fakeChild(JSON.stringify([{ iid: 7, title: 'x', assignees: [], labels: [] }]));
        if (cmd === 'glab' && args[0] === 'mr') return fakeChild('[]');
        return fakeChild('');
      });
      const out = await detectGitlabIssues(app, { issueAuthorFilter: 'owner' });
      expect(out.actionable).toBe(true);
      const listCall = spawn.mock.calls.find(([cmd, a]) => cmd === 'glab' && a[0] === 'issue');
      expect(listCall[1]).toContain('--author');
      expect(listCall[1]).toContain('alice');
    });
  });
});
