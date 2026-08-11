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
import { BIBLE_KEYS, BIBLE_SOURCE, sanitizeCharacter } from '../../lib/storyBible.js';
import { renderEntitiesSummary } from '../../lib/universePromptRenderers.js';
import { getUniverse, updateUniverse } from '../universeBuilder.js';
import { isBlankString, isBlankArray } from '../universeCharacterExpand.js';
import { expandWorldTemplate, narrativeRepairTargets } from '../universeBuilderExpand.js';
import { getSeries, updateSeries } from './series.js';
import { listIssues } from './issues.js';
import { getSeriesCanon } from './seriesCanon.js';
import {
  resolveVerifyIssues,
  restoreArcState,
  snapshotArcState,
  verifyArc,
} from './arcPlanner.js';

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
        // The starter prompt is the author's protected originating intent, not
        // just another generated bible paragraph. A change here must invalidate
        // a cached verdict, and the judge must compare every derived field to it
        // so a polished-but-off-premise foundation cannot fast-pass forever.
        starterPrompt: universe.starterPrompt || '',
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

const PLACEHOLDER_FINDING = /^(?:string|placeholder|todo|tbd|n\/?a|none|null|undefined)$/i;
const isMeaningfulFinding = (value) => (
  typeof value === 'string'
  && value.trim().length > 0
  && !PLACEHOLDER_FINDING.test(value.trim())
);

