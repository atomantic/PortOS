/**
 * Pipeline — Foundation-quality judge + fix router (CWQE Phase 11, #2176).
 *
 * The "correct it up-front, not in editor mode" mechanism for autonomous runs.
 * Before Series Autopilot drafts a single issue, it judges the FOUNDATION as a
 * whole — universe canon (worldbuilding) + character records + the series
 * arc/seasons (structure) + declared voice/style (craft) — against a weighted
 * rubric mirroring the Phase 10 craft doctrine (#2175):
 *
 *     worldbuilding 40% · character 30% · structure 20% · craft 10%
 *
 * The judge runs on the writer/judge split resolved by `resolveJudgeForStage()`
 * (#2167) off the `pipeline-arc-overview` writer stage — the model that scores
 * the foundation is deliberately different from the one that generated it. It
 * returns a per-dimension `{ score, gap, fix }` and a weighted composite the
 * autopilot gate spends: proceed once the weighted score clears a configurable
 * threshold AND every dimension clears its floor; otherwise the bounded improve loop (in
 * seriesAutopilot.js `runFoundationGate`) targets the largest weighted deficit, applies
 * the fix through the OWNING service (never a raw write, `force:false`
 * everywhere), and re-judges.
 *
 * Fast-pass / skip: the judged inputs (canon + character records + full
 * synopsis plan + character arcs + series voice) are
 * content-hashed and pinned on the snapshot, so a re-judge of an UNCHANGED
 * foundation returns the cached verdict with no LLM call — an already-clean
 * foundation re-reached after unrelated steps cannot loop (mirrors
 * editorialAnalysis.js / pipelineJudge.js staleness). Snapshots persist at
 * `data/pipeline-foundation-judge/{seriesId}.json`.
 *
 * AI-provider policy: this fires ONLY from the already-consented Series
 * Autopilot (or an explicit user action) — never at boot.
 *
 * Errors bubble (no try/catch) except the single deliberate malformed-JSON retry
 * in `runFoundationJudgeStage` — LLM judges intermittently emit prose-wrapped or
 * truncated JSON, and one stricter retry salvages most of them.
 */

import { join } from 'path';
import { createHash } from 'crypto';
import { PATHS, atomicWrite, ensureDir, tryReadFile, safeJSONParse } from '../../lib/fileUtils.js';
import { runStagedLLM, resolveStageContext, resolveJudgeForStage } from '../../lib/stageRunner.js';
import { manuscriptContentBudgetChars, estimateTokens } from '../../lib/contextBudget.js';
import { getStage } from '../promptService.js';
import { composeStyleNotes, sanitizeStyleGuide, STYLE_GUIDE_LIMITS } from '../../lib/styleGuide.js';
import { renderCharacterArcsForPrompt, sanitizeCharacterArcList } from '../../lib/seriesCharacterArc.js';
import { BIBLE_SOURCE, sanitizeCharacter } from '../../lib/storyBible.js';
import { renderEntitiesSummary } from '../../lib/universePromptRenderers.js';
import { getUniverse, updateUniverse } from '../universeBuilder.js';
import { isBlankString, isBlankArray } from '../universeCharacterExpand.js';
import { expandWorldTemplate } from '../universeBuilderExpand.js';
import { getSeries, updateSeries } from './series.js';
import { listIssues } from './issues.js';
import { getSeriesCanon } from './seriesCanon.js';
import { resolveVerifyIssues } from './arcPlanner.js';

const STAGE = 'pipeline-judge-foundation';
const REPAIR_STAGE = 'pipeline-foundation-repair';
const CHARACTER_FOUNDATION_STAGE = 'pipeline-character-foundation';
// The writer stage whose judgeProvider/judgeModel pin drives the writer/judge
// split — the arc overview is the foundation's authoring pass. Mirrors
// pipelineJudge.js's WRITER_STAGE_TEMPLATE indirection (kept local + stable).
const WRITER_STAGE = 'pipeline-arc-overview';

// The four rubric dimensions and their weights — the single source of truth for
// the weighted composite, the fix router, sanitize, and client rendering.
// Order is display order. Weights sum to 1.0 (asserted at module load).
export const FOUNDATION_DIMENSIONS = Object.freeze(['worldbuilding', 'character', 'structure', 'craft']);
export const FOUNDATION_WEIGHTS = Object.freeze({
  worldbuilding: 0.4,
  character: 0.3,
  structure: 0.2,
  craft: 0.1,
});
// Fail fast if a future edit unbalances the rubric — a weighted score is only
// meaningful when the weights sum to 1.
const WEIGHT_SUM = FOUNDATION_DIMENSIONS.reduce((n, d) => n + FOUNDATION_WEIGHTS[d], 0);
if (Math.abs(WEIGHT_SUM - 1) > 1e-9) {
  throw new Error(`foundationJudge: FOUNDATION_WEIGHTS must sum to 1 (got ${WEIGHT_SUM})`);
}

// Default gate threshold — the weighted [0,10] score the foundation must clear
// before drafting. Mirrors autonovel's 7.5 foundation bar (design record
// Phase 11). Overridable per-run + via the persisted setting.
export const DEFAULT_FOUNDATION_THRESHOLD = 7.5;
// A strong weighted world score must not hide a critically thin character or
// craft foundation. The floor follows an intentionally lowered run threshold,
// but otherwise keeps every dimension at a publishable planning baseline.
export const DEFAULT_FOUNDATION_DIMENSION_FLOOR = 6;

// Defensive caps on LLM output — never trust raw model JSON.
const GAP_MAX = 600;
const FIX_MAX = 600;
const SUMMARY_MAX = 600;
const JUDGE_OUTPUT_RESERVE_TOKENS = 2_000;

const nowIso = () => new Date().toISOString();

