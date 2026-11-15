/**
 * The agent-instructions file pair a repository carries (#4852).
 *
 * The `AGENTS.md` + bridge `CLAUDE.md` pair a repo carries (#4852). `writeAgentInstructions(repoPath,
 * content)` writes the body to `AGENTS.md` and the one-line `@AGENTS.md` import beside it — use it in
 * scaffolders instead of a bare `writeFile(join(repoPath, 'CLAUDE.md'), …)`, since a generated repo
 * carrying only one name is unreadable to half the CLIs PortOS can point at it. Constants:
 * `AGENT_INSTRUCTIONS_FILENAME`, `CLAUDE_BRIDGE_FILENAME`, `AGENT_INSTRUCTIONS_IMPORT`.
 *
 * `AGENTS.md` is the cross-vendor standard every CLI PortOS drives reads —
 * except Claude Code, whose memory discovery hardcodes `CLAUDE.md` with no
 * configurable filename. So a repo needs both, and the second one is a
 * one-line `@AGENTS.md` import rather than a symlink: a git symlink checked out
 * on a Windows runner without symlink support materializes as a 9-byte text
 * file containing the literal string `AGENTS.md`, from which Claude Code loads
 * nothing, and a CLI that reads BOTH names (grok) would ingest the full body
 * twice. A real import file is correct on every platform and inert everywhere
 * else.
 */

import { writeFile } from 'fs/promises';
import { join } from 'path';

/** Canonical filename holding the content. */
export const AGENT_INSTRUCTIONS_FILENAME = 'AGENTS.md';

/** Claude Code's hardcoded filename, kept as a bridge to the canonical one. */
export const CLAUDE_BRIDGE_FILENAME = 'CLAUDE.md';

/** Entire body of the bridge file. */
export const AGENT_INSTRUCTIONS_IMPORT = '@AGENTS.md\n';

/**
 * Write a repo's instructions to `AGENTS.md` and the Claude Code bridge beside
 * it. Use this instead of a bare `writeFile(join(repoPath, 'CLAUDE.md'), …)` —
 * a generated repo carrying only one of the two names is unreadable to half the
 * CLIs PortOS can point at it.
 * @param {string} repoPath
 * @param {string} content full `AGENTS.md` body
 */
export async function writeAgentInstructions(repoPath, content) {
  await Promise.all([
    writeFile(join(repoPath, AGENT_INSTRUCTIONS_FILENAME), content),
    writeFile(join(repoPath, CLAUDE_BRIDGE_FILENAME), AGENT_INSTRUCTIONS_IMPORT),
  ]);
}
