/**
 * Pipeline — Calibrated LLM issue quality judge (CWQE Phase 3, #2167).
 *
 * A harsh, calibrated judge scores one drafted issue across 9 dimensions against
 * the SAME contract the writer received (series bible + style guide + beat sheet +
 * full canon), using an anti-inflation calibration ladder and a quote-level
 * evidence requirement. The judge runs on the writer/judge split resolved by
 * `resolveJudgeForStage()` — the model that evaluates is deliberately different
 * from the one that wrote, "to avoid self-congratulation" (autonovel).
 *
 * The composite the downstream keep/revert loops (Phases 5, 7) spend as currency:
 *
 *     qualityScore = judgeOverall − computeSlopPenalty(text)   (clamped 0..10)
 *
 * The deterministic slop penalty (#2165) catches what the LLM judge normalizes
 * away — the dual immune system. Snapshots persist at
 * `data/pipeline-judge/{issueId}.json` and pin a `sourceContentHash` so a later
 * edit flips the score to `stale` (mirrors editorialAnalysis.js). The judge run
 * itself lands in `data/runs/<runId>/` (run history) via runStagedLLM.
 *
 * AI-provider policy: the judge fires ONLY from an explicit user action (the
 * route) or the already-consented Series Autopilot — never at boot.
 *
 * Errors bubble (no try/catch) except the single, deliberate malformed-JSON
 * retry in `runJudgeStage` — LLM judges intermittently emit prose-wrapped or
 * truncated JSON, and one stricter retry salvages most of them before the parse
 * error surfaces.
 */

import { join } from 'path';
import { createHash } from 'crypto';
import { PATHS, atomicWrite, ensureDir, tryReadFile, safeJSONParse } from '../../lib/fileUtils.js';
import { runStagedLLM, resolveStageContext, resolveJudgeForStage } from '../../lib/stageRunner.js';
import { manuscriptContentBudgetChars, estimateTokens } from '../../lib/contextBudget.js';
import { computeSlopPenalty } from '../../lib/editorial/slopScore.js';
import { getStage } from '../promptService.js';
import { composeStyleNotes } from '../../lib/styleGuide.js';
import { renderEntitiesSummary } from '../../lib/universePromptRenderers.js';
import { getUniverse } from '../universeBuilder.js';
import { scopeCharactersForIssue, stageContentOf } from './textStages.js';
import { pickAnalyzableContent } from './editorialAnalysis.js';
import { getIssue, listIssues } from './issues.js';
import { getSeries } from './series.js';
import { getSeriesCanon } from './seriesCanon.js';

const STAGE = 'pipeline-judge-issue';

// The 9 rubric dimensions — the single source of truth for sanitize + shape
// validation + client rendering. Order is the display order.
export const JUDGE_DIMENSIONS = Object.freeze([
  'voiceAdherence',
  'beatCoverage',
  'characterVoice',
  'plantsSeeded',
  'proseQuality',
  'continuity',
  'canonCompliance',
  'loreIntegration',
  'engagement',
]);

// Writer-stage template for each drafted source stage — the config object whose
// judgeProvider/judgeModel pin drives the writer/judge split. Mirrors
// textStages.js STAGE_TO_TEMPLATE (kept local: a tiny, stable map, and importing
// its __testing bag into production code would be worse than a 3-entry mirror).
const WRITER_STAGE_TEMPLATE = Object.freeze({
  prose: 'pipeline-prose',
  comicScript: 'pipeline-comic-script',
  teleplay: 'pipeline-teleplay',
});

// Defensive caps on LLM output — never trust raw model JSON.
const SENTENCE_MAX = 240;
const MOMENT_MAX = 400;
const FIX_MAX = 300;
const REVISION_MAX = 300;
const VERDICT_MAX = 400;
const MAX_SENTENCES = 3;
const MAX_REVISIONS = 3;
const JUDGE_OUTPUT_RESERVE_TOKENS = 2_500;

const nowIso = () => new Date().toISOString();

// Snapshot content hash — pins the judged draft so a later edit flips `stale`.
// One-liner (matches editorialAnalysis.js) — not worth a shared lib module.
const contentHash = (text) => createHash('sha256').update(text || '').digest('hex');

