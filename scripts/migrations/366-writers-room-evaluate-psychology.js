/**
 * Name the psychology profile and the Three Sliders in the Writers Room
 * evaluate prompt (#6417).
 *
 * `pickCharacterFramework` began projecting `psychology` and `sliders` into the
 * author-side review payload, but the template's prose still enumerated only
 * the Ghost → Wound → Lie → Need → Want chain — so a reader following the
 * instructions had no idea what the extra JSON keys were, and no ruling on how
 * to read them. This adds that sentence plus the one rule the projection makes
 * necessary: an absent field was left blank on purpose, and a `psychology`
 * ruled `unknown` / `not-applicable` is an authoring decision rather than a gap
 * to report as a defect.
 *
 * Copy-only — no variables changed, so an install still on the previous shipped
 * template keeps working either way; this just stops the prose from describing
 * half the payload.
 */
import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  "writers-room-evaluate.md": [
    "d3b2b40bcabc9ca690fa67b69d64d628"
  ]
};
export const NEW_SHIPPED_MD5 = {
  "writers-room-evaluate.md": "286e9498966187ed74126680da4a6a54"
};
const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5, current: NEW_SHIPPED_MD5,
  label: 'writers-room evaluate psychology',
  customizedHint: (filename) => `   Merge the psychology / sliders paragraph and the "an absent field was left blank on purpose" rule from data.reference/prompts/stages/${filename}.`,
});
export { applyMigration };
export default { up };
