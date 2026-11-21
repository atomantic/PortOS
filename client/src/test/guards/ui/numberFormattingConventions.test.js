/**
 * Rule: Use `formatCount`, `formatPercent`, `formatUsd`, and `formatDateTime` (`utils/formatters.js`) instead of bare `.toLocaleString()` or hand-rolled `toFixed` percent/USD strings (see root `AGENTS.md`).
 * Fix: Replace `.toLocaleString()` with `formatCount` / `formatDateTime`, and replace `` `${x.toFixed(...)}%` `` / `` `$${x.toFixed(...)}` `` with `formatPercent` / `formatUsd`.
 * What this guard cannot see:
 *   - String literals are not stripped (comments are stripped).
 *   - Aliasing (`const f = n.toLocaleString`), computed members (`n['toLocaleString']()`), or calls funneled through another file's helper.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { trackedSourceFiles } from '../../trackedFiles.js';
import { stripComments } from '../../stripComments.js';
import { readText, REPO_ROOT } from '../../../../../scripts/lib/guardCorpus.js';

const CLIENT_ROOT = join(REPO_ROOT, 'client');

const WRAPPER_FILE = 'src/utils/formatters.js';
const ALLOWED = [
  WRAPPER_FILE,
  'src/components/usage/UsageMeter.jsx',
];

const isAllowed = (file) => ALLOWED.includes(file);

/**
 * `.toLocaleString(` preceded by a member-access dot or `?.`. Matches with or
 * without call arguments — a locale-pinned `.toLocaleString('en-US')` is the
 * same anti-pattern as a bare `.toLocaleString()`, just already half-fixed.
 */
