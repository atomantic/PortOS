#!/usr/bin/env node
/**
 * Dry-run, or stopped-server, wrapper around the Antigravity usage repair.
 *
 * While PortOS is running, use Reconcile now on the Usage page. That path
 * writes the server's in-memory ledger, so the next save cannot drop the rows.
 * This script prints the same plan and, with --apply, calls that same repair
 * only when this process is the one that owns data/usage.json. Stop PortOS
 * first. A running server keeps the ledger in memory and will overwrite a
 * file this process saved.
 *
 *   node scripts/backfill-antigravity-usage.js
 *   node scripts/backfill-antigravity-usage.js --home /path/to/home --data /path/to/data
 *   node scripts/backfill-antigravity-usage.js --apply
 */

import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { PATHS } from '../server/lib/fileUtils.js';
import { applyAgyUsageRepair, planAgyUsageRepairFromDisk } from '../server/services/agyUsageBackfill.js';
import { summarizeAgyRepairAdditions } from '../server/services/agyUsageRepair.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function printPlan(plan) {
  const counts = summarizeAgyRepairAdditions(plan.additions);
  console.log(`Antigravity usage repair: ${counts.added} addition(s).`);
  for (const item of plan.additions) {
    console.log(`  ${item.day}  ${item.repairId}  model=${item.record.model || '(default)'}  images=${item.record.images || 0}`);
  }
  console.log(`Summary: ${counts.images} image row(s).`);
  for (const note of plan.notes) console.log(`Note: ${note}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const home = argValue(argv, '--home') || homedir();
  const dataDir = argValue(argv, '--data') || join(ROOT, 'data');
  if (!apply) {
    printPlan(await planAgyUsageRepairFromDisk({ home, dataDir }));
    console.log('Dry run. Reconcile now on the Usage page applies this while PortOS is running. --apply writes the ledger only after PortOS is stopped.');
    return;
  }
  if (resolve(dataDir) !== resolve(PATHS.data)) {
    console.error(`❌ --apply writes ${PATHS.data}/usage.json. Re-run without --data, or pass --data ${PATHS.data}.`);
    process.exitCode = 1;
    return;
  }
  const result = await applyAgyUsageRepair({ home, dataDir });
  console.log(`Applied ${result.added} addition(s): ${result.images} image row(s).`);
  if (result.note) console.log(`Note: ${result.note}`);
  if (result.backedUp) console.log(`Backed up the ledger to ${result.backupDir}`);
  if (result.added === 0) console.log('Nothing to apply.');
}

main().catch((err) => {
  console.error(`❌ Antigravity usage backfill failed: ${err.message}`);
  process.exitCode = 1;
});
