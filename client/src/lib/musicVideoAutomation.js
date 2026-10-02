// Music Video automation brief — client half. Re-exports the server's tool
// catalog (a dependency-free leaf) and owns the form draft ↔ wire mapping.

import { MUSIC_VIDEO_AUTOMATION_TOOLS, MUSIC_VIDEO_AUTOMATION_TOOL_IDS, musicVideoLlmRouteLabel } from '../../../server/lib/musicVideoAutomation.js';

export { MUSIC_VIDEO_AUTOMATION_TOOLS, MUSIC_VIDEO_AUTOMATION_TOOL_IDS };
// `claude-tui · opus · high (TUI)` — one line naming the route a stage ran on.
export const llmRouteLabel = musicVideoLlmRouteLabel;

// Free (local) tools — the default pick for a new autopilot brief, so nothing
// metered is spent until the director opts in.
export const DEFAULT_AUTOMATION_TOOLS = MUSIC_VIDEO_AUTOMATION_TOOLS.filter((t) => !t.metered).map((t) => t.id);

// The direction/planning LLM pin as form strings: '' provider = Auto (an eligible
// TUI provider, else the active one — resolved server-side, see llmRoute.js).
export const EMPTY_LLM_DRAFT = Object.freeze({ providerId: '', model: '', effort: '' });

// The draft keeps budget as the raw input string so an empty field reads as
// "no cap" rather than 0.
export const automationDraftFrom = (automation) => ({
  tools: automation?.tools ?? DEFAULT_AUTOMATION_TOOLS,
  guidance: automation?.guidance ?? '',
  budget: automation?.budgetUsd != null ? String(automation.budgetUsd) : '',
  // The Cast & Sets check-in stops the autopilot for review unless auto-approved.
  castAndSetsCheckin: automation?.checkins?.castAndSets === 'auto' ? 'auto' : 'review',
  llm: automation?.llm?.providerId
    ? { providerId: automation.llm.providerId, model: automation.llm.model || '', effort: automation.llm.effort || '' }
    : { ...EMPTY_LLM_DRAFT },
});

export const automationFromDraft = (draft) => {
  const budget = Number.parseFloat(draft.budget);
  return {
    tools: draft.tools,
    guidance: draft.guidance.trim(),
    budgetUsd: Number.isFinite(budget) && budget >= 0 ? budget : null,
    checkins: { castAndSets: draft.castAndSetsCheckin === 'auto' ? 'auto' : 'review' },
    // Absent when Auto. Clearing a SAVED pin back to Auto is the caller's `llm: null` (the
    // server keeps a stored pin when the key is absent), so a create payload stays unchanged.
    ...(draft.llm?.providerId
      ? { llm: { providerId: draft.llm.providerId, model: draft.llm.model || null, effort: draft.llm.effort || null } }
      : {}),
  };
};

