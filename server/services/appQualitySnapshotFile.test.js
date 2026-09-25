import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { basename, join } from 'node:path';
import {
  APP_QUALITY_SNAPSHOT_FILENAME, APP_QUALITY_SNAPSHOT_MAX_BYTES, QUALITY_SNAPSHOT_BRANCH,
  readAppQualitySnapshotFile, readStoredQualitySnapshot, publishAppQualitySnapshot,
  migrateAppQualitySnapshot, __resetQualitySnapshotPublishState,
} from './appQualitySnapshotFile.js';
import {
  APP_QUALITY_LEGACY_SNAPSHOT_FILENAME, qualityFileFromWireSnapshot,
} from './appQualitySnapshotFormat.js';

const app = { id: 'example-id', repoPath: '/repo/example-app' };
const worktreePath = '/tmp/portos-quality-test';
const prUrl = 'https://github.com/example/app/pull/42';
const snapshot = (count = 1) => ({
  schemaVersion: 1,
  repository: 'a'.repeat(64),
  measurements: Array.from({ length: count }, (_, index) => ({
    measurementId: String(index).padStart(64, 'b'),
    assessedAt: '2026-09-10T10:00:00Z',
    report: { version: 1, category: 'security', score: 82, worstSeverity: 5,
      coverage: 'broad', confidence: 'high', scannedFiles: 12, totalFiles: 12 },
  })),
});
const serialized = body => `${JSON.stringify(body, null, 2)}\n`;
const canonical = () => qualityFileFromWireSnapshot(snapshot());
const missingShow = { exitCode: 1, stdout: '', stderr: 'exists' };
const gitDouble = (overrides = {}) => ({
  isRepo: vi.fn(async () => true),
  getRemote: vi.fn(async () => ({ origin: { fetch: 'git@github.com:example/app.git' } })),
  fetchOrigin: vi.fn(async () => true),
  getDefaultBranch: vi.fn(async () => 'main'),
  execGit: vi.fn(async (args) => {
    if (args[0] === 'show' || (args[0] === 'rev-parse' && String(args[1] || '').includes(QUALITY_SNAPSHOT_BRANCH))) {
      return missingShow;
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  }),
  stageFiles: vi.fn(async () => true),
  unstageFiles: vi.fn(async () => true),
  commit: vi.fn(async () => ({ hash: 'abc1234', message: 'commit' })),
  createPR: vi.fn(async () => ({ success: true, url: prUrl, cli: 'gh' })),
  mergePR: vi.fn(async () => ({ success: true })),
  parsePullRequestUrl: vi.fn(() => ({ number: 42, host: 'github.com', owner: 'example', repo: 'app' })),
  ...overrides,
});
const testDeps = (overrides = {}) => ({
  git: gitDouble(),
  writeFile: vi.fn(async () => true),
  buildQualitySnapshot: vi.fn(async () => snapshot()),
  mkdtemp: vi.fn(async () => worktreePath),
  rm: vi.fn(async () => {}),
  addWorktree: vi.fn(async () => true),
  queuePendingMerge: vi.fn(async () => true),
  probePrForBranch: vi.fn(async () => ({ prState: null, prUrl: null, prNumber: null, readable: true })),
  ...overrides,
});

let log;
beforeEach(() => {
  __resetQualitySnapshotPublishState();
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => log.mockRestore());

// Uniquely pins the opt-in snapshot file contract: numeric-only content and the
// skips that must never touch the app's live checkout or its git index.
it('reads a committed snapshot and answers null for every unusable file', async () => {
  const read = body => readAppQualitySnapshotFile('/repo/example-app', { readFile: async () => body });
  expect(await read(JSON.stringify(snapshot()))).toEqual(snapshot());
  expect(await read('not json')).toBeNull();
  expect(await read('[1,2]')).toBeNull();
  expect(await read('"a string"')).toBeNull();
  expect(await read(' '.repeat(APP_QUALITY_SNAPSHOT_MAX_BYTES + 1))).toBeNull();
  expect(await readAppQualitySnapshotFile('', { readFile: async () => '{}' })).toBeNull();
  expect(await readAppQualitySnapshotFile('/repo/example-app', { readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } })).toBeNull();
  expect(APP_QUALITY_SNAPSHOT_FILENAME).toBe('.quality.json');
  expect(QUALITY_SNAPSHOT_BRANCH).toBe('portos/quality-snapshot');
});

it('lands a changed snapshot from a detached worktree so the PR branch stays attachable', async () => {
  const deps = testDeps();
  expect(await publishAppQualitySnapshot(app, deps)).toEqual({
    published: true, hash: 'abc1234', path: '.quality.json',
    prUrl, prNumber: 42, merged: true, queuedMerge: false,
  });
  const [path, body] = deps.writeFile.mock.calls[0];
  expect(path).toBe(join(worktreePath, '.quality.json'));
  expect(body).toBe(canonical());
  expect(JSON.parse(body)).toMatchObject({
    schemaVersion: 2,
    reportVersion: 1,
    categories: ['security'],
    measurements: [['2026-09-10T10:00:00Z', 0, 82, 5, 0, 2, 12, 12]],
  });
  expect(body.endsWith('\n')).toBe(true);
  expect(body).not.toMatch(/measurementId|Users|summary|app_id|agent-|github/);
  expect(deps.buildQualitySnapshot).toHaveBeenCalledWith(app, 30, deps);
  expect(deps.addWorktree).toHaveBeenCalledWith(
    ['worktree', 'add', '--detach', worktreePath, 'origin/main'],
    '/repo/example-app',
  );
  expect(deps.git.stageFiles).toHaveBeenCalledWith(worktreePath, ['.quality.json']);
  expect(deps.git.commit).toHaveBeenCalledWith(worktreePath,
    'chore: publish PortOS quality snapshot (1 measurements)', { paths: ['.quality.json'] });
  expect(deps.git.execGit).toHaveBeenCalledWith(
    ['push', '-u', 'origin', 'HEAD:refs/heads/portos/quality-snapshot'], worktreePath);
  expect(deps.git.createPR).toHaveBeenCalledWith(worktreePath, expect.objectContaining({
    title: 'chore: publish quality snapshot',
    base: 'main',
    head: 'portos/quality-snapshot',
  }));
  expect(deps.git.createPR.mock.calls[0][1].body).toContain('no code review required');
  expect(deps.git.createPR.mock.calls[0][1].body).toContain('without waiting for CI');
  expect(deps.git.mergePR).toHaveBeenCalledWith('/repo/example-app', 42, expect.objectContaining({
    forgeAccount: null,
  }));
  expect(deps.queuePendingMerge).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(`📊 Published quality snapshot for app example-id: 1 measurements → abc1234 (${prUrl})`);
  expect(deps.git.execGit).toHaveBeenCalledWith(
    ['worktree', 'remove', '--force', worktreePath], '/repo/example-app', { ignoreExitCode: true });

  const unchanged = testDeps();
  expect(await publishAppQualitySnapshot(app, unchanged)).toEqual({
    published: false, reason: 'no-changes', path: '.quality.json',
  });
  expect(unchanged.writeFile).not.toHaveBeenCalled();
  expect(unchanged.addWorktree).not.toHaveBeenCalled();
  expect(unchanged.git.createPR).not.toHaveBeenCalled();
});

it('skips when origin already has the snapshot and does not write the live checkout', async () => {
  const body = canonical();
  const deps = testDeps({
    git: gitDouble({
      execGit: vi.fn(async (args) => args[0] === 'show' && String(args[1]).startsWith('origin/main:')
        ? { exitCode: 0, stdout: body, stderr: '' }
        : missingShow),
    }),
  });
  expect(await publishAppQualitySnapshot(app, deps)).toEqual({
    published: false, reason: 'no-changes', path: '.quality.json',
  });
  expect(deps.writeFile).not.toHaveBeenCalled();
  expect(deps.addWorktree).not.toHaveBeenCalled();
  expect(deps.git.stageFiles).not.toHaveBeenCalled();
});

it('merges an already-open snapshot PR whose branch already has the same bytes without waiting for CI', async () => {
  const body = canonical();
  const deps = testDeps({
    git: gitDouble({
      execGit: vi.fn(async (args) => args[0] === 'show' && String(args[1]).includes(QUALITY_SNAPSHOT_BRANCH)
        ? { exitCode: 0, stdout: body, stderr: '' }
        : missingShow),
    }),
    probePrForBranch: vi.fn(async () => ({
      prState: 'OPEN', prUrl, prNumber: 42, cli: 'gh', readable: true,
    })),
  });
  expect(await publishAppQualitySnapshot(app, deps)).toMatchObject({
    published: true, prUrl, prNumber: 42, merged: true, queuedMerge: false,
  });
  expect(deps.writeFile).not.toHaveBeenCalled();
  expect(deps.addWorktree).not.toHaveBeenCalled();
  expect(deps.git.mergePR).toHaveBeenCalledWith('/repo/example-app', 42, expect.objectContaining({
    forgeAccount: null,
  }));
  expect(deps.queuePendingMerge).not.toHaveBeenCalled();
});

it('falls back to the merge-on-green queue when branch protection refuses the immediate merge', async () => {
  const body = canonical();
  const deps = testDeps({
    git: gitDouble({
      execGit: vi.fn(async (args) => args[0] === 'show' && String(args[1]).includes(QUALITY_SNAPSHOT_BRANCH)
        ? { exitCode: 0, stdout: body, stderr: '' }
        : missingShow),
      mergePR: vi.fn(async () => ({ success: false, error: 'required status checks' })),
    }),
    probePrForBranch: vi.fn(async () => ({
      prState: 'OPEN', prUrl, prNumber: 42, cli: 'gh', readable: true,
    })),
  });
  expect(await publishAppQualitySnapshot(app, deps)).toMatchObject({
    published: true, prUrl, prNumber: 42, merged: false, queuedMerge: true,
  });
  expect(deps.queuePendingMerge).toHaveBeenCalledWith('example-id', expect.objectContaining({ prNumber: 42 }));
});

it('never overwrites an existing snapshot with an empty or unreachable one', async () => {
  const empty = testDeps({ buildQualitySnapshot: async () => snapshot(0) });
  expect(await publishAppQualitySnapshot(app, empty)).toEqual({ published: false, reason: 'no-evidence', path: '.quality.json' });
  expect(empty.writeFile).not.toHaveBeenCalled();

  const missing = testDeps({ buildQualitySnapshot: async () => null });
  expect((await publishAppQualitySnapshot(app, missing)).reason).toBe('no-evidence');

  const notRepo = testDeps({ git: { ...gitDouble(), isRepo: async () => false } });
  expect(await publishAppQualitySnapshot(app, notRepo)).toEqual({ published: false, reason: 'not-a-repo', path: '.quality.json' });
  expect(notRepo.buildQualitySnapshot).not.toHaveBeenCalled();

  const noPath = testDeps();
  expect(await publishAppQualitySnapshot({ id: 'example-id' }, noPath)).toEqual({ published: false, reason: 'no-repo-path', path: '.quality.json' });
  expect(await publishAppQualitySnapshot(null, noPath)).toMatchObject({ reason: 'no-repo-path' });
  expect(noPath.git.isRepo).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith('📊 Quality snapshot skipped for app example-id: not-a-repo');

  const noRemote = testDeps({ git: { ...gitDouble(), getRemote: async () => ({}) } });
  expect(await publishAppQualitySnapshot(app, noRemote)).toEqual({ published: false, reason: 'no-remote', path: '.quality.json' });
  expect(noRemote.git.fetchOrigin).not.toHaveBeenCalled();
});

it('serializes concurrent publishes for one checkout so the second sees the first one\'s bytes', async () => {
  const calls = [];
  let releaseCommit;
  const held = new Promise(resolve => { releaseCommit = resolve; });
  const deps = testDeps({
    git: gitDouble({
      commit: async () => { calls.push('commit-start'); await held; calls.push('commit-end'); return { hash: 'abc1234' }; },
    }),
    addWorktree: async () => { calls.push('worktree'); return true; },
    writeFile: async () => { calls.push('write'); },
  });
  const first = publishAppQualitySnapshot(app, deps);
  const second = publishAppQualitySnapshot(app, deps);
  releaseCommit();
  expect(await first).toMatchObject({ published: true, hash: 'abc1234', prUrl });
  expect(await second).toMatchObject({ published: false, reason: 'no-changes' });
  expect(calls).toEqual(['worktree', 'write', 'commit-start', 'commit-end']);
});

it('unstages the file and rethrows when the commit fails, so no stray path sits in the worktree index', async () => {
  const deps = testDeps({ git: gitDouble({ commit: vi.fn(async () => { throw new Error('index.lock exists'); }) }) });
  await expect(publishAppQualitySnapshot(app, deps)).rejects.toThrow('index.lock exists');
  expect(deps.git.unstageFiles).toHaveBeenCalledWith(worktreePath, ['.quality.json']);
  expect(deps.git.createPR).not.toHaveBeenCalled();

  const next = testDeps();
  expect(await publishAppQualitySnapshot(app, next)).toMatchObject({ published: true, prUrl });
});

it('force-with-lease updates an existing snapshot branch rather than committing on the live checkout', async () => {
  const deps = testDeps({
    git: gitDouble({
      execGit: vi.fn(async (args) => {
        if (args[0] === 'show') return missingShow;
        if (args[0] === 'rev-parse' && args[1] === `origin/${QUALITY_SNAPSHOT_BRANCH}`) {
          return { exitCode: 0, stdout: 'aa'.repeat(20), stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    }),
  });
  expect(await publishAppQualitySnapshot(app, deps)).toMatchObject({ published: true, prUrl });
  expect(deps.git.execGit).toHaveBeenCalledWith([
    'push',
    `--force-with-lease=refs/heads/${QUALITY_SNAPSHOT_BRANCH}:${'aa'.repeat(20)}`,
    'origin',
    `HEAD:refs/heads/${QUALITY_SNAPSHOT_BRANCH}`,
  ], worktreePath);
  expect(deps.writeFile.mock.calls[0][0]).toBe(join(worktreePath, '.quality.json'));
});

it('refreshes refs and rebuilds a detached worktree once after a stale lease', async () => {
  let remoteSha = 'aa'.repeat(20);
  let pushes = 0;
  const git = gitDouble({
    fetchOrigin: vi.fn(async () => { if (pushes) remoteSha = 'bb'.repeat(20); }),
    execGit: vi.fn(async (args) => {
      if (args[0] === 'show') return missingShow;
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: remoteSha, stderr: '' };
      if (args[0] === 'push' && ++pushes === 1) throw new Error('! [rejected] (stale info)');
      return { exitCode: 0, stdout: '', stderr: '' };
    }),
  });
  const deps = testDeps({ git });
  expect(await publishAppQualitySnapshot(app, deps)).toMatchObject({ published: true, prUrl });
  expect(git.fetchOrigin).toHaveBeenCalledTimes(2);
  expect(git.fetchOrigin).toHaveBeenLastCalledWith(app.repoPath, { prune: true });
  expect(deps.probePrForBranch).toHaveBeenCalledWith(app.repoPath, QUALITY_SNAPSHOT_BRANCH);
  expect(deps.addWorktree).toHaveBeenCalledTimes(2);
  expect(deps.addWorktree).toHaveBeenLastCalledWith(
    ['worktree', 'add', '--detach', worktreePath, 'origin/main'], app.repoPath,
  );
  expect(git.execGit.mock.calls.filter(([args]) => args[0] === 'push').map(([args]) => args[1])).toEqual([
    `--force-with-lease=refs/heads/${QUALITY_SNAPSHOT_BRANCH}:${'aa'.repeat(20)}`,
    `--force-with-lease=refs/heads/${QUALITY_SNAPSHOT_BRANCH}:${'bb'.repeat(20)}`,
  ]);
  expect(deps.writeFile.mock.calls.every(([path]) => path === join(worktreePath, '.quality.json'))).toBe(true);
  expect(git.createPR).toHaveBeenCalledTimes(1);
});

it.each(['future', 'malformed'])('refuses a %s snapshot found after a stale lease', async kind => {
  let fetches = 0;
  const body = kind === 'future'
    ? JSON.stringify({ schemaVersion: 3, repository: 'a'.repeat(64) })
    : '{invalid json';
  const git = gitDouble({
    fetchOrigin: vi.fn(async () => { fetches++; }),
    execGit: vi.fn(async (args) => {
      if (args[0] === 'show') {
        return fetches > 1 && String(args[1]).includes(`${QUALITY_SNAPSHOT_BRANCH}:`)
          ? { exitCode: 0, stdout: body, stderr: '' }
          : missingShow;
      }
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'aa'.repeat(20), stderr: '' };
      if (args[0] === 'push') throw new Error('! [rejected] (stale info)');
      return { exitCode: 0, stdout: '', stderr: '' };
    }),
  });
  const deps = testDeps({ git });
  expect(await publishAppQualitySnapshot(app, deps)).toEqual({
    published: false, reason: 'unsupported-format', path: '.quality.json',
  });
  expect(git.fetchOrigin).toHaveBeenCalledTimes(2);
  expect(deps.addWorktree).toHaveBeenCalledTimes(1);
  expect(git.createPR).not.toHaveBeenCalled();
  expect(deps.writeFile.mock.calls.every(([path]) => path === join(worktreePath, '.quality.json'))).toBe(true);
});

it('leaves a second stale lease rejection visible and retryable', async () => {
  let remoteSha = 'aa'.repeat(20);
  const git = gitDouble({
    fetchOrigin: vi.fn(async () => { remoteSha = remoteSha === 'aa'.repeat(20) ? 'bb'.repeat(20) : 'cc'.repeat(20); }),
    execGit: vi.fn(async (args) => {
      if (args[0] === 'show') return missingShow;
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: remoteSha, stderr: '' };
      if (args[0] === 'push') throw new Error('! [rejected] (stale info)');
      return { exitCode: 0, stdout: '', stderr: '' };
    }),
  });
  const deps = testDeps({ git });
  await expect(publishAppQualitySnapshot(app, deps)).rejects.toThrow('stale info');
  expect(git.execGit.mock.calls.filter(([args]) => args[0] === 'push')).toHaveLength(2);
  expect(deps.addWorktree).toHaveBeenCalledTimes(2);
  expect(git.createPR).not.toHaveBeenCalled();
  // A failed publish cannot poison the in-process queue or mark these bytes as landed.
  await expect(publishAppQualitySnapshot(app, deps)).rejects.toThrow('stale info');
  expect(deps.addWorktree).toHaveBeenCalledTimes(4);
});

it('does not retry a stale lease when the refreshed PR state cannot be read', async () => {
  const git = gitDouble({
    execGit: vi.fn(async (args) => {
      if (args[0] === 'show') return missingShow;
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'aa'.repeat(20), stderr: '' };
      if (args[0] === 'push') throw new Error('! [rejected] (stale info)');
      return { exitCode: 0, stdout: '', stderr: '' };
    }),
  });
  const deps = testDeps({
    git,
    probePrForBranch: vi.fn(async () => ({ readable: false })),
  });
  await expect(publishAppQualitySnapshot(app, deps)).rejects.toThrow('publish PR state unavailable');
  expect(deps.probePrForBranch).toHaveBeenCalledWith(app.repoPath, QUALITY_SNAPSHOT_BRANCH);
  expect(deps.addWorktree).toHaveBeenCalledTimes(1);
  expect(git.createPR).not.toHaveBeenCalled();
});

it('adopts an already-open PR when createPR reports a conflict and merges it immediately', async () => {
  const deps = testDeps({
    git: gitDouble({
      createPR: vi.fn(async () => ({ success: false, error: 'a pull request already exists' })),
    }),
    probePrForBranch: vi.fn(async () => ({
      prState: 'OPEN', prUrl, prNumber: 42, cli: 'gh', readable: true,
    })),
  });
  expect(await publishAppQualitySnapshot(app, deps)).toMatchObject({
    published: true, prUrl, prNumber: 42, merged: true, queuedMerge: false,
  });
  expect(deps.git.mergePR).toHaveBeenCalled();
  expect(deps.queuePendingMerge).not.toHaveBeenCalled();
});

it('merges a GitLab MR immediately instead of arming pipeline auto-merge', async () => {
  const execGlab = vi.fn(async () => '');
  const deps = testDeps({
    git: gitDouble({
      createPR: vi.fn(async () => ({ success: true, url: 'https://gitlab.com/example/app/-/merge_requests/7', cli: 'glab' })),
      parsePullRequestUrl: vi.fn(() => ({ number: 7, host: 'gitlab.com', owner: 'example', repo: 'app' })),
    }),
    execGlab,
  });
  expect(await publishAppQualitySnapshot(app, deps)).toMatchObject({
    published: true, prNumber: 7, merged: true, queuedMerge: false,
  });
  expect(deps.queuePendingMerge).not.toHaveBeenCalled();
  expect(execGlab).toHaveBeenCalledWith(
    ['mr', 'merge', '7', '--yes', '--when-pipeline-succeeds=false'],
    '/repo/example-app', undefined, { rejectOnError: true },
  );
});

it('falls back to GitLab auto-merge when the immediate merge is refused', async () => {
  const execGlab = vi.fn()
    .mockRejectedValueOnce(new Error('pipeline must succeed'))
    .mockResolvedValueOnce('');
  const deps = testDeps({
    git: gitDouble({
      createPR: vi.fn(async () => ({ success: true, url: 'https://gitlab.com/example/app/-/merge_requests/7', cli: 'glab' })),
      parsePullRequestUrl: vi.fn(() => ({ number: 7, host: 'gitlab.com', owner: 'example', repo: 'app' })),
    }),
    execGlab,
  });
  expect(await publishAppQualitySnapshot(app, deps)).toMatchObject({
    published: true, prNumber: 7, merged: false, queuedMerge: true,
  });
  expect(execGlab).toHaveBeenCalledWith(
    ['mr', 'merge', '7', '--yes', '--when-pipeline-succeeds=false'],
    '/repo/example-app', undefined, { rejectOnError: true },
  );
  expect(execGlab).toHaveBeenCalledWith(
    ['mr', 'merge', '7', '--yes', '--auto-merge'],
    '/repo/example-app', undefined, { rejectOnError: true },
  );
});

const showFiles = files => vi.fn(async (args) => {
  if (args[0] !== 'show') return missingShow;
  const spec = String(args[1]);
  const name = spec.slice(spec.lastIndexOf(':') + 1);
  return Object.hasOwn(files, name)
    ? { exitCode: 0, stdout: files[name], stderr: '' }
    : missingShow;
});

it('rewrites a v1 snapshot to canonical v2 and leaves a semantically identical v2 untouched', async () => {
  const upgrade = testDeps({ git: gitDouble({ execGit: showFiles({ '.quality.json': serialized(snapshot()) }) }) });
  expect(await publishAppQualitySnapshot(app, upgrade)).toMatchObject({ published: true, prUrl });
  expect(upgrade.writeFile.mock.calls[0][1]).toBe(canonical());
  expect(upgrade.writeFile.mock.calls[0][0]).toBe(join(worktreePath, '.quality.json'));

  __resetQualitySnapshotPublishState();
  const compact = JSON.stringify(JSON.parse(canonical()));
  const identical = testDeps({ git: gitDouble({ execGit: showFiles({ '.quality.json': compact }) }) });
  expect(await publishAppQualitySnapshot(app, identical)).toEqual({
    published: false, reason: 'no-changes', path: '.quality.json',
  });
  expect(identical.writeFile).not.toHaveBeenCalled();
  expect(identical.addWorktree).not.toHaveBeenCalled();
});

it('does not replace a future snapshot already on the publish branch', async () => {
  const future = JSON.stringify({ schemaVersion: 3, repository: 'a'.repeat(64) });
  const deps = testDeps({
    git: gitDouble({
      execGit: vi.fn(async (args) => {
        if (args[0] === 'show' && String(args[1]).includes(`${QUALITY_SNAPSHOT_BRANCH}:`)) {
          return { exitCode: 0, stdout: future, stderr: '' };
        }
        return missingShow;
      }),
    }),
  });
  expect(await publishAppQualitySnapshot(app, deps)).toEqual({
    published: false, reason: 'unsupported-format', path: '.quality.json',
  });
  expect(deps.writeFile).not.toHaveBeenCalled();
  expect(deps.addWorktree).not.toHaveBeenCalled();
});

it('leaves a future, unrecognized, or unreadable snapshot in place', async () => {
  const future = testDeps({
    git: gitDouble({ execGit: showFiles({ '.quality.json': JSON.stringify({ schemaVersion: 3, repository: 'a'.repeat(64) }) }) }),
  });
  expect(await publishAppQualitySnapshot(app, future)).toEqual({
    published: false, reason: 'unsupported-format', path: '.quality.json',
  });
  expect(future.writeFile).not.toHaveBeenCalled();

  const tsv = testDeps({
    git: gitDouble({ execGit: showFiles({ '.quality.json': 'category\tscore\nsecurity\t80\n' }) }),
  });
  expect((await publishAppQualitySnapshot(app, tsv)).reason).toBe('unsupported-format');
  expect(tsv.writeFile).not.toHaveBeenCalled();

  const unreadable = testDeps({
    git: gitDouble({ execGit: vi.fn(async (args) => {
      if (args[0] === 'show') throw new Error('git output exceeded maxBuffer');
      return { exitCode: 0, stdout: '', stderr: '' };
    }) }),
  });
  expect((await publishAppQualitySnapshot(app, unreadable)).reason).toBe('unsupported-format');
  expect(unreadable.writeFile).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith('📊 Quality snapshot left untouched for app example-id: future');

  // Readable, but rewriting it canonically would drop the newer install's rows.
  const newer = testDeps({
    git: gitDouble({ execGit: showFiles({ '.quality.json': JSON.stringify({
      schemaVersion: 2, repository: 'a'.repeat(64), reportVersion: 1,
      categories: ['security', 'example-future-lens'],
      coverage: ['broad', 'partial', 'unavailable', 'not-applicable'], confidence: ['low', 'medium', 'high'],
      measurements: [['2026-09-20T00:00:00.000Z', 1, 50, 3, 0, 2, 10, 10]],
    }) }) }),
  });
  expect((await publishAppQualitySnapshot(app, newer)).reason).toBe('unsupported-format');
  expect(newer.writeFile).not.toHaveBeenCalled();
});

it('migrates a legacy file to v2 without inventing measurements or writing the live checkout', async () => {
  const legacyBody = serialized(snapshot());
  const deps = testDeps({
    git: gitDouble({ execGit: showFiles({ [APP_QUALITY_LEGACY_SNAPSHOT_FILENAME]: legacyBody }) }),
    buildQualitySnapshot: vi.fn(async () => snapshot(3)),
  });
  expect(await migrateAppQualitySnapshot(app, deps)).toMatchObject({ published: true, prUrl, hash: 'abc1234' });
  expect(deps.buildQualitySnapshot).not.toHaveBeenCalled();
  const [path, body] = deps.writeFile.mock.calls[0];
  expect(path).toBe(join(worktreePath, '.quality.json'));
  expect(path.startsWith(app.repoPath)).toBe(false);
  expect(JSON.parse(body).measurements).toEqual([['2026-09-10T10:00:00Z', 0, 82, 5, 0, 2, 12, 12]]);
  expect(deps.git.execGit).toHaveBeenCalledWith(
    ['rm', '-f', '--', APP_QUALITY_LEGACY_SNAPSHOT_FILENAME], worktreePath);
  expect(deps.git.commit).toHaveBeenCalledWith(worktreePath,
    'chore: migrate quality snapshot to schema v2 (1 measurements)',
    { paths: ['.quality.json', APP_QUALITY_LEGACY_SNAPSHOT_FILENAME] });

  __resetQualitySnapshotPublishState();
  const again = testDeps({
    git: gitDouble({ execGit: showFiles({ '.quality.json': body }) }),
    buildQualitySnapshot: vi.fn(async () => { throw new Error('database must stay unread'); }),
  });
  expect(await migrateAppQualitySnapshot(app, again)).toEqual({
    published: false, reason: 'no-changes', path: '.quality.json',
  });
  expect(again.writeFile).not.toHaveBeenCalled();
  expect(again.addWorktree).not.toHaveBeenCalled();
});

it('reads v1, v2, and the legacy filename without falling past a canonical file', async () => {
  const v1 = serialized(snapshot());
  const v2 = canonical();
  const read = files => readStoredQualitySnapshot('/repo/example-app', {
    readFile: async path => {
      const name = basename(path);
      if (!Object.hasOwn(files, name)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files[name];
    },
  });
  expect(APP_QUALITY_LEGACY_SNAPSHOT_FILENAME).toBe('quality-snapshot.json');
  expect((await read({ '.quality.json': v1 })).status).toBe('v1');
  expect((await read({ '.quality.json': v2 })).status).toBe('v2');
  expect((await read({ [APP_QUALITY_LEGACY_SNAPSHOT_FILENAME]: v1 })).filename).toBe(APP_QUALITY_LEGACY_SNAPSHOT_FILENAME);
  const both = await read({ '.quality.json': v2, [APP_QUALITY_LEGACY_SNAPSHOT_FILENAME]: v1 });
  expect(both.filename).toBe('.quality.json');
  expect(both.status).toBe('v2');
  expect((await read({ '.quality.json': 'not-json', [APP_QUALITY_LEGACY_SNAPSHOT_FILENAME]: v1 })).status).toBe('unrecognized');
  expect((await read({ '.quality.json': ' '.repeat(APP_QUALITY_SNAPSHOT_MAX_BYTES + 1) })).status).toBe('oversize');
  const unreadable = await readStoredQualitySnapshot('/repo/example-app', {
    readFile: async path => {
      if (basename(path) === '.quality.json') throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return v1;
    },
  });
  expect(unreadable.status).toBe('unreadable');
  expect(unreadable.filename).toBe('.quality.json');
});
