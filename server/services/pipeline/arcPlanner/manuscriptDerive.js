/**
 * arcPlanner/manuscriptDerive.js — derive an arc from existing manuscript /
 * source text and commit the derived plan. Built on ./context.js + ./arcCore.js.
 */

import { runStagedLLM } from '../../../lib/stageRunner.js';
import { getSeries, updateSeries } from '../series.js';
import { getIssue, listIssues, recomputeIssueNumbersForSeries, updateIssue, updateStage } from '../issues.js';
import { emitRecordUpdated, withReexportSuppressed } from '../../sharing/recordEvents.js';
import { buildSeason, sanitizeArc, sanitizeSeason } from '../../../lib/storyArc.js';
import { ERR_VALIDATION, collectIssueSourceText, compareIssuesByPosition, makeErr, shapeSeasonOutlines } from './context.js';
import { commitSeasonsWithRemap, mergeSeasonsWithLocks } from './arcCore.js';

/**
 * Reverse-engineer an arc + seasons from EXISTING finished work (a concatenated
 * corpus of the series' issue scripts / prose), rather than forward-generating
 * from the series bible. This is the Story Builder's "backfill the arc from a
 * drafted comic" path — it reuses the importer's `importer-arc-extract` prompt
 * (which is purpose-built to describe the spine already in a text) and returns
 * the SAME `{ arc, seasons, ... }` shape as generateArcOverview so the caller
 * can commit it through the identical commitSeasonsWithRemap path.
 *
 * `contentType` defaults to 'comic-script'; it only tunes the prompt's
 * per-type guidance (issue/volume boundary heuristics).
 */
export async function generateArcFromSource(seriesId, {
  sourceText, contentType = 'comic-script', providerOverride, modelOverride,
} = {}) {
  const series = await getSeries(seriesId);
  if (series.locked?.arc === true) {
    throw makeErr(
      'Arc is locked — unlock it on the Arc Canvas before regenerating',
      ERR_VALIDATION,
    );
  }
  const source = String(sourceText || '').trim();
  if (!source) throw makeErr('No source content to extract an arc from', ERR_VALIDATION);
  const { content, runId, providerId, model } = await runStagedLLM(
    'importer-arc-extract',
    {
      seriesName: series.name,
      contentType,
      source,
      // Mirror the importer's per-type Mustache section guards so the prompt's
      // boundary heuristics fire correctly (buildTypeFlags in importer.js).
      isShortStory: contentType === 'short-story',
      isNovel: contentType === 'novel',
      isScreenplay: contentType === 'screenplay',
      isComicScript: contentType === 'comic-script',
    },
    {
      providerOverride,
      modelOverride,
      returnsJson: true,
      source: 'story-builder-arc-backfill',
    },
  );
  const arc = sanitizeArc({
    logline: content?.logline || '',
    summary: content?.summary || '',
    themes: content?.themes,
    protagonistArc: content?.protagonistArc || '',
    // Honor the importer prompt's `shape` pick; fall back to any existing pick.
    shape: content?.shape ?? series.arc?.shape ?? null,
    // Preserve an existing reader map — the extraction doesn't author one.
    readerMap: series.arc?.readerMap ?? null,
    // Likewise preserve an existing ticking clock the extraction doesn't author.
    tickingClock: series.arc?.tickingClock ?? null,
    status: 'draft',
  });
  // importer-arc-extract returns `seasons` (number/title/logline/synopsis/
  // endingHook); shapeSeasonOutlines forwards all fields buildSeason accepts.
  const seasons = shapeSeasonOutlines(content?.seasons);
  return { arc, seasons, raw: content, runId, providerId, model };
}

// Render one derived season's logline + synopsis into a per-issue synopsis seed
// the preview pre-fills `idea.input` with. Empty string when the season carries
// no usable text (the caller leaves the issue's existing synopsis untouched).
export function issueSynopsisFromSeason(season) {
  if (!season) return '';
  return [season.logline, season.synopsis].map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean).join('\n\n');
}

