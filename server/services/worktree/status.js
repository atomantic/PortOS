/** Read and classify worktree status and Git registrations. */

import { lstat } from 'fs/promises';
import { AGENT_SCRATCH_PATHS, matchesScratchRoot } from '../../lib/agent/agentScratchPaths.js';
import { execGit } from '../../lib/execGit.js';
import { pathsEqual } from './paths.js';

// Lockfiles that npm/yarn/pnpm modify as a side-effect — safe to discard during worktree cleanup
const AUTO_GENERATED_LOCKFILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];

/**
 * Classify a `git status --porcelain` blob into real changes vs auto-generated
 * lockfile churn. Pure (testable) — callers decide what to do with the result.
 *
 * PortOS's own runtime scratch (`AGENT_SCRATCH_PATHS` — the public-review input
 * bundle and its patch directory) is subtracted for EVERY caller, not passed in
 * per call. It is written by PortOS into the worktree and never committed, so a
 * tree holding only that is finished work by every consumer's definition; making
 * each one learn the names is how two `pr-reviewer` worktrees survived
 * `removeWorktree`, `reapMergedWorktrees` and branch-reconcile in turn.
 *
 * @param {string} porcelain - raw `git status --porcelain` stdout
 * @param {object} [options]
 * @param {string[]} [options.ignoredPaths] - ADDITIONAL runtime-only paths that
 *   must not preserve a completed worktree — for names this module cannot know
 *   statically, notably one run's own `.agent-done-<agentId>` sentinel. Matched
 *   as roots: a directory entry also covers everything under it. They are still
 *   removed only when the rest of the tree is safe to remove.
 * @param {{ ignoredPaths?: string[], preserveLockfiles?: boolean }} [opts] - `preserveLockfiles` classifies lockfiles as real changes
 * @returns {{ clean: boolean, lockfileOnly: boolean, lockfilePaths: string[], untrackedLockfilePaths: string[], realChangePaths: string[], hasRealChanges: boolean }}
 *   - clean: no changes at all
 *   - lockfileOnly: every change is an auto-generated lockfile (safe to discard)
 *   - lockfilePaths: paths of those lockfiles (strip the porcelain `XY ` status prefix)
 *   - untrackedLockfilePaths: the subset of lockfilePaths that is untracked (`??`)
 *   - realChangePaths: paths of the NON-lockfile changes, same prefix stripping.
 *     Branch reconciliation intersects these with what the default branch has
 *     touched since the branch diverged, to spot work that may have been
 *     superseded while it sat uncommitted.
 *   - hasRealChanges: at least one non-lockfile change (worktree must be preserved)
 */
