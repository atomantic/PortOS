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
  execGhMock.mockResolvedValue('[]');
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
  it('returns ready=[] when the blocked list is empty', async () => {
    execGhMock.mockResolvedValueOnce('[]').mockResolvedValueOnce('[]');
    const result = await gatherBlockedIssueState('/repo');
    expect(result.forge).toBe('github');
    expect(result.ready).toEqual([]);
  });

  it('resolves a blocked issue whose named blocker is now closed', async () => {
    execGhMock
      .mockResolvedValueOnce(JSON.stringify([{ number: 5, title: 'Feature X', body: 'Blocked by #10', url: 'u' }]))
      .mockResolvedValueOnce(JSON.stringify([{ number: 10, state: 'CLOSED' }, { number: 5, state: 'OPEN' }]));
    const result = await gatherBlockedIssueState('/repo');
    expect(result.ready).toEqual([
      expect.objectContaining({ number: 5, blockingNumbers: [10], closedBlockers: [10], openBlockers: [] }),
    ]);
  });

  it('leaves a blocked issue out of ready when its blocker is still open', async () => {
    execGhMock
      .mockResolvedValueOnce(JSON.stringify([{ number: 5, title: 'Feature X', body: 'Blocked by #10', url: 'u' }]))
      .mockResolvedValueOnce(JSON.stringify([{ number: 10, state: 'OPEN' }]));
    const result = await gatherBlockedIssueState('/repo');
    expect(result.ready).toEqual([]);
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
});

describe('gatherBlockedIssueState (GitLab)', () => {
  beforeEach(() => {
    getOriginInfo.mockResolvedValue({ isGithub: false, host: 'gitlab.com', fullName: 'group/proj' });
    readOriginRemoteUrl.mockResolvedValue('git@gitlab.com:group/proj.git');
  });

  it('resolves a blocked issue whose named blocker is now closed', async () => {
    execGlabJsonMock
      .mockResolvedValueOnce({ rows: [{ iid: 5, title: 'Feature X', description: 'Blocked by #10', web_url: 'u' }], reason: 'ok' })
      .mockResolvedValueOnce({ rows: [{ iid: 10, state: 'closed' }, { iid: 5, state: 'opened' }], reason: 'ok' });
    const result = await gatherBlockedIssueState('/repo');
    expect(result.forge).toBe('gitlab');
    expect(result.ready).toEqual([
      expect.objectContaining({ number: 5, closedBlockers: [10], openBlockers: [] }),
    ]);
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
