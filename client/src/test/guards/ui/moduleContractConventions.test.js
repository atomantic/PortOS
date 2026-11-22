/**
 * Rule: Member reads on `CONTRACT_MODULES` and literal `vi.mock` factories must only reference real exports (via `scripts/lib/mockContractScan.js`).
 * Fix: Fix the missing export/member name, or update the mock factory.
 * What this guard cannot see:
 *   - Scoped to git-tracked sources under `client/src` (comments masked); non-literal `vi.mock` factories are not checked.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { trackedSourceFiles } from '../../trackedFiles.js';
import { lineOf, maskComments } from '../../classNameScan.js';
import { mockDrift as scanMockDriftIn, unusedAllowed } from '../../../../../scripts/lib/mockContractScan.js';
import { readText, REPO_ROOT, trackedFiles } from '../../../../../scripts/lib/guardCorpus.js';

const CLIENT_ROOT = join(REPO_ROOT, 'client');

/** Shared modules whose default export is an object API callers dot into. */
const CONTRACT_MODULES = [
  {
    file: 'src/components/ui/Toast.jsx',
    // Import specifiers end in one of these (with or without the extension).
    specifier: /(?:^|\/)ui\/Toast(?:\.jsx)?$/,
    namedAliases: ['toast'],
    load: async () => {
      const mod = await import('../../../components/ui/Toast.jsx');
      return { api: mod.default, exportNames: Object.keys(mod) };
    },
  },
];

/** `<test file>|<module specifier>|<key>` -> reason, for mock keys that are deliberate adapters. */
const MOCK_ADAPTERS = new Map([
  ['src/test/musicVideoPageMocks.jsx|../services/apiMusicVideo.js|listMusicVideoProjects', 'in-test project store: the Music Video page suites back listMusicVideoProjectSummaries and getMusicVideoProject with it'],
]);

const IMPORT_RE = /import\s+([^'"]+?)\s+from\s+['"]([^'"]+)['"]/g;

/** Local bindings that refer to the module's object API in one file. */
export function contractBindings(source, contract) {
  const locals = new Set();
  for (const match of source.matchAll(IMPORT_RE)) {
    if (!contract.specifier.test(match[2])) continue;
    const clause = match[1].trim();
    const defaultName = clause.match(/^([A-Za-z_$][\w$]*)/);
    if (defaultName) locals.add(defaultName[1]);
    const named = clause.match(/\{([^}]*)\}/);
    if (!named) continue;
    for (const part of named[1].split(',')) {
      const [imported, alias] = part.trim().split(/\s+as\s+/);
      if (contract.namedAliases.includes(imported)) locals.add(alias || imported);
    }
  }
  return locals;
}

/** `<local>.<member>` reads whose member the real API lacks. */
export function missingMembers(rawSource, file, contract, members) {
  const source = maskComments(rawSource);
  const violations = [];
  for (const local of contractBindings(source, contract)) {
    const access = new RegExp(`(?<![\\w$.])${local.replace(/\$/g, '\\$')}\\.([A-Za-z_$][\\w$]*)`, 'g');
    for (const match of source.matchAll(access)) {
      if (!members.has(match[1])) violations.push(`${file}:${lineOf(source, match.index)} — ${local}.${match[1]}`);
    }
  }
  return violations;
}

/** The balanced `( … )` argument text starting at `open`, or '' when unbalanced. */
function balancedArgs(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return '';
}

const MOCK_KEY_RE = /(?<![\w$.'"])([A-Za-z_$][\w$]*)\s*:\s*(?:vi\.fn|\(|async\b|function\b)/g;

/** Keys a `vi.mock(<contract module>, factory)` defines that the real module lacks. */
export function mockDrift(rawSource, file, contract, allowed) {
  const source = maskComments(rawSource);
  const violations = [];
  for (const call of source.matchAll(/vi\.mock\(\s*['"]([^'"]+)['"]/g)) {
    if (!contract.specifier.test(call[1])) continue;
    const args = balancedArgs(source, call.index + 'vi.mock'.length);
    for (const key of args.matchAll(MOCK_KEY_RE)) {
      if (!allowed.has(key[1])) violations.push(`${file}:${lineOf(source, call.index)} — mocks ${key[1]}`);
    }
  }
  return violations;
}

const usedAdapters = new Set();
const scanMockDrift = (testFile, source) => scanMockDriftIn(testFile, source, { root: CLIENT_ROOT, allowed: MOCK_ADAPTERS, used: usedAdapters });

const read = (file) => readText(join(CLIENT_ROOT, file));

// Shared page mock scaffolds (`src/test/*PageMocks.jsx`) register `vi.mock` for several suites, so they are scanned too.
const trackedTestFiles = () => trackedFiles(CLIENT_ROOT, ['src'])
  .filter((f) => /\.test\.jsx?$/.test(f) || /^src\/test\/\w+PageMocks\.jsx$/.test(f));

describe('module contract conventions', () => {
  const files = trackedSourceFiles(CLIENT_ROOT);
  const testFiles = trackedTestFiles();

  it('scans a populated client tree', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(testFiles.length).toBeGreaterThan(100);
  });

  it('detects a missing member and a drifted mock', () => {
    const [contract] = CONTRACT_MODULES;
    const members = new Set(['success', 'warning']);
    expect(missingMembers("import toast from '../ui/Toast';\ntoast.warn('x'); toast.success('y');", 'probe.jsx', contract, members))
      .toEqual(['probe.jsx:2 — toast.warn']);
    expect(missingMembers("import { toast as t } from '../ui/Toast.jsx';\nt.info('x');", 'probe.jsx', contract, members))
      .toEqual(['probe.jsx:2 — t.info']);
    expect(missingMembers("import toast from './toastish';\ntoast.warn('x');", 'probe.jsx', contract, members)).toEqual([]);
    expect(mockDrift("vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), info: vi.fn() } }));", 'probe.test.jsx', contract, new Set(['default', 'success'])))
      .toEqual(['probe.test.jsx:1 — mocks info']);
  });

  for (const contract of CONTRACT_MODULES) {
    it(`calls only members ${contract.file} exports`, async () => {
      const { api, exportNames } = await contract.load();
      const members = new Set(Object.keys(api));
      const violations = files.flatMap((file) => missingMembers(read(file), file, contract, members));
      expect(violations, 'call a member the module defines, or add the member to the module').toEqual([]);

      const allowed = new Set([...members, ...exportNames, '__esModule']);
      const drift = testFiles.flatMap((file) => mockDrift(read(file), file, contract, allowed));
      expect(drift, 'a mock must not define a member the real module lacks').toEqual([]);
    });
  }

  it('flags a planted mock key the real module does not export', () => {
    const probe = join(CLIENT_ROOT, 'src/__probe.test.jsx');
    expect(scanMockDrift(probe, "vi.mock('./services/socket.js', () => ({ default: {}, plantedDeadKey: vi.fn() }));"))
      .toEqual(['src/__probe.test.jsx:1 — ./services/socket.js mocks plantedDeadKey']);
  });

  it('mocks only members the real modules export', () => {
    const drift = testFiles.flatMap((file) => scanMockDrift(join(CLIENT_ROOT, file), read(file)));
    expect(drift, 'delete the dead key, or mock the module that really exports it').toEqual([]);
    expect(unusedAllowed(MOCK_ADAPTERS, usedAdapters), 'delete the stale MOCK_ADAPTERS entry').toEqual([]);
  }, 60_000); // reads every tracked client test file; a loaded runner overran the 15s default
});
