// @vitest-environment node
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';
import { getConfig } from '@testing-library/dom';

import { trackedTestFiles } from './trackedFiles.js';
import { ASYNC_UTIL_TIMEOUT_MS, TEST_TIMEOUT_MS } from './timeouts.js';
import vitestConfig from '../../vitest.config.js';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** This file's own path, as `trackedTestFiles` spells it. */
const SELF = 'src/test/timeouts.test.js';

/** A brace-delimited object literal with no nested braces, and its `key:` names. */
const FLAT_OBJECT = /\{([^{}]*)\}/g;
const OBJECT_KEYS = /(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:/g;
/** `timeout: <number>` inside such an object. */
const TIMEOUT_KEY = /(?:^|,)\s*timeout:\s*([\d_]+)\s*(?:,|$)/;
/**
 * Every option `waitFor` / `findBy*` accept. An object whose keys are all in
 * here is an async bound; one carrying anything else is fixture data that
 * happens to hold a `timeout` field (`src/utils/providers.test.js` has
 * `{ id, timeout }`).
 */
const WAIT_FOR_OPTIONS = new Set([
  'timeout', 'interval', 'onTimeout', 'container', 'mutationObserverOptions',
  'ignore', 'showOriginalStackTrace', 'asyncUtilTimeout',
]);
/**
 * A file raising its own per-test budget. Matched on the `testTimeout` key
 * rather than the bare call, so a file that merely MENTIONS `vi.setConfig` — in
 * a comment, or in this file's own probes — is not silently exempted.
 */
const RAISES_OWN_BUDGET = /vi\.setConfig\(\s*\{[^{}]*\btestTimeout\b/;

/**
 * `source` with comments and the CONTENTS of string/template literals blanked
 * to spaces (offsets preserved), so bracket matching and call discovery never
 * trip on prose or on a `it(\'x\', ...)` inside a comment.
 */
function maskNonCode(source) {
  const out = source.split('');
  const blank = (from, to) => { for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === '\\' ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
    } else i += 1;
  }
  return out.join('');
}

/** Index of the bracket closing the one at `open` in masked source, or -1. */
function matchClose(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    if ('([{'.includes(masked[i])) depth += 1;
    else if (')]}'.includes(masked[i])) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Top-level comma-separated argument spans between `open` and `close` parens. */
function splitArgs(masked, open, close) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i += 1) {
    if ('([{'.includes(masked[i])) depth += 1;
    else if (')]}'.includes(masked[i])) depth -= 1;
    else if (masked[i] === ',' && depth === 0) {
      args.push([start, i]);
      start = i + 1;
    }
  }
  if (masked.slice(start, close).trim()) args.push([start, close]);
  return args;
}

const TEST_CALL = /\b(?:it|test)((?:\.\w+)*)\s*(?=[(`])/g;
const NUMBER_ARG = /^\s*(\d[\d_]*)\s*$/;
const OPTION_ARG = /^\s*\{[^{}]*?\btimeout:\s*(\d[\d_]*)/;

/**
 * Every `it`/`test` call (including `.each` forms) with its source span, its
 * effective explicit timeout (third numeric argument or `{ timeout }` second
 * argument; null when it inherits the suite budget), and the span of a
 * `{ timeout }` options argument, which declares the budget rather than
 * consuming it.
 */
function testCalls(source, masked) {
  const calls = [];
  for (const m of masked.matchAll(TEST_CALL)) {
    let open = m.index + m[0].length;
    if (/\.each\b/.test(m[1])) {
      if (masked[open] === '`') {
        open = masked.indexOf('`', open + 1) + 1;
      } else {
        const tableClose = matchClose(masked, open);
        if (tableClose === -1) continue;
        open = tableClose + 1;
      }
      while (/\s/.test(masked[open] ?? '')) open += 1;
    }
    if (masked[open] !== '(') continue;
    const close = matchClose(masked, open);
    if (close === -1) continue;
    const args = splitArgs(masked, open, close);
    let timeout = null;
    let optionSpan = null;
    if (args.length >= 3) {
      const last = NUMBER_ARG.exec(masked.slice(...args[args.length - 1]));
      const opt = OPTION_ARG.exec(source.slice(...args[1]));
      if (last) timeout = Number(last[1].replace(/_/g, ''));
      else if (opt) {
        timeout = Number(opt[1].replace(/_/g, ''));
        optionSpan = args[1];
      }
    }
    calls.push({ start: open, end: close, timeout, optionSpan });
  }
  return calls;
}

/**
 * Inline async bounds in `source` that the enclosing budget would cut short —
 * the test dies first, so the extended wait never happens and the failure names
 * nothing. Exported so the bypass probe below can prove the detector still
 * fires; a guard whose detector has quietly stopped matching passes forever.
 *
 * Scope is deliberately one-sided. A bound TIGHTER than the suite-wide async
 * budget is a legitimate local choice — several tests assert that something
 * settles fast — while a bound at or above the enclosing budget is inert in
 * every case, which is the one that actually shipped.
 */
