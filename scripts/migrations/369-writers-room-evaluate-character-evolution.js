/**
 * Teach the Writers Room evaluate prompt to read the five-stage character
 * evolution lens (#6445, epic #6418).
 *
 * The pass already receives the authored character framework; it now also
 * receives `{{characterEvolution}}` — the OPTIONAL lens a writer maps onto the
 * manuscript retrospectively, with each stage's evidence annotated against the
 * live segment index. The template needed the rulings that block makes
 * necessary, and none of them can be inferred from the JSON alone:
 *
 *   - `tragic-refusal` and `flat-testing` are INTENDED endings, so neither is a
 *     flat-arc finding; `partial-open` makes incompleteness legitimate and only
 *     an unearned claim of completion a finding.
 *   - a `[stale]` or `[unverified]` anchor is NOT proof — segment numbering is
 *     rebuilt on every draft save, so a resolving id can name prose the stage
 *     was never written for.
 *   - "no authored intent" and "authored intent not delivered" are different
 *     defects with different repairs and must stay separate findings.
 *
 * Additive and section-gated: a work with no authored lens renders no block, so
 * its analysis is unchanged.
 */
import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  "writers-room-evaluate.md": [
    "286e9498966187ed74126680da4a6a54"
  ]
};
export const NEW_SHIPPED_MD5 = {
  "writers-room-evaluate.md": "995cfd92061b55730b0e081998e96f84"
};
const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5, current: NEW_SHIPPED_MD5,
  label: 'writers-room evaluate character evolution',
  customizedHint: (filename) => `   Merge the "Authored character evolution (five-stage lens)" section — the four declared outcomes, the stale/unverified evidence rule, and the two distinct failure modes — from data.reference/prompts/stages/${filename}.`,
});
export { applyMigration };
export default { up };
