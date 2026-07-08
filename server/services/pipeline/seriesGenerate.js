/**
 * Pipeline — Series Concept Generator (multi-concept ideation, CWQE Phase 15, #2180).
 *
 * Given a universe, asks the configured LLM to invent SEVERAL genuinely distinct
 * new series that live in that world — each a different story from any series
 * already in it and from each other. Every concept carries a fresh name /
 * logline / premise / recommended Vonnegut shape PLUS craft facets (hook, world,
 * conflict engine, cost, tension, theme), generated under an anti-generic
 * banlist that merges a shipped default list with the universe's own
 * `influences.avoid`. Concept diversity at the seed is the cheapest quality lever
 * in the whole pipeline — everything downstream inherits it (autonovel's seed
 * stage generated 10 concepts under an explicit banlist, then selected).
 *
 * Two selection modes, per the AI-provider policy (this fires ONLY from an
 * explicit user action or the already-consented autonomous invention path —
 * never at boot):
 *   - `generateSeriesConcepts()` — interactive: returns ALL candidates for the
 *     user to pick from (the New Series form presents them). Nothing is
 *     persisted here; the rejected candidates live in run history so the user
 *     can switch without regenerating.
 *   - `generateSeriesConcept()` — autonomous (CoS-driven invention / Series
 *     Autopilot): judge-picks the winner via a one-call forced-rank (reusing the
 *     writer/judge split, #2167) and returns the single winning concept in the
 *     legacy `{ name, logline, premise, shape }` shape (backward-compatible),
 *     plus the rejected candidates. Falls back to the first candidate when no
 *     judge is configured / the judge call fails.
 *
 * Sampling note: the issue asks concept generation to run "hot" (high
 * temperature) where the provider path supports it. The shared stage runner /
 * toolkit provider path does NOT currently plumb sampling params (mirrors the
 * sibling CWQE phases — pipelineJudge / voice-discover — which punted on it too),
 * so diversity is driven by the prompt's explicit banlist + "make each concept
 * distinct" mandate rather than a temperature knob. CLI providers would ignore
 * a temperature anyway. When the provider path grows sampling support this is
 * the natural first caller to opt in.
 *
 * Throws ServerError(502, PIPELINE_SERIES_CONCEPT_EMPTY) on unusable output —
 * matches the other refine helpers' error shape so the UI surfaces a uniform
 * "try again" toast.
 */

import { getUniverse, joinInfluenceList, ERR_NOT_FOUND as UNIVERSE_ERR_NOT_FOUND } from '../universeBuilder.js';
import { listSeries, NAME_MAX, LOGLINE_MAX, PREMISE_MAX } from './series.js';
import { ARC_SHAPES, ARC_SHAPE_IDS } from '../../lib/storyArc.js';
import { runPromptRefineRaw } from './refineHelpers.js';
import { runStagedLLM, resolveJudgeForStage } from '../../lib/stageRunner.js';
import { getStage } from '../promptService.js';
import { ServerError } from '../../lib/errorHandler.js';

const CANON_LIST_MAX = 24; // cap per canon kind in the brief — keeps the prompt tight
const EXISTING_SERIES_MAX = 30;
const FACET_MAX = 1000; // per-facet char cap (hook / world / conflictEngine / cost / tension / theme)

// How many candidate concepts to generate. Default 5 (mid of the issue's 4–6);
// clamped so a stray option can't spawn a wall of concepts or a single one.
export const CANDIDATE_COUNT_DEFAULT = 5;
export const CANDIDATE_COUNT_MIN = 2;
export const CANDIDATE_COUNT_MAX = 8;

// Shipped, genre-neutral anti-generic banlist — the exhausted default-mode ideas
// a reader who has seen a thousand pitches scrolls past. Merged with the
// universe's own `influences.avoid` before rendering into the prompt. Kept
// genre-spanning (not every series has magic) so it steers ideation across the
// whole catalog, per the issue's "adapt facet names to be genre-neutral" note.
export const ANTI_GENERIC_BANLIST = Object.freeze([
  'a chosen one / prophesied savior destined to save the world',
  'a Dark Lord or ultimate evil whose defeat is the whole plot',
  'medieval-Europe-with-a-reskin as the default setting',
  'a secret magic/training academy the protagonist enrolls in',
  'a love triangle as the primary engine of tension',
  'an amnesiac protagonist who slowly recovers who they were',
  '"it was all a simulation / dream / afterlife" as the central twist',
  'a scrappy band of misfits who are the only hope',
  'an ancient prophecy that foretells the events of the story',
  'a mentor who dies to motivate the hero',
]);

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const rangeIndices = (n) => Array.from({ length: n }, (_, i) => i);

