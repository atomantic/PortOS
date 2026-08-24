/**
 * arcPlanner/arcCore.js — the arc overview / reader-map / refine / verify /
 * resolve / commit cluster.
 *
 * These passes are mutually recursive (overview ↔ resolve ↔ commit, verify ↔
 * volume-verify) and can't be cleanly separated, so they share one module.
 * Built on the leaf helpers in ./context.js.
 */

import { runStagedLLM } from '../../stageRunner.js';
import { ServerError } from '../../../lib/errorHandler.js';
import { stripAnsi } from '../../../lib/ansiStrip.js';
import { ARC_LOCKABLE_FIELDS, getSeries, updateSeries } from '../series.js';
import { listIssues, listIssuesForSeries, recomputeIssueNumbersForSeries, updateIssue, updateStageWithLatest, updateStagesWithLatest } from '../issues.js';
import { emitRecordUpdated, withReexportSuppressed } from '../../sharing/recordEvents.js';
import { getSeason } from '../seasons.js';
import { ARC_LIMITS, READER_MAP_BEAT_KINDS, buildSeason, cleanThemes, renderArcShapeGuidance, renderArcShapePositionSummary, sanitizeArc, sanitizeReaderMap, sanitizeSeason, sanitizeSeasonList } from '../../../lib/storyArc.js';
import { sanitizeCharacterArcList } from '../../../lib/seriesCharacterArc.js';
import { runPromptRefineRaw, trimChanges } from '../refineHelpers.js';
import { ERR_VALIDATION, SHAPE_GUIDANCE_NONE, appendTickingClock, buildArcBaseContext, buildArcOverviewContext, buildNeighborVolumes, buildReaderMapContext, buildResolveContext, buildVerifyContext, compareIssuesByPosition, findingIdSet, makeErr, matchIssueForEpisodeEdit, matchResolvedFindings, renderVolumeFields, renderVolumeIssue, resolveWorldContext, seasonIdByNumberOf, shapeEpisodeResolutions, shapeFindings, shapeSeasonOutlines, shapeVerifyIssues } from './context.js';

export async function generateArcOverview(seriesId, options = {}) {
  const series = await getSeries(seriesId);
  if (series.locked?.arc === true) {
    throw makeErr(
      'Arc is locked — unlock it on the Arc Canvas before regenerating',
      ERR_VALIDATION,
    );
  }
  const ctx = await buildArcOverviewContext(series);
  const { content, runId, providerId, model } = await runStagedLLM(
    'pipeline-arc-overview',
    ctx,
    {
      providerOverride: options.providerOverride,
      providerDefault: options.providerDefault,
      modelOverride: options.modelOverride,
      modelDefault: options.modelDefault,
      effortDefault: options.effortDefault,
      onRunCreated: options.onRunCreated,
      onRunSettled: options.onRunSettled,
      returnsJson: true,
      source: 'pipeline-arc-overview',
    },
  );
  // Build the canonical arc + seasons shape from the LLM payload. We send
  // both back to the caller so the route can persist in one updateSeries
  // call (or hand the user a preview before committing).
  // `shape` is the user's Vonnegut pick — the overview prompt doesn't ask
  // the LLM for it, so without this fallback a regenerate would wipe the
  // pick. Mirrors `resolveVerifyIssues` further down.
  const arc = sanitizeArc({
    logline: content?.logline || '',
    summary: content?.summary || '',
    themes: content?.themes,
    protagonistArc: content?.protagonistArc || '',
    shape: content?.shape ?? series.arc?.shape ?? null,
    // The arc-overview prompt doesn't author the reader map — preserve any
    // existing one (like `shape`) so regenerating the arc never silently wipes
    // a reader map the user already built on the next step.
    readerMap: series.arc?.readerMap ?? null,
    // Same for the ticking clock — the overview prompt doesn't author it, so
    // preserve any existing countdown across a regenerate.
    tickingClock: series.arc?.tickingClock ?? null,
    // The arc-overview prompt DOES author the foreshadowing ledger (#2172) —
    // take the LLM's if present, else preserve any existing one so a regenerate
    // that omits it doesn't silently wipe the seeds.
    foreshadowing: content?.foreshadowing ?? series.arc?.foreshadowing ?? null,
    status: 'draft',
  });
  const seasons = shapeSeasonOutlines(content?.seasonOutlines);
  return {
    arc,
    seasons,
    raw: content,
    runId,
    providerId,
    model,
  };
}

// The reader map is authored AFTER the plot arc is approved, so a frozen arc
// (`locked.arc`, which protects the core arc fields from the arc-overview
// regenerator) must NOT block reader-map work — only the reader-map field lock
// (`locked.arcFields.readerMap`) does. The locked arc is read as INPUT here.
export function assertReaderMapUnlocked(series) {
  if (series.locked?.arcFields?.readerMap === true) {
    throw makeErr('Reader map is locked — unlock it before regenerating', ERR_VALIDATION);
  }
}

/**
 * Generate the reader map (audience experience roadmap) from the series arc.
 * Extraction-only like generateArcOverview — returns the sanitized readerMap;
 * the caller persists it by merging into `series.arc` (preserving the other
 * arc fields) via updateSeries.
 */
export async function generateReaderMap(seriesId, options = {}) {
  const series = await getSeries(seriesId);
  assertReaderMapUnlocked(series);
  const ctx = await buildReaderMapContext(series);
  const { content, runId, providerId, model } = await runStagedLLM(
    'story-builder-reader-map',
    ctx,
    {
      providerOverride: options.providerOverride,
      providerDefault: options.providerDefault,
      modelOverride: options.modelOverride,
      modelDefault: options.modelDefault,
      effortDefault: options.effortDefault,
      onRunCreated: options.onRunCreated,
      onRunSettled: options.onRunSettled,
      returnsJson: true,
      source: 'story-builder-reader-map',
    },
  );
  const readerMap = sanitizeReaderMap({
    hooks: content?.hooks,
    payoffs: content?.payoffs,
    beats: content?.beats,
    cliffhangers: content?.cliffhangers,
    status: 'draft',
  });
  // A null sanitize means the LLM returned nothing usable — surface an error
  // rather than letting the caller persist `readerMap: null` over an existing
  // map (silent data loss).
  if (!readerMap) {
    throw makeErr('LLM returned an empty reader map — try regenerating', ERR_VALIDATION);
  }
  return { readerMap, raw: content, runId, providerId, model };
}

/**
 * Refine an existing reader map against free-text feedback (the same AI-
 * feedback affordance as image-prompt refine). Returns the regenerated
 * readerMap plus `changes` (a short bullet list) and `rationale`.
 */
export async function refineReaderMap(seriesId, feedback, options = {}) {
  const series = await getSeries(seriesId);
  assertReaderMapUnlocked(series);
  const arc = series.arc || {};
  const { content, rationale, runId, providerId, model } = await runPromptRefineRaw({
    templateName: 'story-builder-reader-map-refine',
    variables: {
      currentReaderMapJson: arc.readerMap ? JSON.stringify(arc.readerMap, null, 2) : '{}',
      feedback: typeof feedback === 'string' ? feedback.trim().slice(0, 4000) : '',
      arcSummary: arc.summary || '',
      protagonistArc: arc.protagonistArc || '',
      shapeGuidance: appendTickingClock(renderArcShapeGuidance(arc.shape) || SHAPE_GUIDANCE_NONE, arc),
      beatKindsCsv: READER_MAP_BEAT_KINDS.join(', '),
    },
    options,
    source: 'story-builder-reader-map-refine',
    logTag: `Story Builder reader-map refine series=${seriesId.slice(0, 8)}`,
  });
  const readerMap = sanitizeReaderMap({ ...content, status: 'draft' });
  // Refine is meant to PRESERVE — never let an empty LLM payload null out the
  // existing map. Fall back to the current reader map when the refine produced
  // nothing usable (mirrors the AGENTS.md absent-vs-empty rule).
  const safeReaderMap = readerMap || arc.readerMap || null;
  if (!safeReaderMap) {
    throw makeErr('LLM returned an empty reader map and there is none to preserve', ERR_VALIDATION);
  }
  // When the refine produced nothing usable and we fell back to the existing
  // map, the LLM's `changes`/`rationale` describe an attempt that was DISCARDED
  // — surfacing them would tell the user we applied edits we threw away. Only
  // report changes/rationale when the refined map is the one we're returning.
  const usedRefinedMap = readerMap != null;
  return {
    readerMap: safeReaderMap,
    changes: usedRefinedMap ? trimChanges(content.changes) : [],
    rationale: usedRefinedMap ? rationale : '',
    runId,
    providerId,
    model,
  };
}

/**
 * Refine an existing plot arc's NARRATIVE fields (logline / summary /
 * protagonist arc / themes) against free-text feedback — the AI-feedback
 * affordance the arc step lacked (it only had full regenerate). Deliberately
 * does NOT re-plan seasons or change the Vonnegut shape: the refine prompt
 * authors only the narrative fields, and `shape`/`readerMap` are carried over
 * from the current arc. Returns the merged arc plus `changes` + `rationale`.
 *
 * Honors the absent-vs-intentionally-empty rule: a field the LLM omits or
 * returns empty falls back to the current value (refine PRESERVES; it must
 * never null out an arc the user already has). The same `locked.arc` guard the
 * arc-overview regenerator uses applies.
 */
