import { posix } from 'node:path';

// Filename patterns relative to the Vitest root (server/). The DB runner
// includes these suites and the unit runner excludes the same files.
export const DB_TEST_INCLUDE = ['**/*.db.test.js', '**/db.test.js', '../scripts/**/*.db.test.js'];

const patterns = DB_TEST_INCLUDE.map((pattern) => posix.normalize(posix.join('server', pattern)));

/** Resolve the canonical, server-rooted include patterns without loading Vitest. */
export const resolveDbTestFiles = (files) => files.filter((file) => {
  const serverPath = file.startsWith('server/') ? file : posix.normalize(posix.join('server', file));
  return patterns.some((pattern) => posix.matchesGlob(file, pattern) || posix.matchesGlob(serverPath, pattern));
});
