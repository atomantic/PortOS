// @vitest-environment node

/**
 * Repo-wide guard: `formatCount` (`utils/formatters.js`) is the canonical
 * grouped-integer renderer; a bare `.toLocaleString()` on a number is not.
 *
 * The two disagree in a user-visible way, not just stylistically (#7433):
 *
 *   - Locale. `formatCount` pins `en-US` so a grouped count matches the `$`
 *     beside it (`formatUsd` also pins `en-US`). A bare `.toLocaleString()`
 *     follows the BROWSER locale, so on a non-`en` browser the same screen
 *     renders "1.234" in one span and "1,234" in the next.
 *   - Fractions. `.toLocaleString()` defaults to up to 3 fraction digits;
 *     `formatCount` rounds to 0.
 *   - Missing vs. zero. `formatCount(x)` renders '—' for an unmeasured count
 *     and takes `{ fallback: '0' }` where a measured zero is meant. The
 *     `.toLocaleString()` call sites each hand-rolled their own `?? 0` / `|| 0`
 *     coalesce, inconsistently.
 *
 * `new Date(x).toLocaleString()` is the same anti-pattern for a date/time
 * render — root `AGENTS.md` forbids the inline form; route it through
 * `formatDateTime` or the date helper matching the shape wanted.
 *
 * The rule is therefore structural rather than per-site: any `.toLocaleString(`
 * call outside the allowlist fails this suite.
 *
 * ## Allowlist
 *
 * - `src/utils/formatters.js` — it IS the canonical implementation (`formatCount`
 *   grouping numbers; `formatDateTime`/`formatWeekdayTime`/`formatEventDateTime`
 *   rendering dates through the browser locale on purpose).
 * - `src/components/usage/UsageMeter.jsx` — `formatResetsAt` renders a quota
 *   reset as a compact "Sep 16, 1:30 AM" (month + day + time, no year, no
 *   weekday). No existing helper matches that shape, and it has exactly one
 *   caller — same reasoning `storageConventions.test.js` uses to allowlist
 *   `timeWindow.js` rather than add a single-caller helper. Move it off this
 *   allowlist (into a named `utils/formatters.js` helper) the day a second
 *   caller wants the same shape.
 *
 * ## What this guard CANNOT see
 *
 * It is a source grep, not an AST pass. Comments are stripped (both forms,
 * with a `:` lookbehind so a `https://` URL is not read as a line comment) so
 * prose mentioning "toLocaleString" does not trip the guard; string literals
 * are NOT stripped. Aliasing (`const f = n.toLocaleString`), a computed
 * member (`n['toLocaleString']()`), or a call funneled through a helper in
 * another file all slip through. Those are unusual enough here that the grep
 * earns its keep; closing them means moving to an AST pass.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { trackedSourceFiles } from './test/trackedFiles.js';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const WRAPPER_FILE = 'src/utils/formatters.js';
const ALLOWED = [
  WRAPPER_FILE,
  'src/components/usage/UsageMeter.jsx',
];

const isAllowed = (file) => ALLOWED.includes(file);

/**
 * Block and line comments removed, the same way `storageConventions.test.js`
 * does it — see that file for why the `[^:]` guard before `//` matters.
 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');

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

describe('Number/date formatting goes through utils/formatters', () => {
  it('has no raw .toLocaleString( calls outside the wrapper and its allowlist', () => {
    const files = trackedSourceFiles(CLIENT_ROOT);
    // A broken `git ls-files` (wrong cwd, detached checkout) would otherwise make
    // this guard pass by scanning nothing at all.
    expect(files.length).toBeGreaterThan(100);

    const violations = [];
    for (const file of files) {
      if (isAllowed(file)) continue;
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
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
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
      expect(
        findRawToLocaleString(src).length,
        `${file} no longer calls toLocaleString directly — drop it from the allowlist`,
      ).toBeGreaterThan(0);
    }
  });
});
