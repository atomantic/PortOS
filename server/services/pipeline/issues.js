/**
 * Pipeline — Issues Service
 *
 * An Issue (or Episode — same record, two formats) is a child of a Series and
 * carries the full per-stage state of one production pipeline run:
 *
 *   stages.idea         — beat sheet from the rough human seed
 *   stages.prose        — short-story draft
 *   stages.comicScript  — page/panel script (one of two parallel script stages)
 *   stages.tvScript     — scene-by-scene teleplay (the other parallel script stage)
 *   stages.comicPages   — image-gen output for each comic page's panels
 *   stages.storyboards  — image-gen + per-scene video output via CD scene runner
 *   stages.episodeVideo — final stitched episode video via CD
 *
 * Each stage record carries a status, the user-editable input, the AI output,
 * and a `lastRunId` pointer into data/runs/<runId>/ for the LLM transcript.
 *
 * Persisted to data/pipeline-issues.json.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, atomicWrite, readJSONFile, ensureDir } from '../../lib/fileUtils.js';
import {
  LENGTH_PROFILE_NAMES, DEFAULT_LENGTH_PROFILE,
  CUSTOM_PAGE_MIN, CUSTOM_PAGE_MAX, CUSTOM_MINUTE_MIN, CUSTOM_MINUTE_MAX,
} from '../../lib/issueLength.js';

// Lazy resolution — see series.js for context.
const statePath = () => join(PATHS.data, 'pipeline-issues.json');

export const ERR_NOT_FOUND = 'PIPELINE_ISSUE_NOT_FOUND';
export const ERR_VALIDATION = 'PIPELINE_ISSUE_VALIDATION';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

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

// Stage IDs are ordered for UI display; the canonical order is also the
// auto-run text-chain order (idea → prose → scripts in parallel). Comic
// pages / storyboards / episode video stages are visual and stay manual
// in MVP.
export const TEXT_STAGE_IDS = Object.freeze(['idea', 'prose', 'comicScript', 'tvScript']);
export const VISUAL_STAGE_IDS = Object.freeze(['comicPages', 'storyboards', 'episodeVideo']);
export const STAGE_IDS = Object.freeze([...TEXT_STAGE_IDS, ...VISUAL_STAGE_IDS]);
export const STAGE_STATUSES = Object.freeze(['empty', 'generating', 'ready', 'edited', 'needs-review', 'error']);
export const ISSUE_STATUSES = Object.freeze(['draft', 'running', 'needs-review', 'shipped']);

const isStr = (v) => typeof v === 'string';
const trimTo = (v, max) => (isStr(v) ? v.trim().slice(0, max) : '');

const emptyStage = () => ({
  status: 'empty',
  input: '',
  output: '',
  lastRunId: null,
  errorMessage: '',
  updatedAt: null,
});

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
  };
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
const IMAGE_MODE_VALUES = new Set(['auto', 'local', 'codex']);
const GEN_CONFIG_STR_MAX = 200;
const sanitizeGenConfig = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const imageMode = IMAGE_MODE_VALUES.has(raw.imageMode) ? raw.imageMode : 'auto';
  const imageModelId = trimTo(raw.imageModelId, GEN_CONFIG_STR_MAX) || null;
  const refineProvider = trimTo(raw.refineProvider, GEN_CONFIG_STR_MAX) || null;
  const refineModel = trimTo(raw.refineModel, GEN_CONFIG_STR_MAX) || null;
  if (imageMode === 'auto' && !imageModelId && !refineProvider && !refineModel) {
    return null;
  }
  return { imageMode, imageModelId, refineProvider, refineModel };
};

const COVER_SCRIPT_MAX = 8000;
const COVER_PROMPT_MAX = 16_000;
const sanitizeCover = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const script = trimTo(raw.script, COVER_SCRIPT_MAX);
  const imageJobId = isStr(raw.imageJobId) && raw.imageJobId ? raw.imageJobId : null;
  const prompt = trimTo(raw.prompt, COVER_PROMPT_MAX);
  if (!script && !imageJobId && !prompt) return null;
  return { script, imageJobId, prompt: prompt || null };
};

const sanitizeVisualStage = (raw, stageId = null) => {
  // Visual stages keep arbitrary structured artifact lists. Sanitize the
  // wrapper but pass through known shapes.
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
    // `cover` is meaningful only on comicPages — it carries the front-cover
    // concept + render job. Dropping it on storyboards / episodeVideo makes
    // the contract explicit (matches the comment in pipeline.js's visual
    // stage schema). When stageId is omitted (legacy callers / stage-shape
    // sanitize at issue load time without per-stage context), keep the
    // field — `sanitizeStages` below threads the stageId through so the
    // canonical persistence path enforces the rule.
    cover: stageId === null || stageId === 'comicPages' ? sanitizeCover(raw?.cover) : null,
  };
};

const sanitizeStages = (raw = {}) => {
  const out = {};
  for (const id of TEXT_STAGE_IDS) out[id] = sanitizeStage(raw[id]);
  for (const id of VISUAL_STAGE_IDS) out[id] = sanitizeVisualStage(raw[id], id);
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
    ? Math.max(CUSTOM_PAGE_MIN, Math.min(CUSTOM_PAGE_MAX, Math.floor(raw.pageTarget)))
    : null;
  const minutesTarget = Number.isFinite(raw.minutesTarget)
    ? Math.max(CUSTOM_MINUTE_MIN, Math.min(CUSTOM_MINUTE_MAX, Math.floor(raw.minutesTarget)))
    : null;
  return {
    id: raw.id,
    seriesId: trimTo(raw.seriesId, SERIES_ID_MAX),
    number,
    title,
    status,
    seasonId,
    arcPosition,
    lengthProfile,
    pageTarget,
    minutesTarget,
    stages: sanitizeStages(raw.stages || {}),
    createdAt,
    updatedAt,
  };
};

async function readState() {
  await ensureDir(PATHS.data);
  const raw = await readJSONFile(statePath(), { issues: [] }, { logError: false });
  const issues = Array.isArray(raw.issues) ? raw.issues.map(sanitizeIssue).filter(Boolean) : [];
  return { issues };
}

async function writeState(state) {
  await atomicWrite(statePath(), state);
}

export async function listIssues({ seriesId = null } = {}) {
  const { issues } = await readState();
  const filtered = seriesId ? issues.filter((i) => i.seriesId === seriesId) : issues;
  return [...filtered]
    .sort((a, b) => {
      if (a.seriesId !== b.seriesId) return a.seriesId.localeCompare(b.seriesId);
      return (a.number || 0) - (b.number || 0);
    })
    .slice(0, ISSUES_PER_RESPONSE_MAX);
}

/**
 * Recently-updated issues across all series. Sorts the FULL issue set by
 * `updatedAt` desc before applying `limit` — unlike `listIssues`, which
 * sorts by `seriesId/number` then caps at `ISSUES_PER_RESPONSE_MAX`. That
 * cap would silently miss the most-recent issues once the dataset grows
 * beyond 1000, so the sidebar's recent-issues view needs this dedicated
 * helper.
 */
