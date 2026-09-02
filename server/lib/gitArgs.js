// Pure command-argument builders and validators for git operations. No
// child-process access — these sanitize/shape the inputs that
// server/services/git.js passes to execGit.

// Long-lived shared branches that must never be deleted by the branch-cleanup
// paths, nor handed to the branch-reconcile coordinator agent — they are not
// disposable work. `gh-pages` is the GitHub Pages publishing branch: deleting it
// (or letting reconcile try to "open a PR" merging it into the default branch)
// would break the published site, so it is protected everywhere the others are.
export const PROTECTED_BRANCHES = ['main', 'master', 'dev', 'develop', 'release', 'gh-pages'];

// Null bytes and shell command separators. Shared by the predicate and the
// thrower below so the two can never disagree about what is unsafe.
const GIT_UNSAFE_CHARS = /[\0;|&`$]/;

/**
 * `validateFilePaths`'s non-throwing twin: true when `file` is a repo-relative
 * path git can be asked to stage. For callers that must REPORT an unstageable
 * path as data rather than throw — e.g. a route that would otherwise write the
 * file to disk and only then discover the commit can't reference it, leaving a
 * mutated tree behind a 500. `validateFilePaths` is layered on this, so the
 * gate and the predicate always admit the same set.
 *
 * Note `..` is rejected as a SUBSTRING, not just as a path component, which is
 * stricter than `pathSafety.isTopLevelEntryName` — `notes..md` is a perfectly
 * good filename that git staging still refuses here.
 *
 * @param {string} file - Repo-relative file path
 * @returns {boolean}
 */
export function isGitStageableFilePath(file) {
  if (!file || typeof file !== 'string') return false;
  if (GIT_UNSAFE_CHARS.test(file)) return false;
  return !file.startsWith('/') && !file.includes('..');
}

/**
 * Validate file paths to prevent command injection and path traversal.
 * Throws on null bytes / shell metacharacters, absolute paths, or `..` traversal.
 * Accepts a single path or an array; always returns an array of the sanitized paths.
 *
 * Glob characters (* ? [) are deliberately NOT rejected — legitimate filenames
 * contain them (Next.js/SvelteKit `[id].jsx` dynamic routes). Wildcard
 * expansion is neutralized at the call site instead: services/git.js prefixes
 * each path with `toLiteralPathspec` so git never glob-expands them.
 *
 * @param {string|string[]} files - File path(s)
 * @returns {string[]} - Sanitized file paths
 */
export function validateFilePaths(files) {
  const fileList = Array.isArray(files) ? files : [files];
  return fileList.map(f => {
    // Reject paths with null bytes or command separators
    if (GIT_UNSAFE_CHARS.test(f)) {
      throw new Error(`Invalid character in file path: ${f}`);
    }
    // Reject absolute paths or parent directory traversal
    if (!isGitStageableFilePath(f)) {
      throw new Error(`Invalid file path: ${f}`);
    }
    return f;
  });
}

/**
 * Wrap a validated repo-relative path in git's `:(literal)` pathspec magic so
 * pathspec wildcards (`*`, `?`, `[...]`) are treated as literal filename
 * characters instead of glob patterns. Without this, staging `app/[id].jsx`
 * either errors ("did not match any files") or silently matches the WRONG
 * file (`app/i.jsx`), and a crafted `*` pathspec would stage everything.
 * @param {string} path - Repo-relative file path (already validated)
 * @returns {string} - Pathspec with literal magic applied
 */
export function toLiteralPathspec(path) {
  return `:(literal)${path}`;
}
