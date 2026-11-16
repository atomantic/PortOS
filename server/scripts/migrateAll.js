#!/usr/bin/env node
// One-shot migration runner: chains every data-shape upgrade in order, idempotent end to end.
//   node server/scripts/migrateAll.js [--dry-run]
// Order matters: (1) world → universe naming must run first because (2) series canon → universe
// canon reads `series.universeId`, which (1) renames from `worldId`.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(`PortOS data migration ${DRY_RUN ? '(dry-run)' : ''}\n`);

  // Imported for its side effect (runs main()); it reads process.argv, so re-pass --dry-run there.
  console.log('━━ Step 1/2: world → universe naming ━━');
  process.argv = [process.argv[0], join(__dirname, 'migrateWorldToUniverse.js'), ...(DRY_RUN ? ['--dry-run'] : [])];
  await import('./migrateWorldToUniverse.js');

  console.log('\n━━ Step 2/2: series canon → universe canon ━━');
  const { migrateSeriesCanon } = await import('../services/pipeline/migrateSeriesCanon.js');
  await migrateSeriesCanon({ dryRun: DRY_RUN });

  console.log(`\n✨ All migrations complete${DRY_RUN ? ' (dry-run — re-run without --dry-run to apply)' : ''}.`);
}

main().catch((err) => { console.error('❌ Migration failed:', err); process.exit(1); });
