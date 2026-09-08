/**
 * Teach the character prompts the optional psychology profile (#6414):
 * a one-sentence theory of control, the strategy it motivates, what it
 * protects, what it costs, and the survival / connection / status drives it
 * serves — plus the rule that a `lie` is never restated as the theory and that
 * an honest `unknown` beats an invented interior.
 */
import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  "universe-character-expand.md": [
    "924fe8836f3014873d1789e98e997db2"
  ],
  "pipeline-character-foundation.md": [
    "b7d2bac347e11171606f4c6acfcd32e1"
  ]
};
export const NEW_SHIPPED_MD5 = {
  "universe-character-expand.md": "961b73ba6e50df5d49f0cc76505e50bd",
  "pipeline-character-foundation.md": "c606061954b23a9957c68dd068b54dc4"
};
const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5, current: NEW_SHIPPED_MD5,
  label: 'character psychology profile',
  customizedHint: (filename) => `   Merge the psychology (theory of control + survival/connection/status drives) guidance and output keys from data.reference/prompts/stages/${filename}.`,
});
export { applyMigration };
export default { up };
