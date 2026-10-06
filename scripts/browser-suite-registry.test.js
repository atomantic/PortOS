import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BROWSER_SUITES } from './ci-test-plan.js';

// Scans the tracked tree, so it is registered in ALWAYS_RUN_TESTS (#10312).
describe('cross-workspace browser suite registry', () => {
  it('lists exactly the suites that guard canRun with the browser suite gate', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const gated = execFileSync('git', ['grep', '-l', 'browserSuiteGate', '--', 'server/**/*.browser.test.js'], { cwd: root, encoding: 'utf8' })
      .split('\n').filter(Boolean).sort();
    expect(gated).toEqual([...BROWSER_SUITES].sort());
  });
});
