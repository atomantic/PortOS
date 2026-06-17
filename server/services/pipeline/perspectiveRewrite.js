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
import { usableInputTokens, estimateTokens, CHARS_PER_TOKEN } from '../../lib/contextBudget.js';
import { richCanonDescriptorFragments, flattenCanonDescriptorFragments } from '../../lib/canonPrompt.js';
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

// Floor on source chars sent to the model — scaled UP to the target model's
// context window (mirrors editorialAnalysis), so a big-context model rewrites
// the whole passage rather than a 48K slice.
const CONTENT_MAX = 48_000;
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

async function resolveCast(series) {
  const canon = series ? await getSeriesCanon(series).catch(() => ({ characters: [] })) : { characters: [] };
  return (canon.characters || []).map(shapeCastEntry).filter(Boolean);
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
  const cast = await resolveCast(series);
  const pov = cast.find((c) => c.id === povCharacterId || c.name === povCharacterId);
  if (!pov) return { status: 'unknown-character', issueId, seriesId: issue.seriesId, povCharacterId };

  // Scale the content cap to the rewrite model's context window — never below
  // CONTENT_MAX, so a big-context model re-lenses the whole passage.
  const { contextWindow } = await resolveStageContext(REWRITE_STAGE, { providerOverride: providerId, modelOverride: model });
  const overheadTokens = 1_500 + estimateTokens([series?.name || '', series?.styleNotes || '', pov.descriptor].join(' '));
  const budgetChars = usableInputTokens({
    contextWindow,
    overheadTokens,
    outputReserveTokens: REWRITE_OUTPUT_RESERVE_TOKENS,
  }) * CHARS_PER_TOKEN;
  const contentMax = Math.max(CONTENT_MAX, budgetChars);
  const truncated = picked.text.length > contentMax;
  const originalContent = truncated
    ? `${picked.text.slice(0, contentMax)}\n\n[passage truncated for rewrite — ${picked.text.length} chars total]`
    : picked.text;

  const seriesVars = {
    name: series?.name || 'Untitled series',
    logline: series?.logline || '',
    styleNotes: series?.styleNotes || '',
    characters: cast,
  };
  const issueVars = { number: issue.number, title: issue.title };
  const povVars = { name: pov.name, role: pov.role, descriptor: pov.descriptor };

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

  // 2. Analyze original vs rewrite (structured JSON). Both passages must fit the
  // analysis window — split the budget across the two.
  const halfMax = Math.floor(contentMax / 2);
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
