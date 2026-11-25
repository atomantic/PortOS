// test-memo: git-fixture — git only ever runs in repositories this suite creates under the temp directory (docs/TEST_MEMO_GIT_FIXTURES.md).
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, mkdir, stat, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { createStagedFixStore, isAutofixerSessionId, buildAutofixerSessionId, processNameFromSessionId } from './stagedFixes.js';
let root, repo, store, restart;
const id = 'autofixer_example_123';
// git apply/checkout on Windows applies autocrlf, so compare with LF endings.
const readExample = async (repo) => (await readFile(join(repo, 'example.txt'), 'utf8')).replace(/\r\n/g, '\n');

const patch = 'diff --git a/example.txt b/example.txt\nindex 3367afd..3e75765 100644\n--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-old\n+new\n';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'autofixer-staged-'));
  repo = join(root, 'repo');
  await mkdir(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  // The fixture's exact-byte patch/rollback contract must not inherit the
  // runner's checkout conversion (core.autocrlf=true on Windows).
  execFileSync('git', ['config', '--local', 'core.autocrlf', 'false'], { cwd: repo });
  await writeFile(join(repo, 'example.txt'), 'old\n');
  await mkdir(join(root, 'sessions', id), { recursive: true });
  await writeFile(join(root, 'sessions', id, 'metadata.json'), JSON.stringify({
    sessionId: id, appId: 'example', repoPath: repo, processName: 'example-process', staged: true,
  }));
  await writeFile(join(root, 'sessions', id, 'fix.patch'), patch);
  restart = vi.fn().mockResolvedValue({ stdout: 'ok' });
  store = createStagedFixStore({ root, execPm2: restart,
    loadApps: async () => [{ id: 'example', repoPath: repo, pm2ProcessNames: ['example-process'] }] });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
describe('staged repair lifecycle', () => {
  it.skipIf(process.platform === 'win32')('replaces legacy metadata with a private file even after a stale temp write', async () => {
    const metadata = join(root, 'sessions', id, 'metadata.json');
    const temp = `${metadata}.tmp`;
    await chmod(metadata, 0o644);
    await writeFile(temp, 'interrupted write');
    await chmod(temp, 0o644);

    expect(await store.mutate(id, 'discard')).toEqual({ success: true, disposition: 'discarded' });
    expect((await stat(metadata)).mode & 0o777).toBe(0o600);
    await expect(stat(temp)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('shows the proposal, applies its actual git patch once, and persists history disposition', async () => {
    expect((await store.read(id)).patch).toBe(patch);
    const results = await Promise.all([store.mutate(id, 'apply'), store.mutate(id, 'apply')]);
    expect(results.map(result => result.status || 200)).toEqual([200, 404]);
    expect(await readExample(repo)).toBe('new\n');
    expect(restart).toHaveBeenCalledExactlyOnceWith(['restart', 'example-process']);
    expect(await store.decorateHistory([{ sessionId: id, staged: true }])).toEqual([
      { sessionId: id, staged: false, promoted: true, disposition: 'applied' },
    ]);
  });
  it('runs a dashboard mutation after the monitor releases its promotion lock', async () => {
    const hold = Promise.withResolvers();
    const monitor = store.serialize(() => hold.promise);
    const discard = store.mutate(id, 'discard');
    try {
      expect((await store.read(id)).patch).toBe(patch);
    } finally {
      hold.resolve();
    }
    await monitor;
    expect(await discard).toEqual({ success: true, disposition: 'discarded' });
    expect((await store.read(id)).status).toBe(404);
  });

  it('finishes the in-flight transaction and refuses queued mutations during shutdown', async () => {
    const entered = Promise.withResolvers();
    const hold = Promise.withResolvers();
    restart.mockImplementation(async () => {
      entered.resolve();
      return hold.promise;
    });
    const apply = store.mutate(id, 'apply');
    await entered.promise;
    const refused = expect(store.mutate(id, 'discard')).rejects.toThrow('shutting down');
    const drain = store.stopMutations();
    hold.resolve({ stdout: 'ok' });
    await drain;
    await expect(apply).resolves.toEqual({ success: true, disposition: 'applied' });
    await refused;
    expect(await store.decorateHistory([{ sessionId: id, staged: true }])).toMatchObject([{ staged: false, promoted: true }]);
  });

  it('rejects a stale patch without changing files or restarting', async () => {
    await writeFile(join(repo, 'example.txt'), 'newer edit\n');
    expect((await store.mutate(id, 'apply')).status).toBe(409);
    expect(await readExample(repo)).toBe('newer edit\n');
    expect(restart).not.toHaveBeenCalled();
  });
  it('rolls back on restart failure and retains the staged proposal', async () => {
    restart.mockRejectedValue(new Error('example restart failure'));
    expect((await store.mutate(id, 'apply')).status).toBe(500);
    expect(await readExample(repo)).toBe('old\n');
    expect((await store.read(id)).patch).toBe(patch);
  });

  it('protects a self-restart session until the staged fix is restored after a restart failure', async () => {
    const processName = 'portos-autofixer';
    await writeFile(join(root, 'sessions', id, 'metadata.json'), JSON.stringify({
      sessionId: id, appId: 'example', repoPath: repo, processName, staged: true,
    }));
    const result = Promise.withResolvers();
    restart.mockReturnValue(result.promise);
    store = createStagedFixStore({ root, execPm2: restart,
      loadApps: async () => [{ id: 'example', repoPath: repo, pm2ProcessNames: [processName] }] });

    expect(await store.mutate(id, 'apply')).toMatchObject({ status: 202 });
    try {
      expect(await store.canPrune(id)).toBe(false);
    } finally {
      result.reject(new Error('example restart failure'));
    }
    await vi.waitFor(async () => expect((await store.read(id)).patch).toBe(patch));
    expect(await store.canPrune(id)).toBe(false);
  });

  it('discards without applying and rejects traversal IDs', async () => {
    expect((await store.read('../outside')).status).toBe(404);
    expect(await store.mutate(id, 'discard')).toEqual({ success: true, disposition: 'discarded' });
    expect((await store.read(id)).status).toBe(404);
    expect(await readExample(repo)).toBe('old\n');
    expect(restart).not.toHaveBeenCalled();
  });
});

describe('session IDs for dotted PM2 process names', () => {
  it('encodes new IDs to a filesystem-safe grammar and recovers the name', () => {
    const generated = buildAutofixerSessionId('example.worker', 1700000000000, 0.123456789);
    expect(generated).toMatch(/^autofixer_example_2e_worker_1700000000000_[a-z0-9]+$/);
    expect(isAutofixerSessionId(generated)).toBe(true);
    expect(processNameFromSessionId(generated)).toBe('example.worker');
  });

  it('keeps pre-encoding dotted IDs operable but rejects malformed, traversal and unrelated names', () => {
    expect(isAutofixerSessionId('autofixer_example.worker_1700000000000_abc123def')).toBe(true);
    for (const bad of ['autofixer_example.worker', 'autofixer_a/../b.c_1_x', 'autofixer_a.b_1_x/..',
      'autofixer_a\\b.c_1_x', '../autofixer_a.b_1_x', 'other_a.b_1_x', 'autofixer_.._1_x', '', null]) {
      expect(isAutofixerSessionId(bad)).toBe(false);
    }
  });

  it.each([
    ['encoded', 'autofixer_example_2e_worker_1700000000000_abc123def'],
    ['legacy', 'autofixer_example.worker_1700000000000_abc123def'],
  ])('reads, discards and prunes a %s dotted session', async (_label, dotted) => {
    await mkdir(join(root, 'sessions', dotted), { recursive: true });
    await writeFile(join(root, 'sessions', dotted, 'metadata.json'), JSON.stringify({
      sessionId: dotted, appId: 'example', repoPath: repo, processName: 'example.worker', staged: true,
    }));
    await writeFile(join(root, 'sessions', dotted, 'fix.patch'), patch);
    expect((await store.read(dotted)).patch).toBe(patch);
    expect(await store.canPrune(dotted)).toBe(false);
    expect(await store.mutate(dotted, 'discard')).toEqual({ success: true, disposition: 'discarded' });
    expect(await store.canPrune(dotted)).toBe(true);
  });
});