/**
 * Back-derive an arc + bible + a single-volume restructure proposal from the
 * series' EXISTING issue manuscripts — the "I imported a finished graphic novel,
 * now reconstruct its spine" path. Read-only: writes nothing. Returns a preview
 * the UI shows for review/edit before `commitDerivedManuscript` applies it.
 *
 * The proposal is deliberately single-volume (a graphic novel is one book): the
 * derived multi-season `seasons` from `generateArcFromSource` are flattened into
 * per-issue synopsis suggestions (zipped by story order), so the user's "the
 * volume descriptions read better as issue descriptions" intuition is the
 * default. `volume` is the single book; `issues[]` maps each existing issue to a
 * proposed title + synopsis the user can edit.
 */
export async function deriveFromManuscript(seriesId, { providerOverride, modelOverride } = {}) {
  const series = await getSeries(seriesId);
  if (series.locked?.arc === true) {
    throw makeErr('Arc is locked — unlock it on the Arc Canvas before deriving from the manuscript', ERR_VALIDATION);
  }
  const sourceText = await collectIssueSourceText(seriesId);
  if (!sourceText) {
    throw makeErr(
      'No issue manuscript to derive from — write a comic script, prose, or teleplay on at least one issue first',
      ERR_VALIDATION,
    );
  }
  const { arc, seasons, raw, runId, providerId, model } = await generateArcFromSource(seriesId, {
    sourceText, providerOverride, modelOverride,
  });
  const issues = (await listIssues({ seriesId })).sort(compareIssuesByPosition);
  const issueMapping = issues.map((iss, i) => ({
    id: iss.id,
    number: iss.number,
    title: iss.title || `Issue ${i + 1}`,
    currentSynopsis: (iss.stages?.idea?.input || '').trim(),
    // Zip the derived seasons onto issues in story order; extra seasons (more
    // seasons than issues) fall off the end — the user can fold them into the
    // last issue's synopsis in the preview if they matter.
    synopsisSuggestion: issueSynopsisFromSeason(seasons[i]),
    ideaLocked: iss.stages?.idea?.locked === true,
  }));
  return {
    arc,
    // The single book the issues comprise. Title defaults to the series name;
    // logline/synopsis seed from the derived arc.
    volume: {
      title: series.name || seasons[0]?.title || 'Volume 1',
      logline: arc?.logline || '',
      synopsis: arc?.summary || '',
    },
    bible: {
      logline: arc?.logline || series.logline || '',
      premise: arc?.summary || series.premise || '',
      issueCountTarget: issues.length,
    },
    issues: issueMapping,
    // Surface the raw derived seasons too so a future "keep as multi-volume"
    // affordance can opt out of the flatten without re-running the LLM.
    derivedSeasons: seasons,
    runId,
    providerId,
    model,
  };
}

// Seed one issue's `idea.input` synopsis (respecting the per-stage lock). Used
// by the derive-commit to make Verify Arc — which reads `idea.input` — useful on
// issues that only carried a verbatim comicScript before. Never touches
// `idea.output` (beats) or the comicScript manuscript.
export async function seedIssueSynopsis(issueId, synopsis) {
  const text = typeof synopsis === 'string' ? synopsis.trim() : '';
  if (!text) return;
  const iss = await getIssue(issueId).catch(() => null);
  if (!iss || iss.stages?.idea?.locked === true) return;
  const hasBeats = !!(iss.stages?.idea?.output || '').trim();
  await updateStage(issueId, 'idea', {
    input: text,
    // Don't downgrade an issue that already has generated beats.
    status: hasBeats ? (iss.stages?.idea?.status || 'edited') : 'empty',
  });
}

/**
 * Apply a (possibly user-edited) `deriveFromManuscript` preview: write the
 * bible, collapse the series to ONE volume, reassign every issue onto it, and
 * seed per-issue synopses. The verbatim issue scripts (comicScript/prose) are
 * never touched — same contract as `resolveVerifyIssues`.
 *
 * The single volume reuses the lowest-numbered existing season's id when one
 * exists (so issues already under it don't churn), and `commitSeasonsWithRemap`
 * drops the rest while honoring arc/season locks. A follow-up sweep then pins
 * EVERY issue onto the kept volume — covering both issues the remap routed to
 * the ungrouped bucket and any that were already attached elsewhere.
 */
