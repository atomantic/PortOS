/**
 * Music Video automation brief — the tool catalog an automation-first project
 * is allowed to spend on, plus the brief normalizer.
 *
 * A dependency-free leaf (the client's create drawer and automation panel
 * import it directly, like navManifest.js) so the tool alphabet cannot drift
 * between the picker and the server schema. Image/video tool ids derive from
 * the render-backend alphabets in generationModes.js and `metered` from its
 * cloud (remote-quota) lists, so a backend added there reaches the picker —
 * correctly flagged — in the same commit; `code:render` is the code-rendered
 * pass (typography, composition layers, procedural frames).
 */

import { EFFORT_LEVELS } from './providerModels.js';
import { trimTo } from './textUtils.js';
import {
  CLOUD_IMAGE_GEN_MODES, CLOUD_VIDEO_GEN_MODES, IMAGE_GEN_MODE, IMAGE_GEN_MODES, VIDEO_GEN_MODE, VIDEO_GEN_MODES,
} from './generationModes.js';

// Display names only; a backend with no entry falls back to its mode id.
const IMAGE_TOOL_LABELS = {
  [IMAGE_GEN_MODE.LOCAL]: 'Local image gen',
  [IMAGE_GEN_MODE.CODEX]: 'Codex image gen',
  [IMAGE_GEN_MODE.GROK]: 'Grok image gen',
  [IMAGE_GEN_MODE.AGY]: 'Antigravity image gen',
  [IMAGE_GEN_MODE.FAL]: 'fal.ai image gen',
  [IMAGE_GEN_MODE.EXTERNAL]: 'External SD API',
};
const VIDEO_TOOL_LABELS = {
  [VIDEO_GEN_MODE.LOCAL]: 'Local video gen',
  [VIDEO_GEN_MODE.GROK]: 'Grok video',
  [VIDEO_GEN_MODE.FAL]: 'fal.ai video',
  [VIDEO_GEN_MODE.REACTOR]: 'Reactor video',
};

// Metered = spends money or remote quota (the cloud lists); the budget cap is
// meaningful only for these. Local backends cost electricity, not dollars.
const toolsFor = (group, modes, labels, cloud) => modes.map((mode) => ({
  id: `${group}:${mode}`, group, label: labels[mode] || `${mode} ${group}`, metered: cloud.includes(mode),
}));

export const MUSIC_VIDEO_AUTOMATION_TOOLS = Object.freeze([
  ...toolsFor('image', IMAGE_GEN_MODES, IMAGE_TOOL_LABELS, CLOUD_IMAGE_GEN_MODES),
  ...toolsFor('video', VIDEO_GEN_MODES, VIDEO_TOOL_LABELS, CLOUD_VIDEO_GEN_MODES),
  { id: 'code:render', group: 'code', label: 'Render with code', metered: false },
].map((tool) => Object.freeze(tool)));

export const MUSIC_VIDEO_AUTOMATION_TOOL_IDS = Object.freeze(MUSIC_VIDEO_AUTOMATION_TOOLS.map((t) => t.id));

export const MUSIC_VIDEO_AUTOMATION_GUIDANCE_MAX = 8000;
// Check-in gates the autopilot stops at. `review` (the default) waits for the
// director; `auto` approves the step and continues.
export const MUSIC_VIDEO_CHECKIN_MODES = Object.freeze(['review', 'auto']);
export const MUSIC_VIDEO_AUTOMATION_BUDGET_MAX_USD = 100000;
// The LLM text stages a director may route to their own provider/model/effort
// (`automation.llmStages`). An unpinned stage uses the direction pin (`llm`).
// `brief` / `lyrics` / `lyricsReview` run inside an autonomous run; `castAndSets`,
// `plan` and `authoring` run for every automation-first project.
export const MUSIC_VIDEO_LLM_STAGES = Object.freeze(['brief', 'lyrics', 'lyricsReview', 'castAndSets', 'plan', 'authoring']);
export const MUSIC_VIDEO_LLM_STAGE_LABELS = Object.freeze({
  brief: 'Creative brief',
  lyrics: 'Lyrics draft',
  lyricsReview: 'Lyrics review & revise',
  castAndSets: 'Cast & sets direction',
  plan: 'Shot plan',
  authoring: 'Code authoring',
});
// Stages that record the effective LLM route they last ran on (#9545): every LLM stage.
export const MUSIC_VIDEO_AUTOMATION_ROUTE_STAGES = MUSIC_VIDEO_LLM_STAGES;
export const MUSIC_VIDEO_LLM_TRANSPORTS = Object.freeze(['tui', 'cli', 'api']);
// pinned = the request named it; stage = the brief's pin for that stage did;
// brief = the saved brief's direction pin did; tui-preferred = nothing was
// pinned so an eligible TUI provider was chosen; active = the install's active
// provider (no eligible TUI).
export const MUSIC_VIDEO_LLM_ROUTE_SOURCES = Object.freeze(['pinned', 'stage', 'brief', 'tui-preferred', 'active']);

