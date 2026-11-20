/**
 * Inventory guard for the DB-backed suites: every test that gates on
 * checkHealth()+dbReady must be in the db-config include set, and every explicit
 * include must exist. Split from db.guards.test.js, which covers db.js's own
 * test-runner write guards.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { DB_TEST_INCLUDE } from '../../../vitest.config.db.js';
import { REPO_ROOT } from '../../../../scripts/lib/guardCorpus.js';

// Drift guard: a DB-backed suite skips on a non-test DB (correct), so if a new
// one is left out of vitest.config.db.js it would simply NEVER run — silently
// losing coverage with a green board. This asserts every real DB-backed suite
// (identified by the checkHealth + dbReady gating pattern those suites share) is
// matched by the db-config include set. Suites that MOCK checkHealth (no dbReady
// gate, e.g. memoryBackend.test.js) are not DB-backed and are correctly excluded.
describe('DB-backed test files are covered by vitest.config.db.js', () => {
  it('every checkHealth+dbReady suite is in the db-config include set', () => {
    const SERVER = join(REPO_ROOT, 'server'); // vitest root for the db config
    const REPO_SCRIPTS = join(SERVER, '..', 'scripts');

    const hasDbGlob = DB_TEST_INCLUDE.includes('**/db.test.js');
    // Match normalized paths so two suites with the same basename in different
    // directories remain independently covered by the explicit include list.
    const explicitIncludes = new Set(
      DB_TEST_INCLUDE.filter((p) => p !== '**/db.test.js').map((p) => p.split('/').join(sep)),
    );

    // The checkHealth + dbReady gating always sits in a suite's first ~40 lines,
    // so read only the file header instead of slurping every test file whole.
    // 8 KB leaves generous margin past the gating block (routes/catalog.test.js
    // already reaches ~1.8 KB) without slurping large suites whole.
    const readHead = (path, bytes = 8192) => {
      const fd = openSync(path, 'r');
      try {
        const buf = Buffer.alloc(bytes);
        return buf.toString('utf8', 0, readSync(fd, buf, 0, bytes, 0));
      } finally {
        closeSync(fd);
      }
    };

    const SKIP_DIRS = new Set(['node_modules', 'slashdo', 'coverage', '.git']);
    // Prune the skipped directories DURING the walk, not after it. A
    // `readdirSync(root, { recursive: true })` enumerates every entry under
    // `server/node_modules` — hundreds of thousands of files — before the
    // filter ever runs, which pushed this single test past a minute on Windows
    // and timed the suite out under full-suite load.
    const collect = (root, rel = '') => {
      let entries;
      try {
        entries = readdirSync(join(root, rel), { withFileTypes: true });
      } catch {
        return [];
      }
      return entries.flatMap((entry) => {
        const next = rel ? join(rel, entry.name) : entry.name;
        if (entry.isDirectory()) {
          return SKIP_DIRS.has(entry.name) ? [] : collect(root, next);
        }
        return entry.name.endsWith('.test.js') ? [next] : [];
      });
    };

    const offenders = [];
    for (const [root, prefix] of [[SERVER, ''], [REPO_SCRIPTS, '../scripts/']]) {
      for (const rel of collect(root)) {
        const base = rel.split(sep).pop();
        // This check itself references checkHealth/dbReady (the detector
        // regex), and so does the db.js guard suite it was split from (imports);
        // neither is a DB-backed suite — exclude both.
        if ((prefix === '' && rel === join('test', 'guards', 'repo', 'db.inventory.test.js')) || base === 'db.guards.test.js') continue;
        const head = readHead(join(root, rel));
        // A real DB-backed suite gates on checkHealth() and either exposes dbReady or
        // gates through requireDbOrSkip (the cos_tasks suites slipped past a
        // dbReady-only detector and never ran).
        if (!(/\bcheckHealth\b/.test(head) && /\b(dbReady|requireDbOrSkip)\b/.test(head))) continue;
        const relativePath = join(prefix, rel);
        const covered = (hasDbGlob && base === 'db.test.js') || explicitIncludes.has(relativePath);
        if (!covered) offenders.push(prefix + rel.split(sep).join('/'));
      }
    }

    expect(
      offenders,
      `These DB-backed suites use checkHealth()+dbReady but are missing from ` +
        `server/vitest.config.db.js include — they would never run against portos_test:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every explicit DB_TEST_INCLUDE entry resolves to a real file', () => {
    // Path matching above proves a detected suite is covered, but it does not
    // prove every explicit include path resolves to a file; a stale entry for a
    // renamed or deleted suite would otherwise be invisible. Resolve each
    // non-glob entry against the config root (server/) and assert it exists.
    const SERVER = join(REPO_ROOT, 'server');
    const broken = DB_TEST_INCLUDE
      .filter((p) => !p.includes('*'))
      .filter((p) => !existsSync(join(SERVER, p)));
    expect(
      broken,
      `These vitest.config.db.js include paths resolve to no file (relative to server/):\n  ${broken.join('\n  ')}`,
    ).toEqual([]);
  });
});
