#!/usr/bin/env node
/**
 * Dry-run, or stopped-server, wrapper around the Grok usage repair.
 *
 * While PortOS is running, use Reconcile now on the Usage page. That path
 * writes the server's in-memory ledger, so the next save cannot drop the rows.
 * This script prints the same plan and, with --apply, calls that same repair
 * only when this process is the one that owns data/usage.json. Stop PortOS
 * first. A running server keeps the ledger in memory and will overwrite a
 * file this process saved.
 *
 *   node scripts/backfill-grok-usage.js
 *   node scripts/backfill-grok-usage.js --home /path/to/home --data /path/to/data
 *   node scripts/backfill-grok-usage.js --apply
 *
 * Cache rates re-price when the Usage page is built. This script does not
 * rewrite those tokens. It also cannot recover past HTTP calls that never
 * stored prompt size, cache, or reasoning; the 200k tier for chars/4
 * estimates; the subscription allowance percent; or Imagine resolution above
 * the default tier.
 */

import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { PATHS } from '../server/lib/fileUtils.js';
import { applyGrokUsageRepair, planGrokUsageRepairFromDisk } from '../server/services/grokUsageBackfill.js';
import { summarizeGrokRepairAdditions } from '../server/services/grokUsageRepair.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function printPlan(plan) {
  const counts = summarizeGrokRepairAdditions(plan.additions);
  console.log(`Grok usage repair: ${counts.added} addition(s).`);
  for (const item of plan.additions) {
    console.log(`  ${item.day}  ${item.repairId}  model=${item.record.model || '(default)'}  images=${item.record.images || 0}  videoSeconds=${item.record.videoSeconds || 0}  longIn=${item.record.longTokensIn || 0}`);
  }
  console.log(`Summary: ${counts.turns} long-context turn(s), ${counts.images} image row(s), ${counts.videos} video row(s).`);
  for (const note of plan.notes) console.log(`Note: ${note}`);
  console.log('Not recoverable: past HTTP calls that never stored prompt size, cache, or reasoning; chars/4 estimates; the subscription allowance percent; Imagine resolution above the default tier.');
  console.log('Cache rates re-price themselves when you reload the Usage page. This script does not rewrite those tokens.');
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const home = argValue(argv, '--home') || homedir();
  const dataDir = argValue(argv, '--data') || join(ROOT, 'data');
  if (!apply) {
    printPlan(await planGrokUsageRepairFromDisk({ home, dataDir }));
    console.log('Dry run. Reconcile now on the Usage page applies this while PortOS is running. --apply writes the ledger only after PortOS is stopped.');
    return;
  }
  if (resolve(dataDir) !== resolve(PATHS.data)) {
    console.error(`❌ --apply writes ${PATHS.data}/usage.json. Re-run without --data, or pass --data ${PATHS.data}.`);
    process.exitCode = 1;
    return;
  }
  const result = await applyGrokUsageRepair({ home, dataDir });
  console.log(`Applied ${result.added} addition(s): ${result.turns} long-context turn(s), ${result.images} image row(s), ${result.videos} video row(s).`);
  if (result.note) console.log(`Note: ${result.note}`);
  if (result.backedUp) console.log(`Backed up the ledger to ${result.backupDir}`);
  if (result.added === 0) console.log('Nothing to apply.');
}

main().catch((err) => {
  console.error(`❌ Grok usage backfill failed: ${err.message}`);
  process.exitCode = 1;
});
