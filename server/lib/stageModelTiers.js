/**
 * The model-tier vocabulary a prompt stage's `model` / `judgeModel` field uses (#8149).
 *
 * The prompt-stage `model`/`judgeModel` tier vocabulary (#8149): `STAGE_MODEL_TIERS` (`default` + the
 * shared MODEL_TIERS), `STAGE_MODEL_TIER_OPTIONS` (the picker rows every stage model select renders),
 * `LEGACY_STAGE_MODEL_TIERS` (`quick`→light, `coding`→medium, still readable from older
 * peers/backups), `canonicalStageModelTier`, `isStageModelTier` (tier vs model-id pin). Pure — the
 * client re-exports it.
 *
 * A stage names either an exact model id (a pin) or one of these tiers, which resolves on whichever
 * provider runs the stage.
 *
 * The tiers are the shared MODEL_TIERS (the same names task metadata,
 * orchestration roles and dispatch labels use) plus `default` — "no tier, use
 * the provider's default model". `quick`/`coding` are the legacy stage
 * spellings of light/medium: migration 409 rewrites stored configs and the
 * pickers write only canonical names, but a config synced from an older peer or
 * restored from a backup can still carry them, so they stay readable forever.
 */

import { MODEL_TIERS } from './aiToolkit/constants.js';

export const STAGE_MODEL_TIERS = Object.freeze(['default', ...Object.values(MODEL_TIERS)]);

export const LEGACY_STAGE_MODEL_TIERS = Object.freeze({ quick: 'light', coding: 'medium' });

/** Picker options, in the order every stage model select shows them. */
export const STAGE_MODEL_TIER_OPTIONS = Object.freeze([
  { value: 'default', label: 'Default', hint: "the active provider's default model" },
  { value: 'light', label: 'Light', hint: "provider's light/fast model" },
  { value: 'medium', label: 'Medium', hint: "provider's medium model" },
  { value: 'heavy', label: 'Heavy', hint: "provider's heavy model" },
  { value: 'ultra', label: 'Ultra', hint: "provider's frontier model" },
].map(Object.freeze));

/** The canonical tier for a stored stage value; anything else passes through. */
export function canonicalStageModelTier(value) {
  return LEGACY_STAGE_MODEL_TIERS[value] || value;
}

/** True for a tier name (canonical or legacy) — false for a model id pin. */
export function isStageModelTier(value) {
  return typeof value === 'string' && STAGE_MODEL_TIERS.includes(canonicalStageModelTier(value));
}
