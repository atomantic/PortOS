/**
 * Pipeline — Issues shared store/queue + record sanitizers (#2531)
 *
 * Split out of the former monolithic `issues.js` so `issueCrud` / `issueStages`
 * / `issueSync` can share ONE store facade, ONE per-series write queue, and ONE
 * set of record sanitizers. This module owns:
 *
 *   - the storage-backend dispatcher `store()` (issuesStore/store.js facade),
 *   - the per-series write tail `queueSeriesIssuesWrite` (single tail per
 *     seriesId — see the note on the queue below; two writes to different
 *     issues in the same series share the series-level index and MUST collapse
 *     to one tail),
 *   - the record + stage sanitizers (sanitizeIssue and friends),
 *   - the read/save helpers (readState / saveIssueNow / …) and renumberInline.
 *
 * An Issue (or Episode — same record, two formats) is a child of a Series and
 * carries the full per-stage state of one production pipeline run. Persisted to
 * data/pipeline-issues/{id}/index.json (PG-backed via the store facade).
 */

import { getIssuesStore } from './issuesStore/store.js';
import { createKeyCachedQueue } from '../../lib/createKeyCachedQueue.js';
import { IMAGE_GEN_MODE, QUEUEABLE_IMAGE_MODES } from '../imageGen/modes.js';
import {
  LENGTH_PROFILE_NAMES, DEFAULT_LENGTH_PROFILE,
  CUSTOM_PAGE_MIN, CUSTOM_PAGE_MAX, CUSTOM_MINUTE_MIN, CUSTOM_MINUTE_MAX,
} from '../../lib/issueLength.js';
import { sanitizeOrigin } from '../../lib/sharingOrigin.js';
import { sanitizeSoftDeleteFields } from '../../lib/syncWire.js';
import { ServerError } from '../../lib/errorHandler.js';
import { ARC_ROLES } from '../../lib/storyArc.js';
import { isStr, trimTo } from '../../lib/storyBible.js';
import { sanitizeCoverLike } from '../../lib/renderSlot.js';
import { applyVolumeOrderedNumbers } from '../../lib/pipelineIssueOrder.js';
import * as seriesSvc from './series.js';

// Storage backend dispatcher (#1015). Issue records moved from per-record
// `data/pipeline-issues/{id}/index.json` (collectionStore) to one-row-per-issue
// in PostgreSQL (`pipeline_issues`); the facade is a drop-in for the
// collectionStore surface this service calls (loadAll/loadOne/saveOneNow/
// deleteOne/queueTypeIndexWrite), so only this factory changed.
const store = () => getIssuesStore(sanitizeIssue);

export const issueStore = () => store();

// Series-scoped write queue. ALL issue mutations — create, per-issue PATCH,
// stage writes, deletes, and sibling-renumbering ops — route through this so
// they serialize per series. Even though collectionStore keeps a per-id queue,
// per-issue edits still share the series-level `index.json` (numbering, ordering),
// so two concurrent writes to *different* issues in the same series could read a
// stale index and clobber each other. A single tail per seriesId collapses that
// race: each write awaits the previous one and merges against the freshest state.
const seriesIssueQueue = createKeyCachedQueue();
function queueSeriesIssuesWrite(seriesId, fn) {
  const key = typeof seriesId === 'string' && seriesId ? seriesId : '__unknown__';
  return seriesIssueQueue(key, fn);
}

export const ERR_NOT_FOUND = 'PIPELINE_ISSUE_NOT_FOUND';
export const ERR_VALIDATION = 'PIPELINE_ISSUE_VALIDATION';
export const ERR_DUPLICATE = 'PIPELINE_ISSUE_DUPLICATE';
export const ERR_SEASON_LOCKED = 'PIPELINE_ISSUE_SEASON_LOCKED';
export const ERR_STAGE_LOCKED = 'PIPELINE_STAGE_LOCKED';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

const ISSUE_ID_RE = /^iss-[A-Za-z0-9-]+$/;

