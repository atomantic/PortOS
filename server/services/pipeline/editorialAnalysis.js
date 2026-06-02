/**
 * Pipeline — Editorial reader-emotion / plot / character analysis.
 *
 * Runs an LLM pass over one issue's reader-facing content (prose, falling back
 * to comic script / teleplay) and stores a section-by-section emotion log plus
 * plot tension and character-arc detection. Snapshots persist at
 * `data/pipeline-editorial/{issueId}.json` and pin a `sourceContentHash` so the
 * UI can flag stale results when the underlying draft changes.
 *
 * The series-level Editorial Roadmap (`getSeriesEditorial`) aggregates every
 * issue's snapshot into the Plot / Character / Reader curves + character arcs.
 *
 * Mirrors the Writers Room evaluator (server/services/writersRoom/evaluator.js)
 * for the snapshot+staleness pattern. Errors bubble (no try/catch) — the batch
 * runner in editorialAnalysisRunner.js owns the per-issue boundary.
 */

import { join } from 'path';
import { createHash } from 'crypto';
import { PATHS, atomicWrite, ensureDir, tryReadFile, safeJSONParse } from '../../lib/fileUtils.js';
import { runStagedLLM, resolveStageContext } from '../../lib/stageRunner.js';
import { usableInputTokens, estimateTokens, CHARS_PER_TOKEN } from '../../lib/contextBudget.js';
import { getIssue, listIssues } from './issues.js';
import { getSeries } from './series.js';
import { getSeriesCanon } from './seriesCanon.js';

const STAGE = 'pipeline-editorial-analysis';
const ARC_DIRECTIONS = Object.freeze(['rising', 'falling', 'flat', 'complex']);

// Defensive caps on LLM output — never trust raw model JSON.
const MAX_SECTIONS = 200;
const MAX_CHARACTERS = 40;
const MAX_BEATS = 60;
const LABEL_MAX = 120;
const EXCERPT_MAX = 200;
const EMOTION_MAX = 40;
const NOTE_MAX = 500;
// Cap the content we send to the model. Prose/script stage output is bounded
// at STAGE_OUTPUT_MAX (~400KB) which would blow the context window (and the
// JSON instruction block with it) on a long issue, yielding a truncated /
// malformed response that extractJson rejects (it throws "Invalid JSON in AI
// response", surfacing as an analysis error rather than a silent empty
// snapshot). ~48K chars (~12K tokens) leaves ample room for the prompt + a
// heavy-tier reply. This is a FLOOR — the real cap scales up to the target
// model's context window (see analyzeIssue), so a big-context model isn't
// needlessly truncated to 48K.
const CONTENT_MAX = 48_000;
// Output reserve for the analysis JSON (sections + character arcs).
const ANALYSIS_OUTPUT_RESERVE_TOKENS = 4_000;

const nowIso = () => new Date().toISOString();

// Snapshot content hash — sourceContentHash pins the analyzed draft so a later
// edit flips the issue to `stale`. One-liner (matches writersRoom/local.js's
// contentHash) — not worth a shared lib module + barrel entry.
const contentHash = (text) => createHash('sha256').update(text || '').digest('hex');

