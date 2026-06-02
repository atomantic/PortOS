/**
 * Pipeline — Series Arc Planning Service
 *
 * Phase 3 of the Story Arc Planning initiative. Owns the three LLM-driven
 * planning passes that populate `series.arc` and `series.seasons[]`:
 *
 *   generateArcOverview(seriesId)         → seeds series.arc + series.seasons[]
 *   generateSeasonEpisodes(seriesId, seasonId, { force? })
 *                                          → seeds issues under a season
 *   verifyArc(seriesId)                   → cross-season continuity pass
 *
 * Each function returns `{ result, runId, providerId, model }` so the caller
 * can react to a successful run (persisted via `updateSeries` / `createSeason`
 * / `createIssue` chains as appropriate) and surface the runId in /runs.
 *
 * Extraction-only; mirrors how `bibleExtractor.js` and `sceneExtractor.js`
 * are split — the caller decides whether to persist. The two-step shape
 * keeps the LLM call replayable and lets the UI preview the plan before
 * committing it (Phase 4's confirm-before-seeding pattern).
 */

import { runStagedLLM, resolveStageContext } from '../../lib/stageRunner.js';
import { planManuscriptPass, estimateTokens } from '../../lib/contextBudget.js';
import { ServerError } from '../../lib/errorHandler.js';
import { stripAnsi } from '../../lib/ansiStrip.js';
import { getSeries, updateSeries, updateSeasonOnSeries, ARC_LOCKABLE_FIELDS, MANUSCRIPT_TYPES } from './series.js';
import { listIssues, updateIssue, recomputeIssueNumbersForSeries, getIssue, updateStage, updateStageWithLatest, assertStageUnlocked, createIssue } from './issues.js';
import { emitRecordUpdated, withReexportSuppressed } from '../sharing/recordEvents.js';
import { getSeason } from './seasons.js';
import {
  sanitizeArc,
  cleanThemes,
  sanitizeSeasonList,
  sanitizeSeason,
  buildSeason,
  sanitizeReaderMap,
  ARC_ROLES as ARC_ROLE_LIST,
  ARC_SHAPE_IDS,
  READER_MAP_BEAT_KINDS,
  renderArcShapeGuidance,
  renderArcShapePositionSummary,
} from '../../lib/storyArc.js';
import { runPromptRefineRaw, trimChanges } from './refineHelpers.js';
import { recommendStructure, describeStructure } from '../../lib/seasonStructure.js';
import { LENGTH_PROFILE_NAMES, DEFAULT_LENGTH_PROFILE } from '../../lib/issueLength.js';
import { getUniverse } from '../universeBuilder.js';
import { getSeriesCanon } from './seriesCanon.js';
import { renderCategoriesForPrompt, renderCompositesForPrompt, renderCanonForPrompt, renderEntitiesSummary } from '../../lib/universePromptRenderers.js';

export const ERR_VALIDATION = 'PIPELINE_ARC_VALIDATION';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

const VERIFY_SEVERITIES = new Set(['high', 'medium', 'low']);
const ARC_ROLES = new Set(ARC_ROLE_LIST);
// Season-episode generation must produce concrete preset profiles only — the
// 'custom' sentinel needs companion pageTarget/minutesTarget values the LLM is
// not asked to invent, so a 'custom' here would silently render as 'standard'
// at prompt time. Limit to the canonical preset names.
const SEASON_LENGTH_PRESETS = new Set(LENGTH_PROFILE_NAMES.filter((n) => n !== 'custom'));
// Finale-role episodes should size like a finale even when the LLM omits
// (or misspells) lengthProfile. Other arcRoles fall back to the default
// profile so a missing/misspelled length doesn't cascade into the wrong
// size for the whole arc.
const lengthProfileForArcRole = (arcRole) => (arcRole === 'finale' ? 'finale' : DEFAULT_LENGTH_PROFILE);

// Each prior season renders as its header (logline + synopsis) plus the
// committed per-episode beats from `stages.idea.input` — that field was
// seeded with the LLM's `logline + synopsis` at episode-generate time.
function renderPriorSeason(s, priorIssues) {
  const header = `### Season ${s.number} — ${s.title}\n\n${s.logline}\n\n${s.synopsis || '(no synopsis)'}`;
  const seasonEpisodes = priorIssues
    .filter((iss) => iss.seasonId === s.id)
    .sort(compareIssuesByPosition);
  if (seasonEpisodes.length === 0) return header;
  const lines = seasonEpisodes.map((iss) => {
    const idea = (iss.stages?.idea?.input || '').trim();
    const ord = iss.arcPosition || '?';
    return idea ? `- E${ord} — ${iss.title}: ${idea}` : `- E${ord} — ${iss.title}`;
  }).join('\n');
  return `${header}\n\nEpisode beats:\n${lines}`;
}

// Shared placeholder for world-context fields when the series has no linked
// Universe Builder world. Exported so per-issue context builders
// (textStages.buildStageContext) render the same string instead of drifting
// to a near-duplicate phrasing.
export const NO_LINKED_UNIVERSE_PLACEHOLDER = '(none — series has no linked Universe Builder world)';

// The world is the canonical source for factions, characters, environments,
// etc. — without this, the arc planner would only see the series' own
// characters/places/objects which are usually empty pre-prose.
async function loadWorldContext(universeId) {
  if (!universeId) return null;
  const world = await getUniverse(universeId).catch(() => null);
  if (!world) return null;

  const embrace = Array.isArray(world.influences?.embrace) ? world.influences.embrace : [];
  const avoid = Array.isArray(world.influences?.avoid) ? world.influences.avoid : [];

  return {
    // Truthy mustache flag the prompt templates use to gate the entire
    // "Linked World" block — unlinked arc/verify runs render a neutral
    // placeholder instead of telling the LLM the series is grounded in a
    // non-existent world.
    hasLinkedWorld: true,
    worldName: world.name || '',
    worldStarter: world.starterPrompt || '',
    worldLogline: world.logline || '',
    worldPremise: world.premise || '',
    worldStyleNotes: world.styleNotes || '',
    worldInfluencesEmbrace: embrace.length ? embrace.join(', ') : '(none)',
    worldInfluencesAvoid: avoid.length ? avoid.join(', ') : '(none)',
    worldCategoriesText: renderCategoriesForPrompt(world.categories) || '(none)',
    worldCompositesText: renderCompositesForPrompt(world.compositeSheets) || '(none)',
    // Universe canon — named characters/places/objects the arc references by
    // name. Separate from categories because the LLM should treat these as
    // first-class entities, not exploratory variations.
    worldCanonText: renderCanonForPrompt(world) || '(none)',
    // Compact one-line-per-kind synopsis of canon — intended for text stages
    // (prose/teleplay/comic-script) where the full canon dump would dominate
    // the prompt. Arc-level prompts also receive it so a template author can
    // pick whichever level of detail fits the section being grounded.
    worldEntitiesSummary: renderEntitiesSummary(world) || '(none)',
  };
}