export const TITLE_MAX = 300;
export const SERIES_ID_MAX = 64;
export const SEASON_ID_MAX = 64;
// Issues fall back to position 0 when un-numbered; the cap keeps a runaway
// LLM payload from inflating the field unbounded.
export const ARC_POSITION_MAX = 9999;
export const STAGE_INPUT_MAX = 200_000;   // ~200kB — fits a long prose draft
export const STAGE_OUTPUT_MAX = 400_000;  // ~400kB — fits a long comic script
export const STAGE_NOTES_MAX = 4000;
export const ISSUES_PER_RESPONSE_MAX = 1000;
// How many prior versions of a text stage to retain for the diff modal.
// Each entry holds the full prior input+output, so the upper bound is
// N × (STAGE_INPUT_MAX + STAGE_OUTPUT_MAX) per stage. Five keeps a useful
// undo trail without ballooning pipeline-issues.json. Only text stages
// snapshot — visual/audio artifact shapes (pages[]/scenes[]/lines[]) aren't
// meaningfully diffable as plain text; see snapshot gating in
// updateStageWithLatest + updateIssue.
export const STAGE_RUN_HISTORY_MAX = 5;

// Stage IDs are ordered for UI display; the canonical order is also the
// auto-run text-chain order (idea → prose → scripts in parallel). Comic
// pages / storyboards / episode video stages are visual and stay manual
// in MVP.
export const TEXT_STAGE_IDS = Object.freeze(['idea', 'prose', 'comicScript', 'teleplay']);
export const VISUAL_STAGE_IDS = Object.freeze(['comicPages', 'storyboards', 'episodeVideo']);
// Audio is its own category — voice-over lines + music. Feature-gated on
// series.targetFormat (only meaningful when the series ships video, not
// comic-only). Kept separate from VISUAL_STAGE_IDS so the artifact shape
// (`lines[]`, `music`) stays distinct from visual stages.
export const AUDIO_STAGE_IDS = Object.freeze(['audio']);
export const STAGE_IDS = Object.freeze([...TEXT_STAGE_IDS, ...VISUAL_STAGE_IDS, ...AUDIO_STAGE_IDS]);
// Stages exposed to voice navigation ("next stage" / "previous stage" tools)
// and the tab strip. Includes audio now that the AudioStage UI is wired.
export const NAVIGABLE_STAGE_IDS = Object.freeze([...TEXT_STAGE_IDS, ...VISUAL_STAGE_IDS, ...AUDIO_STAGE_IDS]);

// "This stage has usable content and shouldn't be regenerated by default."
// `edited` = user typed into the editor; `ready` = LLM filled and the user
// hasn't asked to rerun. Both are good — auto-runners skip past them unless
// `force` is set. Defined here so every coordinator agrees on the predicate.
export function isStageReady(stage) {
  if (!stage) return false;
  if (stage.status !== 'ready' && stage.status !== 'edited') return false;
  return !!(stage.output && stage.output.trim());
}
export const STAGE_STATUSES = Object.freeze(['empty', 'generating', 'ready', 'edited', 'needs-review', 'error']);
export const ISSUE_STATUSES = Object.freeze(['draft', 'running', 'needs-review', 'shipped']);

const emptyStage = () => ({
  status: 'empty',
  input: '',
  output: '',
  lastRunId: null,
  errorMessage: '',
  updatedAt: null,
  locked: false,
  // Most-recent-first list of prior `{ runId, createdAt, input, output }`
  // snapshots, capped at STAGE_RUN_HISTORY_MAX. Populated only for text
  // stages — visual/audio stages keep the field as [] for shape parity.
  runHistory: [],
});

/**
 * Throw a 400 ServerError when `issue.stages[stageId].locked === true`.
 * Every code path that regenerates a stage's primary artifact (LLM text run,
 * image render, video render, audio synth, refine-prompt, extract-scenes /
 * extract-pages) must call this so the lock contract is uniform. Sibling to
 * the series-level (`series.locked.arc`) and season-level (`season.locked`)
 * checks elsewhere — any of the three rejects.
 */
export function assertStageUnlocked(issue, stageId) {
  if (issue?.stages?.[stageId]?.locked === true) {
    throw new ServerError(
      `Stage "${stageId}" is locked — unlock it before regenerating`,
      { status: 400, code: ERR_STAGE_LOCKED },
    );
  }
}

const sanitizeRunHistoryEntry = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const runId = isStr(raw.runId) && raw.runId ? raw.runId : null;
  if (!runId) return null;
  return {
    runId,
    createdAt: isStr(raw.createdAt) && raw.createdAt ? raw.createdAt : null,
    input: trimTo(raw.input, STAGE_INPUT_MAX),
    output: trimTo(raw.output, STAGE_OUTPUT_MAX),
  };
};

const sanitizeRunHistory = (raw) => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(sanitizeRunHistoryEntry)
    .filter(Boolean)
    .slice(0, STAGE_RUN_HISTORY_MAX);
};

