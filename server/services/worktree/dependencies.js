/** Dependency links and workspace node_modules for managed worktrees. */

import { existsSync } from 'fs';
import { lstat, readlink, readdir, rm, stat, symlink, unlink } from 'fs/promises';
import { dirname, isAbsolute, join, resolve } from 'path';
import { inspectClaimDependencyLock } from '../claimDependencyLock.js';
import { provisionWorkspaceNodeModules, removeProvisionedNodeModules } from '../../lib/worktreeNodeModules.js';
import { pathsEqual } from './paths.js';

const CACHE_ENTRIES = new Set(['.vite', '.vitest-cache', '.cache']);

// Dependencies are linked from the source checkout for ordinary ephemeral
// worktrees. Dependency-update tasks opt out so package managers cannot mutate
// the source checkout's installed tree through these links.
async function worktreeDependencyPaths(sourceWorkspace, worktreePath, { cleanup = false } = {}) {
  const entries = await readdir(worktreePath, { withFileTypes: true });
  const children = await Promise.all(entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .map(async ({ name }) => {
      // Cleanup must still find owned links after a package or its source is removed.
      if (cleanup) return join(name, 'node_modules');
      const sourceDirectory = await lstat(join(sourceWorkspace, name)).catch(() => null);
      if (!sourceDirectory?.isDirectory()) return null;
      if (existsSync(join(sourceWorkspace, name, '.git')) || existsSync(join(worktreePath, name, '.git'))) return null;
      const manifest = await lstat(join(worktreePath, name, 'package.json')).catch(() => null);
      if (!manifest?.isFile()) return null;
      return join(name, 'node_modules');
    }));
  return ['node_modules', ...children.filter(Boolean)];
}

const hasInstalledDependencies = path => stat(path).then(info => info.isDirectory()).catch(() => false);

/**
 * Make installed dependencies available to a fresh worktree without copying
 * or reinstalling them. Missing source directories are skipped so this also
 * works for managed repositories that do not use PortOS's client/server
 * layout. Existing paths are preserved, including real directories and links.
 * A root node_modules holding workspace links is rebuilt as a real directory
 * so those links resolve inside the worktree, not the source (#12633).
 */
export async function linkWorktreeDependencies(sourceWorkspace, worktreePath, { verifyRootLockfile = false } = {}) {
  const dependencyPaths = await worktreeDependencyPaths(sourceWorkspace, worktreePath);
  const lock = verifyRootLockfile ? await inspectClaimDependencyLock(sourceWorkspace, worktreePath) : null;
  // A missing or unverifiable root install can require a workspace-wide
  // reinstall. Leave child paths unlinked so it cannot write through them.
  if (lock && lock.status !== 'matching') {
    const installedChildren = await Promise.all(dependencyPaths.slice(1).map(path => hasInstalledDependencies(join(sourceWorkspace, path))));
    return [{ path: 'node_modules', ...lock, hasInstalledChildren: installedChildren.some(Boolean) }];
  }

  const outcomes = await Promise.all(dependencyPaths.map(async (relativePath) => {
    const sourcePath = join(sourceWorkspace, relativePath);
    const targetPath = join(worktreePath, relativePath);
    const sourceExists = await hasInstalledDependencies(sourcePath);
    const targetStat = await lstat(targetPath).catch(() => null);
    if (!sourceExists) return { path: relativePath, status: targetStat ? 'existing' : 'absent' };
    if (targetStat) {
      const isSymlink = targetStat.isSymbolicLink?.() ?? false;
      const isDir = targetStat.isDirectory?.() ?? !isSymlink;
      if (!isSymlink && isDir) {
        const entries = await readdir(targetPath).catch(() => null);
        if (entries !== null && entries.length > 0 && entries.every(name => CACHE_ENTRIES.has(name))) {
          await rm(targetPath, { recursive: true, force: true });
        } else {
          console.warn(`⚠️ linkWorktreeDependencies: skipping existing ${targetPath} (not a cache-only directory)`);
          return { path: relativePath, status: 'existing' };
        }
      } else {
        return { path: relativePath, status: 'existing' };
      }
    }
    const root = relativePath === 'node_modules';
    const provisioned = root && await provisionWorkspaceNodeModules(sourceWorkspace, worktreePath);
    if (!provisioned) await symlink(sourcePath, targetPath, 'dir');
    return { path: relativePath, status: root && lock ? 'linked-match' : 'linked' };
  }));
  return outcomes;
}

/**
 * Remove only dependency symlinks that point back into the source checkout,
 * plus a root node_modules this module provisioned as a link farm. Real
 * dependency directories and links managed by another tool stay intact.
 */
export async function unlinkWorktreeDependencies(sourceWorkspace, worktreePath) {
  const dependencyPaths = await worktreeDependencyPaths(sourceWorkspace, worktreePath, { cleanup: true });
  await Promise.all(dependencyPaths.map(async (relativePath) => {
    const sourcePath = join(sourceWorkspace, relativePath);
    const targetPath = join(worktreePath, relativePath);
    const targetStat = await lstat(targetPath).catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (!targetStat) return;
    if (!targetStat.isSymbolicLink()) {
      if (relativePath === 'node_modules') await removeProvisionedNodeModules(sourceWorkspace, worktreePath);
      return;
    }

    const linkTarget = await readlink(targetPath);
    const linkedPath = isAbsolute(linkTarget) ? linkTarget : resolve(dirname(targetPath), linkTarget);
    if (pathsEqual(linkedPath, sourcePath)) await unlink(targetPath);
  }));
}
