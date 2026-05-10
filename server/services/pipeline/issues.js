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

const STATE_PATH = join(PATHS.data, 'pipeline-issues.json');

export const ERR_NOT_FOUND = 'PIPELINE_ISSUE_NOT_FOUND';
export const ERR_VALIDATION = 'PIPELINE_ISSUE_VALIDATION';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

export const TITLE_MAX = 300;
export const SERIES_ID_MAX = 64;
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

const sanitizeVisualStage = (raw) => {
  // Visual stages keep arbitrary structured artifact lists. Sanitize the
  // wrapper but pass through known shapes.
  const base = sanitizeStage(raw);
  return {
    ...base,
    pages: Array.isArray(raw?.pages) ? raw.pages.slice(0, 200) : [],
    scenes: Array.isArray(raw?.scenes) ? raw.scenes.slice(0, 200) : [],
    cdProjectId: isStr(raw?.cdProjectId) && raw.cdProjectId ? raw.cdProjectId : null,
    videoPath: isStr(raw?.videoPath) && raw.videoPath ? raw.videoPath : null,
  };
};

const sanitizeStages = (raw = {}) => {
  const out = {};
  for (const id of TEXT_STAGE_IDS) out[id] = sanitizeStage(raw[id]);
  for (const id of VISUAL_STAGE_IDS) out[id] = sanitizeVisualStage(raw[id]);
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
  return {
    id: raw.id,
    seriesId: trimTo(raw.seriesId, SERIES_ID_MAX),
    number,
    title,
    status,
    stages: sanitizeStages(raw.stages || {}),
    createdAt,
    updatedAt,
  };
};

async function readState() {
  await ensureDir(PATHS.data);
  const raw = await readJSONFile(STATE_PATH, { issues: [] }, { logError: false });
  const issues = Array.isArray(raw.issues) ? raw.issues.map(sanitizeIssue).filter(Boolean) : [];
  return { issues };
}

async function writeState(state) {
  await atomicWrite(STATE_PATH, state);
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

  const mergedStages = 'stages' in patch
    ? { ...cur.stages, ...(patch.stages || {}) }
    : cur.stages;

  const merged = sanitizeIssue({
    ...cur,
    ...('title' in patch ? { title: patch.title } : {}),
    ...('number' in patch ? { number: patch.number } : {}),
    ...('status' in patch ? { status: patch.status } : {}),
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
  const sanitize = isVisual ? sanitizeVisualStage : sanitizeStage;
  const next = sanitize({
    ...cur.stages[stageId],
    ...patch,
    updatedAt: new Date().toISOString(),
  });
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
