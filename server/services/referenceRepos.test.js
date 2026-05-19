import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── mocks (must precede the import under test) ──────────────────────────────

vi.mock('../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  ensureDir: vi.fn(async () => {}),
  PATHS: { data: '/mock/data', root: '/mock/root' },
  readJSONFile: vi.fn(async () => ({ apps: {} })),
}));

vi.mock('../lib/uuid.js', () => ({
  v4: vi.fn(() => 'mock-uuid-1234'),
}));

// Stub apps.js so we can drive the per-app reference list without going
// through the full apps registry / file I/O.
const mockApps = new Map();
vi.mock('./apps.js', () => ({
  getAppById: vi.fn(async (id) => mockApps.get(id) || null),
  updateApp: vi.fn(async (id, patch) => {
    const cur = mockApps.get(id) || { id };
    const next = { ...cur, ...patch };
    mockApps.set(id, next);
    return next;
  }),
}));

// execGit is the one syscall every git operation funnels through. The mock
// returns canned stdout per call so each describe block can assert
// behavior without spawning real git. Tests pull `execGitMock` off the
// module to queue per-call results.
const execGitMock = vi.fn();
vi.mock('../lib/execGit.js', () => ({
  execGit: (args, cwd, opts) => {
    const result = execGitMock(args, cwd, opts);
    if (result?.error) return Promise.reject(result.error);
    return Promise.resolve({ stdout: result?.stdout ?? '', stderr: '', exitCode: 0 });
  },
}));

// existsSync is hit when the service decides whether the managed clone
// already exists. Default to false so first-touch goes through clone path;
// individual tests override.
const existsMock = vi.fn(() => false);
const statMock = vi.fn(() => ({ isDirectory: () => true }));
vi.mock('fs', () => ({
  existsSync: (p) => existsMock(p),
  statSync: (p) => statMock(p),
}));

// ─── module under test (after mocks) ─────────────────────────────────────────

let svc;
beforeEach(async () => {
  vi.resetModules();
  mockApps.clear();
  execGitMock.mockReset();
  existsMock.mockReset();
  existsMock.mockReturnValue(false);
  svc = await import('./referenceRepos.js');
});

const seedApp = (id, refs = []) => {
  mockApps.set(id, { id, name: 'TestApp', repoPath: '/mock/repo', referenceRepos: refs });
};

// ─── tests ───────────────────────────────────────────────────────────────────

describe('addReferenceRepo', () => {
  it('appends a ref with server-assigned id, default branch, and needs-clone status', async () => {
    seedApp('app-1');
    const ref = await svc.addReferenceRepo('app-1', {
      name: 'phosphene',
      repoUrl: 'https://github.com/mrbizarro/phosphene.git',
      notes: 'LTX-2 video gen pipeline',
    });
    expect(ref).toMatchObject({
      id: 'mock-uuid-1234',
      name: 'phosphene',
      repoUrl: 'https://github.com/mrbizarro/phosphene.git',
      branch: 'main',
      notes: 'LTX-2 video gen pipeline',
      lastReviewedSha: null,
      lastCheckedAt: null,
      status: 'needs-clone',
    });
    const stored = mockApps.get('app-1');
    expect(stored.referenceRepos).toHaveLength(1);
  });

  it('preserves existing refs when appending', async () => {
    seedApp('app-1', [{ id: 'r1', name: 'A', repoUrl: 'x', branch: 'main', status: 'ok' }]);
    await svc.addReferenceRepo('app-1', { name: 'B', repoUrl: 'y' });
    expect(mockApps.get('app-1').referenceRepos.map((r) => r.name)).toEqual(['A', 'B']);
  });

  it('throws 404 when the app does not exist', async () => {
    await expect(svc.addReferenceRepo('missing', { name: 'x', repoUrl: 'y' }))
      .rejects.toThrow(/App not found/);
  });
});

