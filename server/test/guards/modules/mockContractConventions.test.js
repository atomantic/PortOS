/**
 * Every `vi.mock` literal factory under the server-side test trees defines only
 * members its target exports. Scanner and rationale: scripts/lib/mockContractScan.js.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { exportNames, mask, mockDrift, unusedAllowed } from '../../../../scripts/lib/mockContractScan.js';
import { guardCorpus, readText, REPO_ROOT as ROOT } from '../../../../scripts/lib/guardCorpus.js';

/** Deliberate fixture adapters: `<test file>|<module specifier>|<key>` -> reason. */
const ALLOWED = new Map([
  ['server/services/memoryBackend.test.js|./memory.js|__backend', 'sentinel the suite reads to assert which backend was selected'],
  ['server/services/memoryBackend.test.js|./memoryDB.js|__backend', 'sentinel the suite reads to assert which backend was selected'],
]);

const used = new Set();

function isFile(file) {
  const path = relative(ROOT, file);
  if (!path.startsWith('..') && !isAbsolute(path)) {
    const info = guardCorpus().lstat(path);
    if (!info?.isSymbolicLink()) return info?.isFile() === true;
  }
  return existsSync(file) && statSync(file).isFile();
}

const drift = (testFile, source) => mockDrift(testFile, source, { root: ROOT, allowed: ALLOWED, used, readFile: readText, isFile });

describe('vi.mock factory contract conventions', () => {
  it('flags a planted key the real module does not export', () => {
    const probe = join(ROOT, 'server/lib/__probe.test.js');
    const src = [
      "vi.mock('./validateRequest.js', () => ({ validate: vi.fn(), plantedDeadKey: vi.fn() }));",
      "// vi.mock('./validateRequest.js', () => ({ commentedDeadKey: vi.fn() }));",
      "vi.mock('./validateRequest.js', async () => ({ ...(await vi.importActual('./validateRequest.js')), spreadKey: vi.fn() }));",
    ].join('\n');
    // The spread factory is read too: its explicit key is checked, the spread itself is not.
    expect(drift(probe, src)).toEqual([
      'server/lib/__probe.test.js:1 — ./validateRequest.js mocks plantedDeadKey',
      'server/lib/__probe.test.js:3 — ./validateRequest.js duplicates the vi.mock at line 1, which this one replaces',
      'server/lib/__probe.test.js:3 — ./validateRequest.js mocks spreadKey',
    ]);
  });

  it('flags a dead relative specifier', () => {
    const probe = join(ROOT, 'server/lib/__probe.test.js');
    expect(drift(probe, "vi.mock('./noSuchModule.js', () => ({ x: vi.fn() }));")).toEqual(['server/lib/__probe.test.js:1 — ./noSuchModule.js does not resolve']);
  });

  it('does not read a JSX-text apostrophe as a string opener (#12794)', () => {
    const src = [
      'export function Panel() {',
      "  return <p>Style is prepended to every scene's image prompt.</p>;",
      '}',
      'export default Panel;',
    ].join('\n');
    expect(mask(src)).toContain('export default Panel');
    expect(mask('export const a = <i>the default\'s value</i>;\nexport const b = 1;')).toContain('export const b');
    expect(mask('export const a = <i>Zoë\'s</i>;\nexport const b = 1;')).toContain('export const b');
    expect(mask("export const a = 'x';\nexport const b = 1;")).toContain('export const b');
    expect(mask("export const c = 'don\\'t';")).not.toContain('don');
  });

  it('collects the default export of a component with an apostrophe in JSX text (#12794)', () => {
    const file = join(ROOT, 'client/src/components/writers-room/StoryboardConfigTab.jsx');
    expect(exportNames(file).has('default')).toBe(true);
  });

  it('follows export * when collecting real exports', () => {
    expect(exportNames(join(ROOT, 'server/lib/fileUtils.js'))).toContain('safeJSONParse');
  });

  it('mocks only members the real modules export', async () => {
    const corpus = guardCorpus();
    const files = corpus.workingTreeCandidates().filter((path) =>
      /^(?:server|scripts|lib|autofixer)\//.test(path) && /\.test\.[cm]?js$/.test(path) && corpus.lstat(path) !== null);
    expect(files.length).toBeGreaterThan(100);
    const violations = [];
    for await (const [file, source] of corpus.readSources(files)) {
      violations.push(...drift(join(ROOT, file), source));
    }
    expect(violations, 'delete the dead key, or point the mock at the module that really exports it').toEqual([]);
    expect(unusedAllowed(ALLOWED, used), 'delete the stale ALLOWED entry').toEqual([]);
  });
});
