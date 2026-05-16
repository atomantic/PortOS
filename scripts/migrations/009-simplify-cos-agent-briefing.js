/**
 * Strip the obsolete preamble from the CoS agent prompt template:
 *   - The "# Chief of Staff Agent Briefing" header
 *   - The "You are an autonomous agent…" role-play framing
 * Both were chrome on top of the real instructions. The template only
 * serves API providers now (TUI and CLI agents get a runtime-built light
 * prompt from buildLightContextPrompt), so this cleanup is API-facing only.
 *
 * Strategy — "unmodified-only" update: if the installed file matches any
 * historical shipped hash, replace it with the current data.sample copy.
 * Diverged (customized) files are left alone with a warning.
 *
 * Idempotent — re-runs that find the current sample hash on disk are no-ops.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';

const md5 = (str) => {
  const normalized = str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return createHash('md5').update(normalized).digest('hex');
};

const FILENAME = 'cos-agent-briefing.md';

// Every shipped version of cos-agent-briefing.md prior to this migration.
// If the installed file matches any of these, the user hasn't customized it
// and we can safely replace it with the current sample.
const OLD_SHIPPED_HASHES = [
  '699d053875472df455258724a0162bd5', // e827e066 — abort standardization on dirty worktree
  '181b26838e526427173e4dccfc884d01', // d086bdfc — remove git stash + enforce /do:push
  '3e1ca7f7b14b799f89a193c568003624', // f4589187 — don't update PortOS changelog
  'af73fd50d6f29d561772474c12346e53', // 3b4ced6a — task-type skill templates
  '9bcd3a0167dd4aed7cfff7f404494dfb', // cf41dd61 — context compaction
  'd761133753da290a0c02eca1c87709e4', // 9b4c4ba6 — initial CoS landing
];

// Hash of the version this migration copies in (data.sample current).
const NEW_SHIPPED_HASH = 'dccb392a43cbd3dac900fee12c31619a';

export default {
  async up({ rootDir }) {
    const dataPath = join(rootDir, 'data', 'prompts', 'stages', FILENAME);
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

    if (existingMd5 === NEW_SHIPPED_HASH) {
      console.log(`📝 ${FILENAME}: already up to date`);
      return;
    }

    if (!OLD_SHIPPED_HASHES.includes(existingMd5)) {
      console.warn(
        `⚠️  ${FILENAME} has been customized — skipping auto-update.\n` +
        `   To drop the obsolete header and role-play preamble manually, diff:\n` +
        `     data.sample/prompts/stages/${FILENAME}\n` +
        `   against your current:\n` +
        `     data/prompts/stages/${FILENAME}`,
      );
      return;
    }

    const sampleContent = await readFile(samplePath, 'utf-8');
    await writeFile(dataPath, sampleContent);
    console.log(`✅ updated CoS agent prompt template: ${FILENAME}`);
  },
};
