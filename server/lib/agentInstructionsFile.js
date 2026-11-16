/**
 * The `AGENTS.md` + bridge `CLAUDE.md` pair a repo carries; scaffolders use `writeAgentInstructions` rather than a
 * bare CLAUDE.md write.
 *
 * The bridge is a one-line `@AGENTS.md` import, not a symlink: Claude Code hardcodes `CLAUDE.md`, and a symlink on
 * a Windows checkout without symlink support becomes a text file Claude loads nothing from (and a CLI reading both
 * names, grok, would ingest the body twice).
 */

import { writeFile } from 'fs/promises';
import { join } from 'path';

/** Canonical filename holding the content. */
export const AGENT_INSTRUCTIONS_FILENAME = 'AGENTS.md';

/** Claude Code's hardcoded filename, kept as a bridge to the canonical one. */
export const CLAUDE_BRIDGE_FILENAME = 'CLAUDE.md';

/** Entire body of the bridge file. */
export const AGENT_INSTRUCTIONS_IMPORT = '@AGENTS.md\n';
/** Write a repo's instructions to `AGENTS.md` and the Claude Code bridge beside it (a repo with only one name is unreadable to some CLIs). */
export async function writeAgentInstructions(repoPath, content) {
  await Promise.all([
    writeFile(join(repoPath, AGENT_INSTRUCTIONS_FILENAME), content),
    writeFile(join(repoPath, CLAUDE_BRIDGE_FILENAME), AGENT_INSTRUCTIONS_IMPORT),
  ]);
}