/** A reasoning-effort level the runner accepts, else null (the runner clamps it per provider). */
export const normalizeMusicVideoEffort = (value) => (EFFORT_LEVELS.includes(value) ? value : null);

/**
 * The direction/planning LLM the brief pins (#9545): provider, optional model
 * and optional reasoning effort. Returns null when no provider is pinned — the
 * stages then prefer an eligible TUI provider (see services/musicVideo/llmRoute.js).
 * A model or effort with no provider is dropped: neither is meaningful alone.
 */
export function normalizeMusicVideoLlm(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const providerId = trimTo(raw.providerId, 200);
  if (!providerId) return null;
  return {
    providerId,
    model: trimTo(raw.model, 200) || null,
    effort: normalizeMusicVideoEffort(raw.effort),
  };
}

/**
 * Per-stage LLM pins: `{ [stage]: { providerId, model, effort } }`, keeping
 * only known stages whose pin normalizes. Null when no stage is pinned.
 */
export function normalizeMusicVideoLlmStages(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const stages = {};
  for (const stage of MUSIC_VIDEO_LLM_STAGES) {
    const pin = normalizeMusicVideoLlm(raw[stage]);
    if (pin) stages[stage] = pin;
  }
  return Object.keys(stages).length ? stages : null;
}

/** The effective LLM route a stage last ran on, as stored for the project summary. */
function normalizeMusicVideoLlmRoute(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const providerId = trimTo(raw.providerId, 200);
  if (!providerId) return null;
  const text = (v, max) => trimTo(v, max) || null;
  return {
    providerId,
    model: text(raw.model, 200),
    effort: normalizeMusicVideoEffort(raw.effort),
    transport: MUSIC_VIDEO_LLM_TRANSPORTS.includes(raw.transport) ? raw.transport : null,
    source: MUSIC_VIDEO_LLM_ROUTE_SOURCES.includes(raw.source) ? raw.source : null,
    // A saved pin whose provider no longer resolved: what the run replaced.
    ...(text(raw.requestedProviderId, 200) ? { requestedProviderId: text(raw.requestedProviderId, 200) } : {}),
    at: text(raw.at, 40),
  };
}

/** One line naming the route a stage ran on: `claude-tui · opus · high (TUI)`. */
export const musicVideoLlmRouteLabel = (route) => (route?.providerId
  ? `${route.providerId}${route.model ? ` · ${route.model}` : ''}${route.effort ? ` · ${route.effort}` : ''}${route.transport ? ` (${route.transport.toUpperCase()})` : ''}`
  : 'no provider');

/**
 * Merge a validated automation patch onto the stored brief. Sub-fields merge
 * (a guidance edit cannot drop the tool list); `tools` replaces its list whole,
 * de-duplicated in catalog order. `budgetUsd: null` means "no cap".
 * `checkins` merges per gate; an unknown or absent gate is `review`.
 * `llm` (#9545): absent keeps the stored pin, `null` clears it. `llmStages`
 * merges per stage: an absent stage keeps its stored pin, a stage set to `null`
 * clears it (back to the direction pin), and `llmStages: null` clears them all.
 * `routes` (the
 * effective route each stage last ran on) is server-written: only the stored
 * record's value survives — a patch can never set it.
 */
export function normalizeMusicVideoAutomation(patch, current = null) {
  const merged = { ...(current || {}), ...(patch || {}) };
  const picked = new Set(Array.isArray(merged.tools) ? merged.tools : []);
  const budget = Number(merged.budgetUsd);
  const routes = {};
  for (const stage of MUSIC_VIDEO_AUTOMATION_ROUTE_STAGES) {
    const route = normalizeMusicVideoLlmRoute(current?.routes?.[stage]);
    if (route) routes[stage] = route;
  }
  const llm = normalizeMusicVideoLlm(merged.llm);
  const llmStages = normalizeMusicVideoLlmStages(patch?.llmStages === null ? null : {
    ...(current?.llmStages && typeof current.llmStages === 'object' ? current.llmStages : {}),
    ...(patch?.llmStages && typeof patch.llmStages === 'object' ? patch.llmStages : {}),
  });
  return {
    tools: MUSIC_VIDEO_AUTOMATION_TOOL_IDS.filter((id) => picked.has(id)),
    guidance: typeof merged.guidance === 'string' ? merged.guidance.slice(0, MUSIC_VIDEO_AUTOMATION_GUIDANCE_MAX) : '',
    budgetUsd: merged.budgetUsd != null && Number.isFinite(budget) && budget >= 0
      ? Math.min(budget, MUSIC_VIDEO_AUTOMATION_BUDGET_MAX_USD) : null,
    checkins: {
      castAndSets: ({ ...(current?.checkins || {}), ...(patch?.checkins || {}) }).castAndSets === 'auto' ? 'auto' : 'review',
    },
    ...(llm ? { llm } : {}),
    ...(llmStages ? { llmStages } : {}),
    ...(Object.keys(routes).length ? { routes } : {}),
  };
}