// Defense-in-depth: refuse path-traversal-shaped ids before interpolating into
// the on-disk snapshot path (series ids are `ser-<uuid>`).
function assertValidSeriesId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid series id: ${id}`);
  }
}

const foundationDir = () => join(PATHS.data, 'pipeline-foundation-judge');
const snapshotPath = (seriesId) => join(foundationDir(), `${seriesId}.json`);

// ---------- input hashing (fast-pass / staleness) ----------

// The judged foundation as a stable, hashable projection: universe canon,
// character records, the full synopsis plan, authored character arcs, and the
// series voice. A change
// to ANY of these flips the pinned hash so a re-judge re-runs; an unchanged
// foundation short-circuits to the cached verdict. Kept deliberately narrow —
// only the fields the judge actually reads — so an unrelated series edit (e.g. a
// render slot) doesn't needlessly invalidate the score.
export function foundationInputs(series, universe, issues = []) {
  const characters = Array.isArray(universe?.characters) ? universe.characters : [];
  const seriesCharacters = seriesFoundationCharacters(characters, series, issues);
  const episodeInputs = [...(Array.isArray(issues) ? issues : [])]
    .sort((a, b) => String(a?.seasonId || '').localeCompare(String(b?.seasonId || ''))
      || (a?.number ?? 9999) - (b?.number ?? 9999)
      || String(a?.id || '').localeCompare(String(b?.id || '')))
    .map((issue) => ({
      id: issue?.id || '',
      seasonId: issue?.seasonId || '',
      number: issue?.number ?? null,
      title: issue?.title || '',
      synopsis: issue?.stages?.idea?.input || '',
    }));
  return {
    world: universe
      ? {
        logline: universe.logline || '',
        premise: universe.premise || '',
        styleNotes: universe.styleNotes || '',
        influences: universe.influences || null,
        // Places/objects are rendered into the world summary the judge scores,
        // so a user edit to either must flip the pinned hash (otherwise a clean
        // verdict would wrongly fast-pass a changed world).
        places: Array.isArray(universe.places) ? universe.places : [],
        objects: Array.isArray(universe.objects) ? universe.objects : [],
      }
      : null,
    // A linked universe can contain characters belonging to other stories. Only
    // the cast referenced by THIS series is judged and hashed; otherwise an
    // unrelated blank universe asset can keep an otherwise-ready series trapped
    // in the character repair loop forever.
    characters: seriesCharacters.map((c) => ({
      id: c.id,
      name: c.name,
      role: c.role || '',
      ...pickFrameworkFields(c),
    })),
    arc: series?.arc || null,
    seasons: Array.isArray(series?.seasons)
      ? series.seasons.map((s) => ({
        id: s.id,
        number: s.number,
        title: s.title || '',
        logline: s.logline || '',
        synopsis: s.synopsis || '',
        endingHook: s.endingHook || '',
      }))
      : [],
    episodes: episodeInputs,
    characterArcs: Array.isArray(series?.characterArcs) ? series.characterArcs : [],
    voice: {
      styleNotes: series?.styleNotes || '',
      styleGuide: series?.styleGuide || null,
    },
  };
}

// The character-framework subset the character dimension scores (Ghost → Wound →
// Lie → Want → Need chain + secrets + arc fields). Shared by the hash projection
// and the "thinnest character" fix target so both read the SAME field set.
const FRAMEWORK_STRING_FIELDS = Object.freeze(['ghost', 'wound', 'lie', 'want', 'need', 'coreTheme', 'motivations', 'speechPattern']);
function pickFrameworkFields(c) {
  const out = {};
  for (const f of FRAMEWORK_STRING_FIELDS) out[f] = c?.[f] || '';
  out.arcType = c?.arcType || '';
  out.secrets = Array.isArray(c?.secrets) ? c.secrets : [];
  return out;
}

const contentHash = (value) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
export const foundationInputsHash = (series, universe, issues = []) => contentHash(foundationInputs(series, universe, issues));

// ---------- weighted composite math ----------

const clampScore = (v, fallback = 0) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(10, Math.round(n * 100) / 100));
};

/**
 * The weighted [0,10] composite — Σ dimension.score × weight. A missing/invalid
 * dimension contributes 0 for its term (never NaN-poisons the score). Pure +
 * unit-tested; the autopilot gate compares this against the threshold.
 */
export function computeWeightedScore(dimensions) {
  const dims = dimensions && typeof dimensions === 'object' ? dimensions : {};
  let total = 0;
  for (const d of FOUNDATION_DIMENSIONS) {
    const score = Number(dims[d]?.score);
    total += (Number.isFinite(score) ? score : 0) * FOUNDATION_WEIGHTS[d];
  }
  return Math.round(total * 100) / 100;
}

/**
 * The dimension the improve loop should target next: the LARGEST weighted
 * deficit `weight × (10 − score)` — i.e. the single fix that moves the weighted
 * composite the most. Ties break toward the lower raw score, then rubric order.
 * (Fixing a high-weight low-score dimension first is what converges the gate;
 * "weakest" by bare score would waste rounds polishing a 10%-weight craft nit
 * while a thin 40%-weight world drags the composite down.) Pure + unit-tested.
 * Returns `{ dimension, score, deficit }`, or null when no dimension is present.
 */
export function weakestDimension(dimensions) {
  const dims = dimensions && typeof dimensions === 'object' ? dimensions : {};
  let best = null;
  for (const d of FOUNDATION_DIMENSIONS) {
    if (!dims[d]) continue;
    const score = clampScore(dims[d].score);
    const deficit = Math.round(FOUNDATION_WEIGHTS[d] * (10 - score) * 100) / 100;
    if (
      best === null
      || deficit > best.deficit
      || (deficit === best.deficit && score < best.score)
    ) {
      best = { dimension: d, score, deficit };
    }
  }
  return best;
}

export function foundationGateStatus(dimensions, weightedScore, threshold = DEFAULT_FOUNDATION_THRESHOLD) {
  const dimensionFloor = Math.min(
    Number.isFinite(threshold) ? threshold : DEFAULT_FOUNDATION_THRESHOLD,
    DEFAULT_FOUNDATION_DIMENSION_FLOOR,
  );
  const failingDimensions = FOUNDATION_DIMENSIONS
    .filter((dimension) => clampScore(dimensions?.[dimension]?.score) < dimensionFloor);
  return {
    dimensionFloor,
    failingDimensions,
    passes: Number(weightedScore) >= threshold && failingDimensions.length === 0,
  };
}

export function foundationFixTarget(dimensions, threshold = DEFAULT_FOUNDATION_THRESHOLD) {
  const { dimensionFloor, failingDimensions } = foundationGateStatus(dimensions, 0, threshold);
  if (failingDimensions.length === 0) return weakestDimension(dimensions);
  return failingDimensions
    .map((dimension) => ({
      dimension,
      score: clampScore(dimensions?.[dimension]?.score),
      deficit: Math.round((dimensionFloor - clampScore(dimensions?.[dimension]?.score)) * 100) / 100,
    }))
    .sort((a, b) => a.score - b.score
      || FOUNDATION_DIMENSIONS.indexOf(a.dimension) - FOUNDATION_DIMENSIONS.indexOf(b.dimension))[0];
}

// ---------- sanitize LLM output ----------

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function sanitizeDimension(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  return {
    score: clampScore(d.score),
    gap: str(d.gap, GAP_MAX),
    fix: str(d.fix, FIX_MAX),
  };
}

// A judge response is "valid-shaped" when it carries the dimensions object we
// scored against — the retry gate. A response that parses as JSON but omits the
// rubric is treated as malformed and retried once.
export function isValidFoundationShape(content) {
  return !!(content && typeof content === 'object'
    && content.dimensions && typeof content.dimensions === 'object');
}

export function sanitizeFoundationJudge(parsed) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  const rawDims = p.dimensions && typeof p.dimensions === 'object' ? p.dimensions : {};
  const dimensions = {};
  for (const key of FOUNDATION_DIMENSIONS) dimensions[key] = sanitizeDimension(rawDims[key]);
  return {
    dimensions,
    weightedScore: computeWeightedScore(dimensions),
    oneLineVerdict: str(p.oneLineVerdict, SUMMARY_MAX),
  };
}

// The per-dimension findings carried into a pause's `residual` for human review
// — same `{ severity, location, problem, suggestion }` shape the arc/editorial
// gates use, so the existing pause UI renders foundation findings unchanged.
export function residualFindings(dimensions) {
  const dims = dimensions && typeof dimensions === 'object' ? dimensions : {};
  return FOUNDATION_DIMENSIONS
    .filter((d) => dims[d])
    .map((d) => ({
      severity: 'high',
      location: `${d} (weight ${Math.round(FOUNDATION_WEIGHTS[d] * 100)}%, scored ${clampScore(dims[d].score)})`,
      problem: dims[d].gap || `${d} is below the foundation-quality bar`,
      suggestion: dims[d].fix || '',
    }));
}

// ---------- storage ----------

async function loadSnapshot(seriesId) {
  const content = await tryReadFile(snapshotPath(seriesId));
  if (content === null) return null;
  return safeJSONParse(content, null, { allowArray: false, logError: true, context: snapshotPath(seriesId) });
}

async function saveSnapshot(snapshot) {
  await ensureDir(foundationDir());
  await atomicWrite(snapshotPath(snapshot.seriesId), snapshot);
}

// Staleness: a complete snapshot is stale when the current foundation inputs no
// longer match the pinned hash (mirrors pipelineJudge.js). A legacy snapshot
// with no hash is treated as not-stale (can't tell).
export function isFoundationStale(snap, currentHash) {
  if (!snap || snap.status !== 'complete') return false;
  if (!snap.sourceInputsHash) return false;
  return snap.sourceInputsHash !== currentHash;
}

// ---------- context assembly ----------

// Render one character's framework completeness so the judge can see which of
// the Wound/Lie/Want/Need chain is present vs. blank (the character dimension's
// core signal) without dumping the whole record.
function renderCharacterLine(c, { core = false } = {}) {
  const role = c?.role ? ` (${c.role})` : '';
  const concise = (value) => (typeof value === 'string' && value.trim()
    ? value.trim().replace(/\s+/g, ' ').slice(0, 100)
    : '—');
  const framework = FRAMEWORK_STRING_FIELDS
    .map((field) => `${field}: ${concise(c?.[field])}`)
    .join(' | ');
  const secrets = (Array.isArray(c?.secrets) ? c.secrets : [])
    .map(concise)
    .slice(0, 3)
    .join('; ');
  return `- ${core ? '[CORE] ' : ''}**${c?.name || 'Unnamed'}**${role} — ${framework} | arcType: ${c?.arcType || '—'} | secrets: ${secrets || '—'}`;
}

function countOccurrences(text, value) {
  const haystack = String(text || '').toLocaleLowerCase();
  const needle = String(value || '').trim().toLocaleLowerCase();
  if (!needle) return 0;
  let count = 0;
  let cursor = 0;
  while ((cursor = haystack.indexOf(needle, cursor)) !== -1) {
    count += 1;
    cursor += needle.length;
  }
  return count;
}

export function rankFoundationCharacters(characters, series, issues = [], { includeLocked = false } = {}) {
  const list = Array.isArray(characters) ? characters : [];
  const storyText = JSON.stringify({
    logline: series?.logline || '',
    premise: series?.premise || '',
    arc: series?.arc || null,
    seasons: series?.seasons || [],
    characterArcs: series?.characterArcs || [],
    episodes: (Array.isArray(issues) ? issues : []).map((issue) => ({
      title: issue?.title || '',
      synopsis: issue?.stages?.idea?.input || '',
    })),
  });
  const authoredArcKeys = new Set((Array.isArray(series?.characterArcs) ? series.characterArcs : [])
    .flatMap((arc) => [
      arc?.characterId || '',
      arc?.characterName ? `name:${arc.characterName.trim().toLowerCase()}` : '',
    ])
    .filter(Boolean));
  return list
    .filter((character) => character && (includeLocked || character.locked !== true))
    .map((character, index) => {
      const blanks = FRAMEWORK_STRING_FIELDS.filter((field) => isBlankString(character[field])).length
        + (isBlankArray(character.secrets) ? 1 : 0);
      const mentions = countOccurrences(storyText, character.name);
      const authoredArc = authoredArcKeys.has(character.id)
        || authoredArcKeys.has(`name:${String(character.name || '').trim().toLowerCase()}`);
      const coreRole = /protagonist|lead|hero|antagonist|villain|deuteragonist|mentor/i.test(character.role || '');
      return { character, index, mentions, authoredArc, coreRole, blanks };
    })
    .sort((a, b) => Number(b.authoredArc) - Number(a.authoredArc)
      || Number(b.coreRole) - Number(a.coreRole)
      || b.mentions - a.mentions
      || b.blanks - a.blanks
      || a.index - b.index);
}

/**
 * Resolve the cast that belongs to this series from actual story references.
 * Once a plot exists, every named/arc-linked character is retained: there is no
 * arbitrary top-N cap. Before a plot exists, a small ranked fallback gives the
 * character architect enough principals to start from without drafting every
 * unrelated person in a shared universe.
 *
 * Locked referenced characters remain in this returned roster because the
 * judge still has to see constraints it cannot repair. Repair callers filter
 * them separately.
 */
export function seriesFoundationCharacters(characters, series, issues = []) {
  const ranked = rankFoundationCharacters(characters, series, issues, { includeLocked: true });
  const referenced = ranked.filter(({ authoredArc, mentions }) => authoredArc || mentions > 0);
  const selected = referenced.length > 0 ? referenced : ranked.slice(0, 6);
  return selected.map(({ character }) => character);
}

function repairableSeriesFoundationCharacters(characters, series, issues = []) {
  return seriesFoundationCharacters(characters, series, issues)
    .filter((character) => character?.locked !== true);
}

const joinedLength = (lines) => lines.reduce((total, line) => total + line.length + 1, 0);

/**
 * Render the synopsis-level series plan: arc header, per-volume loglines and
 * synopses, the episode list under each volume, and the authored character arcs.
 *
 * `maxChars` bounds the result. The per-episode synopsis list is the ONLY part
 * that grows without bound — a series gains episodes forever, and everything
 * else is fixed by the volume count — so the budget is spent by dropping WHOLE
 * episode lines from the end, keeping the plan spine (arc, volumes, authored
 * character arcs) intact and naming how many were left out. That degrades to a
 * coherent outline the model can still reason over, unlike slicing the rendered
 * text mid-sentence. Earliest episodes survive a tight budget because that's
 * where a character arc's opening transitions hang.
 *
 * Unbudgeted (the default) the output is byte-identical to the pre-budget
 * render, so the foundation judge's own section-level truncation is unchanged.
 */
function renderArc(series, issues = [], { maxChars = Infinity, includeArcTransitions = false } = {}) {
  const arc = series?.arc || {};
  const seasons = Array.isArray(series?.seasons) ? [...series.seasons].sort((a, b) => (a.number || 0) - (b.number || 0)) : [];
  const orderedIssues = [...(Array.isArray(issues) ? issues : [])]
    .sort((a, b) => (a?.number ?? 9999) - (b?.number ?? 9999));
  const themes = Array.isArray(arc.themes) ? arc.themes.join(', ') : (arc.themes || '');
  const head = [
    `Logline: ${arc.logline || '(none)'}`,
    `Summary: ${arc.summary || '(none)'}`,
    `Themes: ${themes || '(none)'}`,
    `Protagonist arc: ${arc.protagonistArc || '(none)'}`,
    `Shape: ${arc.shape || '(unset)'}`,
    '',
    `Volumes (${seasons.length}):`,
  ];
  const volumes = seasons.map((season) => {
    const spine = [
      `  V${season.number ?? '?'} ${season.title || ''}: ${season.logline || '(no logline)'}`,
      `    Synopsis: ${season.synopsis || '(none)'}`,
    ];
    if (season.endingHook) spine.push(`    Ending hook: ${season.endingHook}`);
    const episodes = orderedIssues
      .filter((issue) => issue?.seasonId === season.id)
      .map((issue) => `    #${issue.number ?? '?'} ${issue.title || 'Untitled'}: ${issue?.stages?.idea?.input || '(no synopsis)'}`);
    return { spine, episodes };
  });
  const characterArcs = Array.isArray(series?.characterArcs) ? series.characterArcs : [];
  const tail = ['', `Authored character arcs (${characterArcs.length}):`];
  if (includeArcTransitions) {
    tail.push(renderCharacterArcsForPrompt(characterArcs) || '(none)');
  } else {
    for (const characterArc of characterArcs) {
      tail.push(`  - ${characterArc.characterName || characterArc.characterId || 'Unnamed'}: ${characterArc.startState || '(no start)'} → ${characterArc.endState || '(no end)'}; want=${characterArc.want || '—'}; need=${characterArc.need || '—'}`);
    }
  }

  // The spine is unconditional; episodes fill whatever is left. `remaining` goes
  // negative when the spine alone overruns the budget, which drops every episode
  // rather than throwing — a caller that set a budget wants a smaller prompt, not
  // a failed render.
  let remaining = maxChars - joinedLength([...head, ...volumes.flatMap((v) => v.spine), ...tail]);
  let omitted = 0;
  const lines = [...head];
  for (const volume of volumes) {
    lines.push(...volume.spine);
    for (const episode of volume.episodes) {
      if (episode.length + 1 <= remaining) {
        lines.push(episode);
        remaining -= episode.length + 1;
      } else {
        omitted += 1;
      }
    }
  }
  if (omitted > 0) lines.push(`  [${omitted} later episode synopsis line${omitted === 1 ? '' : 's'} omitted to fit the prompt budget]`);
  lines.push(...tail);
  return lines.join('\n');
}

