/**
 * Unit tests for the Issue Reconciler deterministic core.
 *
 * - issueNumberFromRef / bodyReferencesIssue / prReferencesIssue — the boundary-
 *   safe reference matchers (no `issue-222` matching inside `issue-2220`).
 * - classifyIssue / classifyIssues — the pure LIVE/RESERVED/ZOMBIE/ABANDONED/STALLED state machine.
 * - reconcile / gatherIssueState — end-to-end over mocked gh/glab + git: an
 *   in-progress issue with a merged PR/MR and no live claim is a ZOMBIE; an open
 *   PR/MR or a live claim branch or an active agent keeps it LIVE. Runs the SAME
 *   assertions against both the GitHub (`gh`) and GitLab (`glab`) forge gatherers.
 * - zombieSignature / formatZombiesForPrompt — the convergence signature and the
 *   forge- + autoClose-aware prompt body.
 * - releaseAbandonedClaims — the deterministic releaser for a stale volunteer
 *   claim, the one WRITE this module performs (#6112).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/execGit.js', () => ({
  execGit: vi.fn(async () => ({ stdout: '', exitCode: 0 })),
}));
const ensureForgeReachableMock = vi.fn(async () => ({ ok: true, status: 'ok', detail: null, remedy: null }));
vi.mock('./github.js', () => ({
  execGh: vi.fn(async () => '[]'),
  ensureForgeReachable: (...args) => ensureForgeReachableMock(...args),
}));
vi.mock('./gitlab.js', () => ({
  execGlab: vi.fn(async () => ''),
  execGlabJson: vi.fn(async () => ({ rows: [], reason: 'ok' })),
}));
vi.mock('./jira.js', () => ({ fetchMyCurrentSprintTickets: vi.fn(async () => []) }));
vi.mock('../lib/gitRemote.js', () => ({
  getOriginInfo: vi.fn(async () => ({ isGithub: true, host: 'github.com', fullName: 'atomantic/PortOS' })),
  readOriginRemoteUrl: vi.fn(async () => 'git@github.com:atomantic/PortOS.git'),
}));
// workTracker.js is deliberately NOT mocked: `resolveRepoForgeTarget` is the
// canonical origin→forge classifier, and its only effectful dependency is
// gitRemote.js (mocked above). Running the real implementation is what exercises
// the enterprise-GitHub and nested-subgroup-GitLab branches through the exact
// mapping production uses — a re-implementation here would drift.
vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { root: '/repo' },
  safeJSONParse: (raw, fallback) => { try { return JSON.parse(raw); } catch { return fallback; } },
}));

import {
  issueNumberFromRef, ticketKeyFromRef, bodyReferencesIssue, prReferencesIssue,
  isJiraStartedStatus, isJiraShippedStatus,
  classifyIssue, classifyIssues, reconcile, gatherIssueState,
  zombieSignature, formatZombiesForPrompt,
  releaseAbandonedClaims, daysSince, FOREIGN_CLAIM_STALE_DAYS,
} from './issueReconcile.js';
import { execGit } from '../lib/execGit.js';
import { execGh } from './github.js';
import { execGlab, execGlabJson } from './gitlab.js';
import { fetchMyCurrentSprintTickets } from './jira.js';
import { getOriginInfo, readOriginRemoteUrl } from '../lib/gitRemote.js';

beforeEach(() => {
  vi.clearAllMocks();
  execGit.mockResolvedValue({ stdout: '', exitCode: 0 });
  execGlab.mockResolvedValue('');
  getOriginInfo.mockResolvedValue({ isGithub: true, host: 'github.com', fullName: 'atomantic/PortOS' });
  readOriginRemoteUrl.mockResolvedValue('git@github.com:atomantic/PortOS.git');
});

describe('issueNumberFromRef', () => {
  it('matches the human claim convention', () => {
    expect(issueNumberFromRef('claim/issue-2220')).toBe(2220);
  });
  it('matches the CoS sub-agent convention', () => {
    expect(issueNumberFromRef('cos/branch-reconcile/issue-2220/agent-x')).toBe(2220);
  });
  it('matches a remote-tracking ref', () => {
    expect(issueNumberFromRef('refs/remotes/origin/claim/issue-2220')).toBe(2220);
  });
  it('does NOT match a shorter number inside a longer one', () => {
    // issue-222 must not match inside claim/issue-2220
    expect(issueNumberFromRef('claim/issue-2220')).not.toBe(222);
  });
  it('returns null for a non-claim ref', () => {
    expect(issueNumberFromRef('feat/some-feature')).toBeNull();
    expect(issueNumberFromRef('refs/heads/main')).toBeNull();
    expect(issueNumberFromRef('')).toBeNull();
  });
});

describe('ticketKeyFromRef', () => {
  it('matches the human claim convention (claim/<KEY>)', () => {
    expect(ticketKeyFromRef('claim/PROJ-1234')).toBe('PROJ-1234');
  });
  it('matches the CoS sub-agent convention (cos/<task>/<KEY>/<agent>)', () => {
    expect(ticketKeyFromRef('cos/issue-reconcile/PROJ-1234/agent-x')).toBe('PROJ-1234');
  });
  it('matches a remote-tracking ref', () => {
    expect(ticketKeyFromRef('refs/remotes/origin/claim/ABC-42')).toBe('ABC-42');
  });
  it('returns null for a non-JIRA ref', () => {
    expect(ticketKeyFromRef('claim/issue-2220')).toBeNull();
    expect(ticketKeyFromRef('refs/heads/main')).toBeNull();
    expect(ticketKeyFromRef('feat/some-feature')).toBeNull();
    expect(ticketKeyFromRef('')).toBeNull();
  });
  it('does NOT match a key-shaped segment outside the claim/cos convention (no false live-claim)', () => {
    // A branch that merely ENDS in a key must not register a live claim — else a
    // real zombie would be suppressed forever.
    expect(ticketKeyFromRef('wip/PROJ-42')).toBeNull();
    expect(ticketKeyFromRef('feat/PROJ-42')).toBeNull();
    expect(ticketKeyFromRef('PROJ-42')).toBeNull();
    expect(ticketKeyFromRef('cos/PROJ-42')).toBeNull(); // missing the <task> segment
  });
});

describe('isJiraStartedStatus', () => {
  it('is true only for the In Progress category', () => {
    expect(isJiraStartedStatus({ statusCategory: 'In Progress' })).toBe(true);
  });
  it('is false for To Do (not started) and Done (terminal → converges)', () => {
    expect(isJiraStartedStatus({ statusCategory: 'To Do' })).toBe(false);
    expect(isJiraStartedStatus({ statusCategory: 'Done' })).toBe(false);
    expect(isJiraStartedStatus({})).toBe(false);
  });
});

describe('isJiraShippedStatus', () => {
  it('treats an In Review / Code Review status name as shipped', () => {
    expect(isJiraShippedStatus({ status: 'In Review' })).toBe(true);
    expect(isJiraShippedStatus({ status: 'Code Review' })).toBe(true);
  });
  it('a plain In Progress status is NOT shipped (→ stalled, not zombie)', () => {
    expect(isJiraShippedStatus({ status: 'In Progress' })).toBe(false);
    expect(isJiraShippedStatus({})).toBe(false);
  });
});

describe('bodyReferencesIssue', () => {
  it('matches a plain #num token', () => {
    expect(bodyReferencesIssue('Refs #2220 in the body', 2220)).toBe(true);
  });
  it('matches Closes/Fixes trailers', () => {
    expect(bodyReferencesIssue('Closes #2220', 2220)).toBe(true);
  });
  it('does NOT match a shorter number inside a longer one', () => {
    expect(bodyReferencesIssue('Closes #2220', 222)).toBe(false);
  });
  it('is false for empty / missing', () => {
    expect(bodyReferencesIssue('', 2220)).toBe(false);
    expect(bodyReferencesIssue(null, 2220)).toBe(false);
  });
});

describe('prReferencesIssue', () => {
  it('matches by head ref', () => {
    expect(prReferencesIssue({ headRefName: 'claim/issue-2220', body: '' }, 2220)).toBe(true);
  });
  it('matches by body when head ref does not encode it', () => {
    expect(prReferencesIssue({ headRefName: 'feat/covers', body: 'Refs #2220' }, 2220)).toBe(true);
  });
  it('is false when neither references it', () => {
    expect(prReferencesIssue({ headRefName: 'feat/x', body: 'Closes #99' }, 2220)).toBe(false);
  });
});

describe('classifyIssue', () => {
  it('merged PR + no live claim + no agent → ZOMBIE', () => {
    expect(classifyIssue({ hasMergedPr: true, hasLiveClaim: false, hasActiveAgent: false })).toBe('ZOMBIE');
  });
  it('a live claim wins even with a merged PR → LIVE', () => {
    expect(classifyIssue({ hasMergedPr: true, hasLiveClaim: true, hasActiveAgent: false })).toBe('LIVE');
  });
  it('an active agent wins even with a merged PR → LIVE', () => {
    expect(classifyIssue({ hasMergedPr: true, hasLiveClaim: false, hasActiveAgent: true })).toBe('LIVE');
  });
  it('no merged PR and no live claim → STALLED', () => {
    expect(classifyIssue({ hasMergedPr: false, hasLiveClaim: false, hasActiveAgent: false })).toBe('STALLED');
  });
  // The narrow, automatable slice of STALLED: a claim nothing here owns the
  // release of, sitting untouched long enough that a contributor still working
  // would have shown a branch, a PR, or a comment.
  it('a stale foreign claim with nothing shipped → ABANDONED', () => {
    expect(classifyIssue({
      hasMergedPr: false, hasLiveClaim: false, hasActiveAgent: false,
      hasForeignClaim: true, staleDays: FOREIGN_CLAIM_STALE_DAYS,
    })).toBe('ABANDONED');
  });
  it('a foreign claim younger than the threshold stays STALLED', () => {
    expect(classifyIssue({
      hasMergedPr: false, hasLiveClaim: false, hasActiveAgent: false,
      hasForeignClaim: true, staleDays: FOREIGN_CLAIM_STALE_DAYS - 1,
    })).toBe('STALLED');
  });
  // Absent is not zero: a forge that reported no update time must not read as
  // "updated at the epoch" and release a claim made this morning.
  it('an unresolvable stale-day count never satisfies the gate', () => {
    expect(classifyIssue({
      hasMergedPr: false, hasLiveClaim: false, hasActiveAgent: false,
      hasForeignClaim: true, staleDays: null,
    })).toBe('STALLED');
  });
  // Our own claim's release is owned by the claim flow's Phase 6/7 and by the
  // zombie heal — racing them could unassign a run live on a peer.
  it('an ancient claim held by this install stays STALLED', () => {
    expect(classifyIssue({
      hasMergedPr: false, hasLiveClaim: false, hasActiveAgent: false,
      hasForeignClaim: false, staleDays: 365,
    })).toBe('STALLED');
  });
  // #16599 — a `/do:next --swarm` reservation is `in-progress` with no assignee and no
  // branch yet; a sibling PR that merely mentions it must not make it a zombie.
  it('an unassigned issue is RESERVED even with a merged PR', () => {
    expect(classifyIssue({ hasMergedPr: true, hasLiveClaim: false, hasActiveAgent: false, hasAssignee: false })).toBe('RESERVED');
  });
  it('an assigned issue with a merged PR is still a ZOMBIE', () => {
    expect(classifyIssue({ hasMergedPr: true, hasLiveClaim: false, hasActiveAgent: false, hasAssignee: true })).toBe('ZOMBIE');
  });
  it('an unread assignee list (null) classifies as it did before reservations', () => {
    expect(classifyIssue({ hasMergedPr: true, hasLiveClaim: false, hasActiveAgent: false, hasAssignee: null })).toBe('ZOMBIE');
    expect(classifyIssue({ hasMergedPr: false, hasLiveClaim: false, hasActiveAgent: false, hasAssignee: null })).toBe('STALLED');
  });
  it('a live claim wins over a reservation', () => {
    expect(classifyIssue({ hasMergedPr: true, hasLiveClaim: true, hasActiveAgent: false, hasAssignee: false })).toBe('LIVE');
  });
  it('a live claim wins over the abandoned gate', () => {
    expect(classifyIssue({
      hasMergedPr: false, hasLiveClaim: true, hasActiveAgent: false,
      hasForeignClaim: true, staleDays: 999,
    })).toBe('LIVE');
  });
});

describe('daysSince', () => {
  it('counts whole elapsed days', () => {
    expect(daysSince(daysAgo(20), NOW)).toBe(20);
    expect(daysSince(daysAgo(0.5), NOW)).toBe(0);
  });
  it('returns null — not 0 — for an absent or unparseable timestamp', () => {
    expect(daysSince('', NOW)).toBeNull();
    expect(daysSince(undefined, NOW)).toBeNull();
    expect(daysSince('not a date', NOW)).toBeNull();
  });
});

describe('classifyIssues', () => {
  it('adds a state field to each', () => {
    const out = classifyIssues([
      { number: 1, hasMergedPr: true, hasLiveClaim: false, hasActiveAgent: false },
      { number: 2, hasMergedPr: false, hasLiveClaim: true, hasActiveAgent: false },
    ]);
    expect(out.map((o) => o.state)).toEqual(['ZOMBIE', 'LIVE']);
  });
});

// --- end-to-end gather/reconcile over mocked gh + git ---

/**
 * Wire execGh's list calls (issue / merged pr / open pr) plus the `api user`
 * identity probe by argv shape. `owner` is the login gh reports; passing null
 * simulates a gh that could not answer, which must never read as "every
 * assignee is somebody else".
 */