export async function listRecentIssues({ limit = 10 } = {}) {
  const { issues } = await readState();
  // Coerce in two passes so non-finite inputs ('abc', undefined) fall to
  // the default rather than letting JS's `0 || 10` short-circuit return
  // 10 for an explicit limit=0.
  const raw = Number(limit);
  const fallback = Number.isFinite(raw) ? Math.floor(raw) : 10;
  const clamped = Math.max(1, Math.min(50, fallback));
  return [...issues]
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .slice(0, clamped);
}

export async function getIssue(id) {
  const { issues } = await readState();
  const found = issues.find((i) => i.id === id);
  if (!found) throw makeErr(`Issue not found: ${id}`, ERR_NOT_FOUND);
  return found;
}

export async function createIssue(input = {}) {
  const seriesId = trimTo(input.seriesId, SERIES_ID_MAX);
  if (!seriesId) throw makeErr('seriesId is required', ERR_VALIDATION);
  const title = trimTo(input.title, TITLE_MAX);
  if (!title) throw makeErr(`title is required (1..${TITLE_MAX} chars)`, ERR_VALIDATION);
  const state = await readState();
  const next = sanitizeIssue({
    id: `iss-${randomUUID()}`,
    seriesId,
    number: input.number || nextIssueNumber(state.issues, seriesId),
    title,
    status: 'draft',
    // Phase 2: optional arc pointers passed by the season-episodes generator
    // (and any future caller wiring an issue to a season at create time).
    seasonId: 'seasonId' in input ? input.seasonId : null,
    arcPosition: 'arcPosition' in input ? input.arcPosition : null,
    lengthProfile: 'lengthProfile' in input ? input.lengthProfile : undefined,
    pageTarget: 'pageTarget' in input ? input.pageTarget : null,
    minutesTarget: 'minutesTarget' in input ? input.minutesTarget : null,
    stages: input.stages || {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  if (!next) throw makeErr('Invalid issue payload', ERR_VALIDATION);
  state.issues.push(next);
  await writeState(state);
  return next;
}

function nextIssueNumber(issues, seriesId) {
  const peers = issues.filter((i) => i.seriesId === seriesId);
  if (peers.length === 0) return 1;
  return Math.max(...peers.map((i) => i.number || 0)) + 1;
}

export async function updateIssue(id, patch = {}) {
  const state = await readState();
  const idx = state.issues.findIndex((i) => i.id === id);
  if (idx < 0) throw makeErr(`Issue not found: ${id}`, ERR_NOT_FOUND);
  const cur = state.issues[idx];

  // Per-stage merge: a stage patch carries only the fields the caller is
  // changing (e.g. `{ genConfig }` or `{ cover }`). Without this, the top-level
  // spread would replace the entire stage object and silently drop sibling
  // fields like `scenes` / `pages` / `genConfig`. Sanitization then defaults
  // those back to empty arrays/null, erasing work the user (or LLM) just did.
  // Callers that need a wholesale stage replacement should use `updateStage`,
  // which writes the full sanitized stage in one shot.
  let mergedStages = cur.stages;
  if ('stages' in patch && patch.stages && typeof patch.stages === 'object') {
    mergedStages = { ...cur.stages };
    for (const [stageId, stagePatch] of Object.entries(patch.stages)) {
      const prev = cur.stages?.[stageId];
      if (prev && stagePatch && typeof prev === 'object' && typeof stagePatch === 'object') {
        mergedStages[stageId] = { ...prev, ...stagePatch };
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
    ...('lengthProfile' in patch ? { lengthProfile: patch.lengthProfile } : {}),
    ...('pageTarget' in patch ? { pageTarget: patch.pageTarget } : {}),
    ...('minutesTarget' in patch ? { minutesTarget: patch.minutesTarget } : {}),
    stages: mergedStages,
    updatedAt: new Date().toISOString(),
  });
  if (!merged) throw makeErr('Invalid issue payload', ERR_VALIDATION);
  state.issues[idx] = merged;
  await writeState(state);
  return merged;
}

/**
 * Partial update to a single stage on an issue. Use this from generators so
 * a stage write doesn't have to load the full issue, mutate, and re-validate.
 * Patch keys: status, input, output, lastRunId, errorMessage, and (for
 * visual stages) pages/scenes/cdProjectId/videoPath.
 */
export async function updateStage(issueId, stageId, patch = {}) {
  if (!STAGE_IDS.includes(stageId)) {
    throw makeErr(`Unknown stage: ${stageId}`, ERR_VALIDATION);
  }
  const state = await readState();
  const idx = state.issues.findIndex((i) => i.id === issueId);
  if (idx < 0) throw makeErr(`Issue not found: ${issueId}`, ERR_NOT_FOUND);
  const cur = state.issues[idx];
  const isVisual = VISUAL_STAGE_IDS.includes(stageId);
  const merged = {
    ...cur.stages[stageId],
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  const next = isVisual ? sanitizeVisualStage(merged, stageId) : sanitizeStage(merged);
  const mergedIssue = sanitizeIssue({
    ...cur,
    stages: { ...cur.stages, [stageId]: next },
    updatedAt: new Date().toISOString(),
  });
  state.issues[idx] = mergedIssue;
  await writeState(state);
  return { issue: mergedIssue, stage: mergedIssue.stages[stageId] };
}

export async function deleteIssue(id) {
  const state = await readState();
  const before = state.issues.length;
  state.issues = state.issues.filter((i) => i.id !== id);
  if (state.issues.length === before) throw makeErr(`Issue not found: ${id}`, ERR_NOT_FOUND);
  await writeState(state);
  return { id };
}