function renderWorldFoundation(universe) {
  if (!universe) return '(no linked universe — worldbuilding cannot be judged from canon)';
  const entities = renderEntitiesSummary(universe, { maxPerKind: { characters: 0 } }) || '(no named places or objects)';
  const influences = universe.influences && typeof universe.influences === 'object'
    ? `Embrace: ${(universe.influences.embrace || []).join(', ') || '—'}; Avoid: ${(universe.influences.avoid || []).join(', ') || '—'}`
    : '(none)';
  return [
    `Universe logline: ${universe.logline || '(none)'}`,
    `Universe premise: ${universe.premise || '(none)'}`,
    `Universe style: ${universe.styleNotes || '(none)'}`,
    `Influences: ${influences}`,
    `Named canon: ${entities}`,
  ].join('\n');
}

// Build the judge's variable bag from the whole foundation. Content is budgeted
// to the judge model's window (a small/local judge trims to fit rather than
// overflowing; a big-context judge gets the whole foundation).
function buildFoundationContext({ series, universe, canon, issues = [], contentMax }) {
  const characters = Array.isArray(canon?.characters) ? canon.characters : [];
  const seriesCharacters = seriesFoundationCharacters(characters, series, issues);
  const worldEntitiesSummary = renderWorldFoundation(universe);
  const characterRoster = seriesCharacters.length
    ? seriesCharacters.map((character) => renderCharacterLine(character, { core: true })).join('\n')
    : '(no canon characters)';
  const sectionMax = Math.max(1_000, Math.floor(contentMax / 3));
  // Character quality lives in the choices between start and end, not merely
  // the endpoints. Reuse the canonical authored-arc renderer here so the judge
  // sees decisions, relapses, sacrifices, and their issue placement. The
  // repair prompt keeps the legacy compact summary because it already receives
  // the full `series.characterArcs` JSON separately.
  const arcText = renderArc(series, issues, { includeArcTransitions: true });
  const world = worldEntitiesSummary.length > sectionMax
    ? `${worldEntitiesSummary.slice(0, sectionMax)}\n\n[world summary truncated for judging]`
    : worldEntitiesSummary;
  const roster = characterRoster.length > sectionMax
    ? `${characterRoster.slice(0, sectionMax)}\n\n[character roster truncated for judging]`
    : characterRoster;
  const arcContext = arcText.length > sectionMax
    ? `${arcText.slice(0, sectionMax)}\n\n[series plan truncated for judging]`
    : arcText;
  return {
    series: {
      name: series?.name || 'Untitled series',
      logline: series?.logline || '',
      premise: series?.premise || '',
      styleNotes: composeStyleNotes(series, { proseCraft: true }),
    },
    worldEntitiesSummary: world,
    characterRoster: roster,
    characterCount: seriesCharacters.length,
    arc: arcContext,
  };
}

