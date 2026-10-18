/**
 * Guards the invariant `MIGRATION_OWNED_PATHS` exists to state: none of these
 * paths may ship a `data.reference/` seed.
 *
 * The regression it uniquely catches is #6182's — a seed added beside a
 * migration that derives the same file from the install's existing records
 * silently replaces the user's settings with shipped defaults, because
 * setup-data runs before run-migrations. See
 * `scripts/migrations/340-cos-config-seed-repair.js`.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { MIGRATION_OWNED_PATHS } from './migrationOwnedPaths.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const migrationsDir = join(repoRoot, 'scripts', 'migrations');
// Import declarations only: unrelated historical migrations may have boot-time
// dependencies, and none of their up() functions should run in this guard.
const declaringMigrations = readdirSync(migrationsDir).filter((file) =>
  file.endsWith('.js') && !file.endsWith('.test.js')
  && /\bOWNED_OUTPUT_PATHS\b/.test(readFileSync(join(migrationsDir, file), 'utf8')),
);
const migrationOutputs = await Promise.all(declaringMigrations.map(async (file) => ({
  file,
  paths: (await import(pathToFileURL(join(migrationsDir, file)).href)).OWNED_OUTPUT_PATHS,
})));

describe('migration-owned data paths', () => {
  it('protects every output declared by a deriving migration in the runtime set', () => {
    expect(migrationOutputs.length).toBeGreaterThan(0);
    for (const { file, paths } of migrationOutputs) {
      expect(Array.isArray(paths), `${file}: OWNED_OUTPUT_PATHS must be an array`).toBe(true);
      expect(paths.length, `${file}: declare at least one derived output`).toBeGreaterThan(0);
      for (const path of paths) {
        expect(typeof path, `${file}: output paths must be strings`).toBe('string');
        expect(MIGRATION_OWNED_PATHS.has(path), `${file}: ${path} is missing from MIGRATION_OWNED_PATHS`).toBe(true);
      }
    }
  });

  it('ships no data.reference seed for any migration-owned path', () => {
    const seeded = [...MIGRATION_OWNED_PATHS].filter((relPath) =>
      existsSync(join(repoRoot, 'data.reference', ...relPath.split('/'))),
    );
    expect(seeded).toEqual([]);
  });
});