export async function refineArc(seriesId, feedback, options = {}) {
  const series = await getSeries(seriesId);
  if (series.locked?.arc === true) {
    throw makeErr('Arc is locked — unlock it on the Arc Canvas before refining', ERR_VALIDATION);
  }
  const arc = series.arc || {};
  const { content, rationale, runId, providerId, model } = await runPromptRefineRaw({
    templateName: 'story-builder-arc-refine',
    variables: {
      currentLogline: arc.logline || '',
      currentSummary: arc.summary || '',
      currentProtagonistArc: arc.protagonistArc || '',
      currentThemesCsv: Array.isArray(arc.themes) ? arc.themes.join(', ') : '',
      shapeGuidance: appendTickingClock(renderArcShapeGuidance(arc.shape) || SHAPE_GUIDANCE_NONE, arc),
      series: { name: series.name, premise: series.premise },
      feedback: typeof feedback === 'string' ? feedback.trim().slice(0, 4000) : '',
    },
    options,
    source: 'story-builder-arc-refine',
    logTag: `Story Builder arc refine series=${seriesId.slice(0, 8)}`,
  });
  // Merge the refined narrative fields over the current arc, preserving any the
  // LLM omitted (absent) or returned empty (a refine should never blank a field
  // the user already had). `shape`, `readerMap`, and status pass through from
  // the current arc — this pass is narrative-only. sanitizeArc trims/cleans the
  // fields (incl. themes) on the way in, so pass raw values and only choose
  // between the refined value and the current one here.
  const refinedStr = (next, current) => {
    const trimmed = typeof next === 'string' ? next.trim() : '';
    return trimmed || current || '';
  };
  // Clean the candidate themes BEFORE deciding to keep them: an LLM array of
  // only blanks/nulls (`['  ']`, `[null]`) is non-empty but sanitizes to [],
  // which would wipe the existing themes. Fall back to current when the cleaned
  // candidate is empty (preserve, per the absent-vs-empty rule).
  const cleanedCandidateThemes = cleanThemes(content.themes);
  const refinedThemes = cleanedCandidateThemes.length > 0
    ? cleanedCandidateThemes
    : (arc.themes || []);
  const refinedArc = sanitizeArc({
    logline: refinedStr(content.logline, arc.logline),
    summary: refinedStr(content.summary, arc.summary),
    protagonistArc: refinedStr(content.protagonistArc, arc.protagonistArc),
    themes: refinedThemes,
    shape: arc.shape ?? null,
    readerMap: arc.readerMap ?? null,
    // The arc-refine prompt edits the narrative fields only — preserve the
    // ticking clock (like readerMap/shape) so a refine never wipes it.
    tickingClock: arc.tickingClock ?? null,
    // Same for the foreshadowing ledger — a narrative refine must not wipe it.
    foreshadowing: arc.foreshadowing ?? null,
    status: 'draft',
  });
  // sanitizeArc returns null only when every identifying field is empty — which,
  // because every field above falls back to the current arc, means the current
  // arc was ALSO empty and the LLM added nothing. Nothing to preserve, so error.
  if (!refinedArc) {
    throw makeErr('LLM returned an empty arc and there is none to preserve', ERR_VALIDATION);
  }
  return { arc: refinedArc, changes: trimChanges(content.changes), rationale, runId, providerId, model };
}

export async function verifyArc(seriesId, options = {}) {
  const series = await getSeries(seriesId);
  if (!series.arc) {
    throw new ServerError(
      'Series has no arc to verify — run /arc/generate first',
      { status: 400, code: 'PIPELINE_NO_ARC' },
    );
  }
  const ctx = await buildVerifyContext(series, options.preloadedWorld, { spineOnly: options.spineOnly === true });
  const { content, runId, providerId, model } = await runStagedLLM(
    'pipeline-arc-verify',
    ctx,
    {
      providerOverride: options.providerOverride,
      providerDefault: options.providerDefault,
      modelOverride: options.modelOverride,
      modelDefault: options.modelDefault,
      effortDefault: options.effortDefault,
      onRunCreated: options.onRunCreated,
      onRunSettled: options.onRunSettled,
      returnsJson: true,
      source: 'pipeline-arc-verify',
    },
  );
  const issues = shapeVerifyIssues(content?.issues);
  return { issues, raw: content, runId, providerId, model };
}

export async function buildVolumeVerifyContext(series, season, preloadedWorld, { synopsisOnly = false } = {}) {
  const [allIssues, base] = await Promise.all([
    listIssues({ seriesId: series.id }),
    buildArcBaseContext(series, preloadedWorld),
  ]);
  const volumeIssues = allIssues
    .filter((iss) => iss.seasonId === season.id)
    .sort(compareIssuesByPosition)
    .map((issue) => renderVolumeIssue(issue, { synopsisOnly }));
  // Volume-specific curve placement layered on top of base's arc-wide
  // shapeGuidance so the verifier can flag "this volume inverts the expected
  // fortune at its position."
  const totalSeasons = (series.seasons || []).length || 1;
  const volumeShapePosition = renderArcShapePositionSummary(series.arc?.shape, season.number, totalSeasons)
    || '(no story shape selected — do not flag shape adherence for this volume)';
  return {
    ...base,
    volume: renderVolumeFields(season),
    volumeShapePosition,
    neighborsJson: JSON.stringify(buildNeighborVolumes(series.seasons, season.id), null, 2),
    volumeIssuesJson: JSON.stringify(volumeIssues, null, 2),
  };
}

// Verify a single volume / season — the deeper, narrower counterpart to
// verifyArc. The cross-volume pass operates at synopsis depth across the
// whole arc; this pass operates at beat depth (when beats exist) across one
// volume. Issues without beats are checked at synopsis depth — the prompt
// is explicitly aware of which depth each issue is at, so a partially-
// expanded volume can still be validated mid-workflow.
export async function verifyVolume(seriesId, seasonId, options = {}) {
  const series = await getSeries(seriesId);
  if (!series.arc) {
    throw new ServerError(
      'Series has no arc — run /arc/generate first before verifying a volume',
      { status: 400, code: 'PIPELINE_NO_ARC' },
    );
  }
  const season = await getSeason(seriesId, seasonId);
  const ctx = await buildVolumeVerifyContext(series, season, options.preloadedWorld, {
    synopsisOnly: options.synopsisOnly === true,
  });
  const { content, runId, providerId, model } = await runStagedLLM(
    'pipeline-volume-verify',
    ctx,
    {
      providerOverride: options.providerOverride,
      providerDefault: options.providerDefault,
      modelOverride: options.modelOverride,
      modelDefault: options.modelDefault,
      effortDefault: options.effortDefault,
      onRunCreated: options.onRunCreated,
      onRunSettled: options.onRunSettled,
      returnsJson: true,
      source: 'pipeline-volume-verify',
    },
  );
  const issues = shapeVerifyIssues(content?.issues);
  return { issues, raw: content, runId, providerId, model, seasonId };
}

/**
 * Split one auto-resolve response into the edits that actually name a finding
 * the round was handed, and the ones to drop (#3724). Pure.
 *
 * Every entry in `arc` / `characterArcs[]` / `seasons[]` / `episodes[]` has to carry
 * `resolves: ["f2", …]` naming at least one input finding — an edit that names
 * none can't be closing anything, so applying it is all blast radius and no
 * benefit. Returns `{ legacy, arc, arcDropped, characterArcs,
 * characterArcsDropped, seasons, seasonsDropped, episodes, episodesDropped,
 * episodesOutOfScope }`.
 *
 * `spineOnly` drops every episode edit regardless of what it names (#3789): a
 * spine round is judged against an episode-empty plan, so an episode rewrite
 * cannot close the finding it declares — it only mutates records the gate never
 * read. Counted separately from `episodesDropped` because the two are different
 * diagnoses (wrong scope vs. named no finding), and enforced here rather than
 * trusting the prompt alone so a customized/stale installed template can't
 * re-open the blast radius.
 *
 * `legacy` is the escape hatch for an install whose `pipeline-arc-resolve.md`
 * was customized before #3724 and therefore never got the migration: when NOT
 * ONE entry in the whole response declares a `resolves` array, the model is
 * plainly running the old contract, and dropping everything would silently turn
 * auto-resolve into a no-op that burns a round per pass. Those responses are
 * applied unkeyed (still as a sparse patch, which is strictly safer than the
 * old full-list rewrite) and logged. A response that keys SOME of its edits is
 * on the new contract, so its unkeyed entries are genuine drops.
 */
export function selectFindingKeyedEdits(content, findings, { spineOnly = false } = {}) {
  const validIds = findingIdSet(findings);
  const isEdit = (e) => !!e && typeof e === 'object';
  const arcEdit = isEdit(content?.arc) ? content.arc : null;
  const characterArcsRaw = (Array.isArray(content?.characterArcs) ? content.characterArcs : []).filter(isEdit);
  const seasonsRaw = (Array.isArray(content?.seasons) ? content.seasons : []).filter(isEdit);
  const episodesRaw = (Array.isArray(content?.episodes) ? content.episodes : []).filter(isEdit);
  const legacy = ![arcEdit, ...characterArcsRaw, ...seasonsRaw, ...episodesRaw]
    .some((e) => e && matchResolvedFindings(e, validIds).declared);
  const targeted = (raw) => legacy || matchResolvedFindings(raw, validIds).matched.length > 0;
  const characterArcs = characterArcsRaw.filter(targeted);
  const seasons = seasonsRaw.filter(targeted);
  const episodes = spineOnly ? [] : episodesRaw.filter(targeted);
  return {
    legacy,
    arc: arcEdit && targeted(arcEdit) ? arcEdit : null,
    arcDropped: !!arcEdit && !targeted(arcEdit),
    characterArcs,
    characterArcsDropped: characterArcsRaw.length - characterArcs.length,
    seasons,
    seasonsDropped: seasonsRaw.length - seasons.length,
    episodes,
    episodesDropped: spineOnly ? 0 : episodesRaw.length - episodes.length,
    episodesOutOfScope: spineOnly ? episodesRaw.length : 0,
  };
}

const characterArcKey = (arc) => {
  const characterId = typeof arc?.characterId === 'string' ? arc.characterId.trim() : '';
  if (characterId) return `id:${characterId}`;
  const characterName = typeof arc?.characterName === 'string' ? arc.characterName.trim().toLowerCase() : '';
  return characterName ? `name:${characterName}` : '';
};

const CHARACTER_ARC_PATCH_FIELDS = Object.freeze([
  'want', 'need', 'startState', 'endState', 'status',
]);
const TRANSITION_PATCH_FIELDS = Object.freeze([
  'kind', 'label', 'atIssue', 'atSceneAnchor', 'note',
]);

/**
 * Apply finding-keyed per-character arc edits as sparse patches. Existing
 * character and transition identifiers are required and preserved: an arc
 * verifier finding must never mint a new cast arc or replace every transition
 * merely because the model corrected one milestone.
 */
