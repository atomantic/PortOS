/**
 * Repo-wide touch fallback for hover-revealed controls.
 *
 * Tailwind v4 wraps every `hover:` / `group-hover:` / `peer-hover:` rule in
 * `@media (hover: hover)`, so on a touch tablet the reveal never fires. A row
 * action written `sm:opacity-0 sm:group-hover:opacity-100` is therefore
 * invisible at every width ≥640px on an iPad: the delete button still takes a
 * tap at opacity 0 (an unseen destructive target), and a `md:hidden
 * md:group-hover:flex` control cannot be reached at all. This was fixed one site
 * at a time in #9899, #13923, #13924 and #13925 before the rest of the tree was
 * swept.
 *
 * The rule: a class string that hides a control (`opacity-0`, `hidden`,
 * `invisible`, at any breakpoint) and reveals it with a hover-family variant
 * must scope the hide to hover-capable devices — the canonical form is
 * `[@media(hover:hover)]:sm:opacity-0` (`components/Layout.jsx`), which hides
 * exactly where the reveal can run. A string that instead restores the control
 * on touch (`pointer-coarse:opacity-100`, `[@media(hover:none)]:opacity-100`)
 * also passes; `pages/Ask.jsx` uses that form to show its action at full
 * opacity on touch.
 *
 * Deliberately NOT flagged: state hides such as `disabled:opacity-0`, and hover
 * effects that never hide anything (`opacity-70 group-hover:opacity-100`).
 *
 * Scoped to git-tracked non-test sources; comments are masked first so a doc
 * block quoting an example class string is documentation, not markup.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { trackedSourceFiles } from './test/trackedFiles.js';
import { lineOf, maskComments, stringLiterals } from './test/classNameScan.js';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// A hide at the base viewport or behind breakpoint variants only. A state
// variant (`disabled:`, `group-focus:`) is not a hover-dependent hide.
const HIDE = /^(?:(?:sm|md|lg|xl|2xl):)*(?:opacity-0|hidden|invisible)$/;
const HOVER_GATED_HIDE = /^\[@media\(hover:hover\)\]:/;
const HOVER_REVEAL = /(?:^|:)(?:group|peer)-hover(?:\/[\w-]+)?:/;
const TOUCH_RESTORE = /^(?:pointer-coarse|\[@media\(hover:none\)\]):(?:opacity-100|flex|block|inline-flex|visible)$/;

function violationsIn(rawSource, file) {
  const source = maskComments(rawSource);
  return stringLiterals(source)
    .filter(({ value }) => {
      const tokens = value.split(/\s+/).filter(Boolean);
      if (!tokens.some((token) => HOVER_REVEAL.test(token))) return false;
      if (tokens.some((token) => TOUCH_RESTORE.test(token))) return false;
      return tokens.some((token) => HIDE.test(token) && !HOVER_GATED_HIDE.test(token));
    })
    .map(({ value, index }) => `${file}:${lineOf(source, index)} — "${value.trim()}"`);
}

const findViolations = (file) =>
  violationsIn(readFileSync(join(CLIENT_ROOT, file), 'utf8'), file);

describe('hover-reveal touch conventions', () => {
  const files = trackedSourceFiles(CLIENT_ROOT);

  it('scans a populated client tree', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('flags a hover-only reveal and clears every touch-safe form', () => {
    const flagged = (markup) => violationsIn(`<div className="${markup}" />`, 'probe.jsx').length;
    expect(flagged('opacity-40 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100')).toBe(1);
    expect(flagged('md:opacity-0 md:group-hover:opacity-100')).toBe(1);
    expect(flagged('opacity-0 group-hover:opacity-100')).toBe(1);
    expect(flagged('flex md:hidden md:group-hover:flex')).toBe(1);
    expect(flagged('sm:opacity-0 group-hover/folder:opacity-100')).toBe(1);
    expect(flagged('sm:invisible peer-hover:visible')).toBe(1);
    expect(flagged('opacity-40 [@media(hover:hover)]:sm:opacity-0 sm:group-hover:opacity-100')).toBe(0);
    expect(flagged('opacity-40 sm:opacity-0 sm:group-hover:opacity-100 pointer-coarse:opacity-100')).toBe(0);
    expect(flagged('sm:opacity-0 sm:group-hover:opacity-100 [@media(hover:none)]:opacity-100')).toBe(0);
    // Hover effects that never hide, and state hides, are not the bug.
    expect(flagged('opacity-70 group-hover:opacity-100 focus:opacity-100')).toBe(0);
    expect(flagged('opacity-40 group-hover:opacity-100 disabled:opacity-0')).toBe(0);
    // A hide with no hover reveal is a plain responsive hide.
    expect(flagged('hidden sm:flex')).toBe(0);
    expect(violationsIn('// e.g. "sm:opacity-0 sm:group-hover:opacity-100"', 'probe.jsx')).toEqual([]);
  });

  it('never hides a hover-revealed control from touch devices', () => {
    expect(files.flatMap((file) => findViolations(file))).toEqual([]);
  });
});
