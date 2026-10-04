/**
 * Cross-module contract guards for an untyped client.
 *
 * PortOS's client is plain JavaScript, so nothing checks that a call site and
 * the module it imports agree. `toast.info(...)` shipped at ~30 call sites
 * while the shared Toast API had no `info` member: every one threw
 * `toast.info is not a function` at runtime, and the component tests stayed
 * green because 54 of them mocked Toast WITH an `info` the real module lacked.
 * No scheduled audit owned that class — `typing` only runs on TypeScript repos,
 * `ui-bugs` needs a live reproduction, and `api-contract` stops at HTTP.
 *
 * Three rules, each cheap and deterministic:
 *
 * 1. Every `<local>.<member>` read on an imported object-API module names a
 *    member the real export has. `CONTRACT_MODULES` lists the modules whose
 *    default export is a member-bag; add a row when another shared module
 *    takes that shape.
 * 2. A test's `vi.mock` factory for one of those modules defines only members
 *    the real export has, so a mock cannot paper over a missing member again.
 * 3. No browser `alert`/`confirm`/`prompt` (client/src/AGENTS.md: inline
 *    confirmations or toasts instead). Blocking dialogs freeze the tab and are
 *    unusable from a PWA or a remote session.
 *
 * Scoped to git-tracked sources under `client/src`; comments are masked first.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { trackedSourceFiles } from './test/trackedFiles.js';
import { lineOf, maskComments } from './test/classNameScan.js';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Shared modules whose default export is an object API callers dot into. */
const CONTRACT_MODULES = [
  {
    file: 'src/components/ui/Toast.jsx',
    // Import specifiers end in one of these (with or without the extension).
    specifier: /(?:^|\/)ui\/Toast(?:\.jsx)?$/,
    namedAliases: ['toast'],
    load: async () => {
      const mod = await import('./components/ui/Toast.jsx');
      return { api: mod.default, exportNames: Object.keys(mod) };
    },
  },
];

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

const BLOCKING_DIALOG_RE = /(?<![\w$.])(?:window\.)?(alert|confirm)\s*\(/g;

/** Calls to the browser's blocking dialogs (bare or via `window.`). */
export function blockingDialogs(rawSource, file) {
  const source = maskComments(rawSource)
    // A declaration or method shorthand named confirm/prompt is not a call to the global.
    .replace(/\bfunction\s+(?:alert|confirm)\s*\(/g, 'function _(');
  return [...source.matchAll(BLOCKING_DIALOG_RE)]
    // `confirm(id) {` / `confirm(id) =>` is a method or callback being defined, not a call.
    .filter((match) => match[0].startsWith('window.')
      || !/^[^)]*\)\s*(?:\{|=>)/.test(source.slice(match.index + match[0].length).split('\n')[0]))
    .map((match) => `${file}:${lineOf(source, match.index)} — ${match[0].replace(/\s*\($/, '')}()`);
}

const read = (file) => readFileSync(join(CLIENT_ROOT, file), 'utf8');

const trackedTestFiles = () => execSync('git ls-files src', { cwd: CLIENT_ROOT, encoding: 'utf8' })
  .trim().split('\n').filter((f) => /\.test\.jsx?$/.test(f));

describe('module contract conventions', () => {
  const files = trackedSourceFiles(CLIENT_ROOT);

  it('scans a populated client tree', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('detects a missing member, a drifted mock and a blocking dialog', () => {
    const [contract] = CONTRACT_MODULES;
    const members = new Set(['success', 'warning']);
    expect(missingMembers("import toast from '../ui/Toast';\ntoast.warn('x'); toast.success('y');", 'probe.jsx', contract, members))
      .toEqual(['probe.jsx:2 — toast.warn']);
    expect(missingMembers("import { toast as t } from '../ui/Toast.jsx';\nt.info('x');", 'probe.jsx', contract, members))
      .toEqual(['probe.jsx:2 — t.info']);
    expect(missingMembers("import toast from './toastish';\ntoast.warn('x');", 'probe.jsx', contract, members)).toEqual([]);
    expect(mockDrift("vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), info: vi.fn() } }));", 'probe.test.jsx', contract, new Set(['default', 'success'])))
      .toEqual(['probe.test.jsx:1 — mocks info']);
    expect(blockingDialogs("if (!confirm('Delete?')) return;\nwindow.alert('x');", 'probe.jsx'))
      .toEqual(['probe.jsx:1 — confirm()', 'probe.jsx:2 — window.alert()']);
    expect(blockingDialogs("const confirm = useConfirmDelete();\ndeleteConfirm.confirm();\n// confirm('x')", 'probe.jsx')).toEqual([]);
  });

  for (const contract of CONTRACT_MODULES) {
    it(`calls only members ${contract.file} exports`, async () => {
      const { api, exportNames } = await contract.load();
      const members = new Set(Object.keys(api));
      const violations = files.flatMap((file) => missingMembers(read(file), file, contract, members));
      expect(violations, 'call a member the module defines, or add the member to the module').toEqual([]);

      const allowed = new Set([...members, ...exportNames, '__esModule']);
      const drift = trackedTestFiles().flatMap((file) => mockDrift(read(file), file, contract, allowed));
      expect(drift, 'a mock must not define a member the real module lacks').toEqual([]);
    });
  }

  it('never calls the browser alert/confirm/prompt dialogs', () => {
    const violations = files.flatMap((file) => blockingDialogs(read(file), file));
    expect(violations, 'use an inline confirmation (useConfirmDelete + ConfirmButtonPair) or a toast').toEqual([]);
  });
});