export async function commitDerivedManuscript(seriesId, { arc, bible, volume, issues = [] } = {}) {
  const series = await getSeries(seriesId);
  if (series.locked?.arc === true) {
    throw makeErr('Arc is locked — unlock it on the Arc Canvas before applying', ERR_VALIDATION);
  }

  // 1) Bible — top-level series fields the Arc Canvas sidebar reads. These are
  //    not lock-gated individually (only `locked.arc` exists, checked above).
  const biblePatch = {};
  if (typeof bible?.logline === 'string') biblePatch.logline = bible.logline;
  if (typeof bible?.premise === 'string') biblePatch.premise = bible.premise;
  if (Number.isFinite(bible?.issueCountTarget)) biblePatch.issueCountTarget = bible.issueCountTarget;
  if (Object.keys(biblePatch).length) await updateSeries(seriesId, biblePatch);

  // 2) Build the single target volume, reusing the lowest-numbered existing
  //    season's id so its child issues don't need re-homing. sanitizeSeason
  //    mints a fresh sea-uuid when `id` is undefined (no seasons yet).
  const existingSeasons = (Array.isArray(series.seasons) ? series.seasons : [])
    .slice()
    .sort((a, b) => (a.number || 0) - (b.number || 0));
  const keep = existingSeasons[0] || null;
  const existingIssues = await listIssues({ seriesId });
  const targetSeason = sanitizeSeason({
    id: keep?.id,
    number: 1,
    title: volume?.title || series.name || 'Volume 1',
    logline: volume?.logline || '',
    synopsis: volume?.synopsis || '',
    episodeCountTarget: existingIssues.length,
    status: keep?.status || 'draft',
    locked: keep?.locked === true,
  });

  // 3) Persist arc + the single season (drops the others; honors locks +
  //    migrates orphans). Re-read first so we merge against the bible write.
  const sanitizedArc = sanitizeArc({ ...(arc || {}), status: 'draft' });
  const latest = await getSeries(seriesId);
  const { series: afterSeasons } = await commitSeasonsWithRemap(latest, { arc: sanitizedArc, seasons: [targetSeason] });

  // A locked NON-target season survives commitSeasonsWithRemap (mergeSeasonsWithLocks
  // re-inserts it). Pinning its issues onto the target volume would empty a locked
  // volume — the exact destructive move deleteSeason / bulkReassignSeason refuse.
  // So leave a locked survivor's issues where they are (deleteSeason's contract).
  const lockedSurvivorIds = new Set(
    (afterSeasons?.seasons || [])
      .filter((s) => s.locked === true && s.id !== targetSeason.id)
      .map((s) => s.id),
  );

  // 4) Pin every issue onto the single volume and apply per-issue edits.
  const editsById = new Map((Array.isArray(issues) ? issues : []).map((e) => [e.id, e]));
  await withReexportSuppressed('series', seriesId, async () => {
    for (const iss of existingIssues) {
      // `iss.seasonId` is the pre-collapse season; a locked survivor keeps its id
      // (and its issues weren't remapped), so this skip is correct against either
      // the stale or fresh view.
      if (!lockedSurvivorIds.has(iss.seasonId) && iss.seasonId !== targetSeason.id) {
        await updateIssue(iss.id, { seasonId: targetSeason.id }, { skipRenumber: true });
      }
      const edit = editsById.get(iss.id);
      if (edit?.title && typeof edit.title === 'string' && edit.title.trim() && edit.title.trim() !== iss.title) {
        await updateIssue(iss.id, { title: edit.title.trim() }, { skipRenumber: true });
      }
      if (edit?.synopsis) await seedIssueSynopsis(iss.id, edit.synopsis);
    }
    await recomputeIssueNumbersForSeries(seriesId);
  });
  emitRecordUpdated('series', seriesId);

  const updated = await getSeries(seriesId);
  return { series: updated, volumeId: targetSeason.id, issueCount: existingIssues.length };
}
