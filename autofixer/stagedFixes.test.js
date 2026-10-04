import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { createStagedFixStore } from './stagedFixes.js';
let root, repo, store, restart;
const id = 'autofixer_example_123';
const patch = 'diff --git a/example.txt b/example.txt\nindex 3367afd..3e75765 100644\n--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-old\n+new\n';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'autofixer-staged-'));
  repo = join(root, 'repo');
  await mkdir(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
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
  it('shows the proposal, applies its actual git patch once, and persists history disposition', async () => {
    expect((await store.read(id)).patch).toBe(patch);
    const results = await Promise.all([store.mutate(id, 'apply'), store.mutate(id, 'apply')]);
    expect(results.map(result => result.status || 200)).toEqual([200, 404]);
    expect((await readFile(join(repo, 'example.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('new\n');
    expect(restart).toHaveBeenCalledExactlyOnceWith(['restart', 'example-process']);
    expect(await store.decorateHistory([{ sessionId: id, staged: true }])).toEqual([
      { sessionId: id, staged: false, promoted: true, disposition: 'applied' },
    ]);
  });
  it('rejects a stale patch without changing files or restarting', async () => {
    await writeFile(join(repo, 'example.txt'), 'newer edit\n');
    expect((await store.mutate(id, 'apply')).status).toBe(409);
    expect(await readFile(join(repo, 'example.txt'), 'utf8')).toBe('newer edit\n');
    expect(restart).not.toHaveBeenCalled();
  });
  it('rolls back on restart failure and retains the staged proposal', async () => {
    restart.mockRejectedValue(new Error('example restart failure'));
    expect((await store.mutate(id, 'apply')).status).toBe(500);
    expect(await readFile(join(repo, 'example.txt'), 'utf8')).toBe('old\n');
    expect((await store.read(id)).patch).toBe(patch);
  });
  it('discards without applying and rejects traversal IDs', async () => {
    expect((await store.read('../outside')).status).toBe(404);
    expect(await store.mutate(id, 'discard')).toEqual({ success: true, disposition: 'discarded' });
    expect((await store.read(id)).status).toBe(404);
    expect(await readFile(join(repo, 'example.txt'), 'utf8')).toBe('old\n');
    expect(restart).not.toHaveBeenCalled();
  });
});
