/**
 * Replace the triple-backtick fences around `{{source}}` in the three
 * Create-Suite Importer stage prompts with long tilde fences.
 *
 * User-supplied source can be up to 200 000 characters of arbitrary prose,
 * script, or markdown. When the source itself contains ``` (any sample of
 * code, any pasted markdown, a screenplay quoting a Stack-Exchange answer,
 * etc.) the LLM sees the fence close early and treats everything after as
 * instructions — a prompt-injection vector with no malice required.
 *
 * Only updates prompts whose installed contents still match the original
 * shipped (triple-backtick) version. Customized prompts are left alone with
 * a warning so the operator can opt in.
 */

import { access, readFile, writeFile, constants } from 'fs/promises';
import { createHash } from 'crypto';
import { join } from 'path';

const TARGETS = [
  {
    filename: 'importer-canon-extract.md',
    oldShippedMd5: 'cd5e4ed4096723e05642b881fb74b3ec',
    newShippedMd5: '724bb2ae8ff68e29e79999452ddefd63',
  },
  {
    filename: 'importer-arc-extract.md',
    oldShippedMd5: 'd3cdbcc4c6a0bf1481f922e900b6d848',
    newShippedMd5: 'a60450cabce43eb8340f63135a5fbc5d',
  },
  {
    filename: 'importer-issue-proposal.md',
    oldShippedMd5: 'd837e6321b8f6820bddaf972e7dbe01c',
    newShippedMd5: '192f824a02885010d380aaacb4df67b5',
  },
];

const md5 = (text) => createHash('md5')
  .update(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'))
  .digest('hex');

export default {
  async up({ rootDir }) {
    let updated = 0;
    let alreadyNew = 0;
    let customized = 0;
    let missing = 0;

    for (const { filename, oldShippedMd5, newShippedMd5 } of TARGETS) {
      const installedPath = join(rootDir, 'data', 'prompts', 'stages', filename);
      const samplePath = join(rootDir, 'data.sample', 'prompts', 'stages', filename);

      const installedExists = await access(installedPath, constants.F_OK).then(() => true, () => false);
      if (!installedExists) { missing++; continue; }

      const installed = await readFile(installedPath, 'utf8');
      const installedHash = md5(installed);

      if (installedHash === newShippedMd5) { alreadyNew++; continue; }
      if (installedHash !== oldShippedMd5) {
        console.warn(`⚠️  importer-fence-source: ${filename} is customized — leaving as-is. If you have not added safeguards around \`{{source}}\` fencing, re-paste the shipped template manually.`);
        customized++;
        continue;
      }

      const sampleExists = await access(samplePath, constants.F_OK).then(() => true, () => false);
      if (!sampleExists) {
        console.warn(`⚠️  importer-fence-source: data.sample for ${filename} missing — cannot update`);
        continue;
      }
      const sample = await readFile(samplePath, 'utf8');
      await writeFile(installedPath, sample, 'utf8');
      updated++;
      console.log(`✅ importer-fence-source: updated ${filename}`);
    }

    console.log(`📝 importer fence-source: ${updated} updated, ${alreadyNew} already current, ${customized} customized, ${missing} missing`);
  },
};