export const CANON_EXTRACTION_STATUSES = Object.freeze(['ok', 'partial', 'failed']);
const CANON_KINDS = Object.freeze(['character', 'place', 'object']);

// Normalize a canon-extraction outcome marker. Returns `null` for absent /
// malformed input (the "never attempted" state) so the field stays falsy in
// the UI until a real extraction runs. `extracted` counts are coerced to
// non-negative integers; `failedKinds` is filtered to the known kinds.
const sanitizeCanonExtraction = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  if (!CANON_EXTRACTION_STATUSES.includes(raw.status)) return null;
  const count = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const ex = raw.extracted && typeof raw.extracted === 'object' ? raw.extracted : {};
  return {
    status: raw.status,
    error: trimTo(raw.error, STAGE_NOTES_MAX),
    failedKinds: Array.isArray(raw.failedKinds)
      ? [...new Set(raw.failedKinds.filter((k) => CANON_KINDS.includes(k)))]
      : [],
    extracted: {
      characters: count(ex.characters),
      places: count(ex.places),
      objects: count(ex.objects),
    },
    provider: trimTo(raw.provider, 80),
    model: trimTo(raw.model, 128),
    at: isStr(raw.at) ? raw.at : null,
  };
};

// Persisted outcome of the last strictly-prose-grounded "describe nouns from
// prose" run (see universeCanon.describeCanonFromProse). `null` = never run.
// `none`/`thin` carry the nouns the manuscript couldn't (or only thinly)
// describe so the Nouns UI can render a persistent manuscript-quality banner.
const sanitizeDescGapList = (arr) => (Array.isArray(arr) ? arr : [])
  .filter((g) => g && typeof g === 'object' && CANON_KINDS.includes(g.kind))
  .slice(0, 200)
  .map((g) => ({
    id: trimTo(g.id, 80),
    name: trimTo(g.name, 200),
    kind: g.kind,
    note: trimTo(g.note, 600),
  }));

const sanitizeDescGaps = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  return {
    at: isStr(raw.at) ? raw.at : null,
    provider: trimTo(raw.provider, 80),
    model: trimTo(raw.model, 128),
    filled: Number.isFinite(raw.filled) && raw.filled > 0 ? Math.floor(raw.filled) : 0,
    none: sanitizeDescGapList(raw.none),
    thin: sanitizeDescGapList(raw.thin),
    skippedLocked: sanitizeDescGapList(raw.skippedLocked),
  };
};

const sanitizeStage = (raw) => {
  if (!raw || typeof raw !== 'object') return emptyStage();
  const status = STAGE_STATUSES.includes(raw.status) ? raw.status : 'empty';
  return {
    status,
    input: trimTo(raw.input, STAGE_INPUT_MAX),
    output: trimTo(raw.output, STAGE_OUTPUT_MAX),
    lastRunId: isStr(raw.lastRunId) && raw.lastRunId ? raw.lastRunId : null,
    errorMessage: trimTo(raw.errorMessage, STAGE_NOTES_MAX),
    updatedAt: isStr(raw.updatedAt) ? raw.updatedAt : null,
    // Per-stage editorial lock. When true, `generateStage` (text) and the
    // visual stage `enqueueXxx` entry points refuse — lets the user freeze a
    // finalized comic script while still iterating storyboards. Independent
    // of `series.locked.arc` and `season.locked`; any of the three rejects.
    locked: raw.locked === true,
    runHistory: sanitizeRunHistory(raw.runHistory),
  };
};

// Text stages (idea/prose/comicScript/teleplay) carry one extra field beyond
// the shared stage shape: `canonExtraction`, the persisted outcome of the last
// characters/places/objects extraction run against the stage output (used on
// `prose`). Layered here rather than in `sanitizeStage` so visual/audio shapes
// never inherit a concern that doesn't apply to them. `null` = never attempted.
// Per-attempt record of the last multi-candidate draft-gate run (#2169, CWQE
// Phase 5). `null` = the gate never ran (single-shot generation, the default).
// Each attempt carries its runId (so its full text is recoverable from
// runHistory) + the composite qualityScore it was judged at, and `winner` names
// the kept attempt's runId — so the UI can show "kept 8.1, rejected 6.4 / 5.9".
const sanitizeDraftGate = (raw) => {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.attempts)) return null;
  const num = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
  const attempts = raw.attempts
    .filter((a) => a && typeof a === 'object' && isStr(a.runId) && a.runId)
    .slice(0, STAGE_RUN_HISTORY_MAX)
    .map((a) => ({
      runId: a.runId,
      qualityScore: num(a.qualityScore),
      overall: num(a.overall),
      slopPenalty: num(a.slopPenalty),
      rejected: a.rejected === true,
    }));
  if (!attempts.length) return null;
  return {
    winner: isStr(raw.winner) && raw.winner ? raw.winner : null,
    threshold: num(raw.threshold),
    attempts,
    stoppedEarly: raw.stoppedEarly === true,
    at: isStr(raw.at) ? raw.at : null,
  };
};