// One deliberate malformed-JSON retry (see module doc). Mirrors pipelineJudge.js.
async function runFoundationJudgeStage(ctx, runOptions) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await runStagedLLM(STAGE, ctx, runOptions);
      if (isValidFoundationShape(result.content)) return result;
      lastError = new Error('foundation judge response parsed but is missing the `dimensions` rubric');
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

// ---------- judge ----------

/**
 * Judge a series' foundation. Returns the stored snapshot, or a cached snapshot
 * when the inputs are unchanged and `!force` (the fast-pass that stops the gate
 * looping on an already-clean foundation).
 *
 * @param {string} seriesId
 * @param {object} [opts]
 * @param {string} [opts.providerId]  explicit judge provider override
 * @param {string} [opts.model]       explicit judge model override
 * @param {string} [opts.effort]      run-level reasoning effort (soft — a per-stage
 *                                   `effort` pin still wins, #3641)
 * @param {string} [opts.providerDefault] soft run-level judge provider; stage pin wins
 * @param {string} [opts.modelDefault] soft run-level judge model; explicit stage model wins
 * @param {string} [opts.effortDefault] soft run-level judge effort; stage pin wins
 * @param {boolean} [opts.force]      re-judge unchanged inputs
 */
export async function judgeFoundation(seriesId, {
  providerId,
  model,
  effort,
  providerDefault,
  modelDefault,
  effortDefault,
  force = false,
} = {}) {
  assertValidSeriesId(seriesId);
  const series = await getSeries(seriesId);
  const [universe, issues] = await Promise.all([
    series?.universeId ? getUniverse(series.universeId).catch(() => null) : null,
    listIssues({ seriesId }),
  ]);
  const hash = foundationInputsHash(series, universe, issues);

  const existing = await loadSnapshot(seriesId);
  if (!force && existing && existing.status === 'complete' && existing.sourceInputsHash === hash) {
    return { ...existing, cached: true };
  }

  const canon = await getSeriesCanon(series);

  // Writer/judge split: resolve the judge provider/model from the arc-overview
  // writer stage's config (judgeProvider/judgeModel), honoring a route override.
  const writerStage = getStage(WRITER_STAGE);
  const { provider: judgeProvider, model: judgeModel } = await resolveJudgeForStage(writerStage, {
    providerOverride: providerId,
    modelOverride: model,
    providerDefault,
    modelDefault,
  });

  // Budget content to the judge model's window (#1488).
  const { contextWindow } = await resolveStageContext(STAGE, {
    providerOverride: judgeProvider.id,
    modelOverride: judgeModel,
  });
  const overheadTokens = 2_000 + estimateTokens(composeStyleNotes(series, { proseCraft: true }));
  const contentMax = manuscriptContentBudgetChars({
    contextWindow,
    overheadTokens,
    outputReserveTokens: JUDGE_OUTPUT_RESERVE_TOKENS,
  });

  const ctx = buildFoundationContext({ series, universe, canon, issues, contentMax });
  const result = await runFoundationJudgeStage(ctx, {
    returnsJson: true,
    providerOverride: judgeProvider.id,
    modelOverride: judgeModel,
    effortDefault: effort || effortDefault,
    source: STAGE,
  });

  const judge = sanitizeFoundationJudge(result.content);
  const weak = weakestDimension(judge.dimensions);
  const snapshot = {
    seriesId,
    universeId: series?.universeId || null,
    status: 'complete',
    sourceInputsHash: hash,
    providerId: result.providerId,
    model: result.model,
    judgeProviderId: judgeProvider.id,
    judgeModel: judgeModel || null,
    runId: result.runId,
    createdAt: existing?.createdAt || nowIso(),
    completedAt: nowIso(),
    weakest: weak ? weak.dimension : null,
    ...judge,
  };
  await saveSnapshot(snapshot);
  const actualProviderId = result.providerId || judgeProvider.id;
  const actualModel = result.model || judgeModel || '(default)';
  console.log(`🏛️ foundation judge — series=${seriesId.slice(0, 12)} weighted=${judge.weightedScore} target=${weak?.dimension || '—'}(${weak?.score ?? '—'}) via ${actualProviderId}/${actualModel}`);
  return snapshot;
}

