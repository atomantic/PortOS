#!/usr/bin/env node
// One-shot migration runner — chains every data-shape upgrade in the
// correct order so a stale-data machine can be brought current with one
// command:
//
//   node server/scripts/migrateAll.js [--dry-run]
//
// Order matters:
//   1. world → universe naming (files, top-level keys, field renames).
//      Must run first because (2) reads `series.universeId`, which only
//      exists after (1) renames it from `worldId`.
//   2. series canon → universe canon (copy series.{characters,settings,
//      objects} into the linked universe via mergeExtractedBible).
//
// Idempotent end-to-end: re-runs no-op once the data is current.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(`PortOS data migration ${DRY_RUN ? '(dry-run)' : ''}\n`);

  // Step 1: world → universe naming. Importing for its side-effect (running
  // main() on import) keeps the wrapper trivial. The script reads
  // process.argv directly, so re-pass --dry-run via env.
  console.log('━━ Step 1/2: world → universe naming ━━');
  process.argv = [process.argv[0], join(__dirname, 'migrateWorldToUniverse.js'), ...(DRY_RUN ? ['--dry-run'] : [])];
  await import('./migrateWorldToUniverse.js');

  // Step 2: series canon → universe canon. Same pattern.
  console.log('\n━━ Step 2/2: series canon → universe canon ━━');
  const { migrateSeriesCanon } = await import('../services/pipeline/migrateSeriesCanon.js');
  await migrateSeriesCanon({ dryRun: DRY_RUN });

  console.log(`\n✨ All migrations complete${DRY_RUN ? ' (dry-run — re-run without --dry-run to apply)' : ''}.`);
}

main().catch((err) => { console.error('❌ Migration failed:', err); process.exit(1); });
