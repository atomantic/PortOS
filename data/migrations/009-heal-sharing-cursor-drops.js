/**
 * One-shot heal for sharing cursor entries that suppressed retry of a
 * manifest whose record JSON hadn't synced yet at first-import time.
 *
 * Background: a pre-fix processManifest marked every manifest as processed
 * even when readReferencedRecords returned an empty records array (the JSON
 * file hadn't synced into the bucket yet). The cursor entry then suppressed
 * every future replay, silently dropping the universe/series until the user
 * re-shared. The importer now defers markProcessed when a manifest references
 * records that aren't present, but installs that already accumulated bad
 * cursor entries stay stuck. This migration scans each bucket's cursor
 * against the local record stores and forgets entries whose referenced
 * records are absent locally AND whose manifest is still on disk — the next
 * backlog pass will retry them through the fixed code path.
 *
 * Idempotent: a second run finds nothing to forget (the bad entries were
 * already cleared, or the records have since been imported successfully).
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const readJson = async (path, fallback) => {
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
};

const writeJson = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + '\n');

async function loadLocalIdSets(dataDir) {
  const universes = await readJson(join(dataDir, 'universe-builder.json'), { universes: [] });
  const series = await readJson(join(dataDir, 'pipeline-series.json'), { series: [] });
  const issues = await readJson(join(dataDir, 'pipeline-issues.json'), { issues: [] });
  const media = await readJson(join(dataDir, 'media-jobs.json'), { jobs: [] });
  return {
    universeIds: new Set((universes.universes || []).map((u) => u?.id).filter(Boolean)),
    seriesIds: new Set((series.series || []).map((s) => s?.id).filter(Boolean)),
    issueIds: new Set((issues.issues || []).map((i) => i?.id).filter(Boolean)),
    mediaIds: new Set((media.jobs || []).map((m) => m?.id).filter(Boolean)),
  };
}

function manifestHasMissingRecord(manifest, idSets) {
  for (const id of manifest?.recordIds || []) {
    if (typeof id !== 'string') continue;
    if (id.startsWith('ser-')) {
      if (!idSets.seriesIds.has(id)) return true;
    } else if (id.startsWith('iss-')) {
      if (!idSets.issueIds.has(id)) return true;
    } else if (id.startsWith('chr-') || id.startsWith('set-') || id.startsWith('obj-')) {
      // Bible entries — never standalone records, skip.
      continue;
    } else {
      // UUID-only — could be universe or media job. Present in either is fine.
      if (!idSets.universeIds.has(id) && !idSets.mediaIds.has(id)) return true;
    }
  }
  return false;
}

export async function healSharingCursorDrops({ rootDir }) {
  const dataDir = join(rootDir, 'data');
  const sharingDir = join(dataDir, 'sharing');
  const bucketsPath = join(sharingDir, 'buckets.json');
  const cursorsDir = join(sharingDir, 'cursors');

  const bucketsDoc = await readJson(bucketsPath, null);
  if (!bucketsDoc || !Array.isArray(bucketsDoc.buckets) || bucketsDoc.buckets.length === 0) {
    console.log('📦 sharing.heal: no buckets registered — nothing to do');
    return { totalForgotten: 0 };
  }

  const idSets = await loadLocalIdSets(dataDir);
  let totalForgotten = 0;

  for (const bucket of bucketsDoc.buckets) {
    if (!bucket?.id || !bucket?.path) continue;
    const cursorPath = join(cursorsDir, `${bucket.id}.json`);
    const cursor = await readJson(cursorPath, null);
    if (!cursor || !cursor.processedById || typeof cursor.processedById !== 'object') continue;

    const manifestsDir = join(bucket.path, 'manifests');
    const forgotten = [];
    for (const filename of Object.keys(cursor.processedById)) {
      const manifestPath = join(manifestsDir, filename);
      // Peer unshared the record (file gone) — leave the cursor alone so we
      // don't churn forgetting + re-noticing the same unlink.
      if (!existsSync(manifestPath)) continue;
      const manifest = await readJson(manifestPath, null);
      if (!manifest) continue;
      if (manifestHasMissingRecord(manifest, idSets)) {
        forgotten.push(filename);
      }
    }

    if (forgotten.length === 0) continue;
    for (const f of forgotten) delete cursor.processedById[f];
    cursor.lastProcessedAt = new Date().toISOString();
    await writeJson(cursorPath, cursor);
    totalForgotten += forgotten.length;
    console.log(`🧹 sharing.heal: bucket=${bucket.name || bucket.id} forgot ${forgotten.length} cursor entr${forgotten.length === 1 ? 'y' : 'ies'} pointing at absent records`);
  }

  if (totalForgotten === 0) {
    console.log('✅ sharing.heal: no stuck cursor entries found');
  } else {
    console.log(`✅ sharing.heal: total ${totalForgotten} entr${totalForgotten === 1 ? 'y' : 'ies'} cleared — next watcher pass will retry`);
  }
  return { totalForgotten };
}

export default {
  up: healSharingCursorDrops,
};
