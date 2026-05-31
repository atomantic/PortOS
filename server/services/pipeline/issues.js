/**
 * Pipeline — Issues Service
 *
 * An Issue (or Episode — same record, two formats) is a child of a Series and
 * carries the full per-stage state of one production pipeline run:
 *
 *   stages.idea         — beat sheet from the rough human seed
 *   stages.prose        — short-story draft
 *   stages.comicScript  — page/panel script (one of two parallel script stages)
 *   stages.teleplay     — scene-by-scene teleplay (the other parallel script stage)
 *   stages.comicPages   — image-gen output for each comic page's panels
 *   stages.storyboards  — image-gen + per-scene video output via CD scene runner
 *   stages.episodeVideo — final stitched episode video via CD
 *
 * Each stage record carries a status, the user-editable input, the AI output,
 * and a `lastRunId` pointer into data/runs/<runId>/ for the LLM transcript.
 *
 * Persisted to data/pipeline-issues/{id}/index.json.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS } from '../../lib/fileUtils.js';
import { createCollectionStore } from '../../lib/collectionStore.js';
import { isPlainObject } from '../../lib/objects.js';
import { IMAGE_GEN_MODE } from '../imageGen/modes.js';
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
import { emitRecordUpdated } from '../sharing/recordEvents.js';
import { applyVolumeOrderedNumbers, UNSCOPED_ANCHOR } from '../../lib/pipelineIssueOrder.js';
import * as seriesSvc from './series.js';

// TYPE-level (storage layout) schema version stamped on
// `data/pipeline-issues/index.json`.
//   v1 — issues split out of monolithic `data/pipeline-issues.json` into
//        per-record `data/pipeline-issues/{id}/index.json`. See migration 035.
const TYPE_SCHEMA_VERSION = 1;

let _store = null;
const store = () => {
  if (_store && _store.dir === join(PATHS.data, 'pipeline-issues')) return _store;
  _store = createCollectionStore({
    dir: join(PATHS.data, 'pipeline-issues'),
    type: 'pipelineIssues',
    schemaVersion: TYPE_SCHEMA_VERSION,
    sanitizeRecord: sanitizeIssue,
    idPattern: /^iss-[A-Za-z0-9-]+$/,
  });
  return _store;
};

export const issueStore = () => store();

// Series-scoped queue for mutations that can renumber siblings. Ordinary
// per-issue PATCH/stage writes use collectionStore's per-id queue so edits to
// different issues no longer serialize behind one monolithic JSON tail.
const seriesIssueTails = new Map();
function queueSeriesIssuesWrite(seriesId, fn) {
  const key = typeof seriesId === 'string' && seriesId ? seriesId : '__unknown__';
  const prev = seriesIssueTails.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  const silenced = next.catch(() => {});
  seriesIssueTails.set(key, silenced);
  silenced.finally(() => {
    if (seriesIssueTails.get(key) === silenced) seriesIssueTails.delete(key);
  });
  return next;
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
const sanitizeTextStage = (raw) => ({
  ...sanitizeStage(raw),
  canonExtraction: sanitizeCanonExtraction(raw?.canonExtraction),
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
const IMAGE_MODE_VALUES = new Set(['auto', IMAGE_GEN_MODE.LOCAL, IMAGE_GEN_MODE.CODEX]);
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
  if (imageMode === 'auto' && !imageModelId && !refineProvider && !refineModel) {
    return null;
  }
  return { imageMode, imageModelId, refineProvider, refineModel };
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
const AUDIO_FILENAME_MAX = 500;
const AUDIO_LINE_ID_MAX = 80;
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

async function saveIssueNow(issue) {
  await store().saveOneNow(issue.id, issue);
  return issue;
}

async function saveIssuesNow(issues) {
  await Promise.all(issues.map((issue) => saveIssueNow(issue)));
}

export async function listIssues({
  seriesId = null,
  offset = 0,
  limit = ISSUES_PER_RESPONSE_MAX,
  paginated = false,
  withHistory = true,
  includeDeleted = false,
} = {}) {
  const { issues } = await readState();
  const live = includeDeleted ? issues : issues.filter((i) => !i.deleted);
  const filtered = seriesId ? live.filter((i) => i.seriesId === seriesId) : live;
  const sorted = [...filtered].sort((a, b) => {
    if (a.seriesId !== b.seriesId) return a.seriesId.localeCompare(b.seriesId);
    return (a.number || 0) - (b.number || 0);
  });
  const project = withHistory ? (i) => i : stripRunHistoryFromIssue;
  const safeLimit = Math.min(Math.max(1, limit), ISSUES_PER_RESPONSE_MAX);
  const safeOffset = Math.max(0, offset);
  if (paginated) {
    return {
      items: sorted.slice(safeOffset, safeOffset + safeLimit).map(project),
      total: sorted.length,
      offset: safeOffset,
      limit: safeLimit,
    };
  }
  return sorted.slice(0, ISSUES_PER_RESPONSE_MAX).map(project);
}

/**
 * Recently-updated issues across all series. Sorts the FULL issue set by
 * `updatedAt` desc before applying `limit` — unlike `listIssues`, which
 * sorts by `seriesId/number` then caps at `ISSUES_PER_RESPONSE_MAX`. That
 * cap would silently miss the most-recent issues once the dataset grows
 * beyond 1000, so the sidebar's recent-issues view needs this dedicated
 * helper.
 */
