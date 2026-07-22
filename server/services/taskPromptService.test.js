import { describe, it, expect, vi } from 'vitest';

// Drive getTaskPrompt with a controlled template so the REAL
// resolvePromptPlaceholders (and the real PATHS.worktrees) do the work, without
// touching persisted schedule state. getTaskInterval is the only taskSchedule
// export taskPromptService imports.
vi.mock('./taskSchedule.js', () => ({
  getTaskInterval: vi.fn(async () => ({ prompt: 'before {worktreesRoot}/claim-x after' })),
}));

import { getTaskPrompt } from './taskPromptService.js';
import { PATHS } from '../lib/fileUtils.js';

describe('taskPromptService {worktreesRoot} substitution', () => {
  it('resolves {worktreesRoot} to PATHS.worktrees (PortOS shared dir), leaving no literal placeholder', async () => {
    // PATHS.worktrees is PortOS's own shared worktrees dir — an absolute path
    // ending in data/cos/worktrees — NOT a repo-relative one.
    expect(PATHS.worktrees).toMatch(/\/data\/cos\/worktrees$/);

    const out = await getTaskPrompt('claim-issue');
    expect(out).toBe(`before ${PATHS.worktrees}/claim-x after`);
    expect(out).not.toContain('{worktreesRoot}');
  });
});
