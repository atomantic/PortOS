/**
 * Pipeline — Perspective Rewrite + Analysis (#1290).
 *
 * Rewrites one issue's drafted passage (prose, falling back to comic script /
 * teleplay) from a *different cast character's* point of view, then runs an
 * analysis pass comparing the original and the rewrite — what new interiority
 * surfaces, what the original POV was hiding, whether the new POV has a stronger
 * claim to the scene, and concrete edits to fold back. A revision exercise that
 * exposes what each POV character knows, wants, and withholds.
 *
 * NON-DESTRUCTIVE: rewrites are stored as alternate artifacts at
 * `data/pipeline-pov-rewrites/{issueId}.json` (sibling-file pattern, mirroring
 * editorialAnalysis.js). The canonical `stages.prose` draft is never touched —
 * the user folds insights back by hand. Each rewrite pins a `sourceContentHash`
 * so the UI can flag it stale once the analyzed draft changes. Per-issue writes
 * serialize on a single tail (one tail per shared file, per CLAUDE.md).
 *
 * Errors bubble (no try/catch) — the route owns the request boundary.
 */

import { join } from 'path';
import { createHash, randomUUID } from 'crypto';
import { PATHS, atomicWrite, ensureDir, tryReadFile, safeJSONParse } from '../../lib/fileUtils.js';
import { createFileWriteQueue } from '../../lib/fileWriteQueue.js';
import { runStagedLLM, resolveStageContext } from '../../lib/stageRunner.js';
import { manuscriptContentBudgetChars, estimateTokens } from '../../lib/contextBudget.js';
import { richCanonDescriptorFragments, flattenCanonDescriptorFragments } from '../../lib/canonPrompt.js';
import { filterCanonListForIssue } from '../../lib/storyBible.js';
import { getIssue } from './issues.js';
import { getSeries } from './series.js';
import { getSeriesCanon } from './seriesCanon.js';
import { pickAnalyzableContent } from './editorialAnalysis.js';

const REWRITE_STAGE = 'pipeline-pov-rewrite';
const ANALYSIS_STAGE = 'pipeline-pov-analysis';

// Storage-layout version for the rewrites document. Bump + migrate if the
// stored shape changes in a way an older reader can't tolerate.
const SCHEMA_VERSION = 1;

// Keep a bounded history of alternate-POV artifacts per issue — newest first.
// This is an exploratory revision tool, not an archive; old experiments age out.
const MAX_REWRITES = 12;

// Defensive caps on LLM analysis output — never trust raw model JSON.
const MAX_LIST_ITEMS = 12;
const ITEM_MAX = 600;
const RATIONALE_MAX = 600;
const ONE_LINE_MAX = 400;
const REWRITE_MAX_CHARS = 200_000;

// Output space reserved when budgeting the source passage against the model's
// context window (see resolveStageContentMax) — the passage scales to fill the
// window above a manuscript floor, so a big-context model rewrites the whole
// passage while a small one trims to fit rather than overflowing a 48K floor.
const REWRITE_OUTPUT_RESERVE_TOKENS = 6_000;
const ANALYSIS_OUTPUT_RESERVE_TOKENS = 3_000;

const nowIso = () => new Date().toISOString();
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const clampNum = (v, min, max, fallback = 0) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
};

// Snapshot content hash — pins the analyzed draft so a later edit flips a
// rewrite to `stale`. One-liner matching editorialAnalysis.contentHash.
const contentHash = (text) => createHash('sha256').update(text || '').digest('hex');