/**
 * Load a series' stored foundation verdict with a `stale` flag. Returns null when
 * never judged.
 */
export async function getFoundationJudge(seriesId) {
  assertValidSeriesId(seriesId);
  const snap = await loadSnapshot(seriesId);
  if (!snap) return null;
  const series = await getSeries(seriesId).catch(() => null);
  const [universe, issues] = await Promise.all([
    series?.universeId ? getUniverse(series.universeId).catch(() => null) : null,
    series ? listIssues({ seriesId }).catch(() => null) : null,
  ]);
  const hash = series && issues ? foundationInputsHash(series, universe, issues) : null;
  return { ...snap, stale: hash ? isFoundationStale(snap, hash) : true };
}

// ---------- fix router (dimension → owning service) ----------

// The thinnest unlocked character to expand for a `character`-dimension fix: the
// one missing the MOST framework fields (most leverage), skipping locked
// records (locked entries are constraints, not fix targets). Pure — takes the
// canon character list, returns the entry id or null.
export function thinnestCharacter(characters) {
  const list = Array.isArray(characters) ? characters : [];
  let best = null;
  for (const c of list) {
    if (!c || c.locked === true) continue;
    const blanks = FRAMEWORK_STRING_FIELDS.filter((f) => isBlankString(c[f])).length
      + (isBlankArray(c.secrets) ? 1 : 0);
    if (blanks === 0) continue;
    if (best === null || blanks > best.blanks) best = { id: c.id, blanks };
  }
  return best ? best.id : null;
}

const REPAIRABLE_CHARACTER_FIELDS = Object.freeze([
  ...FRAMEWORK_STRING_FIELDS,
  'arcType',
  'secrets',
  'personality',
  'background',
  'relationships',
]);

const MAX_FOUNDATION_NEW_CHARACTERS = 3;
// Exhaustive, not restrictive: large casts are split across as many sequential
// calls as necessary so every story-referenced character gets authored without
// asking one response to carry an unbounded amount of JSON. Each batch sees the
// full ensemble map for differentiation and relationship continuity.
const CHARACTER_FOUNDATION_BATCH_SIZE = 6;

// How much of the synopsis-level plan a repair prompt may carry. The judge
// prompt this mirrors has always been budgeted (`buildFoundationContext` caps
// each section at a third of the model's usable input); repair alone sent the
// whole plan raw, so its prompt grew with every episode the series gained. On a
// long-running series that section reached 28KB of a 35KB prompt and BOTH the
// primary and the fallback TUI provider burned their full 10-minute timeout on
// it without emitting a response — which errored the entire autonomous run.
// ~12K chars (~3K tokens) keeps the arc spine plus the early episodes a
// character arc's transitions hang off, and still fits alongside the rest of the
// prompt inside a small local model's window. A fixed cap rather than a
// window-derived one on purpose: the binding constraint here is how much
// material a reasoning model will chew through before the wall clock runs out,
// not how much its context can hold.
const REPAIR_OUTLINE_MAX_CHARS = 12_000;
const CRAFT_REPAIR_MAX_ATTEMPTS = 2;

function craftRepairViolations(proposal) {
  const guide = proposal?.styleGuide;
  if (!guide || typeof guide !== 'object') return ['styleGuide is missing'];
  const violations = [];
  const validateEntries = (key, { min, max }) => {
    const entries = guide[key];
    if (!Array.isArray(entries)) {
      violations.push(`${key} must be an array`);
      return;
    }
    if (entries.length < min || entries.length > max) {
      violations.push(`${key} must contain ${min}-${max} entries`);
    }
    for (const [index, entry] of entries.entries()) {
      const passage = typeof entry?.passage === 'string' ? entry.passage.trim() : '';
      const note = typeof entry?.note === 'string' ? entry.note.trim() : '';
      if (!passage) violations.push(`${key}[${index}].passage is required`);
      else if (passage.length > STYLE_GUIDE_LIMITS.EXEMPLAR_PASSAGE_MAX) {
        violations.push(`${key}[${index}].passage exceeds ${STYLE_GUIDE_LIMITS.EXEMPLAR_PASSAGE_MAX} characters`);
      }
      if (!note) violations.push(`${key}[${index}].note is required`);
      else if (note.length > STYLE_GUIDE_LIMITS.EXEMPLAR_NOTE_MAX) {
        violations.push(`${key}[${index}].note exceeds ${STYLE_GUIDE_LIMITS.EXEMPLAR_NOTE_MAX} characters`);
      }
    }
  };
  validateEntries('voiceExemplars', { min: 1, max: 2 });
  validateEntries('voiceAntiExemplars', { min: 1, max: STYLE_GUIDE_LIMITS.EXEMPLARS_MAX });
  return violations;
}

