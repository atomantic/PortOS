// Music Video automation brief — client half. Re-exports the server's tool
// catalog (a dependency-free leaf) and owns the form draft ↔ wire mapping.

import {
  MUSIC_VIDEO_AUTOMATION_TOOLS, MUSIC_VIDEO_AUTOMATION_TOOL_IDS, MUSIC_VIDEO_LLM_STAGES, MUSIC_VIDEO_LLM_STAGE_LABELS, musicVideoLlmRouteLabel,
} from '../../../server/lib/musicVideoAutomation.js';

export { MUSIC_VIDEO_AUTOMATION_TOOLS, MUSIC_VIDEO_AUTOMATION_TOOL_IDS, MUSIC_VIDEO_LLM_STAGES, MUSIC_VIDEO_LLM_STAGE_LABELS };
// `claude-tui · opus · high (TUI)` — one line naming the route a stage ran on.
export const llmRouteLabel = musicVideoLlmRouteLabel;

// Free (local) tools — the default pick for a new autopilot brief, so nothing
// metered is spent until the director opts in.
export const DEFAULT_AUTOMATION_TOOLS = MUSIC_VIDEO_AUTOMATION_TOOLS.filter((t) => !t.metered).map((t) => t.id);

// The direction/planning LLM pin as form strings: '' provider = Auto (an eligible
// TUI provider, else the active one — resolved server-side, see llmRoute.js).
export const EMPTY_LLM_DRAFT = Object.freeze({ providerId: '', model: '', effort: '' });

const llmDraftFrom = (pin) => (pin?.providerId
  ? { providerId: pin.providerId, model: pin.model || '', effort: pin.effort || '' }
  : { ...EMPTY_LLM_DRAFT });
const llmFromDraft = (draft) => ({ providerId: draft.providerId, model: draft.model || null, effort: draft.effort || null });

// The stored per-stage pins as form drafts: `{ [stage]: llmDraft }`, only for pinned stages.
export const llmStagesDraftFrom = (llmStages) => Object.fromEntries(MUSIC_VIDEO_LLM_STAGES
  .filter((stage) => llmStages?.[stage]?.providerId)
  .map((stage) => [stage, llmDraftFrom(llmStages[stage])]));

/**
 * The per-stage pins a draft sends, or undefined when there is nothing to send.
 * Pinned stages carry their pin; with `saved` (the stored map), a stage the
 * director set back to Default is sent as `null` so the server clears it — an
 * absent stage keeps its stored pin.
 */
export function llmStagesFromDraft(draftStages, saved = null) {
  const out = {};
  for (const stage of MUSIC_VIDEO_LLM_STAGES) {
    const draft = draftStages?.[stage];
    if (draft?.providerId) out[stage] = llmFromDraft(draft);
    else if (saved?.[stage]) out[stage] = null;
  }
  return Object.keys(out).length ? out : undefined;
}

// The draft keeps budget as the raw input string so an empty field reads as
// "no cap" rather than 0.
export const automationDraftFrom = (automation) => ({
  tools: automation?.tools ?? DEFAULT_AUTOMATION_TOOLS,
  guidance: automation?.guidance ?? '',
  budget: automation?.budgetUsd != null ? String(automation.budgetUsd) : '',
  // The Cast & Sets check-in stops the autopilot for review unless auto-approved.
  castAndSetsCheckin: automation?.checkins?.castAndSets === 'auto' ? 'auto' : 'review',
  llm: llmDraftFrom(automation?.llm),
  llmStages: llmStagesDraftFrom(automation?.llmStages),
});

// `saved` (the stored brief) lets a stage set back to Default clear its stored pin.
export const automationFromDraft = (draft, saved = null) => {
  const budget = Number.parseFloat(draft.budget);
  const llmStages = llmStagesFromDraft(draft.llmStages, saved?.llmStages);
  return {
    tools: draft.tools,
    guidance: draft.guidance.trim(),
    budgetUsd: Number.isFinite(budget) && budget >= 0 ? budget : null,
    checkins: { castAndSets: draft.castAndSetsCheckin === 'auto' ? 'auto' : 'review' },
    // Absent when Auto. Clearing a SAVED pin back to Auto is the caller's `llm: null` (the
    // server keeps a stored pin when the key is absent), so a create payload stays unchanged.
    ...(draft.llm?.providerId ? { llm: llmFromDraft(draft.llm) } : {}),
    ...(llmStages ? { llmStages } : {}),
  };
};

