/**
 * Writers Room ↔ Pipeline bridge (item 6 of the DRY unification).
 *
 * `promoteWorkToPipeline(workId)` creates a Pipeline Series + first Issue from
 * a Writers Room work — carrying over bibles (characters / settings / objects),
 * the active draft body, and the latest script-analysis scenes — then records
 * the bidirectional id link on both sides.
 *
 * Idempotent by default: if a work already records a pipelineSeriesId AND
 * the linked series still exists, return that series + issue instead of
 * creating duplicates. Pass `force: true` to make a fresh series anyway
 * (useful for re-syncing after a destructive pipeline-side edit).
 *
 * One-way: this is only the WR → Pipeline transfer. The link is stable
 * forever, but content does NOT auto-sync — calling this again on a linked
 * work returns the existing pair without re-copying. A future "re-sync"
 * action will be a separate explicit endpoint.
 */

import * as wrLocal from './local.js';
import { listCharacters } from './characters.js';
import { listSettings } from './settings.js';
import { listObjects } from './objects.js';
import { getAnalysis } from './evaluator.js';
import * as seriesSvc from '../pipeline/series.js';
import * as issuesSvc from '../pipeline/issues.js';

export const ERR_NO_DRAFT_BODY = 'WR_PROMOTE_NO_DRAFT_BODY';

/**
 * Pull the latest script-analysis scenes for the work, if any.
 * Returns the canonical scene shape (visualPrompt + the rich fields) — we
 * apply the `visualPrompt → description` UI-shape alias at the issue-write
 * step below, matching the pipeline storyboards extractor route.
 */
async function loadScriptScenes(workId) {
  const analysis = await getAnalysis(workId, 'script').catch((err) => {
    // No analysis yet → treat as "no scenes to transfer," not an error.
    if (err?.status === 404 || err?.code === 'NOT_FOUND') return null;
    throw err;
  });
  if (!analysis || analysis.status !== 'succeeded') return [];
  const scenes = analysis?.result?.scenes;
  return Array.isArray(scenes) ? scenes : [];
}

function buildStoryboardScenes(canonicalScenes) {
  // Mirror the adapter in routes/pipeline.js's /extract-scenes handler so the
  // promoted issue's storyboards stage shape is byte-for-byte identical to
  // what the in-pipeline "Generate scenes from {prose|teleplay}" button
  // would produce. Rich fields (heading/summary/dialogue/...) ride along.
  return canonicalScenes.map((s) => ({
    ...s,
    description: s.visualPrompt || '',
    imageJobId: null,
    prompt: null,
  }));
}

export async function promoteWorkToPipeline(workId, { force = false } = {}) {
  const { manifest, body } = await wrLocal.getWorkWithBody(workId);
  const proseBody = (body || '').trim();
  if (!proseBody) {
    const err = new Error('Cannot promote — the active draft has no prose. Write some text first.');
    err.code = ERR_NO_DRAFT_BODY;
    throw err;
  }

  // Idempotent fast-path. Re-validate that the linked series + issue still
  // exist (a user can delete them out-of-band); if either is missing we drop
  // the stale link and fall through to a fresh create.
  if (!force && manifest.pipelineSeriesId && manifest.pipelineIssueId) {
    const existingSeries = await seriesSvc.getSeries(manifest.pipelineSeriesId).catch(() => null);
    const existingIssue = await issuesSvc.getIssue(manifest.pipelineIssueId).catch(() => null);
    // Verify the issue actually belongs to the linked series — otherwise a
    // manual edit / partial delete / future migration could leave the work
    // pointing at a mismatched pair, and we'd return an unrelated issue.
    // A mismatch is treated like a missing record: drop the stale link and
    // fall through to a fresh create.
    if (existingSeries && existingIssue && existingIssue.seriesId === existingSeries.id) {
      return { series: existingSeries, issue: existingIssue, reused: true };
    }
    await wrLocal.linkToPipeline(workId, { seriesId: null, issueId: null });
  }

  const [characters, settings, objects, scriptScenes] = await Promise.all([
    listCharacters(workId),
    listSettings(workId),
    listObjects(workId),
    loadScriptScenes(workId),
  ]);

  const series = await seriesSvc.createSeries({
    name: manifest.title,
    logline: '',
    premise: '',
    characters,
    settings,
    objects,
    styleNotes: '',
    targetFormat: 'comic+tv',
    issueCountTarget: 1,
    writersRoomWorkId: workId,
  });

  const storyboards = buildStoryboardScenes(scriptScenes);
  const issue = await issuesSvc.createIssue({
    seriesId: series.id,
    title: manifest.title,
    number: 1,
    stages: {
      prose: { status: 'edited', output: proseBody, input: '' },
      storyboards: storyboards.length
        ? { status: 'ready', scenes: storyboards }
        : { status: 'empty' },
    },
  });

  await wrLocal.linkToPipeline(workId, { seriesId: series.id, issueId: issue.id });

  return { series, issue, reused: false };
}
