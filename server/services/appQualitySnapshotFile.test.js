import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { APP_QUALITY_SNAPSHOT_FILENAME, APP_QUALITY_SNAPSHOT_MAX_BYTES,
  readAppQualitySnapshotFile, publishAppQualitySnapshot } from './appQualitySnapshotFile.js';

const app = { id: 'example-id', repoPath: '/repo/example-app' };
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
const gitDouble = () => ({ isRepo: vi.fn(async () => true), stageFiles: vi.fn(async () => true),
  unstageFiles: vi.fn(async () => true), commit: vi.fn(async () => ({ hash: 'abc1234', message: 'commit' })) });
const testDeps = (overrides = {}) => ({ git: gitDouble(), writeFile: vi.fn(async () => true),
  buildQualitySnapshot: vi.fn(async () => snapshot()), readFile: vi.fn(async () => { throw new Error('ENOENT'); }),
  ...overrides });

let log;
beforeEach(() => { log = vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => log.mockRestore());

// Uniquely pins the opt-in snapshot file contract: numeric-only content and the
// four skips that must never touch the app's repo or its git index.
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
});

it('publishes a changed snapshot as one scoped commit and skips without touching git otherwise', async () => {
  const deps = testDeps();
  expect(await publishAppQualitySnapshot(app, deps)).toEqual({ published: true, hash: 'abc1234', path: '.quality.json' });
  const [path, body] = deps.writeFile.mock.calls[0];
  expect(path).toBe(join('/repo/example-app', '.quality.json'));  // join(): Windows CI joins with backslashes
  expect(JSON.parse(body)).toEqual(snapshot());
  expect(body.endsWith('\n')).toBe(true);
  // The published file carries numeric evidence only — no prose, paths or run ids.
  expect(body).not.toMatch(/Users|summary|app_id|agent-|github/);
  expect(deps.git.stageFiles).toHaveBeenCalledWith('/repo/example-app', ['.quality.json']);
  expect(deps.git.commit).toHaveBeenCalledWith('/repo/example-app',
    'chore: publish PortOS quality snapshot (1 measurements)', { paths: ['.quality.json'] });
  expect(log).toHaveBeenCalledWith('📊 Published quality snapshot for app example-id: 1 measurements → abc1234');

  // Re-publishing the identical snapshot must not create an empty commit.
  const unchanged = testDeps({ readFile: async () => body });
  expect(await publishAppQualitySnapshot(app, unchanged)).toEqual({ published: false, reason: 'no-changes', path: '.quality.json' });
  expect(unchanged.writeFile).not.toHaveBeenCalled();
  expect(unchanged.git.stageFiles).not.toHaveBeenCalled();
  expect(unchanged.git.commit).not.toHaveBeenCalled();
});

it('never overwrites an existing snapshot with an empty or unreachable one', async () => {
  const empty = testDeps({ buildQualitySnapshot: async () => snapshot(0), readFile: async () => JSON.stringify(snapshot()) });
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
});

it('serializes concurrent publishes for one checkout so the second sees the first one\'s bytes', async () => {
  // Several audit categories for one app finish together; read-modify-write over
  // `.quality.json` and `.git/index` must not interleave.
  const calls = [];
  let releaseCommit;
  const held = new Promise(resolve => { releaseCommit = resolve; });
  let stored = null;
  const deps = {
    git: {
      isRepo: async () => { calls.push('isRepo'); return true; },
      stageFiles: async () => { calls.push('stage'); return true; },
      unstageFiles: async () => true,
      commit: async () => { calls.push('commit-start'); await held; calls.push('commit-end'); return { hash: 'abc1234' }; },
    },
    buildQualitySnapshot: async () => snapshot(),
    readFile: async () => { calls.push('read'); if (stored === null) throw new Error('ENOENT'); return stored; },
    writeFile: async (_path, body) => { calls.push('write'); stored = body; },
  };
  const first = publishAppQualitySnapshot(app, deps);
  const second = publishAppQualitySnapshot(app, deps);
  releaseCommit();
  expect(await first).toMatchObject({ published: true, hash: 'abc1234' });
  expect(await second).toMatchObject({ published: false, reason: 'no-changes' });
  expect(calls).toEqual(['isRepo', 'read', 'write', 'stage', 'commit-start', 'commit-end', 'isRepo', 'read']);
});

it('unstages the file and rethrows when the commit fails, so no stray path sits in the index', async () => {
  const deps = testDeps({ git: { ...gitDouble(), commit: vi.fn(async () => { throw new Error('index.lock exists'); }) } });
  await expect(publishAppQualitySnapshot(app, deps)).rejects.toThrow('index.lock exists');
  expect(deps.git.unstageFiles).toHaveBeenCalledWith('/repo/example-app', ['.quality.json']);

  // A failed publish must not poison the checkout's queue for the next one.
  const next = testDeps();
  expect(await publishAppQualitySnapshot(app, next)).toMatchObject({ published: true });
});