// Fallback when series has no linked world — prompt partials still expect
// these variables to be defined. `hasLinkedWorld: false` lets the template's
// `{{#hasLinkedWorld}}…{{/hasLinkedWorld}}` block fall through so the LLM
// isn't told to ground arcs in a non-existent universe.
const EMPTY_WORLD_CONTEXT = {
  hasLinkedWorld: false,
  worldName: '(no linked world)',
  worldStarter: '',
  worldLogline: '',
  worldPremise: '',
  worldStyleNotes: '',
  worldInfluencesEmbrace: '(none)',
  worldInfluencesAvoid: '(none)',
  worldCategoriesText: NO_LINKED_UNIVERSE_PLACEHOLDER,
  worldCompositesText: '(none)',
  worldCanonText: NO_LINKED_UNIVERSE_PLACEHOLDER,
  worldEntitiesSummary: NO_LINKED_UNIVERSE_PLACEHOLDER,
};

// Resolve world context, accepting an optional preloaded value so callers
// that chain (verify → resolve) don't reload the same world twice.
async function resolveWorldContext(series, preloaded) {
  if (preloaded) return preloaded;
  return (await loadWorldContext(series.universeId)) || EMPTY_WORLD_CONTEXT;
}

// Canonical issue sort: arcPosition first (issues seeded by the season-
// episode generator carry sequential positions), then series number as a
// tiebreaker for issues that were created ad-hoc and never got a position.
export const compareIssuesByPosition = (a, b) =>
  (a.arcPosition ?? 9999) - (b.arcPosition ?? 9999) || (a.number || 0) - (b.number || 0);

// Cap on the concatenated manuscript fed to back-derivation passes. Mirrors the
// importer's source ceiling intent — large enough for a full graphic novel,
// bounded so a runaway corpus can't blow the prompt budget.
const BACKFILL_SOURCE_MAX = 200_000;

// Local copy of textStages' stageContentOf. Inlined (not imported) because
// textStages.js imports from THIS module (compareIssuesByPosition,
// NO_LINKED_UNIVERSE_PLACEHOLDER) — importing back would create a cycle whose
// binding is undefined at module-eval time. The one-liner is stable.
// output (the generated/edited artifact) before input (the upstream seed): for
// back-derivation we want the most-developed text, so a prose stage with both a
// beat-sheet seed (input) and a drafted manuscript (output) yields the draft.
// (textStages.stageContentOf is input-first because it answers a different
// question — "does this stage have ANY content to use as a generation source".)
const stageTextOf = (stage) => (stage?.output?.trim() || stage?.input?.trim() || '');

// The drafted-manuscript stages, in precedence order. Single source of truth is
// `MANUSCRIPT_TYPES` in series.js (which series.js needs for the bible field and
// arcPlanner already imports — so no new cycle). Re-exported under the
// historical name for the existing importers.
export const MANUSCRIPT_STAGES = MANUSCRIPT_TYPES;
// Default stage precedence: the richest authored artifact per issue. `idea`
// (the outline/synopsis seed) is the lowest-priority fallback — it lets an
// arc be back-derived from outlines alone. Callers that specifically mean
// "the DRAFTED MANUSCRIPT" must pass MANUSCRIPT_STAGES to exclude it.
const SOURCE_STAGE_ORDER = [...MANUSCRIPT_STAGES, 'idea'];

/**
 * Concatenate the richest authored artifact per issue into one corpus an
 * upstream pass can back-derive FROM — the "started from a finished manuscript"
 * case. Issues are ordered by arcPosition so the corpus reads in story order.
 * Returns '' when no issue has text in any of `stageOrder`.
 *
 * `stageOrder` selects which stages count (and their precedence). The default
 * includes `idea`, so an arc can be derived from outlines; pass
 * `MANUSCRIPT_STAGES` to require actual drafted script (excludes `idea`) —
 * that's what `analyzeManuscriptCompleteness` uses so it never grades an
 * outline as if it were a finished manuscript.
 *
 * Shared by `deriveFromManuscript` here and the Story Builder's plotArc/idea
 * backfill (storyBuilder.js) so both see the identical corpus shape.
 */
export async function collectManuscriptSections(seriesId, { stageOrder = MANUSCRIPT_STAGES } = {}) {
  if (!seriesId) return [];
  const issues = (await listIssues({ seriesId }).catch(() => [])).sort(compareIssuesByPosition);
  const sections = [];
  for (const iss of issues) {
    const st = iss.stages || {};
    const pick = stageOrder
      .map((sid) => ({ sid, content: stageTextOf(st[sid]) }))
      .find((x) => x.content);
    if (!pick) continue;
    sections.push({
      issueId: iss.id,
      number: iss.number,
      title: iss.title || '',
      stageId: pick.sid,
      content: pick.content,
    });
  }
  return sections;
}

// Header for one manuscript section. The corpus join below derives from
// `collectManuscriptSections` so the text the LLM sees stays byte-identical to
// the per-section text the editor renders — anchorQuote/find matching depends
// on that invariant. Exported so manuscriptFix.js shares the exact same shape.
export const manuscriptSectionHeader = (s) => `# Issue ${s.number}${s.title ? ` — ${s.title}` : ''} (${s.stageId})`;

// Join sections into one manuscript corpus. The single source of truth for
// "render sections as a manuscript" — reused by collectIssueSourceText, the
// completeness pass, and manuscriptFix so the LLM-visible text never drifts.
export const sectionsCorpus = (sections) =>
  sections.map((s) => `${manuscriptSectionHeader(s)}\n\n${s.content || ''}`).join('\n\n---\n\n');

export async function collectIssueSourceText(seriesId, { stageOrder = SOURCE_STAGE_ORDER } = {}) {
  if (!seriesId) return '';
  const sections = await collectManuscriptSections(seriesId, { stageOrder });
  return sectionsCorpus(sections).slice(0, BACKFILL_SOURCE_MAX);
}

// Lightweight version list for a stage — `{ runId, createdAt }` per retained
// prior version (full text stays in the issue record, fetched on revert via the
// restore route). Lets the editor show "History (N)" + revert without shipping
// every snapshot's text in the manuscript payload.
export const stageVersionsOf = (stage) =>
  (Array.isArray(stage?.runHistory) ? stage.runHistory : [])
    .map((h) => ({ runId: h.runId, createdAt: h.createdAt }));

