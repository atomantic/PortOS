/**
 * Backfill issue.number on existing pipeline data after the switch to
 * volume-ordered numbering.
 *
 * Previously, `issue.number` was a series-wide counter that only ever moved
 * forward — a series with V1 (#1–11) and V2 (#12–43) kept those numbers
 * even though they no longer reflected volume position. The new model derives
 * `number` from (volume order, arcPosition). This walks every series once
 * and rewrites `pipeline-issues.json` so the on-disk state matches what the
 * live renumber pass would produce on the next mutation — users don't have
 * to edit a record to see correct numbers.
 *
 * Imports the same algorithm the live service uses, so the migration can't
 * drift from `createIssue`'s renumber pass. Idempotent: a series whose
 * issues already match the derived order is left alone.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { applyVolumeOrderedNumbers } from '../../server/lib/pipelineIssueOrder.js';

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

export async function renumberPipelineIssuesByVolume({ rootDir }) {
  const dataDir = join(rootDir, 'data');
  const seriesPath = join(dataDir, 'pipeline-series.json');
  const issuesPath = join(dataDir, 'pipeline-issues.json');

  const seriesDoc = await readJson(seriesPath, null);
  const issuesDoc = await readJson(issuesPath, null);
  if (!seriesDoc || !issuesDoc) {
    console.log('🔢 issue-renumber: no pipeline data — nothing to do');
    return { changedSeries: 0 };
  }

  const seriesList = Array.isArray(seriesDoc.series) ? seriesDoc.series : [];
  const issuesList = Array.isArray(issuesDoc.issues) ? issuesDoc.issues : [];
  if (seriesList.length === 0 || issuesList.length === 0) {
    console.log('🔢 issue-renumber: empty series or issue list — nothing to do');
    return { changedSeries: 0 };
  }

  let changedSeries = 0;
  for (const series of seriesList) {
    if (!series?.id) continue;
    const changed = applyVolumeOrderedNumbers({
      issues: issuesList,
      seriesId: series.id,
      seasons: Array.isArray(series.seasons) ? series.seasons : [],
    });
    if (changed) changedSeries += 1;
  }

  if (changedSeries === 0) {
    console.log('✅ issue-renumber: all issues already match volume order');
    return { changedSeries: 0 };
  }

  await writeJson(issuesPath, issuesDoc);
  console.log(`✅ issue-renumber: renumbered issues in ${changedSeries} series`);
  return { changedSeries };
}

export default {
  up: renumberPipelineIssuesByVolume,
};
