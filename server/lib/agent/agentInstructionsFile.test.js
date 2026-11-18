import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, lstatSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { writeAgentInstructions, AGENT_INSTRUCTIONS_IMPORT } from './agentInstructionsFile.js';

describe('writeAgentInstructions (#4852)', () => {
  let repoPath;

  beforeEach(() => { repoPath = mkdtempSync(join(tmpdir(), 'portos-agentmd-write-')); });
  afterEach(() => rmSync(repoPath, { recursive: true, force: true }));

  it('writes the body to AGENTS.md and the import bridge to CLAUDE.md', async () => {
    await writeAgentInstructions(repoPath, '# Example App\n\nConventions go here.\n');

    expect(readFileSync(join(repoPath, 'AGENTS.md'), 'utf8')).toBe('# Example App\n\nConventions go here.\n');
    expect(readFileSync(join(repoPath, 'CLAUDE.md'), 'utf8')).toBe(AGENT_INSTRUCTIONS_IMPORT);
  });

  it('writes two regular files, never a symlink', async () => {
    // A git symlink checked out on a Windows runner degrades to 9 bytes of junk
    // text, from which Claude Code loads nothing — so the bridge must be real.
    await writeAgentInstructions(repoPath, '# Example App\n');

    expect(lstatSync(join(repoPath, 'AGENTS.md')).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(repoPath, 'CLAUDE.md')).isSymbolicLink()).toBe(false);
  });
});
