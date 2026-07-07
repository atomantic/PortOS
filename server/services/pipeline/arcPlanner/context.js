/**
 * arcPlanner/context.js — shared context-building + collection helpers.
 *
 * Leaf layer of the arcPlanner decomposition (issue #1152): error helpers,
 * world-context loading, manuscript/issue collectors, prompt context
 * builders, and the verify/resolve finding shapers. Imports nothing from
 * the other arcPlanner modules — they all import from here.
 */

import { MANUSCRIPT_TYPES } from '../series.js';
import { listIssues, STAGE_INPUT_MAX } from '../issues.js';
import { ARC_ROLES as ARC_ROLE_LIST, ARC_SHAPE_IDS, READER_MAP_BEAT_KINDS, buildSeason, renderArcShapeGuidance, renderTickingClock, sanitizeSeasonList } from '../../../lib/storyArc.js';
import { composeStyleNotes } from '../../../lib/styleGuide.js';
import { describeStructure, recommendStructure } from '../../../lib/seasonStructure.js';
import { DEFAULT_LENGTH_PROFILE, LENGTH_PROFILE_NAMES } from '../../../lib/issueLength.js';
import { getUniverse } from '../../universeBuilder.js';
import { getSeriesCanon } from '../seriesCanon.js';
import { renderCanonForPrompt, renderCategoriesForPrompt, renderCompositesForPrompt, renderEntitiesSummary } from '../../../lib/universePromptRenderers.js';

export const ERR_VALIDATION = 'PIPELINE_ARC_VALIDATION';

export const makeErr = (message, code) => Object.assign(new Error(message), { code });

export const VERIFY_SEVERITIES = new Set(['high', 'medium', 'low']);

export const ARC_ROLES = new Set(ARC_ROLE_LIST);

// Season-episode generation must produce concrete preset profiles only — the
// 'custom' sentinel needs companion pageTarget/minutesTarget values the LLM is
// not asked to invent, so a 'custom' here would silently render as 'standard'
// at prompt time. Limit to the canonical preset names.
export const SEASON_LENGTH_PRESETS = new Set(LENGTH_PROFILE_NAMES.filter((n) => n !== 'custom'));

// Finale-role episodes should size like a finale even when the LLM omits
// (or misspells) lengthProfile. Other arcRoles fall back to the default
// profile so a missing/misspelled length doesn't cascade into the wrong
// size for the whole arc.
export const lengthProfileForArcRole = (arcRole) => (arcRole === 'finale' ? 'finale' : DEFAULT_LENGTH_PROFILE);

