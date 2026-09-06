/**
 * Teach the FableLoom whole-series editor the deterministic cast-integrity
 * block (#6415).
 *
 * The editor judged an interactive series against the full canon digest with no
 * statement of what each character actually owes the story, so a declared minor
 * role and a character whose interior the author explicitly ruled out both read
 * as thin leads — and nothing told it that a profile with every field filled can
 * still fail to hold together. The new `{{castIntegrity}}` section carries a
 * model-free depth ruling per character and makes it binding on the `character`
 * findings, plus the two rules the canon digest cannot express: a filled field
 * is not integrity, and an absence the author explained is not a deficiency.
 * It also states the boundary this surface needs — the editor patches the story,
 * never the character records. Hash replacement preserves customized prompts.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'fableloom-editorial-remediate.md': ['d73329e2341e7bea9935a96043ed045f'],
};

export const NEW_SHIPPED_MD5 = {
  'fableloom-editorial-remediate.md': 'c0cce5cfe63ec4e94047415bbe83881b',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'FableLoom editorial cast integrity',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff data.reference/prompts/stages/${filename}\n` +
    `   against data/prompts/stages/${filename} and adopt the {{castIntegrity}} section\n` +
    '   with its binding explained/light/full depth rulings.',
});

export { applyMigration };
export default { up };