// The dominant manuscript type across the series' sections — the editor's
// display "mode". Per-section stageId stays authoritative for writes.
export function primaryStageIdOf(sections) {
  const counts = new Map();
  for (const s of sections) counts.set(s.stageId, (counts.get(s.stageId) || 0) + 1);
  let best = null;
  let bestN = 0;
  for (const [sid, n] of counts) if (n > bestN) { best = sid; bestN = n; }
  return best;
}

/**
 * Collect the FULL series manuscript in every format at once, for the
 * format-switching manuscript editor. Unlike `collectManuscriptSections`
 * (which picks one richest stage per issue), this returns a complete
 * issue-by-issue section list for EACH of comicScript / teleplay / prose —
 * every issue appears in every format's list (content `''` where that issue
 * hasn't been drafted in that format yet) so the editor spans the whole story
 * and the author can fill gaps. One issue scan feeds all three.
 *
 * Returns `{ sectionsByType, availableTypes, detectedPrimary }`:
 *   - sectionsByType[stageId] = [{ issueId, number, title, stageId, content }]
 *   - availableTypes          = the formats that have content in ≥1 issue
 *   - detectedPrimary         = the format with the most drafted issues (the
 *                               fallback when the series hasn't pinned one)
 */
export async function collectManuscriptByType(seriesId) {
  // Derive the accumulators from MANUSCRIPT_STAGES so a new format added there
  // can't desync into a missing key (a `.push` on undefined).
  const sectionsByType = Object.fromEntries(MANUSCRIPT_STAGES.map((t) => [t, []]));
  const counts = Object.fromEntries(MANUSCRIPT_STAGES.map((t) => [t, 0]));
  if (!seriesId) return { sectionsByType, availableTypes: [], detectedPrimary: null };
  const issues = (await listIssues({ seriesId }).catch(() => [])).sort(compareIssuesByPosition);
  for (const iss of issues) {
    const st = iss.stages || {};
    for (const sid of MANUSCRIPT_STAGES) {
      const content = stageTextOf(st[sid]);
      sectionsByType[sid].push({
        issueId: iss.id, number: iss.number, title: iss.title || '', stageId: sid, content,
        versions: stageVersionsOf(st[sid]),
      });
      if (content) counts[sid] += 1;
    }
  }
  const availableTypes = MANUSCRIPT_STAGES.filter((t) => counts[t] > 0);
  let detectedPrimary = null;
  let best = 0;
  for (const t of MANUSCRIPT_STAGES) if (counts[t] > best) { detectedPrimary = t; best = counts[t]; }
  return { sectionsByType, availableTypes, detectedPrimary };
}

// Series + world + arc fields shared by every arc-level prompt context.
// Pulled out so verify-arc and verify-volume don't drift on what counts as
// "the bible block" — both passes must see the same series identity.
const SHAPE_GUIDANCE_NONE = '(no Vonnegut story shape selected — the verifier should not flag shape adherence)';

async function buildArcBaseContext(series, preloadedWorld) {
  const arc = series.arc || {};
  const world = await resolveWorldContext(series, preloadedWorld);
  const shapeGuidance = renderArcShapeGuidance(arc.shape) || SHAPE_GUIDANCE_NONE;
  return {
    series: {
      name: series.name,
      logline: series.logline,
      premise: series.premise,
    },
    ...world,
    arc: {
      logline: arc.logline || '',
      summary: arc.summary || '',
      protagonistArc: arc.protagonistArc || '',
      themesCsv: Array.isArray(arc.themes) ? arc.themes.join(', ') : '',
      shape: arc.shape || '',
    },
    shapeGuidance,
  };
}

// The `recommendedStructure` field encodes comic-as-TV norms (6–10 per
// season, single season ≤ 12, 3-season arc around 18–30) so the LLM stops
// defaulting to 3 seasons regardless of total count.
async function buildArcOverviewContext(series, preloadedWorld) {
  const structure = recommendStructure(series.issueCountTarget);
  const [world, canon] = await Promise.all([
    resolveWorldContext(series, preloadedWorld),
    getSeriesCanon(series),
  ]);
  const arc = series.arc || {};
  // Two-mode prompt: when arc.shape is set the prompt's `{{#pickedShapeId}}`
  // section fires (honor mode); when it's empty the `{{^pickedShapeId}}`
  // inverted section fires (propose mode). promptTemplate.js treats `''` as
  // falsy per Mustache spec, so the empty string is the right sentinel.
  const shapeGuidance = renderArcShapeGuidance(arc.shape)
    || `(no shape selected — you must propose one of: ${ARC_SHAPE_IDS.join(', ')}. Return your pick as the JSON field "shape". Choose the shape that best matches the premise's emotional trajectory.)`;
  return {
    series: {
      name: series.name,
      logline: series.logline,
      premise: series.premise,
      styleNotes: series.styleNotes,
      issueCountTarget: series.issueCountTarget,
    },
    ...world,
    recommendedStructure: structure
      ? describeStructure(structure)
      : '(no target episode count set — propose 1–3 volumes based on premise weight)',
    recommendedSeasonCount: structure ? structure.seasons : '',
    recommendedPerSeasonJson: structure ? JSON.stringify(structure.perSeason) : '[]',
    shapeGuidance,
    pickedShapeId: arc.shape || '',
    allowedShapeIdsCsv: ARC_SHAPE_IDS.join(', '),
    existingCharactersJson: JSON.stringify(canon.characters, null, 2),
    existingPlacesJson: JSON.stringify(canon.places, null, 2),
    existingObjectsJson: JSON.stringify(canon.objects, null, 2),
  };
}

/**
 * Coerce the LLM's `seasonOutlines[]` into a list of canonical Season records.
 * Reuses `buildSeason` so the new seasons get fresh sea-uuid ids + timestamps
 * + run through the sanitizer. Defensive — drops malformed entries silently
 * so a partial response doesn't crash the route layer.
 */