function mockGh({ issues = [], merged = [], open = [], owner = 'atomantic' }) {
  execGh.mockImplementation(async (argv) => {
    if (argv[0] === 'issue' && argv[1] === 'list') return JSON.stringify(issues.map(issue => ({ author: { login: 'trusted-author' }, ...issue })));
    if (argv[0] === 'pr' && argv.includes('merged')) return JSON.stringify(merged);
    if (argv[0] === 'pr' && argv.includes('open')) return JSON.stringify(open);
    if (argv[0] === 'api' && argv.at(-1) === 'user') {
      if (owner === null) throw new Error('gh: not authenticated');
      return JSON.stringify({ login: owner });
    }
    if (argv[0] === 'api' && argv.at(-1).endsWith('/permission')) return JSON.stringify({ permission: 'write', user: { login: 'trusted-author' } });
    return '[]';
  });
}

/** An ISO timestamp `days` in the past, relative to a fixed `now`. */
const NOW = Date.parse('2026-09-01T00:00:00Z');
const daysAgo = (days) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

describe('reconcile', () => {
  it('flags an in-progress issue whose PR merged with no live claim as a ZOMBIE', async () => {
    mockGh({
      issues: [{ number: 2220, title: 'CDO covers', labels: [{ name: 'in-progress' }], assignees: [{ login: 'atomantic' }], url: 'u' }],
      merged: [{ number: 2234, headRefName: 'feat/covers', body: 'Refs #2220', url: 'p' }],
      open: [],
    });
    execGit.mockResolvedValue({ stdout: '', exitCode: 0 }); // no claim refs

    const result = await reconcile('/repo');
    expect(result.forge).toBe('github');
    expect(result.zombies.map((z) => z.number)).toEqual([2220]);
    expect(result.zombies[0].mergedPr.number).toBe(2234);
    expect(result.stalled).toHaveLength(0);
    expect(result.live).toHaveLength(0);
  });

  describe('saturated forge lists', () => {
    const fullMerged = (oldest) => Array.from({ length: 200 }, (_, i) => ({
      number: 5000 + i, headRefName: 'x', body: '', mergedAt: i === 199 ? oldest : daysAgo(1),
    }));
    const issue = { number: 2220, title: 't', labels: [{ name: 'in-progress' }], assignees: [], url: 'u', createdAt: daysAgo(10) };

    it('a full merged-PR window that reaches back past the oldest claim is still complete', async () => {
      mockGh({ issues: [issue], merged: fullMerged(daysAgo(30)) });
      expect(await reconcile('/repo', { now: NOW })).not.toBeNull();
    });

    it('a full merged-PR window that starts after the oldest claim withholds cleanup', async () => {
      mockGh({ issues: [issue], merged: fullMerged(daysAgo(2)) });
      expect(await reconcile('/repo', { now: NOW })).toBeNull();
    });
  });

  it('a live open PR keeps the issue LIVE (not a zombie)', async () => {
    mockGh({
      issues: [{ number: 2220, title: 't', labels: [{ name: 'in-progress' }], assignees: [], url: 'u' }],
      merged: [{ number: 2234, headRefName: 'x', body: 'Refs #2220' }],
      open: [{ number: 2300, headRefName: 'claim/issue-2220', body: '' }],
    });
    const result = await reconcile('/repo');
    expect(result.zombies).toHaveLength(0);
    expect(result.live.map((l) => l.number)).toEqual([2220]);
  });

  it('a live LOCAL/REMOTE claim branch keeps the issue LIVE', async () => {
    mockGh({
      issues: [{ number: 2220, title: 't', labels: [{ name: 'in-progress' }], assignees: [], url: 'u' }],
      merged: [{ number: 2234, headRefName: 'x', body: 'Refs #2220' }],
      open: [],
    });
    // for-each-ref reports a live claim branch (this machine or a peer)
    execGit.mockResolvedValue({ stdout: 'refs/remotes/origin/claim/issue-2220\nrefs/heads/main\n', exitCode: 0 });
    const result = await reconcile('/repo');
    expect(result.zombies).toHaveLength(0);
    expect(result.live.map((l) => l.number)).toEqual([2220]);
  });

  it('an active CoS agent on the issue keeps it LIVE', async () => {
    mockGh({
      issues: [{ number: 2220, title: 't', labels: [{ name: 'in-progress' }], assignees: [], url: 'u' }],
      merged: [{ number: 2234, headRefName: 'x', body: 'Refs #2220' }],
      open: [],
    });
    const result = await reconcile('/repo', { activeAgentIssueNums: new Set([2220]) });
    expect(result.zombies).toHaveLength(0);
    expect(result.live.map((l) => l.number)).toEqual([2220]);
  });

  it('no merged PR and no live claim → STALLED (not healed here)', async () => {
    mockGh({
      issues: [{ number: 2220, title: 't', labels: [{ name: 'in-progress' }], assignees: [{ login: 'atomantic' }], url: 'u' }],
      merged: [],
      open: [],
    });
    const result = await reconcile('/repo');
    expect(result.zombies).toHaveLength(0);
    expect(result.stalled.map((s) => s.number)).toEqual([2220]);
  });

  it('returns null (skip, do not park) when there is no origin / no host', async () => {
    getOriginInfo.mockResolvedValue({ isGithub: false, host: null, fullName: null });
    readOriginRemoteUrl.mockResolvedValue(null);
    const result = await reconcile('/repo');
    expect(result).toBeNull();
  });

  it('returns null (skip) on an unsupported forge (neither GitHub nor GitLab)', async () => {
    // A parseable non-forge remote (e.g. bitbucket) — has a fullName but no
    // gh/glab gatherer, so the scan skips without parking.
    getOriginInfo.mockResolvedValue({ isGithub: false, host: 'bitbucket.org', fullName: 'team/proj' });
    readOriginRemoteUrl.mockResolvedValue('git@bitbucket.org:team/proj.git');
    const result = await reconcile('/repo');
    expect(result).toBeNull();
    expect(execGh).not.toHaveBeenCalled();
    expect(execGlabJson).not.toHaveBeenCalled();
  });

  it('scans a GitHub Enterprise host (isGithub=false) via a host-qualified --repo selector', async () => {
    // isGithub is github.com-only, but github.acme.example classifies as GitHub —
    // the scan must run and target HOST/OWNER/REPO so gh hits the enterprise repo
    // rather than defaulting a bare OWNER/REPO to github.com.
    getOriginInfo.mockResolvedValue({ isGithub: false, host: 'github.acme.example', fullName: 'acme/app' });
    readOriginRemoteUrl.mockResolvedValue('git@github.acme.example:acme/app.git');
    // Assigned, so the identity probe actually fires (it is skipped when no
    // in-progress issue is held by anyone).
    mockGh({
      issues: [{ number: 42, title: 't', labels: [{ name: 'in-progress' }], assignees: [{ login: 'someone' }], url: 'u' }],
      merged: [{ number: 50, headRefName: 'x', body: 'Refs #42' }],
      open: [],
    });
    execGit.mockResolvedValue({ stdout: '', exitCode: 0 });

    const result = await reconcile('/repo');
    expect(result.forge).toBe('github');
    expect(result.fullName).toBe('acme/app');
    expect(result.zombies.map((z) => z.number)).toEqual([42]);
    // Every repo-targeting call carries the host-qualified selector, and the
    // identity probe — which takes no `--repo` — carries the same host, so it
    // resolves the ENTERPRISE login rather than a github.com one.
    const argvs = execGh.mock.calls.map(([argv]) => argv);
    expect(argvs.filter((a) => a.includes('--repo'))
      .every((a) => a[a.indexOf('--repo') + 1] === 'github.acme.example/acme/app')).toBe(true);
    expect(argvs.find((a) => a[0] === 'api' && a.at(-1) === 'user'))
      .toEqual(expect.arrayContaining(['--hostname', 'github.acme.example']));
  });

  it('keys every periodic GitHub read by its repository selector', async () => {
    mockGh({ issues: [], merged: [], open: [] });

    const result = await gatherIssueState('/repo');

    expect(result).not.toBeNull();
    const periodicReads = execGh.mock.calls.filter(([argv]) => argv[0] === 'issue' || argv[0] === 'pr');
    expect(periodicReads).toHaveLength(3);
    for (const [, , options] of periodicReads) {
      expect(options).toEqual({ backoffKey: 'github.com/atomantic/PortOS' });
    }
  });

  it('scans a custom-hostname self-hosted forge when the app pins workTracker (issue #3767)', async () => {
    // Neither `github.*` nor `gitlab.*` — no hostname heuristic can classify a
    // self-hosted forge, so the app's own pin is the only signal. Without the
    // `app` handoff this repo reads as "not a forge" and the zombie scan skips
    // silently, while the app's Issues tab lists the very same issues.
    getOriginInfo.mockResolvedValue({ isGithub: false, host: 'git.example-corp.com', fullName: 'acme/widget' });
    readOriginRemoteUrl.mockResolvedValue('git@git.example-corp.com:acme/widget.git');
    mockGh({
      issues: [{ number: 42, title: 't', labels: [{ name: 'in-progress' }], assignees: [{ login: 'atomantic' }], url: 'u' }],
      merged: [{ number: 50, headRefName: 'x', body: 'Refs #42' }],
      open: [],
    });

    // Same repo, no pin → skip (the pre-fix behavior, kept honest here).
    expect(await reconcile('/repo')).toBeNull();

    const result = await reconcile('/repo', { app: { repoPath: '/repo', workTracker: 'github' } });
    expect(result.forge).toBe('github');
    expect(result.zombies.map((z) => z.number)).toEqual([42]);
    expect(execGh.mock.calls.map(([argv]) => argv).filter((a) => a.includes('--repo'))
      .every((a) => a[a.indexOf('--repo') + 1] === 'git.example-corp.com/acme/widget')).toBe(true);
  });

  it('scans a custom-hostname self-hosted GitLab when the app pins workTracker (issue #3767)', async () => {
    getOriginInfo.mockResolvedValue({ isGithub: false, host: 'git.example-corp.com', fullName: 'acme/widget' });
    readOriginRemoteUrl.mockResolvedValue('git@git.example-corp.com:acme/widget.git');
    mockGlab({
      issues: [{ iid: 42, title: 't', labels: ['in-progress'], assignees: [{ username: 'adam' }], web_url: 'u' }],
      merged: [{ iid: 7, source_branch: 'claim/issue-42', description: 'Refs #42', web_url: 'm' }],
      open: [],
    });

    const result = await reconcile('/repo', { app: { repoPath: '/repo', workTracker: 'gitlab' } });
    expect(result.forge).toBe('gitlab');
    expect(result.zombies.map((z) => z.number)).toEqual([42]);
    // glab is cwd-routed — it must run in the scanned checkout.
    expect(execGlabJson.mock.calls[0][1]).toBe('/repo');
  });

  it('still scans a plan-tracked app on a forge origin (a zombie is a fact about the repo, not about where claims are filed)', async () => {
    // Deliberately NOT the Issues tab's gate: the tab must show only what its
    // Claim button acts on, but refusing to scan here would park a scheduled
    // issue-reconcile task that reconciles this repo fine today.
    mockGh({
      issues: [{ number: 42, title: 't', labels: [{ name: 'in-progress' }], assignees: [{ login: 'atomantic' }], url: 'u' }],
      merged: [{ number: 50, headRefName: 'x', body: 'Refs #42' }],
      open: [],
    });
    const result = await reconcile('/repo', { app: { repoPath: '/repo', workTracker: 'plan' } });
    expect(result.forge).toBe('github');
    expect(result.zombies.map((z) => z.number)).toEqual([42]);
  });

  it('returns null (transient) when the issue list query fails', async () => {
    execGh.mockImplementation(async (argv) => {
      if (argv[0] === 'issue') return null; // load-bearing query failed
      return '[]';
    });
    const result = await reconcile('/repo');
    expect(result).toBeNull();
  });

  it('excludes outsider-authored zombies and abandoned claims while retaining external live PR protection', async () => {
    mockGh({
      issues: [
        { number: 7, author: { login: 'external' }, labels: [{ name: 'in-progress' }], assignees: [{ login: 'volunteer' }], updatedAt: daysAgo(30) },
        { number: 8, author: { login: 'trusted-author' }, labels: [{ name: 'in-progress' }], assignees: [] },
      ],
      merged: [{ number: 17, body: 'Refs #7' }, { number: 18, body: 'Refs #8' }],
      open: [{ number: 20, author: { login: 'external' }, body: 'Refs #8', headRefName: 'claim/issue-8' }],
    });
    execGit.mockResolvedValue({ stdout: '', exitCode: 0 });
    const result = await reconcile('/repo', { now: NOW });
    expect(result.zombies).toEqual([]);
    expect(result.abandoned).toEqual([]);
    expect(result.live.map(issue => issue.number)).toEqual([8]);
  });

  it('empty in-progress list is a valid answer (no zombies), not a skip', async () => {
    mockGh({ issues: [], merged: [], open: [] });
    const result = await reconcile('/repo');
    expect(result).not.toBeNull();
    expect(result.zombies).toHaveLength(0);
  });
});

