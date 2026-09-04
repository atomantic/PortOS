/**
 * Unit tests for the Issue Reconciler deterministic core.
 *
 * - issueNumberFromRef / bodyReferencesIssue / prReferencesIssue — the boundary-
 *   safe reference matchers (no `issue-222` matching inside `issue-2220`).
 * - classifyIssue / classifyIssues — the pure ZOMBIE/LIVE/ABANDONED/STALLED state machine.
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
vi.mock('./gitlab.js', () => ({ execGlabJson: vi.fn(async () => ({ rows: [], reason: 'ok' })) }));
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
import { execGlabJson } from './gitlab.js';
import { fetchMyCurrentSprintTickets } from './jira.js';
import { getOriginInfo, readOriginRemoteUrl } from '../lib/gitRemote.js';

beforeEach(() => {
  vi.clearAllMocks();
  execGit.mockResolvedValue({ stdout: '', exitCode: 0 });
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
    if (argv[0] === 'issue' && argv[1] === 'list') return JSON.stringify(issues);
    if (argv[0] === 'pr' && argv.includes('merged')) return JSON.stringify(merged);
    if (argv[0] === 'pr' && argv.includes('open')) return JSON.stringify(open);
    if (argv[0] === 'api' && argv[1] === 'user') {
      if (owner === null) throw new Error('gh: not authenticated');
      return owner;
    }
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
      issues: [{ number: 2220, title: 't', labels: [{ name: 'in-progress' }], assignees: [], url: 'u' }],
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
    expect(argvs.find((a) => a[0] === 'api' && a[1] === 'user'))
      .toEqual(expect.arrayContaining(['--hostname', 'github.acme.example']));
  });

  it('scans a custom-hostname self-hosted forge when the app pins workTracker (issue #3767)', async () => {
    // Neither `github.*` nor `gitlab.*` — no hostname heuristic can classify a
    // self-hosted forge, so the app's own pin is the only signal. Without the
    // `app` handoff this repo reads as "not a forge" and the zombie scan skips
    // silently, while the app's Issues tab lists the very same issues.
    getOriginInfo.mockResolvedValue({ isGithub: false, host: 'git.example-corp.com', fullName: 'acme/widget' });
    readOriginRemoteUrl.mockResolvedValue('git@git.example-corp.com:acme/widget.git');
    mockGh({
      issues: [{ number: 42, title: 't', labels: [{ name: 'in-progress' }], assignees: [], url: 'u' }],
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
      issues: [{ iid: 42, title: 't', labels: ['in-progress'], assignees: [], web_url: 'u' }],
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
      issues: [{ number: 42, title: 't', labels: [{ name: 'in-progress' }], assignees: [], url: 'u' }],
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
 * default. See gitlab.glabFlags.test.js for why there is no `--state` pair.
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

  it('matches the MR by its claim/issue-<iid> source branch (head ref)', async () => {
    mockGlab({
      issues: [{ iid: 42, title: 't', labels: ['in-progress'], assignees: [], web_url: 'u' }],
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
      issues: [{ iid: 42, title: 't', labels: ['in-progress'], assignees: [], web_url: 'u' }],
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
      issues: [{ iid: 42, title: 't', labels: ['in-progress'], assignees: [], web_url: 'u' }],
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

  it('leaves an unassigned in-progress issue STALLED — there is no claim to release', async () => {
    mockGh({ issues: [staleIssue({ assignees: [] })], merged: [], open: [] });
    const result = await reconcile('/repo', { now: NOW });
    expect(result.abandoned).toHaveLength(0);
    expect(result.stalled).toHaveLength(1);
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

describe('releaseAbandonedClaims', () => {
  const abandoned = [{ number: 2220, title: 't', url: 'u', assignees: ['volunteer-a'], staleDays: 20 }];
  const ctx = { forge: 'github', repoSpec: 'github.com/o/r', fullName: 'o/r' };

  it('comments, then strips the marker and the stale assignee in one edit', async () => {
    execGh.mockResolvedValue('');
    const released = await releaseAbandonedClaims(abandoned, ctx);
    expect(released).toBe(1);
    const [commentArgs, editArgs] = execGh.mock.calls.map(([argv]) => argv);
    expect(commentArgs.slice(0, 4)).toEqual(['issue', 'comment', '2220', '--repo']);
    expect(commentArgs.at(-1)).toContain('20 days');
    expect(editArgs).toEqual([
      'issue', 'edit', '2220', '--repo', 'github.com/o/r',
      '--remove-label', 'in-progress', '--remove-assignee', 'volunteer-a',
    ]);
  });

  // The comment is courtesy; the release is the point. A repo with issue
  // comments locked must still get its marker back.
  it('still releases when the courtesy comment fails', async () => {
    execGh.mockImplementation(async (argv) => {
      if (argv[1] === 'comment') throw new Error('HTTP 403');
      return '';
    });
    expect(await releaseAbandonedClaims(abandoned, ctx)).toBe(1);
  });

  it('reports zero when the edit itself fails, so the next pass retries', async () => {
    execGh.mockImplementation(async (argv) => {
      if (argv[1] === 'edit') throw new Error('HTTP 500');
      return '';
    });
    expect(await releaseAbandonedClaims(abandoned, ctx)).toBe(0);
  });

  it('writes nothing for a non-GitHub forge or an empty set', async () => {
    execGh.mockResolvedValue('');
    expect(await releaseAbandonedClaims(abandoned, { ...ctx, forge: 'gitlab' })).toBe(0);
    expect(await releaseAbandonedClaims([], ctx)).toBe(0);
    expect(await releaseAbandonedClaims(abandoned, { ...ctx, repoSpec: null })).toBe(0);
    expect(execGh).not.toHaveBeenCalled();
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
    expect(md).toContain('CDO');
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
