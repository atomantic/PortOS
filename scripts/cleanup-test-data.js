/**
 * One-shot cleanup for test-fixture records that polluted real `data/`.
 *
 * Background: Vitest test files create universes / series with hard-coded
 * names like "Test Work" and "Commit U". The current tests mock PATHS.data
 * at the filesystem layer, so they should never touch real data — but at
 * some point in the past (before mockPathsDataRoot was widely adopted, or
 * via a stray integration test) these fixtures leaked into the production
 * `data/universe-builder.json` + `data/pipeline-series.json`. The new
 * federated peer-sync auto-subscribe (PR #443) picks them up on
 * `peer:online` and starts pushing them across the federation.
 *
 * This script soft-deletes records whose names EXACTLY match the known
 * test-fixture roster, AND cascades the soft-delete to child issues of
 * each tombstoned series so the orphan-zombie state (children with a
 * seriesId pointing at a tombstone-GC'd parent) never materializes.
 *
 * IMPORTANT — STOP THE SERVER BEFORE `--apply`. This script invokes the
 * service-layer read/modify/write helpers in a SEPARATE Node process from
 * any running portos-server. The service-layer write tails (per-file
 * `writeState` queues) are in-process — they do NOT serialize across
 * processes, so a concurrent `portos-server` write can clobber this
 * script's tombstone (last-writer-wins on the JSON file). Always:
 *
 *   pm2 stop portos-server                          # 1. stop the server
 *   node scripts/cleanup-test-data.js               #    dry-run first
 *   node scripts/cleanup-test-data.js --apply       # 2. apply
 *   pm2 start portos-server                         # 3. restart
 *
 * The PM2 restart propagation: on boot the server fires `peer:online` →
 * `retryPendingPushesForPeer` → walks every sub and re-pushes (let
 * `lastPushedHash` short-circuit the unchanged ones). The now-tombstoned
 * records hash differently so the tombstone push fires for each peer.
 * That delete event is what reaches peers — `deleteUniverse` /
 * `deleteSeries` emit `recordEvents.deleted` which peer-sync now listens
 * for, but only in the process that has `installPeerSyncListener()`
 * running. The CLI process here doesn't, which is why the restart is the
 * propagation mechanism rather than the script's own writes.
 *
 * Add names to TEST_FIXTURE_*_NAMES if your data has other test residue.
 * Names are matched EXACTLY (after trim) to avoid clobbering user-named
 * records that happen to share a substring (e.g. a real series called
 * "Commit Universe Tour").
 */
import { listUniverses, deleteUniverse } from '../server/services/universeBuilder.js';
import { listSeries, deleteSeries } from '../server/services/pipeline/series.js';
import { listIssues, deleteIssue } from '../server/services/pipeline/issues.js';

// Roster of names known to come from test fixtures. Conservative default:
// only unmistakable test names. Generic single-word names that could
// plausibly be a real user's universe/series (e.g. 'A', 'B', 'Live',
// 'Hidden', 'Original', 'Corrupt', 'Moebius SciFi') are intentionally
// OMITTED — running this script with --apply against a polluted data
// directory must never destroy a real user's record. Add per-install
// names here directly if you find more residue.
//
// Source roster (audited against the test suite as of 2026-05-22):
//   server/services/writersRoom/promoteToPipeline.test.js → "Test Work"
//   server/services/importer.test.js                      → "Commit U", "Commit S"
//   server/services/pipeline/series.test.js               → various (only the
//                                                            unambiguously-test ones below)
const TEST_FIXTURE_UNIVERSE_NAMES = new Set([
  'Test Work',
  'Commit U',
]);

