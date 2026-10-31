/**
 * Unit tests for the Blocked-Issue Reconciler deterministic core.
 *
 * - parseBlockingIssueNumbers — the `Blocked by #N` line parser, narrow on
 *   purpose (must not pick up an unrelated `#N` mention elsewhere in the body).
 * - classifyBlockedIssues — pure "are ALL named blockers closed" classifier,
 *   with the absent-state-must-not-read-as-closed discipline.
 * - gatherBlockedIssueState — end-to-end over mocked gh/glab.
 * - unblockIssues — the one WRITE this module performs: comment-then-unlabel,
 *   on both forges, with failure handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const ensureForgeReachableMock = vi.fn(async () => ({ ok: true, status: 'ok', detail: null, remedy: null }));
const execGhMock = vi.fn(async () => '[]');
vi.mock('./github.js', () => ({
  execGh: (...args) => execGhMock(...args),
  ensureForgeReachable: (...args) => ensureForgeReachableMock(...args),
}));
const execGlabMock = vi.fn(async () => 'ok');
const execGlabJsonMock = vi.fn(async () => ({ rows: [], reason: 'ok' }));
vi.mock('./gitlab.js', () => ({
  execGlab: (...args) => execGlabMock(...args),
  execGlabJson: (...args) => execGlabJsonMock(...args),
}));
vi.mock('../lib/gitRemote.js', () => ({
  getOriginInfo: vi.fn(async () => ({ isGithub: true, host: 'github.com', fullName: 'atomantic/PortOS' })),
  readOriginRemoteUrl: vi.fn(async () => 'git@github.com:atomantic/PortOS.git'),
}));
// workTracker.js is intentionally NOT mocked — same rationale as
// issueReconcile.test.js: it is the canonical origin→forge classifier and its
// only effectful dependency (gitRemote.js) is mocked above.
vi.mock('../lib/fileUtils.js', () => ({
  safeJSONParse: (raw, fallback) => { try { return JSON.parse(raw); } catch { return fallback; } },
}));

import {
  parseBlockingIssueNumbers, classifyBlockedIssues, gatherBlockedIssueState, unblockIssues, BLOCKED_LABEL,
} from './blockedIssueReconcile.js';
import { getOriginInfo, readOriginRemoteUrl } from '../lib/gitRemote.js';

beforeEach(() => {
  vi.clearAllMocks();
  ensureForgeReachableMock.mockResolvedValue({ ok: true, status: 'ok', detail: null, remedy: null });
  execGhMock.mockImplementation(async args => args.at(-1) === 'user' ? JSON.stringify({ login: 'maintainer' }) : '[]');
  execGlabMock.mockResolvedValue('ok');
  execGlabJsonMock.mockResolvedValue({ rows: [], reason: 'ok' });
  getOriginInfo.mockResolvedValue({ isGithub: true, host: 'github.com', fullName: 'atomantic/PortOS' });
  readOriginRemoteUrl.mockResolvedValue('git@github.com:atomantic/PortOS.git');
});

describe('parseBlockingIssueNumbers', () => {
  it('parses a single blocker', () => {
    expect(parseBlockingIssueNumbers('Some text\nBlocked by #123\nmore text')).toEqual([123]);
  });
  it('parses multiple blockers on one line, comma or "and" separated', () => {
    expect(parseBlockingIssueNumbers('Blocked by #123, #456 and #789')).toEqual([123, 456, 789]);
  });
  it('is case-insensitive and tolerates a trailing colon', () => {
    expect(parseBlockingIssueNumbers('blocked BY: #42')).toEqual([42]);
  });
  it('tolerates a leading bullet/dash', () => {
    expect(parseBlockingIssueNumbers('- Blocked by #7')).toEqual([7]);
  });
  it('dedupes and sorts', () => {
    expect(parseBlockingIssueNumbers('Blocked by #9\nBlocked by #9, #3')).toEqual([3, 9]);
  });
  it('does NOT match an unrelated #N mention elsewhere in the body', () => {
    expect(parseBlockingIssueNumbers('See #123 for background.\nRelated: #456')).toEqual([]);
  });
  it('does NOT match "Refs #N" or "Related: #N" as a dependency', () => {
    expect(parseBlockingIssueNumbers('Refs #99\nRelated: #100')).toEqual([]);
  });
  it('returns [] for a body with no Blocked by line', () => {
    expect(parseBlockingIssueNumbers('Just a plain description.')).toEqual([]);
  });
  it('returns [] for an absent/empty body', () => {
    expect(parseBlockingIssueNumbers('')).toEqual([]);
    expect(parseBlockingIssueNumbers(undefined)).toEqual([]);
  });
});

describe('classifyBlockedIssues', () => {
  it('marks an issue ready when its single blocker is closed', () => {
    const [result] = classifyBlockedIssues(
      [{ number: 1, title: 'A', url: '', body: 'Blocked by #10' }],
      new Map([[10, 'closed']])
    );
    expect(result.openBlockers).toEqual([]);
    expect(result.closedBlockers).toEqual([10]);
  });
  it('keeps an issue blocked when one of several blockers is still open', () => {
    const [result] = classifyBlockedIssues(
      [{ number: 1, title: 'A', url: '', body: 'Blocked by #10, #11' }],
      new Map([[10, 'closed'], [11, 'open']])
    );
    expect(result.openBlockers).toEqual([11]);
    expect(result.closedBlockers).toEqual([10]);
  });
  it('treats a blocker with unresolved state as still open (absent must not read as closed)', () => {
    const [result] = classifyBlockedIssues(
      [{ number: 1, title: 'A', url: '', body: 'Blocked by #10' }],
      new Map() // #10's state could not be fetched
    );
    expect(result.openBlockers).toEqual([10]);
  });
  it('excludes an issue with no parsed blocker (the human/hardware case)', () => {
    const result = classifyBlockedIssues(
      [{ number: 1, title: 'A', url: '', body: 'Waiting on hardware.' }],
      new Map()
    );
    expect(result).toEqual([]);
  });
});

describe('gatherBlockedIssueState (GitHub)', () => {
  const blockedIssue = (body = 'Blocked by #10', login = 'maintainer') =>
    ({ number: 5, author: { login }, title: 'Feature X', body, url: 'u' });
  // Routes by argv: the blocked-issue list, `api repos/.../issues/N` blocker
  // lookups (value or Error per number), and the trust helper's user lookup.
  const mockGh = (list, blockers = {}) => {
    execGhMock.mockImplementation(async (args) => {
      if (args[0] === 'issue') return JSON.stringify(list);
      if (args[0] === 'api' && args[1].startsWith('repos/')) {
        const hit = blockers[Number(args[1].split('/').pop())];
        if (hit instanceof Error) throw hit;
        return hit === undefined ? '{}' : JSON.stringify(hit);
      }
      return args.at(-1) === 'user' ? JSON.stringify({ login: 'maintainer' }) : '[]';
    });
  };
  const ready = async () => (await gatherBlockedIssueState('/repo')).ready;

  it('returns ready=[] when the blocked list is empty', async () => {
    mockGh([]);
    const result = await gatherBlockedIssueState('/repo');
    expect(result.forge).toBe('github');
    expect(result.ready).toEqual([]);
    expect(execGhMock.mock.calls[0][2]).toEqual({ backoffKey: 'github.com/atomantic/PortOS' });
  });

  it('resolves a blocked issue whose named blocker is now closed', async () => {
    mockGh([blockedIssue()], { 10: { state: 'closed' } });
    expect(await ready()).toEqual([
      expect.objectContaining({ number: 5, blockingNumbers: [10], closedBlockers: [10], openBlockers: [] }),
    ]);
    const lookup = execGhMock.mock.calls.find(([args]) => args[0] === 'api' && args[1].startsWith('repos/'));
    expect(lookup[0].slice(1)).toEqual(['repos/atomantic/PortOS/issues/10', '--hostname', 'github.com']);
    expect(lookup[2]).toEqual({ backoffKey: 'github.com/atomantic/PortOS' });
  });

  it('unblocks on a merged PR blocker but not an open or closed-unmerged one', async () => {
    const pr = (state, merged_at) => ({ state, pull_request: { merged_at } });
    mockGh([blockedIssue('Blocked by #11')], { 11: pr('closed', '2026-10-01T00:00:00Z') });
    expect(await ready()).toHaveLength(1);
    mockGh([blockedIssue('Blocked by #11')], { 11: pr('open', null) });
    expect(await ready()).toEqual([]);
    mockGh([blockedIssue('Blocked by #11')], { 11: pr('closed', null) });
    expect(await ready()).toEqual([]);
  });

  it('requires every named blocker, issue or PR, to be satisfied', async () => {
    mockGh([blockedIssue('Blocked by #10, #11')], {
      10: { state: 'closed' }, 11: { state: 'open', pull_request: { merged_at: null } },
    });
    expect(await ready()).toEqual([]);
  });

  it('leaves the issue blocked when a blocker lookup fails', async () => {
    mockGh([blockedIssue('Blocked by #10, #11')], { 10: { state: 'closed' }, 11: new Error('gh blip') });
    expect(await ready()).toEqual([]);
  });

  it('does not unblock externally authored or unknown-author issues even with closed dependencies', async () => {
    mockGh([
      blockedIssue('Blocked by #10', 'external'),
      { number: 6, body: 'Blocked by #10' },
    ], { 10: { state: 'closed' } });
    expect(await ready()).toEqual([]);
  });

  it('leaves a blocked issue out of ready when its blocker is still open', async () => {
    mockGh([blockedIssue()], { 10: { state: 'open' } });
    expect(await ready()).toEqual([]);
  });

  it('returns null (skip, not "nothing to unblock") when gh is unreachable', async () => {
    ensureForgeReachableMock.mockResolvedValueOnce({ ok: false, status: 'error', detail: 'offline', remedy: null });
    const result = await gatherBlockedIssueState('/repo');
    expect(result).toBeNull();
  });

  it('returns null when the blocked-issue list call fails', async () => {
    execGhMock.mockRejectedValueOnce(new Error('gh blip'));
    const result = await gatherBlockedIssueState('/repo');
    expect(result).toBeNull();
  });

  it('returns null and warns when the blocked list fills the cap', async () => {
    const list = Array.from({ length: 200 }, (_, i) => ({ ...blockedIssue('Blocked by #10'), number: i + 1 }));
    mockGh(list, { 10: { state: 'closed' } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await gatherBlockedIssueState('/repo')).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/incomplete/i));
      expect(execGhMock.mock.calls[0][0]).toEqual(expect.arrayContaining(['--limit', '200']));
      expect(execGhMock.mock.calls.some(([args]) => args[0] === 'api')).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('gatherBlockedIssueState (GitLab)', () => {
  const glIssue = (iid, description = '') => ({ iid, title: `Issue ${iid}`, description, web_url: 'u' });
  const fullPage = (start) => Array.from({ length: 100 }, (_, i) => glIssue(start + i));

  beforeEach(() => {
    getOriginInfo.mockResolvedValue({ isGithub: false, host: 'gitlab.com', fullName: 'group/proj' });
    readOriginRemoteUrl.mockResolvedValue('git@gitlab.com:group/proj.git');
  });

  it('unblocks from glab issue view when the closed blocker is past the first list page', async () => {
    execGlabJsonMock.mockResolvedValueOnce({
      rows: [glIssue(5, 'Blocked by #250')],
      reason: 'ok',
    });
    execGlabMock.mockResolvedValueOnce(JSON.stringify({ iid: 250, state: 'closed' }));
    const result = await gatherBlockedIssueState('/repo');
    expect(result.forge).toBe('gitlab');
    expect(result.ready).toEqual([
      expect.objectContaining({ number: 5, closedBlockers: [250], openBlockers: [] }),
    ]);
    expect(execGlabJsonMock.mock.calls.map(([args]) => args)).toEqual([
      ['issue', 'list', '--label', 'blocked', '--per-page', '100', '--page', '1'],
    ]);
    expect(execGlabJsonMock.mock.calls.some(([args]) => args.includes('--all'))).toBe(false);
    expect(execGlabMock).toHaveBeenCalledWith(
      ['issue', 'view', '250', '--output', 'json'],
      '/repo',
    );
  });

  it('reads the next blocked page when the first page is full', async () => {
    execGlabJsonMock
      .mockResolvedValueOnce({ rows: fullPage(1), reason: 'ok' })
      .mockResolvedValueOnce({ rows: [glIssue(250, 'Blocked by #900')], reason: 'ok' });
    execGlabMock.mockResolvedValueOnce(JSON.stringify({ iid: 900, state: 'closed' }));
    const result = await gatherBlockedIssueState('/repo');
    expect(result.ready).toEqual([
      expect.objectContaining({ number: 250, closedBlockers: [900], openBlockers: [] }),
    ]);
    expect(execGlabJsonMock.mock.calls.map(([args]) => args[args.indexOf('--page') + 1])).toEqual(['1', '2']);
  });

  it('leaves the issue blocked when glab issue view fails', async () => {
    execGlabJsonMock.mockResolvedValueOnce({
      rows: [glIssue(5, 'Blocked by #10, #11')],
      reason: 'ok',
    });
    execGlabMock.mockImplementation(async (args) => (
      args[2] === '10' ? JSON.stringify({ iid: 10, state: 'closed' }) : null
    ));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await gatherBlockedIssueState('/repo');
      expect(result.ready).toEqual([]);
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/blocker view #11 unavailable/));
    } finally {
      error.mockRestore();
    }
  });

  it('returns null and warns when a full page still fills the cap', async () => {
    execGlabJsonMock
      .mockResolvedValueOnce({ rows: fullPage(1).map((row) => ({ ...row, description: 'Blocked by #10' })), reason: 'ok' })
      .mockResolvedValueOnce({ rows: fullPage(101).map((row) => ({ ...row, description: 'Blocked by #11' })), reason: 'ok' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await gatherBlockedIssueState('/repo')).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/incomplete/i));
      expect(execGlabMock).not.toHaveBeenCalled();
      expect(execGlabJsonMock).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('returns null when a later blocked page cannot be read', async () => {
    execGlabJsonMock
      .mockResolvedValueOnce({ rows: fullPage(1), reason: 'ok' })
      .mockResolvedValueOnce({ rows: null, reason: 'cli-failed' });
    const result = await gatherBlockedIssueState('/repo');
    expect(result).toBeNull();
    expect(execGlabMock).not.toHaveBeenCalled();
  });

  it('returns null when glab cannot answer', async () => {
    execGlabJsonMock.mockResolvedValue({ rows: null, reason: 'cli-failed' });
    const result = await gatherBlockedIssueState('/repo');
    expect(result).toBeNull();
  });
});

describe('unblockIssues (GitHub)', () => {
  const ready = [{ number: 5, title: 'Feature X', url: 'u', blockingNumbers: [10], closedBlockers: [10], openBlockers: [] }];
  const ctx = { forge: 'github', repoSpec: 'github.com/o/r', fullName: 'o/r', repoPath: '/repo' };

  it('comments then removes the label, and counts one unblock', async () => {
    execGhMock.mockResolvedValue('');
    const count = await unblockIssues(ready, ctx);
    expect(count).toBe(1);
    const calls = execGhMock.mock.calls.map((c) => c[0]);
    expect(calls[0]).toEqual(['issue', 'comment', '5', '--repo', 'github.com/o/r', '--body', expect.stringContaining('#10')]);
    expect(calls[1]).toEqual(['issue', 'edit', '5', '--repo', 'github.com/o/r', '--remove-label', BLOCKED_LABEL]);
  });

  it('does not count a failed label removal, even if the comment succeeded', async () => {
    execGhMock
      .mockResolvedValueOnce('') // comment succeeds
      .mockRejectedValueOnce(new Error('422')); // edit fails
    const count = await unblockIssues(ready, ctx);
    expect(count).toBe(0);
  });

  it('still attempts the label removal when the comment call fails', async () => {
    execGhMock
      .mockRejectedValueOnce(new Error('comment failed'))
      .mockResolvedValueOnce('');
    const count = await unblockIssues(ready, ctx);
    expect(count).toBe(1);
  });

  it('returns 0 for an empty ready list without calling gh', async () => {
    const count = await unblockIssues([], ctx);
    expect(count).toBe(0);
    expect(execGhMock).not.toHaveBeenCalled();
  });
});

describe('unblockIssues (GitLab)', () => {
  const ready = [{ number: 5, title: 'Feature X', url: 'u', blockingNumbers: [10], closedBlockers: [10], openBlockers: [] }];
  const ctx = { forge: 'gitlab', repoSpec: null, fullName: 'group/proj', repoPath: '/repo' };

  it('notes then unlabels via glab, and counts one unblock', async () => {
    const count = await unblockIssues(ready, ctx);
    expect(count).toBe(1);
    const calls = execGlabMock.mock.calls.map((c) => c[0]);
    expect(calls[0]).toEqual(['issue', 'note', '5', '--message', expect.stringContaining('#10')]);
    expect(calls[1]).toEqual(['issue', 'update', '5', '--unlabel', BLOCKED_LABEL]);
  });

  it('does not count a failed unlabel call', async () => {
    execGlabMock.mockResolvedValueOnce('ok').mockResolvedValueOnce(null);
    const count = await unblockIssues(ready, ctx);
    expect(count).toBe(0);
  });
});