function shapeSeasonOutlines(rawOutlines) {
  if (!Array.isArray(rawOutlines)) return [];
  const out = [];
  for (const raw of rawOutlines) {
    const season = buildSeason({
      number: raw?.number,
      title: raw?.title,
      logline: raw?.logline,
      synopsis: raw?.synopsis,
      endingHook: raw?.endingHook,
      episodeCountTarget: raw?.episodeCountTarget,
    });
    if (season) out.push(season);
  }
  return out;
}

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
      modelOverride: options.modelOverride,
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
function issueSynopsisFromSeason(season) {
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
async function seedIssueSynopsis(issueId, synopsis) {
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

// ── Manuscript completeness ("finish the draft") ──────────────────────────
// Unlike verifyArc/verifyVolume (which read synopsis/beats from idea.input /
// idea.output), this pass reads the ACTUAL drafted manuscript (comicScript /
// prose / teleplay) so it can flag what's missing to FINISH a near-complete
// draft: gaps in content, holes in the arc, and under-developed characters.

// Findings carry a `category` on top of the verify shape so the UI can group
// them. Unknown categories collapse to 'other' rather than being dropped.
const COMPLETENESS_CATEGORIES = new Set([
  'missing-content', 'arc-gap', 'character-gap', 'pacing', 'continuity', 'comic-structure', 'other',
]);

function shapeCompletenessFindings(rawIssues) {
  if (!Array.isArray(rawIssues)) return [];
  const out = [];
  for (const raw of rawIssues) {
    const problem = typeof raw?.problem === 'string' ? raw.problem.trim() : '';
    if (!problem) continue;
    out.push({
      severity: VERIFY_SEVERITIES.has(raw?.severity) ? raw.severity : 'medium',
      category: COMPLETENESS_CATEGORIES.has(raw?.category) ? raw.category : 'other',
      location: typeof raw?.location === 'string' ? raw.location.trim().slice(0, 200) : '',
      problem: problem.slice(0, 2000),
      // comic-structure suggestions are full page rewrites (~4-6 panels); give them more room.
      suggestion: typeof raw?.suggestion === 'string' ? raw.suggestion.trim().slice(0, 8000) : '',
      // Structured anchor: lets the editor map a finding to its issue section
      // and jump to the verbatim excerpt. Both optional — older runs and
      // un-anchorable findings still render (just without click-to-jump).
      issueNumber: Number.isInteger(raw?.issueNumber) ? raw.issueNumber : null,
      anchorQuote: typeof raw?.anchorQuote === 'string' ? raw.anchorQuote.trim().slice(0, 400) : '',
    });
  }
  return out;
}

async function buildCompletenessContext(series, manuscript, preloadedWorld) {
  const [base, canon] = await Promise.all([
    buildArcBaseContext(series, preloadedWorld),
    getSeriesCanon(series),
  ]);
  return {
    ...base,
    manuscript,
    existingCharactersJson: JSON.stringify(canon.characters, null, 2),
    existingPlacesJson: JSON.stringify(canon.places, null, 2),
    existingObjectsJson: JSON.stringify(canon.objects, null, 2),
  };
}

const COMPLETENESS_STAGE = 'pipeline-manuscript-completeness';
// Output room for the findings list; comic-structure suggestions are full page
// rewrites, so reserve generously.
const COMPLETENESS_OUTPUT_RESERVE_TOKENS = 6_000;
// Earlier-chapter findings summarized into the rolling digest fed to later
// chunks, and the char cap on that digest (kept small so it fits the margin).
const COMPLETENESS_PRIOR_DIGEST_MAX = 40;
const COMPLETENESS_PRIOR_DIGEST_CHARS = 2_000;

// One-line digest of prior-chunk findings so later chunks keep cross-chapter
// continuity in view. Rides INSIDE the manuscript field, so the prompt template
// is unchanged (no migration).
function priorFindingsDigest(findings) {
  if (!findings.length) return '';
  const lines = findings.slice(0, COMPLETENESS_PRIOR_DIGEST_MAX).map((f) => {
    const where = Number.isInteger(f.issueNumber) ? `Issue ${f.issueNumber}` : (f.location || 'general');
    return `- [${where}] ${f.category}: ${f.problem}`;
  });
  const more = findings.length > COMPLETENESS_PRIOR_DIGEST_MAX
    ? `\n(+${findings.length - COMPLETENESS_PRIOR_DIGEST_MAX} more earlier findings)` : '';
  const body = `${lines.join('\n')}${more}`.slice(0, COMPLETENESS_PRIOR_DIGEST_CHARS);
  return `# Editorial findings already recorded for EARLIER chapters\n`
    + `Do not repeat these. Flag only NEW gaps in the chapters below, plus any cross-chapter `
    + `continuity problems these earlier findings reveal.\n\n${body}\n\n---\n\n`;
}

// First-wins dedupe key across chunks — a finding identical on (issue,
// category, anchor, problem) is recorded once even if two chunks surface it.
const findingKey = (f) => [
  f.issueNumber ?? '',
  f.category,
  (f.anchorQuote || '').trim().toLowerCase().slice(0, 120),
  (f.problem || '').trim().toLowerCase().slice(0, 120),
].join('|');

/**
 * Editor pass over the drafted manuscript itself: returns categorized
 * suggestions for rounding out and finishing a near-complete draft — missing
 * pages/beats, arc holes, and character-development gaps. Read-only; advisory
 * (no auto-resolve). Complements verifyArc/verifyVolume, which stay at synopsis
 * depth and never see the script.
 *
 * Context-window-aware: when the whole manuscript + canon context fits the
 * target model's window it runs in one call (frontier models hold the entire
 * book); otherwise it chunks by issue, feeds each chunk a digest of prior-chunk
 * findings for continuity, and merges with first-wins dedupe.
 */
export async function analyzeManuscriptCompleteness(seriesId, options = {}) {
  const series = await getSeries(seriesId);
  // Manuscript-only: exclude `idea` so an outline/synopsis seed can't pass the
  // guard below and get graded as if it were a drafted manuscript.
  const sections = await collectManuscriptSections(seriesId, { stageOrder: MANUSCRIPT_STAGES });
  if (!sections.length) {
    throw makeErr(
      'No manuscript to analyze — write a comic script, prose, or teleplay on at least one issue first',
      ERR_VALIDATION,
    );
  }

  // Base (non-manuscript) context is fixed overhead present in every call.
  const baseCtx = await buildCompletenessContext(series, '', options.preloadedWorld);
  const overheadTokens = estimateTokens(JSON.stringify(baseCtx)) + 2_000; // + template/instructions
  const { contextWindow } = await resolveStageContext(COMPLETENESS_STAGE, {
    providerOverride: options.providerOverride,
    modelOverride: options.modelOverride,
  });
  const plan = planManuscriptPass({
    contextWindow,
    sections: sections.map((s) => ({ ...s, text: `${manuscriptSectionHeader(s)}\n\n${s.content}` })),
    overheadTokens,
    outputReserveTokens: COMPLETENESS_OUTPUT_RESERVE_TOKENS,
  });

  const runOne = (manuscript) => runStagedLLM(COMPLETENESS_STAGE, { ...baseCtx, manuscript }, {
    providerOverride: options.providerOverride,
    modelOverride: options.modelOverride,
    returnsJson: true,
    source: 'pipeline-manuscript-completeness',
  });

  if (plan.mode === 'whole') {
    const { content, runId, providerId, model } = await runOne(sectionsCorpus(sections).slice(0, plan.usableChars));
    return { issues: shapeCompletenessFindings(content?.issues), raw: content, runId, providerId, model, chunked: false, chunkCount: 1 };
  }

  console.log(`📚 completeness: chunked review series=${String(seriesId).slice(0, 12)} chunks=${plan.chunks.length} window=${contextWindow ?? 'floor'}`);
  // Accumulate findings into one first-wins map so the per-chunk digest is O(1)
  // to derive (no re-merging every prior chunk).
  const merged = new Map();
  let first = null;
  for (const chunk of plan.chunks) {
    const digest = priorFindingsDigest([...merged.values()]);
    const corpus = sectionsCorpus(chunk.sections).slice(0, plan.usableChars);
    const result = await runOne(`${digest}${corpus}`);
    if (!first) first = result;
    for (const f of shapeCompletenessFindings(result.content?.issues)) {
      const k = findingKey(f);
      if (!merged.has(k)) merged.set(k, f);
    }
  }
  const issues = [...merged.values()];
  return {
    issues,
    raw: { issues },
    runId: first?.runId,
    providerId: first?.providerId,
    model: first?.model,
    chunked: true,
    chunkCount: plan.chunks.length,
  };
}

// Reader-map context: the protagonist arc + the Vonnegut shape backbone + the
// planned volume boundaries (so the LLM can place cliffhangers at issue gaps).
// Mirrors buildArcOverviewContext's world+arc projection.
async function buildReaderMapContext(series, preloadedWorld) {
  const arc = series.arc || {};
  const world = await resolveWorldContext(series, preloadedWorld);
  const seasons = Array.isArray(series.seasons) ? series.seasons : [];
  const issueBoundaries = seasons.length === 0
    ? '(no volumes planned yet — pace hooks/payoffs across a single-volume arc)'
    : seasons
      .slice()
      .sort((a, b) => (a.number || 0) - (b.number || 0))
      .map((s) => `Volume ${s.number} — ${s.title || 'Untitled'} (~${s.episodeCountTarget || '?'} issues): ${s.logline || '(no logline)'}`)
      .join('\n');
  return {
    series: { name: series.name, logline: series.logline, premise: series.premise },
    ...world,
    arc: {
      logline: arc.logline || '',
      summary: arc.summary || '',
      protagonistArc: arc.protagonistArc || '',
      themesCsv: Array.isArray(arc.themes) ? arc.themes.join(', ') : '',
      shape: arc.shape || '',
    },
    shapeGuidance: renderArcShapeGuidance(arc.shape) || SHAPE_GUIDANCE_NONE,
    issueBoundaries,
    beatKindsCsv: READER_MAP_BEAT_KINDS.join(', '),
    existingReaderMapJson: arc.readerMap ? JSON.stringify(arc.readerMap, null, 2) : '(none yet)',
  };
}

// The reader map is authored AFTER the plot arc is approved, so a frozen arc
// (`locked.arc`, which protects the core arc fields from the arc-overview
// regenerator) must NOT block reader-map work — only the reader-map field lock
// (`locked.arcFields.readerMap`) does. The locked arc is read as INPUT here.
function assertReaderMapUnlocked(series) {
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
      modelOverride: options.modelOverride,
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
      shapeGuidance: renderArcShapeGuidance(arc.shape) || SHAPE_GUIDANCE_NONE,
      beatKindsCsv: READER_MAP_BEAT_KINDS.join(', '),
    },
    options,
    source: 'story-builder-reader-map-refine',
    logTag: `Story Builder reader-map refine series=${seriesId.slice(0, 8)}`,
  });
  const readerMap = sanitizeReaderMap({ ...content, status: 'draft' });
  // Refine is meant to PRESERVE — never let an empty LLM payload null out the
  // existing map. Fall back to the current reader map when the refine produced
  // nothing usable (mirrors the CLAUDE.md absent-vs-empty rule).
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
      shapeGuidance: renderArcShapeGuidance(arc.shape) || SHAPE_GUIDANCE_NONE,
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

