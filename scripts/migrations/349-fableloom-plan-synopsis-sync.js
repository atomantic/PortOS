/** Keep episode summaries synchronized when the series plan changes. */
import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'fableloom-feedback-series-plan.md': ['6c4f6c846acc6186eaa8da297080b9d9'],
};
export const NEW_SHIPPED_MD5 = {
  'fableloom-feedback-series-plan.md': '2d1b40041223baa02a1517a102f103c2',
};
const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'FableLoom episode synopsis synchronization',
  customizedHint: (filename) => `   Merge episodeSynopsisEdits support from data.reference/prompts/stages/${filename}.`,
});
export { applyMigration };
export default { up };
