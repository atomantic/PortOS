/**
 * Refine the screenplay split-logic block in `importer-issue-proposal.md` so
 * it gates on the new `isUserRequestedCount` boolean instead of the legacy
 * "targetIssueCount > 1" inline check.
 *
 * Background: `analyzeImport` already passes `isUserRequestedCount` (true
 * only when the user explicitly typed a count on the intake form) alongside
 * `targetIssueCount` (which always has a value — either the user's input or
 * the per-content-type default like screenplay → 1). The old prompt copy
 * conflated these so a default-of-1 looked like "user asked for 1", which
 * was harmless for screenplays but masked the distinction. The new copy
 * gates the act-split branch on `isUserRequestedCount` explicitly: split on
 * act breaks ONLY when the user asked for >1; otherwise return one issue
 * regardless of act structure.
 *
 * Only updates prompts whose installed contents still match the post-016
 * shipped version. Customized prompts are left alone with a warning.
 */

import { access, readFile, writeFile, constants } from 'fs/promises';
import { createHash } from 'crypto';
import { join } from 'path';

const FILENAME = 'importer-issue-proposal.md';
// Set by migration 016 (importer-fence-source).
const OLD_SHIPPED_MD5 = '192f824a02885010d380aaacb4df67b5';
// New screenplay-block hash after this migration runs.
const NEW_SHIPPED_MD5 = 'a6838832f8289932836db84ee565b870';

const md5 = (text) => createHash('md5')
  .update(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'))
  .digest('hex');

export default {
  async up({ rootDir }) {
    const installedPath = join(rootDir, 'data', 'prompts', 'stages', FILENAME);
    const samplePath = join(rootDir, 'data.sample', 'prompts', 'stages', FILENAME);

    const installedExists = await access(installedPath, constants.F_OK).then(() => true, () => false);
    if (!installedExists) {
      console.log(`📝 importer-screenplay-user-requested-count: ${FILENAME} not installed — skipping`);
      return;
    }

    const installed = await readFile(installedPath, 'utf8');
    const installedHash = md5(installed);

    if (installedHash === NEW_SHIPPED_MD5) {
      console.log(`✅ importer-screenplay-user-requested-count: ${FILENAME} already current`);
      return;
    }
    if (installedHash !== OLD_SHIPPED_MD5) {
      console.warn(`⚠️  importer-screenplay-user-requested-count: ${FILENAME} is customized — leaving as-is. Merge the new screenplay-block gating manually from data.sample if needed.`);
      return;
    }

    const sampleExists = await access(samplePath, constants.F_OK).then(() => true, () => false);
    if (!sampleExists) {
      console.warn(`⚠️  importer-screenplay-user-requested-count: data.sample for ${FILENAME} missing — cannot update`);
      return;
    }
    const sample = await readFile(samplePath, 'utf8');
    await writeFile(installedPath, sample, 'utf8');
    console.log(`✅ importer-screenplay-user-requested-count: updated ${FILENAME}`);
  },
};
