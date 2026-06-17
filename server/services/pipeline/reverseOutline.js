/**
 * Pipeline — Reverse Outline (#1286).
 *
 * Generates a scene-by-scene map of the *drafted* manuscript — what is actually
 * on the page — with each scene tagged to the plotline it advances (A-plot,
 * subplots, POV threads). This is the canonical **scene-segmentation producer**:
 * other editorial checks (scene-balance, POV-justification, cliffhanger, arc
 * transitions) read the cached segmentation via `getSceneSegmentation` instead
 * of re-segmenting.
 *
 * Stored as a sibling of the series record at
 * `data/pipeline-series/{id}/reverse-outline.json` (same pattern as
 * `manuscript-review.json`) so it travels with the series folder without
 * bloating the LWW-merged series `index.json`. A `sourceContentHash` pins the
 * analyzed manuscript so the UI flags the outline as stale once the draft
 * changes. Writes serialize on a per-series tail (single tail per shared file,
 * per CLAUDE.md).
 *
 * The SSE wrapper at the bottom mirrors editorial/checkRunner.js: a single
 * in-memory runs map keyed by seriesId via lib/sseUtils.js.
 */

import { join } from 'path';
import { createHash } from 'crypto';
import { atomicWrite, readJSONFile } from '../../lib/fileUtils.js';
import { createFileWriteQueue } from '../../lib/fileWriteQueue.js';
import { createSseRunner } from '../../lib/sseUtils.js';
import { runStagedLLM, resolveStageContext } from '../../lib/stageRunner.js';
import { usableInputTokens, estimateTokens, CHARS_PER_TOKEN } from '../../lib/contextBudget.js';
import { seriesStore, getSeries } from './series.js';
import { getSeriesCanon } from './seriesCanon.js';
import { collectManuscriptSections, sectionsCorpus } from './arcPlanner.js';

const STAGE = 'pipeline-reverse-outline';

// Storage-layout version for the outline document. Bump + migrate if the scene
// shape changes in a way an older reader can't tolerate.
const SCHEMA_VERSION = 1;

const OUTLINE_FILE = 'reverse-outline.json';
const outlinePath = (seriesId) => join(seriesStore().recordDir(seriesId), OUTLINE_FILE);

// Defensive caps on LLM output — never trust raw model JSON.
const MAX_PLOTLINES = 10;
const MAX_SCENES = 600;
const MAX_CHARS_PRESENT = 24;
const LABEL_MAX = 120;
const SUMMARY_MAX = 600;
const ANCHOR_MAX = 240;
const NAME_MAX = 80;
const SETTING_MAX = 120;
const PLOTLINE_ID_MAX = 40;

// Floor on manuscript chars sent to the model — scaled UP to the target model's
// context window in generateReverseOutline (mirrors editorialAnalysis), so a
// big-context model segments the whole manuscript rather than a 60K slice.
const CONTENT_MAX = 60_000;
const OUTLINE_OUTPUT_RESERVE_TOKENS = 6_000;

const PLOTLINE_KINDS = Object.freeze(['main', 'subplot', 'pov', 'thematic', 'other']);

// Stable plotline color palette — assigned by plotline index server-side rather
// than trusting model-supplied colors, so colors stay consistent across re-runs
// and the view never renders an unreadable/duplicate hue.
const PLOTLINE_COLORS = Object.freeze([
  '#3b82f6', // accent blue (main)
  '#ef4444', // red
  '#22c55e', // green
  '#f59e0b', // amber
  '#a855f7', // purple
  '#ec4899', // pink
  '#14b8a6', // teal
  '#eab308', // yellow
  '#6366f1', // indigo
  '#f97316', // orange
]);
const UNASSIGNED_PLOTLINE = Object.freeze({ id: '_unassigned', label: 'Unassigned', kind: 'other', color: '#6b7280' });

const nowIso = () => new Date().toISOString();
const clampStr = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const colorForIndex = (i) => PLOTLINE_COLORS[i % PLOTLINE_COLORS.length];