export async function listRecentIssues({ limit = 10, withHistory = true, includeDeleted = false } = {}) {
  const { issues } = await readState();
  const live = includeDeleted ? issues : issues.filter((i) => !i.deleted);
  // Coerce in two passes so non-finite inputs ('abc', undefined) fall to
  // the default rather than letting JS's `0 || 10` short-circuit return
  // 10 for an explicit limit=0.
  const raw = Number(limit);
  const fallback = Number.isFinite(raw) ? Math.floor(raw) : 10;
  const clamped = Math.max(1, Math.min(50, fallback));
  const project = withHistory ? (i) => i : stripRunHistoryFromIssue;
  return [...live]
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .slice(0, clamped)
    .map(project);
}

export async function getIssue(id, { includeDeleted = false } = {}) {
  const found = await store().loadOne(id);
  if (!found) throw makeErr(`Issue not found: ${id}`, ERR_NOT_FOUND);
  if (found.deleted && !includeDeleted) throw makeErr(`Issue not found: ${id}`, ERR_NOT_FOUND);
  return found;
}

export function createIssue(input = {}) {
  const seriesId = trimTo(input.seriesId, SERIES_ID_MAX);
  if (!seriesId) return Promise.reject(makeErr('seriesId is required', ERR_VALIDATION));
  const title = trimTo(input.title, TITLE_MAX);
  if (!title) return Promise.reject(makeErr(`title is required (1..${TITLE_MAX} chars)`, ERR_VALIDATION));
  return queueSeriesIssuesWrite(seriesId, async () => {
    const state = await readState();
    const next = sanitizeIssue({
      id: `iss-${randomUUID()}`,
      seriesId,
      // Placeholder — `renumberInline` below derives the canonical number.
      number: 0,
      title,
      status: 'draft',
      // Phase 2: optional arc pointers passed by the season-episodes generator
      // (and any future caller wiring an issue to a season at create time).
      seasonId: 'seasonId' in input ? input.seasonId : null,
      arcPosition: 'arcPosition' in input ? input.arcPosition : null,
      arcRole: 'arcRole' in input ? input.arcRole : null,
      lengthProfile: 'lengthProfile' in input ? input.lengthProfile : undefined,
      pageTarget: 'pageTarget' in input ? input.pageTarget : null,
      minutesTarget: 'minutesTarget' in input ? input.minutesTarget : null,
      stages: input.stages || {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ephemeral: input.ephemeral === true,
    });
    if (!next) throw makeErr('Invalid issue payload', ERR_VALIDATION);
    state.issues.push(next);
    await renumberInline(state, seriesId, next.seasonId || UNSCOPED_ANCHOR);
    await saveIssuesNow(state.issues.filter((i) => i.seriesId === seriesId));
    // New issue = series-level change for any active share subscription.
    emitRecordUpdated('series', next.seriesId);
    return next;
  });
}

async function renumberInline(state, seriesId, fromSeasonId = null) {
  const series = await seriesSvc.getSeries(seriesId).catch(() => null);
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

export function recomputeIssueNumbersForSeries(seriesId, fromSeasonId = null) {
  return queueSeriesIssuesWrite(seriesId, async () => {
    const state = await readState();
    const changed = await renumberInline(state, seriesId, fromSeasonId);
    if (!changed) return { changed: false };
    await saveIssuesNow(state.issues.filter((i) => i.seriesId === seriesId));
    emitRecordUpdated('series', seriesId);
    return { changed: true };
  });
}

/**
 * Reassign every issue under `(seriesId, fromSeasonId)` to `toSeasonId` in a
 * single collection load → in-memory mutate → per-record save pass.
 * Used by `deleteSeason` (and any future bulk season-move flow) to collapse
 * N per-issue write cycles into one — the legacy N+1 pattern was
 * `for (iss of children) await updateIssue(iss.id, { seasonId: toSeasonId }, { skipRenumber: true })`
 * which paid N read/write round-trips and N debounced re-exports even with
 * `withReexportSuppressed`.
 *
 * Returns `{ reassigned, fromSeasonId, toSeasonId }`. `toSeasonId` may be
 * `null` (un-grouped). A re-export of the parent series is emitted once, after
 * the renumber pass — callers under `withReexportSuppressed` get exactly one
 * `series:updated` event regardless of the issue count.
 */
export function bulkReassignSeason(seriesId, fromSeasonId, toSeasonId = null, { _preloadedSeries = null } = {}) {
  return queueSeriesIssuesWrite(seriesId, async () => {
    // Honor per-season locks — refuse to move issues OUT of or INTO a locked
    // volume. Series lives in a different write queue, so this is best-effort
    // single-user gating, not strict serialization (fine per CLAUDE.md).
    // Callers that already hold a fresh series (e.g. `deleteSeason` reads it
    // for the reassign-target validation) can pass `_preloadedSeries` to skip
    // the duplicate read.
    if (fromSeasonId || toSeasonId) {
      const series = _preloadedSeries || await seriesSvc.getSeries(seriesId);
      const seasons = Array.isArray(series.seasons) ? series.seasons : [];
      const findLocked = (id) => (id ? seasons.find((s) => s.id === id && s.locked === true) : null);
      const blocker = findLocked(fromSeasonId) || findLocked(toSeasonId);
      if (blocker) {
        throw makeErr(
          `Season "${blocker.title || blocker.number}" is locked — unlock it before reassigning issues`,
          ERR_SEASON_LOCKED,
        );
      }
    }
    const state = await readState();
    let reassigned = 0;
    const now = new Date().toISOString();
    for (let i = 0; i < state.issues.length; i += 1) {
      const iss = state.issues[i];
      if (iss.seriesId !== seriesId) continue;
      // Skip tombstones — moving a soft-deleted issue would bump its
      // `updatedAt`, which then loses LWW races with the originator's
      // tombstone and can resurrect the record on every peer.
      if (iss.deleted) continue;
      if ((iss.seasonId || null) !== (fromSeasonId || null)) continue;
      // Re-sanitize through the same pipeline updateIssue uses so the
      // in-memory rewrite gets the same shape guarantees as a route PATCH.
      const merged = sanitizeIssue({
        ...iss,
        seasonId: toSeasonId,
        updatedAt: now,
      });
      if (!merged) continue;
      state.issues[i] = merged;
      reassigned += 1;
    }
    if (reassigned === 0) return { reassigned: 0, fromSeasonId, toSeasonId };
    // One renumber pass after the bulk move — the source AND destination
    // volume both reshuffled, so use the series-wide form (fromSeasonId=null).
    await renumberInline(state, seriesId, null);
    await saveIssuesNow(state.issues.filter((i) => i.seriesId === seriesId));
    emitRecordUpdated('series', seriesId);
    return { reassigned, fromSeasonId, toSeasonId };
  });
}

/**
 * Reassign every live issue from `fromSeriesId` to `toSeriesId` — used by the
 * series-merge engine (recordMerge.js) so a duplicate series' issues survive
 * the merge instead of being orphaned under the tombstoned loser.
 *
 * Moved issues land UN-GROUPED (`seasonId: null`): seasons are series-scoped,
 * so the loser's season ids don't exist on the survivor. The survivor's
 * seasons were unioned by number separately; re-homing issues to specific
 * survivor seasons is left to the user. A single renumber pass on the survivor
 * sequences the combined set. Returns `{ reassigned }`.
 *
 * Serialized on the SURVIVOR's issues queue so the renumber can't race a
 * concurrent survivor edit. Tombstoned issues are skipped (moving them would
 * bump updatedAt and lose the originator's delete LWW race).
 */
export function reassignIssuesToSeries(fromSeriesId, toSeriesId) {
  if (!isStr(fromSeriesId) || !isStr(toSeriesId) || fromSeriesId === toSeriesId) {
    return Promise.reject(makeErr('reassignIssuesToSeries: fromSeriesId and toSeriesId must differ', ERR_VALIDATION));
  }
  // This reads/mutates issues belonging to BOTH series (it moves source issues
  // and renumbers the destination), so serialize on both per-series queues, not
  // just the destination — otherwise a concurrent edit/renumber on the source
  // (e.g. a peer-sync merge landing on the loser mid-merge) could interleave and
  // be lost. Acquire in sorted order so a future two-series caller can't deadlock.
  const [first, second] = [fromSeriesId, toSeriesId].sort();
  const body = async () => {
    const state = await readState();
    const now = new Date().toISOString();
    const moved = [];
    for (let i = 0; i < state.issues.length; i += 1) {
      const iss = state.issues[i];
      if (iss.seriesId !== fromSeriesId || iss.deleted) continue;
      const merged = sanitizeIssue({ ...iss, seriesId: toSeriesId, seasonId: null, updatedAt: now });
      if (!merged) continue;
      state.issues[i] = merged;
      moved.push(merged);
    }
    if (moved.length === 0) return { reassigned: 0 };
    await renumberInline(state, toSeriesId, null);
    // Persist every issue now tagged to the survivor (the moved ones + any the
    // survivor already had, whose numbers may have shifted in the renumber).
    await saveIssuesNow(state.issues.filter((i) => i.seriesId === toSeriesId));
    emitRecordUpdated('series', toSeriesId);
    emitRecordUpdated('series', fromSeriesId);
    return { reassigned: moved.length };
  };
  return queueSeriesIssuesWrite(first, () => queueSeriesIssuesWrite(second, body));
}

/**
 * Insert an issue with a caller-supplied id (used by the share-bucket importer
 * so re-imports of the same issue LWW-merge onto the same local row).
 * Throws ERR_DUPLICATE / ERR_VALIDATION on contract violations.
 */
export function insertIssueWithId(input = {}) {
  if (!isStr(input.id) || !ISSUE_ID_RE.test(input.id)) {
    return Promise.reject(makeErr(`insertIssueWithId: invalid id "${input.id}" (expected iss-<uuid>)`, ERR_VALIDATION));
  }
  const seriesId = trimTo(input.seriesId, SERIES_ID_MAX);
  if (!seriesId) return Promise.reject(makeErr('seriesId is required', ERR_VALIDATION));
  const title = trimTo(input.title, TITLE_MAX);
  if (!title) return Promise.reject(makeErr(`title is required (1..${TITLE_MAX} chars)`, ERR_VALIDATION));
  return queueSeriesIssuesWrite(seriesId, async () => {
    const state = await readState();
    // Tombstone-overwrite: same contract as universeBuilder.insertUniverseWithId.
    const existingIdx = state.issues.findIndex((i) => i.id === input.id);
    if (existingIdx >= 0 && !state.issues[existingIdx].deleted) {
      throw makeErr(`Issue id already exists: ${input.id}`, ERR_DUPLICATE);
    }
    const wasResurrection = existingIdx >= 0;
    const next = sanitizeIssue({ ...input, seriesId, title });
    if (!next) throw makeErr('Invalid issue payload', ERR_VALIDATION);
    if (wasResurrection) {
      console.warn(`♻️  insertIssueWithId: overwriting tombstone for ${input.id}`);
      state.issues[existingIdx] = next;
    } else {
      state.issues.push(next);
    }
    // Imported `number` is a starting hint — local canonical numbering still
    // comes from (volume order, arcPosition) of the local state.
    await renumberInline(state, seriesId, next.seasonId || UNSCOPED_ANCHOR);
    await saveIssuesNow(state.issues.filter((i) => i.seriesId === seriesId));
    // Mirror createIssue's federation side-effect on tombstone-overwrite:
    // issues ride series-level events, so notify peers via the parent series.
    if (wasResurrection) emitRecordUpdated('series', next.seriesId);
    return next;
  });
}

function mergeIssuePatch(cur, patch = {}) {
  // Per-stage merge: a stage patch carries only the fields the caller is
  // changing (e.g. `{ genConfig }` or `{ cover }`). Without this, the top-level
  // spread would replace the entire stage object and silently drop sibling
  // fields like `scenes` / `pages` / `genConfig`. Sanitization then defaults
  // those back to empty arrays/null, erasing work the user (or LLM) just did.
  // Callers that need stage-level changes without touching issue-level fields
  // should use `updateStage`, which does a shallow merge of the patch over the
  // existing stage (`{ ...cur.stages[stageId], ...patch }`) before sanitizing.
  //
  // `cover` and `genConfig` are treated as deep-merge sub-objects: a partial
  // `{ cover: { script } }` patch from a textarea-blur save must not wipe the
  // sibling `imageJobId` / `prompt` that a parallel "Render cover" mutation
  // just persisted. Passing `null` explicitly still clears the sub-object.
  const NESTED_DEEP_MERGE_KEYS = ['cover', 'genConfig'];
  let mergedStages = cur.stages;
  if ('stages' in patch && patch.stages && typeof patch.stages === 'object') {
    mergedStages = { ...cur.stages };
    for (const [stageId, stagePatch] of Object.entries(patch.stages)) {
      const prev = cur.stages?.[stageId];
      if (prev && stagePatch && typeof prev === 'object' && typeof stagePatch === 'object') {
        const merged = { ...prev, ...stagePatch };
        merged.runHistory = snapshotRunHistory(prev, stagePatch, stageId);
        for (const key of NESTED_DEEP_MERGE_KEYS) {
          if (key in stagePatch
              && stagePatch[key] && typeof stagePatch[key] === 'object'
              && prev[key] && typeof prev[key] === 'object') {
            merged[key] = { ...prev[key], ...stagePatch[key] };
          }
        }
        if ('status' in stagePatch && stagePatch.status !== 'error'
            && stagePatch.status !== 'generating'
            && !('errorMessage' in stagePatch)) {
          merged.errorMessage = '';
        }
        mergedStages[stageId] = merged;
      } else {
        mergedStages[stageId] = stagePatch;
      }
    }
  }

  const merged = sanitizeIssue({
    ...cur,
    ...('title' in patch ? { title: patch.title } : {}),
    ...('number' in patch ? { number: patch.number } : {}),
    ...('status' in patch ? { status: patch.status } : {}),
    ...('seasonId' in patch ? { seasonId: patch.seasonId } : {}),
    ...('arcPosition' in patch ? { arcPosition: patch.arcPosition } : {}),
    ...('arcRole' in patch ? { arcRole: patch.arcRole } : {}),
    ...('lengthProfile' in patch ? { lengthProfile: patch.lengthProfile } : {}),
    ...('pageTarget' in patch ? { pageTarget: patch.pageTarget } : {}),
    ...('minutesTarget' in patch ? { minutesTarget: patch.minutesTarget } : {}),
    ...('origin' in patch ? { origin: patch.origin } : {}),
    // Local-only "don't sync" marker. Issues piggyback on their parent
    // series' subscription, so an ephemeral issue is dropped from the
    // series push payload via sanitizeRecordForWire returning null.
    ...('ephemeral' in patch ? { ephemeral: patch.ephemeral } : {}),
    stages: mergedStages,
    updatedAt: new Date().toISOString(),
  });
  if (!merged) throw makeErr('Invalid issue payload', ERR_VALIDATION);
  return merged;
}

export function updateIssue(id, patch = {}, { skipRenumber = false } = {}) {
  const needsRenumber = !skipRenumber && ('seasonId' in patch || 'arcPosition' in patch);
  if (!needsRenumber) {
    // Route through the SERIES tail (see updateStageWithLatest) so a plain
    // field update can't race a concurrent series-wide renumber rewriting this
    // issue. seriesId is immutable, so read it outside the lock to pick the
    // queue, then re-read the issue inside.
    return getIssue(id, { includeDeleted: true }).then((existing) =>
      queueSeriesIssuesWrite(existing.seriesId, async () => {
        const cur = await store().loadOne(id);
        if (!cur) throw makeErr(`Issue not found: ${id}`, ERR_NOT_FOUND);
        if (cur.deleted) throw makeErr(`Issue not found: ${id}`, ERR_NOT_FOUND);
        const merged = mergeIssuePatch(cur, patch);
        await saveIssueNow(merged);
        emitRecordUpdated('series', merged.seriesId);
        return merged;
      }),
    );
  }

  return getIssue(id, { includeDeleted: true }).then((existing) =>
    queueSeriesIssuesWrite(existing.seriesId, async () => {
      const state = await readState();
      const idx = state.issues.findIndex((i) => i.id === id);
      if (idx < 0) throw makeErr(`Issue not found: ${id}`, ERR_NOT_FOUND);
      const cur = state.issues[idx];
      if (cur.deleted) throw makeErr(`Issue not found: ${id}`, ERR_NOT_FOUND);
      const merged = mergeIssuePatch(cur, patch);
      state.issues[idx] = merged;
      // A seasonId move affects both source and destination volumes, so full
      // renumber. An arcPosition change only reorders within the current volume.
      if ('seasonId' in patch && cur.seasonId !== merged.seasonId) {
        await renumberInline(state, merged.seriesId, null);
      } else if ('arcPosition' in patch && cur.arcPosition !== merged.arcPosition) {
        await renumberInline(state, merged.seriesId, merged.seasonId || UNSCOPED_ANCHOR);
      }
      await saveIssuesNow(state.issues.filter((i) => i.seriesId === merged.seriesId));
      // Issues are exported as part of their parent series — re-export the
      // series so any active subscription picks up the issue change.
      emitRecordUpdated('series', merged.seriesId);
      return merged;
    })
  );
}

/**
 * Partial update to a single stage on an issue. Use this from generators so
 * a stage write doesn't have to load the full issue, mutate, and re-validate.
 * Patch keys: status, input, output, lastRunId, errorMessage, and (for
 * visual stages) pages/scenes/cdProjectId/videoPath.
 *
 * When the patch depends on the current stage value (e.g. cover preservation),
 * use `updateStageWithLatest` instead so the decision is made against the
 * freshest persisted record inside the serialized write region.
 */
export function updateStage(issueId, stageId, patch = {}) {
  return updateStageWithLatest(issueId, stageId, () => patch);
}

/**
 * Restore a prior `runHistory` snapshot as the active stage state. Looks up the
 * snapshot by `runId` against the freshest persisted record (so a concurrent
 * generate can't make the chosen snapshot disappear out from under the call).
 * The previous active state is itself snapshotted into runHistory by the normal
 * lastRunId-changed trigger in `updateStageWithLatest`, so restore is just
 * another version event — there's no special "rollback" semantics.
 *
 * Resolves with `{ issue, stage }`. Rejects with ERR_VALIDATION when the runId
 * isn't present in the current runHistory.
 */
export function restoreStageFromHistory(issueId, stageId, runId) {
  if (!TEXT_STAGE_IDS.includes(stageId)) {
    return Promise.reject(makeErr(`Stage "${stageId}" does not support history restore`, ERR_VALIDATION));
  }
  if (!isStr(runId) || !runId) {
    return Promise.reject(makeErr('runId is required', ERR_VALIDATION));
  }
  return updateStageWithLatest(issueId, stageId, (cur) => {
    const snapshot = (cur?.runHistory || []).find((entry) => entry.runId === runId);
    if (!snapshot) throw makeErr(`Snapshot not found in stage history: ${runId}`, ERR_VALIDATION);
    return {
      status: 'edited',
      input: snapshot.input || '',
      output: snapshot.output || '',
      lastRunId: snapshot.runId,
      errorMessage: '',
    };
  });
}

export function deleteIssue(id) {
  // Soft-delete — same tombstone-in-record pattern as universes/series. The
  // record stays on disk with `deleted: true` so the next sync propagates the
  // delete to peers; the orchestrator's GC sweep prunes it once all peers ack.
  // `renumberInline` filters tombstones, so surviving issues stay contiguous.
  return getIssue(id, { includeDeleted: true }).then((existing) =>
    queueSeriesIssuesWrite(existing.seriesId, async () => {
      const state = await readState();
      const idx = state.issues.findIndex((i) => i.id === id);
      if (idx < 0) throw makeErr(`Issue not found: ${id}`, ERR_NOT_FOUND);
      const cur = state.issues[idx];
      if (cur.deleted) throw makeErr(`Issue not found: ${id}`, ERR_NOT_FOUND);
      const seriesId = cur.seriesId;
      const now = new Date().toISOString();
      state.issues[idx] = { ...cur, deleted: true, deletedAt: now, updatedAt: now };
      await renumberInline(state, seriesId, cur.seasonId || UNSCOPED_ANCHOR);
      await saveIssuesNow(state.issues.filter((i) => i.seriesId === seriesId));
      // Series export bundles every issue, so a deletion is an update on the
      // parent series for any active share-bucket subscription.
      emitRecordUpdated('series', seriesId);
      return { id };
    })
  );
}

/**
 * Like `updateStage`, but the patch is computed from the *latest* persisted
 * stage inside the serialized write region. Use this when the patch value
 * depends on the current stage state (e.g. cover preservation) so a concurrent
 * write that lands between the outer `getIssue` read and this call is not
 * silently overwritten.
 *
 * `computeFn(currentStage) → patch` — called with the freshest stage record
 * inside the queue; its return value is shallow-merged over the stage exactly
 * as `updateStage` merges a static patch.
 */
export function updateStageWithLatest(issueId, stageId, computeFn, { snapshotPrior = false } = {}) {
  if (!STAGE_IDS.includes(stageId)) {
    // Validate before queueing so the caller gets an immediate rejection
    // rather than waiting in line for an error it already knows about.
    return Promise.reject(makeErr(`Unknown stage: ${stageId}`, ERR_VALIDATION));
  }
  // Serialize on the SERIES tail (not the per-id queue) so a stage save can't
  // interleave with a series-wide renumber/bulk write that rewrites this same
  // issue — both share one mutex per series. The per-record split (migrations
  // 035/036) otherwise left renumbers on the series queue and stage saves on
  // the per-id queue (two independent mutexes over the same shared resource);
  // see CLAUDE.md "single tail per shared file". seriesId is immutable, so read
  // it outside the lock to pick the queue, then re-read the issue INSIDE the
  // lock for the freshest stage.
  const work = async () => {
    const cur = await store().loadOne(issueId);
    if (!cur) throw makeErr(`Issue not found: ${issueId}`, ERR_NOT_FOUND);
    if (cur.deleted) throw makeErr(`Issue not found: ${issueId}`, ERR_NOT_FOUND);
    const isVisual = VISUAL_STAGE_IDS.includes(stageId);
    const isAudio = AUDIO_STAGE_IDS.includes(stageId);
    const currentStage = cur.stages[stageId];
    const patch = computeFn(currentStage);
    // Empty-patch fast path: a computeFn that returns `{}` is a "decided not
    // to write" signal (e.g. stale media-job completion against a re-rendered
    // page). Skip the disk write + emitRecordUpdated so it doesn't trigger
    // a re-export storm in share subscriptions for late no-op events.
    if (isPlainObject(patch) && Object.keys(patch).length === 0) {
      return { issue: cur, stage: currentStage };
    }
    // Snapshot the prior `{ runId, input, output }` into runHistory when this
    // patch carries a fresh lastRunId (i.e. a generate just replaced prior
    // content). Computed BEFORE the spread so it reads pre-merge state.
    const nextRunHistory = snapshotRunHistory(currentStage, patch, stageId, { force: snapshotPrior });
    const merged = {
      ...currentStage,
      ...patch,
      runHistory: nextRunHistory,
      updatedAt: new Date().toISOString(),
    };
    let next;
    if (isVisual) next = sanitizeVisualStage(merged, stageId);
    else if (isAudio) next = sanitizeAudioStage(merged);
    else next = sanitizeTextStage(merged);
    const mergedIssue = sanitizeIssue({
      ...cur,
      stages: { ...cur.stages, [stageId]: next },
      updatedAt: new Date().toISOString(),
    });
    await saveIssueNow(mergedIssue);
    emitRecordUpdated('series', mergedIssue.seriesId);
    return { issue: mergedIssue, stage: mergedIssue.stages[stageId] };
  };
  return getIssue(issueId, { includeDeleted: true }).then((existing) =>
    queueSeriesIssuesWrite(existing.seriesId, work),
  );
}

/**
 * Sync-orchestrator entry point. Merges a remote peer's issues array into
 * local state through the collection store's type-index queue for one
 * consistent merge snapshot. Each incoming record passes through
 * `sanitizeIssue` for shape enforcement (stage statuses, trimmed fields,
 * valid id format). LWW by `updatedAt`; returns `{ applied, count }` where
 * `count` is the number of issues actually changed/added.
 */
export async function mergeIssuesFromSync(remoteIssues) {
  if (!Array.isArray(remoteIssues)) return { applied: false, count: 0 };
  // Series IDs whose issue set saw at least one delete-transition — drives a
  // post-write renumber so the receiver's issue numbering catches up with the
  // sender's (otherwise a synced tombstone would leave a gap).
  //
  // Edit-only merges (no delete-transitions) do NOT emit `recordUpdated` for
  // the parent series — see `mergeUniversesFromSync` for the rationale (the
  // Stage 2 per-record peer-sync push owns sync-time edit emits). Delete-
  // transitions DO emit per series so subscribers know to drop the issue.
  const seriesNeedingRenumber = new Set();
  // Build the set of locally-ephemeral series ids BEFORE the queue. The
  // per-record push pipeline (applyIncomingPush) already gates the bundled
  // issues batch by parent-ephemeral, but the snapshot pipeline path
  // (applyPipelineRemote → mergeIssuesFromSync) bypasses that check. Without
  // this filter, a peer with `pipeline` sync enabled can create/update/
  // tombstone issues under a locally-private series and overwrite the
  // user's private fork.
  const ephemeralSeriesIds = new Set(
    (await seriesSvc.listSeries({ includeDeleted: true }).catch(() => []))
      .filter((s) => s?.ephemeral === true)
      .map((s) => s.id),
  );
  return store().queueTypeIndexWrite(async () => {
    const state = await readState();
    const localById = new Map(state.issues.map((i) => [i.id, i]));
    let changed = 0;
    for (const remote of remoteIssues) {
      if (!remote || typeof remote !== 'object' || !isStr(remote.id)) continue;
      // Drop issues whose parent series is locally ephemeral, BEFORE any
      // mutation. This covers create/update/tombstone uniformly — the
      // sanitized.seriesId may be either the existing local series or a
      // remote-only target; reject either way.
      if (ephemeralSeriesIds.has(remote.seriesId)) continue;
      const sanitized = sanitizeIssue(remote);
      if (!sanitized) continue;
      // Strip inbound `ephemeral` — see mergeUniversesFromSync.
      if ('ephemeral' in sanitized) delete sanitized.ephemeral;
      const local = localById.get(sanitized.id);
      // Belt-and-suspenders: if the existing local issue belongs to an
      // ephemeral series, refuse the merge even though the inbound
      // sanitized.seriesId might point elsewhere (a peer could ship an
      // issue id whose local copy is under a private series and try to
      // move it).
      if (local && ephemeralSeriesIds.has(local.seriesId)) continue;
      if (!local) {
        // No local counterpart — accept the record but don't trigger a
        // renumber pass. A tombstone for an issue we never had has nothing
        // to compact; firing `emitRecordUpdated('series', …)` for a series
        // we may not even own would spuriously re-export.
        localById.set(sanitized.id, sanitized);
        changed++;
      } else if (local.ephemeral === true) {
        // Local-ephemeral issues are immune to inbound merges. See
        // mergeUniversesFromSync for the contract.
        continue;
      } else {
        const localTs = local.updatedAt || '';
        const remoteTs = sanitized.updatedAt || '';
        if (remoteTs > localTs) {
          localById.set(sanitized.id, sanitized);
          // Renumber on EITHER direction of the transition: a delete leaves
          // a gap, a resurrection (deleted→live) reintroduces a previously-
          // compacted number and can collide with live siblings until some
          // unrelated edit triggers a renumber. Cover both here.
          if (sanitized.deleted !== local.deleted) {
            seriesNeedingRenumber.add(sanitized.seriesId);
            // A resurrection may move from the OLD seriesId to a different
            // one in the inbound record (rare, but possible) — renumber both.
            if (local.seriesId && local.seriesId !== sanitized.seriesId) {
              seriesNeedingRenumber.add(local.seriesId);
            }
          }
          changed++;
        }
      }
    }
    if (changed === 0) return { applied: false, count: 0 };
    state.issues = Array.from(localById.values());
    // Compact issue numbers for each affected series — the merge may have
    // tombstoned (gap) or resurrected (collision) an issue. renumberInline
    // skips tombstones, so the resulting numbering is always contiguous
    // across live issues. Single renumber per series, all inside the queue.
    for (const seriesId of seriesNeedingRenumber) {
      await renumberInline(state, seriesId, null);
    }
    await saveIssuesNow(state.issues);
    // Re-emit a series-updated for each touched series so any active share
    // subscription re-exports the post-merge issue set.
    for (const seriesId of seriesNeedingRenumber) {
      emitRecordUpdated('series', seriesId);
    }
    return { applied: true, count: changed };
  });
}

/**
 * Garbage-collect issue tombstones older than `beforeMs`. See
 * `pruneTombstonedUniverses` for the contract — pure mechanical prune; the
 * caller owns the policy. Tombstones with unparseable `deletedAt` are kept.
 *
 * Issue tombstones ride series pushes (the receiver bundles child issues
 * with each series push) so the relevant ack horizon is "peers subscribed
 * to the parent series." The caller resolves that.
 */
export async function pruneTombstonedIssues(beforeMs) {
  if (!Number.isFinite(beforeMs)) return { pruned: 0 };
  return store().queueTypeIndexWrite(async () => {
    const { issues } = await readState();
    const prunable = issues.filter((i) => {
      if (!i?.deleted) return false;
      const t = Date.parse(i.deletedAt || '');
      if (!Number.isFinite(t)) return false;
      return t < beforeMs;
    });
    await Promise.all(prunable.map((i) => store().deleteOne(i.id)));
    return { pruned: prunable.length };
  });
}
