/**
 * Upgrade the shipped `security-audit` CoS skill template to the trust-model
 * version from #9875.
 *
 * `promptSections/instructions.js` reads `data/prompts/skills/security-audit.md`
 * verbatim into every security task's agent prompt, and `setup-data.js` copies
 * only missing files. #9875 rewrote the shipped body without a migration, so
 * every install seeded before v2.86 still hands its security agents the generic
 * OWASP checklist, which tells them to flag permissive CORS and missing rate
 * limits — exemptions the security model documents — and says nothing about
 * delegated agent authority.
 *
 * Only an untouched copy of the pre-#9875 shipped body is replaced; an edited
 * template is kept and reported.
 */

import { makePromptReplaceMigration } from './_lib.js';

// The only body shipped before #9875 (unchanged from its introduction).
export const ACCEPTED_OLD_MD5 = {
  'security-audit.md': ['4b6d257ff6c4b4bd36b5044338eb7634'],
};

export const NEW_SHIPPED_MD5 = {
  'security-audit.md': 'cd2380a3363c6db68566bc26cb68c603',
};

// A CoS skill template, not a stage prompt.
export const DRIFT_SUBDIRS = {
  'security-audit.md': 'skills',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  subdirs: DRIFT_SUBDIRS,
  label: 'security-audit skill trust model',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff:\n` +
    `     data.reference/prompts/skills/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/skills/${filename}\n` +
    `   and merge the "Establish the actual threat model" section.`,
  skipFooter: (count) =>
    `⚠️  ${count} security-audit skill template(s) could not be auto-updated because\n` +
    `   they were customized. Security agents will keep the old checklist until you\n` +
    `   merge data.reference/prompts/skills/security-audit.md.`,
});

export { applyMigration };
export default { up };