async function runFoundationRepair(series, issues, dimension, finding, characters, options) {
  const stage = dimension === 'character' ? CHARACTER_FOUNDATION_STAGE : REPAIR_STAGE;
  const renderPromptCharacter = (character) => ({
    id: character.id,
    name: character.name,
    role: character.role,
    personality: character.personality,
    background: character.background,
    relationships: character.relationships,
    ...pickFrameworkFields(character),
  });
  const charactersPayload = dimension === 'character'
    ? {
      targetCharacters: characters.map(renderPromptCharacter),
      fullSeriesRoster: (options.ensembleCharacters || characters).map(renderPromptCharacter),
    }
    : characters.map(renderPromptCharacter);
  let violations = [];
  const maxAttempts = dimension === 'craft' ? CRAFT_REPAIR_MAX_ATTEMPTS : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const findingPayload = { gap: finding?.gap || '', fix: finding?.fix || '' };
    if (dimension === 'craft') {
      findingPayload.hardStorageContract = {
        voiceExemplars: '1-2 entries',
        voiceAntiExemplars: `1-${STYLE_GUIDE_LIMITS.EXEMPLARS_MAX} entries`,
        passageMaxChars: STYLE_GUIDE_LIMITS.EXEMPLAR_PASSAGE_MAX,
        noteMaxChars: STYLE_GUIDE_LIMITS.EXEMPLAR_NOTE_MAX,
        requirement: 'Every passage and note must end as complete prose within these limits; storage never preserves overflow.',
      };
      if (violations.length > 0) {
        findingPayload.retryReason = `The previous proposal violated the hard storage contract: ${violations.join('; ')}. Rewrite it shorter; do not merely cut it off.`;
      }
    }
    const result = await runStagedLLM(stage, {
      dimension,
      phase: options.phase || (dimension === 'character' ? 'post-arc reconciliation' : 'foundation repair'),
      foundationFindingJson: JSON.stringify(findingPayload, null, 2),
      seriesJson: JSON.stringify({
        id: series.id,
        name: series.name,
        premise: series.premise,
        targetFormat: series.targetFormat,
        issueCountTarget: series.issueCountTarget,
        styleNotes: series.styleNotes,
        styleGuide: series.styleGuide,
        characterArcs: series.characterArcs,
      }, null, 2),
      outline: renderArc(series, issues, { maxChars: REPAIR_OUTLINE_MAX_CHARS }),
      charactersJson: JSON.stringify(charactersPayload, null, 2),
    }, {
      returnsJson: true,
      providerDefault: options.providerId,
      modelDefault: options.model,
      effortDefault: options.effort,
      source: stage,
    });
    const proposal = result?.content && typeof result.content === 'object' ? result.content : {};
    if (dimension !== 'craft') return proposal;
    violations = craftRepairViolations(proposal);
    if (violations.length === 0) return proposal;
  }
  throw new Error(`foundation craft repair failed its storage contract after ${CRAFT_REPAIR_MAX_ATTEMPTS} attempts: ${violations.join('; ')}`);
}

async function repairCharacters(series, issues, universe, finding, options) {
  const seriesRoster = seriesFoundationCharacters(universe?.characters, series, issues);
  const targets = seriesRoster.filter((character) => character?.locked !== true);
  const targetBatches = targets.length > 0
    ? Array.from({ length: Math.ceil(targets.length / CHARACTER_FOUNDATION_BATCH_SIZE) }, (_, index) => (
      targets.slice(index * CHARACTER_FOUNDATION_BATCH_SIZE, (index + 1) * CHARACTER_FOUNDATION_BATCH_SIZE)
    ))
    : [[]];
  const proposals = [];
  let workingRoster = [...seriesRoster];
  const workingNewCharacters = [];
  for (const originalBatch of targetBatches) {
    const batchIds = new Set(originalBatch.map((character) => character.id));
    const targetBatch = workingRoster.filter((character) => batchIds.has(character.id));
    const proposal = await runFoundationRepair(series, issues, 'character', finding, targetBatch, {
      ...options,
      // Locked cast members are immutable constraints, but the model still
      // needs to see them when differentiating relationships and voices.
      // Later batches also see the accepted shape of earlier proposals, so two
      // batches cannot independently invent the same voice or relationship.
      ensembleCharacters: [...workingRoster, ...workingNewCharacters],
    });
    proposals.push(proposal);

    const proposedById = new Map((Array.isArray(proposal.characters) ? proposal.characters : [])
      .filter((character) => typeof character?.id === 'string')
      .map((character) => [character.id, character]));
    workingRoster = workingRoster.map((character) => {
      const raw = proposedById.get(character.id);
      if (!raw) return character;
      return sanitizeCharacter({ ...character, ...raw, id: character.id, name: character.name }) || character;
    });
    const knownNames = new Set([...workingRoster, ...workingNewCharacters]
      .map((character) => String(character?.name || '').trim().toLowerCase())
      .filter(Boolean));
    for (const raw of Array.isArray(proposal.newCharacters) ? proposal.newCharacters : []) {
      if (workingNewCharacters.length >= MAX_FOUNDATION_NEW_CHARACTERS) break;
      const nameKey = String(raw?.name || '').trim().toLowerCase();
      if (!nameKey || knownNames.has(nameKey)) continue;
      workingNewCharacters.push(raw);
      knownNames.add(nameKey);
    }
  }
  const proposedCharacters = proposals.flatMap((proposal) => (
    Array.isArray(proposal.characters) ? proposal.characters : []
  ));
  const proposalById = new Map(proposedCharacters
    .filter((character) => typeof character?.id === 'string')
    .map((character) => [character.id, character]));
  const targetIds = new Set(targets.map((character) => character.id));
  const updatedFields = new Set();
  let charactersApplied = false;
  const addedCharacters = [];
  await updateUniverse(universe.id, (latest) => {
    const latestCharacters = Array.isArray(latest?.characters) ? latest.characters : [];
    let changed = false;
    const characters = latestCharacters.map((character) => {
      if (!targetIds.has(character.id) || character.locked === true) return character;
      const raw = proposalById.get(character.id);
      if (!raw) return character;
      const sanitized = sanitizeCharacter({ ...character, ...raw, id: character.id, name: character.name });
      if (!sanitized) return character;
      const next = { ...character };
      for (const field of REPAIRABLE_CHARACTER_FIELDS) {
        const value = sanitized[field];
        const authored = Array.isArray(value) ? value.length > 0 : !isBlankString(value);
        if (!authored || JSON.stringify(value) === JSON.stringify(character[field])) continue;
        next[field] = value;
        updatedFields.add(field);
        changed = true;
      }
      return next;
    });
    const knownNames = new Set(characters
      .map((character) => String(character?.name || '').trim().toLowerCase())
      .filter(Boolean));
    const proposedNewCharacters = proposals
      .flatMap((proposal) => (Array.isArray(proposal.newCharacters) ? proposal.newCharacters : []))
      .slice(0, MAX_FOUNDATION_NEW_CHARACTERS);
    for (const raw of proposedNewCharacters) {
      const nameKey = String(raw?.name || '').trim().toLowerCase();
      if (!nameKey || knownNames.has(nameKey)) continue;
      const sanitized = sanitizeCharacter({
        ...raw,
        id: undefined,
        locked: false,
        source: BIBLE_SOURCE.SERIES_EXTRACT,
        sourceSeriesId: series.id,
      }, { preserveTimestamps: false });
      if (!sanitized) continue;
      characters.push(sanitized);
      addedCharacters.push(sanitized);
      knownNames.add(nameKey);
      changed = true;
    }
    if (!changed) return null;
    charactersApplied = true;
    return { characters };
  });

  const characterIdByName = new Map([
    ...(Array.isArray(universe?.characters) ? universe.characters : []),
    ...addedCharacters,
  ].map((character) => [String(character?.name || '').trim().toLowerCase(), character?.id]));
  const proposedArcs = sanitizeCharacterArcList(proposals
    .flatMap((proposal) => (Array.isArray(proposal.characterArcs) ? proposal.characterArcs : []))
    .map((arc) => ({
      ...arc,
      characterId: characterIdByName.get(String(arc?.characterName || '').trim().toLowerCase()) || arc?.characterId,
    })));
  let arcsApplied = false;
  if (proposedArcs.length > 0) {
    const latestSeries = await getSeries(series.id);
    // A legacy name-only arc and a newly canon-linked arc otherwise have
    // different sanitizer keys and survive as duplicates. Remove every prior
    // identity the proposal replaces, then rely on last-write-wins within the
    // proposal itself. This preserves untouched arcs while upgrading the
    // authored character to its stable canon id.
    const replacementKeys = new Set(proposedArcs.flatMap((arc) => [
      arc.characterId || '',
      arc.characterName ? `name:${arc.characterName.trim().toLowerCase()}` : '',
    ]).filter(Boolean));
    const untouchedArcs = (latestSeries.characterArcs || []).filter((arc) => (
      !replacementKeys.has(arc?.characterId || '')
      && !replacementKeys.has(arc?.characterName ? `name:${arc.characterName.trim().toLowerCase()}` : '')
    ));
    const mergedArcs = sanitizeCharacterArcList([...untouchedArcs, ...proposedArcs]);
    if (JSON.stringify(mergedArcs) !== JSON.stringify(latestSeries.characterArcs || [])) {
      await updateSeries(series.id, { characterArcs: mergedArcs });
      arcsApplied = true;
    }
  }

  const applied = charactersApplied || arcsApplied;
  return applied
    ? {
      applied: true,
      entryIds: targets.map((character) => character.id),
      updatedFields: [...updatedFields],
      charactersAdded: addedCharacters.length,
      characterArcsUpdated: arcsApplied,
    }
    : { applied: false, reason: 'repair model proposed no usable core-cast or character-arc changes' };
}

