/**
 * arcPlanner/coverConcepts.js — volume + comic cover-concept generation.
 * Built on ./context.js.
 */

import { runStagedLLM } from '../../../lib/stageRunner.js';
import { getSeries, updateSeasonOnSeries } from '../series.js';
import { assertStageUnlocked, getIssue, updateStageWithLatest } from '../issues.js';
import { ERR_VALIDATION, makeErr } from './context.js';

/**
 * Generate FRONT + BACK cover-art concepts for one volume (season). Returns
 * the proposed text without persisting; pass `commit: true` to write the
 * scripts to `season.cover.script` / `season.backCover.script` — only when
 * those slots are currently blank, never clobbering a user edit.
 *
 * Sized as a lightweight per-season LLM call rather than bolted onto the
 * arc-overview pass so (a) cover concepts can be regenerated independently
 * of the arc structure, and (b) the heavier arc-overview prompt's output
 * tokens stay focused on structural beats.
 */
export async function generateVolumeCoverConcepts(seriesId, seasonId, options = {}) {
  const series = await getSeries(seriesId);
  const seasons = series.seasons || [];
  const season = seasons.find((s) => s.id === seasonId);
  if (!season) {
    throw makeErr(`Season not found on series: ${seasonId}`, ERR_VALIDATION);
  }
  const themesCsv = Array.isArray(season.themes) ? season.themes.join(', ') : '';
  const ctx = {
    series: {
      name: series.name,
      logline: series.logline,
      styleNotes: series.styleNotes,
    },
    season: {
      number: season.number,
      title: season.title,
      logline: season.logline,
      synopsis: season.synopsis,
      endingHook: season.endingHook,
      episodeCountTarget: season.episodeCountTarget,
      themesCsv,
    },
  };
  const { content, runId, providerId, model } = await runStagedLLM(
    'pipeline-volume-cover-concepts',
    ctx,
    {
      providerOverride: options.providerOverride,
      modelOverride: options.modelOverride,
      returnsJson: true,
      source: 'pipeline-volume-cover-concepts',
    },
  );
  const coverConcept = (typeof content?.coverConcept === 'string' ? content.coverConcept : '').trim();
  const backCoverConcept = (typeof content?.backCoverConcept === 'string' ? content.backCoverConcept : '').trim();
  let updatedSeries = null;
  const seeded = { cover: false, backCover: false };
  if (options.commit) {
    // Scoped per-season patch via updateSeasonOnSeries — runs inside the
    // series write tail, skips the full sanitizeSeries pass over every
    // bible list. The "only seed when blank" check happens INSIDE the
    // callback so it reads the freshest persisted scripts (avoiding a
    // race against a concurrent user blur-save).
    updatedSeries = await updateSeasonOnSeries(seriesId, seasonId, (cur) => {
      const patch = {};
      // Trim before the blank-check so whitespace-only scripts count as
      // blank — matches the client `.trim()` gate on the per-card buttons.
      if (coverConcept && !(cur.cover?.script || '').trim()) {
        patch.cover = { ...(cur.cover || {}), script: coverConcept };
        seeded.cover = true;
      }
      if (backCoverConcept && !(cur.backCover?.script || '').trim()) {
        patch.backCover = { ...(cur.backCover || {}), script: backCoverConcept };
        seeded.backCover = true;
      }
      return patch;
    });
  }
  return {
    season: updatedSeries ? (updatedSeries.seasons || []).find((s) => s.id === seasonId) : season,
    series: updatedSeries,
    coverConcept,
    backCoverConcept,
    seeded,
    raw: content,
    runId,
    providerId,
    model,
  };
}

/**
 * Generate FRONT + BACK cover-art concepts for one comic issue. Per-issue
 * sibling of `generateVolumeCoverConcepts`: returns the proposed text and,
 * when `commit: true`, seeds blank `stages.comicPages.cover.script` /
 * `stages.comicPages.backCover.script` slots without clobbering user edits.
 *
 * `options.target` ('cover' | 'backCover' | 'both', default 'both') gates
 * which slots can be seeded — the UI buttons live per-card so the user can
 * regenerate one without touching the other, even though the LLM returns
 * the pair so the back can complement the front.
 */
export async function generateComicCoverConcepts(issueId, options = {}) {
  // `??` (not `||`) so an empty-string target falls through to the
  // invalid-target guard below instead of silently defaulting to 'both'.
  const target = options.target ?? 'both';
  if (target !== 'cover' && target !== 'backCover' && target !== 'both') {
    throw makeErr(`Invalid target: ${target}`, ERR_VALIDATION);
  }
  const issue = await getIssue(issueId);
  // `commit: true` mutates `stages.comicPages.cover/backCover.script` —
  // refuse when the stage is locked. Preview-only (`commit !== true`) is
  // allowed: it just returns the LLM output without persisting.
  if (options.commit) assertStageUnlocked(issue, 'comicPages');
  const series = await getSeries(issue.seriesId);
  const proseFull = (issue.stages?.prose?.output || '').trim();
  // Cap prose at a generous excerpt so very long drafts don't blow the
  // prompt budget — the LLM only needs enough scene material to anchor a
  // cover image, not the full text.
  const proseExcerpt = proseFull.length > 4000 ? `${proseFull.slice(0, 4000)}…` : proseFull;
  const ctx = {
    series: {
      name: series.name,
      logline: series.logline,
      styleNotes: series.styleNotes,
    },
    issue: {
      number: issue.number,
      title: issue.title,
      synopsis: (issue.stages?.idea?.input || '').trim(),
      beats: (issue.stages?.idea?.output || '').trim(),
      proseExcerpt,
    },
  };
  const { content, runId, providerId, model } = await runStagedLLM(
    'pipeline-comic-cover-concepts',
    ctx,
    {
      providerOverride: options.providerOverride,
      modelOverride: options.modelOverride,
      returnsJson: true,
      source: 'pipeline-comic-cover-concepts',
    },
  );
  const coverConcept = (typeof content?.coverConcept === 'string' ? content.coverConcept : '').trim();
  const backCoverConcept = (typeof content?.backCoverConcept === 'string' ? content.backCoverConcept : '').trim();
  const wantCover = target === 'cover' || target === 'both';
  const wantBack = target === 'backCover' || target === 'both';
  let updatedIssue = null;
  let updatedStage = null;
  const seeded = { cover: false, backCover: false };
  if (options.commit) {
    // Read the freshest persisted stage inside the queue so a concurrent
    // blur-save on either cover script can't be silently overwritten —
    // same "only seed when blank" pattern as the volume variant.
    const result = await updateStageWithLatest(issueId, 'comicPages', (cur) => {
      const patch = {};
      // Trim before the blank-check so the server's notion of "occupied"
      // matches the client's `.trim()`-based button gate — otherwise a
      // whitespace-only script enables the button but the server refuses
      // to seed, producing a misleading "preserved" toast.
      if (wantCover && coverConcept && !(cur?.cover?.script || '').trim()) {
        patch.cover = { ...(cur?.cover || {}), script: coverConcept };
        seeded.cover = true;
      }
      if (wantBack && backCoverConcept && !(cur?.backCover?.script || '').trim()) {
        patch.backCover = { ...(cur?.backCover || {}), script: backCoverConcept };
        seeded.backCover = true;
      }
      return patch;
    });
    updatedIssue = result.issue;
    updatedStage = result.stage;
  }
  return {
    issue: updatedIssue,
    stage: updatedStage,
    target,
    coverConcept,
    backCoverConcept,
    seeded,
    raw: content,
    runId,
    providerId,
    model,
  };
}
