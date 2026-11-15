/**
 * A shipped migration's filename is its applied-list identity (#16094).
 *
 * The number prefix is only an ordering hint: `run-migrations` keys the ledger
 * on the filename and sorts lexically, so two migrations sharing a prefix run
 * fine and renumbering a collision is churn. Renaming or deleting a migration
 * that an install may already have applied is the real hazard — the renamed
 * file reads as "never applied" and re-runs on every install, and a deleted
 * one silently drops its transform for installs that have not run it yet.
 *
 * So this guard is base-relative: every migration filename present on the
 * merge base must still exist in the tree. Retirements are an explicit,
 * reviewed exception list, never a pattern match.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const MIGRATIONS_DIR = 'scripts/migrations';

// Migrations deliberately retired from the tree. Add an entry only with the
// retirement rationale in the same change; never add one to silence a rename.
export const RETIRED_MIGRATIONS = new Set([]);

// Same selection as `scanMigrationFiles` in scripts/lib/migrationFiles.js.
export const isShippedMigrationName = (name) => /^\d+-.*\.js$/.test(name) && !name.endsWith('.test.js');

/** Base-branch migration filenames that no longer exist in `currentNames`. */
export function missingShippedMigrations(baseNames, currentNames, retired = RETIRED_MIGRATIONS) {
  const current = new Set(currentNames);
  return baseNames
    .filter((name) => isShippedMigrationName(name) && !retired.has(name) && !current.has(name))
    .sort();
}

const git = (...args) => execFileSync('git', args, {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

const basenamesIn = (listing) => listing
  .split('\n')
  .filter(Boolean)
  .map((path) => path.slice(path.lastIndexOf('/') + 1));

describe('shipped migration filenames stay stable', () => {
  it('no migration present on the merge base was renamed or deleted', (context) => {
    const explicitBase = process.env.CI_BASE_SHA?.trim();
    let base;
    if (explicitBase) {
      // The planner chose this commit; a bad SHA must fail, not fall back.
      base = git('rev-parse', '--verify', `${explicitBase}^{commit}`);
    } else {
      try {
        base = git('merge-base', 'origin/main', 'HEAD');
      } catch {
        context.skip('No merge base available; fetch origin/main to check shipped migration filenames.');
        return;
      }
    }
    const baseNames = basenamesIn(git('ls-tree', '--name-only', base, `${MIGRATIONS_DIR}/`));
    const currentNames = readdirSync(join(REPO_ROOT, MIGRATIONS_DIR));
    expect(missingShippedMigrations(baseNames, currentNames),
      `Migrations shipped at ${base} were renamed or deleted; installs that applied them would re-run or lose them. Restore the file, or record a retirement in RETIRED_MIGRATIONS.`,
    ).toEqual([]);
  });

  describe('filename identity matching', () => {
    it('flags a rename that moves the number prefix', () => {
      expect(missingShippedMigrations(['011-backfill.js'], ['500-backfill.js'])).toEqual(['011-backfill.js']);
    });

    it('flags a deletion even when a same-numbered file is added (bypass probe)', () => {
      expect(missingShippedMigrations(['011-backfill.js'], ['011-other.js'])).toEqual(['011-backfill.js']);
    });

    it('allows a new migration that duplicates an existing prefix', () => {
      expect(missingShippedMigrations(['011-backfill.js'], ['011-backfill.js', '011-other.js'])).toEqual([]);
    });

    it('honours an explicit retirement and ignores test siblings', () => {
      expect(missingShippedMigrations(['011-backfill.js', '012-x.test.js'], [], new Set(['011-backfill.js']))).toEqual([]);
      expect(missingShippedMigrations(['012-x.test.js'], [])).toEqual([]);
    });
  });
});
