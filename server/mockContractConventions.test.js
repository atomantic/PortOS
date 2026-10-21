/**
 * Every `vi.mock` literal factory under the server-side test trees defines only
 * members its target exports. Scanner and rationale: scripts/lib/mockContractScan.js.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportNames, mask, mockDrift } from '../scripts/lib/mockContractScan.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Deliberate fixture adapters: `<test file>|<module specifier>|<key>` -> reason. */
const ALLOWED = new Map([
  ['server/services/memoryBackend.test.js|./memory.js|__backend', 'sentinel the suite reads to assert which backend was selected'],
  ['server/services/memoryBackend.test.js|./memoryDB.js|__backend', 'sentinel the suite reads to assert which backend was selected'],
  ['server/routes/peerAdministration.test.js|../services/pm2.js|restartProcess', 'dead guard double; replacing it is tracked in #11873'],
]);

const drift = (testFile, source) => mockDrift(testFile, source, { root: ROOT, allowed: ALLOWED });

function trackedTests() {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', 'server', 'scripts', 'lib', 'autofixer'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter((f) => /\.test\.[cm]?js$/.test(f) && existsSync(join(ROOT, f)));
}

describe('vi.mock factory contract conventions', () => {
  it('flags a planted key the real module does not export', () => {
    const probe = join(ROOT, 'server/lib/__probe.test.js');
    const src = [
      "vi.mock('./validation.js', () => ({ validateRequest: vi.fn(), plantedDeadKey: vi.fn() }));",
      "// vi.mock('./validation.js', () => ({ commentedDeadKey: vi.fn() }));",
      "vi.mock('./validation.js', async () => ({ ...(await vi.importActual('./validation.js')), spreadKey: vi.fn() }));",
    ].join('\n');
    expect(drift(probe, src)).toEqual(['server/lib/__probe.test.js:1 — ./validation.js mocks plantedDeadKey']);
  });

  it('does not read a JSX-text apostrophe as a string opener (#12794)', () => {
    const src = [
      'export function Panel() {',
      "  return <p>Style is prepended to every scene's image prompt.</p>;",
      '}',
      'export default Panel;',
    ].join('\n');
    expect(mask(src)).toContain('export default Panel');
    expect(mask("export const a = 'x';\nexport const b = 1;")).toContain('export const b');
    expect(mask("export const c = 'don\\'t';")).not.toContain('don');
  });

  it('collects the default export of a component with an apostrophe in JSX text (#12794)', () => {
    const file = join(ROOT, 'client/src/components/writers-room/StoryboardConfigTab.jsx');
    expect([...exportNames(file)]).toEqual(['default']);
  });

  it('follows export * when collecting real exports', () => {
    expect(exportNames(join(ROOT, 'server/lib/index.js')).size).toBeGreaterThan(50);
  });

  it('mocks only members the real modules export', () => {
    const files = trackedTests();
    expect(files.length).toBeGreaterThan(100);
    const violations = files.flatMap((f) => drift(join(ROOT, f), readFileSync(join(ROOT, f), 'utf8')));
    expect(violations, 'delete the dead key, or point the mock at the module that really exports it').toEqual([]);
  });
});