// Clamp a caller-supplied concept count into [MIN, MAX], defaulting when absent
// or non-numeric.
export function clampCandidateCount(v) {
  if (v == null) return CANDIDATE_COUNT_DEFAULT;
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return CANDIDATE_COUNT_DEFAULT;
  return Math.min(CANDIDATE_COUNT_MAX, Math.max(CANDIDATE_COUNT_MIN, n));
}

/**
 * Merge the shipped anti-generic banlist with the universe's own avoid-influences
 * into one deduped list (case-insensitive; shipped entries win their slot). This
 * is what gives the universe author's "steer clear of X" a hard veto at the seed.
 * Exported for the route/UI + unit tests.
 */
export function mergeAntiGenericBanlist(universe) {
  const merged = [...ANTI_GENERIC_BANLIST];
  const seen = new Set(ANTI_GENERIC_BANLIST.map((s) => s.toLowerCase()));
  const avoid = Array.isArray(universe?.influences?.avoid) ? universe.influences.avoid : [];
  for (const raw of avoid) {
    const t = typeof raw === 'string' ? raw.trim() : '';
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(t);
  }
  return merged;
}

// Render the merged banlist as a bullet block for the prompt.
const renderBanlist = (list) => (Array.isArray(list) && list.length
  ? list.map((b) => `- ${b}`).join('\n')
  : '- (no banlist configured)');

// Render a universe canon list (characters / places / objects) as a compact
// "Name — role; Name — role" string the LLM can scan. Entries with no
// identifier drop out; an empty (or all-unidentified) list becomes an explicit
// "(none)" so the prompt never renders a dangling label.
function renderCanonList(entries) {
  const rendered = (Array.isArray(entries) ? entries : [])
    .slice(0, CANON_LIST_MAX)
    .map((e) => {
      // Places may carry only a `slugline` and no `name` — the bible sanitizer
      // accepts either as the identifier (storyBible.js), so fall back to it.
      // Characters/objects always have a name, so the fallback is a no-op there.
      const label = (e?.name || e?.slugline || '').trim();
      if (!label) return null;
      const role = (e?.role || '').trim();
      return role ? `${label} — ${role}` : label;
    })
    .filter(Boolean)
    .join('; ');
  return rendered || '(none catalogued yet)';
}

const SHAPES_BLOCK = ARC_SHAPES
  .map((s) => `- \`${s.id}\` (${s.label}): ${s.description}`)
  .join('\n');

function buildContext(universe, existingSeries) {
  const existing = (existingSeries || [])
    .slice(0, EXISTING_SERIES_MAX)
    .map((s) => {
      const name = (s?.name || '').trim();
      if (!name) return null;
      const logline = (s?.logline || '').trim();
      return logline ? `- "${name}" — ${logline}` : `- "${name}"`;
    })
    .filter(Boolean);
  return {
    universe: {
      name: (universe.name || '').slice(0, 200),
      premise: (universe.premise || '').slice(0, 4000),
      logline: (universe.logline || '').slice(0, 500),
      styleNotes: (universe.styleNotes || '').slice(0, 4000),
      embrace: joinInfluenceList(universe.influences?.embrace) || '(none)',
      avoid: joinInfluenceList(universe.influences?.avoid) || '(none)',
    },
    characters: renderCanonList(universe.characters),
    places: renderCanonList(universe.places),
    objects: renderCanonList(universe.objects),
    shapes: SHAPES_BLOCK,
    existingSeries: existing.length
      ? existing.join('\n')
      : '(none yet — this is the first series in the universe)',
  };
}

// Normalize one LLM candidate concept. Drops a candidate with no usable name (the
// create form needs a title); clamps every string to its cap; keeps only a
// recognized story-shape id (unknown → null, the create path treats that as "no
// shape picked"). The facet fields are advisory craft context — surfaced in the
// picker UI and fed to the judge, not persisted on the series record.
function normalizeCandidate(raw) {
  if (raw == null || typeof raw !== 'object') return null;
  const name = str(raw.name, NAME_MAX);
  if (!name) return null;
  const shapeRaw = typeof raw.shape === 'string' ? raw.shape.trim() : '';
  return {
    name,
    logline: str(raw.logline, LOGLINE_MAX),
    premise: str(raw.premise, PREMISE_MAX),
    shape: ARC_SHAPE_IDS.includes(shapeRaw) ? shapeRaw : null,
    hook: str(raw.hook, FACET_MAX),
    world: str(raw.world, FACET_MAX),
    conflictEngine: str(raw.conflictEngine, FACET_MAX),
    cost: str(raw.cost, FACET_MAX),
    tension: str(raw.tension, FACET_MAX),
    theme: str(raw.theme, FACET_MAX),
  };
}