// Defense-in-depth: refuse path-traversal-shaped ids before interpolating into
// the on-disk path. Issue ids are `iss-<uuid>` — restrict to a safe charset.
function assertValidIssueId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid issue id: ${id}`);
  }
}

const rewritesDir = () => join(PATHS.data, 'pipeline-pov-rewrites');
const docPath = (issueId) => join(rewritesDir(), `${issueId}.json`);

// ---------- per-issue write tail (single tail per shared file) ----------

const writeQueues = new Map();
function queueWrite(issueId, fn) {
  const key = typeof issueId === 'string' && issueId ? issueId : '__unknown__';
  let q = writeQueues.get(key);
  if (!q) { q = createFileWriteQueue(); writeQueues.set(key, q); }
  return q(fn);
}

// ---------- cast ----------

// Build the POV-character roster from the series' linked-universe canon. Each
// entry carries a flattened descriptor so the rewrite prompt can ground the new
// POV in everything we know about them.
function shapeCastEntry(char) {
  if (!char || typeof char !== 'object') return null;
  const name = str(char.name, 120);
  if (!name) return null;
  const descriptorParts = [
    flattenCanonDescriptorFragments(richCanonDescriptorFragments('character', char)),
    char.personality ? `Personality: ${str(char.personality, 600)}` : '',
    char.background ? `Background: ${str(char.background, 600)}` : '',
  ].filter(Boolean);
  return {
    id: str(char.id, 120) || name,
    name,
    role: str(char.role, 80),
    descriptor: descriptorParts.join('. '),
  };
}

// Resolve the cast for a rewrite prompt at `issueNumber`. This is a
// writer-facing GENERATIVE prompt (it grounds regenerated prose in the cast's
// full canon, incl. background/personality), so it must reveal-gate the canon
// exactly like `buildStageContext` (#2178) — a later-reveal character's secret
// must not leak into an earlier issue's rewrite. `keepFullPov` (the POV
// character being rewritten FROM) is exempt: the narrator knows their own
// secrets, so they keep their full record even when gated. The exemption
// matches the SAME id-OR-name identity the caller resolves the POV with
// (`c.id === keepFullPov || c.name === keepFullPov`) — otherwise a name-form
// POV request on a reveal-gated narrator would surface/drop them and either
// lose their private canon or return `unknown-character`. Absent `issueNumber`
// = no gate (backward compatible).
async function resolveCast(series, issueNumber, keepFullPov = null) {
  const canon = series ? await getSeriesCanon(series).catch(() => ({ characters: [] })) : { characters: [] };
  const chars = Array.isArray(canon.characters) ? canon.characters : [];
  const isPov = (c) => keepFullPov != null && ((c?.id && c.id === keepFullPov) || (c?.name && c.name === keepFullPov));
  const gated = Number.isFinite(issueNumber)
    ? chars.map((c) => (isPov(c) ? c : filterCanonListForIssue([c], 'character', issueNumber)[0]))
      .filter(Boolean)
    : chars;
  return gated.map(shapeCastEntry).filter(Boolean);
}

// ---------- sanitize LLM analysis ----------

function sanitizeStringList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => str(v, ITEM_MAX)).filter(Boolean).slice(0, MAX_LIST_ITEMS);
}

function sanitizeFoldBack(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((f) => {
      if (!f || typeof f !== 'object') return null;
      const suggestion = str(f.suggestion, ITEM_MAX);
      if (!suggestion) return null;
      return { suggestion, rationale: str(f.rationale, RATIONALE_MAX) };
    })
    .filter(Boolean)
    .slice(0, MAX_LIST_ITEMS);
}

export function sanitizeAnalysis(parsed) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  const arc = p.arcStrength && typeof p.arcStrength === 'object' ? p.arcStrength : {};
  return {
    newInformation: sanitizeStringList(p.newInformation),
    hiddenInformation: sanitizeStringList(p.hiddenInformation),
    arcStrength: {
      score: clampNum(arc.score, 0, 100),
      strongerThanOriginal: arc.strongerThanOriginal === true,
      rationale: str(arc.rationale, RATIONALE_MAX),
    },
    foldBackSuggestions: sanitizeFoldBack(p.foldBackSuggestions),
    povJustification: str(p.povJustification, RATIONALE_MAX),
    oneLine: str(p.oneLine, ONE_LINE_MAX),
  };
}

// ---------- storage ----------

async function loadDoc(issueId) {
  const content = await tryReadFile(docPath(issueId));
  if (content === null) return null;
  return safeJSONParse(content, null, { allowArray: false, logError: true, context: docPath(issueId) });
}

async function saveDoc(doc) {
  await ensureDir(rewritesDir());
  await atomicWrite(docPath(doc.issueId), doc);
}

// ---------- content selection ----------

// Pick the passage to rewrite. An explicit `sourceStage` is honored when it has
// content; otherwise fall back to the reader-facing preference (prose → comic
// script → teleplay) shared with editorialAnalysis. Returns null when the issue
// has no drafted content yet.
function pickSource(issue, sourceStage) {
  if (sourceStage) {
    const text = (issue?.stages?.[sourceStage]?.output || '').trim();
    if (text) return { text, sourceStage };
    return null;
  }
  return pickAnalyzableContent(issue);
}

const formatLabel = (stage) =>
  stage === 'comicScript' ? 'comic script' : stage === 'teleplay' ? 'teleplay' : 'prose';

// Resolve a stage's usable content budget in chars, scaled to the (possibly
// per-stage-pinned) model's context window, reserving a manuscript floor so a
// small/local provider window trims the passage to fit rather than overflowing on
// a fixed 48K floor (#1488); a big-context model scales up. The rewrite and
// analysis stages can be pinned to different providers/models, so each must be
// budgeted against its OWN window — and `overheadText` must cover every non-content
// token the stage's prompt renders (e.g. the full cast roster the rewrite prompt
// prints), or a large cast silently overfills the window.
async function resolveStageContentMax(stage, { providerId, model, overheadText, outputReserveTokens }) {
  const { contextWindow } = await resolveStageContext(stage, { providerOverride: providerId, modelOverride: model });
  return manuscriptContentBudgetChars({
    contextWindow,
    overheadTokens: 1_500 + estimateTokens(overheadText),
    outputReserveTokens,
  });
}

// ---------- generation ----------

/**
 * Generate an alternate-POV rewrite of one issue's drafted passage, plus a
 * structured "what we learn" analysis. Appends the artifact to the issue's
 * rewrites doc (newest first, capped) WITHOUT touching the canonical draft.
 *
 * @param {string} issueId
 * @param {object} options
 *   - povCharacterId  — required; the cast character to rewrite from
 *   - sourceStage     — optional; which stage to rewrite (defaults to prose→script)
 *   - providerId/model — forwarded to both LLM stages (manual override)
 * @returns {Promise<{ status, rewrite?, ... }>}
 */
export async function generatePerspectiveRewrite(issueId, { povCharacterId, sourceStage, providerId, model } = {}) {
  assertValidIssueId(issueId);
  const issue = await getIssue(issueId);
  const picked = pickSource(issue, sourceStage);
  if (!picked) return { status: 'no-content', issueId, seriesId: issue.seriesId };

  const series = await getSeries(issue.seriesId).catch(() => null);
  // Reveal-gate the cast to this issue's horizon (#2178) — but keep the POV
  // character (the narrator) full, since they know their own secrets.
  const cast = await resolveCast(series, issue.number, povCharacterId);
  const pov = cast.find((c) => c.id === povCharacterId || c.name === povCharacterId);
  if (!pov) return { status: 'unknown-character', issueId, seriesId: issue.seriesId, povCharacterId };

  const seriesVars = {
    name: series?.name || 'Untitled series',
    logline: series?.logline || '',
    styleNotes: series?.styleNotes || '',
    characters: cast,
  };
  const issueVars = { number: issue.number, title: issue.title };
  const povVars = { name: pov.name, role: pov.role, descriptor: pov.descriptor };

  // Scale the content cap to the rewrite model's context window — the rewrite
  // prompt renders the FULL cast roster, so it's counted in the overhead too
  // (a large/verbose cast otherwise silently overfills the window).
  const rosterText = cast.map((c) => `${c.name} ${c.role} ${c.descriptor}`).join(' ');
  const contentMax = await resolveStageContentMax(REWRITE_STAGE, {
    providerId,
    model,
    overheadText: [seriesVars.name, seriesVars.styleNotes, pov.descriptor, rosterText].join(' '),
    outputReserveTokens: REWRITE_OUTPUT_RESERVE_TOKENS,
  });
  const truncated = picked.text.length > contentMax;
  const originalContent = truncated
    ? `${picked.text.slice(0, contentMax)}\n\n[passage truncated for rewrite — ${picked.text.length} chars total]`
    : picked.text;

  // 1. Rewrite the passage in the new POV (freeform prose).
  const rewriteResult = await runStagedLLM(REWRITE_STAGE, {
    series: seriesVars,
    issue: issueVars,
    povCharacter: povVars,
    sourceFormat: formatLabel(picked.sourceStage),
    originalContent,
  }, {
    returnsJson: false,
    providerOverride: providerId,
    modelOverride: model,
    source: 'pipeline-pov-rewrite',
  });
  const rewriteText = str(rewriteResult.content, REWRITE_MAX_CHARS);
  if (!rewriteText) return { status: 'empty-rewrite', issueId, seriesId: issue.seriesId };

  // 2. Analyze original vs rewrite (structured JSON). Budget against the
  // ANALYSIS stage's own window (it may be pinned to a different provider/model
  // than the rewrite stage), then split it across the two passages it must hold.
  const analysisMax = await resolveStageContentMax(ANALYSIS_STAGE, {
    providerId,
    model,
    overheadText: [seriesVars.name, pov.name, pov.role].join(' '),
    outputReserveTokens: ANALYSIS_OUTPUT_RESERVE_TOKENS,
  });
  const halfMax = Math.floor(analysisMax / 2);
  const clipForAnalysis = (text, label) =>
    text.length > halfMax ? `${text.slice(0, halfMax)}\n\n[${label} truncated for analysis]` : text;
  const analysisResult = await runStagedLLM(ANALYSIS_STAGE, {
    series: { name: seriesVars.name },
    issue: issueVars,
    povCharacter: povVars,
    originalContent: clipForAnalysis(picked.text, 'original'),
    rewriteContent: clipForAnalysis(rewriteText, 'rewrite'),
  }, {
    returnsJson: true,
    providerOverride: providerId,
    modelOverride: model,
    source: 'pipeline-pov-analysis',
  });

  const rewrite = {
    id: `pov-${randomUUID()}`,
    sourceStage: picked.sourceStage,
    sourceContentHash: contentHash(picked.text),
    povCharacterId: pov.id,
    povCharacterName: pov.name,
    povCharacterRole: pov.role,
    rewrite: rewriteText,
    analysis: sanitizeAnalysis(analysisResult.content),
    providerId: rewriteResult.providerId,
    model: rewriteResult.model,
    runId: rewriteResult.runId,
    analysisRunId: analysisResult.runId,
    truncated,
    createdAt: nowIso(),
  };

  await queueWrite(issueId, async () => {
    const existing = await loadDoc(issueId);
    const prior = Array.isArray(existing?.rewrites) ? existing.rewrites : [];
    const doc = {
      issueId,
      seriesId: issue.seriesId,
      schemaVersion: SCHEMA_VERSION,
      rewrites: [rewrite, ...prior].slice(0, MAX_REWRITES),
      updatedAt: nowIso(),
    };
    await saveDoc(doc);
  });

  console.log(`🎭 pov rewrite: issue=${issueId.slice(0, 12)} pov=${pov.name} src=${picked.sourceStage} chars=${rewriteText.length}${truncated ? ' (truncated)' : ''}`);
  return { status: 'complete', issueId, seriesId: issue.seriesId, rewrite };
}

// ---------- read ----------

// A stored rewrite is stale when the current source-stage content no longer
// matches the hash it was generated against (the draft was edited since), or the
// source content was removed entirely. A legacy entry with no hash → not-stale.
function rewriteStale(rewrite, issue) {
  if (!rewrite?.sourceContentHash) return false;
  const text = (issue?.stages?.[rewrite.sourceStage]?.output || '').trim();
  if (!text) return true;
  return rewrite.sourceContentHash !== contentHash(text);
}

/**
 * Read all stored alternate-POV rewrites for an issue, the available cast (for
 * the picker), and a per-rewrite `stale` flag. Returns a consistent shell when
 * nothing has been generated yet so the route/UI always has the same shape.
 */
export async function getPerspectiveRewrites(issueId) {
  assertValidIssueId(issueId);
  const issue = await getIssue(issueId);
  const series = await getSeries(issue.seriesId).catch(() => null);
  const cast = await resolveCast(series);
  // The picker only needs id/name/role — drop the heavy descriptor from the wire.
  const castForWire = cast.map(({ id, name, role }) => ({ id, name, role }));
  const doc = await loadDoc(issueId);
  const rewrites = (Array.isArray(doc?.rewrites) ? doc.rewrites : []).map((r) => ({
    ...r,
    stale: rewriteStale(r, issue),
  }));
  const hasContent = !!pickAnalyzableContent(issue);
  return { issueId, seriesId: issue.seriesId, cast: castForWire, hasContent, rewrites };
}

/**
 * Remove one stored rewrite artifact. Returns `{ removed }`. No-op (removed:
 * false) when the issue has no doc or the id isn't present.
 */
export async function deletePerspectiveRewrite(issueId, rewriteId) {
  assertValidIssueId(issueId);
  return queueWrite(issueId, async () => {
    const existing = await loadDoc(issueId);
    const prior = Array.isArray(existing?.rewrites) ? existing.rewrites : [];
    const next = prior.filter((r) => r.id !== rewriteId);
    if (next.length === prior.length) return { removed: false };
    await saveDoc({ ...existing, rewrites: next, updatedAt: nowIso() });
    return { removed: true };
  });
}

export const __testing = { sanitizeAnalysis, shapeCastEntry, rewriteStale, contentHash, pickSource };