// --- end-to-end gather/reconcile over mocked glab + git (GitLab forge) ---

/** Point the origin at GitLab so getForgeState routes to the glab gatherer. */
function useGitlabOrigin() {
  getOriginInfo.mockResolvedValue({ isGithub: false, host: 'gitlab.com', fullName: 'group/proj' });
}

/**
 * Wire execGlabJson's three list calls by argv shape. Inputs use the RAW GitLab
 * JSON shape (iid / web_url / source_branch / description) so the test also
 * exercises the GitLab→common normalizers.
 *
 * The merged/open split keys off the `--merged` presence flag; open is glab's
 * default. See server/test/guards/runtime/gitlab.glabFlags.test.js for why there is no `--state` pair.
 */
function mockGlab({ issues = [], merged = [], open = [] }) {
  execGlabJson.mockImplementation(async (argv) => {
    if (argv[0] === 'issue' && argv[1] === 'list') return { rows: issues, reason: 'ok' };
    if (argv[0] === 'mr') return { rows: argv.includes('--merged') ? merged : open, reason: 'ok' };
    return { rows: [], reason: 'ok' };
  });
}

describe('reconcile (GitLab forge)', () => {
  beforeEach(useGitlabOrigin);

  it('flags an in-progress issue whose MR merged with no live claim as a ZOMBIE', async () => {
    mockGlab({
      issues: [{ iid: 42, title: 'GL zombie', labels: ['in-progress', 'area:api'], assignees: [{ username: 'adam' }], web_url: 'u' }],
      merged: [{ iid: 7, source_branch: 'claim/issue-42', description: 'Refs #42', web_url: 'm' }],
      open: [],
    });
    const result = await reconcile('/repo');
    expect(result.forge).toBe('gitlab');
    expect(result.zombies.map((z) => z.number)).toEqual([42]);
    expect(result.zombies[0].mergedPr.number).toBe(7);
    // GitLab labels/assignees normalize to plain strings.
    expect(result.zombies[0].labels).toContain('area:api');
    expect(result.zombies[0].assignees).toEqual(['adam']);
    expect(execGh).not.toHaveBeenCalled();
  });

  describe('saturated forge lists', () => {
    const issue = { iid: 42, title: 't', labels: ['in-progress'], assignees: [{ username: 'adam' }], created_at: daysAgo(10) };
    const fullMerged = (oldest) => Array.from({ length: 100 }, (_, i) => ({
      iid: 5000 + i, source_branch: 'x', description: 'Refs #42', merged_at: i === 99 ? oldest : daysAgo(1),
    }));

    it.each(['issues', 'open'])('withholds the whole scan when the %s page is full', async (list) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        mockGlab({
          issues: [issue], merged: [{ iid: 7, source_branch: 'x', description: 'Refs #42' }],
          [list]: Array.from({ length: 100 }, (_, i) => list === 'issues'
            ? { ...issue, iid: 42 + i }
            : { iid: 1000 + i, source_branch: `b${i}`, description: '' }),
        });
        expect(await reconcile('/repo', { now: NOW })).toBeNull();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('forge lists reached the completeness limit; withholding cleanup'));
        expect(execGlab).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it.each([daysAgo(30), daysAgo(10)])('accepts a full merged-MR window reaching the oldest claim (%s)', async (oldest) => {
      mockGlab({ issues: [issue], merged: fullMerged(oldest) });
      const result = await reconcile('/repo', { now: NOW });
      expect(result.zombies.map((z) => z.number)).toEqual([42]);
    });

    it.each([daysAgo(2), undefined, 'invalid'])('withholds a full merged-MR window without proven coverage (%s)', async (oldest) => {
      mockGlab({ issues: [issue], merged: fullMerged(oldest) });
      expect(await reconcile('/repo', { now: NOW })).toBeNull();
    });

    it('withholds a full merged-MR window when issue creation is unreadable', async () => {
      mockGlab({ issues: [{ ...issue, created_at: undefined }], merged: fullMerged(daysAgo(30)) });
      expect(await reconcile('/repo', { now: NOW })).toBeNull();
    });

    it('accepts a full merged-MR window with no in-progress issues', async () => {
      mockGlab({ merged: fullMerged(daysAgo(30)) });
      expect((await reconcile('/repo', { now: NOW })).zombies).toEqual([]);
    });
  });

  it('matches the MR by its claim/issue-<iid> source branch (head ref)', async () => {
    mockGlab({
      issues: [{ iid: 42, title: 't', labels: ['in-progress'], assignees: [{ username: 'adam' }], web_url: 'u' }],
      merged: [{ iid: 7, source_branch: 'claim/issue-42', description: 'no trailer here', web_url: 'm' }],
      open: [],
    });
    const result = await reconcile('/repo');
    expect(result.zombies.map((z) => z.number)).toEqual([42]);
  });

  it('a live open MR keeps the issue LIVE (not a zombie)', async () => {
    mockGlab({
      issues: [{ iid: 42, title: 't', labels: ['in-progress'], assignees: [], web_url: 'u' }],
      merged: [{ iid: 7, source_branch: 'x', description: 'Refs #42' }],
      open: [{ iid: 9, source_branch: 'claim/issue-42', description: '' }],
    });
    const result = await reconcile('/repo');
    expect(result.zombies).toHaveLength(0);
    expect(result.live.map((l) => l.number)).toEqual([42]);
  });

  it('a live LOCAL/REMOTE claim branch keeps the GitLab issue LIVE', async () => {
    mockGlab({
      issues: [{ iid: 42, title: 't', labels: ['in-progress'], assignees: [], web_url: 'u' }],
      merged: [{ iid: 7, source_branch: 'x', description: 'Refs #42' }],
      open: [],
    });
    execGit.mockResolvedValue({ stdout: 'refs/remotes/origin/claim/issue-42\nrefs/heads/main\n', exitCode: 0 });
    const result = await reconcile('/repo');
    expect(result.zombies).toHaveLength(0);
    expect(result.live.map((l) => l.number)).toEqual([42]);
  });

  it('no merged MR and no live claim → STALLED', async () => {
    mockGlab({
      issues: [{ iid: 42, title: 't', labels: ['in-progress'], assignees: [{ username: 'adam' }], web_url: 'u' }],
      merged: [],
      open: [],
    });
    const result = await reconcile('/repo');
    expect(result.zombies).toHaveLength(0);
    expect(result.stalled.map((s) => s.number)).toEqual([42]);
  });

  it('returns null (transient) when the glab issue list query fails', async () => {
    execGlabJson.mockImplementation(async (argv) => {
      // load-bearing query failed / glab down
      if (argv[0] === 'issue') return { rows: null, reason: 'cli-failed' };
      return { rows: [], reason: 'ok' };
    });
    const result = await reconcile('/repo');
    expect(result).toBeNull();
  });

  it('splits merged-vs-open MRs with presence flags, not a nonexistent `--state`', async () => {
    mockGlab({ issues: [], merged: [], open: [] });
    await reconcile('/repo');
    const mrCalls = execGlabJson.mock.calls.map(([argv]) => argv).filter((argv) => argv[0] === 'mr');
    expect(mrCalls).toHaveLength(2);
    for (const argv of mrCalls) expect(argv).not.toContain('--state');
    // Merged is explicit; opened is glab's default, so it carries no state flag.
    expect(mrCalls.some((argv) => argv.includes('--merged'))).toBe(true);
    expect(mrCalls.some((argv) => !argv.includes('--merged'))).toBe(true);
  });

  it('leaves the JSON output flag to execGlabJson', async () => {
    mockGlab({ issues: [], merged: [], open: [] });
    await reconcile('/repo');
    for (const [argv] of execGlabJson.mock.calls) {
      expect(argv).not.toContain('-F');
      expect(argv).not.toContain('--output');
    }
  });

  it('empty in-progress list is a valid answer (no zombies), not a skip', async () => {
    mockGlab({ issues: [], merged: [], open: [] });
    const result = await reconcile('/repo');
    expect(result).not.toBeNull();
    expect(result.forge).toBe('gitlab');
    expect(result.zombies).toHaveLength(0);
  });

  it('scans a nested subgroup remote whose owner/repo does NOT parse (getOriginInfo.fullName=null)', async () => {
    // Common GitLab layout `group/subgroup/project` — getOriginInfo's strict
    // owner/repo parse returns null, but the host still classifies as GitLab and
    // `glab` is cwd-based, so the scan must NOT be skipped. Host is classified off
    // the origin URL via the real hostFromOriginUrl. `originUrl` is part of
    // getOriginInfo's real return shape on the unparseable-remote path (see
    // gitRemote.js) — the resolver reads it rather than re-shelling to git.
    getOriginInfo.mockResolvedValue({
      isGithub: false, host: null, fullName: null,
      originUrl: 'git@gitlab.com:group/subgroup/project.git',
    });
    readOriginRemoteUrl.mockResolvedValue('git@gitlab.com:group/subgroup/project.git');
    mockGlab({
      issues: [{ iid: 42, title: 't', labels: ['in-progress'], assignees: [{ username: 'adam' }], web_url: 'u' }],
      merged: [{ iid: 7, source_branch: 'claim/issue-42', description: 'Refs #42' }],
      open: [],
    });
    const result = await reconcile('/repo');
    expect(result).not.toBeNull();
    expect(result.forge).toBe('gitlab');
    // Best-effort display name is the full subgroup project path from the URL.
    expect(result.fullName).toBe('group/subgroup/project');
    expect(result.zombies.map((z) => z.number)).toEqual([42]);
  });
});

