/**
 * FableLoom record caps — the single source of truth shared by the sanitizer
 * (`records.js`, enforcement) and the route schemas
 * (`server/lib/fableLoomValidation.js`, door check). A leaf module so the lib
 * barrel doesn't transitively load the universe/series service graph.
 */

export const LOOM_LIMITS = Object.freeze({
  NAME_MAX: 200,
  LOGLINE_MAX: 500,
  PREMISE_MAX: 20000,
  STYLE_NOTES_MAX: 4000,
  REF_ID_MAX: 64,
  EPISODES_MAX: 100,
  EPISODE_TITLE_MAX: 300,
  SYNOPSIS_MAX: 4000,
  FEEDBACK_MAX: 4000,
  NODES_MAX: 200,
  NODE_TITLE_MAX: 300,
  PROSE_MAX: 20000,
  IMAGE_PROMPT_MAX: 2000,
  ENDING_LABEL_MAX: 200,
  TRANSITIONS_MAX: 12,
  INTENT_MAX: 120,
  TRIGGER_MAX: 160,
  TRIGGERS_MAX: 8,
  TRANSITION_DESC_MAX: 500,
});
