/**
 * Add `## Back cover concept` section to the comic-script stage prompt.
 *
 * Before this migration, the comic-script template emitted only a
 * `## Cover concept` section. After: the template also asks the LLM for a
 * `## Back cover concept` (one paragraph, illustration-only, no text), which
 * the parser captures into `backCoverConcept` and the issue's
 * `stages.comicPages.backCover.script` slot reads via the extract-pages
 * route.
 *
 * Strategy: same "unmodified-only" auto-update pattern as migration 003.
 * If the live file's MD5 matches any of the historical shipped hashes
 * (pre-003 or post-003), we replace it with the current data.sample/.
 * Diverged (user-customized) files are skipped with a merge hint.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';

const md5 = (str) => {
  const normalized = str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return createHash('md5').update(normalized).digest('hex');
};

// Every historical shipped MD5 of pipeline-comic-script.md. A user at any
// of these is unmodified and can be auto-bumped to the new template.
const HISTORICAL_SHIPPED_MD5 = [
  '40e5fdc1a1e68a7419b7dad936366c1a', // pre-003 (original)
  'beab031951859ca13579cdb9c4dbe769', // post-003 (length-profile feature)
];

// MD5 of the new data.sample/pipeline-comic-script.md (with Back cover section).
const NEW_SHIPPED_MD5 = '1e0af305c27d0c80c4b482d2ebcb4a0d';

const FILENAME = 'pipeline-comic-script.md';

export default {
  async up({ rootDir }) {
    const dataPath   = join(rootDir, 'data', 'prompts', 'stages', FILENAME);
    const samplePath = join(rootDir, 'data.sample', 'prompts', 'stages', FILENAME);

    const existing = await readFile(dataPath, 'utf-8').catch((err) => {
      if (err.code !== 'ENOENT') throw err;
      return null;
    });

    if (existing === null) {
      console.log(`📄 ${FILENAME}: not present in data/, will be created by setup-data.js`);
      return;
    }

    const existingMd5 = md5(existing);

    if (existingMd5 === NEW_SHIPPED_MD5) {
      console.log(`📝 ${FILENAME}: already at new version (Back cover section present)`);
      return;
    }

    if (!HISTORICAL_SHIPPED_MD5.includes(existingMd5)) {
      console.warn(
        `⚠️  ${FILENAME} has been customized — skipping auto-update.\n` +
        `   To add the Back cover concept section manually, diff:\n` +
        `     data.sample/prompts/stages/${FILENAME}\n` +
        `   against your current:\n` +
        `     data/prompts/stages/${FILENAME}\n` +
        `   and merge the new \`## Back cover concept\` block.`,
      );
      return;
    }

    const sampleContent = await readFile(samplePath, 'utf-8');
    await writeFile(dataPath, sampleContent);
    console.log(`✅ updated ${FILENAME} — added Back cover concept section`);
  },
};
