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

// Real records are ALWAYS minted with randomUUID() — universes get a bare UUID,
// series an `ser-<uuid>`, issues an `iss-<uuid>` (server/services/pipeline/{series,
// issues}.js, universeBuilder.js). So any record whose id is NOT that shape
// (e.g. `ok-1`, `ser-1`, `ser-uuid-2`, `iss-live`, `iss-dup`) is unambiguously a
// hard-coded test fixture the app could never have created — a far more reliable
// signal than the name roster, and it catches generic-named fixtures the roster
// intentionally omits. We delete on EITHER signal: impossible-id OR test-name.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUniverseFixtureId = (id) => !UUID_RE.test(id || '');
const isSeriesFixtureId = (id) => !(/^ser-/.test(id || '') && UUID_RE.test((id || '').slice(4)));
const isIssueFixtureId = (id) => !(/^iss-/.test(id || '') && UUID_RE.test((id || '').slice(4)));

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
  'Committed S',
  'Linkless S',
  'Locked S',
  'Same Title',
  'Salt Run',
  'Old tombstone',
  'New tombstone',
  'Edited Locally',
  // Added 2026-06-14 after auditing the live DB: more unambiguous test names
  // (the matching fixtures all carry `ser-<uuid>` ids so the id-shape check
  // alone wouldn't catch them). All sourced from series.test.js / importer.test.js.
  'A Series',
  'Born Committed',
  'Real Work',
  'Moving Series',
  'S1',
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

  // A record is a fixture target on EITHER signal: an impossible (non-minted)
  // id shape OR a name in the test roster. The id-shape check is the stronger
  // signal — the running app cannot mint `ser-1`/`ok-1`/`iss-live`.
  const universeReason = (u) =>
    isUniverseFixtureId(u.id) ? 'non-uuid id'
    : TEST_FIXTURE_UNIVERSE_NAMES.has((u.name || '').trim()) ? 'test name' : null;
  const seriesReason = (s) =>
    isSeriesFixtureId(s.id) ? 'non-uuid id'
    : TEST_FIXTURE_SERIES_NAMES.has((s.name || '').trim()) ? 'test name' : null;

  // Universes (skip already-tombstoned ones so a re-run is a no-op).
  const universes = await listUniverses({ includeDeleted: false });
  const universeTargets = universes
    .map(u => ({ rec: u, reason: universeReason(u) }))
    .filter(t => t.reason);
  console.log(`🗑️  Universes to delete: ${universeTargets.length}`);
  for (const { rec: u, reason } of universeTargets) {
    console.log(`   - ${u.id.slice(0, 8)} "${u.name}" (${reason}, updated ${u.updatedAt})`);
  }

  // Series + their child issues. Resolve children up front so the dry-run
  // output also reports the cascade — running with --apply matches.
  const series = await listSeries({ includeDeleted: false });
  const seriesTargets = series
    .map(s => ({ rec: s, reason: seriesReason(s) }))
    .filter(t => t.reason);
  const seriesTargetIds = new Set(seriesTargets.map(t => t.rec.id));
  // Map series.id → array of live child issues for that series.
  const childIssuesBySeries = new Map();
  for (const { rec: s } of seriesTargets) {
    const children = await listIssues({ seriesId: s.id, includeDeleted: false }).catch(() => []);
    childIssuesBySeries.set(s.id, children);
  }
  const totalChildIssues = [...childIssuesBySeries.values()].reduce((n, arr) => n + arr.length, 0);
  console.log(`\n🗑️  Series to delete: ${seriesTargets.length} (cascading ${totalChildIssues} child issue${totalChildIssues === 1 ? '' : 's'})`);
  for (const { rec: s, reason } of seriesTargets) {
    const children = childIssuesBySeries.get(s.id) || [];
    console.log(`   - ${s.id.slice(0, 12)} "${s.name}" (${reason}, updated ${s.updatedAt}, ${children.length} child issue${children.length === 1 ? '' : 's'})`);
  }

  // Orphan fixture issues: a non-uuid-id issue whose parent series is NOT itself
  // a target (so it won't be reached by the cascade above). These are direct
  // test-fixture inserts (`iss-live`, `iss-dup`, …) that would otherwise survive.
  const allIssues = await listIssues({ includeDeleted: false }).catch(() => []);
  const orphanIssueTargets = allIssues.filter(
    i => isIssueFixtureId(i.id) && !seriesTargetIds.has(i.seriesId),
  );
  console.log(`\n🗑️  Orphan fixture issues (non-uuid id, parent not targeted): ${orphanIssueTargets.length}`);
  for (const i of orphanIssueTargets) {
    console.log(`   - ${i.id} (series ${i.seriesId}, #${i.number})`);
  }

  if (!apply) {
    console.log('\n🧪 DRY-RUN complete — re-run with --apply to write tombstones');
    return;
  }

  // Apply phase — universes first (their child series carry universeId
  // pointers, but the tombstone on the universe doesn't cascade to series;
  // series with this universeId orphan-but-live, which is fine).
  console.log('\n🗑️  Applying universe tombstones...');
  for (const { rec: u } of universeTargets) {
    await deleteUniverse(u.id).catch(err =>
      console.error(`   ⚠️  failed to delete universe ${u.id.slice(0, 8)}: ${err.message}`),
    );
  }
  // Series: tombstone the children FIRST so a re-run can't see them after
  // the parent series tombstone is gone (listIssues filters by seriesId so
  // an orphan child wouldn't surface in the dry-run either — children must
  // go via this script's pass, not the parent's GC). Then tombstone the series.
  console.log('🗑️  Applying issue + series tombstones...');
  for (const { rec: s } of seriesTargets) {
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
  // Orphan fixture issues whose parent series wasn't itself a target.
  for (const i of orphanIssueTargets) {
    await deleteIssue(i.id).catch(err =>
      console.error(`   ⚠️  failed to delete orphan issue ${i.id}: ${err.message}`),
    );
  }
  console.log(`\n✅ Tombstoned ${universeTargets.length} universe(s) + ${seriesTargets.length} series + ${totalChildIssues + orphanIssueTargets.length} issue(s).`);
  console.log('🔄 Now restart the PM2 server to propagate the tombstones to peers:');
  console.log('   pm2 restart portos-server');
  console.log('   (peer:online will re-fire every per-record sub and the new tombstone');
  console.log('    hashes will diverge from lastPushedHash so the deletes push.)');
}

main().catch(err => {
  console.error('❌ cleanup-test-data failed:', err);
  process.exit(1);
});