/**
 * Build the context for one season's episode breakdown. `priorSeasonsContext`
 * gives the LLM granular per-episode continuity — without it the verifier and
 * planner only see season-level synopses and can't catch beat-level contradictions.
 */
async function buildSeasonEpisodesContext(series, season, priorSeasons, priorIssues = [], preloadedWorld) {
  const arc = series.arc || {};
  const themesCsv = Array.isArray(arc.themes) ? arc.themes.join(', ') : '';
  const priorSeasonsContext = priorSeasons.length === 0
    ? '(this is the first season — no prior context)'
    : priorSeasons.map((s) => renderPriorSeason(s, priorIssues)).join('\n\n');
  const [world, canon] = await Promise.all([
    resolveWorldContext(series, preloadedWorld),
    getSeriesCanon(series),
  ]);
  const totalSeasons = (series.seasons || []).length || 1;
  const arcGuidance = renderArcShapeGuidance(arc.shape) || SHAPE_GUIDANCE_NONE;
  const shapePosition = renderArcShapePositionSummary(arc.shape, season.number, totalSeasons)
    || '(no story shape selected — pace episode beats by arcRole only)';
  return {
    series: {
      name: series.name,
      logline: series.logline,
      premise: series.premise,
      styleNotes: series.styleNotes,
    },
    ...world,
    arc: {
      logline: arc.logline || '',
      protagonistArc: arc.protagonistArc || '',
      themesCsv,
      shape: arc.shape || '',
    },
    shapeGuidance: arcGuidance,
    shapePosition,
    priorSeasonsContext,
    season: {
      number: season.number,
      title: season.title,
      logline: season.logline,
      synopsis: season.synopsis,
      endingHook: season.endingHook,
      episodeCountTarget: season.episodeCountTarget,
    },
    existingCharactersJson: JSON.stringify(canon.characters, null, 2),
    existingPlacesJson: JSON.stringify(canon.places, null, 2),
    existingObjectsJson: JSON.stringify(canon.objects, null, 2),
  };
}

/**
 * Shape `episodes[]` from the LLM into the canonical issue-like preview
 * shape. We do NOT persist here — the route layer creates the issues via
 * `createIssue` so a preview/confirm flow can land in Phase 4.
 *
 * Drops entries with no title, clamps `number` >= 1, and validates `arcRole`
 * against the controlled vocab the prompt promised. An invalid `arcRole`
 * collapses to `null` rather than the entry being rejected — the rest of the
 * episode metadata is still useful.
 */