// Load the shared seed context both entry points need — the universe (404-mapped)
// and the same-universe existing series (storage failure propagates so a
// silently-empty list can't weaken duplicate-avoidance while reporting success).
async function loadSeedContext(universeId) {
  const universe = await getUniverse(universeId).catch((err) => {
    if (err?.code === UNIVERSE_ERR_NOT_FOUND) {
      throw new ServerError(`Universe not found: ${universeId} — pick an existing universe.`, {
        status: 404, code: 'PIPELINE_SERIES_CONCEPT_UNIVERSE_NOT_FOUND',
      });
    }
    throw err;
  });
  const all = await listSeries();
  const existingSeries = all.filter((s) => s.universeId === universeId);
  return { universe, existingSeries };
}

// The one LLM call that invents the candidate concepts. Shared by both entry
// points. Returns the normalized candidate list plus the merged banlist and run
// metadata.
async function runConceptGeneration(universe, existingSeries, options = {}) {
  const count = clampCandidateCount(options.count);
  const banlist = mergeAntiGenericBanlist(universe);
  const emptyError = {
    code: 'PIPELINE_SERIES_CONCEPT_EMPTY',
    message: 'LLM returned no usable series concepts — try again or pick a different provider.',
  };
  const { content, rationale, runId, providerId, model } = await runPromptRefineRaw({
    templateName: 'pipeline-series-generate',
    variables: { ...buildContext(universe, existingSeries), count, banlist: renderBanlist(banlist) },
    options,
    source: 'pipeline-series-generate',
    logTag: `Series concepts — universe=${(universe.id || '').slice(0, 8)} count=${count}`,
    emptyError,
    // A response with no candidates array is unusable — hard gate before the
    // per-candidate normalization below.
    validateContent: (c) => {
      if (!Array.isArray(c?.candidates)) {
        throw new ServerError(emptyError.message, { status: 502, code: emptyError.code });
      }
    },
  });
  const candidates = content.candidates.map(normalizeCandidate).filter(Boolean);
  if (!candidates.length) {
    throw new ServerError(emptyError.message, { status: 502, code: emptyError.code });
  }
  return { candidates, banlist, rationale, runId, providerId, model };
}

/**
 * Interactive multi-concept generation. Returns ALL candidates for user pick —
 * nothing is persisted (the New Series form pre-fills from the chosen candidate;
 * the rest live in run history so the user can switch without regenerating).
 *
 * @param {string} universeId
 * @param {object} [options] — { count, providerId, model }
 * @returns {Promise<{ candidates, banlist, rationale, runId, providerId, model }>}
 */
export async function generateSeriesConcepts(universeId, options = {}) {
  const { universe, existingSeries } = await loadSeedContext(universeId);
  return runConceptGeneration(universe, existingSeries, options);
}

// Render the candidate concepts (numbered 1..N) for the forced-rank judge prompt.
function renderCandidatesForJudge(candidates) {
  return candidates.map((c, i) => {
    const lines = [`### Concept ${i + 1}: ${c.name}`];
    if (c.logline) lines.push(`- Logline: ${c.logline}`);
    if (c.hook) lines.push(`- Hook: ${c.hook}`);
    if (c.world) lines.push(`- World: ${c.world}`);
    if (c.conflictEngine) lines.push(`- Conflict engine: ${c.conflictEngine}`);
    if (c.cost) lines.push(`- Cost: ${c.cost}`);
    if (c.tension) lines.push(`- Tension: ${c.tension}`);
    if (c.theme) lines.push(`- Theme: ${c.theme}`);
    if (c.premise) lines.push(`- Premise: ${c.premise.slice(0, 800)}`);
    return lines.join('\n');
  }).join('\n\n');
}

// Parse the forced-rank judge response into a 0-based pick + ranking. Returns
// null when the pick is missing/out-of-range so the caller falls back to the
// first candidate (the "no usable judge decision" path). `n` is the candidate
// count — a pick must be a 1-based number in [1, n].
export function parseConceptPick(content, n) {
  if (!content || typeof content !== 'object') return null;
  const pickNum = Math.trunc(Number(content.pick));
  if (!Number.isFinite(pickNum) || pickNum < 1 || pickNum > n) return null;
  const index = pickNum - 1;
  const rankingRaw = Array.isArray(content.ranking) ? content.ranking : [];
  const seen = new Set();
  const ranking = [];
  for (const r of rankingRaw) {
    const num = Math.trunc(Number(r));
    if (!Number.isFinite(num) || num < 1 || num > n) continue;
    const idx = num - 1;
    if (seen.has(idx)) continue;
    seen.add(idx);
    ranking.push(idx);
  }
  // Ensure the winner leads the ranking, and every candidate appears once.
  const ordered = [index, ...ranking.filter((i) => i !== index)];
  for (const i of rangeIndices(n)) if (!ordered.includes(i)) ordered.push(i);
  const rationale = str(content.rationale, 600);
  return { index, ranking: ordered, rationale };
}

