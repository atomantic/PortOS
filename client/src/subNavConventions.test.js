/**
 * Repo-wide sub-nav convention.
 *
 * `client/src/AGENTS.md` requires a section sub-nav that doesn't fit a phone
 * to collapse to icon links via `TabPills.mobileCompact`, not a `<select>` and
 * not a hand-rolled underline bar. Every bar that already routes through
 * `TabPills` gets that treatment; the failure mode this guard catches is a new
 * `<nav>`/`<div>` that maps a tab array onto `border-b-2`-styled buttons or
 * `Link`s and so ships a third answer to "what does a sub-nav do on a phone".
 *
 * The rule is deliberately blunt: **no `border-b-2` in a class string** under
 * `src/` except in the primitive itself and an allowlisted file carrying a
 * one-line reason. TabPills owns that underline token; a caller that needs it
 * is a caller that should be a TabPills. Unbounded record switchers (shell
 * sessions, manuscript issues, Beeper accounts) do not use this token and so
 * do not match — they are not section sub-navs.
 *
 * Scoped to git-tracked non-test sources under `client/src`. Comments are
 * masked first: a doc comment quoting `border-b-2` is documentation, not markup.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { trackedSourceFiles } from './test/trackedFiles.js';
import { lineOf, maskComments, stringLiterals } from './test/classNameScan.js';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Files allowed to carry `border-b-2`, each with the reason it is not a
 * section sub-nav. Adding a row is the point at which to ask whether TabPills
 * fits instead.
 */
const ALLOWED = new Map([
  [
    'src/components/ui/TabPills.jsx',
    'the primitive this guard exists to funnel callers into',
  ],
  [
    'src/components/pipeline/manuscript/ManuscriptHighlightedProse.jsx',
    'underline on comment-anchored prose, not a section sub-nav',
  ],
  [
    'src/components/pipeline/manuscript/ManuscriptLiveSection.jsx',
    'same comment-anchor underline in the live editor',
  ],
]);

const BORDER_TOKEN = /(?:^|[\s'"`{])border-b-2(?=[\s'"`}]|$)/;

function violationsIn(rawSource, file) {
  const source = maskComments(rawSource);
  return stringLiterals(source)
    .filter(({ value }) => BORDER_TOKEN.test(value))
    .map(({ value, index }) => `${file}:${lineOf(source, index)} — "${value.trim()}"`);
}

const findViolations = (file) =>
  violationsIn(readFileSync(join(CLIENT_ROOT, file), 'utf8'), file);

describe('sub-nav conventions', () => {
  const files = trackedSourceFiles(CLIENT_ROOT);

  it('scans a populated client tree', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('flags a hand-rolled border-b-2 tab strip and clears the primitive', () => {
    const flagged = (markup) => violationsIn(markup, 'probe.jsx').length;
    expect(flagged('<button className="px-4 py-2 border-b-2 border-port-accent">Overview</button>')).toBe(1);
    expect(flagged('<Link className={`inline-flex border-b-2 ${active ? "border-port-accent" : "border-transparent"}`} />')).toBe(1);
    expect(flagged('<button className="px-4 py-2 border-b border-port-border">Overview</button>')).toBe(0);
    expect(violationsIn('// e.g. "border-b-2 border-port-accent"', 'probe.jsx')).toEqual([]);
  });

  it('never hand-rolls a border-b-2 tab strip outside TabPills', () => {
    const violations = files
      .filter((file) => !ALLOWED.has(file))
      .flatMap((file) => findViolations(file));
    expect(violations).toEqual([]);
  });

  it('keeps the allowlist honest — every exempt file still has the underline it was exempted for', () => {
    const stale = [...ALLOWED.keys()].filter((file) => findViolations(file).length === 0);
    expect(stale).toEqual([]);
  });
});
