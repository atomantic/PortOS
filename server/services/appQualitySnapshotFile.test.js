import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import {
  APP_QUALITY_SNAPSHOT_FILENAME, APP_QUALITY_SNAPSHOT_MAX_BYTES, QUALITY_SNAPSHOT_BRANCH,
  readAppQualitySnapshotFile, publishAppQualitySnapshot, __resetQualitySnapshotPublishState,
} from './appQualitySnapshotFile.js';

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
  expect(await readAppQualitySnapshotFile('/repo/example-app', { readFile: async () => { throw new Error('ENOENT'); } })).toBeNull();
  expect(APP_QUALITY_SNAPSHOT_FILENAME).toBe('.quality.json');
  expect(QUALITY_SNAPSHOT_BRANCH).toBe('portos/quality-snapshot');
});

it('lands a changed snapshot from a detached worktree so the PR branch stays attachable', async () => {
  const deps = testDeps();
  expect(await publishAppQualitySnapshot(app, deps)).toEqual({
    published: true, hash: 'abc1234', path: '.quality.json',
    prUrl, prNumber: 42, queuedMerge: true,
  });
  const [path, body] = deps.writeFile.mock.calls[0];
  expect(path).toBe(join(worktreePath, '.quality.json'));
  expect(JSON.parse(body)).toEqual(snapshot());
  expect(body.endsWith('\n')).toBe(true);
  expect(body).not.toMatch(/Users|summary|app_id|agent-|github/);
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
  expect(deps.queuePendingMerge).toHaveBeenCalledWith('example-id', expect.objectContaining({
    prUrl, prNumber: 42, prBranch: 'portos/quality-snapshot',
    sourceTask: expect.objectContaining({ metadata: { app: 'example-id' } }),
  }));
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
  const body = serialized(snapshot());
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

it('re-queues an already-open snapshot PR whose branch already has the same bytes', async () => {
  const body = serialized(snapshot());
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
    published: true, prUrl, prNumber: 42, queuedMerge: true,
  });
  expect(deps.writeFile).not.toHaveBeenCalled();
  expect(deps.addWorktree).not.toHaveBeenCalled();
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

it('adopts an already-open PR when createPR reports a conflict and still queues the merge', async () => {
  const deps = testDeps({
    git: gitDouble({
      createPR: vi.fn(async () => ({ success: false, error: 'a pull request already exists' })),
    }),
    probePrForBranch: vi.fn(async () => ({
      prState: 'OPEN', prUrl, prNumber: 42, cli: 'gh', readable: true,
    })),
  });
  expect(await publishAppQualitySnapshot(app, deps)).toMatchObject({
    published: true, prUrl, prNumber: 42, queuedMerge: true,
  });
  expect(deps.queuePendingMerge).toHaveBeenCalled();
});

it('enables GitLab auto-merge instead of the GitHub pending-merge queue', async () => {
  const execGlab = vi.fn(async () => '');
  const deps = testDeps({
    git: gitDouble({
      createPR: vi.fn(async () => ({ success: true, url: 'https://gitlab.com/example/app/-/merge_requests/7', cli: 'glab' })),
      parsePullRequestUrl: vi.fn(() => ({ number: 7, host: 'gitlab.com', owner: 'example', repo: 'app' })),
    }),
    execGlab,
  });
  expect(await publishAppQualitySnapshot(app, deps)).toMatchObject({
    published: true, prNumber: 7, queuedMerge: true,
  });
  expect(deps.queuePendingMerge).not.toHaveBeenCalled();
  expect(execGlab).toHaveBeenCalledWith(
    ['mr', 'merge', '7', '--yes', '--auto-merge'],
    '/repo/example-app', undefined, { rejectOnError: true },
  );
});