// --- end-to-end gather/reconcile over mocked JIRA API + git (JIRA tracker) ---

const JIRA = { instanceId: 'inst1', projectKey: 'PROJ' };

/** Build a raw JIRA sprint ticket in the shape fetchMyCurrentSprintTickets returns. */
function jiraTicket({ key, status, statusCategory, summary = 't', url = 'u' }) {
  return { key, summary, status, statusCategory, url };
}

describe('reconcile (JIRA tracker)', () => {
  // JIRA has no label marker, so no reservation: its empty assignee list must not read as one.
  it('never classifies a JIRA ticket RESERVED and logs no unreadable-assignee skip', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      fetchMyCurrentSprintTickets.mockResolvedValue([jiraTicket({ key: 'PROJ-1', status: 'In Review', statusCategory: 'In Progress' })]);
      const result = await reconcile('/repo', { jira: JIRA });
      expect(result.zombies.map((z) => z.number)).toEqual(['PROJ-1']);
      expect(result.reserved).toEqual([]);
      expect(log.mock.calls.some(([msg]) => String(msg).includes('assignees unreadable'))).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  it('flags an In-Review ticket with no live claim branch as a ZOMBIE', async () => {
    fetchMyCurrentSprintTickets.mockResolvedValue([
      jiraTicket({ key: 'PROJ-42', status: 'In Review', statusCategory: 'In Progress', summary: 'JIRA zombie', url: 'https://j/PROJ-42' }),
    ]);
    execGit.mockResolvedValue({ stdout: '', exitCode: 0 }); // no claim refs
    const result = await reconcile('/repo', { jira: JIRA });
    expect(result.forge).toBe('jira');
    expect(result.fullName).toBe('PROJ');
    expect(result.zombies.map((z) => z.number)).toEqual(['PROJ-42']);
    expect(result.zombies[0].status).toBe('In Review');
    // JIRA never routes to gh/glab.
    expect(execGh).not.toHaveBeenCalled();
    expect(execGlabJson).not.toHaveBeenCalled();
  });

  it('a live claim/<KEY> branch keeps the In-Review ticket LIVE (not a zombie)', async () => {
    fetchMyCurrentSprintTickets.mockResolvedValue([
      jiraTicket({ key: 'PROJ-42', status: 'In Review', statusCategory: 'In Progress' }),
    ]);
    execGit.mockResolvedValue({ stdout: 'refs/remotes/origin/claim/PROJ-42\nrefs/heads/main\n', exitCode: 0 });
    const result = await reconcile('/repo', { jira: JIRA });
    expect(result.zombies).toHaveLength(0);
    expect(result.live.map((l) => l.number)).toEqual(['PROJ-42']);
  });

  it('an active CoS agent on the ticket keeps it LIVE', async () => {
    fetchMyCurrentSprintTickets.mockResolvedValue([
      jiraTicket({ key: 'PROJ-42', status: 'In Review', statusCategory: 'In Progress' }),
    ]);
    const result = await reconcile('/repo', { jira: JIRA, activeAgentIssueNums: new Set(['PROJ-42']) });
    expect(result.zombies).toHaveLength(0);
    expect(result.live.map((l) => l.number)).toEqual(['PROJ-42']);
  });

  it('a plain In-Progress ticket (not shipped) → STALLED, not a zombie', async () => {
    fetchMyCurrentSprintTickets.mockResolvedValue([
      jiraTicket({ key: 'PROJ-42', status: 'In Progress', statusCategory: 'In Progress' }),
    ]);
    const result = await reconcile('/repo', { jira: JIRA });
    expect(result.zombies).toHaveLength(0);
    expect(result.stalled.map((s) => s.number)).toEqual(['PROJ-42']);
  });

  it('a To Do (not started) ticket is excluded entirely', async () => {
    fetchMyCurrentSprintTickets.mockResolvedValue([
      jiraTicket({ key: 'PROJ-1', status: 'To Do', statusCategory: 'To Do' }),
    ]);
    const result = await reconcile('/repo', { jira: JIRA });
    expect(result.zombies).toHaveLength(0);
    expect(result.stalled).toHaveLength(0);
    expect(result.live).toHaveLength(0);
  });

  it('a Done (terminal) ticket is excluded so the scan converges', async () => {
    fetchMyCurrentSprintTickets.mockResolvedValue([
      jiraTicket({ key: 'PROJ-9', status: 'Done', statusCategory: 'Done' }),
    ]);
    const result = await reconcile('/repo', { jira: JIRA });
    expect(result.zombies).toHaveLength(0);
    expect(result.stalled).toHaveLength(0);
  });

  it('returns null (transient, skip) when the JIRA fetch throws', async () => {
    fetchMyCurrentSprintTickets.mockRejectedValue(new Error('JIRA down'));
    const result = await reconcile('/repo', { jira: JIRA });
    expect(result).toBeNull();
  });

  it('empty sprint is a valid answer (no zombies), not a skip', async () => {
    fetchMyCurrentSprintTickets.mockResolvedValue([]);
    const result = await reconcile('/repo', { jira: JIRA });
    expect(result).not.toBeNull();
    expect(result.forge).toBe('jira');
    expect(result.zombies).toHaveLength(0);
  });

  it('does NOT route to JIRA without explicit config (origin-host forge instead)', async () => {
    // No jira option → falls through to the GitHub forge resolved from the origin.
    mockGh({
      issues: [{ number: 2220, title: 't', labels: [{ name: 'in-progress' }], assignees: [], url: 'u' }],
      merged: [{ number: 2234, headRefName: 'x', body: 'Refs #2220' }],
      open: [],
    });
    const result = await reconcile('/repo');
    expect(result.forge).toBe('github');
    expect(fetchMyCurrentSprintTickets).not.toHaveBeenCalled();
  });
});

// #6112 — `in-progress` had three appliers and only two releasers. A volunteer
// assigned by the issue-watcher (or by the claim prompt's handoff) who never
// opened a PR matched STALLED on every pass, indefinitely.
describe('abandoned volunteer claims', () => {
  const staleIssue = (overrides = {}) => ({
    number: 2220, title: 'Fix the thing', url: 'https://example.com/i/2220',
    labels: [{ name: 'in-progress' }], assignees: [{ login: 'volunteer-a' }],
    updatedAt: daysAgo(FOREIGN_CLAIM_STALE_DAYS + 6), ...overrides,
  });

  it('classifies a stale non-owner claim with nothing shipped as ABANDONED', async () => {
    mockGh({ issues: [staleIssue()], merged: [], open: [] });
    const result = await reconcile('/repo', { now: NOW });
    expect(result.abandoned.map((a) => a.number)).toEqual([2220]);
    expect(result.stalled).toHaveLength(0);
    expect(result.repoSpec).toBe('github.com/atomantic/PortOS');
  });

  // A scheduler tick over a repo with no held in-progress issue has nothing to
  // classify as foreign, so it must not spend a `gh api user` call to find that out.
  it('does not probe the viewer identity when no in-progress issue is assigned', async () => {
    mockGh({ issues: [staleIssue({ assignees: [] })], merged: [], open: [] });
    await reconcile('/repo', { now: NOW });
    expect(execGh.mock.calls.some(([argv]) => argv[0] === 'api' && argv[1] === 'user')).toBe(false);
  });

  it('leaves a claim held by this install STALLED, however old', async () => {
    mockGh({ issues: [staleIssue({ assignees: [{ login: 'AtomAntic' }] })], merged: [], open: [] });
    const result = await reconcile('/repo', { now: NOW });
    expect(result.abandoned).toHaveLength(0);
    expect(result.stalled.map((sIssue) => sIssue.number)).toEqual([2220]);
  });

  // #16599 — an unassigned in-progress issue is a reservation. A swarm that died
  // leaves it stranded, so past the same stale gate it is released like a claim.
  it('releases an unassigned in-progress issue once it is stale (an expired reservation)', async () => {
    mockGh({ issues: [staleIssue({ assignees: [] })], merged: [], open: [] });
    const result = await reconcile('/repo', { now: NOW });
    expect(result.abandoned.map((a) => [a.number, a.state])).toEqual([[2220, 'RESERVED']]);
    expect(result.reserved).toHaveLength(0);
    expect(result.stalled).toHaveLength(0);
  });

  // The load-bearing degrade: an unresolved identity must not read as "every
  // assignee is a foreigner" and unassign a live claim on an auth blip.
  it('never abandons anything when gh cannot resolve the viewer login', async () => {
    mockGh({ issues: [staleIssue()], merged: [], open: [], owner: null });
    const result = await reconcile('/repo', { now: NOW });
    expect(result.ownerLogin).toBeNull();
    expect(result.abandoned).toHaveLength(0);
    expect(result.stalled).toHaveLength(1);
  });

  // GitLab resolves no owner login on purpose: both flows that CREATE a
  // volunteer claim are gh-only, so there is nothing here to release.
  it('never abandons a GitLab issue', async () => {
    getOriginInfo.mockResolvedValue({ isGithub: false, host: 'gitlab.com', fullName: 'g/p' });
    readOriginRemoteUrl.mockResolvedValue('git@gitlab.com:g/p.git');
    execGlabJson.mockImplementation(async (argv) => (argv[0] === 'issue'
      ? { rows: [{ iid: 7, title: 't', labels: ['in-progress'], assignees: [{ username: 'volunteer-a' }], web_url: 'u', updated_at: daysAgo(400) }], reason: 'ok' }
      : { rows: [], reason: 'ok' }));
    const result = await reconcile('/repo', { now: NOW });
    expect(result.forge).toBe('gitlab');
    expect(result.abandoned).toHaveLength(0);
    expect(result.stalled).toHaveLength(1);
  });
});

// #16599 — the gather→classify boundary for a swarm reservation.
describe('swarm reservations (in-progress, no assignee)', () => {
  const issue = (overrides = {}) => ({
    number: 2220, title: 't', url: 'u', labels: [{ name: 'in-progress' }],
    assignees: [], updatedAt: daysAgo(1), ...overrides,
  });
  // A sibling PR that only mentions the issue — what made a reservation look shipped.
  const mention = [{ number: 2234, headRefName: 'next/issue-2219', body: 'Also unblocks #2220.', url: 'p' }];

  it('keeps a fresh reservation out of the zombie set the coordinator receives', async () => {
    mockGh({ issues: [issue()], merged: mention, open: [] });
    const result = await reconcile('/repo', { now: NOW });
    expect(result.zombies).toEqual([]);
    expect(result.abandoned).toEqual([]);
    expect(result.reserved.map((r) => [r.number, r.state])).toEqual([[2220, 'RESERVED']]);
    expect(result.reserved[0].hasMergedPr).toBe(true);
  });

  it('still heals the same facts as a ZOMBIE when the issue is assigned', async () => {
    mockGh({ issues: [issue({ assignees: [{ login: 'atomantic' }] })], merged: mention, open: [] });
    const result = await reconcile('/repo', { now: NOW });
    expect(result.zombies.map((z) => z.number)).toEqual([2220]);
    expect(result.reserved).toEqual([]);
  });

  it('releases a stale reservation by unlabel + comment, never a close', async () => {
    mockGh({ issues: [issue({ updatedAt: daysAgo(FOREIGN_CLAIM_STALE_DAYS) })], merged: mention, open: [] });
    const result = await reconcile('/repo', { now: NOW });
    expect(result.zombies).toEqual([]);
    expect(result.abandoned.map((a) => a.number)).toEqual([2220]);

    execGh.mockReset();
    execGh.mockResolvedValue('');
    const released = await releaseAbandonedClaims(result.abandoned, {
      forge: result.forge, repoSpec: result.repoSpec, fullName: result.fullName,
    });
    expect(released).toBe(1);
    const argvs = execGh.mock.calls.map(([argv]) => argv);
    expect(argvs).toHaveLength(2);
    expect(argvs[0]).toEqual(['issue', 'edit', '2220', '--repo', 'github.com/atomantic/PortOS', '--remove-label', 'in-progress']);
    expect(argvs[1].slice(0, 3)).toEqual(['issue', 'comment', '2220']);
    expect(argvs[1].at(-1)).toContain('reservation');
    expect(argvs[1].at(-1)).toContain(`${FOREIGN_CLAIM_STALE_DAYS} days`);
    expect(argvs.some((argv) => argv.includes('close'))).toBe(false);
  });

  // #16623 — a failed unlabel must leave the issue as stale as it was, for both release kinds.
  it.each([
    ['an expired reservation', { assignees: [] }, 'RESERVED'],
    ['an abandoned foreign claim', { assignees: [{ login: 'volunteer-a' }] }, 'ABANDONED'],
  ])('retries %s on the next pass after a failed unlabel', async (_name, overrides, state) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const staleUpdatedAt = daysAgo(FOREIGN_CLAIM_STALE_DAYS + 1);
      let updatedAt = staleUpdatedAt;
      let editFails = true;
      execGh.mockImplementation(async (argv) => {
        if (argv[0] === 'issue' && argv[1] === 'list') {
          return JSON.stringify([{ number: 2220, title: 't', url: 'u', labels: [{ name: 'in-progress' }], updatedAt, author: { login: 'trusted-author' }, ...overrides }]);
        }
        if (argv[0] === 'pr' && argv.includes('merged')) return '[]';
        if (argv[0] === 'api' && argv.at(-1) === 'user') return JSON.stringify({ login: 'atomantic' });
        if (argv[0] === 'api' && argv.at(-1).endsWith('/permission')) return JSON.stringify({ permission: 'write', user: { login: 'trusted-author' } });
        if (argv[0] === 'issue' && argv[1] === 'comment') { updatedAt = new Date(NOW).toISOString(); return ''; }
        if (argv[0] === 'issue' && argv[1] === 'edit' && editFails) throw new Error('HTTP 502');
        return '[]';
      });
      const ctxOf = (r) => ({ forge: r.forge, repoSpec: r.repoSpec, fullName: r.fullName });

      const first = await reconcile('/repo', { now: NOW });
      expect(first.abandoned.map((a) => [a.number, a.state])).toEqual([[2220, state]]);
      expect(await releaseAbandonedClaims(first.abandoned, ctxOf(first))).toBe(0);
      expect(updatedAt).toBe(staleUpdatedAt);

      const second = await reconcile('/repo', { now: NOW });
      expect(second.abandoned.map((a) => [a.number, a.state])).toEqual([[2220, state]]);
      editFails = false;
      expect(await releaseAbandonedClaims(second.abandoned, ctxOf(second))).toBe(1);
    } finally {
      error.mockRestore();
    }
  });

  it('never releases a reservation whose activity time is unresolved', async () => {
    mockGh({ issues: [issue({ updatedAt: undefined })], merged: mention, open: [] });
    const result = await reconcile('/repo', { now: NOW });
    expect(result.reserved.map((r) => [r.number, r.staleDays])).toEqual([[2220, null]]);
    expect(result.abandoned).toEqual([]);
  });

  it('a missing assignee field is not "no assignees": classifies as before and logs on stdout', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      execGh.mockImplementation(async (argv) => {
        if (argv[0] === 'issue' && argv[1] === 'list') {
          return JSON.stringify([{ number: 2220, title: 't', url: 'u', labels: [{ name: 'in-progress' }], updatedAt: daysAgo(30), author: { login: 'trusted-author' } }]);
        }
        if (argv[0] === 'pr' && argv.includes('merged')) return JSON.stringify(mention);
        if (argv[0] === 'api' && argv.at(-1).endsWith('/permission')) return JSON.stringify({ permission: 'write', user: { login: 'trusted-author' } });
        return '[]';
      });
      const result = await reconcile('/repo', { now: NOW });
      expect(result.zombies.map((z) => [z.number, z.hasAssignee])).toEqual([[2220, null]]);
      expect(result.reserved).toEqual([]);
      expect(result.abandoned).toEqual([]);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/^⏭️ issue-reconcile: assignees unreadable for #2220/));
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore(); warn.mockRestore(); error.mockRestore();
    }
  });

  describe('GitLab', () => {
    beforeEach(useGitlabOrigin);
    const glIssue = (overrides = {}) => ({ iid: 42, title: 't', labels: ['in-progress'], web_url: 'u', updated_at: daysAgo(1), ...overrides });
    const glMention = [{ iid: 7, source_branch: 'x', description: 'Also unblocks #42.' }];

    it('an unassigned GitLab issue is a reservation, not a zombie', async () => {
      mockGlab({ issues: [glIssue({ assignees: [] })], merged: glMention, open: [] });
      const result = await reconcile('/repo', { now: NOW });
      expect(result.zombies).toEqual([]);
      expect(result.reserved.map((r) => r.number)).toEqual([42]);
    });

    it('reads the legacy single `assignee` field when `assignees` is absent', async () => {
      mockGlab({ issues: [glIssue({ assignee: { username: 'adam' } }), { ...glIssue({ assignee: null }), iid: 43 }], merged: [...glMention, { iid: 8, source_branch: 'y', description: '#43' }], open: [] });
      const result = await reconcile('/repo', { now: NOW });
      expect(result.zombies.map((z) => z.number)).toEqual([42]);
      expect(result.reserved.map((r) => r.number)).toEqual([43]);
    });

    it('neither assignee field → unresolved, classified as before', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        mockGlab({ issues: [glIssue()], merged: glMention, open: [] });
        const result = await reconcile('/repo', { now: NOW });
        expect(result.zombies.map((z) => z.number)).toEqual([42]);
        expect(log).toHaveBeenCalledWith(expect.stringContaining('assignees unreadable for #42'));
      } finally {
        log.mockRestore();
      }
    });

    // #16608 — the gather → release boundary on GitLab, where `glab` is cwd-routed.
    const release = (result) => releaseAbandonedClaims(result.abandoned, {
      forge: result.forge, repoSpec: result.repoSpec, fullName: result.fullName, repoPath: '/repo',
    });
    const glabWrites = () => execGlab.mock.calls.map(([argv, cwd]) => [argv, cwd]);

    it('releases a stale reservation with one unlabel and one note, never a close', async () => {
      mockGlab({ issues: [glIssue({ assignees: [], updated_at: daysAgo(FOREIGN_CLAIM_STALE_DAYS) })], merged: glMention, open: [] });
      const result = await reconcile('/repo', { now: NOW });
      expect(result.zombies).toEqual([]);
      expect(result.abandoned.map((a) => [a.number, a.state])).toEqual([[42, 'RESERVED']]);

      expect(await release(result)).toBe(1);
      const writes = glabWrites();
      expect(writes).toHaveLength(2);
      expect(writes[0][0]).toEqual(['issue', 'update', '42', '--unlabel', 'in-progress']);
      expect(writes[1][0].slice(0, 4)).toEqual(['issue', 'note', '42', '--message']);
      expect(writes[1][0].at(-1)).toContain('reservation');
      expect(writes[1][0].at(-1)).toContain(`${FOREIGN_CLAIM_STALE_DAYS} days`);
      expect(writes.every(([, cwd]) => cwd === '/repo')).toBe(true);
      expect(writes.some(([argv]) => argv.includes('close'))).toBe(false);
      expect(execGh).not.toHaveBeenCalled();
    });

    it('holds a fresh reservation: nothing to release, nothing written', async () => {
      mockGlab({ issues: [glIssue({ assignees: [], updated_at: daysAgo(FOREIGN_CLAIM_STALE_DAYS - 1) })], merged: [], open: [] });
      const result = await reconcile('/repo', { now: NOW });
      expect(result.reserved.map((r) => r.number)).toEqual([42]);
      expect(await release(result)).toBe(0);
      expect(execGlab).not.toHaveBeenCalled();
    });

    it('never releases a reservation whose activity time is unresolved', async () => {
      mockGlab({ issues: [glIssue({ assignees: [], updated_at: undefined })], merged: [], open: [] });
      const result = await reconcile('/repo', { now: NOW });
      expect(result.reserved.map((r) => [r.number, r.staleDays])).toEqual([[42, null]]);
      expect(await release(result)).toBe(0);
      expect(execGlab).not.toHaveBeenCalled();
    });

    it('an unreadable assignee list is not "no assignee": a stale issue is never released', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        mockGlab({ issues: [glIssue({ updated_at: daysAgo(400) })], merged: [], open: [] });
        const result = await reconcile('/repo', { now: NOW });
        expect(result.stalled.map((s) => [s.number, s.hasAssignee])).toEqual([[42, null]]);
        expect(await release(result)).toBe(0);
        expect(execGlab).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
      }
    });

    it('a failed note still counts as released once the label is gone', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        mockGlab({ issues: [glIssue({ assignees: [], updated_at: daysAgo(30) })], merged: [], open: [] });
        const result = await reconcile('/repo', { now: NOW });
        execGlab.mockImplementation(async (argv) => (argv[1] === 'note' ? null : ''));
        expect(await release(result)).toBe(1);
        expect(glabWrites().map(([argv]) => argv[1])).toEqual(['update', 'note']);
      } finally {
        error.mockRestore();
      }
    });

    // A note would refresh `updated_at`, making the next scan read the reservation as fresh.
    it('a failed unlabel writes no note and reports 0, so the next scan retries it', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        mockGlab({ issues: [glIssue({ assignees: [], updated_at: daysAgo(30) })], merged: [], open: [] });
        execGlab.mockImplementation(async (argv) => (argv[1] === 'update' ? null : ''));
        expect(await release(await reconcile('/repo', { now: NOW }))).toBe(0);
        expect(glabWrites().map(([argv]) => argv[1])).toEqual(['update']);

        execGlab.mockReset();
        execGlab.mockResolvedValue('');
        const next = await reconcile('/repo', { now: NOW });
        expect(next.abandoned.map((a) => a.number)).toEqual([42]);
        expect(await release(next)).toBe(1);
      } finally {
        error.mockRestore();
      }
    });

    it('withholds the scan while the open-MR page is full (an unseen MR may own a reservation)', async () => {
      const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const fullPage = Array.from({ length: 100 }, (_, i) => ({ iid: 1000 + i, source_branch: `b${i}`, description: '' }));
        mockGlab({ issues: [glIssue({ assignees: [], updated_at: daysAgo(30) })], merged: [], open: fullPage });
        const result = await reconcile('/repo', { now: NOW });
        expect(result).toBeNull();
        expect(execGlab).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalledWith(expect.stringContaining('forge lists reached the completeness limit; withholding cleanup'));

        mockGlab({ issues: [glIssue({ assignees: [], updated_at: daysAgo(30) })], merged: [], open: fullPage.slice(1) });
        expect((await reconcile('/repo', { now: NOW })).abandoned.map((a) => a.number)).toEqual([42]);
      } finally {
        log.mockRestore();
      }
    });
  });
});