function shapeEpisodes(rawEpisodes) {
  if (!Array.isArray(rawEpisodes)) return [];
  const out = [];
  let nextNumber = 1;
  for (const raw of rawEpisodes) {
    const title = typeof raw?.title === 'string' ? raw.title.trim().slice(0, 300) : '';
    if (!title) continue;
    const number = Number.isFinite(raw?.number) && raw.number > 0
      ? Math.floor(raw.number)
      : nextNumber;
    nextNumber = number + 1;
    const arcRole = ARC_ROLES.has(raw?.arcRole) ? raw.arcRole : null;
    // Episode-level length sizing — fed straight into the issue's
    // lengthProfile when the route creates issues from this preview. Only the
    // concrete presets are accepted here (no 'custom' sentinel — the LLM is
    // never asked to invent custom page/minute targets, and a 'custom' value
    // without companion numbers silently degrades to 'standard' downstream).
    // The fallback is derived from arcRole so a finale episode still sizes
    // like a finale when the LLM omits the field.
    const lengthProfile = SEASON_LENGTH_PRESETS.has(raw?.lengthProfile)
      ? raw.lengthProfile
      : lengthProfileForArcRole(arcRole);
    const primaryCharacters = Array.isArray(raw?.primaryCharacters)
      ? raw.primaryCharacters.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim().slice(0, 200)).slice(0, 12)
      : [];
    out.push({
      number,
      title,
      logline: typeof raw?.logline === 'string' ? raw.logline.trim().slice(0, 500) : '',
      synopsis: typeof raw?.synopsis === 'string' ? raw.synopsis.trim().slice(0, 4000) : '',
      primaryCharacters,
      arcRole,
      lengthProfile,
    });
  }
  return out;
}

export async function generateSeasonEpisodes(seriesId, seasonId, options = {}) {
  const series = await getSeries(seriesId);
  const seasons = series.seasons || [];
  const season = seasons.find((s) => s.id === seasonId);
  if (!season) {
    throw makeErr(`Season not found on series: ${seasonId}`, ERR_VALIDATION);
  }
  // Per-season lock — same semantics as the arc-level lock above, scoped to
  // this volume. Generating episodes seeds new issue records under the
  // season; a locked season's shape is frozen, so refuse before the LLM call.
  // Verify (read-only) stays available so the user can still inspect findings.
  if (season.locked === true) {
    throw makeErr(
      `Season "${season.title || season.number}" is locked — unlock it before generating episodes`,
      ERR_VALIDATION,
    );
  }
  // A season with no synopsis + no logline gives the LLM nothing to riff
  // against — fail loud so the user sees the misconfiguration instead of
  // getting back 8 episodes of "a thing happens then another thing".
  if (!season.synopsis?.trim() && !season.logline?.trim()) {
    throw makeErr(
      `Season "${season.title || season.number}" has no synopsis or logline — fill at least one before generating episodes`,
      ERR_VALIDATION,
    );
  }
  // Prior-seasons context for continuity. Strict number-ordering rather than
  // id-ordering because seasons[] is already sorted by number in the
  // sanitizer; this matches what the user is editing on screen.
  const priorSeasons = seasons.filter((s) => (s.number || 0) < (season.number || 0));

  let priorIssues = [];
  if (priorSeasons.length > 0) {
    const priorIds = new Set(priorSeasons.map((s) => s.id));
    const all = await listIssues({ seriesId });
    priorIssues = all.filter((iss) => iss.seasonId && priorIds.has(iss.seasonId));
  }

  const ctx = await buildSeasonEpisodesContext(series, season, priorSeasons, priorIssues);
  const { content, runId, providerId, model } = await runStagedLLM(
    'pipeline-season-episodes',
    ctx,
    {
      providerOverride: options.providerOverride,
      modelOverride: options.modelOverride,
      returnsJson: true,
      source: 'pipeline-season-episodes',
    },
  );
  const episodes = shapeEpisodes(content?.episodes);
  return {
    season,
    episodes,
    raw: content,
    runId,
    providerId,
    model,
  };
}

/**
 * Persist a season's generated episodes as issue records — one issue per
 * episode, with the season pointer + arcPosition + arcRole + length profile
 * forwarded so the downstream auto-run-text chain has a seed to expand
 * against. Shared by the pipeline season-episodes route and the Story
 * Builder's "generate issues from arc" action so both mint byte-identical
 * issue shapes. The episode's logline + synopsis land in `stages.idea.input`.
 */
export async function commitEpisodesToIssues(seriesId, seasonId, episodes = [], { preloadedSeries = null } = {}) {
  // Fetch the series once for the whole batch (unless the caller already holds
  // it) and thread it into each createIssue's renumber pass. The series record
  // doesn't change as issues are appended, so an N-episode season otherwise
  // pays N redundant getSeries reads of an unchanging record.
  const series = preloadedSeries || await getSeries(seriesId).catch(() => null);
  const created = [];
  for (const ep of episodes) {
    const issue = await createIssue({
      seriesId,
      title: ep.title,
      // Issue `number` is derived from (volume order, arcPosition) by
      // `createIssue`'s renumber pass — a new episode falls into its volume's
      // slot and later volumes' numbers shift to make room.
      seasonId,
      arcPosition: ep.number,
      // `arcRole` carries the LLM's pilot / complication / midpoint / etc.
      // classification forward so the idea-expansion prompt can size beats to
      // the role (a finale needs a different cadence than a complication).
      arcRole: ep.arcRole,
      // Episode-level length sizing from the season-episodes LLM pass.
      // Defaults to 'standard' inside the issue sanitizer when missing.
      lengthProfile: ep.lengthProfile,
      stages: {
        idea: {
          status: ep.synopsis ? 'edited' : 'empty',
          input: [ep.logline, ep.synopsis].filter(Boolean).join('\n\n'),
        },
      },
    }, { preloadedSeries: series });
    created.push(issue);
  }
  return created;
}

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

/**
 * Build the verify-pass context — a JSON-encoded tree of seasons + their
 * child issues so the LLM has a single structural blob to scan. Issues are
 * looked up via `listIssues` so the verify pass sees the *current* set, not
 * a stale snapshot.
 */
