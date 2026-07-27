import { MODEL_SELECTABLE_REVIEWERS } from '../components/cos/constants';

/**
 * Adapters between the two shapes a per-reviewer model pin takes.
 *
 * The Code Review Defaults settings slice persists ONE SCALAR PER REVIEWER
 * (`codexModel`, `claudeModel`, `lmstudioModel`, `ollamaModel`) and stays that way
 * — the encoding crosses installs, so changing it would need a migration for zero
 * gain. Everything else (the ReviewerPicker table, per-task metadata, the slashdo
 * token builders) speaks the token-keyed MAP shape the `~opt` / `~max` controls
 * already use, so the two need one documented conversion point rather than a
 * hand-rolled loop in each consumer.
 *
 * Server mirror: `reviewerModelsFromDefaults` in `server/lib/cosValidation.js`.
 */

/** Scalars → `{ codex: 'gpt-…', ollama: 'qwen…' }`. Blank/absent scalars are omitted. */
export function reviewerModelsFromDefaults(defaults) {
  const out = {};
  for (const reviewer of MODEL_SELECTABLE_REVIEWERS) {
    const model = defaults?.[`${reviewer}Model`];
    if (typeof model === 'string' && model.trim()) out[reviewer] = model.trim();
  }
  return out;
}

/**
 * Map → scalars, for a settings PATCH. EVERY model-selectable reviewer gets a key,
 * so an unpinned one sends `undefined` and the schema's `emptyToUndefined`
 * preprocess CLEARS the stored scalar. Omitting absent keys instead would leave a
 * stale model persisted after the user cleared the field.
 */
export function reviewerModelsToDefaults(models) {
  return Object.fromEntries(
    MODEL_SELECTABLE_REVIEWERS.map((reviewer) => [`${reviewer}Model`, models?.[reviewer] || undefined])
  );
}