const TEST_FIXTURE_SERIES_NAMES = new Set([
  'Commit S',
  'Linkless S',
  'Locked S',
  'Same Title',
  'Salt Run',
  'Old tombstone',
  'New tombstone',
  'Edited Locally',
]);

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
    console.log('🧪 DRY-RUN — pass --apply to actually soft-delete\n');
  } else {
    // Service-layer write tails are in-process — a concurrent portos-server
    // can clobber tombstones (last-writer-wins on the JSON file). Warn loudly.
    console.log('⚠️  --apply: STOP the server before continuing or tombstones may be clobbered');
    console.log('⚠️  Run `pm2 stop portos-server` first, then `pm2 start portos-server` to propagate\n');
  }

  // Universes (skip already-tombstoned ones so a re-run is a no-op).
  const universes = await listUniverses({ includeDeleted: false });
  const universeTargets = universes.filter(u =>
    TEST_FIXTURE_UNIVERSE_NAMES.has((u.name || '').trim())
  );
  console.log(`🗑️  Universes to delete: ${universeTargets.length}`);
  for (const u of universeTargets) {
    console.log(`   - ${u.id.slice(0, 8)} "${u.name}" (updated ${u.updatedAt})`);
  }

  // Series + their child issues. Resolve children up front so the dry-run
  // output also reports the cascade — running with --apply matches.
  const series = await listSeries({ includeDeleted: false });
  const seriesTargets = series.filter(s =>
    TEST_FIXTURE_SERIES_NAMES.has((s.name || '').trim())
  );
  // Map series.id → array of live child issues for that series.
  const childIssuesBySeries = new Map();
  for (const s of seriesTargets) {
    const children = await listIssues({ seriesId: s.id, includeDeleted: false }).catch(() => []);
    childIssuesBySeries.set(s.id, children);
  }
  const totalChildIssues = [...childIssuesBySeries.values()].reduce((n, arr) => n + arr.length, 0);
  console.log(`\n🗑️  Series to delete: ${seriesTargets.length} (cascading ${totalChildIssues} child issue${totalChildIssues === 1 ? '' : 's'})`);
  for (const s of seriesTargets) {
    const children = childIssuesBySeries.get(s.id) || [];
    console.log(`   - ${s.id.slice(0, 12)} "${s.name}" (updated ${s.updatedAt}, ${children.length} child issue${children.length === 1 ? '' : 's'})`);
  }

  if (!apply) {
    console.log('\n🧪 DRY-RUN complete — re-run with --apply to write tombstones');
    return;
  }

  // Apply phase — universes first (their child series carry universeId
  // pointers, but the tombstone on the universe doesn't cascade to series;
  // series with this universeId orphan-but-live, which is fine).
  console.log('\n🗑️  Applying universe tombstones...');
  for (const u of universeTargets) {
    await deleteUniverse(u.id).catch(err =>
      console.error(`   ⚠️  failed to delete universe ${u.id.slice(0, 8)}: ${err.message}`),
    );
  }
  // Series: tombstone the children FIRST so a re-run can't see them after
  // the parent series tombstone is gone (listIssues filters by seriesId so
  // an orphan child wouldn't surface in the dry-run either — children must
  // go via this script's pass, not the parent's GC). Then tombstone the series.
  console.log('🗑️  Applying issue + series tombstones...');
  for (const s of seriesTargets) {
    const children = childIssuesBySeries.get(s.id) || [];
    for (const i of children) {
      await deleteIssue(i.id).catch(err =>
        console.error(`   ⚠️  failed to delete issue ${i.id.slice(0, 12)} (child of ${s.id.slice(0, 12)}): ${err.message}`),
      );
    }
    await deleteSeries(s.id).catch(err =>
      console.error(`   ⚠️  failed to delete series ${s.id.slice(0, 12)}: ${err.message}`),
    );
  }
  console.log(`\n✅ Tombstoned ${universeTargets.length} universe(s) + ${seriesTargets.length} series + ${totalChildIssues} issue(s).`);
  console.log('🔄 Now restart the PM2 server to propagate the tombstones to peers:');
  console.log('   pm2 restart portos-server');
  console.log('   (peer:online will re-fire every per-record sub and the new tombstone');
  console.log('    hashes will diverge from lastPushedHash so the deletes push.)');
}

main().catch(err => {
  console.error('❌ cleanup-test-data failed:', err);
  process.exit(1);
});
