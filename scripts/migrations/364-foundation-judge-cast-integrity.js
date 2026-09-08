/**
 * Teach the foundation judge the deterministic cast-integrity block (#6415).
 *
 * The judge previously held every series-linked character to one field list, so
 * a declared minor role and a character whose interior the author explicitly
 * ruled out both scored as incomplete leads. The new `{{castIntegrity}}` section
 * carries a model-free depth ruling per character and makes it binding, plus the
 * converse rule the blank count could never express: a fully populated profile
 * whose control belief does not predict its own behavior is still a character
 * gap. Hash replacement preserves customized prompts.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-judge-foundation.md': ['e44b6c50d741bbd21fc86f481684c410'],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-judge-foundation.md': '75714f0e41c77ff5c8b9623cb4fb0a25',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'foundation judge cast integrity',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff data.reference/prompts/stages/${filename}\n` +
    `   against data/prompts/stages/${filename} and adopt the {{castIntegrity}} section\n` +
    '   with its binding explained/light/full depth rulings.',
});

export { applyMigration };
export default { up };