async function buildVerifyContext(series, preloadedWorld) {
  const seasons = sanitizeSeasonList(series.seasons || []);
  const [issues, base, canon] = await Promise.all([
    listIssues({ seriesId: series.id }),
    buildArcBaseContext(series, preloadedWorld),
    getSeriesCanon(series),
  ]);
  // Group issues by seasonId so the tree's leaf order matches the seasons'
  // arcPosition order. Ungrouped issues land in a `null` bucket so the LLM
  // sees them too.
  const issuesBySeason = new Map();
  for (const iss of issues) {
    const key = iss.seasonId || null;
    if (!issuesBySeason.has(key)) issuesBySeason.set(key, []);
    // `synopsis` key (not `beats`) so it matches the prompt's existing
    // language; sourced from idea.input which carries the LLM's logline+synopsis.
    const synopsis = (iss.stages?.idea?.input || '').trim();
    issuesBySeason.get(key).push({
      number: iss.number,
      title: iss.title,
      status: iss.status,
      arcPosition: iss.arcPosition,
      synopsis: synopsis || null,
    });
  }
  for (const list of issuesBySeason.values()) {
    list.sort(compareIssuesByPosition);
  }
  const tree = seasons.map((s) => ({
    number: s.number,
    title: s.title,
    logline: s.logline,
    synopsis: s.synopsis,
    endingHook: s.endingHook,
    episodeCountTarget: s.episodeCountTarget,
    themes: s.themes,
    status: s.status,
    episodes: issuesBySeason.get(s.id) || [],
  }));
  const ungrouped = issuesBySeason.get(null) || [];
  if (ungrouped.length) {
    tree.push({
      number: null,
      title: '(ungrouped issues)',
      episodes: ungrouped,
    });
  }
  return {
    ...base,
    seasonsTreeJson: JSON.stringify(tree, null, 2),
    existingCharactersJson: JSON.stringify(canon.characters, null, 2),
    existingPlacesJson: JSON.stringify(canon.places, null, 2),
    existingObjectsJson: JSON.stringify(canon.objects, null, 2),
  };
}

/**
 * Shape verify-pass issues. Drops malformed entries (no problem, invalid
 * severity) so a partial LLM response doesn't trash the route response.
 */
function shapeVerifyIssues(rawIssues) {
  if (!Array.isArray(rawIssues)) return [];
  const out = [];
  for (const raw of rawIssues) {
    const problem = typeof raw?.problem === 'string' ? raw.problem.trim() : '';
    if (!problem) continue;
    const severity = VERIFY_SEVERITIES.has(raw?.severity) ? raw.severity : 'medium';
    out.push({
      severity,
      location: typeof raw?.location === 'string' ? raw.location.trim().slice(0, 200) : '',
      problem: problem.slice(0, 2000),
      suggestion: typeof raw?.suggestion === 'string' ? raw.suggestion.trim().slice(0, 2000) : '',
    });
  }
  return out;
}

export async function verifyArc(seriesId, options = {}) {
  const series = await getSeries(seriesId);
  if (!series.arc) {
    throw new ServerError(
      'Series has no arc to verify — run /arc/generate first',
      { status: 400, code: 'PIPELINE_NO_ARC' },
    );
  }
  const ctx = await buildVerifyContext(series, options.preloadedWorld);
  const { content, runId, providerId, model } = await runStagedLLM(
    'pipeline-arc-verify',
    ctx,
    {
      providerOverride: options.providerOverride,
      modelOverride: options.modelOverride,
      returnsJson: true,
      source: 'pipeline-arc-verify',
    },
  );
  const issues = shapeVerifyIssues(content?.issues);
  return { issues, raw: content, runId, providerId, model };
}

// Set exactly one of `beats` / `synopsis` so the prompt's beat-level checks
// don't run against synopsis-only issues (and vice-versa). Beats land in
// idea.output once the LLM-expand pass runs; before that, idea.input still
// carries the seed synopsis.
function renderVolumeIssue(iss) {
  const beats = (iss.stages?.idea?.output || '').trim();
  const synopsis = (iss.stages?.idea?.input || '').trim();
  const base = {
    number: iss.number,
    title: iss.title,
    status: iss.status,
    arcPosition: iss.arcPosition,
  };
  if (beats) return { ...base, beats };
  return { ...base, synopsis: synopsis || null };
}

// Neighbor volumes — only the immediately-prior and immediately-next season
// (by `number`) — so the LLM can check boundary continuity (#5 in the
// prompt) without ballooning the context. Excludes the volume under review.
function buildNeighborVolumes(allSeasons, currentSeasonId) {
  const sorted = (allSeasons || [])
    .filter((s) => s && s.id)
    .slice()
    .sort((a, b) => (a.number || 0) - (b.number || 0));
  const idx = sorted.findIndex((s) => s.id === currentSeasonId);
  if (idx < 0) return [];
  const out = [];
  if (idx > 0) out.push({ position: 'prior', ...sliceSeasonForNeighbor(sorted[idx - 1]) });
  if (idx < sorted.length - 1) out.push({ position: 'next', ...sliceSeasonForNeighbor(sorted[idx + 1]) });
  return out;
}

function sliceSeasonForNeighbor(s) {
  return {
    number: s.number,
    title: s.title,
    logline: s.logline || '',
    synopsis: s.synopsis || '',
    endingHook: s.endingHook || '',
  };
}