describe('releaseAbandonedClaims', () => {
  const abandoned = [{ number: 2220, title: 't', url: 'u', assignees: ['volunteer-a'], staleDays: 20 }];
  const ctx = { forge: 'github', repoSpec: 'github.com/o/r', fullName: 'o/r' };

  it('strips the marker and the stale assignee in one edit, then comments', async () => {
    execGh.mockResolvedValue('');
    const released = await releaseAbandonedClaims(abandoned, ctx);
    expect(released).toBe(1);
    const [editArgs, commentArgs] = execGh.mock.calls.map(([argv]) => argv);
    expect(execGh).toHaveBeenCalledTimes(2);
    expect(commentArgs.slice(0, 4)).toEqual(['issue', 'comment', '2220', '--repo']);
    expect(commentArgs.at(-1)).toContain('20 days');
    expect(editArgs).toEqual([
      'issue', 'edit', '2220', '--repo', 'github.com/o/r',
      '--remove-label', 'in-progress', '--remove-assignee', 'volunteer-a',
    ]);
  });

  // The comment is courtesy; the release is the point. A repo with issue
  // comments locked must still get its marker back, and the miss is not an error.
  it('still releases when the courtesy comment fails, logged on stdout', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      execGh.mockImplementation(async (argv) => {
        if (argv[1] === 'comment') throw new Error('HTTP 403');
        return '';
      });
      expect(await releaseAbandonedClaims(abandoned, ctx)).toBe(1);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/^⏭️ issue-reconcile: released #2220 .* but could not comment/));
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore(); error.mockRestore();
    }
  });

  // A comment refreshes updatedAt, so commenting after a failed edit would hide the
  // issue from the next scan for a full stale window.
  it('reports zero and posts no comment when the edit fails, so the next pass retries', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      execGh.mockImplementation(async (argv) => {
        if (argv[1] === 'edit') throw new Error('HTTP 500');
        return '';
      });
      expect(await releaseAbandonedClaims(abandoned, ctx)).toBe(0);
      expect(execGh.mock.calls.some(([argv]) => argv[1] === 'comment')).toBe(false);
    } finally {
      error.mockRestore();
    }
  });

  it('writes nothing for a non-GitHub forge or an empty set', async () => {
    execGh.mockResolvedValue('');
    expect(await releaseAbandonedClaims(abandoned, { ...ctx, forge: 'gitlab' })).toBe(0);
    expect(await releaseAbandonedClaims([], ctx)).toBe(0);
    expect(await releaseAbandonedClaims(abandoned, { ...ctx, repoSpec: null })).toBe(0);
    expect(execGh).not.toHaveBeenCalled();
  });

  // GitLab has no ABANDONED state, and glab needs the checkout it resolves the project from.
  it('on GitLab releases only a reservation, and only with a repo path', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const gl = { forge: 'gitlab', repoSpec: null, fullName: 'g/p', repoPath: '/repo' };
      expect(await releaseAbandonedClaims([{ ...abandoned[0], state: 'ABANDONED' }], gl)).toBe(0);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/^⏭️ issue-reconcile: not releasing #2220/));
      expect(await releaseAbandonedClaims([{ ...abandoned[0], state: 'RESERVED' }], { ...gl, repoPath: undefined })).toBe(0);
      expect(execGlab).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});

