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
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { MIGRATION_OWNED_PATHS } from './migrationOwnedPaths.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('migration-owned data paths', () => {
  it('ships no data.reference seed for any migration-owned path', () => {
    const seeded = [...MIGRATION_OWNED_PATHS].filter((relPath) =>
      existsSync(join(repoRoot, 'data.reference', ...relPath.split('/'))),
    );
    expect(seeded).toEqual([]);
  });
});
