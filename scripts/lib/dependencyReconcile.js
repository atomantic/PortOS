/**
 * Pending-dependency-reconcile marker for the PortOS source checkout (#17511).
 *
 * `ensureLatest` fast-forwards the checkout under agent work without running npm,
 * so a lockfile-changing range leaves `node_modules` behind the locks that every
 * linked claim worktree is then checked against. The fast-forward records this
 * marker; the idle auto-updater treats it as "an update is due" and the update
 * script's install step clears it once it has reconciled the installs. Fs-only
 * so the server, the update script and tests share one definition.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

export const DEPENDENCY_LOCKFILES = ['package-lock.json', 'server/package-lock.json', 'client/package-lock.json'];

export const pendingReconcilePath = dataDir => join(dataDir, 'dependency-reconcile-pending.json');

/** Lockfiles among `changedPaths` (git `--name-only` output, `/`-separated). */
export const changedDependencyLockfiles = changedPaths => changedPaths.filter(path => DEPENDENCY_LOCKFILES.includes(path));

export function markDependencyReconcilePending(dataDir, lockfiles, now = new Date()) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(pendingReconcilePath(dataDir), JSON.stringify({ lockfiles, recordedAt: now.toISOString() }));
}

export const isDependencyReconcilePending = dataDir => existsSync(pendingReconcilePath(dataDir));

export function clearDependencyReconcilePending(dataDir) {
  rmSync(pendingReconcilePath(dataDir), { force: true });
}
