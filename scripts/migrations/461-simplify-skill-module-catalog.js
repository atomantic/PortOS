/**
 * Upgrade the shipped `simplify` CoS skill template to search the derived module catalog.
 *
 * The skill told agents to grep the catalog tables in the `server/lib`, `client/src/lib`,
 * hooks and services READMEs. #16084 removed those tables: module summaries now live in each
 * module's header and `node scripts/lib-catalog.js <term>` prints them. `setup-data.js` copies
 * only missing files, so installed copies keep the stale instruction without this migration.
 *
 * Only an untouched copy of the previous shipped body is replaced; an edited template is kept
 * and reported.
 */

import { makePromptReplaceMigration } from './_lib.js';

// The only body shipped before #16084 (unchanged since its introduction).
export const ACCEPTED_OLD_MD5 = {
  'simplify.md': ['8415080bcc0284a5736a4768bf4f40b2'],
};

export const NEW_SHIPPED_MD5 = {
  'simplify.md': '0b064e2a5f847ca26be8e8c8f4dfd0c8',
};

// A CoS skill template, not a stage prompt.
export const DRIFT_SUBDIRS = {
  'simplify.md': 'skills',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  subdirs: DRIFT_SUBDIRS,
  label: 'simplify skill module catalog',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff:\n` +
    `     data.reference/prompts/skills/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/skills/${filename}\n` +
    `   and merge the "Prefer reuse over a new helper" bullet.`,
  skipFooter: (count) =>
    `⚠️  ${count} simplify skill template(s) could not be auto-updated because\n` +
    `   they were customized. Simplify agents will keep grepping the removed README\n` +
    `   catalogs until you merge data.reference/prompts/skills/simplify.md.`,
});

export { applyMigration };
export default { up };
