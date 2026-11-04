/**
 * Machine-wide claim for a local accelerator job.
 *
 * The claim is deliberately a file below the install's data root rather than an
 * in-process flag: PortOS worktrees and restarted server processes share the
 * same machine, and must therefore see the same owner. A dead process is
 * reclaimed on the next acquisition, so a crash cannot wedge local rendering.
 */

import { randomUUID } from 'crypto';
import { link, mkdir, open, readFile, readdir, unlink } from 'fs/promises';
import { constants, existsSync, readFileSync, realpathSync, unlinkSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { PATHS, atomicWrite, sleep, writeFileGuarded } from './fileUtils.js';
import { maintenance } from './maintenanceAdmission.js';

export const HEAVY_LOCAL_JOB_CLAIM_PATH = join(PATHS.data, 'heavy-local-job.claim.json');
export const HEAVY_LOCAL_JOB_STALE_MS = 24 * 60 * 60 * 1000;

const heldClaims = new Map();
const locallyCompletedClaims = new Map();
const recoveringClaims = new Map();
const localMutations = new Map();
let exitCleanupInstalled = false;

// Serialize same-process compare-and-remove operations with claim publication.
// The on-disk claim still provides exclusion between separate processes.
const tryLockMutation = claimPath => {
  if (localMutations.has(claimPath)) return null;
  let done;
  const finished = new Promise(resolve => { done = resolve; });
  localMutations.set(claimPath, finished);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    localMutations.delete(claimPath);
    done();
  };
};

const lockMutation = async claimPath => {
  for (;;) {
    const unlock = tryLockMutation(claimPath);
    if (unlock) return unlock;
    await localMutations.get(claimPath);
  }
};

// A known survivor must be observed while its on-disk claim is reattached.
export function beginHeavyJobRecovery(id) {
  const token = randomUUID();
  recoveringClaims.set(token, id);
  return () => recoveringClaims.delete(token);
}

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

// Only this process may schedule cleanup of its own completed token.
const scheduleCompletedCleanup = (claimPath, token) => {
  const retry = async () => {
    if (locallyCompletedClaims.get(claimPath) !== token) return;
    const unlock = tryLockMutation(claimPath);
    if (!unlock) {
      const timer = setTimeout(() => { void retry(); }, 1000);
      timer.unref?.();
      return;
    }
    try {
      if (locallyCompletedClaims.get(claimPath) !== token) return;
      locallyCompletedClaims.delete(claimPath);
      const current = await readHolder(claimPath);
      if (current?.token === token && current.pid === process.pid) await unlink(claimPath).catch(err => { if (err?.code !== 'ENOENT') throw err; });
    } catch {
      locallyCompletedClaims.set(claimPath, token);
      const timer = setTimeout(() => { void retry(); }, 1000);
      timer.unref?.();
    } finally { unlock(); }
  };
  const timer = setTimeout(() => { void retry(); }, 1000);
  timer.unref?.();
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
export const __cleanupHeldClaims = cleanupHeldClaims;

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

// Publish a complete file with no-replace semantics: other claimants must not
// observe an empty file between exclusive open and the owner's first write.
async function publishClaim(path, data, { writeTemp = writeFileGuarded, linkFile = link, removeTemp = unlink } = {}) {
  const temporary = `${path}.${randomUUID()}.pending`;
  try {
    await writeTemp(temporary, data, { flag: 'wx' });
    await linkFile(temporary, path).catch(err => {
      if (['EPERM', 'ENOSYS', 'EOPNOTSUPP', 'ENOTSUP', 'EACCES'].includes(err?.code)) {
        throw Object.assign(new Error('Local accelerator claims require a data directory that permits hard links on a supported filesystem.'),
          { code: 'HEAVY_CLAIM_LINK_UNSUPPORTED', cause: err });
      }
      throw err;
    });
  } finally {
    await removeTemp(temporary).catch(err => {
      if (err?.code !== 'ENOENT') console.warn('⚠️ Temporary accelerator claim could not be removed');
    });
  }
}
export { publishClaim as __publishClaim };

// Retired trainers can survive a server restart before their accelerator file
// is rebound. Their existing detached controls identify the real live child;
// history and recycled PIDs do not reserve the accelerator.
const readTrainerPid = async path => {
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 128) return null;
    const raw = await file.readFile('utf8');
    return { raw, at: info.mtimeMs };
  } finally { await file.close(); }
};

