import { afterEach, it, expect } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from '../lib/childProcess.js';
import { assertGitWorkSettled, execGit } from '../lib/execGit.js';
import { localReviewLifecycle } from '../lib/localReviewLifecycle.js';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('./local-review-lifecycle.mjs', import.meta.url));
let workflow;

// A test deadline does not cancel its async body or its admitted Git work.
afterEach(async () => { await Promise.allSettled([workflow]); });

it('resumes one completed delivery across creation retries, restarts and multiple feedback pushes without relabeling its reviewed head', () => {
  workflow = exerciseDelivery();
  return workflow;
});

async function exerciseDelivery() {
  const cwd = await mkdtemp(join(tmpdir(), 'review-lifecycle-'));
  const git = async (...args) => (await execGit(args, cwd)).stdout.trim();
  const run = (action, base, value) => localReviewLifecycle(cwd, {
    action, base, ...(action === 'complete' ? { status: value } : { prUrl: value }),
  });
  let cliHeld = false;
  const cli = async (...args) => {
    try {
      return JSON.parse((await exec(process.execPath, [script, ...args], { cwd, timeout: 15000 })).stdout);
    } catch (error) {
      cliHeld ||= Boolean(error.killed || error.signal);
      throw error;
    }
  };
  const phase = async (status, reviewedHead) => writeFile(join(cwd, '.git/portos-local-review-state'), `LOCAL_OVERALL_STATUS=${status}\nLOCAL_REVIEWED_HEAD_SHA=${reviewedHead ?? await git('rev-parse', 'HEAD')}\nLOCAL_REMEDIATED_HEAD_SHA=${await git('rev-parse', 'HEAD')}\n`);
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
    await expect(cli('complete', 'main', 'pending')).rejects.toMatchObject({
      code: 1,
      stdout: '',
      stderr: 'Local review lifecycle evidence is missing, invalid or belongs to another delivery; preserve it and stop.\n',
    });
    expect((await run('check', 'main')).reusable).toBe(false);
    await expect(cli('complete', 'main', 'clean')).rejects.toMatchObject({ code: 1 });
    await phase('clean');
    const completed = await cli('complete', 'main', 'clean');
    expect(completed).toMatchObject({ version: 2, completedHead: await git('rev-parse', 'HEAD'), inspectionProvenance: 'recorded' });
    expect((await run('check', 'main')).receipt.reviewedHead).toBe(completed.reviewedHead);
    // A failed create can retry on the same head without another review.
    expect((await run('check', 'main')).reusable).toBe(true);
    await git('push', '-q', '-u', 'origin', 'delivery');
    await cli('publish', 'main', pr);
    await run('publish', 'main', pr); // interrupted publication is idempotent
    for (let n = 0; n < 2; n++) {
      await commit();
      await git('push', '-q', 'origin', 'delivery');
      const resumed = await run('check', 'main', pr);
      expect(resumed.reusable).toBe(true);
      expect(resumed.receipt.reviewedHead).toBe(completed.reviewedHead);
      expect(resumed.receipt.reviewedHead).not.toBe(await git('rev-parse', 'HEAD'));
    }
    // A real fresh process must recover the durable receipt after feedback pushes.
    expect(await cli('check', 'main', pr)).toMatchObject({
      reusable: true, receipt: { reviewedHead: completed.reviewedHead, prUrl: pr, status: 'clean' },
    });
    expect((await run('check', 'main', pr.replace('/1', '/2'))).reusable).toBe(false);
    expect((await run('check', 'other-base', pr)).reusable).toBe(false);
    expect((await run('check', 'main')).reusable).toBe(false);
    await expect(run('complete', 'main', 'clean')).rejects.toThrow();
    await git('checkout', '-qb', 'new-delivery');
    expect((await run('check', 'main', pr)).reusable).toBe(false);
    await phase('review-blocked', '');
    await run('complete', 'main', 'review-blocked');
    await run('publish', 'main', pr.replace('/1', '/2'));
    expect((await run('check', 'main', pr.replace('/1', '/2'))).receipt.status).toBe('review-blocked');
    // Availability recovery may finish the missing reviewer in the same delivery.
    await phase('clean');
    await run('complete', 'main', 'clean');
    expect((await run('check', 'main', pr.replace('/1', '/2'))).receipt.status).toBe('clean');
    expect(await readFile(join(cwd, '.git/portos-local-review-lifecycle'), 'utf8')).not.toContain('findings');

    await git('checkout', '-qb', 'partial-delivery');
    const inspected = await git('rev-parse', 'HEAD');
    await commit();
    const remediated = await git('rev-parse', 'HEAD');
    await phase('partial', inspected);
    const partial = await cli('complete', 'main', 'partial');
    expect(partial).toMatchObject({ completedHead: remediated, reviewedHead: inspected, inspectionProvenance: 'recorded' });
    // Creation interrupted after completion can resume, but new commits cannot be silently published.
    expect((await cli('check', 'main')).reusable).toBe(true);
    await commit();
    await expect(cli('publish', 'main', pr)).rejects.toMatchObject({ code: 1 });
    await git('reset', '--hard', remediated);
    await cli('publish', 'main', pr);
    await commit();
    expect(await cli('check', 'main', pr)).toMatchObject({ reusable: true, receipt: { ...partial, prUrl: pr },
      inspection: { completedHead: remediated, reviewedHead: inspected, inspectionProvenance: 'recorded' } });

    await git('checkout', '-qb', 'invalid-evidence');
    const receiptPath = join(cwd, '.git/portos-local-review-lifecycle');
    const original = await readFile(receiptPath, 'utf8');
    await phase('clean', 'f'.repeat(40));
    await expect(cli('complete', 'main', 'clean')).rejects.toMatchObject({ code: 1 });
    await phase('partial');
    await expect(cli('complete', 'main', 'clean')).rejects.toMatchObject({ code: 1 });
    await phase('clean');
    await commit();
    await expect(cli('complete', 'main', 'clean')).rejects.toMatchObject({ code: 1 });
    await phase('clean');
    await writeFile(join(cwd, '.git/portos-review-status'), `REVIEW_STATUS=clean\nREVIEW_HEAD=${inspected}\n`);
    await expect(cli('complete', 'main', 'clean')).rejects.toMatchObject({ code: 1 });
    await writeFile(join(cwd, '.git/portos-review-status'), 'REVIEW_STATUS=clean\nREVIEW_STATUS=clean\n');
    await expect(cli('complete', 'main', 'clean')).rejects.toMatchObject({ code: 1 });
    await writeFile(join(cwd, '.git/portos-review-status'), 'REVIEW_STATUS=clean\n');
    await mkdir(`${receiptPath}.tmp`);
    await expect(cli('complete', 'main', 'clean')).rejects.toMatchObject({ code: 1 });
    await rmdir(`${receiptPath}.tmp`);
    expect(await readFile(receiptPath, 'utf8')).toBe(original);

    const legacy = { ...completed, version: 1, branch: 'invalid-evidence', reviewedHead: await git('rev-parse', 'HEAD'), prUrl: pr };
    delete legacy.completedHead;
    delete legacy.inspectionProvenance;
    await writeFile(receiptPath, JSON.stringify(legacy));
    expect(await cli('check', 'main', pr)).toMatchObject({ reusable: true, receipt: legacy,
      inspection: { reviewedHead: null, completedHead: legacy.reviewedHead, inspectionProvenance: 'legacy-unknown' } });
    await commit();
    expect((await cli('check', 'main', pr)).reusable).toBe(true);
    expect(JSON.parse(await readFile(receiptPath, 'utf8'))).toEqual(legacy);
    const malformed = { ...legacy, version: 2, completedHead: legacy.reviewedHead, reviewedHead: null, inspectionProvenance: 'recorded' };
    await writeFile(receiptPath, JSON.stringify(malformed));
    await expect(cli('check', 'main', pr)).rejects.toMatchObject({ code: 1 });
    expect(JSON.parse(await readFile(receiptPath, 'utf8'))).toEqual(malformed);

  } finally {
    if (cliHeld) throw new Error('Local review CLI settlement is unconfirmed; fixture retained');
    assertGitWorkSettled(cwd);
    await rm(cwd, { recursive: true, force: true });
  }
}