export function mergeCharacterArcPatches(existingArcs, patches) {
  const current = sanitizeCharacterArcList(existingArcs);
  if (!Array.isArray(patches) || patches.length === 0) return current;
  const patchByKey = new Map(patches.map((patch) => [characterArcKey(patch), patch]).filter(([key]) => key));
  const merged = current.map((arc) => {
    const patch = patchByKey.get(characterArcKey(arc));
    if (!patch) return arc;
    const next = { ...arc };
    for (const field of CHARACTER_ARC_PATCH_FIELDS) {
      if (field in patch) next[field] = patch[field];
    }
    if (Array.isArray(patch.transitions)) {
      const transitionPatches = new Map(patch.transitions
        .filter((transition) => transition && typeof transition === 'object' && typeof transition.id === 'string')
        .map((transition) => [transition.id, transition]));
      next.transitions = arc.transitions.flatMap((transition) => {
        const transitionPatch = transitionPatches.get(transition.id);
        if (!transitionPatch) return [transition];
        if (transitionPatch.delete === true) return [];
        const updated = { ...transition };
        for (const field of TRANSITION_PATCH_FIELDS) {
          if (field in transitionPatch) updated[field] = transitionPatch[field];
        }
        return [updated];
      });
    }
    return next;
  });
  return sanitizeCharacterArcList(merged);
}

const EXACT_TEXT_PATCH_MODE = 'exact-text-v1';
const EXACT_TEXT_EDITS_MAX = 12;

/**
 * Apply bounded exact-match replacements to one persisted long-form field.
 *
 * Arc verification findings are usually sentence-local, but `synopsis` and
 * `summary` are monolithic strings. Asking the resolver to return either field
 * wholesale gave a one-sentence repair thousands of unrelated words of blast
 * radius, and an over-limit rewrite could then be truncated mid-sentence by the
 * canonical sanitizer. Exact replacements keep the untouched text byte-for-byte
 * stable. Ambiguous/missing anchors and over-limit results are skipped rather
 * than guessed at; the next verification round will leave the original finding
 * visible instead of persisting a speculative rewrite.
 */
export function applyExactTextEdits(current, rawEdits, maxLength) {
  const original = typeof current === 'string' ? current : '';
  if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
    return { value: original, applied: 0, rejected: 0 };
  }
  let value = original;
  let applied = 0;
  let rejected = 0;
  for (const raw of rawEdits.slice(0, EXACT_TEXT_EDITS_MAX)) {
    const find = typeof raw?.find === 'string' ? raw.find : '';
    const replacement = typeof raw?.replace === 'string' ? raw.replace : null;
    const first = find ? value.indexOf(find) : -1;
    const duplicate = first >= 0 && value.indexOf(find, first + find.length) >= 0;
    const replacesWholeLongField = find.length === value.length
      && maxLength > ARC_LIMITS.SEASON_ENDING_HOOK_MAX;
    if (!find || replacement == null || first < 0 || duplicate || replacesWholeLongField) {
      rejected += 1;
      continue;
    }
    const candidate = `${value.slice(0, first)}${replacement}${value.slice(first + find.length)}`;
    if (candidate.length > maxLength) {
      rejected += 1;
      continue;
    }
    value = candidate;
    applied += 1;
  }
  rejected += Math.max(0, rawEdits.length - EXACT_TEXT_EDITS_MAX);
  return { value, applied, rejected };
}

// Two stored values are the same edit-wise. `undefined` and `null` are one
// value here: an omitted field and an explicit null both mean "no change I can
// count", and the appliers treat them identically.
const sameStored = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// The fields a resolve response can change on the arc / on a volume — the same
// surface the two appliers below spread (`sanitizeArc` at the arc, the season
// patch inside `resolveVerifyIssues`), restated here because those do per-field
// coercion rather than list iteration. THEY MOVE TOGETHER: a newly patchable
// field the appliers accept but this list omits is a change the isolated bound
// cannot see. Long prose is paired `[direct, editsKey, limit]` because under
// `exact-text-v1` it lands ONLY through the `*Edits` array and a
// directly-returned string is ignored (and vice versa) — counting the ignored
// spelling would reject a candidate over an edit that was never going to be
// persisted.
const ARC_SHORT_FIELDS = Object.freeze(['logline', 'themes', 'shape', 'foreshadowing']);
const ARC_LONG_FIELDS = Object.freeze([
  ['summary', 'summaryEdits', ARC_LIMITS.SUMMARY_MAX],
  ['protagonistArc', 'protagonistArcEdits', ARC_LIMITS.PROTAGONIST_ARC_MAX],
]);
const SEASON_SHORT_FIELDS = Object.freeze(['title', 'number', 'logline', 'episodeCountTarget', 'themes']);
const SEASON_LONG_FIELDS = Object.freeze([
  ['synopsis', 'synopsisEdits', ARC_LIMITS.SEASON_SYNOPSIS_MAX],
  ['endingHook', 'endingHookEdits', ARC_LIMITS.SEASON_ENDING_HOOK_MAX],
]);

// ---------------------------------------------------------------------------
// Resolve-outcome accounting (#3843). `applied` says a pass wrote SOMETHING; it
// never said what, and the gate's telemetry reported only `episodesEdited` — a
// count the arc-SPINE resolver can never move, because that altitude may not
// touch episodes at all. A spine round that rewrote the arc and two volumes and
// took the blocking set from 5 to 2 therefore reported `episodesEdited: 0`,
// indistinguishable from a round that wrote nothing. These supply the missing
// halves: per-record counts of what landed, and a categorical reason when
// nothing did. Numbers and enum values only — it rides into the retained
// diagnosis log, which must never carry manuscript text or resolver prose.
// ---------------------------------------------------------------------------

// The arc surface a resolve pass can rewrite — derived from the two lists the
// isolated-candidate bound already keeps in step with the appliers, so a newly
// patchable field is counted the moment it is accepted rather than after
// someone remembers a third list. `readerMap` / `tickingClock` / `status` are
// absent by construction: the resolver never authors them.
const RESOLVE_ARC_FIELDS = Object.freeze([...ARC_SHORT_FIELDS, ...ARC_LONG_FIELDS.map(([direct]) => direct)]);

const changedFieldCount = (next, prev, fields) => fields
  .filter((field) => !sameStored(next?.[field], prev?.[field])).length;

// Entries in `next` that match no entry in `prev` — i.e. minted or rewritten.
// Deletion is not reachable on either list this counts (volumes ride through as
// a sparse patch, character arcs merge in place), so added/changed is a complete
// account of the pass's writes.
const changedEntryCount = (next, prev) => {
  const before = new Set((prev || []).map((entry) => JSON.stringify(entry)));
  return (next || []).filter((entry) => !before.has(JSON.stringify(entry))).length;
};

const NO_MUTATIONS = Object.freeze({
  arcFieldsEdited: 0, volumesEdited: 0, characterArcsEdited: 0, episodesEdited: 0,
});

/**
 * Why a resolve pass wrote nothing, as ONE of these values. Categorical so the
 * stall diagnosis can separate the cases it kept conflating: the resolver
 * answered but its anchors no longer matched (`exact-edits-rejected`), it
 * answered at an altitude this gate forbids (`edits-out-of-scope`), or it
 * declined to propose anything at all (`no-edits-returned`) — a content-level
 * refusal no amount of extra rounds will fix. Exported because the diagnosis
 * prompts have to explain every value they can be handed; the contract test in
 * `arcPlanner.test.js` fails when a value is missing from that legend.
 */
export const RESOLVE_NO_CHANGE_REASONS = Object.freeze([
  'no-findings',
  'isolated-candidate-rejected',
  'exact-edits-rejected',
  'edits-matched-existing',
  'edits-out-of-scope',
  'edits-named-no-finding',
  'no-edits-returned',
]);

const noChangeReasonFor = (edits, rejectedExactEdits) => {
  if (rejectedExactEdits > 0) return 'exact-edits-rejected';
  const proposed = (edits.arc ? 1 : 0) + edits.characterArcs.length + edits.seasons.length + edits.episodes.length;
  // Something survived selection and was applied, yet the store did not move:
  // the resolver re-authored text the plan already held.
  if (proposed > 0) return 'edits-matched-existing';
  if (edits.episodesOutOfScope > 0) return 'edits-out-of-scope';
  const dropped = (edits.arcDropped ? 1 : 0) + edits.characterArcsDropped + edits.seasonsDropped + edits.episodesDropped;
  if (dropped > 0) return 'edits-named-no-finding';
  return 'no-edits-returned';
};

// How many stored values a patch would actually change. Echoed fields that
// already match the record do not count: the resolve prompt asks for `id` and
// `number` to be repeated, so "field present" is not "field changed". Exact-text
// replacements are counted by running the real applier — one `{find, replace}`
// pair is one causal change, and an anchor `applyExactTextEdits` would reject
// (missing, ambiguous, over-limit) is none, so the count is the patch's
// persisted effect rather than the size of what the model asked for.
function countFieldChanges(patch, current, { shortFields, longFields = [], exactTextMode = false }) {
  let changes = 0;
  for (const field of shortFields) {
    if (patch?.[field] === undefined) continue;
    if (!sameStored(patch[field], current?.[field])) changes += 1;
  }
  for (const [direct, editsKey, limit] of longFields) {
    if (exactTextMode) {
      changes += applyExactTextEdits(current?.[direct] || '', patch?.[editsKey], limit).applied;
    } else if (typeof patch?.[direct] === 'string' && !sameStored(patch[direct], current?.[direct] ?? '')) {
      changes += 1;
    }
  }
  return changes;
}

// Same accounting one altitude down, for a per-character arc patch: changed
// top-level fields plus ONE per patched existing transition (a transition is the
// causal unit — correcting its label and its issue anchor together is one
// milestone repair). Transitions the merge would discard anyway (no `id`, or an
// id no stored transition carries) are not changes.
function countCharacterArcChanges(patch, current) {
  let changes = countFieldChanges(patch, current, { shortFields: CHARACTER_ARC_PATCH_FIELDS });
  const byId = new Map((current?.transitions || []).map((t) => [t.id, t]));
  for (const raw of (Array.isArray(patch?.transitions) ? patch.transitions : [])) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') continue;
    const existing = byId.get(raw.id);
    if (!existing) continue;
    if (raw.delete === true) { changes += 1; continue; }
    if (TRANSITION_PATCH_FIELDS.some((f) => raw[f] !== undefined && !sameStored(raw[f], existing[f]))) changes += 1;
  }
  return changes;
}

