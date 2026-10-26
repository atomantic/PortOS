/** Durable repository admission shared by checkout writers and explicit quarantine. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat, mkdtemp, open, readFile, rename } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { type as hostOsType } from 'node:os';
import { realpathSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { createBackupSharedAdmission } from './backupSharedAdmission.js';
import { execGit, withGitMutationLifetime } from './execGit.js';

const context = new AsyncLocalStorage();

// Filesystem capabilities follow the actual host, not an emulated platform.
async function syncDirectory(path) {
  if (hostOsType() === 'Windows_NT') return;
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
const refused = () => Object.assign(new Error('checkout-retirement-reserved'), {
  code: 'CHECKOUT_RETIREMENT_RESERVED',
});

export async function _checkoutAdmission(repoPath) {
  // A new admission may originate in an expired async context. This read-only
  // bootstrap needs its own command lifetime before checking the current cut;
  // it never revives the old publication's authority.
  const common = (await withGitMutationLifetime(() => execGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], repoPath))).stdout.trim();
  if (!isAbsolute(common)) throw refused();
  const directory = join(realpathSync(common), 'portos-checkout-admission');
  for (const path of [directory, join(directory, 'publications'), join(directory, 'cut')]) {
    const info = await lstat(path).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info && (!info.isDirectory() || info.isSymbolicLink()
      || (hostOsType() !== 'Windows_NT' && (info.mode & 0o777) !== 0o700))) throw refused();
  }
  return { directory, admission: createBackupSharedAdmission(directory) };
}

/** Register before testing the cut; nested operations retain their parent's lease. */
export async function withCheckoutPublication(repoPath, work) {
  const { directory, admission } = await _checkoutAdmission(repoPath);
  const parent = context.getStore();
  const joined = parent?.directory === directory
    ? parent.lease?.active ? parent.lease : parent.cutLifetime?.active
      ? { get active() { return parent.cutLifetime.active; }, path: join(directory, 'cut') } : null
    : null;
  // Every child gets a durable permit: detached fan-out can outlive its parent.
  const lease = admission.tryPublication({ parent: joined });
  if (!lease) throw refused();
  let uncertain = false;
  const retain = () => {
    if (uncertain) return;
    uncertain = true;
    lease.markUncertain();
  };
  try { return await withGitMutationLifetime(() => context.run({ directory, lease }, work), retain); }
  finally { if (!uncertain) lease.release(); }
}

/** Cut creation precedes the reader check. A busy repository is retained, not drained. */
export async function reserveCheckoutRetirement(repoPath, transactionId) {
  const { directory } = await _checkoutAdmission(repoPath);
  const admission = createBackupSharedAdmission(directory, { makeId: () => transactionId });
  const lease = admission.reserveCut();
  if (admission.publications().length) {
    lease.release();
    throw refused();
  }
  return { directory, owner: lease.owner };
}

/** Recover only the reservation already bound to this journal, never a PID/age guess. */
export async function readCheckoutReservation(repoPath, transactionId) {
  const { directory } = await _checkoutAdmission(repoPath);
  const owner = JSON.parse(await readFile(join(directory, 'cut', 'owner.json'), 'utf8'));
  if (owner.id !== transactionId || owner.generation !== transactionId || owner.kind !== 'snapshot') throw refused();
  return { directory, owner };
}

async function verifyCheckoutReservation(reservation) {
  const cut = join(reservation.directory, 'cut');
  const info = await lstat(cut);
  if (!info.isDirectory() || info.isSymbolicLink()) throw refused();
  const owner = JSON.parse(await readFile(join(cut, 'owner.json'), 'utf8'));
  if (JSON.stringify(owner) !== JSON.stringify(reservation.owner)) throw refused();
  const uncertain = await lstat(join(cut, 'uncertain')).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (uncertain) throw refused();
}

/** Only the transaction executor holding its native mutex may enter or release a cut. */
export async function withCheckoutReservation(reservation, work) {
  await verifyCheckoutReservation(reservation);
  if (createBackupSharedAdmission(reservation.directory).publications().length) throw refused();
  const cutLifetime = { active: true };
  try { return await withGitMutationLifetime(() => context.run({ directory: reservation.directory, reservation, cutLifetime }, work),
    () => {
      if (cutLifetime.uncertain) return;
      cutLifetime.uncertain = true;
      const fd = openSync(join(reservation.directory, 'cut', 'uncertain'), 'wx', 0o600);
      try { writeFileSync(fd, 'Git or helper termination is uncertain; retain reservation.\n'); fsyncSync(fd); }
      finally { closeSync(fd); }
      if (hostOsType() !== 'Windows_NT') {
        const parent = openSync(join(reservation.directory, 'cut'), 'r');
        try { fsyncSync(parent); } finally { closeSync(parent); }
      }
    }); }
  finally { cutLifetime.active = false; }
}

export async function releaseCheckoutReservation(reservation) {
  const lifetime = context.getStore()?.cutLifetime;
  if (lifetime) lifetime.active = false;
  await verifyCheckoutReservation(reservation);
  if (createBackupSharedAdmission(reservation.directory).publications().length) throw refused();
  const cut = join(reservation.directory, 'cut');
  if (context.getStore()?.cutLifetime?.uncertain) throw refused();
  const uncertain = await lstat(join(cut, 'uncertain')).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (uncertain) throw refused();
  // Keep the owner intact across the release crash boundary. Atomic rename
  // either leaves the complete live cut or a complete private release record;
  // it never strands an ownerless cut which another transaction might claim.
  const released = await mkdtemp(join(reservation.directory, 'released-'));
  await syncDirectory(reservation.directory);
  await rename(cut, join(released, 'cut'));
  await syncDirectory(released);
  await syncDirectory(reservation.directory);
}
