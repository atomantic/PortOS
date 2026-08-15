/**
 * Machine-wide claim for a local accelerator job.
 *
 * The claim is deliberately a file below the install's data root rather than an
 * in-process flag: PortOS worktrees and restarted server processes share the
 * same machine, and must therefore see the same owner. A dead process is
 * reclaimed on the next acquisition, so a crash cannot wedge local rendering.
 */

import { randomUUID } from 'crypto';
import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { PATHS } from './fileUtils.js';

export const HEAVY_LOCAL_JOB_CLAIM_PATH = join(PATHS.data, 'heavy-local-job.claim.json');
export const HEAVY_LOCAL_JOB_STALE_MS = 24 * 60 * 60 * 1000;

const heldClaims = new Map();
let exitCleanupInstalled = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

const parseHolder = (raw) => {
  try {
    const holder = JSON.parse(raw);
    if (!holder || typeof holder.kind !== 'string' || typeof holder.id !== 'string') return null;
    return holder;
  } catch {
    return null;
  }
};

const readHolder = async (claimPath) => {
  const raw = await readFile(claimPath, 'utf8').catch((err) => (err?.code === 'ENOENT' ? null : Promise.reject(err)));
  return raw === null ? null : parseHolder(raw);
};

const cleanupHeldClaims = () => {
  for (const [claimPath, token] of heldClaims) {
    try {
      if (existsSync(claimPath) && parseHolder(readFileSync(claimPath, 'utf8'))?.token === token) unlinkSync(claimPath);
    } catch {
      // Process-exit cleanup is best-effort. A stale PID is reclaimed later.
    }
  }
};

const installExitCleanup = () => {
  if (exitCleanupInstalled) return;
  exitCleanupInstalled = true;
  process.once('exit', cleanupHeldClaims);
};

const holderMessage = (holder, { stale = false } = {}) => {
  const started = Number.isFinite(holder?.startedAt) ? `, started ${new Date(holder.startedAt).toISOString()}` : '';
  const suffix = stale ? ' The recorded claim is older than the safety ceiling.' : '';
  return `Local accelerator is in use by ${holder?.kind || 'another job'} ${holder?.id || 'unknown'}${started}.${suffix}`;
};

const publicHolder = ({ kind, id, pid, startedAt } = {}) => ({ kind, id, pid, startedAt });

/**
 * Claim the machine-local accelerator.
 *
 * A zero timeout refuses immediately, suitable for an interactive Generate
 * action. Background callers may provide a bounded timeout to wait for a
 * currently-running job without silently waiting forever.
 */
export async function claimHeavyLocalJob({
  kind,
  id,
  timeoutMs = 0,
  claimPath = HEAVY_LOCAL_JOB_CLAIM_PATH,
  pid = process.pid,
  now = () => Date.now(),
  wait = sleep,
  pidIsAlive = isPidAlive,
} = {}) {
  if (typeof kind !== 'string' || !kind.trim() || typeof id !== 'string' || !id.trim()) {
    throw new Error('A heavy local job claim requires non-empty kind and id.');
  }
  const deadline = now() + Math.max(0, timeoutMs);
  const token = randomUUID();
  const ours = { kind, id, pid, startedAt: now(), token };
  await mkdir(dirname(claimPath), { recursive: true });

  for (;;) {
    try {
      await writeFile(claimPath, JSON.stringify(ours), { flag: 'wx' });
      heldClaims.set(claimPath, token);
      installExitCleanup();
      let released = false;
      return {
        ok: true,
        holder: publicHolder(ours),
        // Detached media children outlive a server restart. Transfer the PID
        // recorded on disk once one exists so process-exit cleanup does not
        // release a claim while that child is still consuming the accelerator.
        async handoffTo(childPid) {
          if (!Number.isInteger(childPid) || childPid <= 0) return;
          const current = await readHolder(claimPath);
          if (current?.token !== token) return;
          ours.pid = childPid;
          await writeFile(claimPath, JSON.stringify(ours));
          heldClaims.delete(claimPath);
        },
        async release() {
          if (released) return;
          released = true;
          heldClaims.delete(claimPath);
          const current = await readHolder(claimPath);
          if (current?.token === token) await unlink(claimPath).catch((err) => {
            if (err?.code !== 'ENOENT') throw err;
          });
        },
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }

    const holder = await readHolder(claimPath);
    if (!holder || !pidIsAlive(holder.pid)) {
      await unlink(claimPath).catch((err) => {
        if (err?.code !== 'ENOENT') throw err;
      });
      continue;
    }
    const stale = now() - holder.startedAt > HEAVY_LOCAL_JOB_STALE_MS;
    if (now() >= deadline) {
      return { ok: false, holder: publicHolder(holder), stale, message: holderMessage(holder, { stale }), release: async () => {} };
    }
    await wait(Math.min(250, Math.max(1, deadline - now())));
  }
}

/**
 * Adopt a claim already recorded on disk, for a process that did not
 * acquire it — a restarted server re-attaching to a detached child that
 * survived the crash (#1332). The surviving child already holds the
 * machine-wide accelerator claim (transferred to it via `handoffTo` before
 * the restart); calling `claimHeavyLocalJob` again here would see that live
 * claim as a COMPETING job and refuse it, failing every restart-survived run
 * outright. This never contends for the lock — it only recognizes a claim
 * that already names this exact job and PID, so it's safe to call blind.
 *
 * Returns `null` when no on-disk claim matches `kind`/`id`/`pid` (e.g. an
 * in-flight run that predates this claim file, or a genuinely different
 * holder), so the caller can fall back to `claimHeavyLocalJob`.
 */
export async function adoptHeavyLocalJob({
  kind, id, pid, claimPath = HEAVY_LOCAL_JOB_CLAIM_PATH,
} = {}) {
  const holder = await readHolder(claimPath);
  if (holder?.kind !== kind || holder.id !== id || holder.pid !== pid || typeof holder.token !== 'string') return null;
  let released = false;
  return {
    ok: true,
    holder: publicHolder(holder),
    async handoffTo() {},
    async release() {
      if (released) return;
      released = true;
      const current = await readHolder(claimPath);
      if (current?.token === holder.token) await unlink(claimPath).catch((err) => {
        if (err?.code !== 'ENOENT') throw err;
      });
    },
  };
}