/**
 * Decide whether an isolated (single-finding) resolve candidate is bounded
 * enough to persist. Pure. Returns a short rejection reason, or null when the
 * candidate is exactly ONE causal patch: one owner record, one changed field on
 * it — one exact-text replacement, one short scalar, or one existing
 * character-transition patch.
 *
 * This is what makes the arc gate's per-finding fallback (#3780) bounded.
 * Isolating the FINDING never isolated the EDIT: every entry in a single-finding
 * response trivially names that finding, so `selectFindingKeyedEdits` passed
 * whole-arc rewrites and each "isolated" attempt regressed the blocking set
 * exactly like the whole-set pass it escalated from.
 *
 * Checked BEFORE anything is written, so an over-reaching candidate costs its
 * own resolve call and nothing else: no rewrite to undo, and no verification
 * round billed to discover that the rewrite was worse. The post-apply verifier
 * and rollback in the gate stay exactly as they are — this is a narrower net in
 * front of them, not a replacement for them.
 *
 * Counting is against the STORED record, not the response's shape: an echoed
 * `id`/`number`/title is not a change, and an edit the appliers would discard
 * (an unmatched character arc, a transition with no id, an unanchored exact-text
 * replacement, the ignored spelling of a long prose field) is not one either —
 * rejecting on those would fail candidates that were already going to be no-ops.
 */
export function isolatedCandidateRejection(edits, { exactTextMode = false, series = {}, matchedSeasons } = {}) {
  const touched = [];
  if (edits.arc) {
    const changes = countFieldChanges(edits.arc, series.arc || {}, {
      shortFields: ARC_SHORT_FIELDS, longFields: ARC_LONG_FIELDS, exactTextMode,
    });
    if (changes) touched.push({ label: 'the arc', changes });
  }
  if (edits.characterArcs.length) {
    const arcByKey = new Map(sanitizeCharacterArcList(series.characterArcs).map((a) => [characterArcKey(a), a]));
    for (const patch of edits.characterArcs) {
      // An unmatched key mints nothing (mergeCharacterArcPatches drops it), so
      // it is not a record this candidate touches.
      const existing = arcByKey.get(characterArcKey(patch));
      if (!existing) continue;
      const changes = countCharacterArcChanges(patch, existing);
      if (changes) touched.push({ label: `character arc ${existing.characterId || 'unkeyed'}`, changes });
    }
  }
  const matched = matchedSeasons || matchProposedSeasons(series.seasons, edits.seasons);
  for (let idx = 0; idx < edits.seasons.length; idx += 1) {
    const existing = matched[idx];
    // An unmatched volume proposal MINTS one. A new volume is never the minimal
    // causal patch for a single finding, and it is the one edit here that can't
    // be undone by putting a field back.
    if (!existing) return 'it would add a new volume instead of patching one';
    const changes = countFieldChanges(edits.seasons[idx], existing, {
      shortFields: SEASON_SHORT_FIELDS, longFields: SEASON_LONG_FIELDS, exactTextMode,
    });
    if (changes) touched.push({ label: `volume ${existing.number ?? '?'}`, changes });
  }
  // Shaped by the applier's own admission rule, so an entry `applyEpisodeResolutions`
  // would drop (no integer episode number, past its cap) is not counted as a
  // record this candidate touches.
  for (const episode of shapeEpisodeResolutions(edits.episodes)) {
    touched.push({ label: `episode ${episode.episodeNumber}`, changes: 1 });
  }
  if (touched.length === 0) return 'it changed nothing this gate would persist';
  if (touched.length > 1) {
    return `it edits ${touched.length} records (${touched.map((t) => t.label).join(', ')}) — an isolated repair may change only one`;
  }
  const [only] = touched;
  if (only.changes > 1) {
    return `it changes ${only.changes} fields on ${only.label} — an isolated repair may change only one`;
  }
  return null;
}