function hasCompleteFramework(character) {
  return FRAMEWORK_STRING_FIELDS.every((field) => !isBlankString(character?.[field]))
    && !isBlankArray(character?.secrets)
    && !isBlankString(character?.arcType);
}

/**
 * Establish the character engine before the plot spine is generated. This is
 * intentionally distinct from the later whole-foundation judge: the early pass
 * gives the arc planner causal people to build events around, while the later
 * pass reconciles those people with story-specific discoveries.
 */
export async function establishCharacterFoundation(seriesId, {
  providerDefault,
  modelDefault,
  effortDefault,
} = {}) {
  assertValidSeriesId(seriesId);
  const series = await getSeries(seriesId);
  if (!series?.universeId) {
    return { applied: false, skipped: true, ran: false, reason: 'no linked universe' };
  }
  const universe = await getUniverse(series.universeId).catch(() => null);
  if (!universe) {
    return { applied: false, skipped: true, ran: false, reason: 'linked universe not found' };
  }
  const targets = repairableSeriesFoundationCharacters(universe.characters, series, []);
  const authoredArcs = Array.isArray(series.characterArcs) ? series.characterArcs : [];
  const arcKeys = new Set(authoredArcs.flatMap((arc) => [
    arc?.characterId || '',
    `name:${String(arc?.characterName || '').trim().toLowerCase()}`,
  ]).filter(Boolean));
  const needsRepair = targets.length === 0 || targets.some((character) => (
    !hasCompleteFramework(character)
    || (!arcKeys.has(character.id) && !arcKeys.has(`name:${String(character.name || '').trim().toLowerCase()}`))
  ));
  if (!needsRepair) {
    return { applied: false, skipped: true, ran: false, reason: 'core character foundation is already complete' };
  }
  const result = await repairCharacters(series, [], universe, {
    gap: 'The plot spine has not been generated yet, so the core cast must first have specific causal inner engines and relationship tensions.',
    fix: 'Complete the core ensemble from the premise: Ghost to Wound to Lie to Want to Need, distinct voice and contradictions, active relationships, and a provisional whole-series change path. Add only a genuinely missing core role.',
  }, {
    providerId: providerDefault,
    model: modelDefault,
    effort: effortDefault,
    phase: 'pre-arc character foundation',
  });
  return { ...result, ran: true };
}

async function repairCraft(series, issues, finding, options) {
  const proposal = await runFoundationRepair(series, issues, 'craft', finding, [], options);
  const latestSeries = await getSeries(series.id);
  const rawGuide = proposal.styleGuide && typeof proposal.styleGuide === 'object'
    ? proposal.styleGuide
    : null;
  const existingGuide = latestSeries.styleGuide || {};
  const mergedGuide = rawGuide
    ? sanitizeStyleGuide({
      ...existingGuide,
      ...rawGuide,
      conventions: rawGuide.conventions && typeof rawGuide.conventions === 'object'
        ? { ...(existingGuide.conventions || {}), ...rawGuide.conventions }
        : existingGuide.conventions,
      voiceExemplars: Array.isArray(rawGuide.voiceExemplars) && rawGuide.voiceExemplars.length > 0
        ? rawGuide.voiceExemplars
        : existingGuide.voiceExemplars,
      voiceAntiExemplars: Array.isArray(rawGuide.voiceAntiExemplars) && rawGuide.voiceAntiExemplars.length > 0
        ? rawGuide.voiceAntiExemplars
        : existingGuide.voiceAntiExemplars,
    })
    : latestSeries.styleGuide;
  const styleNotes = typeof proposal.styleNotes === 'string' && proposal.styleNotes.trim()
    ? proposal.styleNotes.trim()
    : latestSeries.styleNotes;
  const patch = {};
  if (styleNotes !== latestSeries.styleNotes) patch.styleNotes = styleNotes;
  if (JSON.stringify(mergedGuide) !== JSON.stringify(latestSeries.styleGuide)) patch.styleGuide = mergedGuide;
  if (Object.keys(patch).length === 0) {
    return { applied: false, reason: 'repair model proposed no usable series voice changes' };
  }
  await updateSeries(series.id, patch);
  return { applied: true, updatedFields: Object.keys(patch) };
}

