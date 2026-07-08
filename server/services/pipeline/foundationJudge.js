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
 * autopilot gate spends: proceed to beat sheets once the weighted score clears a
 * configurable threshold; otherwise the bounded improve loop (in
 * seriesAutopilot.js `runFoundationGate`) targets the weakest dimension, applies
 * the fix through the OWNING service (never a raw write, `force:false`
 * everywhere), and re-judges.
 *
 * Fast-pass / skip: the judged inputs (canon + character records + arc) are
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
import { composeStyleNotes } from '../../lib/styleGuide.js';
import { renderEntitiesSummary } from '../../lib/universePromptRenderers.js';
import { getUniverse, updateUniverse } from '../universeBuilder.js';
import { expandUniverseCharacter, isBlankString, isBlankArray } from '../universeCharacterExpand.js';
import { expandWorldTemplate } from '../universeBuilderExpand.js';
import { getSeries } from './series.js';
import { getSeriesCanon } from './seriesCanon.js';
import { resolveVerifyIssues } from './arcPlanner.js';

const STAGE = 'pipeline-judge-foundation';
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

// The judged foundation as a stable, hashable projection: universe canon
// (worldbuilding), character records, and the arc/seasons (structure). A change
// to ANY of these flips the pinned hash so a re-judge re-runs; an unchanged
// foundation short-circuits to the cached verdict. Kept deliberately narrow —
// only the fields the judge actually reads — so an unrelated series edit (e.g. a
// render slot) doesn't needlessly invalidate the score.
export function foundationInputs(series, universe) {
  const characters = Array.isArray(universe?.characters) ? universe.characters : [];
  return {
    world: universe
      ? {
        logline: universe.logline || '',
        premise: universe.premise || '',
        styleNotes: universe.styleNotes || '',
        categories: universe.categories || {},
        compositeSheets: universe.compositeSheets || [],
        // Places/objects are rendered into the world summary the judge scores,
        // so a user edit to either must flip the pinned hash (otherwise a clean
        // verdict would wrongly fast-pass a changed world).
        places: Array.isArray(universe.places) ? universe.places : [],
        objects: Array.isArray(universe.objects) ? universe.objects : [],
      }
      : null,
    characters: characters.map((c) => ({
      id: c.id,
      name: c.name,
      role: c.role || '',
      ...pickFrameworkFields(c),
    })),
    arc: series?.arc || null,
    seasons: Array.isArray(series?.seasons)
      ? series.seasons.map((s) => ({ id: s.id, number: s.number, logline: s.logline, endingHook: s.endingHook, summary: s.summary }))
      : [],
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
export const foundationInputsHash = (series, universe) => contentHash(foundationInputs(series, universe));

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
function renderCharacterLine(c) {
  const present = FRAMEWORK_STRING_FIELDS.filter((f) => !isBlankString(c?.[f]));
  const blanks = FRAMEWORK_STRING_FIELDS.filter((f) => isBlankString(c?.[f]));
  const secretCount = Array.isArray(c?.secrets) ? c.secrets.length : 0;
  const role = c?.role ? ` (${c.role})` : '';
  const has = present.length ? `has: ${present.join(', ')}` : 'has: —';
  const missing = blanks.length ? ` | missing: ${blanks.join(', ')}` : '';
  return `- **${c?.name || 'Unnamed'}**${role} — ${has}${missing} | secrets: ${secretCount}${c?.arcType ? ` | arcType: ${c.arcType}` : ''}`;
}

function renderArc(series) {
  const arc = series?.arc || {};
  const seasons = Array.isArray(series?.seasons) ? [...series.seasons].sort((a, b) => (a.number || 0) - (b.number || 0)) : [];
  const themes = Array.isArray(arc.themes) ? arc.themes.join(', ') : (arc.themes || '');
  const lines = [
    `Logline: ${arc.logline || '(none)'}`,
    `Summary: ${arc.summary || '(none)'}`,
    `Themes: ${themes || '(none)'}`,
    `Protagonist arc: ${arc.protagonistArc || '(none)'}`,
    `Shape: ${arc.shape || '(unset)'}`,
    '',
    `Volumes (${seasons.length}):`,
    ...seasons.map((s) => `  V${s.number ?? '?'}: ${s.logline || '(no logline)'}${s.endingHook ? ` → hook: ${s.endingHook}` : ''}`),
  ];
  return lines.join('\n');
}

// Build the judge's variable bag from the whole foundation. Content is budgeted
// to the judge model's window (a small/local judge trims to fit rather than
// overflowing; a big-context judge gets the whole foundation).
function buildFoundationContext({ series, universe, canon, contentMax }) {
  const characters = Array.isArray(canon?.characters) ? canon.characters : [];
  const worldEntitiesSummary = universe
    ? (renderEntitiesSummary(universe, { maxPerKind: { characters: 0 } }) || '(none)')
    : '(no linked universe — worldbuilding cannot be judged from canon)';
  const characterRoster = characters.length
    ? characters.map(renderCharacterLine).join('\n')
    : '(no canon characters)';
  const arcText = renderArc(series);
  // Truncate the coarsest, most variable section (world entities) first so the
  // arc + character roster — the smaller, high-signal sections — always survive.
  const world = worldEntitiesSummary.length > contentMax
    ? `${worldEntitiesSummary.slice(0, contentMax)}\n\n[world summary truncated for judging]`
    : worldEntitiesSummary;
  return {
    series: {
      name: series?.name || 'Untitled series',
      logline: series?.logline || '',
      premise: series?.premise || '',
      styleNotes: composeStyleNotes(series, { proseCraft: true }),
    },
    worldEntitiesSummary: world,
    characterRoster,
    characterCount: characters.length,
    arc: arcText,
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
 * @param {boolean} [opts.force]      re-judge unchanged inputs
 */
export async function judgeFoundation(seriesId, { providerId, model, force = false } = {}) {
  assertValidSeriesId(seriesId);
  const series = await getSeries(seriesId);
  const universe = series?.universeId ? await getUniverse(series.universeId).catch(() => null) : null;
  const hash = foundationInputsHash(series, universe);

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

  const ctx = buildFoundationContext({ series, universe, canon, contentMax });
  const result = await runFoundationJudgeStage(ctx, {
    returnsJson: true,
    providerOverride: judgeProvider.id,
    modelOverride: judgeModel,
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
  console.log(`🏛️ foundation judge — series=${seriesId.slice(0, 12)} weighted=${judge.weightedScore} weakest=${weak?.dimension || '—'}(${weak?.score ?? '—'}) via ${judgeProvider.id}/${judgeModel || '(default)'}`);
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
  const universe = series?.universeId ? await getUniverse(series.universeId).catch(() => null) : null;
  const hash = series ? foundationInputsHash(series, universe) : null;
  return { ...snap, stale: hash ? isFoundationStale(snap, hash) : false };
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

// Refine the universe world bible (worldbuilding + craft dimensions) through the
// owning service: regenerate logline/premise/styleNotes/influences via
// expandWorldTemplate — which ECHOES locked entries unchanged (force:false /
// no-clobber) — then persist through updateUniverse (serialized write queue).
// Mirrors storyBuilder.js's `universeAesthetic` step. Returns false when there's
// no universe to refine.
async function refineWorld(universeId, { providerId, model }) {
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
    providerId,
    model,
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
    if (locked.logline !== true) patch.logline = expanded.logline;
    if (locked.premise !== true) patch.premise = expanded.premise;
    if (locked.styleNotes !== true) patch.styleNotes = expanded.styleNotes;
    if (expanded.influences && locked.influences !== true) patch.influences = expanded.influences;
    if (!Object.keys(patch).length) return null; // every field locked → no-op
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
 *   craft         → universe world refine (styleNotes carries voice/craft)
 *   character     → expandUniverseCharacter on the thinnest unlocked character
 *   structure     → arc resolve (resolveVerifyIssues) with the judge's finding
 *
 * `finding` is the judge's `{ gap, fix }` for the targeted dimension, threaded
 * into the structure resolve as a synthesized arc finding.
 */
export async function applyFoundationFix(seriesId, dimension, { finding = {}, providerOverride, modelOverride } = {}) {
  assertValidSeriesId(seriesId);
  const series = await getSeries(seriesId);
  const universeId = series?.universeId || null;
  const provider = { providerId: providerOverride, model: modelOverride };

  if (dimension === 'worldbuilding' || dimension === 'craft') {
    const r = await refineWorld(universeId, provider);
    return { dimension, ...r };
  }

  if (dimension === 'character') {
    if (!universeId) return { dimension, applied: false, reason: 'no linked universe' };
    const universe = await getUniverse(universeId).catch(() => null);
    const targetId = thinnestCharacter(universe?.characters);
    if (!targetId) return { dimension, applied: false, reason: 'no unlocked character with blank framework fields' };
    const result = await expandUniverseCharacter(universeId, targetId, provider);
    return { dimension, applied: (result?.updatedFields?.length || 0) > 0, entryId: targetId, updatedFields: result?.updatedFields || [] };
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
  renderCharacterLine,
  FRAMEWORK_STRING_FIELDS,
};
