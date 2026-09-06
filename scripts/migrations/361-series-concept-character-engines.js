/** Feed authored character psychology into the series-concept seed (#6416). */
import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  "pipeline-series-generate.md": [
    "21352c21ed6d4edb7a4b7c32704eff55"
  ]
};
export const NEW_SHIPPED_MD5 = {
  "pipeline-series-generate.md": "136a21435aba2b2b212883750040b986"
};
const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5, current: NEW_SHIPPED_MD5,
  label: 'Series concepts built on authored character engines',
  customizedHint: (filename) => `   Add the {{characterFoundations}} section from data.reference/prompts/stages/${filename}.`,
});
export { applyMigration };
export default { up };
