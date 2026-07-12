/**
 * Gate the stock "Target Application" heading in the CoS agent briefing
 * template on a precomputed `targetAppLabel` instead of the raw
 * `task.metadata.app` id.
 *
 * The api-prompt path renders this heading for EVERY task that carries an app
 * id — including the PortOS default app (`portos-default`), where the agent
 * already runs in the PortOS directory so the line is redundant noise. The
 * light/fallback path already suppresses it (buildTaskBlock in
 * agentPromptBuilder.js); this brings the editable stage template in line.
 *
 * `agentPromptBuilder.js` now passes `targetAppLabel` into the template
 * context — empty string for the default app (section renders nothing), the
 * app id for managed apps. `task.metadata.app` stays in the context untouched
 * so any custom template references keep working.
 *
 * Accepted-old chain cross-syncs migration 010's shape so an install that ran
 * 010 (or any earlier accepted-old copy 010 would have auto-updated to
 * `dccb392a…`) still matches and auto-updates here.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'cos-agent-briefing.md': [
    'dccb392a43cbd3dac900fee12c31619a', // 010 shipped — strip header/role-play preamble (the copy an install carries after 010)
    '699d053875472df455258724a0162bd5', // e827e066 — abort standardization on dirty worktree
    '181b26838e526427173e4dccfc884d01', // d086bdfc — remove git stash + enforce /do:push
    '3e1ca7f7b14b799f89a193c568003624', // f4589187 — don't update PortOS changelog
    'af73fd50d6f29d561772474c12346e53', // 3b4ced6a — task-type skill templates
    '9bcd3a0167dd4aed7cfff7f404494dfb', // cf41dd61 — context compaction
    'd761133753da290a0c02eca1c87709e4', // 9b4c4ba6 — initial CoS landing
  ],
};

export const NEW_SHIPPED_MD5 = {
  'cos-agent-briefing.md': 'a01c81d3a7f4ac0ca9e8d5137735c0e3',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'cos-agent-briefing',
  customizedHint: (filename) =>
    `   To gate the "Target Application" heading on {{targetAppLabel}} manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}`,
});

export { applyMigration };
export default { up };
