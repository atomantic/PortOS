// Fully-autonomous Music Video — client half. Re-exports the server's stage
// vocabulary and brief normalizer (a dependency-light leaf) and owns the start
// form's draft ↔ wire mapping and the run's display helpers.

import {
  AUTONOMOUS_DEFAULT_LIMITS, AUTONOMOUS_DEFAULT_TOOLS, AUTONOMOUS_LIVE_STATUSES, AUTONOMOUS_SONG_SOURCES, AUTONOMOUS_STAGES,
} from '../../../server/lib/musicVideoAutonomous.js';

export const AUTONOMOUS_SONG_SOURCE_LABELS = Object.freeze({
  suno: 'Suno (PortOS Browser)',
  local: 'Local engine (Music Studio)',
});

export { AUTONOMOUS_CHECKPOINT_IDS, AUTONOMOUS_SONG_SOURCES, autonomousMedium } from '../../../server/lib/musicVideoAutonomous.js';

export const AUTONOMOUS_CHECKPOINT_LABELS = Object.freeze({
  ...Object.fromEntries(AUTONOMOUS_STAGES.map((stage) => [stage.id, stage.label])),
  cast: 'Cast & Sets',
});

export const AUTONOMOUS_STATUS_LABELS = Object.freeze({
  running: 'Running', 'awaiting-approval': 'Waiting for your approval', 'needs-human': 'Needs you', stopped: 'Paused',
  completed: 'Finished', failed: 'Failed', canceled: 'Cancelled',
});

export const emptyAutonomousDraft = () => ({
  prompt: '',
  mediaMode: 'code-images-video',
  songSource: AUTONOMOUS_SONG_SOURCES[0],
  localFallback: false,
  instrumental: false,
  tools: [...AUTONOMOUS_DEFAULT_TOOLS],
  models: {},
  guidance: '',
  budget: '',
  maxGenerations: String(AUTONOMOUS_DEFAULT_LIMITS.maxGenerations),
  checkpoints: [],
  moodBoardId: '',
});

const optionalInt = (raw) => {
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) ? n : undefined;
};

/** The start request for a draft: blank optional fields are omitted so the server defaults apply. */
export function autonomousRequestFromDraft(draft, { providerId, model, effort } = {}) {
  const budget = Number.parseFloat(draft.budget);
  const maxGenerations = optionalInt(draft.maxGenerations);
  const models = Object.fromEntries(Object.entries(draft.models || {})
    .filter(([id, value]) => draft.tools.includes(id) && typeof value === 'string' && value.trim())
    .map(([id, value]) => [id, value.trim()]));
  return {
    prompt: draft.prompt.trim(),
    mediaMode: draft.mediaMode,
    songSource: draft.songSource,
    localFallback: draft.songSource === 'suno' && draft.localFallback === true,
    instrumental: draft.instrumental === true,
    tools: draft.tools,
    ...(Object.keys(models).length ? { models } : {}),
    ...(draft.guidance.trim() ? { guidance: draft.guidance.trim() } : {}),
    budgetUsd: Number.isFinite(budget) && budget >= 0 ? budget : null,
    ...(maxGenerations ? { limits: { maxGenerations } } : {}),
    checkpoints: draft.checkpoints,
    ...(draft.moodBoardId ? { moodBoardId: draft.moodBoardId } : {}),
    ...(providerId ? { providerId, ...(model ? { model } : {}), ...(effort ? { effort } : {}) } : {}),
  };
}

/** One display row per stage of a run: its label, state and (when failed) the error. */
export function autonomousStageRows(run) {
  if (!run) return [];
  return AUTONOMOUS_STAGES.map((stage) => {
    const state = run.stages?.[stage.id] || {};
    const current = run.stage === stage.id;
    return { id: stage.id, label: stage.label, status: state.status || 'pending', current, error: state.error || null, step: state.step || null };
  });
}

/** The stages whose output stays viewable on the run panel, in pipeline order. */
export const AUTONOMOUS_VIEWABLE_STAGES = Object.freeze(['brief', 'lyrics', 'style', 'song']);

