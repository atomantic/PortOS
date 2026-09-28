// Music Video automation brief — client half. Re-exports the server's tool
// catalog (a dependency-free leaf) and owns the form draft ↔ wire mapping.

import { MUSIC_VIDEO_AUTOMATION_TOOLS, MUSIC_VIDEO_AUTOMATION_TOOL_IDS } from '../../../server/lib/musicVideoAutomation.js';

export { MUSIC_VIDEO_AUTOMATION_TOOLS, MUSIC_VIDEO_AUTOMATION_TOOL_IDS };

// Free (local) tools — the default pick for a new autopilot brief, so nothing
// metered is spent until the director opts in.
export const DEFAULT_AUTOMATION_TOOLS = MUSIC_VIDEO_AUTOMATION_TOOLS.filter((t) => !t.metered).map((t) => t.id);

// The draft keeps budget as the raw input string so an empty field reads as
// "no cap" rather than 0.
export const automationDraftFrom = (automation) => ({
  tools: automation?.tools ?? DEFAULT_AUTOMATION_TOOLS,
  guidance: automation?.guidance ?? '',
  budget: automation?.budgetUsd != null ? String(automation.budgetUsd) : '',
});

export const automationFromDraft = (draft) => {
  const budget = Number.parseFloat(draft.budget);
  return {
    tools: draft.tools,
    guidance: draft.guidance.trim(),
    budgetUsd: Number.isFinite(budget) && budget >= 0 ? budget : null,
  };
};