// Each prior season renders as its header (logline + synopsis) plus the
// committed per-episode beats from `stages.idea.input` — that field was
// seeded with the LLM's `logline + synopsis` at episode-generate time.
export function renderPriorSeason(s, priorIssues) {
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
export async function loadWorldContext(universeId) {
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
export const EMPTY_WORLD_CONTEXT = {
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
export async function resolveWorldContext(series, preloaded) {
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
export const BACKFILL_SOURCE_MAX = 200_000;

// Local copy of textStages' stageContentOf. Inlined (not imported) because
// textStages.js imports from THIS module (compareIssuesByPosition,
// NO_LINKED_UNIVERSE_PLACEHOLDER) — importing back would create a cycle whose
// binding is undefined at module-eval time. The one-liner is stable.
// output (the generated/edited artifact) before input (the upstream seed): for
// back-derivation we want the most-developed text, so a prose stage with both a
// beat-sheet seed (input) and a drafted manuscript (output) yields the draft.
// (textStages.stageContentOf is input-first because it answers a different
// question — "does this stage have ANY content to use as a generation source".)
export const stageTextOf = (stage) => (stage?.output?.trim() || stage?.input?.trim() || '');

// The drafted-manuscript stages, in precedence order. Single source of truth is
// `MANUSCRIPT_TYPES` in series.js (which series.js needs for the bible field and
// arcPlanner already imports — so no new cycle). Re-exported under the
// historical name for the existing importers.
export const MANUSCRIPT_STAGES = MANUSCRIPT_TYPES;

// Default stage precedence: the richest authored artifact per issue. `idea`
// (the outline/synopsis seed) is the lowest-priority fallback — it lets an
// arc be back-derived from outlines alone. Callers that specifically mean
// "the DRAFTED MANUSCRIPT" must pass MANUSCRIPT_STAGES to exclude it.
export const SOURCE_STAGE_ORDER = [...MANUSCRIPT_STAGES, 'idea'];

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
      // `seasonId` (additive) lets the prose-export packager group issues into
      // volume breaks; existing corpus/completeness callers ignore it.
      seasonId: iss.seasonId || null,
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
export const SHAPE_GUIDANCE_NONE = '(no Vonnegut story shape selected — the verifier should not flag shape adherence)';

// Append the ticking-clock guidance (only when the clock is enabled) to an
// arc-level shape-guidance block. Every arc/reader-map prompt already renders
// `{{{shapeGuidance}}}`, so folding the countdown in here surfaces it to
// generation without adding a new template variable — and therefore without a
// stage-prompt migration. Returns the guidance unchanged when there's no
// enabled clock.
export function appendTickingClock(shapeGuidance, arc) {
  const clock = renderTickingClock(arc?.tickingClock);
  return clock ? `${shapeGuidance}\n\n${clock}` : shapeGuidance;
}

export async function buildArcBaseContext(series, preloadedWorld) {
  const arc = series.arc || {};
  const world = await resolveWorldContext(series, preloadedWorld);
  const shapeGuidance = appendTickingClock(renderArcShapeGuidance(arc.shape) || SHAPE_GUIDANCE_NONE, arc);
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
export async function buildArcOverviewContext(series, preloadedWorld) {
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
  const shapeGuidance = appendTickingClock(
    renderArcShapeGuidance(arc.shape)
      || `(no shape selected — you must propose one of: ${ARC_SHAPE_IDS.join(', ')}. Return your pick as the JSON field "shape". Choose the shape that best matches the premise's emotional trajectory.)`,
    arc,
  );
  return {
    series: {
      name: series.name,
      logline: series.logline,
      premise: series.premise,
      // Structured style guide folded into the free-text notes (see
      // composeStyleNotes) so arc generation respects house style without a
      // new template variable / migration.
      styleNotes: composeStyleNotes(series),
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
export function shapeSeasonOutlines(rawOutlines) {
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

// Reader-map context: the protagonist arc + the Vonnegut shape backbone + the
// planned volume boundaries (so the LLM can place cliffhangers at issue gaps).
// Mirrors buildArcOverviewContext's world+arc projection.
export async function buildReaderMapContext(series, preloadedWorld) {
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
    shapeGuidance: appendTickingClock(renderArcShapeGuidance(arc.shape) || SHAPE_GUIDANCE_NONE, arc),
    issueBoundaries,
    beatKindsCsv: READER_MAP_BEAT_KINDS.join(', '),
    existingReaderMapJson: arc.readerMap ? JSON.stringify(arc.readerMap, null, 2) : '(none yet)',
  };
}

/**
 * Build the verify-pass context — a JSON-encoded tree of seasons + their
 * child issues so the LLM has a single structural blob to scan. Issues are
 * looked up via `listIssues` so the verify pass sees the *current* set, not
 * a stale snapshot.
 */
// Group issues into the season→episode tree both verify passes feed the LLM.
// Mechanically shared shape: issues bucket by `seasonId` (an `null` bucket for
// ungrouped issues so the LLM still sees them), each bucket sorted by
// arcPosition, then mapped onto the season list with an appended
// `(ungrouped issues)` node. Callers supply the two things that diverge:
//   - `renderLeaf(iss)` — how each issue renders (synopsis-object vs. beats)
//   - `seasonFields(s)` — the per-season metadata (verify carries `status`,
//     the beat pass does not); `episodes` is always appended last so the JSON
//     key order matches the previous hand-rolled builders byte-for-byte.
export function groupIssuesBySeasonTree(seasons, issues, { renderLeaf, seasonFields }) {
  const issuesBySeason = new Map();
  for (const iss of issues) {
    const key = iss.seasonId || null;
    if (!issuesBySeason.has(key)) issuesBySeason.set(key, []);
    issuesBySeason.get(key).push(iss);
  }
  for (const list of issuesBySeason.values()) {
    list.sort(compareIssuesByPosition);
  }
  const renderBucket = (list) => list.map(renderLeaf);
  const tree = seasons.map((s) => ({
    ...seasonFields(s),
    episodes: renderBucket(issuesBySeason.get(s.id) || []),
  }));
  const ungrouped = issuesBySeason.get(null) || [];
  if (ungrouped.length) {
    tree.push({ number: null, title: '(ungrouped issues)', episodes: renderBucket(ungrouped) });
  }
  return tree;
}

export async function buildVerifyContext(series, preloadedWorld) {
  const seasons = sanitizeSeasonList(series.seasons || []);
  const [issues, base, canon] = await Promise.all([
    listIssues({ seriesId: series.id }),
    buildArcBaseContext(series, preloadedWorld),
    getSeriesCanon(series),
  ]);
  const tree = groupIssuesBySeasonTree(seasons, issues, {
    // `synopsis` key (not `beats`) so it matches the prompt's existing
    // language; sourced from idea.input which carries the LLM's logline+synopsis.
    renderLeaf: (iss) => ({
      number: iss.number,
      title: iss.title,
      status: iss.status,
      arcPosition: iss.arcPosition,
      synopsis: (iss.stages?.idea?.input || '').trim() || null,
    }),
    seasonFields: (s) => ({
      number: s.number,
      title: s.title,
      logline: s.logline,
      synopsis: s.synopsis,
      endingHook: s.endingHook,
      episodeCountTarget: s.episodeCountTarget,
      themes: s.themes,
      status: s.status,
    }),
  });
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
export function shapeVerifyIssues(rawIssues) {
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

// Max episode-synopsis corrections an auto-resolve pass may apply in one round.
// A bound (mirrors RESOLVE_FINDING_MAX) so a runaway LLM response can't rewrite
// the entire episode lineup in a single convergence step.
export const RESOLVE_EPISODE_MAX = 50;

/**
 * Shape the auto-resolve pass's optional `episodes[]` output — a SPARSE list of
 * episode-synopsis corrections the resolver applies when a finding originates at
 * the episode level (see pipeline-arc-resolve.md rule 8). Each entry must carry
 * an integer `episodeNumber` and a non-empty `synopsis`; `seasonNumber` is
 * optional disambiguation. Malformed entries are dropped so a partial response
 * never throws.
 */
export function shapeEpisodeResolutions(rawEpisodes) {
  if (!Array.isArray(rawEpisodes)) return [];
  const out = [];
  for (const raw of rawEpisodes) {
    const synopsis = typeof raw?.synopsis === 'string' ? raw.synopsis.trim() : '';
    const episodeNumber = Number(raw?.episodeNumber);
    if (!synopsis || !Number.isInteger(episodeNumber)) continue;
    const seasonNumberRaw = Number(raw?.seasonNumber);
    out.push({
      seasonNumber: Number.isInteger(seasonNumberRaw) ? seasonNumberRaw : null,
      episodeNumber,
      synopsis: synopsis.slice(0, STAGE_INPUT_MAX),
    });
    if (out.length >= RESOLVE_EPISODE_MAX) break;
  }
  return out;
}

// Set exactly one of `beats` / `synopsis` so the prompt's beat-level checks
// don't run against synopsis-only issues (and vice-versa). Beats land in
// idea.output once the LLM-expand pass runs; before that, idea.input still
// carries the seed synopsis.
export function renderVolumeIssue(iss) {
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
export function buildNeighborVolumes(allSeasons, currentSeasonId) {
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

export function sliceSeasonForNeighbor(s) {
  return {
    number: s.number,
    title: s.title,
    logline: s.logline || '',
    synopsis: s.synopsis || '',
    endingHook: s.endingHook || '',
  };
}

// Build the season-number → seasonId lookup the episode-correction passes use
// to disambiguate a correction that names a season. Only integer-numbered
// seasons are indexed (a malformed season can't be a resolution target).
export const seasonIdByNumberOf = (series) => new Map(
  (series?.seasons || []).filter((s) => Number.isInteger(s?.number)).map((s) => [s.number, s.id]),
);

// Match the issue an episode-level correction targets. The arc tree numbers
// episodes series-globally, but when a correction names a season that resolved
// to a real season id we REQUIRE the issue to be in it — we do NOT fall back to
// a season-agnostic number match, because if an LLM ever emits a per-season
// `episodeNumber` a bare-number fallback would silently rewrite the wrong
// season's issue (e.g. global issue 5 when the model meant season 2 episode 5).
// Failing safe to no-match (the caller logs it) is the correct outcome for a
// numbering-scheme mismatch. Only when no season is given (or it didn't resolve)
// do we match on the globally-unique number alone. Returns the issue or
// undefined. Shared by applyEpisodeResolutions (arc-resolve) and
// applyBeatResolutions (beat-continuity).
export function matchIssueForEpisodeEdit(issues, seasonIdByNumber, edit) {
  const wantSeasonId = edit.seasonNumber != null ? seasonIdByNumber.get(edit.seasonNumber) : null;
  return wantSeasonId
    ? issues.find((i) => i.number === edit.episodeNumber && i.seasonId === wantSeasonId)
    : issues.find((i) => i.number === edit.episodeNumber);
}

export async function buildResolveContext(series, findings, preloadedWorld) {
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

// ---------------------------------------------------------------------------
// Whole-manuscript BEAT-level continuity pass (#1510).
//
// verifyArc checks SYNOPSIS depth across the whole arc; verifyVolume checks
// BEAT depth within ONE volume. The missing altitude was a whole-BOOK beat
// pass — cross-issue beat defects (an unresolved cliffhanger, a finale that
// drifts from the arc's intended ending, a promised through-line that never
// lands, an event staged as "first" in two issues) only surfaced AFTER full
// scripts existed (the most expensive stage). These builders feed the per-issue
// beat sheets (idea.output) for the whole series as the corpus — compact enough
// that the whole book fits a normal window, so no chunking. Leaves carry `beats`
// where present (via renderVolumeIssue) and fall back to `synopsis`, so a
// partially-expanded series is still checkable mid-workflow.
// ---------------------------------------------------------------------------

// Render the season→issue tree with beat-bearing leaves and report how many
// issues actually carry beats, so the conductor/prompt can tell a real beat
// corpus from a synopsis-only one. Shared by the verify and resolve contexts.
async function buildBeatTree(series, preloadedWorld) {
  const seasons = sanitizeSeasonList(series.seasons || []);
  const [issues, base, canon] = await Promise.all([
    listIssues({ seriesId: series.id }),
    buildArcBaseContext(series, preloadedWorld),
    getSeriesCanon(series),
  ]);
  const tree = groupIssuesBySeasonTree(seasons, issues, {
    renderLeaf: renderVolumeIssue,
    seasonFields: (s) => ({
      number: s.number,
      title: s.title,
      logline: s.logline,
      synopsis: s.synopsis,
      endingHook: s.endingHook,
      episodeCountTarget: s.episodeCountTarget,
      themes: s.themes,
    }),
  });
  // Report how many issues actually carry beats, so the conductor/prompt can
  // tell a real beat corpus from a synopsis-only one. Counted from the built
  // tree — every leaf with `.beats` came through renderVolumeIssue's beats branch.
  const beatBearing = tree.reduce((n, s) => n + s.episodes.filter((e) => e.beats).length, 0);
  return { base, canon, tree, beatBearing };
}

export async function buildBeatContinuityContext(series, preloadedWorld) {
  const { base, canon, tree, beatBearing } = await buildBeatTree(series, preloadedWorld);
  return {
    ...base,
    seasonsTreeJson: JSON.stringify(tree, null, 2),
    beatBearingCount: beatBearing,
    existingCharactersJson: JSON.stringify(canon.characters, null, 2),
    existingPlacesJson: JSON.stringify(canon.places, null, 2),
    existingObjectsJson: JSON.stringify(canon.objects, null, 2),
  };
}

export async function buildBeatContinuityResolveContext(series, findings, preloadedWorld) {
  const ctx = await buildBeatContinuityContext(series, preloadedWorld);
  return { ...ctx, findingsJson: JSON.stringify(findings, null, 2) };
}

// Max beat corrections an auto-resolve pass may apply in one round (mirrors
// RESOLVE_EPISODE_MAX) so a runaway LLM response can't rewrite every issue's
// beats in a single convergence step.
export const RESOLVE_BEAT_MAX = 50;

/**
 * Shape the beat-continuity resolver's `episodes[]` output — a SPARSE list of
 * per-issue BEAT rewrites (vs `shapeEpisodeResolutions`'s synopsis rewrites).
 * Each entry needs an integer `episodeNumber` and non-empty `beats`;
 * `seasonNumber` is optional disambiguation. Malformed entries are dropped.
 */
export function shapeBeatResolutions(rawEpisodes) {
  if (!Array.isArray(rawEpisodes)) return [];
  const out = [];
  for (const raw of rawEpisodes) {
    const beats = typeof raw?.beats === 'string' ? raw.beats.trim() : '';
    const episodeNumber = Number(raw?.episodeNumber);
    if (!beats || !Number.isInteger(episodeNumber)) continue;
    const seasonNumberRaw = Number(raw?.seasonNumber);
    out.push({
      seasonNumber: Number.isInteger(seasonNumberRaw) ? seasonNumberRaw : null,
      episodeNumber,
      beats: beats.slice(0, STAGE_INPUT_MAX),
    });
    if (out.length >= RESOLVE_BEAT_MAX) break;
  }
  return out;
}

export const RESOLVE_FINDING_MAX = 50;

export function shapeFindings(rawFindings) {
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