export function classifyWorktreeDirt(porcelain, { ignoredPaths = [], preserveLockfiles = false } = {}) {
  const ignored = [...AGENT_SCRATCH_PATHS, ...ignoredPaths];
  // Git's porcelain v1 output C-quotes paths with spaces and several other
  // characters. Decode those paths before comparing them with scratch roots or
  // lockfile names. Octal escapes represent bytes, so collect them as bytes and
  // decode UTF-8 only after the whole quoted path has been read.
  const unquoteGitPath = (path) => {
    if (!path.startsWith('"') || !path.endsWith('"')) return path;
    const bytes = [];
    for (let i = 1; i < path.length - 1; i += 1) {
      const char = path[i];
      if (char !== '\\') {
        const codePoint = String.fromCodePoint(path.codePointAt(i));
        bytes.push(...Buffer.from(codePoint));
        i += codePoint.length - 1;
        continue;
      }
      const escaped = path[++i];
      if (/[0-7]/.test(escaped || '')) {
        const octal = path.slice(i, i + 3);
        if (!/^[0-7]{3}$/.test(octal)) {
          bytes.push(...Buffer.from(`\\${escaped}`));
          continue;
        }
        bytes.push(parseInt(octal, 8));
        i += 2;
        continue;
      }
      const controls = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
      if (Object.hasOwn(controls, escaped)) bytes.push(controls[escaped]);
      else bytes.push(...Buffer.from(escaped || ''));
    }
    return Buffer.from(bytes).toString('utf8');
  };
  const splitRename = (path) => {
    let quoted = false;
    let escaped = false;
    for (let i = 0; i <= path.length - 4; i += 1) {
      const char = path[i];
      if (escaped) { escaped = false; continue; }
      if (quoted && char === '\\') { escaped = true; continue; }
      if (char === '"') { quoted = !quoted; continue; }
      if (!quoted && path.startsWith(' -> ', i)) return [path.slice(0, i), path.slice(i + 4)];
    }
    return [path];
  };
  const toPath = (line) => {
    const statusless = line.replace(/^\s*\S+\s+/, '');
    return splitRename(statusless).map(unquoteGitPath).at(-1);
  };
  const lines = (porcelain || '').split('\n')
    .filter(l => l.trim())
    .filter(line => !matchesScratchRoot(toPath(line), ignored));
  if (lines.length === 0) {
    return { clean: true, lockfileOnly: false, lockfilePaths: [], untrackedLockfilePaths: [], realChangePaths: [], hasRealChanges: false };
  }
  // `dependency-updates` can legitimately deliver a lockfile-only diff (`npm audit
  // fix`, a transitive bump), so there a lockfile is work, never churn.
  const isLockfile = (line) => !preserveLockfiles && AUTO_GENERATED_LOCKFILES.some(f => toPath(line).endsWith(f));
  // `R old -> new` (rename) names two paths; the post-rename path is the one
  // that exists on disk and the one a diff against the default branch reports.
  const lockfileLines = lines.filter(isLockfile);
  const lockfileOnly = lockfileLines.length === lines.length;
  return {
    clean: false,
    lockfileOnly,
    lockfilePaths: lockfileLines.map(toPath),
    // Untracked (`??`) lockfiles have no index entry, so `git checkout --` cannot
    // restore them; discardLockfileChanges deletes these instead.
    untrackedLockfilePaths: lockfileLines.filter(line => line.startsWith('??')).map(toPath),
    realChangePaths: lines.filter((line) => !isLockfile(line)).map(toPath),
    hasRealChanges: !lockfileOnly
  };
}

/** Whether a checkout directory exists: false only when proven absent, null when unreadable. */
export async function readCheckoutPresence(worktreePath) {
  return lstat(worktreePath).then(() => true, err => (err.code === 'ENOENT' || err.code === 'ENOTDIR' ? false : null));
}

/** A proven-absent directory is empty; an existing tree must identify itself.
 * Git can otherwise walk out of a broken linked checkout and report its parent
 * clean. null means unknown, including unreadable directories or status errors.
 */
export async function readWorktreeStatus(worktreePath) {
  const present = await readCheckoutPresence(worktreePath);
  if (present === false) return '';
  if (present === null) return null;
  const top = await execGit(['rev-parse', '--show-toplevel'], worktreePath).then(r => r.stdout.trim()).catch(() => null);
  if (!top || !pathsEqual(top, worktreePath)) return null;
  const status = await execGit(['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'], worktreePath,
    { ignoreExitCode: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).catch(() => null);
  return status?.exitCode === 0 ? status.stdout : null;
}

/**
 * List all active worktrees for the repository.
 *
 * Split on CRLF as well as LF. On Windows git's porcelain output is CRLF, and a
 * bare `split('\n')` leaves a trailing \r on every value: `path` and `branch`
 * silently carry it, so containment checks and path equality match nothing, and
 * the flag lines never compare equal (`'bare\r' !== 'bare'`) so `bare`,
 * `detached`, `locked` and `prunable` all read as false. That is what made the
 * reaper report a managed worktree as `worktree-unmanaged-location` on Windows
 * and skip it forever, while every Linux run stayed green.
 */
export async function listWorktrees(sourceWorkspace) {
  const { stdout } = await execGit(['worktree', 'list', '--porcelain'], sourceWorkspace);
  const worktrees = [];
  let current = {};

  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current.path) worktrees.push(current);
      current = { path: line.slice(9) };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice(5);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7);
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === 'detached') {
      current.detached = true;
    } else if (line === 'locked' || line.startsWith('locked ')) {
      // `git worktree list --porcelain` emits a bare `locked` line, or `locked <reason>`.
      current.locked = true;
      current.lockReason = line.startsWith('locked ') ? line.slice(7) : null;
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      // Same two spellings. Set when git considers the registration disposable —
      // its directory is gone, or its .git pointer no longer resolves.
      current.prunable = true;
    }
  }
  if (current.path) worktrees.push(current);

  return worktrees;
}