// Character arcs are patched in place by existing IDs; episode (issue) records
// are never CREATED or DELETED here, and their drafted scripts are never
// clobbered — a full-arc round may rewrite an episode's planning synopsis (see
// `applyEpisodeResolutions`), and nothing else. If a
// finding's only actionable resolution would require deleting issues, the LLM
// is told to flag that in the response's `notes` field rather than executing it.
// `options.findings` empty / omitted = re-run verify first and resolve
// everything it returns. `options.avoid` is the optional "a previous attempt at
// these same findings authored THESE and was reverted" list (see
// buildResolveContext) — set only by a corrective pass.
// `options.spineOnly` mirrors verifyArc's pre-episode arc-spine mode: the
// resolver sees the same episode-empty plan and may only patch the series arc,
// per-character arcs, and volumes (#3789). It is a PAIRING constraint, not an independent knob — it
// must match the verify that produced `options.findings`, or the resolver
// answers at an altitude the gate never judged. Episode-synopsis corrections
// stay available for the later full arc gate, which runs after episodes exist
// and actually judges them.
export async function resolveVerifyIssues(seriesId, options = {}) {
  const spineOnly = options.spineOnly === true;
  const isolated = options.isolated === true;
  const series = await getSeries(seriesId);
  if (!series.arc) {
    throw new ServerError(
      'Series has no arc to resolve — run /arc/generate first',
      { status: 400, code: 'PIPELINE_NO_ARC' },
    );
  }
  // Resolve rewrites arc + seasons in place, so the lock gates this too.
  // Verify (read-only) stays enabled — the user can act on findings manually.
  if (series.locked?.arc === true) {
    throw new ServerError(
      'Arc is locked — unlock it before rewriting the arc',
      { status: 400, code: ERR_VALIDATION },
    );
  }

  // Load the world once and thread it through verify + resolve so the
  // refresh-then-resolve path doesn't hit the filesystem twice for the same
  // world.
  const world = await resolveWorldContext(series);

  let findings = shapeFindings(options.findings);
  if (!findings.length) {
    // The spread is load-bearing: it carries `spineOnly` into the refresh, which
    // is the one path where the verify and the resolve it feeds are the same
    // call and so must not drift apart in altitude.
    const fresh = await verifyArc(seriesId, { ...options, preloadedWorld: world });
    findings = fresh.issues || [];
    if (!findings.length) {
      return {
        series,
        applied: false,
        notes: 'No findings to resolve',
        findings: [],
        mutations: NO_MUTATIONS,
        noChangeReason: 'no-findings',
      };
    }
  }

  // `options.avoid` carries the findings a reverted earlier attempt at these
  // same findings authored, so a corrective pass is told what NOT to re-create
  // instead of re-running the identical prompt and regressing identically.
  const ctx = await buildResolveContext(series, findings, world, { avoid: options.avoid, spineOnly, isolated });
  const { content, runId, providerId, model } = await runStagedLLM(
    'pipeline-arc-resolve',
    ctx,
    {
      providerOverride: options.providerOverride,
      providerDefault: options.providerDefault,
      modelOverride: options.modelOverride,
      modelDefault: options.modelDefault,
      effortDefault: options.effortDefault,
      onRunCreated: options.onRunCreated,
      onRunSettled: options.onRunSettled,
      returnsJson: true,
      source: 'pipeline-arc-resolve',
    },
  );

  // Keep only the edits that name a finding this round was handed (#3724). An
  // untargeted rewrite is pure blast radius: it can't close anything, and every
  // volume it touches is a chance to author the contradiction the next verify
  // files as a brand-new blocker.
  const edits = selectFindingKeyedEdits(content, findings, { spineOnly });
  const exactTextMode = content?.patchMode === EXACT_TEXT_PATCH_MODE;
  // Only worth saying when there is actually something to apply unkeyed — a
  // response that proposed NO edits reads as legacy too, and warning about a
  // stale prompt there would be a lie.
  if (edits.legacy && (edits.arc || edits.characterArcs.length || edits.seasons.length || edits.episodes.length)) {
    console.log(`⚠️ arc-resolve: response carries no resolves[] — applying it unkeyed (installed pipeline-arc-resolve.md predates #3724)`);
  }
  if (edits.arcDropped) {
    console.log(`⚠️ arc-resolve: dropped the arc-level edit — it named no input finding`);
  }
  if (edits.characterArcsDropped || edits.seasonsDropped || edits.episodesDropped) {
    console.log(`⚠️ arc-resolve: dropped ${edits.characterArcsDropped} character arc + ${edits.seasonsDropped} volume + ${edits.episodesDropped} episode edit(s) naming no input finding`);
  }
  if (edits.episodesOutOfScope) {
    console.log(`⚠️ arc-resolve: discarded ${edits.episodesOutOfScope} episode edit(s) — the arc-spine gate resolves at arc/volume scope only`);
  }

  // What every return below carries regardless of whether the candidate landed.
  const runMeta = {
    notes: typeof content?.notes === 'string' ? content.notes.trim().slice(0, 2000) : '',
    findings,
    runId,
    providerId,
    model,
  };

  // Which existing volume each proposal rewrites. Resolved once: the isolated
  // check needs it to tell a patch from a mint, and the season merge below needs
  // the same answer.
  const matchedExisting = matchProposedSeasons(series.seasons, edits.seasons);

  // The isolated fallback's candidate is judged BEFORE anything is written: a
  // candidate that spans records or fields is discarded whole, so it costs its
  // own resolve call and neither a rewrite to undo nor a verification round to
  // discover the damage. Reported as a plain unapplied result — the shape the
  // gate already reads for "nothing was written" — with the bound it broke as
  // the reason. The post-apply verifier and rollback still judge everything that
  // DOES get through.
  const isolationRejected = isolated
    ? isolatedCandidateRejection(edits, { exactTextMode, series, matchedSeasons: matchedExisting })
    : null;
  if (isolationRejected) {
    console.log(`⚠️ arc-resolve: discarded an isolated repair candidate — ${isolationRejected}`);
    return {
      series,
      applied: false,
      reason: isolationRejected,
      patchMode: exactTextMode ? 'exact-text-v1' : null,
      rejectedExactEdits: 0,
      episodesResolved: [],
      mutations: NO_MUTATIONS,
      noChangeReason: 'isolated-candidate-rejected',
      ...runMeta,
    };
  }


  const arcSummary = exactTextMode
    ? applyExactTextEdits(series.arc.summary || '', edits.arc?.summaryEdits, ARC_LIMITS.SUMMARY_MAX)
    : { value: edits.arc?.summary || series.arc.summary || '', applied: 0, rejected: 0 };
  const protagonistArc = exactTextMode
    ? applyExactTextEdits(series.arc.protagonistArc || '', edits.arc?.protagonistArcEdits, ARC_LIMITS.PROTAGONIST_ARC_MAX)
    : { value: edits.arc?.protagonistArc ?? series.arc.protagonistArc ?? '', applied: 0, rejected: 0 };
  let rejectedExactEdits = arcSummary.rejected + protagonistArc.rejected;
  const arc = sanitizeArc({
    logline: edits.arc?.logline || series.arc.logline || '',
    summary: arcSummary.value,
    themes: edits.arc?.themes ?? series.arc.themes,
    protagonistArc: protagonistArc.value,
    shape: edits.arc?.shape ?? series.arc.shape ?? null,
    // The resolve prompt doesn't author the reader map — preserve any existing
    // one so auto-resolve never silently wipes a reader map the user already
    // built on the next step. Mirrors `generateArcOverview` above.
    readerMap: series.arc?.readerMap ?? null,
    // Same for the ticking clock — auto-resolve must not wipe the countdown.
    tickingClock: series.arc?.tickingClock ?? null,
    // The resolve prompt doesn't author the foreshadowing ledger — take it if
    // present, else preserve any existing one so auto-resolve never wipes it.
    foreshadowing: edits.arc?.foreshadowing ?? series.arc?.foreshadowing ?? null,
    status: 'draft',
  });

  // Round-trip the LLM's seasons through `buildSeason` if they include a
  // brand-new entry (no `id`), otherwise preserve the existing `id` so child
  // issues still join their season cleanly. The sanitizer enforces the
  // canonical shape regardless.
  //
  // `seasons[]` is a SPARSE PATCH LIST (#3724), not the full volume lineup: the
  // response carries only the volumes the resolver actually edited, and every
  // existing volume it left out rides through untouched below. That removes the
  // old "omit a volume and it is deleted" footgun — deletion is now an explicit
  // `notes` recommendation, matching how episode deletion already worked.
  const proposedSeasons = edits.seasons;
  // `matchedExisting` (resolved above) pairs each proposal with the existing
  // record it rewrites BEFORE minting. The resolve prompt frequently returns a
  // rewritten volume WITHOUT echoing its `id`; matching on id alone read that as
  // a brand-new season and minted one. With `preserveDroppedSeasons` on (the
  // autopilot's unlock-for-run mode) the original was then re-inserted alongside
  // the mint — so every auto-resolve round ADDED a duplicate "Volume 1" instead
  // of clearing a finding, and arc-verify could never converge. See the
  // divergence pause on 2026-08-09.
  // Patched rewrites keyed by the record they land on, plus the genuinely-new
  // volumes to append. Untouched existing volumes are carried through verbatim.
  const patchedById = new Map();
  const mintedSeasons = [];
  proposedSeasons.forEach((raw, idx) => {
    const existing = matchedExisting[idx];
    if (existing) {
      const synopsis = exactTextMode
        ? applyExactTextEdits(existing.synopsis || '', raw.synopsisEdits, ARC_LIMITS.SEASON_SYNOPSIS_MAX)
        : { value: typeof raw.synopsis === 'string' ? raw.synopsis : existing.synopsis, applied: 0, rejected: 0 };
      const endingHook = exactTextMode
        ? applyExactTextEdits(existing.endingHook || '', raw.endingHookEdits, ARC_LIMITS.SEASON_ENDING_HOOK_MAX)
        : { value: typeof raw.endingHook === 'string' ? raw.endingHook : existing.endingHook, applied: 0, rejected: 0 };
      if (synopsis.rejected || endingHook.rejected) {
        console.log(`⚠️ arc-resolve: skipped ${synopsis.rejected + endingHook.rejected} ambiguous or over-limit exact text edit(s) for volume ${existing.number}`);
      }
      rejectedExactEdits += synopsis.rejected + endingHook.rejected;
      patchedById.set(existing.id, sanitizeSeason({
        ...existing,
        title: typeof raw.title === 'string' ? raw.title : existing.title,
        number: Number.isFinite(raw.number) ? raw.number : existing.number,
        logline: typeof raw.logline === 'string' ? raw.logline : existing.logline,
        synopsis: synopsis.value,
        endingHook: endingHook.value,
        episodeCountTarget: Number.isFinite(raw.episodeCountTarget)
          ? raw.episodeCountTarget
          : existing.episodeCountTarget,
        themes: Array.isArray(raw.themes) ? raw.themes : existing.themes,
      }));
      return;
    }
    const minted = buildSeason({
      number: raw?.number,
      title: raw?.title,
      logline: raw?.logline,
      synopsis: raw?.synopsis,
      endingHook: raw?.endingHook,
      episodeCountTarget: raw?.episodeCountTarget,
    });
    if (minted) mintedSeasons.push(minted);
  });

  const seasons = sanitizeSeasonList([
    ...(series.seasons || []).map((s) => patchedById.get(s.id) || s),
    ...mintedSeasons,
  ]);

  // `preserveDroppedSeasons` (autopilot unlock-for-run) rides through so an
  // auto-resolve can rewrite a volume but never delete one — see the option's
  // contract on commitSeasonsWithRemap.
  const arcOrSeasonsChanged = JSON.stringify(arc) !== JSON.stringify(series.arc)
    || JSON.stringify(seasons) !== JSON.stringify(series.seasons || []);
  const { series: updated } = arcOrSeasonsChanged
    ? await commitSeasonsWithRemap(
      series,
      { arc, seasons },
      { preserveDroppedSeasons: options.preserveDroppedSeasons === true },
    )
    : { series };

  const characterArcs = mergeCharacterArcPatches(updated.characterArcs, edits.characterArcs);
  const characterArcsChanged = !sameStored(characterArcs, updated.characterArcs || []);
  const resolvedSeries = characterArcsChanged
    ? await updateSeries(seriesId, { characterArcs })
    : updated;

  // Apply any episode-level synopsis corrections the resolver returned. This is
  // the heal capability that lets episode-scoped findings converge: when a
  // contradiction originates inside one episode's planning synopsis (e.g. it
  // stages an event a later volume reserves as its own "first"), the only fix is
  // to rewrite that episode — the volume/arc layer can't make it go away. Done
  // here (after the arc+season commit) against the freshest issue set.
  const episodesResolved = await applyEpisodeResolutions(
    seriesId,
    resolvedSeries,
    shapeEpisodeResolutions(edits.episodes),
  );

  const episodesChanged = episodesResolved.some((entry) => !entry.skipped);
  const applied = arcOrSeasonsChanged || characterArcsChanged || episodesChanged;
  if (!applied && rejectedExactEdits) {
    console.log(`⚠️ arc-resolve: response made no applicable change after ${rejectedExactEdits} exact text edit(s) were rejected`);
  }

  // What this pass actually wrote, per record kind — the whole account in one
  // place, so a fifth record kind is added here and nowhere else. `series.*` is
  // the state as it stood BEFORE the commit above, so these describe this call's
  // writes and nothing else, and the two `*Changed` flags gate the counting: a
  // pass that moved nothing needs no per-record comparison to prove it.
  // Episodes ride the same manifest the rollback is driven by, so an edit that
  // was skipped or failed is never counted as written.
  const mutations = {
    arcFieldsEdited: arcOrSeasonsChanged ? changedFieldCount(arc, series.arc, RESOLVE_ARC_FIELDS) : 0,
    volumesEdited: arcOrSeasonsChanged ? changedEntryCount(seasons, series.seasons) : 0,
    characterArcsEdited: characterArcsChanged ? changedEntryCount(characterArcs, updated.characterArcs) : 0,
    episodesEdited: resolvedEpisodeEdits({ episodesResolved }).length,
  };

  return {
    series: resolvedSeries,
    applied,
    patchMode: exactTextMode ? 'exact-text-v1' : null,
    rejectedExactEdits,
    episodesResolved,
    mutations,
    noChangeReason: applied ? null : noChangeReasonFor(edits, rejectedExactEdits),
    ...runMeta,
  };
}

/**
 * Apply the auto-resolve pass's episode-synopsis corrections to the canonical
 * issue records. Each correction targets one issue by its series-global episode
 * number (with `seasonNumber` as a disambiguating cross-check). Writes the new
 * synopsis to the issue's `idea.input` seed. If that issue already has expanded
 * beats (`idea.output`) — only possible on a resume where beats ran in a prior
 * pass — they are cleared and the stage reset to `empty` so the beat-sheet step
 * regenerates them from the corrected synopsis instead of leaving stale beats
 * that still encode the contradiction.
 *
 * A locked `idea` stage is left untouched (the user froze it) and reported as
 * skipped. Returns `[{ issueId, number, seasonNumber, clearedBeats, skipped, idea }]`
 * for the conductor to surface; never throws — a bad match is dropped, not fatal.
 *
 * `idea` is the stage AS THIS CALL LEFT IT, and it is what makes the entry a
 * mutation manifest rather than a report: rollback restores an episode only when
 * the resolver is on record as having written it AND the value it wrote is still
 * standing (see `restoreArcState`). A write that failed is reported skipped —
 * counting it as an applied edit told the gate a synopsis had changed when the
 * store still held the old one.
 */
