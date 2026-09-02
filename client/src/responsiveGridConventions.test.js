/**
 * Repo-wide responsive-grid convention.
 *
 * `client/src/AGENTS.md` requires every page to be mobile responsive, and the
 * overwhelming majority of grids in the tree already carry a column breakpoint
 * (`grid-cols-1 sm:grid-cols-2 xl:grid-cols-3`). The failure mode this guard
 * catches is the one that keeps slipping through review: a stat/summary bar
 * hard-coding four or five columns with no breakpoint prefix at all. At a 360px
 * viewport that leaves each card ~65px of outer width — after its own padding,
 * ~34px of content — so a label like "Platform Accounts" wraps to five lines and
 * the whole above-the-fold region becomes unreadable (issue #5679).
 *
 * The rule: a `className` string holding a bare `grid-cols-N` for N >= 4 must
 * also hold at least one *prefixed* `…:grid-cols-*` in the same string, so the
 * wide layout is something the viewport opts into rather than the phone default.
 * Any variant prefix counts — a media breakpoint (`sm:`), a container query
 * (`@3xl:`), or a custom variant — because each of them makes the column count
 * conditional on available width.
 *
 * Scoped to git-tracked non-test sources under `client/src` so an untracked
 * scratch file can't fail the suite. Comments are masked first: a doc comment
 * quoting an example class string is documentation, not markup.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { trackedSourceFiles } from './test/trackedFiles.js';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Grids that are legitimately N-across on a phone, with the reason they are.
 * Adding a row here is a deliberate design call, not a way past the guard — the
 * cell has to stay readable at 360px on its own merits.
 */
const ALLOWED = new Map([
  [
    'src/components/calendar/MonthView.jsx',
    'A month grid is inherently seven days wide; collapsing the columns would stop it being a calendar.',
  ],
  [
    'src/components/digital-twin/tabs/ImportTab.jsx',
    'Big Five traits are a fixed five-across bar chart; each cell is one bar plus a five-character label, kept legible with a reduced gap and a smaller label below `sm`.',
  ],
  [
    'src/components/digital-twin/InterviewAnalysisCard.jsx',
    'Same Big Five five-across readout, in the interview-analysis summary.',
  ],
]);

/** Blank out `//` and block comments so a quoted example class isn't scanned as markup. */
function maskComments(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      out += ch;
      i += 1;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === '\\') {
          out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += source[i];
        i += 1;
      }
      out += source[i] ?? '';
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const STRING_LITERAL = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
// A column count that is the phone default: no `variant:` in front of it.
const BARE_WIDE_GRID = /(?:^|\s)grid-cols-(\d+)(?=\s|$)/;
// Any variant prefix — `sm:`, `lg:`, `@3xl:`, `roomy-viewport:` — makes it conditional.
const PREFIXED_GRID = /[\w@[\]().\-/]+:grid-cols-/;
const MIN_WIDE_COLUMNS = 4;

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

function violationsIn(rawSource, file) {
  const source = maskComments(rawSource);
  const found = [];
  let match;
  STRING_LITERAL.lastIndex = 0;
  while ((match = STRING_LITERAL.exec(source))) {
    const value = match[2];
    const bare = value.match(BARE_WIDE_GRID);
    if (!bare || Number(bare[1]) < MIN_WIDE_COLUMNS) continue;
    if (PREFIXED_GRID.test(value)) continue;
    found.push(`${file}:${lineOf(source, match.index)} — "${value.trim()}"`);
  }
  return found;
}

const findViolations = (file) =>
  violationsIn(readFileSync(join(CLIENT_ROOT, file), 'utf8'), file);

describe('responsive grid conventions', () => {
  const files = trackedSourceFiles(CLIENT_ROOT);

  it('scans a populated client tree', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  // Without this the suite would still pass if the detector silently stopped
  // matching anything — a green tree-wide guard proves nothing on its own.
  it('flags a bare wide grid and clears every conditional form', () => {
    const flagged = (markup) => violationsIn(`<div className="${markup}" />`, 'probe.jsx').length;
    expect(flagged('grid grid-cols-4 gap-4 mb-6')).toBe(1);
    expect(flagged('grid grid-cols-5 gap-2')).toBe(1);
    expect(flagged('grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4')).toBe(0);
    expect(flagged('grid grid-cols-4 sm:grid-cols-8 lg:grid-cols-12 gap-1.5')).toBe(0);
    expect(flagged('grid grid-cols-2 gap-3 @3xl:grid-cols-4')).toBe(0);
    // Narrow grids are fine unprefixed — three stat cards still fit at 360px.
    expect(flagged('grid grid-cols-3 gap-2')).toBe(0);
    // A doc comment quoting an example class string is not markup.
    expect(violationsIn('// e.g. "grid grid-cols-4 gap-4"', 'probe.jsx')).toEqual([]);
  });

  it('never hard-codes four or more columns without a breakpoint', () => {
    const violations = files
      .filter((file) => !ALLOWED.has(file))
      .flatMap((file) => findViolations(file));
    expect(violations).toEqual([]);
  });

  it('keeps the allowlist honest — every exempt file still has the wide grid it was exempted for', () => {
    const stale = [...ALLOWED.keys()].filter((file) => findViolations(file).length === 0);
    expect(stale).toEqual([]);
  });
});
