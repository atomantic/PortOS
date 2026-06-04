// Pure command-argument builders and validators for git operations. No
// child-process access — these sanitize/shape the inputs that
// server/services/git.js passes to execGit.

// Branches that must never be deleted by the branch-cleanup paths.
export const PROTECTED_BRANCHES = ['main', 'master', 'dev', 'develop', 'release'];

/**
 * Validate file paths to prevent command injection and path traversal.
 * Throws on null bytes / shell metacharacters, absolute paths, or `..` traversal.
 * Accepts a single path or an array; always returns an array of the sanitized paths.
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