describe('gatherIssueState carries labels/assignees for the follow-up', () => {
  it('surfaces area labels + assignees on the zombie record', async () => {
    mockGh({
      issues: [{ number: 2220, title: 't', labels: [{ name: 'in-progress' }, { name: 'area:create' }], assignees: [{ login: 'atomantic' }], url: 'u' }],
      merged: [{ number: 2234, headRefName: 'x', body: 'Refs #2220' }],
      open: [],
    });
    const gathered = await gatherIssueState('/repo');
    expect(gathered.issues[0].labels).toContain('area:create');
    expect(gathered.issues[0].assignees).toEqual(['atomantic']);
  });
});

// #3358 — "the forge said there is nothing" vs "we could not ask the forge".
// Collapsing the two here is worse than elsewhere: this reconciler CLOSES issues
// and strips their `in-progress` label, so an empty answer it never got would
// unlabel a claim that is live on a peer right now.
describe('unreachable forge (#3358)', () => {
  it('skips the scan when the gh probe is not ok, without issuing a single gh call', async () => {
    ensureForgeReachableMock.mockResolvedValueOnce({ ok: false, status: 'unreachable', detail: 'dial tcp' });
    const gathered = await gatherIssueState('/repo');
    expect(gathered).toBeNull();
    expect(execGh).not.toHaveBeenCalled();
  });

  it('fails the scan when the merged-PR list is unavailable (never treats it as "nothing shipped")', async () => {
    execGh.mockImplementation(async (argv) => {
      if (argv[0] === 'issue') return JSON.stringify([{ number: 1, title: 't', labels: [], assignees: [], url: 'u' }]);
      if (argv.includes('merged')) throw new Error('connect: bad file descriptor');
      return '[]';
    });
    expect(await gatherIssueState('/repo')).toBeNull();
  });

  it('fails the scan when the OPEN-PR list is unavailable — an open PR is what proves a claim is live', async () => {
    execGh.mockImplementation(async (argv) => {
      if (argv[0] === 'issue') return JSON.stringify([{ number: 1, title: 't', labels: [], assignees: [], url: 'u' }]);
      if (argv.includes('open')) throw new Error('connect: bad file descriptor');
      return '[]';
    });
    expect(await gatherIssueState('/repo')).toBeNull();
  });

  it('still scans when every list is ANSWERED but empty', async () => {
    mockGh({ issues: [], merged: [], open: [] });
    const gathered = await gatherIssueState('/repo');
    expect(gathered).not.toBeNull();
    expect(gathered.issues).toEqual([]);
  });
});