// Defense-in-depth: refuse path-traversal-shaped ids before interpolating into
// the on-disk snapshot path. Issue ids are `iss-<uuid>` — restrict to a safe
// charset.
function assertValidIssueId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid issue id: ${id}`);
  }
}

const editorialDir = () => join(PATHS.data, 'pipeline-editorial');
const snapshotPath = (issueId) => join(editorialDir(), `${issueId}.json`);

// ---------- content selection ----------

// Reader-facing content, preferring prose, then either script form. Returns
// null when the issue has no drafted content yet (only beats / visual stages).
export function pickAnalyzableContent(issue) {
  const stages = issue?.stages || {};
  for (const sourceStage of ['prose', 'comicScript', 'teleplay']) {
    const text = (stages[sourceStage]?.output || '').trim();
    if (text) return { text, sourceStage };
  }
  return null;
}

// ---------- sanitize LLM output ----------

const clampNum = (v, min, max, fallback = 0) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
};

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function sanitizeSection(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    label: str(raw.label, LABEL_MAX) || 'Section',
    excerpt: str(raw.excerpt, EXCERPT_MAX),
    primaryEmotion: str(raw.primaryEmotion, EMOTION_MAX),
    emotions: Array.isArray(raw.emotions)
      ? raw.emotions.map((e) => str(e, EMOTION_MAX)).filter(Boolean).slice(0, 5)
      : [],
    tension: clampNum(raw.tension, 0, 100),
    valence: clampNum(raw.valence, -100, 100),
    note: str(raw.note, NOTE_MAX),
  };
}

function sanitizeCharacter(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = str(raw.name, LABEL_MAX);
  if (!name) return null;
  return {
    name,
    role: str(raw.role, EMOTION_MAX),
    isProtagonist: raw.isProtagonist === true ? true : raw.isProtagonist === false ? false : null,
    arcDirection: ARC_DIRECTIONS.includes(raw.arcDirection) ? raw.arcDirection : 'flat',
    arcSummary: str(raw.arcSummary, NOTE_MAX),
    beats: Array.isArray(raw.beats)
      ? raw.beats
          .map((b) => (b && typeof b === 'object'
            ? { sectionIndex: clampNum(b.sectionIndex, 0, MAX_SECTIONS), state: str(b.state, LABEL_MAX) }
            : null))
          .filter((b) => b && b.state)
          .slice(0, MAX_BEATS)
      : [],
  };
}

function sanitizeAnalysis(parsed) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  const rollupRaw = p.rollup && typeof p.rollup === 'object' ? p.rollup : {};
  return {
    sections: Array.isArray(p.sections)
      ? p.sections.map(sanitizeSection).filter(Boolean).slice(0, MAX_SECTIONS)
      : [],
    characters: Array.isArray(p.characters)
      ? p.characters.map(sanitizeCharacter).filter(Boolean).slice(0, MAX_CHARACTERS)
      : [],
    rollup: {
      plotTension: clampNum(rollupRaw.plotTension, 0, 100),
      characterProgress: clampNum(rollupRaw.characterProgress, 0, 100),
      readerValence: clampNum(rollupRaw.readerValence, -100, 100),
      readerIntensity: clampNum(rollupRaw.readerIntensity, 0, 100),
      primaryEmotion: str(rollupRaw.primaryEmotion, EMOTION_MAX),
      peakTension: clampNum(rollupRaw.peakTension, 0, 100),
      cliffhanger: rollupRaw.cliffhanger === true,
      oneLine: str(rollupRaw.oneLine, NOTE_MAX),
    },
  };
}

// ---------- storage ----------

async function loadSnapshot(issueId) {
  const content = await tryReadFile(snapshotPath(issueId));
  if (content === null) return null;
  return safeJSONParse(content, null, { allowArray: false, logError: true, context: snapshotPath(issueId) });
}

async function saveSnapshot(snapshot) {
  await ensureDir(editorialDir());
  await atomicWrite(snapshotPath(snapshot.issueId), snapshot);
}

// ---------- analysis ----------

// Best-effort hint: if a canon character's name appears in the series-level
// protagonist-arc text, pass it so the model confirms rather than guesses.
function detectKnownProtagonist(arcText, characterNames) {
  if (!arcText) return '';
  const lower = arcText.toLowerCase();
  return characterNames.find((n) => n && lower.includes(n.toLowerCase())) || '';
}

/**
 * Analyze a single issue. Returns the stored snapshot, a `{ status:'no-content' }`
 * marker, or a cached snapshot when the content is unchanged and `!force`.
 */
export async function analyzeIssue(issueId, { providerId, model, force = false } = {}) {
  assertValidIssueId(issueId);
  const issue = await getIssue(issueId);
  const picked = pickAnalyzableContent(issue);
  if (!picked) return { status: 'no-content', issueId, seriesId: issue.seriesId };

  const hash = contentHash(picked.text);
  const existing = await loadSnapshot(issueId);
  if (!force && existing && existing.status === 'complete' && existing.sourceContentHash === hash) {
    return { ...existing, cached: true };
  }

  const series = await getSeries(issue.seriesId).catch(() => null);
  const canon = series ? await getSeriesCanon(series) : { characters: [] };
  const characterNames = (canon.characters || []).map((c) => c?.name).filter(Boolean).slice(0, 40);
  const arc = series?.arc || null;

  // Scale the content cap to the target model's context window — never below
  // CONTENT_MAX (so we never truncate more than before), but a big-context
  // model gets the whole issue instead of a 48K slice.
  const { contextWindow } = await resolveStageContext(STAGE, { providerOverride: providerId, modelOverride: model });
  const overheadTokens = 1_500 + estimateTokens(
    [characterNames.join(', '), arc?.protagonistArc || '', (arc?.themes || []).join(', ')].join(' '),
  );
  const budgetChars = usableInputTokens({
    contextWindow,
    overheadTokens,
    outputReserveTokens: ANALYSIS_OUTPUT_RESERVE_TOKENS,
  }) * CHARS_PER_TOKEN;
  const contentMax = Math.max(CONTENT_MAX, budgetChars);

  const ctx = {
    series: { name: series?.name || 'Untitled series', logline: series?.logline || '' },
    issue: { number: issue.number, title: issue.title, arcRole: issue.arcRole || '' },
    arc: arc
      ? {
          protagonistArc: arc.protagonistArc || '',
          themesCsv: Array.isArray(arc.themes) ? arc.themes.join(', ') : '',
        }
      : { protagonistArc: '', themesCsv: '' },
    knownProtagonist: detectKnownProtagonist(arc?.protagonistArc, characterNames),
    knownCharacters: characterNames.join(', '),
    format: picked.sourceStage === 'comicScript' ? 'comic script'
      : picked.sourceStage === 'teleplay' ? 'teleplay' : 'prose',
    content: picked.text.length > contentMax
      ? `${picked.text.slice(0, contentMax)}\n\n[content truncated for analysis — ${picked.text.length} chars total]`
      : picked.text,
  };

  const result = await runStagedLLM(STAGE, ctx, {
    returnsJson: true,
    providerOverride: providerId,
    modelOverride: model,
    source: 'pipeline-editorial-analysis',
  });

  const snapshot = {
    issueId,
    seriesId: issue.seriesId,
    status: 'complete',
    sourceStage: picked.sourceStage,
    sourceContentHash: hash,
    providerId: result.providerId,
    model: result.model,
    runId: result.runId,
    createdAt: nowIso(),
    completedAt: nowIso(),
    ...sanitizeAnalysis(result.content),
  };
  await saveSnapshot(snapshot);
  console.log(`📊 editorial: analyzed issue=${issueId.slice(0, 12)} src=${picked.sourceStage} sections=${snapshot.sections.length} chars=${snapshot.characters.length}`);
  return snapshot;
}

// Single source of truth for staleness — used by both the per-issue read and
// the series aggregate so they can never disagree. A complete snapshot is
// stale when the issue's current content no longer matches the analyzed hash,
// OR when the content was removed entirely after analysis (phantom point).
// A legacy snapshot with no stored hash is treated as not-stale (can't tell).
function isSnapshotStale(snap, issue) {
  if (!snap || snap.status !== 'complete') return false;
  const picked = pickAnalyzableContent(issue);
  if (!picked) return true; // analyzed, but the draft was cleared since
  if (!snap.sourceContentHash) return false;
  return snap.sourceContentHash !== contentHash(picked.text);
}

/**
 * Load one issue's stored analysis with a `stale` flag (current content hash
 * differs from the analyzed hash). Returns null when never analyzed.
 */
export async function getIssueAnalysis(issueId) {
  assertValidIssueId(issueId);
  const snap = await loadSnapshot(issueId);
  if (!snap) return null;
  const issue = await getIssue(issueId).catch(() => null);
  return { ...snap, stale: isSnapshotStale(snap, issue) };
}

// ---------- series aggregation ----------

const normalizeName = (name) => String(name || '').trim().toLowerCase();
const valenceToScore = (v) => clampNum((Number(v) + 100) / 2, 0, 100); // −100..100 → 0..100

// Fold one snapshot's character records into the cross-issue accumulator.
// Votes are counted at most ONCE per issue per character — an LLM that lists
// the same name twice in one issue's characters[] must not skew the
// protagonist election, which is decided across issues.
function foldCharacters(acc, snapshot) {
  const countedThisIssue = new Set();
  for (const c of snapshot.characters || []) {
    const key = normalizeName(c.name);
    if (!key) continue;
    let entry = acc.get(key);
    if (!entry) {
      entry = { name: c.name, protagonistVotes: 0, falseVotes: 0, directions: new Set(), arcSummary: '', issues: new Set(), roles: new Set() };
      acc.set(key, entry);
    }
    if (!countedThisIssue.has(key)) {
      countedThisIssue.add(key);
      if (c.isProtagonist === true) entry.protagonistVotes += 1;
      else if (c.isProtagonist === false) entry.falseVotes += 1;
    }
    if (c.arcDirection && c.arcDirection !== 'flat') entry.directions.add(c.arcDirection);
    if (c.role) entry.roles.add(c.role);
    if (c.arcSummary && c.arcSummary.length > entry.arcSummary.length) entry.arcSummary = c.arcSummary;
    entry.issues.add(snapshot.issueId);
  }
}

function resolveDirection(directions) {
  if (directions.size === 0) return 'flat';
  if (directions.size === 1) return [...directions][0];
  return 'complex';
}

/**
 * Aggregate every analyzed issue in a series into the Editorial Roadmap:
 * Plot / Character / Reader curves, character arcs (with protagonist detection),
 * and coverage stats.
 */
export async function getSeriesEditorial(seriesId) {
  const series = await getSeries(seriesId).catch(() => null);
  const issues = await listIssues({ seriesId });
  const ordered = [...issues].sort(
    (a, b) => (a.arcPosition ?? 9999) - (b.arcPosition ?? 9999) || (a.number || 0) - (b.number || 0)
  );

  // Snapshot reads are independent file I/O — fan them out in parallel (mirrors
  // collectionStore.loadAll) rather than awaiting one at a time.
  const snaps = await Promise.all(ordered.map((issue) => loadSnapshot(issue.id)));

  const charAcc = new Map();
  let analyzed = 0;
  let stale = 0;
  let withContent = 0;
  let noContent = 0;

  const roadmap = [];
  ordered.forEach((issue, idx) => {
    const snap = snaps[idx];
    const hasContent = !!pickAnalyzableContent(issue);
    if (hasContent) withContent += 1; else noContent += 1;

    const isComplete = !!(snap && snap.status === 'complete');
    const isStale = isSnapshotStale(snap, issue);
    const entry = {
      issueId: issue.id,
      number: issue.number,
      arcPosition: issue.arcPosition ?? null,
      title: issue.title,
      label: issue.arcPosition != null ? `E${issue.arcPosition}` : `#${issue.number || ''}`,
      analyzed: isComplete,
      hasContent,
      stale: isStale,
      // Snapshot identity — changes when an issue is re-analyzed, so the detail
      // view can invalidate its cached section log.
      analyzedAt: isComplete ? (snap.completedAt || snap.createdAt || null) : null,
      plot: null,
      character: null,
      reader: null,
      primaryEmotion: '',
    };
    if (isComplete) {
      analyzed += 1;
      if (isStale) stale += 1;
      entry.plot = snap.rollup?.plotTension ?? null;
      entry.character = snap.rollup?.characterProgress ?? null;
      entry.reader = valenceToScore(snap.rollup?.readerValence);
      entry.primaryEmotion = snap.rollup?.primaryEmotion || '';
      foldCharacters(charAcc, snap);
    }
    roadmap.push(entry);
  });

  // Resolve aggregated characters. isProtagonist uses NET votes across issues:
  // a clear majority of "yes" → true, a clear majority of "no" → false, a tie
  // (or no votes) → null (genuinely ambiguous). The protagonist is then the
  // strongest net-positive candidate, so a character the model mostly tagged
  // NOT-protagonist can't be crowned on a stray single yes-vote.
  const characters = [...charAcc.values()]
    .map((e) => ({
      name: e.name,
      isProtagonist: e.protagonistVotes > e.falseVotes ? true : (e.falseVotes > e.protagonistVotes ? false : null),
      arcDirection: resolveDirection(e.directions),
      arcSummary: e.arcSummary,
      role: [...e.roles][0] || '',
      issueCount: e.issues.size,
      netProtagonistVotes: e.protagonistVotes - e.falseVotes,
    }))
    .sort((a, b) => b.issueCount - a.issueCount || b.netProtagonistVotes - a.netProtagonistVotes);

  let protagonist = characters
    .filter((c) => c.isProtagonist === true)
    .sort((a, b) => b.netProtagonistVotes - a.netProtagonistVotes || b.issueCount - a.issueCount)[0] || null;
  if (!protagonist) {
    protagonist = characters.find((c) => c.arcDirection !== 'flat') || characters[0] || null;
  }
  if (protagonist) protagonist = { ...protagonist, isProtagonist: true };

  const protagonistKey = protagonist ? normalizeName(protagonist.name) : null;
  const supportingArcs = characters.filter(
    (c) => normalizeName(c.name) !== protagonistKey && c.arcDirection !== 'flat'
  );

  return {
    seriesId,
    coverage: { analyzed, total: ordered.length, withContent, stale, noContent },
    roadmap,
    characters,
    protagonist,
    supportingArcs,
    protagonistArcText: series?.arc?.protagonistArc || null,
    generatedAt: nowIso(),
  };
}

export const __testing = { sanitizeAnalysis, valenceToScore, contentHash };
