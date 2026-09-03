import {
  MODEL_SELECTABLE_REVIEWERS,
  MAX_REVIEWER_MODEL_LENGTH,
  EFFORT_SELECTABLE_REVIEWERS,
  reviewerEffortLevels,
  sanitizeReviewerModelInput
} from '../components/cos/constants';

/**
 * Adapters between the two shapes a per-reviewer pin takes — model ids and
 * reasoning-effort tiers alike.
 *
 * The Code Review Defaults settings slice persists ONE SCALAR PER REVIEWER
 * (`codexModel`, `claudeModel`, `lmstudioModel`, `ollamaModel`, and the matching
 * `<reviewer>Effort` scalars) and stays that way — the encoding crosses installs,
 * so changing it would need a migration for zero gain. Everything else (the
 * ReviewerPicker table, per-task metadata, the slashdo token builders) speaks the
 * token-keyed MAP shape the `~opt` / `~max` controls already use, so the two need
 * one documented conversion point rather than a hand-rolled loop in each consumer.
 *
 * Server mirror: `reviewerModelsFromDefaults` / `reviewerEffortsFromDefaults` in
 * `server/lib/reviewerConfig.js`.
 */

/**
 * Build the scalar↔map adapter pair for ONE pin kind. The two pins differ on
 * exactly three axes — which reviewers can carry the pin, the scalar's key
 * suffix, and how a single value is validated — so they're parameters here
 * rather than a second hand-copied pair of loops. Twin of the server's
 * `keyedReviewerPinNormalizer` factory.
 *
 * `fromDefaults` OMITS anything `validateOne` rejects: settings.json is
 * hand-editable and a reviewer's accepted values move with its CLI, so a stored
 * value the server's normalizer would drop must not surface as a pin the picker
 * DISPLAYS but no reviewer ever receives.
 *
 * `toDefaults` gives EVERY reviewer in the roster a key, so an unpinned one
 * sends `undefined` and the schema's `emptyToUndefined` preprocess CLEARS the
 * stored scalar. Omitting absent keys instead would leave a stale value
 * persisted after the user cleared the field.
 *
 * @param {readonly string[]} roster - reviewers that can carry this pin.
 * @param {string} suffix - scalar key suffix (`'Model'` → `codexModel`).
 * @param {(raw: string, reviewer: string) => string|undefined} validateOne
 */
function pinScalarAdapters(roster, suffix, validateOne) {
  return {
    fromDefaults: (defaults) => {
      const out = {};
      for (const reviewer of roster) {
        const raw = defaults?.[`${reviewer}${suffix}`];
        if (typeof raw !== 'string') continue;
        const value = validateOne(raw, reviewer);
        if (value) out[reviewer] = value;
      }
      return out;
    },
    toDefaults: (pins) => Object.fromEntries(
      roster.map((reviewer) => [`${reviewer}${suffix}`, pins?.[reviewer] || undefined])
    )
  };
}

// A model id survives only if it round-trips the sanitizer unchanged — a value
// carrying a structural delimiter (or an over-long one) is what the server's
// token builders would drop.
const modelAdapters = pinScalarAdapters(MODEL_SELECTABLE_REVIEWERS, 'Model', (raw) => {
  const model = sanitizeReviewerModelInput(raw).trim();
  return model && model.length <= MAX_REVIEWER_MODEL_LENGTH && model === raw.trim() ? model : undefined;
});

// An effort is re-checked against that reviewer's OWN ladder, so a level stored
// before the reviewer's CLI dropped it doesn't survive into the picker.
const effortAdapters = pinScalarAdapters(EFFORT_SELECTABLE_REVIEWERS, 'Effort', (raw, reviewer) => {
  const effort = raw.trim().toLowerCase();
  return reviewerEffortLevels(reviewer)?.includes(effort) ? effort : undefined;
});

/** Scalars → `{ codex: 'gpt-…', ollama: 'qwen…' }`. */
export const reviewerModelsFromDefaults = modelAdapters.fromDefaults;

/** Map → scalars, for a settings PATCH. */
export const reviewerModelsToDefaults = modelAdapters.toDefaults;

/** Effort twin: scalars → `{ codex: 'high' }`. */
export const reviewerEffortsFromDefaults = effortAdapters.fromDefaults;

/** Map → scalars, for a settings PATCH. */
export const reviewerEffortsToDefaults = effortAdapters.toDefaults;