export async function applyEpisodeResolutions(seriesId, series, episodes) {
  if (!Array.isArray(episodes) || episodes.length === 0) return [];
  const issues = await listIssues({ seriesId });
  const seasonIdByNumber = seasonIdByNumberOf(series);
  const applied = [];
  for (const edit of episodes) {
    // Season match required when the named season resolves, else series-global
    // number; fail-safe to no-match on a numbering-scheme mismatch (see
    // matchIssueForEpisodeEdit). A bad match is logged below, never fatal.
    const issue = matchIssueForEpisodeEdit(issues, seasonIdByNumber, edit);
    if (!issue) {
      // A correction we can't land is a silent path to non-convergence — log it
      // so a number-scheme mismatch (per-season vs series-global) is diagnosable.
      console.log(`⚠️ arc-resolve: no issue matched episode correction (season ${edit.seasonNumber}, episode ${edit.episodeNumber})`);
      applied.push({ seasonNumber: edit.seasonNumber, episodeNumber: edit.episodeNumber, skipped: 'no-match' });
      continue;
    }
    if (issue.stages?.idea?.locked === true) {
      applied.push({ issueId: issue.id, number: issue.number, seasonNumber: edit.seasonNumber, skipped: 'locked' });
      continue;
    }
    const hadBeats = !!(issue.stages?.idea?.output && issue.stages.idea.output.trim());
    const written = await updateStageWithLatest(issue.id, 'idea', (current) => (
      hadBeats
        ? { input: edit.synopsis, output: '', status: 'empty', errorMessage: '' }
        : { input: edit.synopsis }
    )).catch((err) => {
      console.log(`⚠️ arc-resolve: episode ${edit.episodeNumber} synopsis edit failed: ${err.message}`);
      return null;
    });
    applied.push({
      issueId: issue.id,
      number: issue.number,
      seasonNumber: edit.seasonNumber,
      clearedBeats: hadBeats,
      ...(written ? { idea: ideaSnapshotOf(written.stage) } : { skipped: 'write-failed' }),
    });
  }
  if (applied.length) {
    const fixed = applied.filter((a) => !a.skipped).length;
    console.log(`📝 arc-resolve: corrected ${fixed} episode synopsis(es) for series ${seriesId.slice(0, 12)}`);
  }
  return applied;
}

// The three `idea`-stage fields an auto-resolve round can rewrite, normalized so
// the snapshot and the restore's dirty-check read the record the same way — a
// fourth field would otherwise have to be added to two hand-rolled default lists
// kept in lockstep.
const ideaSnapshotOf = (stage) => ({
  input: stage?.input ?? '',
  output: stage?.output ?? '',
  status: stage?.status ?? 'empty',
});

const sameIdea = (a, b) => a.input === b.input && a.output === b.output && a.status === b.status;

/**
 * The episode-synopsis writes ONE resolve pass actually landed, as
 * `[{ issueId, idea }]` — the exact-mutation manifest a rollback needs so it can
 * tell its own round's edits from a write that arrived from somewhere else while
 * the verification was running. Derived from the applier's own report — an entry
 * carries `idea` only when the write went through, never when it was skipped or
 * failed — so the manifest cannot claim an edit that never happened.
 *
 * Empty for an arc-spine round: that gate's resolver may not touch episodes at
 * all (`selectFindingKeyedEdits` discards them), which is exactly why a
 * spine-scope rollback must leave every episode `idea` field alone.
 */
export const resolvedEpisodeEdits = (resolved) => (Array.isArray(resolved?.episodesResolved)
  ? resolved.episodesResolved
    .filter((entry) => entry?.issueId && entry.idea)
    .map((entry) => ({ issueId: entry.issueId, idea: entry.idea }))
  : []);

// Every issue in the series, without per-stage run history: `listIssues` caps at
// 1000 (a longer series would lose its tail from the snapshot, making those
// episodes unrestorable) and carries history payloads this projection throws
// away. Shared by the snapshot and the restore.
const listEpisodesForSnapshot = (seriesId) => listIssuesForSeries(seriesId, { withHistory: false });

/**
 * Capture everything ONE auto-resolve round can rewrite — the series arc,
 * per-character arcs, volume records, and each episode's planning synopsis
 * (plus which volume it sits under) — so a round that leaves verification WORSE
 * can be reverted instead of committed. Read-only; the caller holds the snapshot
 * for the duration of the round (see `runArcVerify`'s regression guard).
 *
 * Deep-cloned: `getSeries` hands back the store record un-cloned, and a snapshot
 * that aliases the record it is meant to restore is no snapshot at all.
 */
export async function snapshotArcState(seriesId) {
  const [series, issues] = await Promise.all([getSeries(seriesId), listEpisodesForSnapshot(seriesId)]);
  return {
    seriesId,
    arc: structuredClone(series.arc ?? null),
    characterArcs: structuredClone(series.characterArcs || []),
    seasons: structuredClone(series.seasons || []),
    episodes: issues.map((iss) => ({
      id: iss.id,
      seasonId: iss.seasonId ?? null,
      idea: ideaSnapshotOf(iss.stages?.idea),
    })),
  };
}

/**
 * Put a `snapshotArcState` capture back, restoring only what actually differs:
 * the series arc, per-character arcs, volume list, any episode whose volume the
 * round re-pointed, and any episode synopsis the round rewrote. Returns what it
 * touched.
 *
 * Deliberately NOT routed through `commitSeasonsWithRemap`: that path merges,
 * preserves and re-mints, which is right for applying a rewrite and wrong for
 * undoing one — a rollback wants the exact prior record back, and it restores
 * the child issues' `seasonId` itself so a volume the round minted can't strand
 * the episodes it took. For the same reason it doesn't re-check `locked.arc`:
 * the arc was writable when the round ran, and refusing to undo that round's
 * damage because a lock flipped mid-run would strand the user with the damage.
 * A locked `idea` stage IS skipped — the resolve pass never touched it.
 *
 * `options.episodeEdits` is the round's exact mutation manifest (see
 * `resolvedEpisodeEdits`): pass it and only those episodes' `idea` fields are
 * eligible, and only while the value the resolver wrote is still the one
 * standing — "differs from the snapshot" was never proof the round owned the
 * difference. Two deliberate limits on that:
 *   - Volume reassignment is never manifest-gated. The volume list is being
 *     restored wholesale, so an episode left pointing at a volume that is about
 *     to disappear would be stranded.
 *   - Neither are the arc, character arcs and volume records themselves. Nothing
 *     records what the resolver wrote at that altitude, and a non-spine round is
 *     expected to rewrite all three, so the false-revert exposure is small — but
 *     it is the same reasoning, and closing it needs a manifest one level up.
 *
 * Omit `episodeEdits` and every differing episode is restored. The one caller
 * that still wants that is `restoreFoundationState`, which verifies its own
 * restore fidelity by diffing episodes wholesale. Both rollback loops that judge
 * a round by re-verifying it — the arc gate and the foundation gate's structure
 * repair — pass a manifest.
 *
 * Callers must re-verify after every resolve so they can distinguish a
 * regressive round from a good one. The arc convergence loop uses this to keep
 * its best verified checkpoint; foundation structure repair uses it to restore
 * the pre-repair plan when its bounded verify/correct pass is still blocked.
 * The manual `/arc/resolve` route remains an explicit unguarded user edit.
 */
export async function restoreArcState(seriesId, snapshot, { episodeEdits = null } = {}) {
  if (!snapshot || snapshot.seriesId !== seriesId || !Array.isArray(snapshot.episodes)) {
    return { restored: false, episodesRestored: 0, reassignedIssueCount: 0 };
  }
  const issues = await listEpisodesForSnapshot(seriesId);
  const byId = new Map(issues.map((iss) => [iss.id, iss]));
  // What the round is on record as having written to each episode, or null when
  // the caller kept the pre-manifest "restore every difference" contract.
  const ownedIdea = Array.isArray(episodeEdits)
    ? new Map(episodeEdits.map((e) => [e.issueId, e.idea]))
    : null;
  const stageUpdates = [];
  const reassign = [];
  for (const snap of snapshot.episodes) {
    const cur = byId.get(snap.id);
    // Gone since the snapshot — nothing to restore onto (auto-resolve never
    // deletes issues, so this is a concurrent user edit, not the round).
    if (!cur) continue;
    if ((cur.seasonId ?? null) !== snap.seasonId) reassign.push(snap);
    if (cur.stages?.idea?.locked === true) continue;
    const idea = ideaSnapshotOf(cur.stages?.idea);
    if (sameIdea(idea, snap.idea)) continue;
    if (ownedIdea) {
      const written = ownedIdea.get(snap.id);
      // Either the round never wrote this episode, or its write has since been
      // overwritten — in both cases what stands is someone else's, not the
      // regressive candidate this rollback is undoing.
      if (!written || !sameIdea(idea, written)) continue;
    }
    stageUpdates.push({
      issueId: snap.id,
      stageId: 'idea',
      computeFn: () => ({ ...snap.idea, errorMessage: '' }),
    });
  }
  // Same write ordering as `commitSeasonsWithRemap`: seasons first, so a crash
  // between writes can't leave an issue pointing at a volume that isn't in
  // `series.seasons[]`.
  await withReexportSuppressed('series', seriesId, async () => {
    await updateSeries(seriesId, {
      arc: snapshot.arc,
      seasons: snapshot.seasons,
      ...(Array.isArray(snapshot.characterArcs) ? { characterArcs: snapshot.characterArcs } : {}),
    });
    for (const snap of reassign) {
      await updateIssue(snap.id, { seasonId: snap.seasonId }, { skipRenumber: true });
    }
    if (reassign.length) await recomputeIssueNumbersForSeries(seriesId);
    await updateStagesWithLatest(seriesId, stageUpdates);
  });
  emitRecordUpdated('series', seriesId);
  console.log(`↩️ arc-resolve: reverted a regressive round for series ${seriesId.slice(0, 12)} — ${stageUpdates.length} episode synopsis(es), ${reassign.length} reassignment(s)`);
  return { restored: true, episodesRestored: stageUpdates.length, reassignedIssueCount: reassign.length };
}

// Preserve per-field arc locks. When `currentSeries.locked.arcFields[k]` is
// true, the incoming arc's value for `k` is replaced with the existing one so
// auto-resolve / regenerate flows can rewrite unlocked fields without
// clobbering user-frozen ones. `null` next-arc (no incoming arc) is passed
// through unchanged — the persist layer's sanitizer drops it.
export function mergeArcWithLocks(currentArc, nextArc, lockedFields) {
  if (!nextArc || !lockedFields || typeof lockedFields !== 'object') return nextArc;
  if (!currentArc) return nextArc;
  const merged = { ...nextArc };
  for (const field of ARC_LOCKABLE_FIELDS) {
    if (lockedFields[field] === true) merged[field] = currentArc[field];
  }
  return merged;
}