const sanitizeTextStage = (raw) => ({
  ...sanitizeStage(raw),
  canonExtraction: sanitizeCanonExtraction(raw?.canonExtraction),
  descGaps: sanitizeDescGaps(raw?.descGaps),
  draftGate: sanitizeDraftGate(raw?.draftGate),
});

/**
 * Decide whether `patch` represents a generate-replacement on `prevStage` and,
 * if so, prepend a snapshot of the prior state to `prevStage.runHistory`.
 * Returns the new runHistory array (capped at STAGE_RUN_HISTORY_MAX).
 *
 * Trigger conditions (ALL must hold):
 *   - `stageId` is in TEXT_STAGE_IDS — visual + audio shapes don't snapshot.
 *   - patch.lastRunId is a non-empty string that differs from prevStage.lastRunId.
 *   - prevStage.lastRunId is set AND prevStage.output is non-empty — there's
 *     prior content worth preserving for diff/restore.
 *
 * Skipped triggers (and why):
 *   - First-time generate (prev.lastRunId === null) — nothing to snapshot.
 *   - status: 'generating' transition — patch carries no new lastRunId yet.
 *   - status: 'error' from a failed LLM throw — patch carries no new lastRunId.
 *   - Save-edit (PATCH with input/output but no lastRunId) — caller explicitly
 *     editing the existing version, not replacing it. The previous run remains
 *     the active version; the next generate will snapshot it.
 */
export function snapshotRunHistory(prevStage, patch, stageId, { force = false } = {}) {
  const prevHistory = Array.isArray(prevStage?.runHistory) ? prevStage.runHistory : [];
  if (!patch || typeof patch !== 'object') return prevHistory;
  if (!TEXT_STAGE_IDS.includes(stageId)) return prevHistory;
  const nextRunId = isStr(patch.lastRunId) ? patch.lastRunId : '';
  if (!nextRunId) return prevHistory;
  if (nextRunId === prevStage?.lastRunId) return prevHistory;
  // Default: only snapshot a prior that was itself a recorded run (keeps the
  // first generate from snapshotting an empty/seed-only stage). With `force`
  // (manuscript-editor edits), snapshot ANY non-empty prior, synthesizing an id
  // when the prior was never a run — so imported/hand-typed text stays
  // revertible from its very first edit.
  if (!prevStage?.lastRunId && !force) return prevHistory;
  const prevOutput = prevStage?.output || '';
  if (!prevOutput.trim()) return prevHistory;
  const snapshot = {
    runId: prevStage.lastRunId || `pre-${nextRunId}`,
    createdAt: prevStage.updatedAt || new Date().toISOString(),
    input: prevStage.input || '',
    output: prevOutput,
  };
  // Drop any prior entry whose runId matches the now-active runId. This is
  // the restore case: snapshot r1 → user restores r1 → r1 becomes the active
  // runId AND is still sitting in prevHistory. Without the filter the next
  // regenerate would push the just-displaced state and leave a duplicate
  // r1 in the list, breaking React keys and making restore-by-runId
  // ambiguous (which r1 to apply?).
  const dedupedPrior = prevHistory.filter((entry) => entry.runId !== nextRunId);
  return [snapshot, ...dedupedPrior].slice(0, STAGE_RUN_HISTORY_MAX);
}

// Strip per-stage `runHistory` from a sanitized issue so list-shaped
// endpoints can opt out of shipping each stage's full version history. Text
// stages can hold up to STAGE_RUN_HISTORY_MAX (5) entries × ~600KB each, so
// a maxed-out issue is ~12MB of payload that the sidebar + per-series list
// never render. Opt-in via `withHistory: false` on `listIssues` /
// `listRecentIssues` — the default is full-shape because internal callers
// (notably `exportSeries`) round-trip every stored field through the bucket
// export, and dropping history there would lose it on the receiving peer.
const stripRunHistoryFromIssue = (issue) => {
  if (!issue || typeof issue !== 'object' || !issue.stages) return issue;
  const strippedStages = {};
  for (const [stageId, stage] of Object.entries(issue.stages)) {
    strippedStages[stageId] = stage?.runHistory?.length ? { ...stage, runHistory: [] } : stage;
  }
  return { ...issue, stages: strippedStages };
};