describe('updateReferenceRepo', () => {
  it('updates allowed fields only and bumps lastCheckedAt when SHA is pinned manually', async () => {
    seedApp('app-1', [{ id: 'r1', name: 'old', repoUrl: 'u', branch: 'main', notes: '', lastReviewedSha: null, status: 'ok' }]);
    const updated = await svc.updateReferenceRepo('app-1', 'r1', {
      name: 'new-name',
      lastReviewedSha: 'a'.repeat(40),
    });
    expect(updated.name).toBe('new-name');
    expect(updated.lastReviewedSha).toBe('a'.repeat(40));
    expect(updated.lastCheckedAt).toBeTruthy(); // bumped because SHA was pinned
  });

  it('silently drops unknown fields (allow-list of writable keys)', async () => {
    seedApp('app-1', [{ id: 'r1', name: 'a', repoUrl: 'u', status: 'ok' }]);
    const updated = await svc.updateReferenceRepo('app-1', 'r1', { name: 'b', status: 'error' });
    expect(updated.name).toBe('b');
    expect(updated.status).toBe('ok'); // status not in allowed-update list
  });

  it('throws 404 for unknown ref id', async () => {
    seedApp('app-1', [{ id: 'r1', name: 'a', repoUrl: 'u' }]);
    await expect(svc.updateReferenceRepo('app-1', 'r99', { name: 'b' }))
      .rejects.toThrow(/Reference repo not found/);
  });

  it('trims string fields (name/repoUrl/branch/notes) just like addReferenceRepo', async () => {
    // Without trimming, " main " as a branch causes confusing git failures
    // and " https://github.com/...  " in repoUrl would mismatch addRef shape.
    seedApp('app-1', [{ id: 'r1', name: 'old', repoUrl: 'u', branch: 'main', notes: '', status: 'ok' }]);
    const updated = await svc.updateReferenceRepo('app-1', 'r1', {
      name: '  spaced  ',
      branch: '  develop  ',
      repoUrl: '  https://x/y.git  ',
      notes: '  some notes  ',
    });
    expect(updated.name).toBe('spaced');
    expect(updated.branch).toBe('develop');
    expect(updated.repoUrl).toBe('https://x/y.git');
    expect(updated.notes).toBe('some notes');
  });

  it('does not bump lastCheckedAt when lastReviewedSha is cleared to null', async () => {
    // Clearing the SHA pin (lastReviewedSha=null) is a "reset", not a "review" —
    // bumping lastCheckedAt would make the UI show a fresh-looking timestamp
    // immediately after a reset, which is misleading.
    seedApp('app-1', [{ id: 'r1', name: 'p', repoUrl: 'u', branch: 'main', lastReviewedSha: 'a'.repeat(40), lastCheckedAt: '2026-01-01T00:00:00Z', status: 'ok' }]);
    const updated = await svc.updateReferenceRepo('app-1', 'r1', { lastReviewedSha: null });
    expect(updated.lastReviewedSha).toBeNull();
    expect(updated.lastCheckedAt).toBe('2026-01-01T00:00:00Z'); // unchanged
  });
});

describe('deleteReferenceRepo', () => {
  it('removes the ref from the app and leaves siblings intact', async () => {
    seedApp('app-1', [
      { id: 'r1', name: 'a', repoUrl: 'u' },
      { id: 'r2', name: 'b', repoUrl: 'u' },
    ]);
    await svc.deleteReferenceRepo('app-1', 'r1');
    expect(mockApps.get('app-1').referenceRepos.map((r) => r.id)).toEqual(['r2']);
  });

  it('throws 404 when the ref id is unknown', async () => {
    seedApp('app-1', [{ id: 'r1', name: 'a', repoUrl: 'u' }]);
    await expect(svc.deleteReferenceRepo('app-1', 'missing'))
      .rejects.toThrow(/Reference repo not found/);
  });
});