async function findSurvivingTrainer({ root = PATHS.trainingRuns, ignorePid = null,
  snapshot = async () => (await import('./detachedSpawn.js')).snapshotMaintenanceProcesses(),
  readControl = readTrainerPid } = {}) {
  let rootUnavailable = false;
  const entries = await readdir(root, { withFileTypes: true }).catch(err => {
    if (err?.code === 'ENOENT') return [];
    rootUnavailable = true;
    return [];
  });
  const candidates = [];
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const run = join(root, entry.name);
    const control = join(run, '.detached');
    runs.push(run);
    const pidPath = join(control, 'pid');
    let evidence;
    try {
      evidence = await readControl(pidPath);
    } catch (err) {
      if (err?.code !== 'ENOENT') console.warn('⚠️ A trainer control is unreadable; checking live process commands instead');
      continue;
    }
    const pid = Number(evidence?.raw?.trim());
    if (Number.isSafeInteger(pid) && pid > 0 && pid !== ignorePid) candidates.push({ pid, at: evidence.at, run });
  }
  if (!runs.length && !rootUnavailable) return null;
  const processes = await snapshot();
  const byPid = new Map(processes.map(process => [process.pid, process]));
  const recoveryAncestors = new Set();
  if (ignorePid && ignorePid !== process.pid) {
    let parent = byPid.get(ignorePid)?.ppid;
    while (parent && !recoveryAncestors.has(parent)) {
      recoveryAncestors.add(parent);
      parent = byPid.get(parent)?.ppid;
    }
  }
  const isRecoveringChild = row => {
    if (!ignorePid || ignorePid === row.pid || ignorePid === process.pid) return row.pid === ignorePid;
    if (recoveryAncestors.has(row.pid)) return true;
    const seen = new Set();
    let parent = row.ppid;
    while (parent && !seen.has(parent)) {
      if (parent === ignorePid) return true;
      seen.add(parent);
      parent = byPid.get(parent)?.ppid;
    }
    return false;
  };
  const normalize = value => {
    let path = resolve(value);
    try { path = realpathSync(path); } catch { /* A missing path cannot be canonicalized. */ }
    return path.replaceAll('\\', '/').toLowerCase();
  };
  const paths = run => [resolve(run).replaceAll('\\', '/').toLowerCase(), normalize(run)];
  const related = (command, run) => paths(run).some(path => command.includes(path));
  const trainingCommand = command => (/(?:^|[\s/"'])train_(?:mflux|flux2)_lora\.py(?=$|[\s"'])/.test(command)
      && command.includes('--output-dir'))
    || ((/(?:^|[\s/"'])mflux-train(?:\.exe)?(?=$|[\s"'])/.test(command)
      || /(?:^|\s)-m\s+mflux\.models\.common\.cli\.train(?:$|\s)/.test(command))
      && /--(?:config|resume)(?:\s|=)/.test(command));
  const trainer = candidates.find(candidate => {
    const process = processes.find(row => row.pid === candidate.pid);
    const command = String(process?.command ?? '').replaceAll('\\', '/').toLowerCase();
    return process && !String(process.state ?? '').startsWith('Z')
      && (!Number.isFinite(process.startedAt) || process.startedAt <= candidate.at + 2000)
      && trainingCommand(command) && related(command, candidate.run);
  });
  if (trainer) return trainer;
  return processes.find(process => {
    if (isRecoveringChild(process) || String(process.state ?? '').startsWith('Z')) return false;
    const command = String(process.command ?? '').replaceAll('\\', '/').toLowerCase();
    return trainingCommand(command) && (runs.some(run => related(command, run)) || (rootUnavailable && related(command, root)));
  }) ?? null;
}
export { findSurvivingTrainer as __findSurvivingTrainer };

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
  unlinkClaim = unlink,
  writeClaim = atomicWrite,
  createClaim = publishClaim,
  writeCompletion = writeFileGuarded,
  survivorCheck = findSurvivingTrainer,
  continuationOwned = false,
  admission = maintenance,
} = {}) {
  if (typeof kind !== 'string' || !kind.trim() || typeof id !== 'string' || !id.trim()) {
    throw new Error('A heavy local job claim requires non-empty kind and id.');
  }
  const recoveryBlocked = () => [...recoveringClaims.values()].some(owner => owner !== id);
  const recoveryBusy = () => ({ ok: false, message: 'Local accelerator is in use by a recovering job.', release: async () => {} });
  if (continuationOwned) admission.assertCurrent();
  const permit = continuationOwned ? null : admission.admit('heavy-job', id.slice(0, 256), { continuation: true });
  let retained = false;
  try {
    const deadline = now() + Math.max(0, timeoutMs);
    const token = randomUUID();
    const ours = { kind, id, pid, startedAt: now(), token };
    await mkdir(dirname(claimPath), { recursive: true });
    // Called while holding the local mutation lock.
    const withdraw = async () => {
      if (pid === process.pid) {
        locallyCompletedClaims.set(claimPath, token);
        scheduleCompletedCleanup(claimPath, token);
      }
      const current = await readHolder(claimPath);
      if (current?.token !== token) { if (locallyCompletedClaims.get(claimPath) === token) locallyCompletedClaims.delete(claimPath); return; }
      // A recovery claimant can itself be a live detached trainer. Keep its
      // durable PID rather than withdraw evidence of work that already exists.
      if (pid !== process.pid && pidIsAlive(pid)) return;
      for (let attempt = 0; ; attempt++) {
        try {
          await unlinkClaim(claimPath);
          if (locallyCompletedClaims.get(claimPath) === token) locallyCompletedClaims.delete(claimPath);
          return;
        }
        catch (err) {
          if (err?.code === 'ENOENT') { if (locallyCompletedClaims.get(claimPath) === token) locallyCompletedClaims.delete(claimPath); return; }
          if (attempt < 2) { await wait(100); continue; }
          await writeCompletion(`${claimPath}.completed.json`, JSON.stringify({ token, pid, ownerPid: process.pid, finishedAt: new Date().toISOString() }));
          return;
        }
      }
    };

    for (;;) {
      const recovering = recoveryBlocked() || localMutations.has(claimPath);
      let survivor;
      try { survivor = !recovering && await survivorCheck({ ignorePid: pid }); }
      catch (err) {
        if (now() >= deadline) throw err;
        await wait(Math.min(250, Math.max(1, deadline - now())));
        continue;
      }
      if (recovering || survivor) {
        if (now() >= deadline) return recoveryBusy();
        await wait(Math.min(recovering ? 250 : 2000, Math.max(1, deadline - now())));
        continue;
      }
      const unlock = tryLockMutation(claimPath);
      if (!unlock) {
        if (now() >= deadline) return recoveryBusy();
        await wait(Math.min(250, Math.max(1, deadline - now())));
        continue;
      }
      try {
        if (recoveryBlocked()) {
          unlock();
          if (now() >= deadline) return recoveryBusy();
          await wait(Math.min(250, Math.max(1, deadline - now())));
          continue;
        }
        let created = false;
        try {
          await createClaim(claimPath, JSON.stringify(ours), { flag: 'wx' });
          created = true;
          let blocked, observedSurvivor = false;
          try {
            blocked = recoveryBlocked();
            if (!blocked) observedSurvivor = Boolean(await survivorCheck({ ignorePid: pid }));
            blocked = blocked || observedSurvivor || recoveryBlocked();
          }
          catch (err) {
            await withdraw();
            if (now() >= deadline) throw err;
            unlock();
            await wait(Math.min(250, Math.max(1, deadline - now())));
            continue;
          }
          if (blocked) {
            await withdraw();
            unlock();
            if (now() >= deadline) return recoveryBusy();
            await wait(Math.min(observedSurvivor ? 2000 : 250, Math.max(1, deadline - now())));
            continue;
          }
          if (pid === process.pid) heldClaims.set(claimPath, token);
          installExitCleanup();
          let releasePromise;
          let handoffAttempted = false;
          retained = true;
          return {
            ok: true,
            holder: publicHolder(ours),
            // Detached media children outlive a server restart. Transfer the PID
            // recorded on disk once one exists so process-exit cleanup does not
            // release a claim while that child is still consuming the accelerator.
            async handoffTo(childPid) {
              if (!Number.isInteger(childPid) || childPid <= 0) return;
              handoffAttempted = true;
              heldClaims.delete(claimPath);
              const unlockHandoff = await lockMutation(claimPath);
              try {
                const current = await readHolder(claimPath);
                if (current?.token !== token) throw Object.assign(new Error('Accelerator claim ownership changed.'), { code: 'HEAVY_CLAIM_CHANGED' });
                await writeClaim(claimPath, { ...ours, pid: childPid });
                ours.pid = childPid;
              } finally { unlockHandoff(); }
            },
            release({ childSettled = false } = {}) {
              if (releasePromise) return releasePromise;
              heldClaims.delete(claimPath);
              releasePromise = (async () => {
                const unlockRelease = await lockMutation(claimPath);
                try {
                  const removeOwnClaim = async () => {
                    const current = await readHolder(claimPath);
                    if (current?.token === token) await unlinkClaim(claimPath).catch(err => { if (err?.code !== 'ENOENT') throw err; });
                  };
                  for (let attempt = 0; ; attempt++) {
                    try {
                      await removeOwnClaim();
                      break;
                    } catch (err) {
                      if (attempt < 2) { await wait(100); continue; }
                      console.warn(`⚠️ Accelerator claim cleanup remains incomplete: ${err.message}`);
                      if (ours.pid === process.pid && (!handoffAttempted || childSettled)) {
                        locallyCompletedClaims.set(claimPath, token);
                        scheduleCompletedCleanup(claimPath, token);
                      }
                      try {
                        // Completion evidence is bound to this random claim token;
                        // it does not claim anything about generated output.
                        await writeCompletion(`${claimPath}.completed.json`, JSON.stringify({ token, pid: ours.pid,
                          ownerPid: handoffAttempted && !childSettled ? null : process.pid, finishedAt: new Date().toISOString() }));
                      } catch (markerError) {
                        permit?.markUnsettled();
                        await permit?.finish();
                        throw markerError;
                      }
                      break;
                    }
                  }
                } finally { unlockRelease(); }
                await permit?.finish();
              })();
              return releasePromise;
            },
          };
        } catch (err) {
          if (created || err?.code !== 'EEXIST') throw err;
        }

        const holder = await readHolder(claimPath);
        // The same process knows it finished this exact token. Claim this
        // one-shot cleanup synchronously so another local request cannot unlink
        // a successor; other processes still see the live PID and leave it alone.
        if (holder?.pid === process.pid && holder.token && locallyCompletedClaims.get(claimPath) === holder.token) {
          locallyCompletedClaims.delete(claimPath);
          try { await unlinkClaim(claimPath); }
          catch (err) {
            if (err?.code !== 'ENOENT') {
              locallyCompletedClaims.set(claimPath, holder.token);
              scheduleCompletedCleanup(claimPath, holder.token);
              throw err;
            }
          }
          continue;
        }
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
        unlock();
        await wait(Math.min(250, Math.max(1, deadline - now())));
      } finally { unlock(); }
    }
  } finally { if (!retained) await permit?.finish(); }
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
      const unlock = await lockMutation(claimPath);
      try {
        const current = await readHolder(claimPath);
        if (current?.token === holder.token) await unlink(claimPath).catch((err) => {
          if (err?.code !== 'ENOENT') throw err;
        });
      } finally { unlock(); }
    },
  };
}
