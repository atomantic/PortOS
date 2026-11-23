/**
 * The `vi.mock` contract scan (`scripts/lib/mockContractScan.js`, #17598) flags a
 * dead relative specifier, a module registered twice, and a factory key the real
 * module does not export, for every factory shape (literal, spread override,
 * block body). Planted violations run against a fixture tree so the scan's
 * resolution and export reading are exercised end to end, and the valid shapes
 * pin that comments, strings and template literals never read as live mocks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockDrift, unusedAllowed } from './mockContractScan.js';

let root;
let testFile;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mock-contract-scan-'));
  mkdirSync(join(root, 'svc'));
  writeFileSync(join(root, 'svc', 'store.js'), 'export function getThing() {}\nexport const other = 1;\n');
  writeFileSync(join(root, 'svc', 'peer.js'), 'export const peer = 1;\n');
  testFile = join(root, 'svc', 'probe.test.js');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const scan = (lines, options = {}) => mockDrift(testFile, lines.join('\n'), { root, ...options });

describe('dead relative specifiers', () => {
  it('flags a relative path that resolves to no file, with or without a factory', () => {
    expect(scan([
      "vi.mock('./missing.js', () => ({ x: vi.fn() }));",
      "vi.mock('../nowhere/peer.js');",
      "vi.mock('./helper.js', () => makeHelper());",
    ])).toEqual([
      'svc/probe.test.js:1 — ./missing.js does not resolve',
      'svc/probe.test.js:2 — ../nowhere/peer.js does not resolve',
      'svc/probe.test.js:3 — ./helper.js does not resolve',
    ]);
  });

  it('resolves an extensionless specifier and skips bare package specifiers', () => {
    expect(scan([
      "vi.mock('./store', () => ({ getThing: vi.fn() }));",
      "vi.mock('node:fs', () => ({ anything: 1 }));",
      "vi.mock('some-package', () => ({ anything: 1 }));",
      "vi.mock(`./${name}.js`, () => ({ anything: 1 }));",
    ])).toEqual([]);
  });

  it('ignores a vi.mock that sits in a comment or a string', () => {
    expect(scan([
      "// vi.mock('./missing.js', () => ({ x: 1 }));",
      "/* vi.mock('./missing.js') */",
      "const doc = \"vi.mock('./missing.js')\";",
      "const tpl = `vi.mock('./missing.js')`;",
    ])).toEqual([]);
  });

  it('honors an allowlist entry and reports it as used', () => {
    const allowed = new Map([['svc/probe.test.js|./virtual.js|<unresolved>', 'virtual module']]);
    const used = new Set();
    expect(scan(["vi.mock('./virtual.js', () => ({}));"], { allowed, used })).toEqual([]);
    expect(unusedAllowed(allowed, used)).toEqual([]);
    expect(unusedAllowed(allowed, new Set())).toEqual(['svc/probe.test.js|./virtual.js|<unresolved>']);
  });
});

describe('duplicate registrations', () => {
  it('flags a second vi.mock for the same resolved module, however it is spelled', () => {
    expect(scan([
      "vi.mock('./store.js', () => ({ getThing: vi.fn() }));",
      "vi.mock('./peer.js', () => ({ peer: 1 }));",
      "vi.mock('./store', () => ({ other: 2 }));",
      "vi.mock('./store.js', () => ({ other: 3 }));",
    ])).toEqual([
      'svc/probe.test.js:3 — ./store duplicates the vi.mock at line 1, which this one replaces',
      'svc/probe.test.js:4 — ./store.js duplicates the vi.mock at line 1, which this one replaces',
    ]);
  });

  it('does not count a commented-out registration as the first one', () => {
    expect(scan([
      "// vi.mock('./store.js', () => ({}));",
      "vi.mock('./store.js', () => ({ getThing: vi.fn() }));",
    ])).toEqual([]);
  });

  it('honors a <duplicate> allowlist entry', () => {
    const allowed = new Map([['svc/probe.test.js|./store.js|<duplicate>', 'intentional re-registration']]);
    expect(scan([
      "vi.mock('./store.js', () => ({}));",
      "vi.mock('./store.js', () => ({}));",
    ], { allowed })).toEqual([]);
  });
});

describe('factory keys', () => {
  it('flags a dead key in a literal factory', () => {
    expect(scan(["vi.mock('./store.js', () => ({ getThing: vi.fn(), deadKey: vi.fn() }));"]))
      .toEqual(['svc/probe.test.js:1 — ./store.js mocks deadKey']);
  });

  it('checks the explicit keys beside a spread override, not the spread', () => {
    expect(scan([
      "vi.mock('./store.js', async (importOriginal) => ({",
      '  ...await importOriginal(),',
      '  getThing: vi.fn(),',
      '  deadKey: vi.fn(),',
      '}));',
    ])).toEqual(['svc/probe.test.js:4 — ./store.js mocks deadKey']);
    expect(scan(["vi.mock('./store.js', async () => ({ ...(await vi.importActual('./store.js')), other: 2 }));"])).toEqual([]);
  });

  it('checks the top-level return of a block-body factory', () => {
    expect(scan([
      "vi.mock('./store.js', async (importOriginal) => {",
      '  const actual = await importOriginal();',
      '  const helper = () => { return { nested: 1 }; };',
      '  return { ...actual, getThing: vi.fn(helper), deadKey: vi.fn() };',
      '});',
    ])).toEqual(['svc/probe.test.js:4 — ./store.js mocks deadKey']);
    expect(scan([
      "vi.mock('./store.js', () => {",
      '  const other = vi.fn();',
      '  return { other, getThing: () => ({ inner: 1 }) };',
      '});',
    ])).toEqual([]);
  });

  it('reads a parenthesised block return and quoted keys', () => {
    expect(scan([
      "vi.mock('./store.js', () => { return ({ 'quotedDead': 1, getThing: 1 }); });",
    ])).toEqual(['svc/probe.test.js:1 — ./store.js mocks quotedDead']);
  });

  it('skips a factory that is not an object literal and keeps __esModule', () => {
    expect(scan([
      "vi.mock('./store.js', () => makeStore());",
      "vi.mock('./peer.js', () => ({ __esModule: true, peer: 1 }));",
    ])).toEqual([]);
  });

  it('does not read keys in comments, strings or template literals', () => {
    expect(scan([
      "vi.mock('./store.js', () => ({",
      "  // deadComment: vi.fn(),",
      "  getThing: vi.fn(() => 'deadString: 1'),",
      '  other: `${1}, deadTemplate: 2`,',
      '}));',
    ])).toEqual([]);
  });

  it('honors a key allowlist entry', () => {
    const allowed = new Map([['svc/probe.test.js|./store.js|__backend', 'sentinel']]);
    const used = new Set();
    expect(scan(["vi.mock('./store.js', () => ({ __backend: 'x' }));"], { allowed, used })).toEqual([]);
    expect([...used]).toEqual(['svc/probe.test.js|./store.js|__backend']);
  });
});
