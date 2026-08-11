/**
 * Repo-wide drift guard for hash-driven prompt-replace migrations.
 *
 * `_testHelpers.js` already asserts "NEW_SHIPPED_MD5 matches the live
 * data.reference body" — but only for migrations that ship their own
 * `*.test.js` and opt into `runPromptMigrationTests`. That leaves the failure
 * mode this file exists to close: a prompt edit re-points the NEWEST migration
 * that targets a file, and every EARLIER migration targeting the same file
 * keeps naming the superseded body as current. Those stale migrations then
 * classify today's shipped body as "customized" and silently skip the upgrade
 * on a fresh install (issue #3817 — migrations 007, 027, 123, 171, 240, 241,
 * 243, 248 and 255 had all drifted this way behind edits shipped by 022, 254,
 * 255, 256 and 257; the last two were found by this sweep, not by the issue).
 *
 * One sweep over every numbered migration catches it in a single place,
 * including migrations that carry no test file of their own.
 */
import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { tryReadFile } from '../../server/lib/fileUtils.js';
import { md5 } from './_lib.js';

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const referenceDir = join(migrationsDir, '..', '..', 'data.reference', 'prompts');

/**
 * Prompts that no longer ship in `data.reference` and so have no live body to
 * drift against. Their migrations stay for installs that still hold the old
 * file. Named explicitly rather than inferred from "the file is missing" —
 * otherwise a typo'd filename, or a `_partials` fragment whose migration forgot
 * to export `DRIFT_SUBDIRS`, would read as "retired" and silently pass.
 */
const RETIRED_PROMPTS = new Set([
  'pipeline-tv-script.md', // renamed to pipeline-teleplay.md
]);

/** Every numbered migration that exports a NEW_SHIPPED_MD5 table. */
const loadShippedTables = async () => {
  const files = (await readdir(migrationsDir))
    .filter((f) => /^\d.*\.js$/.test(f) && !f.endsWith('.test.js'))
    .sort();
  const tables = [];
  for (const file of files) {
    const source = await readFile(join(migrationsDir, file), 'utf-8');
    if (!source.includes('NEW_SHIPPED_MD5')) continue;
    const mod = await import(pathToFileURL(join(migrationsDir, file)).href);
    if (!mod.NEW_SHIPPED_MD5) continue;
    tables.push({ file, current: mod.NEW_SHIPPED_MD5, subdirs: mod.DRIFT_SUBDIRS || {} });
  }
  return tables;
};

describe('shipped prompt-hash drift (all migrations)', () => {
  it('every migration NEW_SHIPPED_MD5 matches the live data.reference body', async () => {
    const tables = await loadShippedTables();
    expect(tables.length).toBeGreaterThan(0);

    const drifted = [];
    for (const { file, current, subdirs } of tables) {
      for (const [name, hash] of Object.entries(current)) {
        const subdir = subdirs[name] || 'stages';
        const body = await tryReadFile(join(referenceDir, subdir, name));
        if (body === null) {
          if (RETIRED_PROMPTS.has(name)) continue;
          drifted.push(
            `${file} → ${name}: no live body at data.reference/prompts/${subdir}/ ` +
              '(wrong DRIFT_SUBDIRS, a typo, or a retirement that belongs in RETIRED_PROMPTS)',
          );
          continue;
        }
        const live = md5(body);
        if (live !== hash) drifted.push(`${file} → ${name}: has ${hash}, live is ${live}`);
      }
    }

    // Reported as a list so one run names EVERY stale migration — the whole
    // point is that a prompt edit typically strands several at once.
    expect(drifted).toEqual([]);
  });
});
