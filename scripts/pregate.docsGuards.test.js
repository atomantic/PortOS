// Focused pregate selection for docs and instruction-file edits (#16475).
// Its own file because the planner needs the tracked tree, and a test that
// enumerates it is an always-run guard held to a per-file budget: the same
// cases inside pregate.test.js made that 30 s suite always-run.
import { describe, expect, it } from 'vitest';
import { buildCiTestPlan } from './ci-test-plan.js';
import { focusedLocalPlan } from './pregate.js';

describe('focused local policy: size and index guards (#16475)', () => {
  // A fixture index, not the live tree: the selection under test only needs these paths to exist,
  // and enumerating the tree made this an always-run tree guard (guardScanners false positive).
  const tracked = ['docs/docs-index.test.js', 'scripts/agent-instructions-files.guard.test.js', 'docs/GITHUB_ACTIONS.md', 'ETHOS.md', 'AGENTS.md', 'server/AGENTS.md'];
  // The planner's plan lacks the local-only stages pregate adds; give them their idle defaults.
  const local = { browser: { files: [] }, linuxContainment: false, supercolliderLive: false, dockerContainmentLive: false, macosNative: false };
  const focusedFor = (changed) => focusedLocalPlan({ ...local, ...buildCiTestPlan(changed, { trackedFiles: tracked }) }, tracked, changed, () => null).server.files;

  it('runs the docs size ratchet for a docs or root markdown edit', () => {
    expect(focusedFor(['docs/GITHUB_ACTIONS.md'])).toContain('docs/docs-index.test.js');
    expect(focusedFor(['ETHOS.md'])).toContain('docs/docs-index.test.js');
  });

  it('runs the instruction-file byte caps for an AGENTS.md edit', () => {
    expect(focusedFor(['AGENTS.md'])).toContain('scripts/agent-instructions-files.guard.test.js');
    expect(focusedFor(['server/AGENTS.md'])).toContain('scripts/agent-instructions-files.guard.test.js');
  });
});
