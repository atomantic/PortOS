/**
 * Unit tests for the Issue Reconciler deterministic core.
 *
 * - issueNumberFromRef / bodyReferencesIssue / prReferencesIssue — the boundary-
 *   safe reference matchers (no `issue-222` matching inside `issue-2220`).
 * - classifyIssue / classifyIssues — the pure ZOMBIE/LIVE/STALLED state machine.
 * - reconcile / gatherIssueState — end-to-end over mocked gh + git: an
 *   in-progress issue with a merged PR and no live claim is a ZOMBIE; an open PR
 *   or a live claim branch or an active agent keeps it LIVE.
 * - zombieSignature / formatZombiesForPrompt — the convergence signature and the
 *   autoClose-aware prompt body.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/execGit.js', () => ({
  execGit: vi.fn(async () => ({ stdout: '', exitCode: 0 })),
}));
vi.mock('./github.js', () => ({ execGh: vi.fn(async () => '[]') }));
vi.mock('../lib/gitRemote.js', () => ({
  getOriginInfo: vi.fn(async () => ({ isGithub: true, fullName: 'atomantic/PortOS' })),
}));
vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { root: '/repo' },
  safeJSONParse: (raw, fallback) => { try { return JSON.parse(raw); } catch { return fallback; } },
}));

import {
  issueNumberFromRef, bodyReferencesIssue, prReferencesIssue,
  classifyIssue, classifyIssues, reconcile, gatherIssueState,
  zombieSignature, formatZombiesForPrompt,
} from './issueReconcile.js';
import { execGit } from '../lib/execGit.js';
import { execGh } from './github.js';
import { getOriginInfo } from '../lib/gitRemote.js';

beforeEach(() => {
  vi.clearAllMocks();
  execGit.mockResolvedValue({ stdout: '', exitCode: 0 });
  getOriginInfo.mockResolvedValue({ isGithub: true, fullName: 'atomantic/PortOS' });
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

/** Wire execGh's three list calls (issue / merged pr / open pr) by argv shape. */
function mockGh({ issues = [], merged = [], open = [] }) {
  execGh.mockImplementation(async (argv) => {
    if (argv[0] === 'issue' && argv[1] === 'list') return JSON.stringify(issues);
    if (argv[0] === 'pr' && argv.includes('merged')) return JSON.stringify(merged);
    if (argv[0] === 'pr' && argv.includes('open')) return JSON.stringify(open);
    return '[]';
  });
}

describe('reconcile', () => {
  it('flags an in-progress issue whose PR merged with no live claim as a ZOMBIE', async () => {
    mockGh({
      issues: [{ number: 2220, title: 'CDO covers', labels: [{ name: 'in-progress' }], assignees: [{ login: 'atomantic' }], url: 'u' }],
      merged: [{ number: 2234, headRefName: 'feat/covers', body: 'Refs #2220', url: 'p' }],
      open: [],
    });
    execGit.mockResolvedValue({ stdout: '', exitCode: 0 }); // no claim refs

    const result = await reconcile('/repo');
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

  it('returns null (skip, do not park) on a non-GitHub remote', async () => {
    getOriginInfo.mockResolvedValue({ isGithub: false, fullName: null });
    const result = await reconcile('/repo');
    expect(result).toBeNull();
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
});