const RAW_TO_LOCALE_STRING = /\??\.\s*toLocaleString\s*\(/g;

/** Raw `.toLocaleString(` calls in `src`, as matched snippets. */
export function findRawToLocaleString(src) {
  return [...stripComments(src).matchAll(RAW_TO_LOCALE_STRING)].map((m) => m[0].trim());
}

/**
 * `toFixed(n)` immediately followed by a `%` — in a template (`${x.toFixed(1)}%`),
 * in JSX text (`{x.toFixed(1)}%`), or concatenated (`x.toFixed(1) + '%'`).
 */
const HAND_ROLLED_PERCENT = /\.toFixed\s*\([^)]*\)\s*(?:\}|\+\s*['"`])\s*%/g;

/**
 * `toFixed(n)` rendered as a dollar amount: `$${x.toFixed(2)}` in a template, or
 * JSX text `${x.toFixed(2)}` (a `$` right before the expression container). The
 * JSX form is only read on a line with no backtick before it, because inside a
 * template literal a bare `${x.toFixed(2)}` is ordinary interpolation.
 */
const TEMPLATE_USD = /\$\$\{[^}]*\.toFixed\s*\(/g;
const JSX_USD = /^[^`]*\$\{[^}]*\.toFixed\s*\(/;

/** Hand-rolled `toFixed` percent / USD renders in `src`, as matched snippets. */
export function findHandRolledPercentOrUsd(src) {
  const code = stripComments(src);
  const hits = [...code.matchAll(HAND_ROLLED_PERCENT), ...code.matchAll(TEMPLATE_USD)].map((m) => m[0].trim());
  for (const line of code.split('\n')) {
    if (JSX_USD.test(line)) hits.push(line.trim());
  }
  return hits;
}

describe('Number/date formatting goes through utils/formatters', () => {
  it('has no raw .toLocaleString( calls outside the wrapper and its allowlist', () => {
    const files = trackedSourceFiles(CLIENT_ROOT);
    // A broken `git ls-files` (wrong cwd, detached checkout) would otherwise make
    // this guard pass by scanning nothing at all.
    expect(files.length).toBeGreaterThan(100);

    const violations = [];
    for (const file of files) {
      if (isAllowed(file)) continue;
      const src = readText(join(CLIENT_ROOT, file));
      for (const hit of findRawToLocaleString(src)) violations.push(`${file}: ${hit}`);
    }

    expect(
      violations,
      'These files call `.toLocaleString(` directly. A NUMBER should render through '
      + '`formatCount` (thousands-grouped, en-US-pinned, matches the `$` beside it) — '
      + 'pass `{ fallback: \'0\' }` only where an ABSENT count should read as zero. A '
      + 'DATE should render through `formatDateTime` or the helper matching the shape '
      + 'wanted (see the exports list in `utils/formatters.js`).\n'
      + `Offenders:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  it('has no hand-rolled toFixed percent or USD outside utils/formatters', () => {
    const files = trackedSourceFiles(CLIENT_ROOT);
    expect(files.length).toBeGreaterThan(100);

    const violations = [];
    for (const file of files) {
      if (file === WRAPPER_FILE) continue;
      const src = readText(join(CLIENT_ROOT, file));
      for (const hit of findHandRolledPercentOrUsd(src)) violations.push(`${file}: ${hit}`);
    }

    expect(
      violations,
      'These files format a percentage or dollar amount with `toFixed`. Use '
      + '`formatPercent(value, { decimals })` (value already 0–100; multiply a fraction by 100 first) '
      + 'or `formatUsd(value)` from `utils/formatters` — they render a missing value as `—`, '
      + 'drop float noise, and group thousands.\n'
      + `Offenders:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  it('flags a hand-rolled percent or USD shape and accepts the formatters', () => {
    expect(findHandRolledPercentOrUsd('const s = `${x.toFixed(1)}%`;')).toHaveLength(1);
    expect(findHandRolledPercentOrUsd('<span>{p.cpu?.toFixed(0)}% CPU</span>')).toHaveLength(1);
    expect(findHandRolledPercentOrUsd("const s = x.toFixed(1) + '%';")).toHaveLength(1);
    expect(findHandRolledPercentOrUsd('parts.push(`$${usage.costUsd.toFixed(4)}`);')).toHaveLength(1);
    expect(findHandRolledPercentOrUsd('<b>${spend.spentUsd.toFixed(2)}</b>')).toHaveLength(1);

    expect(findHandRolledPercentOrUsd('formatPercent(x * 100, { decimals: 0 })')).toEqual([]);
    expect(findHandRolledPercentOrUsd('formatUsd(spend.spentUsd)')).toEqual([]);
    // Non-percent / non-currency `toFixed` uses stay legal: seconds, SVG coordinates,
    // and a plain template interpolation of a number.
    expect(findHandRolledPercentOrUsd('`${t.toFixed(2)}s / ${d.toFixed(1)}s`')).toEqual([]);
    expect(findHandRolledPercentOrUsd('`${x.toFixed(1)},${y.toFixed(1)}`')).toEqual([]);
    expect(findHandRolledPercentOrUsd('// shows `${x.toFixed(1)}%` today')).toEqual([]);
  });

  // Guards the guard: if the detector stops recognizing the call, the scan
  // above goes vacuously green and the bug class walks straight back in.
  it('flags every call shape and ignores prose that merely names the method', () => {
    expect(findRawToLocaleString('n.toLocaleString()')).toEqual(['.toLocaleString(']);
    expect(findRawToLocaleString("n.toLocaleString('en-US')")).toEqual(['.toLocaleString(']);
    expect(findRawToLocaleString('count?.toLocaleString()')).toEqual(['?.toLocaleString(']);
    expect(findRawToLocaleString('d.toLocaleString(undefined, { month: "short" })')).toEqual(['.toLocaleString(']);

    expect(findRawToLocaleString('formatCount(n)')).toEqual([]);
    expect(findRawToLocaleString('formatDateTime(d)')).toEqual([]);
    // A comment naming the method is not a call.
    expect(findRawToLocaleString(
      '// prefer formatCount over toLocaleString() for a user-facing count\nconst x = 1;',
    )).toEqual([]);
  });

  // The allowlist must keep naming files that really exist and really carry the
  // shape — otherwise a rename turns an exemption into silent dead config.
  it('allowlists only files that exist and still call toLocaleString directly', () => {
    const tracked = trackedSourceFiles(CLIENT_ROOT);
    for (const file of ALLOWED) {
      expect(tracked, `${file} is allowlisted but no longer tracked`).toContain(file);
      const src = readText(join(CLIENT_ROOT, file));
      expect(
        findRawToLocaleString(src).length,
        `${file} no longer calls toLocaleString directly — drop it from the allowlist`,
      ).toBeGreaterThan(0);
    }
  });
});
