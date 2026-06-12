// Pure command-argument builders and validators for git operations. No
// child-process access — these sanitize/shape the inputs that
// server/services/git.js passes to execGit.

// Branches that must never be deleted by the branch-cleanup paths.
export const PROTECTED_BRANCHES = ['main', 'master', 'dev', 'develop', 'release'];

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
    if (/[\0;|&`$]/.test(f)) {
      throw new Error(`Invalid character in file path: ${f}`);
    }
    // Reject absolute paths or parent directory traversal
    if (f.startsWith('/') || f.includes('..')) {
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