// Preserve per-season locks. For every locked season in `currentSeasons`:
//   - if the LLM proposed an entry with the same id, replace it with the
//     existing locked record field-for-field (LLM's title/logline/etc. are
//     discarded);
//   - if the LLM dropped it entirely, re-insert it so it survives the resolve.
// Unlocked seasons (and brand-new entries the LLM minted) pass through. The
// caller still funnels the result through `sanitizeSeasonList`, which re-sorts
// by `number` ascending and dedups by id.
//
// Mirrors `mergeArcWithLocks`'s contract: locks are an *enforcement* gate, not
// a workflow signal — the arc-level `series.locked.arc` check up the stack
// remains the all-or-nothing block; this lets users freeze individual seasons
// while still letting auto-resolve rewrite the rest of the arc.
export function mergeSeasonsWithLocks(currentSeasons, nextSeasons) {
  if (!Array.isArray(nextSeasons)) return nextSeasons;
  if (!Array.isArray(currentSeasons)) return nextSeasons;
  const lockedById = new Map();
  for (const s of currentSeasons) {
    if (s?.locked === true && s.id) lockedById.set(s.id, s);
  }
  if (lockedById.size === 0) return nextSeasons;
  const seen = new Set();
  const merged = [];
  for (const next of nextSeasons) {
    const locked = next?.id ? lockedById.get(next.id) : null;
    if (locked) {
      merged.push(locked);
      seen.add(locked.id);
    } else {
      merged.push(next);
    }
  }
  for (const [id, locked] of lockedById) {
    if (!seen.has(id)) merged.push(locked);
  }
  return merged;
}

// Re-insert every EXISTING season the rewrite dropped, without freezing the
// ones it kept. Distinct from `mergeSeasonsWithLocks`: that one restores a
// locked season's CONTENT verbatim (the user froze it); this one only
// guarantees the record survives, so a same-id rewrite still applies in full.
//
// Used by the autopilot's `unlockForRun` mode — once that pass clears the
// per-season locks, nothing else stops an LLM-proposed arc from silently
// deleting a volume, and unlocking for EDITING must not become a licence to
// DELETE (see seriesAutopilot/unlockPass.js).
//
// The preserved records go FIRST, and that ordering is load-bearing rather than
// cosmetic: `sanitizeSeasonList` caps the list at SEASONS_PER_SERIES_MAX by
// keeping the first N it sees. Appending them would mean an LLM that returned a
// full cap's worth of brand-new volumes silently pushed every existing volume
// past the cap — the sanitizer would drop them and `commitSeasonsWithRemap`
// would then treat them as deleted and reassign their issues, which is exactly
// the deletion this helper exists to refuse. Existing records therefore win the
// cap; the rewrite's surplus new volumes are what gets trimmed. Final display
// order is unaffected — `sanitizeSeasonList` sorts by `number` at the end.
export function preserveDroppedSeasonRecords(currentSeasons, nextSeasons) {
  if (!Array.isArray(nextSeasons)) return nextSeasons;
  if (!Array.isArray(currentSeasons)) return nextSeasons;
  const keptIds = new Set(nextSeasons.map((s) => s?.id).filter(Boolean));
  const dropped = currentSeasons.filter((s) => s?.id && !keptIds.has(s.id));
  return dropped.length === 0 ? nextSeasons : [...dropped, ...nextSeasons];
}

// Normalized title comparison, shared by the two season matchers below.
const normTitle = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');

/**
 * Resolve each LLM-proposed season to the EXISTING season record it is a
 * rewrite of, so a rewrite lands on that record instead of minting a sibling.
 * Returns an array parallel to `proposedSeasons` holding the matched existing
 * season (or `null` when the proposal is genuinely new).
 *
 * Match priority mirrors `buildSeasonRemap`, and runs as three ordered passes
 * rather than one greedy sweep so a proposal that DOES carry an `id` always
 * wins its own record: a same-titled sibling processed earlier must not claim
 * it and push the id-carrying proposal into minting a duplicate.
 *   1. explicit `id`
 *   2. normalized title (the resolve prompt is told to preserve titles)
 *   3. `number`, only when exactly one unclaimed existing season has it
 *
 * Deliberately NOT a positional fallback — unlike `buildSeasonRemap`'s 1↔1
 * pass, a wrong guess here doesn't just misfile child issues, it overwrites a
 * volume's prose with another volume's rewrite. Unmatched proposals mint, which
 * is the recoverable outcome.
 */
export function matchProposedSeasons(existingSeasons, proposedSeasons) {
  const existing = Array.isArray(existingSeasons) ? existingSeasons.filter((s) => s?.id) : [];
  const proposed = Array.isArray(proposedSeasons) ? proposedSeasons : [];
  const matched = new Array(proposed.length).fill(null);
  if (existing.length === 0) return matched;
  const byId = new Map(existing.map((s) => [s.id, s]));
  const claimed = new Set();

  const claim = (idx, season) => {
    matched[idx] = season;
    claimed.add(season.id);
  };

  // Pass 1 — explicit id.
  proposed.forEach((raw, idx) => {
    const hit = raw?.id ? byId.get(raw.id) : null;
    if (hit && !claimed.has(hit.id)) claim(idx, hit);
  });

  // Pass 2 — normalized title.
  proposed.forEach((raw, idx) => {
    if (matched[idx]) return;
    const title = normTitle(raw?.title);
    if (!title) return;
    const hit = existing.find((s) => normTitle(s.title) === title && !claimed.has(s.id));
    if (hit) claim(idx, hit);
  });

  // Pass 3 — unambiguous `number`.
  proposed.forEach((raw, idx) => {
    if (matched[idx]) return;
    if (!Number.isFinite(raw?.number)) return;
    const hits = existing.filter((s) => s.number === raw.number && !claimed.has(s.id));
    if (hits.length === 1) claim(idx, hits[0]);
  });

  return matched;
}

// Prose fields a collapse may back-fill onto the surviving record. Only ever
// used to fill a field that is EMPTY on the survivor — never to overwrite.
const SEASON_FILLABLE_FIELDS = ['logline', 'synopsis', 'endingHook'];

// Rescue content that only exists on the records being absorbed, so collapsing
// a duplicate can't silently delete the one revision that had a synopsis.
function backfillSeasonGaps(survivor, group) {
  // Newest first — if several duplicates could fill a gap, the latest rewrite
  // is the one the user last saw.
  const donors = group
    .filter((s) => s.id !== survivor.id)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  let next = survivor;
  for (const key of SEASON_FILLABLE_FIELDS) {
    if (next[key]) continue;
    const donor = donors.find((d) => d[key]);
    if (donor) next = { ...next, [key]: donor[key] };
  }
  if (!next.themes?.length) {
    const donor = donors.find((d) => d.themes?.length);
    if (donor) next = { ...next, themes: donor.themes };
  }
  if (!next.episodeCountTarget) {
    const donor = donors.find((d) => d.episodeCountTarget);
    if (donor) next = { ...next, episodeCountTarget: donor.episodeCountTarget };
  }
  return next;
}

/** True when two or more seasons in the list share a `number`. Pure. */
export function hasDuplicateSeasonNumbers(seasons) {
  if (!Array.isArray(seasons)) return false;
  const seen = new Set();
  for (const s of seasons) {
    if (!s) continue;
    if (seen.has(s.number)) return true;
    seen.add(s.number);
  }
  return false;
}

/**
 * Collapse seasons that share a `number` down to one record per number, and
 * report which ids were absorbed so the caller can re-point their child issues.
 * Returns `{ seasons, absorbed: Map<absorbedId, survivorId> }`.
 *
 * Two volumes numbered the same is never a state a user can act on — the Arc
 * Canvas renders both, a volume export can't tell which is canonical, and
 * arc-verify files it as a blocking finding every round. Before
 * `matchProposedSeasons` existed, auto-resolve manufactured exactly this shape,
 * so the collapse doubles as the self-heal for installs that already diverged:
 * the next arc write repairs the record without a migration (the file-migration
 * runner executes before the Postgres pool, and series are db-primary).
 *
 * Survivor preference — the record with the strongest claim to the child
 * issues, so a collapse never strands episodes:
 *   1. `locked` (the user froze it)
 *   2. most child issues
 *   3. oldest `createdAt` (the original, not the bug's mint)
 *
 * A group holding TWO OR MORE locked records is left intact: silently deleting
 * a user-frozen volume is worse than the duplicate, and only a human can say
 * which freeze was intended. Those groups keep warning every write, which is
 * the correct nag.
 */
export function collapseDuplicateSeasonNumbers(seasons, issueCountBySeasonId = new Map(), { log = true } = {}) {
  const absorbed = new Map();
  if (!Array.isArray(seasons)) return { seasons, absorbed };
  const byNumber = new Map();
  for (const s of seasons) {
    if (!s) continue;
    const group = byNumber.get(s.number);
    if (group) group.push(s);
    else byNumber.set(s.number, [s]);
  }

  const survivors = [];
  for (const [number, group] of byNumber) {
    if (group.length === 1) {
      survivors.push(group[0]);
      continue;
    }
    const lockedCount = group.filter((s) => s.locked === true).length;
    if (lockedCount > 1) {
      if (log) {
        console.warn(
          `⚠️ collapseDuplicateSeasonNumbers: volume ${number} has ${group.length} records including ${lockedCount} locked — left intact, unlock all but one to collapse`,
        );
      }
      survivors.push(...group);
      continue;
    }
    const episodes = (s) => issueCountBySeasonId.get(s.id) || 0;
    const [survivor] = [...group].sort((a, b) => (
      (b.locked === true ? 1 : 0) - (a.locked === true ? 1 : 0)
      || episodes(b) - episodes(a)
      || String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
    ));
    survivors.push(backfillSeasonGaps(survivor, group));
    for (const s of group) {
      if (s.id !== survivor.id) absorbed.set(s.id, survivor.id);
    }
    if (log) {
      console.warn(
        `⚠️ collapseDuplicateSeasonNumbers: volume ${number} had ${group.length} records — kept ${survivor.id} (${episodes(survivor)} episode(s)), absorbed ${group.length - 1} into it`,
      );
    }
  }
  // Re-sort: `sanitizeSeasonList`'s number ordering is the contract consumers
  // render straight from, and the group walk above emits in first-seen order.
  return { seasons: survivors.sort((a, b) => (a.number || 0) - (b.number || 0)), absorbed };
}

