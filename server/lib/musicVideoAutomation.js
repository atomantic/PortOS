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

import {
  CLOUD_IMAGE_GEN_MODES, CLOUD_VIDEO_GEN_MODES, IMAGE_GEN_MODE, IMAGE_GEN_MODES, VIDEO_GEN_MODE, VIDEO_GEN_MODES,
} from './generationModes.js';

// Display names only; a backend with no entry falls back to its mode id.
const IMAGE_TOOL_LABELS = {
  [IMAGE_GEN_MODE.LOCAL]: 'Local image gen',
  [IMAGE_GEN_MODE.CODEX]: 'Codex image gen',
  [IMAGE_GEN_MODE.GROK]: 'Grok image gen',
  [IMAGE_GEN_MODE.AGY]: 'Antigravity image gen',
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
export const MUSIC_VIDEO_AUTOMATION_BUDGET_MAX_USD = 100000;

/**
 * Merge a validated automation patch onto the stored brief. Sub-fields merge
 * (a guidance edit cannot drop the tool list); `tools` replaces its list whole,
 * de-duplicated in catalog order. `budgetUsd: null` means "no cap".
 */
export function normalizeMusicVideoAutomation(patch, current = null) {
  const merged = { ...(current || {}), ...(patch || {}) };
  const picked = new Set(Array.isArray(merged.tools) ? merged.tools : []);
  const budget = Number(merged.budgetUsd);
  return {
    tools: MUSIC_VIDEO_AUTOMATION_TOOL_IDS.filter((id) => picked.has(id)),
    guidance: typeof merged.guidance === 'string' ? merged.guidance.slice(0, MUSIC_VIDEO_AUTOMATION_GUIDANCE_MAX) : '',
    budgetUsd: merged.budgetUsd != null && Number.isFinite(budget) && budget >= 0
      ? Math.min(budget, MUSIC_VIDEO_AUTOMATION_BUDGET_MAX_USD) : null,
  };
}