async function buildVolumeVerifyContext(series, season, preloadedWorld) {
  const [allIssues, base] = await Promise.all([
    listIssues({ seriesId: series.id }),
    buildArcBaseContext(series, preloadedWorld),
  ]);
  const volumeIssues = allIssues
    .filter((iss) => iss.seasonId === season.id)
    .sort(compareIssuesByPosition)
    .map(renderVolumeIssue);
  // Volume-specific curve placement layered on top of base's arc-wide
  // shapeGuidance so the verifier can flag "this volume inverts the expected
  // fortune at its position."
  const totalSeasons = (series.seasons || []).length || 1;
  const volumeShapePosition = renderArcShapePositionSummary(series.arc?.shape, season.number, totalSeasons)
    || '(no story shape selected — do not flag shape adherence for this volume)';
  return {
    ...base,
    volume: {
      number: season.number ?? '',
      title: season.title || '',
      logline: season.logline || '',
      synopsis: season.synopsis || '',
      endingHook: season.endingHook || '',
      episodeCountTarget: season.episodeCountTarget ?? '',
      themesCsv: Array.isArray(season.themes) ? season.themes.join(', ') : '',
    },
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
  const ctx = await buildVolumeVerifyContext(series, season, options.preloadedWorld);
  const { content, runId, providerId, model } = await runStagedLLM(
    'pipeline-volume-verify',
    ctx,
    {
      providerOverride: options.providerOverride,
      modelOverride: options.modelOverride,
      returnsJson: true,
      source: 'pipeline-volume-verify',
    },
  );
  const issues = shapeVerifyIssues(content?.issues);
  return { issues, raw: content, runId, providerId, model, seasonId };
}

async function buildResolveContext(series, findings, preloadedWorld) {
  const ctx = await buildVerifyContext(series, preloadedWorld);
  const structure = recommendStructure(series.issueCountTarget);
  return {
    ...ctx,
    findingsJson: JSON.stringify(findings, null, 2),
    recommendedStructure: structure
      ? describeStructure(structure)
      : '(no target episode count set)',
    recommendedSeasonCount: structure ? structure.seasons : '',
    recommendedPerSeasonJson: structure ? JSON.stringify(structure.perSeason) : '[]',
  };
}

const RESOLVE_FINDING_MAX = 50;

function shapeFindings(rawFindings) {
  if (!Array.isArray(rawFindings)) return [];
  const out = [];
  for (const f of rawFindings) {
    const problem = typeof f?.problem === 'string' ? f.problem.trim() : '';
    if (!problem) continue;
    out.push({
      severity: VERIFY_SEVERITIES.has(f?.severity) ? f.severity : 'medium',
      location: typeof f?.location === 'string' ? f.location.trim().slice(0, 200) : '',
      problem: problem.slice(0, 2000),
      suggestion: typeof f?.suggestion === 'string' ? f.suggestion.trim().slice(0, 2000) : '',
    });
    if (out.length >= RESOLVE_FINDING_MAX) break;
  }
  return out;
}

// Per-episode (issue) records are NOT touched — those are user-owned scripts
// and shouldn't get clobbered by a structural fix. If a finding's only
// actionable resolution would require deleting issues, the LLM is told to
// flag that in the response's `notes` field rather than executing it.
// `options.findings` empty / omitted = re-run verify first and resolve
// everything it returns.
export async function resolveVerifyIssues(seriesId, options = {}) {
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
    const fresh = await verifyArc(seriesId, { ...options, preloadedWorld: world });
    findings = fresh.issues || [];
    if (!findings.length) {
      return { series, applied: false, notes: 'No findings to resolve', findings: [] };
    }
  }

  const ctx = await buildResolveContext(series, findings, world);
  const { content, runId, providerId, model } = await runStagedLLM(
    'pipeline-arc-resolve',
    ctx,
    {
      providerOverride: options.providerOverride,
      modelOverride: options.modelOverride,
      returnsJson: true,
      source: 'pipeline-arc-resolve',
    },
  );

  const arc = sanitizeArc({
    logline: content?.arc?.logline || series.arc.logline || '',
    summary: content?.arc?.summary || series.arc.summary || '',
    themes: content?.arc?.themes ?? series.arc.themes,
    protagonistArc: content?.arc?.protagonistArc ?? series.arc.protagonistArc ?? '',
    shape: content?.arc?.shape ?? series.arc.shape ?? null,
    // The resolve prompt doesn't author the reader map — preserve any existing
    // one so auto-resolve never silently wipes a reader map the user already
    // built on the next step. Mirrors `generateArcOverview` above.
    readerMap: series.arc?.readerMap ?? null,
    status: 'draft',
  });

  // Round-trip the LLM's seasons through `buildSeason` if they include a
  // brand-new entry (no `id`), otherwise preserve the existing `id` so child
  // issues still join their season cleanly. The sanitizer enforces the
  // canonical shape regardless.
  const existingById = new Map((series.seasons || []).map((s) => [s.id, s]));
  const proposedSeasons = Array.isArray(content?.seasons) ? content.seasons : [];
  // Track each entry's provenance (existing id vs freshly minted) so we can
  // remap orphaned child issues after sanitization.
  const seasonEntries = proposedSeasons.map((raw) => {
    const existing = raw?.id ? existingById.get(raw.id) : null;
    if (existing) {
      return {
        season: sanitizeSeason({
          ...existing,
          title: typeof raw.title === 'string' ? raw.title : existing.title,
          number: Number.isFinite(raw.number) ? raw.number : existing.number,
          logline: typeof raw.logline === 'string' ? raw.logline : existing.logline,
          synopsis: typeof raw.synopsis === 'string' ? raw.synopsis : existing.synopsis,
          endingHook: typeof raw.endingHook === 'string' ? raw.endingHook : existing.endingHook,
          episodeCountTarget: Number.isFinite(raw.episodeCountTarget)
            ? raw.episodeCountTarget
            : existing.episodeCountTarget,
          themes: Array.isArray(raw.themes) ? raw.themes : existing.themes,
        }),
        sourceId: existing.id,
      };
    }
    return {
      season: buildSeason({
        number: raw?.number,
        title: raw?.title,
        logline: raw?.logline,
        synopsis: raw?.synopsis,
        endingHook: raw?.endingHook,
        episodeCountTarget: raw?.episodeCountTarget,
      }),
      sourceId: null,
    };
  }).filter((entry) => entry?.season);

  const seasons = sanitizeSeasonList(seasonEntries.map((e) => e.season));

  const { series: updated } = await commitSeasonsWithRemap(series, { arc, seasons });

  const notes = typeof content?.notes === 'string' ? content.notes.trim().slice(0, 2000) : '';
  return {
    series: updated,
    applied: true,
    notes,
    findings,
    runId,
    providerId,
    model,
  };
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
 */
export async function commitSeasonsWithRemap(currentSeries, { arc, seasons }) {
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
  const mergedSeasons = sanitizeSeasonList(
    mergeSeasonsWithLocks(latestSeries.seasons, seasons),
  );
  const newIds = new Set(mergedSeasons.map((s) => s.id));
  const droppedOldSeasons = (latestSeries.seasons || []).filter((s) => !newIds.has(s.id));
  const oldIds = new Set((latestSeries.seasons || []).map((s) => s.id));
  const newlyMintedSeasons = mergedSeasons.filter((s) => !oldIds.has(s.id));
  const remap = buildSeasonRemap(droppedOldSeasons, newlyMintedSeasons);
  const droppedIdSet = new Set(droppedOldSeasons.map((s) => s.id));
  const reassignList = droppedIdSet.size
    ? (await listIssues({ seriesId })).filter((iss) => droppedIdSet.has(iss.seasonId))
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
      // don't leak through). Note: per PLAN.md
      // [ansistrip-osc-alternative-unreachable], OSC sequence bodies do leak
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

// Export internals for tests.
export const __testing = {
  buildArcOverviewContext,
  buildSeasonEpisodesContext,
  buildVerifyContext,
  buildVolumeVerifyContext,
  buildResolveContext,
  shapeSeasonOutlines,
  shapeEpisodes,
  shapeVerifyIssues,
  shapeFindings,
  shapeCompletenessFindings,
  buildCompletenessContext,
  issueSynopsisFromSeason,
  renderVolumeIssue,
  buildNeighborVolumes,
  mergeArcWithLocks,
  mergeSeasonsWithLocks,
};