// Episode-video render settings the user chose at kickoff time. Persisted
// on the stage so a page reload doesn't reset them to the defaults — the
// restart flow can render the same pickers populated with the user's
// previous choice. The CD project itself owns the authoritative values once
// rendering starts; these are the *requested* settings for the next start.
const ASPECT_RATIO_VALUES = new Set(['16:9', '9:16', '1:1']);
const QUALITY_VALUES = new Set(['draft', 'standard', 'high']);

// `imageMode: 'auto'` defers to the server resolver (codex when enabled,
// local otherwise). Returns null when nothing was set so the persisted
// JSON stays clean for issues that never opened the panel.
const IMAGE_MODE_VALUES = new Set(['auto', ...QUEUEABLE_IMAGE_MODES]);
const GEN_CONFIG_STR_MAX = 200;
const sanitizeGenConfig = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const imageMode = IMAGE_MODE_VALUES.has(raw.imageMode) ? raw.imageMode : 'auto';
  // imageModelId is only meaningful for local diffusion — clear it for other
  // modes so a previously-pinned model doesn't silently persist in the config
  // and mislead the UI or any future reader that doesn't filter by mode.
  const imageModelId = imageMode === IMAGE_GEN_MODE.LOCAL
    ? (trimTo(raw.imageModelId, GEN_CONFIG_STR_MAX) || null)
    : null;
  const refineProvider = trimTo(raw.refineProvider, GEN_CONFIG_STR_MAX) || null;
  const refineModel = trimTo(raw.refineModel, GEN_CONFIG_STR_MAX) || null;
  // Trained character-LoRA auto-apply opt-out. Default ON — only an explicit
  // false persists, so issues that never touched the toggle stay clean.
  const applyCharacterLoras = raw.applyCharacterLoras !== false;
  if (imageMode === 'auto' && !imageModelId && !refineProvider && !refineModel && applyCharacterLoras) {
    return null;
  }
  return { imageMode, imageModelId, refineProvider, refineModel, applyCharacterLoras };
};

// Page records (pages[]) are pass-through in sanitizeVisualStage's array
// slice, so the new proofImage/finalImage fields survive there without an
// explicit sanitizer. If pages ever gets a deep sanitizer, route slot
// records through sanitizeRenderSlot (lib/renderSlot.js) the same way
// the cover does.

const sanitizeVisualStage = (raw, stageId = null) => {
  // Visual stages keep arbitrary structured artifact lists. Sanitize the
  // wrapper but pass through known shapes. `canonExtraction` is text-stage-only
  // (it lives on `sanitizeTextStage`), so the visual shape never carries it.
  const base = sanitizeStage(raw);
  return {
    ...base,
    pages: Array.isArray(raw?.pages) ? raw.pages.slice(0, 200) : [],
    scenes: Array.isArray(raw?.scenes) ? raw.scenes.slice(0, 200) : [],
    cdProjectId: isStr(raw?.cdProjectId) && raw.cdProjectId ? raw.cdProjectId : null,
    videoPath: isStr(raw?.videoPath) && raw.videoPath ? raw.videoPath : null,
    aspectRatio: ASPECT_RATIO_VALUES.has(raw?.aspectRatio) ? raw.aspectRatio : null,
    quality: QUALITY_VALUES.has(raw?.quality) ? raw.quality : null,
    // Video model id — only meaningful on episodeVideo (it picks the per-scene
    // render engine). Dropped on comicPages/storyboards so the contract is
    // explicit, but kept when stageId is omitted (legacy load-time sanitize
    // has no per-stage context). `null` = use the server/settings default.
    modelId: (stageId === null || stageId === 'episodeVideo') && isStr(raw?.modelId) && raw.modelId
      ? raw.modelId.slice(0, 64)
      : null,
    // genConfig is read by comicPages/storyboards; pass-through is a no-op on
    // episodeVideo, which never looks at it.
    genConfig: sanitizeGenConfig(raw?.genConfig),
    // `cover` and `backCover` are meaningful only on comicPages — they carry
    // the front/back-cover concept + render jobs. Dropping them on
    // storyboards / episodeVideo makes the contract explicit (matches the
    // comment in pipeline.js's visual stage schema). When stageId is
    // omitted (legacy callers / stage-shape sanitize at issue load time
    // without per-stage context), keep the field — `sanitizeStages` below
    // threads the stageId through so the canonical persistence path
    // enforces the rule.
    cover: stageId === null || stageId === 'comicPages' ? sanitizeCoverLike(raw?.cover) : null,
    backCover: stageId === null || stageId === 'comicPages' ? sanitizeCoverLike(raw?.backCover) : null,
  };
};