// Refine the universe world bible (worldbuilding dimension) through the
// owning service: regenerate logline/premise/styleNotes/influences via
// expandWorldTemplate — which ECHOES locked entries unchanged (force:false /
// no-clobber) — then persist through updateUniverse (serialized write queue).
// Mirrors storyBuilder.js's `universeAesthetic` step. Returns false when there's
// no universe to refine.
async function refineWorld(universeId, { providerId, model, effort, finding = {} }) {
  if (!universeId) return { applied: false, reason: 'no linked universe' };
  const universe = await getUniverse(universeId).catch(() => null);
  if (!universe) return { applied: false, reason: 'universe not found' };
  const expanded = await expandWorldTemplate({
    starterPrompt: universe.starterPrompt || universe.name,
    influences: universe.influences,
    logline: universe.logline,
    premise: universe.premise,
    styleNotes: universe.styleNotes,
    locked: universe.locked,
    foundationDirective: [finding.gap, finding.fix].filter(Boolean).join('\nRequested repair: '),
    providerId,
    model,
    effort,
    narrativeOnly: true,
  });
  // Persist through the write-queue mutator against the FRESHEST record, and
  // defensively DROP any field the user has locked — expandWorldTemplate is
  // meant to echo locked fields unchanged, but a bad LLM echo (or a lock set
  // DURING the LLM round-trip) must never overwrite human-locked canon. The
  // gate's whole contract is "locked entries are constraints, not fix targets."
  let wrote = false;
  await updateUniverse(universeId, (latest) => {
    const locked = latest?.locked || {};
    const patch = {};
    // Only write a scalar the LLM actually authored: expandWorldTemplate returns
    // null (or blank) for an OMITTED field, which is "nothing to add" — NOT a
    // clear. Writing it would erase the existing unlocked value (sanitize turns a
    // non-string into ''). Skip locked fields AND absent/blank ones; preserve the
    // current value in both cases (the CLAUDE.md absent-vs-empty rule).
    const filled = (v) => typeof v === 'string' && v.trim() !== '';
    if (locked.logline !== true && filled(expanded.logline)) patch.logline = expanded.logline;
    if (locked.premise !== true && filled(expanded.premise)) patch.premise = expanded.premise;
    if (locked.styleNotes !== true && filled(expanded.styleNotes)) patch.styleNotes = expanded.styleNotes;
    // `influences` is an { embrace, avoid } object and updateUniverse replaces it
    // WHOLESALE — but the lockable keys are the two SUBLISTS
    // (`influencesEmbrace`/`influencesAvoid`, see universeBuilder LOCKABLE_FIELDS),
    // not `influences`. A wholesale write would clobber a locked sublist, so only
    // write influences when NEITHER sublist is locked.
    const influencesLocked = locked.influencesEmbrace === true || locked.influencesAvoid === true;
    if (!influencesLocked && expanded.influences && typeof expanded.influences === 'object') patch.influences = expanded.influences;
    if (!Object.keys(patch).length) return null; // all locked or nothing authored → no-op
    wrote = true;
    return patch;
  });
  // `wrote === false` means every refinable field is locked — report it so the
  // gate pauses 'inapplicable' for human review instead of silently no-op-ing.
  return wrote ? { applied: true } : { applied: false, reason: 'every refinable world field is locked' };
}

/**
 * Apply a fix for one foundation dimension through its OWNING service (never a
 * raw write; `force:false` everywhere so locked canon is a constraint, not a
 * target). Returns `{ applied, dimension, reason? }`.
 *
 * Routing:
 *   worldbuilding → universe world refine (expandWorldTemplate → updateUniverse)
 *   craft         → series voice/style repair (including concrete exemplars)
 *   character     → judge-directed core-cast framework + character-arc repair
 *   structure     → arc resolve (resolveVerifyIssues) with the judge's finding
 *
 * `finding` is the judge's `{ gap, fix }` for the targeted dimension, threaded
 * into the structure resolve as a synthesized arc finding.
 */
export async function applyFoundationFix(seriesId, dimension, { finding = {}, providerOverride, modelOverride, effortOverride, preserveDroppedSeasons = false } = {}) {
  assertValidSeriesId(seriesId);
  const series = await getSeries(seriesId);
  const issues = await listIssues({ seriesId });
  const universeId = series?.universeId || null;
  const provider = { providerId: providerOverride, model: modelOverride, effort: effortOverride, finding };

  if (dimension === 'worldbuilding') {
    const r = await refineWorld(universeId, provider);
    return { dimension, ...r };
  }

  if (dimension === 'craft') {
    const r = await repairCraft(series, issues, finding, provider);
    return { dimension, ...r };
  }

  if (dimension === 'character') {
    if (!universeId) return { dimension, applied: false, reason: 'no linked universe' };
    const universe = await getUniverse(universeId).catch(() => null);
    if (!universe) return { dimension, applied: false, reason: 'universe not found' };
    const r = await repairCharacters(series, issues, universe, finding, { ...provider, phase: 'post-arc reconciliation' });
    return { dimension, ...r };
  }

  if (dimension === 'structure') {
    // A locked arc is a constraint, not a fix target — resolveVerifyIssues throws
    // on a locked arc, which would error the whole run. Degrade to a graceful
    // "can't apply" so the gate pauses for human review instead (mirrors the
    // no-linked-universe / fully-locked-cast paths above).
    if (series?.locked?.arc === true) {
      return { dimension, applied: false, reason: 'arc is locked (a constraint, not a fix target)' };
    }
    // Synthesize an arc finding from the judge's structure gap/fix and route it
    // through the existing arc-resolve owning service.
    const findings = [{
      severity: 'high',
      location: 'arc',
      problem: finding.gap || 'arc structure is below the foundation-quality bar',
      suggestion: finding.fix || '',
    }];
    const r = await resolveVerifyIssues(seriesId, {
      findings,
      providerDefault: providerOverride,
      modelDefault: modelOverride,
      // The autopilot's unlock-for-run mode clears both `series.locked.arc`
      // (disarming the short-circuit above) and every per-season lock, so this
      // is the third arc-rewriting path that could otherwise delete a volume.
      // Carry the same non-deletion guarantee the other two do.
      preserveDroppedSeasons,
      effortDefault: effortOverride,
    });
    return { dimension, applied: r?.applied !== false };
  }

  return { dimension, applied: false, reason: `unknown dimension: ${dimension}` };
}

export const __testing = {
  sanitizeFoundationJudge,
  foundationInputs,
  contentHash,
  isFoundationStale,
  buildFoundationContext,
  renderArc,
  renderCharacterLine,
  REPAIR_OUTLINE_MAX_CHARS,
  CHARACTER_FOUNDATION_BATCH_SIZE,
  FRAMEWORK_STRING_FIELDS,
};
