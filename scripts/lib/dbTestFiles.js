import { posix } from 'node:path';

// Filename patterns relative to the Vitest root (server/). The DB runner
// includes these suites and the unit runner excludes the same files.
export const DB_TEST_INCLUDE = ['**/*.db.test.js', '**/db.test.js', '../scripts/**/*.db.test.js'];

const patterns = DB_TEST_INCLUDE.map((pattern) => posix.normalize(posix.join('server', pattern)));

/** Match repository-relative paths against the DB runner's include patterns. */
export const resolveDbTestFiles = (files) => files.filter(
  (file) => patterns.some((pattern) => posix.matchesGlob(file, pattern)),
);
