/**
 * Teach the two Writers Room character-facing prompts the narrative framework
 * the bible has always been able to store (#6417):
 *
 * - `writers-room-characters.md` may now PROPOSE motivations / Ghost / Wound /
 *   Lie / Need / Want / arc type / secrets, under an explicit rule that an
 *   empty framework field beats an invented backstory and that an inferred
 *   read is flagged in `missingFromProse`.
 * - `writers-room-evaluate.md` receives the authored framework (when the work
 *   has one) so the editorial pass reports delivery against the writer's plan
 *   instead of inferring the plan and the delivery from the same prose.
 */
import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  "writers-room-characters.md": [
    "cdd99c7a3ef92bf798f30fa2fb4465f1"
  ],
  "writers-room-evaluate.md": [
    "d3374472820df264731f435141e05270"
  ]
};
export const NEW_SHIPPED_MD5 = {
  "writers-room-characters.md": "4b19f6538ff3a602007ef8e32c8e5047",
  "writers-room-evaluate.md": "286e9498966187ed74126680da4a6a54"
};
const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5, current: NEW_SHIPPED_MD5,
  label: 'writers-room character framework',
  customizedHint: (filename) => `   Merge the character-framework guidance (Ghost / Wound / Lie / Need / Want, arc type, secrets) and its output keys from data.reference/prompts/stages/${filename}.`,
});
export { applyMigration };
export default { up };