describe('zombieSignature', () => {
  it('is order-independent and keys on issue+merged PR', () => {
    const a = zombieSignature([{ number: 2, mergedPr: { number: 20 } }, { number: 1, mergedPr: { number: 10 } }]);
    const b = zombieSignature([{ number: 1, mergedPr: { number: 10 } }, { number: 2, mergedPr: { number: 20 } }]);
    expect(a).toBe(b);
    expect(a).toBe('1:10|2:20');
  });
  it('changes when a zombie is healed away', () => {
    const before = zombieSignature([{ number: 1, mergedPr: { number: 10 } }, { number: 2, mergedPr: { number: 20 } }]);
    const after = zombieSignature([{ number: 2, mergedPr: { number: 20 } }]);
    expect(before).not.toBe(after);
  });
  it('keys a JIRA zombie on its KEY + status (no merged PR number)', () => {
    const sig = zombieSignature([{ number: 'PROJ-42', status: 'In Review' }]);
    expect(sig).toBe('PROJ-42:In Review');
  });
  it('a JIRA status change is progress (signature changes)', () => {
    const before = zombieSignature([{ number: 'PROJ-42', status: 'In Review' }]);
    const after = zombieSignature([{ number: 'PROJ-42', status: 'Done' }]);
    expect(before).not.toBe(after);
  });
});