describe('checkReferenceRepo', () => {
  // Wire execGitMock as a programmable sequence of git invocations.
  // For URL-based refs the order is: clone (when missing), fetch, rev-parse,
  // log. For local-path refs: rev-parse, log (no clone, no fetch).
  it('clones on first run, fetches, computes commits, persists status=ok', async () => {
    seedApp('app-1', [{ id: 'r1', name: 'phosphene', repoUrl: 'https://github.com/x/y.git', branch: 'main', lastReviewedSha: null, status: 'needs-clone' }]);
    existsMock.mockImplementation(() => false); // clone doesn't exist yet
    execGitMock
      .mockReturnValueOnce({ stdout: '' })                            // git clone
      .mockReturnValueOnce({ stdout: '' })                            // git fetch
      .mockReturnValueOnce({ stdout: 'a'.repeat(40) })                // git rev-parse
      .mockReturnValueOnce({ stdout: ['a'.repeat(40), 'Alice', 'a@x', '2026-05-01T00:00:00Z', 'first commit'].join('\t') }); // git log

    const snapshot = await svc.checkReferenceRepo('app-1', 'r1');
    expect(snapshot.head).toBe('a'.repeat(40));
    expect(snapshot.commitCount).toBe(1);
    expect(snapshot.commits[0].subject).toBe('first commit');

    // The first execGitMock call should have been `git clone <url> <id>`
    expect(execGitMock.mock.calls[0][0]).toEqual(['clone', 'https://github.com/x/y.git', 'r1']);
    // Persisted status must reflect the successful run.
    const persisted = mockApps.get('app-1').referenceRepos[0];
    expect(persisted.status).toBe('ok');
    expect(persisted.lastError).toBeNull();
    expect(persisted.lastCheckedAt).toBeTruthy();
  });

  it('skips clone when .git already exists', async () => {
    seedApp('app-1', [{ id: 'r1', name: 'p', repoUrl: 'https://github.com/x/y.git', branch: 'main', lastReviewedSha: null }]);
    existsMock.mockImplementation((p) => String(p).endsWith('/.git'));
    execGitMock
      .mockReturnValueOnce({ stdout: '' })                            // git fetch
      .mockReturnValueOnce({ stdout: 'b'.repeat(40) })                // git rev-parse
      .mockReturnValueOnce({ stdout: '' });                           // git log (empty)

    const snapshot = await svc.checkReferenceRepo('app-1', 'r1');
    expect(snapshot.commitCount).toBe(0);
    // First git call should be fetch, not clone.
    expect(execGitMock.mock.calls[0][0][0]).toBe('fetch');
  });

  it('uses lastReviewedSha as the lower bound when set', async () => {
    seedApp('app-1', [{ id: 'r1', name: 'p', repoUrl: 'https://github.com/x/y.git', branch: 'main', lastReviewedSha: 'c'.repeat(40) }]);
    existsMock.mockImplementation((p) => String(p).endsWith('/.git'));
    execGitMock
      .mockReturnValueOnce({ stdout: '' })                            // fetch
      .mockReturnValueOnce({ stdout: 'd'.repeat(40) })                // rev-parse
      .mockReturnValueOnce({ stdout: '' });                           // log

    await svc.checkReferenceRepo('app-1', 'r1');
    // After rev-parse, listCommits runs `rev-list --count <range>` before
    // `log -n N <range>`. Both end with the same range arg, so checking
    // the last positional in either call confirms the SHA gets plumbed
    // through to git as a strict <sinceSha>..<headRef> bound.
    const rangeCall = execGitMock.mock.calls[2][0];
    const range = rangeCall[rangeCall.length - 1];
    expect(range).toBe(`${'c'.repeat(40)}..origin/main`);
  });

  it('persists status=error and re-throws on git failure', async () => {
    seedApp('app-1', [{ id: 'r1', name: 'p', repoUrl: 'https://github.com/x/y.git', branch: 'main', lastReviewedSha: null }]);
    existsMock.mockImplementation((p) => String(p).endsWith('/.git'));
    execGitMock.mockReturnValueOnce({ error: new Error('fatal: bad branch') });

    await expect(svc.checkReferenceRepo('app-1', 'r1')).rejects.toThrow(/fatal: bad branch/);
    const persisted = mockApps.get('app-1').referenceRepos[0];
    expect(persisted.status).toBe('error');
    expect(persisted.lastError).toMatch(/bad branch/);
  });

  it('skips clone+fetch for local-path refs and reads SHA via rev-parse on the user path', async () => {
    seedApp('app-1', [{ id: 'r1', name: 'p', repoUrl: '/Users/me/phosphene', branch: 'main', lastReviewedSha: null }]);
    existsMock.mockImplementation((p) => p === '/Users/me/phosphene' || p === '/Users/me/phosphene/.git'); // user path + git dir exist
    execGitMock
      .mockReturnValueOnce({ stdout: 'e'.repeat(40) })                // rev-parse main
      .mockReturnValueOnce({ stdout: '' });                           // log

    const snapshot = await svc.checkReferenceRepo('app-1', 'r1');
    expect(snapshot.head).toBe('e'.repeat(40));
    // No clone, no fetch — first call is rev-parse on the user path
    expect(execGitMock.mock.calls[0][0]).toEqual(['rev-parse', 'main']);
    expect(execGitMock.mock.calls[0][1]).toBe('/Users/me/phosphene');
  });
});