// Defense-in-depth: refuse path-traversal-shaped ids before interpolating into
// the on-disk snapshot path (issue ids are `iss-<uuid>`).
function assertValidIssueId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid issue id: ${id}`);
  }
}

const judgeDir = () => join(PATHS.data, 'pipeline-judge');
const snapshotPath = (issueId) => join(judgeDir(), `${issueId}.json`);

// ---------- content selection ----------

// Reader-facing content to judge. An explicit `stageId` forces a particular
// writer stage; otherwise prefer prose, then either script form (via
// pickAnalyzableContent). Returns null when the issue has no drafted content.
export function pickJudgeContent(issue, stageId) {
  if (stageId) {
    const text = stageContentOf(issue?.stages?.[stageId]);
    return text ? { text, sourceStage: stageId } : null;
  }
  return pickAnalyzableContent(issue);
}

// ---------- composite math ----------

const clampScore = (v, fallback = 0) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(10, Math.round(n * 100) / 100));
};

/**
 * The composite quality score: judge overall minus the deterministic slop
 * penalty, clamped to [0, 10]. A non-finite input collapses to 0 for that term
 * (never NaN-poisons the score). Exported for unit tests + the keep/revert loops.
 */
export function computeQualityScore(judgeOverall, slopPenalty) {
  const overall = Number.isFinite(Number(judgeOverall)) ? Number(judgeOverall) : 0;
  const penalty = Number.isFinite(Number(slopPenalty)) ? Number(slopPenalty) : 0;
  return Math.max(0, Math.min(10, Math.round((overall - penalty) * 100) / 100));
}

// ---------- sanitize LLM output ----------

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const strList = (v, max, cap) => (Array.isArray(v)
  ? v.map((s) => str(s, max)).filter(Boolean).slice(0, cap)
  : []);

function sanitizeDimension(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  return {
    score: clampScore(d.score),
    weakestMoment: str(d.weakestMoment, MOMENT_MAX),
    fix: str(d.fix, FIX_MAX),
  };
}

// A judge response is "valid-shaped" when it carries the dimensions object we
// scored against — the retry gate. A response that parses as JSON but omits the
// rubric is treated as malformed and retried once.
export function isValidJudgeShape(content) {
  return !!(content && typeof content === 'object'
    && content.dimensions && typeof content.dimensions === 'object');
}

export function sanitizeJudge(parsed) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  const rawDims = p.dimensions && typeof p.dimensions === 'object' ? p.dimensions : {};
  const dimensions = {};
  for (const key of JUDGE_DIMENSIONS) dimensions[key] = sanitizeDimension(rawDims[key]);
  const ratio = Number(p.sceneVsSummaryRatio);
  return {
    overall: clampScore(p.overall),
    dimensions,
    strongestSentences: strList(p.strongestSentences, SENTENCE_MAX, MAX_SENTENCES),
    weakestSentences: strList(p.weakestSentences, SENTENCE_MAX, MAX_SENTENCES),
    sceneVsSummaryRatio: Number.isFinite(ratio) ? Math.max(0, Math.min(1, Math.round(ratio * 100) / 100)) : null,
    topRevisions: strList(p.topRevisions, REVISION_MAX, MAX_REVISIONS),
    oneLineVerdict: str(p.oneLineVerdict, VERDICT_MAX),
  };
}

// ---------- storage ----------

async function loadSnapshot(issueId) {
  const content = await tryReadFile(snapshotPath(issueId));
  if (content === null) return null;
  return safeJSONParse(content, null, { allowArray: false, logError: true, context: snapshotPath(issueId) });
}

async function saveSnapshot(snapshot) {
  await ensureDir(judgeDir());
  await atomicWrite(snapshotPath(snapshot.issueId), snapshot);
}

// Single source of truth for staleness (mirrors editorialAnalysis.js): a complete
// snapshot is stale when the current content no longer matches the judged hash,
// OR when the draft was cleared after judging. A legacy snapshot with no hash is
// treated as not-stale (can't tell).
function isSnapshotStale(snap, issue, stageId) {
  if (!snap || snap.status !== 'complete') return false;
  const picked = pickJudgeContent(issue, stageId || snap.stageId);
  if (!picked) return true;
  if (!snap.sourceContentHash) return false;
  return snap.sourceContentHash !== contentHash(picked.text);
}

// ---------- context assembly ----------

// Build the judge's variable bag. Mirrors textStages.js buildStageContext (style
// guide + scoped characters + beat sheet + world roster) so the judge scores
// against the SAME contract the writer received — but with the FULL canon (NO
// reveal-gating), so the judge can catch canon/continuity/premature-reveal issues
// the writer's horizon-filtered view would hide (#2178 flagged the judge as a
// full-canon consumer). Content is budgeted to the judge model's window.
function buildJudgeContext({ series, canon, world, issue, picked, contentMax }) {
  const beatSheet = stageContentOf(issue.stages?.idea);
  const scopeText = [issue.title, beatSheet, picked.text].filter(Boolean).join('\n\n');
  const scopedCharacters = scopeCharactersForIssue(canon?.characters || [], scopeText);
  const scopedNames = new Set(
    scopedCharacters.map((c) => (c?.name || '').trim().toLowerCase()).filter(Boolean),
  );
  const worldEntitiesSummary = world
    ? (renderEntitiesSummary(world, { maxPerKind: { characters: Infinity }, excludeCharacterNames: scopedNames }) || '(none)')
    : '(no linked universe)';
  const content = picked.text.length > contentMax
    ? `${picked.text.slice(0, contentMax)}\n\n[content truncated for judging — ${picked.text.length} chars total]`
    : picked.text;
  return {
    series: {
      name: series?.name || 'Untitled series',
      logline: series?.logline || '',
      premise: series?.premise || '',
      styleNotes: composeStyleNotes(series, { proseCraft: true }),
      characters: scopedCharacters,
    },
    issue: { number: issue.number, title: issue.title },
    worldEntitiesSummary,
    beatSheet: beatSheet || '(no beat sheet was recorded for this issue)',
    format: picked.sourceStage === 'comicScript' ? 'comic script'
      : picked.sourceStage === 'teleplay' ? 'teleplay' : 'prose',
    content,
  };
}

// One deliberate malformed-JSON retry (see module doc). runStagedLLM parses JSON
// internally; a parse throw OR a parsed-but-shapeless response both retry once.
async function runJudgeStage(ctx, runOptions) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await runStagedLLM(STAGE, ctx, runOptions);
      if (isValidJudgeShape(result.content)) return result;
      lastError = new Error('judge response parsed but is missing the `dimensions` rubric');
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

// ---------- judge ----------

/**
 * Judge a single issue. Returns the stored snapshot, a `{ status:'no-content' }`
 * marker, or a cached snapshot when the content is unchanged and `!force`.
 *
 * @param {string} issueId
 * @param {object} [opts]
 * @param {string} [opts.stageId]     writer stage to judge (default: prose→script)
 * @param {string} [opts.providerId]  explicit judge provider override
 * @param {string} [opts.model]       explicit judge model override
 * @param {boolean} [opts.force]      re-judge unchanged content
 */
export async function judgeIssue(issueId, { stageId, providerId, model, force = false } = {}) {
  assertValidIssueId(issueId);
  const issue = await getIssue(issueId);
  const picked = pickJudgeContent(issue, stageId);
  if (!picked) return { status: 'no-content', issueId, seriesId: issue.seriesId };

  const hash = contentHash(picked.text);
  const existing = await loadSnapshot(issueId);
  if (!force && existing && existing.status === 'complete'
    && existing.sourceContentHash === hash && existing.stageId === picked.sourceStage) {
    return { ...existing, cached: true };
  }

  const series = await getSeries(issue.seriesId).catch(() => null);
  const [canon, world] = await Promise.all([
    series ? getSeriesCanon(series) : Promise.resolve({ characters: [] }),
    series?.universeId ? getUniverse(series.universeId).catch(() => null) : Promise.resolve(null),
  ]);

  // Writer/judge split: resolve the judge provider/model from the WRITER stage's
  // config (judgeProvider/judgeModel), honoring an explicit route override.
  const writerStage = getStage(WRITER_STAGE_TEMPLATE[picked.sourceStage] || null);
  const { provider: judgeProvider, model: judgeModel } = await resolveJudgeForStage(writerStage, {
    providerOverride: providerId,
    modelOverride: model,
  });

  // Budget content to the judge model's window (a small/local judge trims to fit
  // rather than overflowing; a big-context judge gets the whole issue). #1488.
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

  const ctx = buildJudgeContext({ series, canon, world, issue, picked, contentMax });
  const result = await runJudgeStage(ctx, {
    returnsJson: true,
    providerOverride: judgeProvider.id,
    modelOverride: judgeModel,
    source: 'pipeline-judge-issue',
  });

  const judge = sanitizeJudge(result.content);
  const slopPenalty = computeSlopPenalty(picked.text);
  const qualityScore = computeQualityScore(judge.overall, slopPenalty);

  const snapshot = {
    issueId,
    seriesId: issue.seriesId,
    status: 'complete',
    stageId: picked.sourceStage,
    sourceContentHash: hash,
    providerId: result.providerId,
    model: result.model,
    judgeProviderId: judgeProvider.id,
    judgeModel: judgeModel || null,
    runId: result.runId,
    createdAt: nowIso(),
    completedAt: nowIso(),
    slopPenalty,
    qualityScore,
    ...judge,
  };
  await saveSnapshot(snapshot);
  console.log(`⚖️ judge: issue=${issueId.slice(0, 12)} stage=${picked.sourceStage} overall=${judge.overall} slop=${slopPenalty} quality=${qualityScore} via ${judgeProvider.id}/${judgeModel || '(default)'}`);
  return snapshot;
}

/**
 * Load one issue's stored judge score with a `stale` flag. Returns null when
 * never judged.
 */
export async function getIssueJudge(issueId) {
  assertValidIssueId(issueId);
  const snap = await loadSnapshot(issueId);
  if (!snap) return null;
  const issue = await getIssue(issueId).catch(() => null);
  return { ...snap, stale: isSnapshotStale(snap, issue) };
}

/**
 * Aggregate every judged issue in a series for the Editorial Roadmap's quality
 * column + weakest-issue sort. Returns a `scores` list ordered WEAKEST-first
 * (lowest qualityScore) — the revision-priority order Phases 5/7 consume — plus
 * coverage stats.
 */
export async function getSeriesJudge(seriesId, { issues: issuesArg } = {}) {
  const issues = Array.isArray(issuesArg) ? issuesArg : await listIssues({ seriesId });
  const ordered = [...issues].sort(
    (a, b) => (a.arcPosition ?? 9999) - (b.arcPosition ?? 9999) || (a.number || 0) - (b.number || 0)
  );
  // Independent file reads — fan out in parallel.
  const snaps = await Promise.all(ordered.map((issue) => loadSnapshot(issue.id)));

  let judged = 0;
  let stale = 0;
  const scores = ordered.map((issue, idx) => {
    const snap = snaps[idx];
    const isComplete = !!(snap && snap.status === 'complete');
    const isStale = isSnapshotStale(snap, issue);
    if (isComplete) {
      judged += 1;
      if (isStale) stale += 1;
    }
    return {
      issueId: issue.id,
      number: issue.number,
      arcPosition: issue.arcPosition ?? null,
      title: issue.title,
      label: issue.arcPosition != null ? `E${issue.arcPosition}` : `#${issue.number || ''}`,
      judged: isComplete,
      stale: isStale,
      stageId: isComplete ? snap.stageId : null,
      overall: isComplete ? snap.overall : null,
      slopPenalty: isComplete ? snap.slopPenalty : null,
      qualityScore: isComplete ? snap.qualityScore : null,
      oneLineVerdict: isComplete ? snap.oneLineVerdict : '',
      judgedAt: isComplete ? (snap.completedAt || snap.createdAt || null) : null,
    };
  });

  // Weakest-first: judged issues by ascending qualityScore, then un-judged.
  const ranked = [...scores].sort((a, b) => {
    if (a.judged !== b.judged) return a.judged ? -1 : 1;
    if (!a.judged) return 0;
    return (a.qualityScore ?? 99) - (b.qualityScore ?? 99);
  });

  return {
    seriesId,
    coverage: { judged, total: ordered.length, stale },
    scores,
    weakest: ranked.filter((s) => s.judged).slice(0, 5),
    generatedAt: nowIso(),
  };
}

export const __testing = { sanitizeJudge, contentHash, isSnapshotStale, buildJudgeContext };
