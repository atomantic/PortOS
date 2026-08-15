import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { adoptHeavyLocalJob, claimHeavyLocalJob, HEAVY_LOCAL_JOB_STALE_MS } from './heavyJobClaim.js';

const withClaimPath = async (run) => {
  const dir = await mkdtemp(join(tmpdir(), 'portos-heavy-job-'));
  const claimPath = join(dir, 'claim.json');
  try {
    await run(claimPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe('claimHeavyLocalJob', () => {
  it('holds one cross-process claim until its owner releases it', async () => {
    await withClaimPath(async (claimPath) => {
      const first = await claimHeavyLocalJob({ kind: 'image', id: 'job-a', claimPath });
      expect(first.ok).toBe(true);
      expect(first.holder).toMatchObject({ kind: 'image', id: 'job-a', pid: process.pid });
      expect(first.holder).not.toHaveProperty('token');

      const second = await claimHeavyLocalJob({ kind: 'video', id: 'job-b', claimPath, pidIsAlive: () => true });
      expect(second).toMatchObject({ ok: false, holder: { kind: 'image', id: 'job-a' } });

      await first.handoffTo(12345);
      expect(JSON.parse(await readFile(claimPath, 'utf8'))).toMatchObject({ pid: 12345 });
      await first.release();
      expect(existsSync(claimPath)).toBe(false);
    });
  });

  it('reclaims a lock whose recorded PID is no longer alive', async () => {
    await withClaimPath(async (claimPath) => {
      await writeFile(claimPath, JSON.stringify({ kind: 'training', id: 'old', pid: 42, startedAt: 1, token: 'old' }));
      const claim = await claimHeavyLocalJob({ kind: 'video', id: 'new', claimPath, pidIsAlive: () => false });
      expect(claim).toMatchObject({ ok: true, holder: { kind: 'video', id: 'new' } });
      expect(JSON.parse(await readFile(claimPath, 'utf8'))).toMatchObject({ kind: 'video', id: 'new' });
      await claim.release();
    });
  });

  it('waits only through its bounded timeout for a background caller', async () => {
    await withClaimPath(async (claimPath) => {
      await writeFile(claimPath, JSON.stringify({ kind: 'training', id: 'held', pid: 42, startedAt: 0, token: 'old' }));
      let now = 0;
      const wait = vi.fn(async (ms) => { now += ms; });
      const result = await claimHeavyLocalJob({
        kind: 'video', id: 'waiting', claimPath, timeoutMs: 500, now: () => now, wait, pidIsAlive: () => true,
      });
      expect(result).toMatchObject({ ok: false, holder: { kind: 'training', id: 'held' } });
      expect(wait).toHaveBeenCalled();
    });
  });

  it('reports a live holder that has exceeded the stale-age ceiling without stealing it', async () => {
    await withClaimPath(async (claimPath) => {
      await writeFile(claimPath, JSON.stringify({ kind: 'training', id: 'held', pid: 42, startedAt: 0, token: 'old' }));
      const result = await claimHeavyLocalJob({
        kind: 'video', id: 'next', claimPath, now: () => HEAVY_LOCAL_JOB_STALE_MS + 1, pidIsAlive: () => true,
      });
      expect(result.stale).toBe(true);
      expect(result.message).toContain('older than the safety ceiling');
    });
  });
});

describe('adoptHeavyLocalJob', () => {
  // #1332 boot re-attach: a restarted server re-attaches to a detached trainer
  // that survived the crash. That trainer's PID already holds the machine-wide
  // claim (handed off to it pre-restart) — the new process must recognize and
  // adopt that claim rather than contending for a fresh one, which would see
  // its own survivor as a competing job and refuse it.
  it('adopts an on-disk claim already recorded for this exact kind/id/pid', async () => {
    await withClaimPath(async (claimPath) => {
      await writeFile(claimPath, JSON.stringify({
        kind: 'LoRA training', id: 'run-a', pid: 4242, startedAt: 0, token: 'tok-a',
      }));
      const adopted = await adoptHeavyLocalJob({ kind: 'LoRA training', id: 'run-a', pid: 4242, claimPath });
      expect(adopted).toMatchObject({ ok: true, holder: { kind: 'LoRA training', id: 'run-a', pid: 4242 } });

      await adopted.release();
      expect(existsSync(claimPath)).toBe(false);
    });
  });

  it('returns null (does not steal) when no claim exists, or the on-disk claim names a different job', async () => {
    await withClaimPath(async (claimPath) => {
      expect(await adoptHeavyLocalJob({ kind: 'LoRA training', id: 'run-a', pid: 4242, claimPath })).toBeNull();

      await writeFile(claimPath, JSON.stringify({
        kind: 'LoRA training', id: 'run-a', pid: 4242, startedAt: 0, token: 'tok-a',
      }));
      // Wrong id, wrong pid, and wrong kind all fail to match — and the claim
      // file is left untouched (still readable, still holding the same token).
      expect(await adoptHeavyLocalJob({ kind: 'LoRA training', id: 'run-b', pid: 4242, claimPath })).toBeNull();
      expect(await adoptHeavyLocalJob({ kind: 'LoRA training', id: 'run-a', pid: 9999, claimPath })).toBeNull();
      expect(await adoptHeavyLocalJob({ kind: 'video', id: 'run-a', pid: 4242, claimPath })).toBeNull();
      expect(JSON.parse(await readFile(claimPath, 'utf8'))).toMatchObject({ token: 'tok-a' });
    });
  });

  it('release() only removes the claim file if its token still matches', async () => {
    await withClaimPath(async (claimPath) => {
      await writeFile(claimPath, JSON.stringify({
        kind: 'LoRA training', id: 'run-a', pid: 4242, startedAt: 0, token: 'tok-a',
      }));
      const adopted = await adoptHeavyLocalJob({ kind: 'LoRA training', id: 'run-a', pid: 4242, claimPath });

      // Someone else already claimed the path under a different token by the
      // time release() runs — it must not remove that unrelated claim.
      await writeFile(claimPath, JSON.stringify({
        kind: 'video', id: 'run-c', pid: 1, startedAt: 0, token: 'tok-c',
      }));
      await adopted.release();
      expect(JSON.parse(await readFile(claimPath, 'utf8'))).toMatchObject({ token: 'tok-c' });
    });
  });
});
