/**
 * One-shot repair for issues stranded behind a defunct seasonId.
 *
 * Background: a "Regenerate arc" against a series replaced series.seasons[]
 * with brand-new uuids without remapping the existing child issues, so the
 * Arc Canvas grouped them under an "Un-grouped" bucket instead of their
 * actual seasons. The structural fix lives in arcPlanner; this script
 * heals the data that was already broken.
 *
 * Strategy: for the target series, group orphaned issues by their stale
 * seasonId, order each group's issues by min(number), and map orphan
 * groups 1:1 onto the series' current seasons (sorted by number). After
 * reassigning seasonIds, run recomputeIssueNumbersForSeries so number
 * gaps from the reorder collapse.
 *
 * Usage:
 *   node scripts/repair-orphaned-issues.js --series=<seriesId>            # dry-run
 *   node scripts/repair-orphaned-issues.js --series=<seriesId> --apply    # write
 */
import { getSeries } from '../server/services/pipeline/series.js';
import {
  listIssues,
  updateIssue,
  recomputeIssueNumbersForSeries,
} from '../server/services/pipeline/issues.js';
import { withReexportSuppressed } from '../server/services/sharing/recordEvents.js';

function parseArgs(argv) {
  const out = { apply: false, seriesId: null };
  for (const arg of argv.slice(2)) {
    if (arg === '--apply') out.apply = true;
    else if (arg.startsWith('--series=')) out.seriesId = arg.slice('--series='.length);
  }
  return out;
}

async function main() {
  const { seriesId, apply } = parseArgs(process.argv);
  if (!seriesId) {
    console.error('❌ --series=<id> is required');
    process.exit(1);
  }

  const series = await getSeries(seriesId);
  const seasons = (series.seasons || []).slice().sort(
    (a, b) => (a.number || 0) - (b.number || 0),
  );
  const validIds = new Set(seasons.map((s) => s.id));
  const issues = await listIssues({ seriesId });

  const orphans = issues.filter((i) => i.seasonId && !validIds.has(i.seasonId));
  if (!orphans.length) {
    console.log(`✅ No orphaned issues on ${seriesId} — nothing to repair`);
    return;
  }

  const groups = new Map();
  for (const iss of orphans) {
    if (!groups.has(iss.seasonId)) groups.set(iss.seasonId, []);
    groups.get(iss.seasonId).push(iss);
  }
  const orphanGroups = [...groups.entries()]
    .map(([oldId, list]) => ({
      oldId,
      list: list.slice().sort((a, b) => (a.number || 0) - (b.number || 0)),
      minNumber: list.reduce((m, i) => Math.min(m, i.number || Infinity), Infinity),
    }))
    .sort((a, b) => a.minNumber - b.minNumber);

  if (orphanGroups.length !== seasons.length) {
    console.error(
      `❌ Refusing to remap: ${orphanGroups.length} orphan groups vs ${seasons.length} current seasons — not 1:1. Resolve manually.`,
    );
    process.exit(2);
  }

  console.log(`🔍 Series: ${series.name || seriesId}`);
  console.log(`🔍 Current seasons (${seasons.length}):`);
  seasons.forEach((s, i) => console.log(`  ${i + 1}. ${s.id}  #${s.number}  ${s.title}`));
  console.log(`🔍 Orphan groups (${orphanGroups.length}):`);
  const remap = new Map();
  orphanGroups.forEach((g, i) => {
    const target = seasons[i];
    remap.set(g.oldId, target.id);
    const titles = g.list.slice(0, 3).map((i) => i.title || '(untitled)').join(' | ');
    console.log(`  ${i + 1}. ${g.oldId}  (${g.list.length} issues, #${g.list[0].number}-${g.list[g.list.length - 1].number})  →  ${target.id}  "${target.title}"`);
    console.log(`     ${titles}${g.list.length > 3 ? ' | …' : ''}`);
  });

  if (!apply) {
    console.log('\nℹ️  Dry-run. Re-run with --apply to write.');
    return;
  }

  await withReexportSuppressed('series', seriesId, async () => {
    for (const iss of orphans) {
      const target = remap.get(iss.seasonId);
      await updateIssue(iss.id, { seasonId: target }, { skipRenumber: true });
    }
    await recomputeIssueNumbersForSeries(seriesId);
  });
  console.log(`\n✅ Reassigned ${orphans.length} issue${orphans.length === 1 ? '' : 's'} and recomputed numbers.`);
}

main().catch((err) => {
  console.error(`❌ ${err?.message || err}`);
  process.exit(1);
});
