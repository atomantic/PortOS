/**
 * Teach every arc-role planning prompt that climax and finale are distinct:
 * climax owns the decisive active choice; finale follows with consequences
 * and denouement. Hash replacement preserves customized installs.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-season-episodes.md': ['a88e8e78a949b7aaf500d03314e2ea0b'],
  'pipeline-idea-expansion.md': ['d6fa86a435f978336661dcabca67258f'],
  'pipeline-arc-verify.md': ['a397f158fd9c0dca1c8dbe62df253f70'],
  'importer-issue-proposal.md': ['a6838832f8289932836db84ee565b870'],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-season-episodes.md': '7c24df53c097c2525a52bfb766239647',
  'pipeline-idea-expansion.md': 'a032e4a724251ed3e3495d33c4dbab8e',
  'pipeline-arc-verify.md': 'f09e81655ec897c74a2fae68ad31b9c4',
  'importer-issue-proposal.md': '9ba2ff965fba61efb85a3568bb530055',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'distinct climax arc role prompts',
  customizedHint: (filename) =>
    `   To add the distinct climax role manually, diff data.reference/prompts/stages/${filename}\n` +
    `   against data/prompts/stages/${filename} and merge the climax/denouement guidance.`,
});

export { applyMigration };
export default { up };
