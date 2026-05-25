/**
 * One-shot tombstone garbage collection.
 *
 * Drives `sweepTombstones({ graceMs: 0 })` from a CLI so a headless cleanup
 * (post-mass-delete, scripted reset, server-stopped maintenance window) can
 * shrink `data/universe-builder.json` + `data/pipeline-series.json` +
 * `data/pipeline-issues.json` immediately rather than waiting up to 24h for
 * the orchestrator's next scheduled sweep.
 *
 * The existing per-kind safety still fires: a snapshot-mode peer that's
 * enabled for `universe` / `pipeline` without a per-record subscription will
 * cause that kind's cutoff to come back null and the prune to be skipped
 * (the resurrection-safety check is independent of graceMs).
 *
 * IMPORTANT — STOP THE SERVER BEFORE RUNNING. This script invokes the
 * service-layer prune helpers in a SEPARATE Node process from any running
 * portos-server. The service-layer write tails (per-file `writeState`
 * queues) are in-process — they do NOT serialize across processes, so a
 * concurrent `portos-server` write can clobber this script's prune
 * (last-writer-wins on the JSON file). Always:
 *
 *   pm2 stop portos-server                # 1. stop the server
 *   node scripts/gc-tombstones-now.js     #    dry-run first (no --apply)
 *   node scripts/gc-tombstones-now.js --apply
 *   pm2 start portos-server               # 2. restart
 *
 * Seed for this script: the 2026-05-23 inline-Node prune we ran for the
 * post-Echoes-cleanup batch (82 universe + 192 series tombstones acked by
 * peer null from a same-day mass-delete that the user wanted off disk early).
 */
import { sweepTombstones, getSweepStatus } from '../server/services/sharing/tombstoneGc.js';

// Mirrors `TOMBSTONE_KIND_PLURAL` in the Instances UI so the CLI output
// matches the toast wording. Dedupe handles the series/issue cohort.
const KIND_PLURAL = { universe: 'universes', series: 'series', issue: 'issues' };
const labelKinds = (kinds) => [...new Set(kinds.map((k) => KIND_PLURAL[k] ?? k))].join(', ');

function parseArgs(argv) {
  const out = { apply: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--apply') out.apply = true;
  }
  return out;
}

async function main() {
  const { apply } = parseArgs(process.argv);
  if (!apply) {
    console.log('🧪 DRY-RUN — pass --apply to actually prune tombstones\n');
  } else {
    console.log('⚠️  --apply: STOP the server before continuing or prunes may be clobbered');
    console.log('⚠️  Run `pm2 stop portos-server` first, then `pm2 start portos-server` after\n');
  }

  // Dry-run path: report the refusal status only. The prune counts depend
  // on iterating tombstone records (which means reading the same JSON files
  // the actual prune would write to) so we deliberately don't preview them
  // — too easy to misread "would prune N" as "did prune N".
  const status = await getSweepStatus();
  if (status.refused.length > 0) {
    console.log(`⚠️  Refused kinds: ${labelKinds(status.refused)}`);
    console.log('   (a snapshot-mode peer has no per-record subscription for this kind — resurrection risk)');
  } else {
    console.log('✅ No refusals — every kind has an ack horizon');
  }

  if (!apply) {
    console.log('\n🧪 DRY-RUN complete — re-run with --apply to prune');
    return;
  }

  const result = await sweepTombstones({ graceMs: 0 });
  console.log(`\n🗑️  Pruned: ${result.universes} universe(s), ${result.series} series, ${result.issues} issue(s)`);
  if (result.refused.length > 0) {
    console.log(`⚠️  Skipped: ${labelKinds(result.refused)} (resurrection-safety refusal)`);
  }
}

main().catch((err) => {
  console.error(`❌ gc-tombstones-now failed: ${err.message}`);
  process.exit(1);
});
