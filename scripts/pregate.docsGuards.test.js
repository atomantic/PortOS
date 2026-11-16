// Focused pregate selection for docs and instruction-file edits (#16475).
// Its own file because the planner needs the tracked tree, and a test that
// enumerates it is an always-run guard held to a per-file budget: the same
// cases inside pregate.test.js made that 30 s suite always-run.
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCiTestPlan } from './ci-test-plan.js';
import { trackedFiles } from './lib/trackedFiles.js';
import { focusedLocalPlan } from './pregate.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('focused local policy: size and index guards (#16475)', () => {
  const tracked = trackedFiles(REPO_ROOT);
  // The planner's plan lacks the local-only stages pregate adds; give them their idle defaults.
  const local = { browser: { files: [] }, promptHistory: false, linuxContainment: false, supercolliderLive: false, dockerContainmentLive: false, macosNative: false };
  const focusedFor = (changed) => focusedLocalPlan({ ...local, ...buildCiTestPlan(changed, { trackedFiles: tracked }) }, tracked, changed, () => null).server.files;

  it('runs the docs size ratchet for a docs or root markdown edit', () => {
    expect(focusedFor(['docs/GITHUB_ACTIONS.md'])).toContain('docs/docs-index.test.js');
    expect(focusedFor(['ETHOS.md'])).toContain('docs/docs-index.test.js');
  });

  it('runs the instruction-file byte caps for an AGENTS.md edit', () => {
    expect(focusedFor(['AGENTS.md'])).toContain('scripts/agent-instructions-files.test.js');
    expect(focusedFor(['server/AGENTS.md'])).toContain('scripts/agent-instructions-files.test.js');
  });
});
