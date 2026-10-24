import { it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from '../lib/childProcess.js';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('./local-review-lifecycle.mjs', import.meta.url));

it('resumes one completed delivery across creation retries, restarts and multiple feedback pushes without relabeling its reviewed head', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'review-lifecycle-'));
  const git = async (...args) => (await exec('git', args, { cwd })).stdout.trim();
  const run = async (...args) => JSON.parse((await exec(process.execPath, [script, ...args], { cwd })).stdout);
  const commit = () => git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'change');
  const pr = 'https://github.com/example/repo/pull/1';
  try {
    await git('init', '-q', '-b', 'delivery');
    await git('init', '--bare', '-q', join(cwd, 'remote.git'));
    await git('remote', 'add', 'origin', join(cwd, 'remote.git'));
    await commit();
    expect((await run('check', 'main')).reusable).toBe(false);
    expect(await run('check', 'main', pr)).toMatchObject({ reusable: false, legacyPublished: true, receipt: null });
    // Failed starts and pending/findings are never successful phase completion.
    await expect(run('complete', 'main', 'pending')).rejects.toThrow();
    expect((await run('check', 'main')).reusable).toBe(false);
    const completed = await run('complete', 'main', 'clean');
    expect((await run('check', 'main')).receipt.reviewedHead).toBe(completed.reviewedHead);
    // A failed create can retry on the same head, in a new process, without review.
    expect((await run('check', 'main')).reusable).toBe(true);
    await git('push', '-q', '-u', 'origin', 'delivery');
    await run('publish', 'main', pr);
    await run('publish', 'main', pr); // interrupted publication is idempotent
    for (let n = 0; n < 2; n++) {
      await commit();
      await git('push', '-q', 'origin', 'delivery');
      const resumed = await run('check', 'main', pr);
      expect(resumed.reusable).toBe(true);
      expect(resumed.receipt.reviewedHead).toBe(completed.reviewedHead);
      expect(resumed.receipt.reviewedHead).not.toBe(await git('rev-parse', 'HEAD'));
    }
    expect((await run('check', 'main', pr.replace('/1', '/2'))).reusable).toBe(false);
    expect((await run('check', 'other-base', pr)).reusable).toBe(false);
    expect((await run('check', 'main')).reusable).toBe(false);
    await expect(run('complete', 'main', 'clean')).rejects.toThrow();
    await git('checkout', '-qb', 'new-delivery');
    expect((await run('check', 'main', pr)).reusable).toBe(false);
    await run('complete', 'main', 'review-blocked');
    await run('publish', 'main', pr.replace('/1', '/2'));
    expect((await run('check', 'main', pr.replace('/1', '/2'))).receipt.status).toBe('review-blocked');
    // Availability recovery may finish the missing reviewer in the same delivery.
    await run('complete', 'main', 'clean');
    expect((await run('check', 'main', pr.replace('/1', '/2'))).receipt.status).toBe('clean');
    expect(await readFile(join(cwd, '.git/portos-local-review-lifecycle'), 'utf8')).not.toContain('findings');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