// Audio stage shape — dialogue VO lines + optional background music. Each
// line carries the source character + the actual line text + the render job
// id + a server-stamped filename (the storyboards filename hook's pattern
// will be extended to audio in a follow-up). `voiceIdOverride` lets a single
// line use a different voice than the character's default (narrator V.O.,
// flashback voice, etc.).
const AUDIO_LINE_TEXT_MAX = 4000;
const AUDIO_LINES_MAX = 1000;
export const AUDIO_FILENAME_MAX = 500;
const AUDIO_LINE_ID_MAX = 80;
// Cap a per-line VO offset at a generous episode length so a corrupted record
// can't push an `adelay` filter into absurd territory. Two hours is far beyond
// any single issue's runtime.
const AUDIO_LINE_OFFSET_MAX_SEC = 7200;
// Normalize a per-line start offset (seconds into the stitched episode where
// this VO line plays). `null` = "not placed yet" — kept distinct from `0`
// ("plays at the very start") so the muxer can skip un-placed lines instead of
// stacking them all at t=0. Negative / non-finite input collapses to null.
export const sanitizeLineOffset = (raw) => {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n, AUDIO_LINE_OFFSET_MAX_SEC);
};
const sanitizeAudioLine = (raw, i) => {
  if (!raw || typeof raw !== 'object') return null;
  const text = trimTo(raw.text, AUDIO_LINE_TEXT_MAX);
  if (!text) return null;
  const id = trimTo(raw.id, AUDIO_LINE_ID_MAX) || `line-${String(i + 1).padStart(3, '0')}`;
  return {
    id,
    characterId: trimTo(raw.characterId, 80) || null,
    characterName: trimTo(raw.characterName, 120) || null,
    text,
    voiceIdOverride: trimTo(raw.voiceIdOverride, 200) || null,
    audioJobId: isStr(raw.audioJobId) && raw.audioJobId ? raw.audioJobId : null,
    audioFilename: isStr(raw.audioFilename) && raw.audioFilename
      ? raw.audioFilename.slice(0, AUDIO_FILENAME_MAX)
      : null,
    // Per-line start offset for muxing VO into the stitched episode (Phase
    // 4d.2). null until the user (or a future auto-spacer) places it.
    offsetSec: sanitizeLineOffset(raw.offsetSec),
  };
};

const MUSIC_SOURCES = new Set(['upload', 'library', 'gen']);
const sanitizeMusicTrack = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const source = MUSIC_SOURCES.has(raw.source) ? raw.source : null;
  const trackFilename = trimTo(raw.trackFilename, AUDIO_FILENAME_MAX) || null;
  const label = trimTo(raw.label, 200) || null;
  if (!source && !trackFilename && !label) return null;
  return { source, trackFilename, label };
};

// Which strategy drives the episode's non-dialogue audio (whole-episode audio,
// issue #863 / design doc 2026-06-03-whole-episode-audio-strategy.md):
//   per-clip       — keep each stitched clip's own soundtrack (today's default)
//   silent         — strip any bed
//   generated      — assemble the arc-driven cues[] onto the timeline
//   uploaded-track — loop the single `music` pointer under the whole episode
export const AUDIO_MODES = Object.freeze(['per-clip', 'silent', 'generated', 'uploaded-track']);
// Read-side default: an absent / unknown audioMode collapses to 'per-clip' —
// today's behavior — so an un-migrated record (or one synced from an older,
// audioMode-unaware peer) reads correctly before migration 067 stamps the
// explicit value. Never let "absent" become a wrong mode (CLAUDE.md sentinel
// discipline).
export const sanitizeAudioMode = (raw) => (AUDIO_MODES.includes(raw) ? raw : 'per-clip');

