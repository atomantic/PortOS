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
import { createKeyedFileWriteQueue } from '../../lib/fileWriteQueue.js';
import { createSseRunner } from '../../lib/sseUtils.js';
import { runStagedLLM, resolveStageContext } from '../../lib/stageRunner.js';
import { manuscriptContentBudgetChars, estimateTokens } from '../../lib/contextBudget.js';
import { seriesStore, getSeries } from './series.js';
import { getSeriesCanon } from './seriesCanon.js';
import { collectManuscriptSections, sectionsCorpus } from './arcPlanner.js';
import { emitRecordUpdated } from '../sharing/recordEvents.js';

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
// Series issue ids are `iss-<uuid>`; the content hash is a 64-char hex digest.
// Used only by the peer-sync sanitizer, which trusts the sender's resolved
// refs rather than recomputing them against a manuscript the receiver may lack.
const ISSUE_ID_MAX = 64;
const HASH_MAX = 128;
const PROVIDER_MAX = 120;

// Output space reserved when budgeting the manuscript chunk against the model's
// context window (see manuscriptContentBudgetChars in generateReverseOutline) —
// the corpus scales to fill the window above a manuscript floor, so a big-context
// model segments the whole manuscript while a small one trims to fit.
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

const queueOutlineWrite = createKeyedFileWriteQueue();

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
 *   - providerId / model — explicit HARD provider/model (manual route override)
 *   - providerIdDefault — Series Autopilot's run provider as a SOFT default
 *     (#1349/#1514): loses to a per-stage pin and soft-falls-through to active
 *     when unavailable, unlike the hard providerId
 *   - modelIdDefault — Series Autopilot's run model as a SOFT default (#1558):
 *     overrides the stage's tier value but loses to a deliberate explicit-model
 *     pin (and to the hard model). See stageRunner.resolveModelHint.
 *   - force — re-segment even when the manuscript hash is unchanged
 *   - signal — AbortSignal checked before the persist
 */
export async function generateReverseOutline(seriesId, { providerId, providerIdDefault, model, modelIdDefault, force = false, signal } = {}) {
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

  // Scale the content cap to the model's context window, reserving a manuscript
  // floor so a small/local provider window trims the corpus to fit rather than
  // overflowing on a fixed 60K floor (#1488); a big window scales up.
  const { contextWindow } = await resolveStageContext(STAGE, { providerOverride: providerId, providerDefault: providerIdDefault, modelOverride: model, modelDefault: modelIdDefault });
  const overheadTokens = 1_500 + estimateTokens([series?.name || '', series?.styleNotes || '', characterNames.join(', ')].join(' '));
  const contentMax = manuscriptContentBudgetChars({
    contextWindow,
    overheadTokens,
    outputReserveTokens: OUTLINE_OUTPUT_RESERVE_TOKENS,
  });
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
    providerDefault: providerIdDefault,
    modelOverride: model,
    modelDefault: modelIdDefault,
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
  // The outline is a sibling of the series record, so regenerating it doesn't
  // move the series `index.json` — emit a series `updated` event so the
  // peer-sync push + bucket re-export fire (both hash the outline into their
  // payload, defeating the lastPushedHash short-circuit). Skipped on the sync
  // RECEIVE path (`mergeOutlineFromSync`) to avoid an echo loop. Mirrors
  // manuscriptReview.seedReviewFromFindings.
  emitRecordUpdated('series', seriesId);
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
 * Read the stored reverse outline with a `stale` flag. Returns a shell (never
 * null) when one has never been generated, so the route/UI has a consistent
 * shape to render — and distinguishes `none` (no outline yet, but there IS
 * draftable manuscript) from `no-content` (nothing drafted yet). Without that
 * split the UI prompts the user to "Generate" again after a no-content run
 * instead of telling them to draft/import first (the generate run reports
 * `no-content`, so the GET must agree once the page refetches).
 */
export async function getReverseOutline(seriesId) {
  assertValidSeriesId(seriesId);
  const outline = await readOutline(seriesId);
  const { corpus } = await buildManuscriptCorpus(seriesId);
  if (!outline) {
    return { ...emptyOutline(), seriesId, status: corpus.trim() ? 'none' : 'no-content' };
  }
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
// Cross-install peer sync (#1348) — the outline rides the series push/export as
// a sibling doc (same as manuscript-review), so a regenerate-only change still
// propagates even though it doesn't move the series record. Unlike the review's
// per-comment LWW, the outline is a single regenerated document, so the merge
// is whole-doc LWW on `generatedAt`.
// ---------------------------------------------------------------------------

/**
 * Lightweight accessor for the push/export bundle: the raw stored outline doc
 * (or null when none exists), WITHOUT the staleness recompute getReverseOutline
 * does (that re-reads the whole manuscript). Only a `complete` outline is worth
 * propagating — callers gate on `status === 'complete'`.
 */
export async function getStoredOutline(seriesId) {
  assertValidSeriesId(seriesId);
  return readOutline(seriesId);
}

// Sanitize one scene arriving over peer sync. Unlike sanitizeScene (which
// rebuilds issueId/issueTitle from the LOCAL manuscript via byNumber), this
// trusts + clamps the issue refs the sender already resolved — the receiving
// peer may not hold the drafted manuscript, and the issues sync separately.
function sanitizeSyncedScene(raw, idx, plotlineIds) {
  if (!raw || typeof raw !== 'object') return null;
  const summary = clampStr(raw.summary, SUMMARY_MAX);
  const heading = clampStr(raw.heading, LABEL_MAX);
  if (!summary && !heading) return null;
  const primary = clampStr(raw.plotlineId, PLOTLINE_ID_MAX);
  const secondary = clampStr(raw.secondaryPlotlineId, PLOTLINE_ID_MAX);
  return {
    id: `scene-${String(idx + 1).padStart(3, '0')}`,
    sequence: idx,
    issueNumber: Number.isInteger(raw.issueNumber) ? raw.issueNumber : null,
    issueId: clampStr(raw.issueId, ISSUE_ID_MAX) || null,
    issueTitle: clampStr(raw.issueTitle, LABEL_MAX),
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
 * Shape a full stored outline document arriving over peer sync into the local
 * stored shape. Returns null for anything that isn't a complete, timestamped
 * outline — only complete outlines propagate, and `generatedAt` is the LWW
 * clock. Defense-in-depth on top of the peer-sync Zod schema: never trust a
 * peer's payload past the wire shape. Exported via __testing.
 */
function sanitizeSyncedOutline(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.status !== 'complete') return null;
  const generatedAt = typeof raw.generatedAt === 'string' ? raw.generatedAt : null;
  if (!generatedAt || Number.isNaN(new Date(generatedAt).getTime())) return null;
  const plotlines = sanitizePlotlines(raw.plotlines);
  const plotlineIds = new Set(plotlines.map((pl) => pl.id));
  const scenes = (Array.isArray(raw.scenes) ? raw.scenes : [])
    .slice(0, MAX_SCENES)
    .map((s, idx) => sanitizeSyncedScene(s, idx, plotlineIds))
    .filter(Boolean);
  // Re-append the synthetic catch-all only if a scene landed on it and the
  // sender didn't already include the row (mirrors sanitizeOutline).
  if (scenes.some((s) => s.plotlineId === UNASSIGNED_PLOTLINE.id) && !plotlineIds.has(UNASSIGNED_PLOTLINE.id)) {
    plotlines.push({ ...UNASSIGNED_PLOTLINE });
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    status: 'complete',
    sourceContentHash: clampStr(raw.sourceContentHash, HASH_MAX) || null,
    truncated: raw.truncated === true,
    providerId: clampStr(raw.providerId, PROVIDER_MAX) || null,
    model: clampStr(raw.model, PROVIDER_MAX) || null,
    runId: clampStr(raw.runId, PROVIDER_MAX) || null,
    generatedAt,
    plotlines,
    scenes,
  };
}

/**
 * Merge a reverse outline received from a peer, whole-doc LWW on `generatedAt`
 * (strict-newer wins, so an equal-clock echo is a skip — matching
 * mergeReviewFromSync's `>` guard). Returns the doc now on disk (local kept on a
 * stale/equal push, remote adopted on a newer one) or null when the payload
 * isn't a propagatable outline. Does NOT emit a record event (the local write
 * paths do) so a received outline can't echo back into a push loop. Serializes
 * on the same per-series tail as local writes.
 */
export async function mergeOutlineFromSync(seriesId, remoteOutline) {
  assertValidSeriesId(seriesId);
  const remote = sanitizeSyncedOutline(remoteOutline);
  if (!remote) return null;
  return queueOutlineWrite(seriesId, async () => {
    const local = await readOutline(seriesId);
    const localRaw = local && typeof local.generatedAt === 'string'
      ? new Date(local.generatedAt).getTime()
      : NaN;
    // A corrupt/missing local clock sorts oldest so a valid remote always wins.
    const localTime = Number.isNaN(localRaw) ? -Infinity : localRaw;
    const remoteTime = new Date(remote.generatedAt).getTime();
    if (!(remoteTime > localTime)) return local;
    const next = { ...remote, seriesId };
    await writeOutline(seriesId, next);
    return next;
  });
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
export const __testing = { sanitizeOutline, sanitizePlotlines, sanitizeScene, sanitizeSyncedOutline, sanitizeSyncedScene, isOutlineStale, contentHash, runs: runner.runs };