// Content hash — pins the analyzed manuscript so a later edit flips the outline
// to `stale`. One-liner matching editorialAnalysis.contentHash.
const contentHash = (text) => createHash('sha256').update(text || '').digest('hex');

// Defense-in-depth: refuse path-traversal-shaped ids before they reach the
// on-disk outline path. Series ids are `ser-<uuid>` — restrict to a safe charset.
function assertValidSeriesId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid series id: ${id}`);
  }
}

// ---------- per-series write tail ----------

const outlineQueues = new Map();
function queueOutlineWrite(seriesId, fn) {
  const key = typeof seriesId === 'string' && seriesId ? seriesId : '__unknown__';
  let q = outlineQueues.get(key);
  if (!q) { q = createFileWriteQueue(); outlineQueues.set(key, q); }
  return q(fn);
}

// ---------- sanitize LLM output ----------

function sanitizePlotlines(rawList) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(rawList) ? rawList : []) {
    if (out.length >= MAX_PLOTLINES) break;
    if (!raw || typeof raw !== 'object') continue;
    const id = clampStr(raw.id, PLOTLINE_ID_MAX);
    const label = clampStr(raw.label, LABEL_MAX);
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      label,
      kind: PLOTLINE_KINDS.includes(raw.kind) ? raw.kind : 'other',
      color: colorForIndex(out.length),
    });
  }
  return out;
}

function sanitizeComponents(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    narrative: c.narrative === true,
    action: c.action === true,
    dialogue: c.dialogue === true,
  };
}

// Shape one scene. `byNumber` resolves issueId/title from the model-reported
// issueNumber; `plotlineIds` is the valid set (unknown ids fall back to the
// synthetic '_unassigned' plotline so the grid never references a missing row).
function sanitizeScene(raw, idx, { byNumber, plotlineIds }) {
  if (!raw || typeof raw !== 'object') return null;
  const summary = clampStr(raw.summary, SUMMARY_MAX);
  const heading = clampStr(raw.heading, LABEL_MAX);
  if (!summary && !heading) return null;
  const issueNumber = Number.isInteger(raw.issueNumber) ? raw.issueNumber : null;
  const section = issueNumber != null ? byNumber.get(issueNumber) : null;
  const primary = clampStr(raw.plotlineId, PLOTLINE_ID_MAX);
  const secondary = clampStr(raw.secondaryPlotlineId, PLOTLINE_ID_MAX);
  return {
    id: `scene-${String(idx + 1).padStart(3, '0')}`,
    sequence: idx,
    issueNumber,
    issueId: section ? section.issueId : null,
    issueTitle: section ? section.title : '',
    heading: heading || summary.slice(0, LABEL_MAX),
    summary,
    anchorQuote: clampStr(raw.anchorQuote, ANCHOR_MAX),
    povCharacter: clampStr(raw.povCharacter, NAME_MAX) || null,
    plotlineId: plotlineIds.has(primary) ? primary : UNASSIGNED_PLOTLINE.id,
    secondaryPlotlineId: secondary && plotlineIds.has(secondary) && secondary !== primary ? secondary : null,
    components: sanitizeComponents(raw.components),
    setting: clampStr(raw.setting, SETTING_MAX),
    charactersPresent: Array.isArray(raw.charactersPresent)
      ? raw.charactersPresent.map((n) => clampStr(n, NAME_MAX)).filter(Boolean).slice(0, MAX_CHARS_PRESENT)
      : [],
  };
}

/**
 * Shape a raw model response into a stored outline body. Exported via __testing.
 * `byNumber` maps issueNumber → manuscript section (for issueId backfill).
 */
function sanitizeOutline(parsed, { byNumber = new Map() } = {}) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  const plotlines = sanitizePlotlines(p.plotlines);
  const plotlineIds = new Set(plotlines.map((pl) => pl.id));
  const scenes = (Array.isArray(p.scenes) ? p.scenes : [])
    .slice(0, MAX_SCENES)
    .map((raw, idx) => sanitizeScene(raw, idx, { byNumber, plotlineIds }))
    .filter(Boolean);
  // Append the synthetic catch-all only when a scene actually landed on it, so a
  // clean run doesn't show an empty "Unassigned" row.
  if (scenes.some((s) => s.plotlineId === UNASSIGNED_PLOTLINE.id)) {
    plotlines.push({ ...UNASSIGNED_PLOTLINE });
  }
  return { plotlines, scenes };
}

// ---------- storage ----------

const emptyOutline = () => ({ schemaVersion: SCHEMA_VERSION, status: 'none', plotlines: [], scenes: [] });

async function readOutline(seriesId) {
  // `null` = file absent (distinct from a present-but-empty outline).
  const raw = await readJSONFile(outlinePath(seriesId), null);
  if (raw == null || typeof raw !== 'object') return null;
  return raw;
}

async function writeOutline(seriesId, outline) {
  await atomicWrite(outlinePath(seriesId), outline);
}

// ---------- manuscript corpus ----------

// Stitch the drafted manuscript into one corpus + the number→section map used
// for issueId backfill and staleness. Returns `{ corpus, byNumber, sections }`.
async function buildManuscriptCorpus(seriesId) {
  const sections = await collectManuscriptSections(seriesId);
  const byNumber = new Map(sections.map((s) => [s.number, s]));
  return { corpus: sectionsCorpus(sections), byNumber, sections };
}

// ---------- generation ----------

/**
 * Generate (or refresh) the reverse outline for a series. Returns the stored
 * outline, a `{ status:'no-content' }` marker when nothing is drafted yet, or
 * the cached outline when the manuscript is unchanged and `!force`.
 *
 * @param {string} seriesId
 * @param {object} [options]
 *   - providerId / model — forwarded to the LLM stage (autopilot/manual override)
 *   - force — re-segment even when the manuscript hash is unchanged
 *   - signal — AbortSignal checked before the persist
 */
export async function generateReverseOutline(seriesId, { providerId, model, force = false, signal } = {}) {
  assertValidSeriesId(seriesId);
  const { corpus, byNumber } = await buildManuscriptCorpus(seriesId);
  if (!corpus.trim()) return { seriesId, status: 'no-content' };

  const hash = contentHash(corpus);
  const existing = await readOutline(seriesId);
  if (!force && existing && existing.status === 'complete' && existing.sourceContentHash === hash) {
    return { ...existing, stale: false, cached: true };
  }

  const series = await getSeries(seriesId).catch(() => null);
  const canon = series ? await getSeriesCanon(series).catch(() => ({ characters: [] })) : { characters: [] };
  const characterNames = (canon.characters || []).map((c) => c?.name).filter(Boolean).slice(0, 60);

  // Scale the content cap to the model's context window — never below CONTENT_MAX.
  const { contextWindow } = await resolveStageContext(STAGE, { providerOverride: providerId, modelOverride: model });
  const overheadTokens = 1_500 + estimateTokens([series?.name || '', series?.styleNotes || '', characterNames.join(', ')].join(' '));
  const budgetChars = usableInputTokens({
    contextWindow,
    overheadTokens,
    outputReserveTokens: OUTLINE_OUTPUT_RESERVE_TOKENS,
  }) * CHARS_PER_TOKEN;
  const contentMax = Math.max(CONTENT_MAX, budgetChars);
  const truncated = corpus.length > contentMax;

  const vars = {
    series: { name: series?.name || 'Untitled series', styleNotes: series?.styleNotes || '' },
    knownCharacters: characterNames.length ? characterNames.join(', ') : '(none on record)',
    manuscript: truncated
      ? `${corpus.slice(0, contentMax)}\n\n[manuscript truncated for analysis — ${corpus.length} chars total]`
      : corpus,
  };

  const result = await runStagedLLM(STAGE, vars, {
    returnsJson: true,
    providerOverride: providerId,
    modelOverride: model,
    source: 'pipeline-reverse-outline',
  });

  if (signal?.aborted) return { seriesId, status: 'canceled' };

  const body = sanitizeOutline(result.content, { byNumber });
  const outline = {
    seriesId,
    schemaVersion: SCHEMA_VERSION,
    status: 'complete',
    sourceContentHash: hash,
    truncated,
    providerId: result.providerId,
    model: result.model,
    runId: result.runId,
    generatedAt: nowIso(),
    ...body,
  };
  await queueOutlineWrite(seriesId, () => writeOutline(seriesId, outline));
  console.log(`🧭 reverse outline: series=${String(seriesId).slice(0, 12)} plotlines=${body.plotlines.length} scenes=${body.scenes.length}${truncated ? ' (truncated)' : ''}`);
  return { ...outline, stale: false };
}

// Single source of truth for staleness — the stored hash no longer matches the
// current manuscript (or the manuscript was cleared after generation). A legacy
// outline with no stored hash is treated as not-stale (can't tell).
function isOutlineStale(outline, corpus) {
  if (!outline || outline.status !== 'complete') return false;
  if (!corpus.trim()) return true; // outlined, but the draft was cleared since
  if (!outline.sourceContentHash) return false;
  return outline.sourceContentHash !== contentHash(corpus);
}

/**
 * Read the stored reverse outline with a `stale` flag. Returns a
 * `{ status:'none' }` shell (never null) when one has never been generated, so
 * the route/UI has a consistent shape to render.
 */
export async function getReverseOutline(seriesId) {
  assertValidSeriesId(seriesId);
  const outline = await readOutline(seriesId);
  if (!outline) return { ...emptyOutline(), seriesId };
  const { corpus } = await buildManuscriptCorpus(seriesId);
  return { ...outline, seriesId, stale: isOutlineStale(outline, corpus) };
}

/**
 * Canonical scene-segmentation accessor for downstream editorial checks
 * (scene-balance, POV-justification, cliffhanger, arc transitions). Returns the
 * stored scenes + plotlines (empty when never generated) plus a `stale` flag so
 * a consumer can decide whether to trust or regenerate. Build the segmentation
 * once here; other checks read it rather than re-segmenting.
 */
export async function getSceneSegmentation(seriesId) {
  const outline = await getReverseOutline(seriesId);
  return {
    seriesId,
    scenes: outline.scenes || [],
    plotlines: outline.plotlines || [],
    status: outline.status || 'none',
    stale: outline.stale === true,
  };
}

// ---------------------------------------------------------------------------
// SSE run-tracking — shared lifecycle via createSseRunner (server/lib/sseUtils.js),
// the same factory backing manuscriptCompletenessRunner + editorial/checkRunner.
// ---------------------------------------------------------------------------

const runner = createSseRunner({ logLabel: 'reverse outline' });

export function isReverseOutlineActive(seriesId) {
  return runner.isActive(seriesId);
}

export function attachClient(seriesId, res) {
  return runner.attachClient(seriesId, res);
}

export function cancelReverseOutline(seriesId) {
  return runner.cancel(seriesId);
}

/**
 * Kick off a streamed reverse-outline generation. Returns the runId
 * immediately; progress + the terminal frame land via SSE. Re-calling while a
 * run is in flight resolves to the existing runId.
 */
export function startReverseOutlineRun(seriesId, options = {}) {
  return runner.start(seriesId, async ({ runId, signal, record, broadcast }) => {
    broadcast({ type: 'start', runId });
    const result = await generateReverseOutline(seriesId, {
      providerId: options.providerId,
      model: options.model,
      force: options.force,
      signal,
    });
    if (record.cancelRequested || result.status === 'canceled') {
      broadcast({ type: 'canceled', runId, canceledAt: nowIso() });
      console.log(`🧭 reverse outline canceled — series=${String(seriesId).slice(0, 12)}`);
      return;
    }
    if (result.status === 'no-content') {
      broadcast({ type: 'complete', runId, status: 'no-content', sceneCount: 0, completedAt: nowIso() });
      return;
    }
    broadcast({
      type: 'complete',
      runId,
      status: 'complete',
      sceneCount: result.scenes?.length || 0,
      plotlineCount: result.plotlines?.length || 0,
      completedAt: nowIso(),
    });
  });
}

// Export internals for tests.
export const __testing = { sanitizeOutline, sanitizePlotlines, sanitizeScene, isOutlineStale, contentHash, runs: runner.runs };