export function inertTimeoutBounds(source, budgetMs = TEST_TIMEOUT_MS) {
  if (RAISES_OWN_BUDGET.test(source)) return [];
  const calls = testCalls(source, maskNonCode(source));
  return [...source.matchAll(FLAT_OBJECT)]
    .filter((m) => [...m[1].matchAll(OBJECT_KEYS)].every(([, key]) => WAIT_FOR_OPTIONS.has(key)))
    .filter((m) => !calls.some((c) => c.optionSpan && m.index >= c.optionSpan[0] && m.index < c.optionSpan[1]))
    .flatMap((m) => {
      const digits = TIMEOUT_KEY.exec(m[1])?.[1];
      if (!digits) return [];
      // Innermost enclosing test call decides the budget; outside one, the suite default.
      const enclosing = calls
        .filter((c) => m.index > c.start && m.index < c.end)
        .sort((a, b) => b.start - a.start)[0];
      const budget = enclosing?.timeout ?? budgetMs;
      return Number(digits.replace(/_/g, '')) >= budget ? [digits] : [];
    });
}

describe('client suite time budgets', () => {
  it('applies the shared async budget inside the budgets that enclose it', () => {
    // The EFFECTIVE values, not the module's own constants: `TEST_TIMEOUT_MS >
    // ASYNC_UTIL_TIMEOUT_MS` is unfalsifiable given the `* 3` that derives one
    // from the other, which is the same vacuous shape this file exists to
    // police. What can actually drift is the wiring — setup.js failing to apply
    // the budget, or vitest.config.js growing a hardcoded timeout beside it.
    expect(getConfig().asyncUtilTimeout).toBe(ASYNC_UTIL_TIMEOUT_MS);
    expect(vitestConfig.test.testTimeout).toBeGreaterThan(getConfig().asyncUtilTimeout);
    expect(vitestConfig.test.hookTimeout).toBeGreaterThan(getConfig().asyncUtilTimeout);
  });

  it('has no inline async bound the enclosing budget would cut short', () => {
    // `BeeperTab.test.jsx` carried `{ timeout: 15000 }` against a 5000ms budget
    // for exactly this reason (#7448) — it read as a fix and was not one.
    const files = trackedTestFiles(CLIENT_ROOT).filter((file) => file !== SELF);
    // A broken `git ls-files` would otherwise make this guard pass by scanning
    // nothing at all. Self is excluded above because the probes below are
    // deliberate offenders.
    expect(files.length).toBeGreaterThan(500);

    const offenders = files.flatMap((file) => (
      inertTimeoutBounds(readFileSync(join(CLIENT_ROOT, file), 'utf8'))
        .map((digits) => `${file}: { timeout: ${digits} }`)
    ));
    expect(offenders).toEqual([]);
  });

  it('still detects an inert bound however the option object is written', () => {
    // The bypass probe: without it, a detector that stopped matching anything
    // would report a clean tree forever.
    expect(inertTimeoutBounds('await waitFor(fn, { timeout: 15000 });')).toEqual(['15000']);
    // `interval` is the common co-key on a raised bound — a sole-key pattern
    // missed exactly the shape most likely to appear.
    expect(inertTimeoutBounds('await waitFor(fn, { timeout: 20000, interval: 50 });')).toEqual(['20000']);
    expect(inertTimeoutBounds('await waitFor(fn, { interval: 50, timeout: 20000 });')).toEqual(['20000']);
    expect(inertTimeoutBounds('await waitFor(fn, { timeout: 2000 });')).toEqual([]);
    // A file that genuinely raises its own budget is exempt; merely naming the
    // call in prose is not.
    expect(inertTimeoutBounds('vi.setConfig({ testTimeout: 60000 });\nwaitFor(fn, { timeout: 30000 });')).toEqual([]);
    expect(inertTimeoutBounds('// vi.setConfig( is discussed here\nwaitFor(fn, { timeout: 30000 });')).toEqual(['30000']);
    // An explicit budget on the enclosing test is the effective one...
    expect(inertTimeoutBounds("it('slow', async () => {\n  await waitFor(fn, { timeout: 15000 });\n}, 30000);")).toEqual([]);
    expect(inertTimeoutBounds("it('slow', { timeout: 30000 }, async () => {\n  await waitFor(fn, { timeout: 15000 });\n});")).toEqual([]);
    // ...but only for that test: a sibling with the default budget still fails.
    expect(inertTimeoutBounds("it('slow', async () => {\n  await waitFor(a, { timeout: 15000 });\n}, 30000);\nit('fast', async () => {\n  await waitFor(b, { timeout: 15000 });\n});")).toEqual(['15000']);
    // A bound at or above the explicit budget is still inert.
    expect(inertTimeoutBounds("it('slow', async () => {\n  await waitFor(fn, { timeout: 30000 });\n}, 30000);")).toEqual(['30000']);
    // each forms, array-table and tagged-template.
    expect(inertTimeoutBounds("it.each([[1], [2]])('n %s', async (n) => {\n  await waitFor(fn, { timeout: 15000 });\n}, 30000);")).toEqual([]);
    expect(inertTimeoutBounds("test.each`\n a\n ${1}\n`('n', async () => {\n  await waitFor(fn, { timeout: 15000 });\n}, 30000);")).toEqual([]);
    expect(inertTimeoutBounds("it.each([[1]])('n', async () => {\n  await waitFor(fn, { timeout: 15000 });\n});")).toEqual(['15000']);
    // A test call or timeout that only appears in a comment or string grants nothing.
    expect(inertTimeoutBounds("// it('x', () => {}, 30000)\nit('y', async () => {\n  await waitFor(fn, { timeout: 15000 });\n});")).toEqual(['15000']);
    expect(inertTimeoutBounds("it('y', async () => {\n  // , 30000)\n  await waitFor(fn, { timeout: 15000 });\n});")).toEqual(['15000']);
    // Fixture data that merely carries a `timeout` field is not an async bound.
    expect(inertTimeoutBounds("const p = { id: 'p1', timeout: 300000 };")).toEqual([]);
  });
});
