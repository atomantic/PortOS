/**
 * Strip the obsolete preamble from the CoS agent prompt template:
 *   - The "# Chief of Staff Agent Briefing" header
 *   - The "You are an autonomous agent…" role-play framing
 * Both were chrome on top of the real instructions. The template only
 * serves API providers now (TUI and CLI agents get a runtime-built light
 * prompt from buildLightContextPrompt), so this cleanup is API-facing only.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'cos-agent-briefing.md': [
    'dccb392a43cbd3dac900fee12c31619a', // the hash this migration originally produced (post-010 / pre-187 — target-app label gating)
    '699d053875472df455258724a0162bd5', // e827e066 — abort standardization on dirty worktree
    '181b26838e526427173e4dccfc884d01', // d086bdfc — remove git stash + enforce /do:push
    '3e1ca7f7b14b799f89a193c568003624', // f4589187 — don't update PortOS changelog
    'af73fd50d6f29d561772474c12346e53', // 3b4ced6a — task-type skill templates
    '9bcd3a0167dd4aed7cfff7f404494dfb', // cf41dd61 — context compaction
    'd761133753da290a0c02eca1c87709e4', // 9b4c4ba6 — initial CoS landing
  ],
};

// Kept in sync with the LATEST shipped hash (migration 187 supersedes 010 for
// this file). Every migration touching cos-agent-briefing.md carries the same
// current hash so each one's drift-catch test asserts the live sample body and
// a fresh chronological run lands directly on the newest template.
export const NEW_SHIPPED_MD5 = {
  'cos-agent-briefing.md': 'a01c81d3a7f4ac0ca9e8d5137735c0e3',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'cos-agent-briefing',
  customizedHint: (filename) =>
    `   To drop the obsolete header and role-play preamble manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}`,
});

export { applyMigration };
export default { up };