// Per-cue field caps. Exported so the route's light Zod arm references the
// same numbers (the sanitizer below is authoritative; the route only guards
// against payload ballooning) and can't silently drift if these change.
export const AUDIO_CUE_ID_MAX = 80;
export const AUDIO_CUE_LABEL_MAX = 200;
export const AUDIO_CUE_PROMPT_MAX = 8000;
export const AUDIO_CUE_ENGINE_MAX = 80;
export const AUDIO_CUES_MAX = 200;

// Per-cue gain override. `null` = "use the stage / global default", distinct
// from `0` ("muted"). Clamped to a sane 0..4 range so a corrupted value can't
// blow out the mix.
const sanitizeCueGain = (raw) => {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n, 4);
};

const sanitizeAudioCue = (raw, i) => {
  if (!raw || typeof raw !== 'object') return null;
  const id = trimTo(raw.id, AUDIO_CUE_ID_MAX) || `cue-${String(i + 1).padStart(3, '0')}`;
  return {
    id,
    label: trimTo(raw.label, AUDIO_CUE_LABEL_MAX) || null,
    prompt: trimTo(raw.prompt, AUDIO_CUE_PROMPT_MAX) || null,
    // Engine id (musicgen | audioldm2 | suno | …). Free-form trimmed string so
    // a future pluggable engine works without a sanitizer change — the render
    // route resolves it against the live ENGINES registry. null = "unset".
    engine: trimTo(raw.engine, AUDIO_CUE_ENGINE_MAX) || null,
    // Reuse sanitizeLineOffset for cue timing: identical null-vs-0 sentinel
    // ("not placed yet" vs "plays at start") and 2h cap as VO line offsets.
    // durationSec is "not rendered yet" (null) → actual length once rendered.
    startSec: sanitizeLineOffset(raw.startSec),
    endSec: sanitizeLineOffset(raw.endSec),
    trackFilename: isStr(raw.trackFilename) && raw.trackFilename
      ? raw.trackFilename.slice(0, AUDIO_FILENAME_MAX)
      : null,
    durationSec: sanitizeLineOffset(raw.durationSec),
    gain: sanitizeCueGain(raw.gain),
  };
};

const sanitizeAudioStage = (raw) => {
  // `canonExtraction` is text-stage-only (see sanitizeTextStage) — the audio
  // shape never carries it.
  const base = sanitizeStage(raw);
  return {
    ...base,
    lines: Array.isArray(raw?.lines)
      ? raw.lines.slice(0, AUDIO_LINES_MAX).map(sanitizeAudioLine).filter(Boolean)
      : [],
    music: sanitizeMusicTrack(raw?.music),
    audioMode: sanitizeAudioMode(raw?.audioMode),
    cues: Array.isArray(raw?.cues)
      ? raw.cues.slice(0, AUDIO_CUES_MAX).map(sanitizeAudioCue).filter(Boolean)
      : [],
  };
};

const sanitizeStages = (raw = {}) => {
  const out = {};
  for (const id of TEXT_STAGE_IDS) out[id] = sanitizeTextStage(raw[id]);
  for (const id of VISUAL_STAGE_IDS) out[id] = sanitizeVisualStage(raw[id], id);
  for (const id of AUDIO_STAGE_IDS) out[id] = sanitizeAudioStage(raw[id]);
  return out;
};

