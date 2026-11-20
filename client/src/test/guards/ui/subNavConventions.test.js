/**
 * Rule: No `border-b-2` in a class string under `client/src/` outside `TabPills` and allowlisted files (see `client/src/AGENTS.md`).
 * Fix: Replace hand-rolled underline sub-navs with `TabPills` (`TabPills.mobileCompact`).
 * What this guard cannot see:
 *   - Scoped to git-tracked non-test sources under `client/src` (comments masked).
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { trackedSourceFiles } from '../../trackedFiles.js';
import { lineOf, maskComments, stringLiterals } from '../../classNameScan.js';
import { readText, REPO_ROOT } from '../../../../../scripts/lib/guardCorpus.js';

const CLIENT_ROOT = join(REPO_ROOT, 'client');

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
  violationsIn(readText(join(CLIENT_ROOT, file)), file);

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