/**
 * Persist a new `arc` + `seasons[]` onto a series, migrating any child issues
 * whose `seasonId` referenced a season that the new shape dropped or renamed.
 * Shared by `resolveVerifyIssues` (auto-resolve) and `/arc/generate` — both
 * paths can rewrite season ids, and without this migration the orphans land
 * behind keys the Arc Canvas never iterates back.
 *
 * Match priority (via `buildSeasonRemap`): normalized title → unique number →
 * positional 1:1 fallback. Unmatched orphans get `seasonId: null` so they fall
 * into the visible "Un-grouped" bucket instead of vanishing.
 *
 * Per-field arc locks (`series.locked.arcFields`) are honored: locked fields
 * are restored from `currentSeries.arc` before the persist, so an auto-resolve
 * that proposes a new logline can preserve the user-frozen themes verbatim.
 *
 * `currentSeries` identifies the target series. The helper refreshes the
 * latest snapshot before writing so locks toggled while an LLM run is in
 * flight are honored at commit time.
 *
 * `options.preserveDroppedSeasons` additionally re-inserts any existing season
 * the new shape omitted, whether or not it was locked — the non-destructive
 * guarantee the autopilot's `unlockForRun` mode relies on (it clears the very
 * per-season locks that would otherwise have preserved them). Content rewrites
 * to surviving seasons still apply; only deletion is refused.
 */
export async function commitSeasonsWithRemap(currentSeries, { arc, seasons }, options = {}) {
  const seriesId = currentSeries.id;
  const latestSeries = await getSeries(seriesId);
  if (latestSeries.locked?.arc === true) {
    throw new ServerError(
      'Arc is locked — unlock it before rewriting the arc',
      { status: 400, code: ERR_VALIDATION },
    );
  }
  const mergedArc = mergeArcWithLocks(latestSeries.arc, arc, latestSeries.locked?.arcFields);
  // Per-season locks: restore any locked existing seasons over LLM-proposed
  // rewrites, and re-insert any locked seasons the LLM dropped. Re-sanitize
  // so the locked records merge with the new shape (sort by number, dedup).
  const lockMerged = mergeSeasonsWithLocks(latestSeries.seasons, seasons);
  let mergedSeasons = sanitizeSeasonList(
    options.preserveDroppedSeasons === true
      ? preserveDroppedSeasonRecords(latestSeries.seasons, lockMerged)
      : lockMerged,
  );

  // One `listIssues` for the whole commit — the collapse below needs per-season
  // episode counts and the reassign sweep needs the same list.
  let allIssues = null;
  const loadIssues = async () => {
    if (allIssues === null) allIssues = await listIssues({ seriesId });
    return allIssues;
  };

  // Self-heal duplicate volume numbers on the way through. `sanitizeSeasonList`
  // dedupes by `id` only, so two records both numbered 1 survive it happily —
  // and that shape is a blocking arc-verify finding no amount of LLM rewriting
  // can clear. Absorbed ids are threaded into the remap below so their episodes
  // follow the survivor instead of falling into the ungrouped bucket.
  let absorbed = new Map();
  if (hasDuplicateSeasonNumbers(mergedSeasons)) {
    const counts = new Map();
    for (const iss of await loadIssues()) {
      if (iss.seasonId) counts.set(iss.seasonId, (counts.get(iss.seasonId) || 0) + 1);
    }
    ({ seasons: mergedSeasons, absorbed } = collapseDuplicateSeasonNumbers(mergedSeasons, counts));
  }

  const newIds = new Set(mergedSeasons.map((s) => s.id));
  const droppedOldSeasons = (latestSeries.seasons || []).filter((s) => !newIds.has(s.id));
  const oldIds = new Set((latestSeries.seasons || []).map((s) => s.id));
  const newlyMintedSeasons = mergedSeasons.filter((s) => !oldIds.has(s.id));
  const remap = buildSeasonRemap(droppedOldSeasons, newlyMintedSeasons);
  // An absorbed duplicate has a KNOWN survivor, which beats buildSeasonRemap's
  // title/number inference — that pass only considers freshly-minted seasons as
  // targets, so a duplicate absorbed into an existing record would otherwise
  // map to null and orphan every episode under it.
  for (const [absorbedId, survivorId] of absorbed) remap.set(absorbedId, survivorId);
  const droppedIdSet = new Set(droppedOldSeasons.map((s) => s.id));
  const reassignList = droppedIdSet.size
    ? (await loadIssues()).filter((iss) => droppedIdSet.has(iss.seasonId))
    : [];

  // Mirrors `deleteSeason`'s bulk-reassign idiom — `skipRenumber` per call +
  // one `recomputeIssueNumbers` after, wrapped in `withReexportSuppressed` so
  // we don't fan out N socket events + N debounced re-exports of the same
  // series.
  //
  // Persist the new seasons FIRST so that a crash between writes leaves
  // issues attached to ids that still exist in `series.seasons[]`. If we
  // wrote issues first and crashed before `updateSeries`, every reassigned
  // issue would point at a `seasonId` that's not in the persisted series —
  // the exact orphan state this helper was written to prevent.
  let updated;
  await withReexportSuppressed('series', seriesId, async () => {
    updated = await updateSeries(seriesId, { arc: mergedArc, seasons: mergedSeasons });
    for (const iss of reassignList) {
      const target = remap.get(iss.seasonId) ?? null;
      await updateIssue(iss.id, { seasonId: target }, { skipRenumber: true });
    }
    if (reassignList.length) await recomputeIssueNumbersForSeries(seriesId);
  });
  if (reassignList.length) emitRecordUpdated('series', seriesId);
  return { series: updated, reassignedIssueCount: reassignList.length };
}

// Build a Map<oldSeasonId, newSeasonId|null> from the set of removed seasons
// and the freshly-minted ones in the same resolve. Matching priority:
//   1. normalized title equality (LLM was told to preserve titles when it can)
//   2. `number` equality (only when the target number is unique among new ones)
//   3. positional fallback — only fires when exactly ONE unmatched on each
//      side. With a single pair the mapping is forced and unambiguous; with
//      2+ unmatched the LLM may have reshuffled/renamed everything and
//      positional guessing silently invents wrong mappings (the bug that
//      motivated this guard). Skipped runs log a warning and let those
//      orphans fall through to the ungrouped bucket below.
// Anything that can't be matched maps to null so the issue lands in the
// ungrouped bucket instead of staying stranded behind a defunct id.
export function buildSeasonRemap(droppedOldSeasons, newlyMintedSeasons) {
  const remap = new Map();
  const claimed = new Set();
  const norm = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');

  // Pass 1: normalized title
  for (const old of droppedOldSeasons) {
    const oldTitle = norm(old.title);
    if (!oldTitle) continue;
    const hit = newlyMintedSeasons.find(
      (n) => norm(n.title) === oldTitle && !claimed.has(n.id),
    );
    if (hit) {
      claimed.add(hit.id);
      remap.set(old.id, hit.id);
    }
  }

  // Pass 2: unique `number` match
  for (const old of droppedOldSeasons) {
    if (remap.has(old.id)) continue;
    if (!Number.isFinite(old.number)) continue;
    const matches = newlyMintedSeasons.filter(
      (n) => n.number === old.number && !claimed.has(n.id),
    );
    if (matches.length === 1) {
      claimed.add(matches[0].id);
      remap.set(old.id, matches[0].id);
    }
  }

  // Pass 3: positional fallback — only when the unmatched sets are exactly
  // 1↔1, where the pairing is forced.
  const oldRemaining = droppedOldSeasons.filter((s) => !remap.has(s.id));
  const newRemaining = newlyMintedSeasons.filter((n) => !claimed.has(n.id));
  if (oldRemaining.length === 1 && newRemaining.length === 1) {
    // Sanitize titles before logging — LLM-generated text can carry newlines,
    // C0/C1 control chars, or ANSI escapes that would break the project's
    // single-line logging convention or corrupt terminal output; fall back to
    // the stable id when the title is empty after sanitization.
    const safeLabel = (s) => {
      const raw = typeof s.title === 'string' ? s.title : '';
      // stripAnsi removes full ESC + CSI sequences (so "[31m" payload tails
      // don't leak through). Note: OSC sequence bodies do leak
      // through stripAnsi today — extremely unlikely in LLM-generated season
      // titles, but called out here so a future fix to ANSI_PATTERN naturally
      // tightens this path. The trailing control-char sweep catches any bare
      // C0/C1 bytes the regex doesn't match.
      const t = stripAnsi(raw)
        .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60);
      return t || s.id;
    };
    console.warn(
      `⚠️ buildSeasonRemap Pass 3 fired: forced 1↔1 pairing "${safeLabel(oldRemaining[0])}" → "${safeLabel(newRemaining[0])}"`,
    );
    remap.set(oldRemaining[0].id, newRemaining[0].id);
    claimed.add(newRemaining[0].id);
  } else if (
    oldRemaining.length === newRemaining.length
    && oldRemaining.length > 1
  ) {
    // Suppression warn ONLY for the cases where the previous behavior would
    // have fired the positional fallback (equal counts ≥ 2). Unequal counts
    // were never positional-fallback candidates, so they don't deserve a
    // "skipped" message.
    console.warn(
      `⚠️ buildSeasonRemap skipped positional fallback (${oldRemaining.length} old × ${newRemaining.length} new unmatched) — orphan issues route to ungrouped`,
    );
  }

  // Anything still unmapped → null (ungrouped bucket).
  for (const old of droppedOldSeasons) {
    if (!remap.has(old.id)) remap.set(old.id, null);
  }
  return remap;
}