/** What the Song stage is doing right now (the server's `stages.song.step`). */
export const AUTONOMOUS_SONG_STEP_LABELS = Object.freeze({
  opening: 'Opening Suno in the PortOS Browser',
  generating: 'Generating the song on Suno',
  exporting: 'Exporting the M4A',
  validating: 'Validating the audio',
  importing: 'Importing into the music library',
});

/**
 * What a completed stage produced, read-only: `[{ key, label, text?, href? }]`
 * (empty when the stage stored nothing). A text field carries `multiline` when
 * it should keep its line breaks (lyrics).
 */
export function autonomousStageOutput(run, stageId) {
  const out = run?.output || {};
  const fields = [];
  const add = (key, label, text, extra = {}) => {
    if (typeof text === 'string' && text.trim()) fields.push({ key, label, text, ...extra });
  };
  if (stageId === 'brief') {
    add('title', 'Title', out.title);
    add('musicalDescription', 'Musical description', out.musicalDescription);
    add('concept', 'Visual concept', out.concept?.prompt);
  } else if (stageId === 'lyrics') {
    add('lyrics', 'Lyrics', out.lyrics, { multiline: true });
  } else if (stageId === 'style') {
    add('sunoStyle', 'Suno style prompt', out.sunoStyle);
    add('conceptStyle', 'Visual style', out.concept?.style);
    if (out.moodBoardId) fields.push({ key: 'moodBoard', label: 'Mood board', href: `/mood-boards/${encodeURIComponent(out.moodBoardId)}`, text: out.moodBoard?.name || 'Open mood board' });
  } else if (stageId === 'song') {
    add('songSource', 'Source', out.songSource ? AUTONOMOUS_SONG_SOURCE_LABELS[out.songSource] || out.songSource : null);
    add('songFallbackReason', 'Why Suno was skipped', out.songFallbackReason);
    add('sunoSongIds', 'Suno song ids', Array.isArray(out.sunoSongIds) ? out.sunoSongIds.join(', ') : null, { mono: true });
  }
  return fields;
}

/** True while the run can still move (or be nudged): the project page keeps its panel prominent. */
export const isAutonomousLive = (run) => !!run && AUTONOMOUS_LIVE_STATUSES.includes(run.status);

/** The Schedule-card form's draft for a saved `taskMetadata.musicVideoAutopilot` (the prompt comes from a Brain idea, so there is none). */
export function autopilotDraftFromParams(params) {
  const p = params && typeof params === 'object' ? params : {};
  const { prompt: _prompt, ...base } = emptyAutonomousDraft();
  return {
    ...base,
    mediaMode: p.mediaMode || base.mediaMode,
    songSource: AUTONOMOUS_SONG_SOURCES.includes(p.songSource) ? p.songSource : base.songSource,
    localFallback: p.localFallback === true,
    instrumental: p.instrumental === true,
    tools: Array.isArray(p.tools) ? [...p.tools] : base.tools,
    models: { ...(p.models || {}) },
    guidance: p.guidance || '',
    budget: p.budgetUsd != null ? String(p.budgetUsd) : '',
    maxGenerations: String(p.limits?.maxGenerations ?? AUTONOMOUS_DEFAULT_LIMITS.maxGenerations),
    checkpoints: Array.isArray(p.checkpoints) ? [...p.checkpoints] : [],
    moodBoardId: p.moodBoardId || '',
    ideaTags: (p.ideaTags || []).join(', '),
  };
}

/**
 * The `musicVideoAutopilot` params a draft saves. Starts from the saved params
 * so fields the form does not edit (review attempts, authoring provider) survive a save; the server re-normalizes it all on write.
 */
export function autopilotParamsFromDraft(draft, saved, { providerId, model, effort } = {}) {
  const { prompt: _prompt, ...request } = autonomousRequestFromDraft({ ...draft, prompt: '' }, {});
  const { llm: _llm, ...kept } = saved && typeof saved === 'object' ? saved : {};
  return {
    ...kept,
    ...request,
    models: request.models || {},
    limits: { ...(kept.limits || {}), ...(request.limits || {}) },
    moodBoardId: draft.moodBoardId || null,
    ideaTags: String(draft.ideaTags || '').split(',').map((t) => t.trim()).filter(Boolean),
    ...(providerId ? { llm: { providerId, model: model || null, ...(effort ? { effort } : {}) } } : {}),
  };
}