const sanitizeIssue = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  if (!isStr(raw.id) || !raw.id) return null;
  if (!isStr(raw.seriesId) || !raw.seriesId) return null;
  const title = trimTo(raw.title, TITLE_MAX);
  if (!title) return null;
  const number = Number.isFinite(raw.number) ? Math.max(0, Math.floor(raw.number)) : 0;
  const status = ISSUE_STATUSES.includes(raw.status) ? raw.status : 'draft';
  const createdAt = isStr(raw.createdAt) ? raw.createdAt : new Date().toISOString();
  const updatedAt = isStr(raw.updatedAt) ? raw.updatedAt : createdAt;
  // Phase 2 of Story Arc Planning: optional pointer back into the parent
  // series' arc tree. `null` is the back-compat default — every pre-existing
  // issue stays un-grouped until the user (or LLM-arc-generation) assigns it.
  const seasonId = isStr(raw.seasonId) && raw.seasonId
    ? trimTo(raw.seasonId, SEASON_ID_MAX)
    : null;
  const arcPosition = Number.isFinite(raw.arcPosition)
    ? Math.max(0, Math.min(ARC_POSITION_MAX, Math.floor(raw.arcPosition)))
    : null;
  // LLM-assigned role within the volume — drives beat-sheet cadence
  // (finale vs. complication need very different shapes).
  const arcRole = ARC_ROLES.includes(raw.arcRole) ? raw.arcRole : null;
  // Defaults to 'standard' so pre-field issues keep the prior 22pg/24min sizing.
  // pageTarget/minutesTarget are only consumed when lengthProfile==='custom',
  // but we persist them on every profile so the picker can remember a previous
  // custom value if the user toggles back. Bounds mirror the values
  // `computeIssueTargets` clamps to at render time — otherwise the persisted
  // record could disagree with the prompt-rendered length.
  const lengthProfile = LENGTH_PROFILE_NAMES.includes(raw.lengthProfile)
    ? raw.lengthProfile
    : DEFAULT_LENGTH_PROFILE;
  const pageTarget = Number.isFinite(raw.pageTarget)
    ? Math.max(CUSTOM_PAGE_MIN, Math.min(CUSTOM_PAGE_MAX, Math.round(raw.pageTarget)))
    : null;
  const minutesTarget = Number.isFinite(raw.minutesTarget)
    ? Math.max(CUSTOM_MINUTE_MIN, Math.min(CUSTOM_MINUTE_MAX, Math.round(raw.minutesTarget)))
    : null;
  return {
    id: raw.id,
    seriesId: trimTo(raw.seriesId, SERIES_ID_MAX),
    number,
    title,
    status,
    seasonId,
    arcPosition,
    arcRole,
    lengthProfile,
    pageTarget,
    minutesTarget,
    stages: sanitizeStages(raw.stages || {}),
    // Share-bucket provenance — present on imported records, absent on locally-authored ones.
    origin: sanitizeOrigin(raw.origin),
    createdAt,
    updatedAt,
    // Soft-delete fields — see universeBuilder.sanitizeTemplate.
    ...sanitizeSoftDeleteFields(raw),
    // Local-only "don't sync to peers" marker. Issues piggyback on their
    // parent series' subscription, so marking an issue ephemeral keeps the
    // series push payload from carrying it (sanitizeRecordForWire drops it
    // and the series's bundled-issues filter discards the null entry).
    ...(raw.ephemeral === true ? { ephemeral: true } : {}),
  };
};

async function readState() {
  return { issues: await store().loadAll() };
}

// Series-scoped read — uses the indexed `idx_issues_series` query (PG) so a
// per-series scan doesn't load + sanitize every issue in the install. Callers
// that already filter by seriesId in JS should source from here instead.
async function readStateForSeries(seriesId) {
  return { issues: await store().loadAllForSeries(seriesId) };
}

async function saveIssueNow(issue) {
  await store().saveOneNow(issue.id, issue);
  return issue;
}

async function saveIssuesNow(issues) {
  await Promise.all(issues.map((issue) => saveIssueNow(issue)));
}

async function renumberInline(state, seriesId, fromSeasonId = null, preloadedSeries = null) {
  // Batch callers (e.g. commitEpisodesToIssues seeding a whole season) thread
  // the already-fetched series so an N-episode loop doesn't pay N redundant
  // getSeries reads of an unchanging record. Guard on id match so a mismatched
  // preload can never renumber against the wrong season list.
  const series = (preloadedSeries && preloadedSeries.id === seriesId)
    ? preloadedSeries
    : await seriesSvc.getSeries(seriesId).catch(() => null);
  // Exclude tombstones from numbering — surviving issues should keep a
  // contiguous sequence regardless of how many deletes happened.
  // applyVolumeOrderedNumbers mutates each issue's `number` in place, so the
  // filtered array still aliases the same objects in state.issues.
  return applyVolumeOrderedNumbers({
    issues: state.issues.filter((i) => !i.deleted),
    seriesId,
    seasons: series?.seasons || [],
    fromSeasonId,
  });
}


// Internal helpers shared across issueCrud / issueStages / issueSync. Exported
// here (rather than inline) so the split modules can reach the single store
// facade, write queue, sanitizers, and renumber pass.
export {
  store,
  queueSeriesIssuesWrite,
  makeErr,
  ISSUE_ID_RE,
  readState,
  readStateForSeries,
  saveIssueNow,
  saveIssuesNow,
  renumberInline,
  sanitizeIssue,
  sanitizeTextStage,
  sanitizeVisualStage,
  sanitizeAudioStage,
  stripRunHistoryFromIssue,
};