describe('isLocalPath', () => {
  it('classifies https / ssh-scheme / scp-style URLs as remote', () => {
    const { isLocalPath } = svc.__test;
    expect(isLocalPath('https://github.com/owner/repo.git')).toBe(false);
    expect(isLocalPath('ssh://git@github.com/owner/repo.git')).toBe(false);
    expect(isLocalPath('git@github.com:owner/repo.git')).toBe(false);
    // scp-style with non-github user@host shape — must still be remote
    expect(isLocalPath('user@example.com:owner/repo.git')).toBe(false);
    // scp-style with NO user (`host:path`) — git accepts these too
    expect(isLocalPath('github.com:owner/repo.git')).toBe(false);
  });

  it('classifies absolute paths and ~-paths as local', () => {
    const { isLocalPath } = svc.__test;
    expect(isLocalPath('/Users/me/phosphene')).toBe(true);
    expect(isLocalPath('~/phosphene')).toBe(true);
    expect(isLocalPath('./phosphene')).toBe(true);
    // Windows drive paths must NOT be treated as scp-style remotes —
    // single-char host segment + path starting with `\` or `/`.
    expect(isLocalPath('C:\\Users\\me\\phosphene')).toBe(true);
    expect(isLocalPath('C:/Users/me/phosphene')).toBe(true);
  });
});

describe('formatReferenceForPrompt', () => {
  it('renders a Markdown chunk with notes + commit list', () => {
    const ref = { id: 'r1', name: 'phosphene', repoUrl: 'https://github.com/x/y.git', branch: 'main', lastReviewedSha: null, notes: 'video gen' };
    const snapshot = {
      head: 'f'.repeat(40),
      headShort: 'ffffffff',
      commitCount: 1,
      commits: [{ sha: 'a'.repeat(40), subject: 'add new feature', author: 'Alice', date: '2026-05-01T00:00:00Z' }],
      cwd: '/mock/clone',
      branch: 'main',
    };
    const out = svc.formatReferenceForPrompt(ref, snapshot);
    expect(out).toContain('## Reference: phosphene');
    expect(out).toContain('Context (user-supplied');
    expect(out).toContain('video gen');
    expect(out).toContain('aaaaaaaa');
    expect(out).toContain('add new feature');
  });

  it('shows "no new commits" line when commitCount is 0', () => {
    const ref = { id: 'r1', name: 'phosphene', repoUrl: 'https://x', branch: 'main', notes: '' };
    const snapshot = { head: 'f'.repeat(40), headShort: 'ffffffff', commitCount: 0, commits: [], cwd: '/x', branch: 'main' };
    const out = svc.formatReferenceForPrompt(ref, snapshot);
    expect(out).toContain('No new commits since last review');
  });
});

describe('markReferenceRepoReviewed', () => {
  it('rejects malformed SHA before touching state', async () => {
    seedApp('app-1', [{ id: 'r1', name: 'p', repoUrl: 'u', branch: 'main' }]);
    await expect(svc.markReferenceRepoReviewed('app-1', 'r1', 'too-short')).rejects.toThrow(/Invalid SHA/);
  });

  it('persists lastReviewedSha + lastCheckedAt on a valid SHA verified in the clone', async () => {
    // Local-path ref so ensureClone() is a no-op other than the existsSync
    // check; cat-file -e succeeds → SHA is treated as verified.
    seedApp('app-1', [{ id: 'r1', name: 'p', repoUrl: '/Users/me/phosphene', branch: 'main', lastReviewedSha: null }]);
    existsMock.mockImplementation((p) => p === '/Users/me/phosphene' || p === '/Users/me/phosphene/.git');
    execGitMock.mockReturnValueOnce({ stdout: '' }); // git cat-file -e <sha>^{commit}
    const out = await svc.markReferenceRepoReviewed('app-1', 'r1', 'a'.repeat(40));
    expect(out.lastReviewedSha).toBe('a'.repeat(40));
    expect(out.lastCheckedAt).toBeTruthy();
    // Verify the actual git call shape so a future refactor can't silently
    // drop SHA verification.
    expect(execGitMock.mock.calls[0][0]).toEqual(['cat-file', '-e', `${'a'.repeat(40)}^{commit}`]);
  });

  it('rejects when the SHA does not resolve to a commit in the clone', async () => {
    seedApp('app-1', [{ id: 'r1', name: 'p', repoUrl: '/Users/me/phosphene', branch: 'main', lastReviewedSha: null }]);
    existsMock.mockImplementation((p) => p === '/Users/me/phosphene' || p === '/Users/me/phosphene/.git');
    execGitMock.mockReturnValueOnce({ error: new Error('fatal: Not a valid object name') });
    await expect(svc.markReferenceRepoReviewed('app-1', 'r1', 'a'.repeat(40)))
      .rejects.toThrow(/not found in reference repo/);
    // SHA must NOT have been persisted on a failed verification.
    expect(mockApps.get('app-1').referenceRepos[0].lastReviewedSha).toBeNull();
  });
});
