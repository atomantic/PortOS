// Pure command-argument builders and validators for git operations (no child-process access) that
// server/services/git.js passes to execGit.
//
// `isGitStageableFilePath` is `validateFilePaths`' non-throwing twin, for callers that must refuse an unstageable
// path BEFORE writing the file.

import { ServerError } from './errorHandler.js';

// Long-lived shared branches never deleted by branch-cleanup nor handed to the branch-reconcile
// coordinator. `gh-pages` is included: deleting it or "opening a PR" merging it would break the site.
export const PROTECTED_BRANCHES = ['main', 'master', 'dev', 'develop', 'release', 'gh-pages'];

// Null bytes and shell command separators; shared so the predicate and thrower can't disagree.
const GIT_UNSAFE_CHARS = /[\0;|&`$]/;

/**
 * `validateFilePaths`'s non-throwing twin: true when `file` is a repo-relative path git can stage. For
 * callers that must REPORT an unstageable path rather than write the file and then 500 on the commit.
 * `..` is rejected as a SUBSTRING (stricter than `pathSafety.isTopLevelEntryName`), so `notes..md` is refused.
 *
 * @param {string} file - Repo-relative file path
 */
export function isGitStageableFilePath(file) {
  if (!file || typeof file !== 'string') return false;
  if (GIT_UNSAFE_CHARS.test(file)) return false;
  return !file.startsWith('/') && !file.includes('..');
}

/**
 * Validate file paths against command injection and traversal (null bytes / shell metacharacters,
 * absolute paths, `..`); accepts one path or an array, returns an array.
 *
 * Glob characters (* ? [) are deliberately NOT rejected (`[id].jsx` routes are legitimate); the call
 * site neutralizes them by prefixing `toLiteralPathspec`.
 *
 * @param {string|string[]} files - File path(s)
 * @returns {string[]} - Sanitized file paths
 */
export function validateFilePaths(files) {
  const fileList = Array.isArray(files) ? files : [files];
  return fileList.map(f => {
    if (GIT_UNSAFE_CHARS.test(f)) {
      throw new ServerError(`Invalid character in file path: ${f}`, { status: 400, code: 'VALIDATION_ERROR' });
    }
    if (!isGitStageableFilePath(f)) {
      throw new ServerError(`Invalid file path: ${f}`, { status: 400, code: 'VALIDATION_ERROR' });
    }
    return f;
  });
}

/**
 * Wrap a validated path in git's `:(literal)` pathspec magic so wildcards are literal: otherwise
 * staging `app/[id].jsx` errors or matches the WRONG file, and a crafted `*` would stage everything.
 *
 * @param {string} path - Repo-relative file path (already validated)
 * @returns {string} - Pathspec with literal magic applied
 */
export function toLiteralPathspec(path) {
  return `:(literal)${path}`;
}

/**
 * True when `ref` is safe as a bare branch/ref argument: not option-shaped (leading "-"), no
 * whitespace/control characters, none of the sequences git-check-ref-format forbids.
 *
 * @param {unknown} ref
 */
export function isSafeGitRef(ref) {
  if (typeof ref !== 'string' || ref.length < 1 || ref.length > 255) return false;
  if (ref.startsWith('-') || ref.startsWith('/')) return false;
  if (/[\s\x00-\x1f\x7f~^:?*[\\]/.test(ref)) return false;
  if (ref.includes('..') || ref.includes('@{')) return false;
  return !(ref.endsWith('/') || ref.endsWith('.lock') || ref.endsWith('.'));
}

/**
 * Defense in depth for callers that bypass HTTP (CoS services import git.js directly): 400 on an unsafe ref.
 *
 * @param {unknown} ref
 * @returns {string} the ref, unchanged
 */
export function assertSafeRef(ref) {
  if (!isSafeGitRef(ref)) {
    throw new ServerError('Invalid git ref name', { status: 400, code: 'VALIDATION_ERROR' });
  }
  return ref;
}