/**
 * Judge-pick the strongest concept via a one-call forced rank ("which concept
 * would a reader who has seen a thousand pitches stop scrolling for?"), reusing
 * the writer/judge split (#2167) resolved from the concept-generation stage's
 * judge pin. Degrades gracefully: with ≤1 candidate, no resolvable judge, or an
 * unusable judge response, it falls back to the FIRST candidate rather than
 * blocking autonomous invention.
 *
 * @param {Array} candidates
 * @param {object} [opts] — { universe, providerId, model }
 * @returns {Promise<{ index, ranking, rationale, judged }>}
 */
export async function judgePickConcept(candidates, opts = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const n = list.length;
  if (n <= 1) {
    return { index: 0, ranking: n === 1 ? [0] : [], rationale: '', judged: false };
  }
  const { universe, providerId, model } = opts;

  // Resolve the judge provider from the concept-generation stage's judge pin
  // (writer/judge split), honoring an explicit override. Resolution failure
  // ("no judge configured" / provider unavailable) degrades to the first
  // candidate — this is the specified fallback, not a swallowed error.
  const stage = getStage('pipeline-series-generate');
  const resolved = await resolveJudgeForStage(stage, {
    providerOverride: providerId,
    modelOverride: model,
  }).catch(() => null);
  if (!resolved) {
    return { index: 0, ranking: rangeIndices(n), rationale: '', judged: false };
  }

  const variables = {
    count: n,
    candidates: renderCandidatesForJudge(list),
    universe: {
      name: (universe?.name || '').slice(0, 200),
      premise: (universe?.premise || '').slice(0, 4000),
      embrace: joinInfluenceList(universe?.influences?.embrace) || '(none)',
      avoid: joinInfluenceList(universe?.influences?.avoid) || '(none)',
    },
  };
  const result = await runStagedLLM('pipeline-series-concept-judge', variables, {
    returnsJson: true,
    providerOverride: resolved.provider.id,
    modelOverride: resolved.model,
    source: 'pipeline-series-concept-judge',
  }).catch(() => null);

  const parsed = parseConceptPick(result?.content, n);
  if (!parsed) {
    return { index: 0, ranking: rangeIndices(n), rationale: '', judged: false };
  }
  console.log(`⚖️ concept judge: picked #${parsed.index + 1}/${n} via ${resolved.provider.id}/${resolved.model || '(default)'}`);
  return { ...parsed, judged: true };
}

/**
 * Autonomous single-concept generation (CoS-driven invention / Series Autopilot).
 * Generates the candidate concepts, judge-picks the winner (or first-candidate
 * fallback), and returns the winning concept in the legacy
 * `{ name, logline, premise, shape, rationale }` shape — backward-compatible with
 * every existing caller — plus `candidates` (all), `rejected` (the losers),
 * `pickIndex`, and `judged`.
 *
 * @param {string} universeId
 * @param {object} [options] — { count, providerId, model }
 */
export async function generateSeriesConcept(universeId, options = {}) {
  const { universe, existingSeries } = await loadSeedContext(universeId);
  const { candidates, banlist, rationale, runId, providerId, model } =
    await runConceptGeneration(universe, existingSeries, options);

  const pick = await judgePickConcept(candidates, {
    universe,
    providerId: options.providerId,
    model: options.model,
  });
  const index = candidates[pick.index] ? pick.index : 0;
  const chosen = candidates[index];
  const rejected = candidates.filter((_, i) => i !== index);

  return {
    // Legacy concept shape (unchanged for backward compatibility).
    name: chosen.name,
    logline: chosen.logline,
    premise: chosen.premise,
    shape: chosen.shape,
    // Judge's deciding rationale when it picked; otherwise the generator's.
    rationale: pick.rationale || rationale,
    // New multi-concept context.
    candidates,
    rejected,
    banlist,
    pickIndex: index,
    judged: pick.judged,
    runId,
    providerId,
    model,
  };
}

export const __testing = { normalizeCandidate, renderCandidatesForJudge, renderBanlist, buildContext };