describe('formatZombiesForPrompt', () => {
  it('lists each zombie factually with its merged PR', () => {
    const md = formatZombiesForPrompt(
      [{ number: 2220, title: 'CDO', url: 'u', mergedPr: { number: 2234, url: 'p' } }],
      { fullName: 'atomantic/PortOS', autoClose: true }
    );
    expect(md).toContain('#2220');
    expect(md).not.toContain('CDO');
    expect(md).toContain('merged PR #2234');
  });
  it('autoClose:true surfaces the close+file-new arm in the header directive', () => {
    const md = formatZombiesForPrompt(
      [{ number: 2220, title: 'CDO', url: 'u', mergedPr: { number: 2234 } }],
      { fullName: 'atomantic/PortOS', autoClose: true }
    );
    expect(md).toContain('autoClose is ON');
    expect(md).toContain('file a scoped follow-up');
  });
  it('autoClose:false forbids closing — comment+release only', () => {
    const md = formatZombiesForPrompt(
      [{ number: 2220, title: 'CDO', url: 'u', mergedPr: { number: 2234 } }],
      { fullName: 'atomantic/PortOS', autoClose: false }
    );
    expect(md).toContain('autoClose is OFF');
    expect(md).toContain('never close an issue or file a follow-up');
  });
  it('defaults to the GitHub forge header (gh) when forge is omitted', () => {
    const md = formatZombiesForPrompt(
      [{ number: 2220, title: 'CDO', url: 'u', mergedPr: { number: 2234, url: 'p' } }],
      { fullName: 'atomantic/PortOS', autoClose: true }
    );
    expect(md).toContain('GitHub (use `gh`)');
    expect(md).toContain('merged PR #2234');
  });
  it('renders a GitLab header + "MR" wording when forge is gitlab', () => {
    const md = formatZombiesForPrompt(
      [{ number: 42, title: 'GL', url: 'u', mergedPr: { number: 7, url: 'm' } }],
      { fullName: 'group/proj', forge: 'gitlab', autoClose: true }
    );
    expect(md).toContain('GitLab (use `glab`)');
    expect(md).toContain('merged MR #7');
    expect(md).not.toContain('merged PR');
  });
  it('renders a JIRA header + status-based wording when forge is jira', () => {
    const md = formatZombiesForPrompt(
      [{ number: 'PROJ-42', title: 'JIRA zombie', url: 'https://j/PROJ-42', status: 'In Review' }],
      { fullName: 'PROJ', forge: 'jira', autoClose: true, projectKey: 'PROJ', instanceId: 'inst1' }
    );
    expect(md).toContain('JIRA (use the PortOS JIRA API)');
    expect(md).toContain('PROJ-42');
    expect(md).toContain('Current status: In Review');
    expect(md).toContain('inst1');
    // No forge-CLI PR/MR wording.
    expect(md).not.toContain('merged PR');
    expect(md).not.toContain('use `gh`');
  });
  it('JIRA autoClose:false forbids Done/follow-up — comment + move back only', () => {
    const md = formatZombiesForPrompt(
      [{ number: 'PROJ-42', title: 't', url: 'u', status: 'In Review' }],
      { fullName: 'PROJ', forge: 'jira', autoClose: false, projectKey: 'PROJ', instanceId: 'inst1' }
    );
    expect(md).toContain('autoClose is OFF');
    expect(md).toContain('never transition a ticket to Done');
  });
});