// A judge response is "valid-shaped" only when every rubric dimension contains
// a usable score plus concrete gap/fix prose. The prompt itself includes a JSON
// shape example whose values are `{ score: 6, gap: "string", fix: "string" }`;
// if a TUI screen scrape ever leaks through, a permissive dimensions-only check
// would mistake that echoed contract for a real verdict and spend a repair round
// on the literal instruction "string". Reject incomplete and placeholder
// rubrics so the deliberate retry (and ultimately the caller) handles them as
// malformed output instead of persisting fabricated editorial evidence.
export function isValidFoundationShape(content) {
  if (!(content && typeof content === 'object'
    && content.dimensions && typeof content.dimensions === 'object')) return false;
  if (!FOUNDATION_DIMENSIONS.every((dimension) => {
    const finding = content.dimensions[dimension];
    const score = Number(finding?.score);
    return finding && typeof finding === 'object'
      && Number.isFinite(score) && score >= 1 && score <= 10
      && isMeaningfulFinding(finding.gap)
      && isMeaningfulFinding(finding.fix);
  })) return false;
  return content.oneLineVerdict === undefined || isMeaningfulFinding(content.oneLineVerdict);
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

const pluralLines = (count) => (count === 1 ? 'line' : 'lines');

// Last-resort clamp for `renderArc`. Every tier above it drops WHOLE lines so the
// render stays coherent, but a budget smaller than the arc header itself (or a
// series with more volume loglines than the budget has room for) can still
// overrun — and `maxChars` is a hard contract, not a target. Slice, and keep the
// marker only when there is room for it.
const ARC_TRUNCATION_NOTE = '\n[series plan truncated to fit the prompt budget]';
function clampArcToBudget(text, maxChars) {
  if (!Number.isFinite(maxChars) || text.length <= maxChars) return text;
  if (maxChars <= ARC_TRUNCATION_NOTE.length) return text.slice(0, Math.max(0, maxChars));
  return `${text.slice(0, maxChars - ARC_TRUNCATION_NOTE.length)}${ARC_TRUNCATION_NOTE}`;
}

/**
 * Render the synopsis-level series plan: arc header, per-volume loglines and
 * synopses, the episode list under each volume, and the authored character arcs.
 *
 * `maxChars` is a HARD bound on the result, spent in tiers so the render always
 * degrades to something coherent rather than being sliced mid-sentence:
 *
 *   1. Drop WHOLE episode synopsis lines from the end. Earliest episodes survive
 *      a tight budget because that's where a character arc's opening transitions
 *      hang.
 *   2. If the spine alone (arc header + every volume's logline/synopsis/hook +
 *      the authored character arcs) still overruns, drop the per-volume synopsis
 *      and ending-hook lines, keeping `V# title: logline` so the volume order and
 *      shape survive. Every episode goes with them.
 *   3. Slice, as a floor, when even the loglines cannot fit — a caller that set a
 *      budget gets a smaller string, never a longer one.
 *
 * Each tier names what it left out, so the model can tell a short plan from a
 * budgeted one.
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
    const logline = `  V${season.number ?? '?'} ${season.title || ''}: ${season.logline || '(no logline)'}`;
    const detail = [`    Synopsis: ${season.synopsis || '(none)'}`];
    if (season.endingHook) detail.push(`    Ending hook: ${season.endingHook}`);
    const episodes = orderedIssues
      .filter((issue) => issue?.seasonId === season.id)
      .map((issue) => `    #${issue.number ?? '?'} ${issue.title || 'Untitled'}: ${issue?.stages?.idea?.input || '(no synopsis)'}`);
    return { logline, detail, episodes };
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

  // Tier 1: the full spine is unconditional; episodes fill whatever is left.
  const fullSpine = [...head, ...volumes.flatMap((volume) => [volume.logline, ...volume.detail]), ...tail];
  let remaining = maxChars - joinedLength(fullSpine);
  const notes = [];
  // Tier 2: the spine alone overruns, so the per-volume synopsis/hook lines go
  // and every episode goes with them — dropping craft detail to make room for
  // episode lines would invert the priority the tiers exist to express.
  const withDetail = remaining >= 0;
  if (!withDetail) {
    const droppedDetail = volumes.reduce((total, volume) => total + volume.detail.length, 0);
    if (droppedDetail > 0) {
      notes.push(`  [${droppedDetail} volume synopsis ${pluralLines(droppedDetail)} omitted to fit the prompt budget]`);
    }
    remaining = -1;
  }
  let omitted = 0;
  const lines = [...head];
  for (const volume of volumes) {
    lines.push(volume.logline);
    if (withDetail) lines.push(...volume.detail);
    for (const episode of volume.episodes) {
      if (episode.length + 1 <= remaining) {
        lines.push(episode);
        remaining -= episode.length + 1;
      } else {
        omitted += 1;
      }
    }
  }
  if (omitted > 0) lines.push(`  [${omitted} later episode synopsis ${pluralLines(omitted)} omitted to fit the prompt budget]`);
  lines.push(...notes, ...tail);
  return clampArcToBudget(lines.join('\n'), maxChars);
}

// Below this the named-canon line carries no usable signal — render the
// omission marker instead of a handful of dangling entity names.
const NAMED_CANON_MIN_CHARS = 200;

/**
 * Render the world as the worldbuilding dimension is scored on it, bounded by
 * `maxChars`.
 *
 * The budget is spent by dropping the NAMED-CANON inventory, never the narrative
 * spine. Causal rules, costs, hard limits, and failure modes live in the premise
 * and style notes; the entity list is the noun inventory whose over-supply the
 * judge already penalizes, and it is the part that grows without bound. Slicing
 * the joined block instead (what this did before) cut the TAIL of the premise —
 * exactly where a freshly authored ruleset lands — so a world repair the judge
 * had just demanded became invisible to the next judge, the score never moved,
 * and the foundation gate burned its rounds against a repair it could not see.
 */
function renderWorldFoundation(universe, { maxChars = Infinity } = {}) {
  if (!universe) return '(no linked universe — worldbuilding cannot be judged from canon)';
  const influences = universe.influences && typeof universe.influences === 'object'
    ? `Embrace: ${(universe.influences.embrace || []).join(', ') || '—'}; Avoid: ${(universe.influences.avoid || []).join(', ') || '—'}`
    : '(none)';
  const spine = [
    `Protected author intent (starter idea): ${universe.starterPrompt || '(none)'}`,
    `Universe logline: ${universe.logline || '(none)'}`,
    `Universe premise: ${universe.premise || '(none)'}`,
    `Universe style: ${universe.styleNotes || '(none)'}`,
    `Influences: ${influences}`,
  ].join('\n');
  const entities = renderEntitiesSummary(universe, { maxPerKind: { characters: 0 } }) || '(no named places or objects)';
  const canonLine = `Named canon: ${entities}`;
  const remaining = maxChars - spine.length - 1;
  if (canonLine.length <= remaining) return `${spine}\n${canonLine}`;
  if (remaining >= NAMED_CANON_MIN_CHARS) return `${spine}\n${canonLine.slice(0, remaining - 1).trimEnd()}…`;
  if (spine.length <= maxChars) return `${spine}\nNamed canon: [omitted to fit the judging budget]`;
  // The spine alone overruns: the premise is larger than this judge model's
  // world budget. Slicing is unavoidable here, but say so rather than letting
  // the judge score a silently amputated world.
  return `${spine.slice(0, maxChars)}\n\n[world summary truncated for judging]`;
}

// Build the judge's variable bag from the whole foundation. Content is budgeted
// to the judge model's window (a small/local judge trims to fit rather than
// overflowing; a big-context judge gets the whole foundation).
function buildFoundationContext({ series, universe, canon, issues = [], contentMax }) {
  const characters = Array.isArray(canon?.characters) ? canon.characters : [];
  const seriesCharacters = seriesFoundationCharacters(characters, series, issues);
  const characterRoster = seriesCharacters.length
    ? seriesCharacters.map((character) => renderCharacterLine(character, { core: true })).join('\n')
    : '(no canon characters)';
  const sectionMax = Math.max(1_000, Math.floor(contentMax / 3));
  const world = renderWorldFoundation(universe, { maxChars: sectionMax });
  // Character quality lives in the choices between start and end, not merely
  // the endpoints. Reuse the canonical authored-arc renderer here so the judge
  // sees decisions, relapses, sacrifices, and their issue placement. The
  // repair prompt keeps the legacy compact summary because it already receives
  // the full `series.characterArcs` JSON separately.
  const arcText = renderArc(series, issues, { includeArcTransitions: true });
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
      lastError = new Error('foundation judge response parsed but its rubric is incomplete or contains placeholders');
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
  onRunCreated,
  onRunSettled,
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
  // Cache only a verdict that still satisfies the current rubric contract.
  // This also self-heals snapshots written by an older permissive validator
  // from echoed prompt examples (`gap: "string"`): unchanged story inputs must
  // not make fabricated editorial evidence immortal across restarts/resumes.
  if (!force
    && existing
    && existing.status === 'complete'
    && existing.sourceInputsHash === hash
    && isValidFoundationShape(existing)) {
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
    onRunCreated,
    onRunSettled,
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

// The outline cap above only ever bound ONE of the repair prompt's three large
// sections. A real character-foundation run built a 72KB prompt — 35KB of raw
// series seed, 18KB of outline, 15KB of candidate cast — and burned a CLI
// runner's full wall clock without emitting a byte. Each section now carries its
// own budget so the total lands near 40K chars, which the stage demonstrably
// completes within. Same reasoning as the outline cap: fixed rather than
// window-derived, because the binding constraint is how much material a
// reasoning model chews through before the clock runs out, not context size.
const REPAIR_SERIES_MAX_CHARS = 12_000;
const REPAIR_CHARACTERS_MAX_CHARS = 12_000;

// The character-foundation stage reasons over the whole ensemble at once, so it
// is the slowest repair stage by a wide margin. Ten minutes proved short enough
// to kill productive high-effort work. Keep a finite safety ceiling for a truly
// hung provider, but give a quality-first ensemble pass enough room to finish.
const CHARACTER_FOUNDATION_TIMEOUT_MS = 7_200_000;

const CRAFT_REPAIR_MAX_ATTEMPTS = 2;

// A repair prompt's JSON sections shed the least load-bearing material first,
// then trim the free-text fields that remain, so the payload stays VALID JSON at
// every tier — a mid-object slice would hand the model a parse error instead of
// a smaller brief. That is the one way these differ from `renderArc`, which is
// plain text and hard-clamps: below the JSON skeleton's own size (a few hundred
// chars of keys and notes) these renderers overshoot the budget rather than
// emitting something unparseable. The real budgets are 12,000.
const JSON_TRUNCATION_MARK = '… [truncated to fit the prompt budget]';
function fitJsonToBudget(payload, trimKeys, maxChars) {
  const shrunk = { ...payload };
  let rendered = JSON.stringify(shrunk, null, 2);
  while (rendered.length > maxChars) {
    const key = trimKeys
      .filter((candidate) => typeof shrunk[candidate] === 'string' && shrunk[candidate].length > 0)
      .sort((a, b) => shrunk[b].length - shrunk[a].length)[0];
    // Nothing left that is safe to trim (structural ids/counts only) — return the
    // smallest valid JSON we can build rather than corrupting it with a slice.
    if (!key) return rendered;
    const keep = Math.max(0, shrunk[key].length - Math.max(rendered.length - maxChars, 1) - JSON_TRUNCATION_MARK.length);
    shrunk[key] = keep > 0 ? `${shrunk[key].slice(0, keep)}${JSON_TRUNCATION_MARK}` : '';
    rendered = JSON.stringify(shrunk, null, 2);
  }
  return rendered;
}

// Drop the style guide's exemplars first — they are craft-dimension material and
// tell a character or world repair nothing — then flatten the authored character
// arcs to their want/need spine, which the outline section already renders in
// full. `premise` / `targetFormat` / `issueCountTarget` / `styleNotes` are the
// brief itself and stay unconditional.
function renderRepairSeriesJson(series, maxChars = REPAIR_SERIES_MAX_CHARS) {
  const base = {
    id: series?.id,
    name: series?.name,
    premise: series?.premise,
    targetFormat: series?.targetFormat,
    issueCountTarget: series?.issueCountTarget,
    styleNotes: series?.styleNotes,
  };
  const arcs = Array.isArray(series?.characterArcs) ? series.characterArcs : [];
  const trimKeys = ['styleNotes', 'premise'];
  const tiers = [
    { ...base, styleGuide: series?.styleGuide, characterArcs: series?.characterArcs },
    {
      ...base,
      characterArcs: series?.characterArcs,
      omitted: 'styleGuide (craft exemplars) omitted to fit the prompt budget',
    },
    {
      ...base,
      characterArcs: arcs.map((arc) => ({
        characterId: arc?.characterId,
        characterName: arc?.characterName,
        want: arc?.want,
        need: arc?.need,
      })),
      omitted: 'styleGuide and character-arc detail omitted to fit the prompt budget; see the outline section',
    },
    // The arcs are named in full in the outline section, so the last structural
    // tier keeps only their count — after this only the brief's own free text is
    // left, which `fitJsonToBudget` can trim.
    {
      ...base,
      characterArcCount: arcs.length,
      omitted: 'styleGuide and every character arc omitted to fit the prompt budget; see the outline section',
    },
  ];
  for (const tier of tiers) {
    const rendered = JSON.stringify(tier, null, 2);
    if (rendered.length <= maxChars) return rendered;
  }
  return fitJsonToBudget(tiers.at(-1), trimKeys, maxChars);
}

// The full-ensemble roster is the unbounded half of the character payload:
// `CHARACTER_FOUNDATION_BATCH_SIZE` bounds `targetCharacters`, but
// `fullSeriesRoster` carries every cast member with every framework field, so it
// grows with the series. Compact the roster to the differentiation spine before
// dropping members — the roster exists so the batch can differentiate and keep
// relationships straight, which a name/role/want/need line still supports.
const compactRosterCharacter = (character) => ({
  id: character?.id,
  name: character?.name,
  role: character?.role,
  want: character?.want || '',
  need: character?.need || '',
});

// `CHARACTER_FOUNDATION_BATCH_SIZE` bounds how MANY characters a batch carries,
// not how large each one is — six characters with long personality/background/
// relationship prose still run to tens of KB. So the last tier caps every string
// field on the batch itself, halving the cap until the payload fits.
// An explicit ladder rather than a halving loop: a loop guarded on `>= floor`
// steps 1_200 → … → 75 → 37 and exits WITHOUT ever trying the floor itself.
const CHARACTER_FIELD_CAPS = Object.freeze([1_200, 600, 300, 150, 75, 40]);
const truncateField = (value, cap) => {
  if (typeof value !== 'string' || value.length <= cap) return value;
  // Below the marker's own length the marker would be the longer string — slice
  // bare rather than "truncating" a field into a longer one.
  if (cap <= JSON_TRUNCATION_MARK.length) return value.slice(0, Math.max(0, cap));
  return `${value.slice(0, cap - JSON_TRUNCATION_MARK.length)}${JSON_TRUNCATION_MARK}`;
};
// Recursive so a nested shape (an array of objects, an object-valued field)
// cannot smuggle uncapped prose past the budget.
const capValue = (value, cap) => {
  if (Array.isArray(value)) return value.map((entry) => capValue(entry, cap));
  if (value && typeof value === 'object') return capCharacterFields(value, cap);
  return truncateField(value, cap);
};
function capCharacterFields(character, cap) {
  return Object.fromEntries(Object.entries(character || {}).map(([key, value]) => [key, capValue(value, cap)]));
}

function renderRepairCharactersJson(payload, maxChars = REPAIR_CHARACTERS_MAX_CHARS) {
  const render = (value) => JSON.stringify(value, null, 2);
  const full = render(payload);
  if (full.length <= maxChars) return full;

  // The flat array shape (non-character dimensions) is ALL batch — there is no
  // roster to shed — so it trims field text rather than dropping fields, and only
  // falls back to the compact spine when even the tightest cap does not fit.
  if (Array.isArray(payload)) {
    let rendered = full;
    for (const cap of CHARACTER_FIELD_CAPS) {
      rendered = render(payload.map((character) => capCharacterFields(character, cap)));
      if (rendered.length <= maxChars) return rendered;
    }
    // Floor: the compact spine at the tightest cap, shedding trailing members
    // until it fits. The budget is a hard contract, so a cast large enough to
    // overrun even that loses members rather than the bound.
    const spine = payload.map((character) => capCharacterFields(compactRosterCharacter(character), CHARACTER_FIELD_CAPS.at(-1)));
    let kept = spine.length;
    rendered = render(spine);
    while (kept > 0 && rendered.length > maxChars) {
      kept -= 1;
      rendered = render(spine.slice(0, kept));
    }
    return rendered;
  }

  const targets = Array.isArray(payload?.targetCharacters) ? payload.targetCharacters : [];
  const roster = Array.isArray(payload?.fullSeriesRoster) ? payload.fullSeriesRoster : [];
  const compactRoster = roster.map(compactRosterCharacter);
  const rosterNote = (kept) => (kept === compactRoster.length
    ? 'Roster compacted to name/role/want/need to fit the prompt budget.'
    : `Roster compacted and limited to ${kept} of ${compactRoster.length} members to fit the prompt budget.`);
  const buildTargets = (cap, spine) => {
    const shaped = spine ? targets.map(compactRosterCharacter) : targets;
    return cap ? shaped.map((character) => capCharacterFields(character, cap)) : shaped;
  };
  const targetNote = (cap, spine) => {
    if (spine) return `Batch compacted to name/role/want/need and truncated at ${cap} characters to fit the prompt budget.`;
    return cap ? `Character fields over ${cap} characters were truncated to fit the prompt budget.` : undefined;
  };
  const build = (kept, cap, spine = false) => render({
    targetCharacters: buildTargets(cap, spine),
    fullSeriesRoster: compactRoster.slice(0, kept),
    rosterNote: rosterNote(kept),
    ...(targetNote(cap, spine) ? { targetNote: targetNote(cap, spine) } : {}),
  });

  // At a given field cap, keep as many roster members as fit. The batch under
  // repair outranks the roster, so the cap only tightens once even an empty
  // roster cannot make room.
  const bestFit = (cap, spine = false) => {
    let kept = compactRoster.length;
    let rendered = build(kept, cap, spine);
    while (kept > 0 && rendered.length > maxChars) {
      kept -= 1;
      rendered = build(kept, cap, spine);
    }
    return rendered;
  };

  let rendered = bestFit(null);
  for (const cap of CHARACTER_FIELD_CAPS) {
    if (rendered.length <= maxChars) return rendered;
    rendered = bestFit(cap);
  }
  // Floor: compact the batch itself to the spine. Lossy for the characters under
  // repair, which is why it is last, but the budget is a hard contract.
  if (rendered.length > maxChars) rendered = bestFit(CHARACTER_FIELD_CAPS.at(-1), true);
  return rendered;
}

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
      seriesJson: renderRepairSeriesJson(series),
      outline: renderArc(series, issues, { maxChars: REPAIR_OUTLINE_MAX_CHARS }),
      charactersJson: renderRepairCharactersJson(charactersPayload),
    }, {
      returnsJson: true,
      providerDefault: options.providerId,
      modelDefault: options.model,
      effortDefault: options.effort,
      onRunCreated: options.onRunCreated,
      onRunSettled: options.onRunSettled,
      source: stage,
      ...(stage === CHARACTER_FOUNDATION_STAGE ? { timeoutOverride: CHARACTER_FOUNDATION_TIMEOUT_MS } : {}),
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
    const existingArcByKey = new Map((latestSeries.characterArcs || []).flatMap((arc) => [
      arc?.characterId ? [arc.characterId, arc] : null,
      arc?.characterName ? [`name:${arc.characterName.trim().toLowerCase()}`, arc] : null,
    ].filter(Boolean)));
    // Character repairs after the macro arc may deepen motivation, arc type,
    // and start/end states, but transition beats are plot events. Letting this
    // editor add or move them silently creates an arc-ledger event that no
    // episode synopsis stages; the next judge then (correctly) penalizes the
    // structure for a contradiction the previous repair just invented. Keep
    // existing authored transitions unchanged in post-arc reconciliation and leave
    // missing scene placement to the structure owner (`resolveVerifyIssues`).
    const boundedProposedArcs = options.phase === 'post-arc reconciliation'
      ? proposedArcs.map((arc) => {
        const existing = existingArcByKey.get(arc.characterId)
          || existingArcByKey.get(`name:${String(arc.characterName || '').trim().toLowerCase()}`);
        return existing
          ? { ...arc, transitions: Array.isArray(existing.transitions) ? existing.transitions : [] }
          : arc;
      })
      : proposedArcs;
    // A legacy name-only arc and a newly canon-linked arc otherwise have
    // different sanitizer keys and survive as duplicates. Remove every prior
    // identity the proposal replaces, then rely on last-write-wins within the
    // proposal itself. This preserves untouched arcs while upgrading the
    // authored character to its stable canon id.
    const replacementKeys = new Set(boundedProposedArcs.flatMap((arc) => [
      arc.characterId || '',
      arc.characterName ? `name:${arc.characterName.trim().toLowerCase()}` : '',
    ]).filter(Boolean));
    const untouchedArcs = (latestSeries.characterArcs || []).filter((arc) => (
      !replacementKeys.has(arc?.characterId || '')
      && !replacementKeys.has(arc?.characterName ? `name:${arc.characterName.trim().toLowerCase()}` : '')
    ));
    const mergedArcs = sanitizeCharacterArcList([...untouchedArcs, ...boundedProposedArcs]);
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
  onRunCreated,
  onRunSettled,
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
    onRunCreated,
    onRunSettled,
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
async function refineWorld(universeId, { providerId, model, effort, onRunCreated, onRunSettled, finding = {} }) {
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
    onRunCreated,
    onRunSettled,
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
  if (!wrote) return { applied: false, reason: 'every refinable world field is locked' };
  // A repair that landed against a field already at its storage ceiling had to
  // consolidate existing prose to make room. Say so on the fix frame: when the
  // gate later pauses on non-convergence, "the premise is full" is the fact that
  // tells a human to prune the bible rather than re-run the same repair.
  const saturated = Object.entries(narrativeRepairTargets(universe))
    .filter(([, budget]) => budget.saturated)
    .map(([field]) => field);
  return saturated.length
    ? { applied: true, reason: `world bible ${saturated.join(' and ')} sat at the storage ceiling; the repair had to consolidate existing canon to fit` }
    : { applied: true };
}

const FOUNDATION_UNIVERSE_SNAPSHOT_FIELDS = Object.freeze([
  'logline', 'premise', 'styleNotes', 'influences', 'characters',
]);

const FOUNDATION_SERIES_SNAPSHOT_FIELDS = Object.freeze([
  'styleNotes', 'styleGuide', 'characterArcs',
]);

const pickFoundationFields = (record, fields) => Object.fromEntries(
  fields.map((field) => [
    field,
    record && Object.hasOwn(record, field) ? structuredClone(record[field]) : undefined,
  ]),
);

// Per-canon-entry fields the universe WRITE PATH owns, which a faithful restore
// therefore does NOT (and must not) bring back to the checkpoint value:
//   - `updatedAt` is re-stamped by `updateUniverse` on every canon entry whose
//     content changed vs the live record — and undoing a repair IS a content
//     change, so a correct revert always comes back with a fresh LWW clock (it
//     has to, or the canon→catalog projection would never carry the revert).
//   - the render/sheet pointers are deliberately preserved FROM the live record
//     (`mergePreservedSheetPointers` / `preserveImageRefsById`) so a sheet or
//     render that completed while the repair ran isn't thrown away by the undo.
// Comparing them made every faithful character rollback report itself as a
// failed restore, which stalled the foundation gate with a checkpoint-corruption
// warning that was never true. Authored content is still compared byte-for-byte.
const CANON_WRITE_PATH_OWNED_FIELDS = Object.freeze([
  'updatedAt', 'referenceSheetImageRef', 'referenceSheets', 'imageRefs',
]);

const comparableCanonEntry = (entry) => {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
  const rest = { ...entry };
  for (const field of CANON_WRITE_PATH_OWNED_FIELDS) delete rest[field];
  return rest;
};

// Walk EVERY canon array the bible defines, not just `characters`. The write
// path (`stampChangedCanonEntries` in universeBuilder/crud.js) stamps
// `updatedAt` across all of `BIBLE_KEYS`, so the moment a canon array beyond
// `characters` joins FOUNDATION_UNIVERSE_SNAPSHOT_FIELDS the same false
// "restored foundation fields did not match the checkpoint" pause would return.
const comparableUniverseFields = (universe) => {
  if (!universe || typeof universe !== 'object') return universe ?? null;
  const comparable = { ...universe };
  for (const key of BIBLE_KEYS) {
    if (Array.isArray(comparable[key])) comparable[key] = comparable[key].map(comparableCanonEntry);
  }
  return comparable;
};

// `undefined` (field absent from the record) is NOT the same as `null` — the
// restore skips absent fields, so a repair-added field the checkpoint never had
// is a genuine leftover the verification must still catch. The sentinel keeps
// the two distinguishable through JSON.
const comparablePart = (value) => (value === undefined ? '<absent>' : JSON.stringify(value ?? null));

/**
 * Field-keyed projection of a foundation snapshot for the post-restore check.
 * Keyed (rather than one blob) so a mismatch can NAME what failed to come back —
 * a bare "did not match" pause tells an operator nothing about what to inspect.
 */
const foundationSnapshotParts = (snapshot) => {
  const universe = comparableUniverseFields(snapshot?.universe);
  const parts = { universeId: comparablePart(snapshot?.universeId || null) };
  for (const field of FOUNDATION_UNIVERSE_SNAPSHOT_FIELDS) {
    parts[`universe.${field}`] = comparablePart(universe ? universe[field] : null);
  }
  for (const field of FOUNDATION_SERIES_SNAPSHOT_FIELDS) {
    parts[`series.${field}`] = comparablePart(snapshot?.series ? snapshot.series[field] : null);
  }
  parts.arc = comparablePart(snapshot?.arcState?.arc ?? null);
  parts.seasons = comparablePart(snapshot?.arcState?.seasons || []);
  parts.episodes = comparablePart(snapshot?.arcState?.episodes || []);
  return parts;
};

/** The snapshot fields that did NOT come back — [] when the restore was faithful. */
const mismatchedFoundationFields = (checkpoint, restored) => {
  const before = foundationSnapshotParts(checkpoint);
  const after = foundationSnapshotParts(restored);
  return Object.keys(before).filter((field) => before[field] !== after[field]);
};

/**
 * Capture every field an owned foundation repair may rewrite. Arc planning has
 * its own exact snapshot (including episode ideas); this adds the world,
 * character, and craft-owned records so the conductor can reject a repair that
 * a fresh judge proves did not earn its changes.
 */
export async function snapshotFoundationState(seriesId) {
  assertValidSeriesId(seriesId);
  const series = await getSeries(seriesId);
  const [universe, arcState] = await Promise.all([
    series?.universeId ? getUniverse(series.universeId).catch(() => null) : null,
    snapshotArcState(seriesId),
  ]);
  return {
    seriesId,
    universeId: series?.universeId || null,
    universe: universe ? pickFoundationFields(universe, FOUNDATION_UNIVERSE_SNAPSHOT_FIELDS) : null,
    series: pickFoundationFields(series, FOUNDATION_SERIES_SNAPSHOT_FIELDS),
    arcState,
  };
}

/** Restore a foundation snapshot and verify the tracked fields match exactly. */
export async function restoreFoundationState(seriesId, snapshot) {
  if (!snapshot || snapshot.seriesId !== seriesId || !snapshot.arcState) {
    return { restored: false, reason: 'invalid foundation snapshot' };
  }
  if (snapshot.universeId && snapshot.universe) {
    await updateUniverse(snapshot.universeId, Object.fromEntries(
      Object.entries(structuredClone(snapshot.universe)).filter(([, value]) => value !== undefined),
    ));
  }
  await updateSeries(seriesId, Object.fromEntries(
    Object.entries(structuredClone(snapshot.series)).filter(([, value]) => value !== undefined),
  ));
  const arcRestore = await restoreArcState(seriesId, snapshot.arcState);
  const restoredSnapshot = await snapshotFoundationState(seriesId);
  const mismatched = mismatchedFoundationFields(snapshot, restoredSnapshot);
  const restored = mismatched.length === 0;
  return {
    restored,
    reason: restored
      ? null
      : `restored foundation fields did not match the checkpoint: ${mismatched.join(', ')}`,
    mismatchedFields: mismatched,
    episodesRestored: arcRestore.episodesRestored || 0,
  };
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
export async function applyFoundationFix(seriesId, dimension, {
  finding = {},
  providerOverride,
  modelOverride,
  effortOverride,
  judgeProviderDefault,
  judgeModelDefault,
  judgeEffortDefault,
  preserveDroppedSeasons = false,
  onRunCreated,
  onRunSettled,
} = {}) {
  assertValidSeriesId(seriesId);
  const series = await getSeries(seriesId);
  const issues = await listIssues({ seriesId });
  const universeId = series?.universeId || null;
  const provider = {
    providerId: providerOverride,
    model: modelOverride,
    effort: effortOverride,
    finding,
    onRunCreated,
    onRunSettled,
  };

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
    const snapshot = await snapshotArcState(seriesId);
    const resolveOptions = {
      providerDefault: providerOverride,
      modelDefault: modelOverride,
      // The autopilot's unlock-for-run mode clears both `series.locked.arc`
      // (disarming the short-circuit above) and every per-season lock, so this
      // is the third arc-rewriting path that could otherwise delete a volume.
      // Carry the same non-deletion guarantee the other two do.
      preserveDroppedSeasons,
      effortDefault: effortOverride,
      onRunCreated,
      onRunSettled,
    };
    const verifyOptions = {
      providerDefault: judgeProviderDefault,
      modelDefault: judgeModelDefault,
      effortDefault: judgeEffortDefault,
      onRunCreated,
      onRunSettled,
    };
    const runGuardedStructureRepair = async () => {
      const first = await resolveVerifyIssues(seriesId, { findings, ...resolveOptions });
      if (first?.applied === false) {
        return { dimension, applied: false, reason: first?.notes || 'arc resolver applied no change' };
      }

      let verification = await verifyArc(seriesId, verifyOptions);
      let blockers = Array.isArray(verification?.issues) ? verification.issues : [];
      if (blockers.length === 0) return { dimension, applied: true, actions: 2 };

      // A foundation-directed structure rewrite can satisfy its broad judge
      // while accidentally violating a narrower canon/location/timing rule.
      // Give the specialized arc verifier's concrete findings one bounded
      // corrective pass before the next foundation round. This keeps those
      // contradictions from consuming the foundation budget as if they were
      // deeper critique, while still bounding spend and rewrite blast radius.
      const correction = await resolveVerifyIssues(seriesId, {
        findings: blockers,
        ...resolveOptions,
      });
      if (correction?.applied !== false) {
        verification = await verifyArc(seriesId, verifyOptions);
        blockers = Array.isArray(verification?.issues) ? verification.issues : [];
      }
      if (blockers.length === 0) return { dimension, applied: true, actions: 4 };

      await restoreArcState(seriesId, snapshot);
      return {
        dimension,
        applied: false,
        actions: correction?.applied === false ? 3 : 4,
        reason: `structure repair left ${blockers.length} arc-verification blocker(s); reverted to the pre-repair plan`,
        // The blockers that condemned the rewrite. Without them the revert is a
        // bare count in prose, and the pause it raises reports dimension-level
        // gaps instead — a different set entirely — so the user is never shown
        // why a plausible rewrite was thrown away.
        discarded: blockers,
      };
    };
    // Any provider/parse failure after the first mutation must not strand the
    // series in the unverified intermediate draft. Restore, then preserve the
    // original error so the conductor pauses with the real provider diagnosis.
    return runGuardedStructureRepair().catch(async (err) => {
      await restoreArcState(seriesId, snapshot);
      throw err;
    });
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
  renderWorldFoundation,
  renderCharacterLine,
  renderRepairSeriesJson,
  renderRepairCharactersJson,
  REPAIR_OUTLINE_MAX_CHARS,
  REPAIR_SERIES_MAX_CHARS,
  REPAIR_CHARACTERS_MAX_CHARS,
  CHARACTER_FOUNDATION_TIMEOUT_MS,
  CHARACTER_FOUNDATION_BATCH_SIZE,
  FRAMEWORK_STRING_FIELDS,
  mismatchedFoundationFields,
  comparableUniverseFields,
  CANON_WRITE_PATH_OWNED_FIELDS,
  FOUNDATION_UNIVERSE_SNAPSHOT_FIELDS,
};
