/**
 * Rule: An `absolute` element with a base fixed width >= 256px (`w-64`+ or equivalent `w-[…]`) must also carry an unprefixed viewport-relative clamp (`max-w-[calc(100vw-1rem)]`, `max-w-[90vw]`, `max-w-full`, or `max-w-screen`).
 * Fix: Add `max-w-[calc(100vw-1rem)]` (or `max-w-full`) at the base viewport alongside the fixed width.
 * What this guard cannot see:
 *   - Scoped to git-tracked non-test sources (comments masked); `min-w-*`/`max-w-*`, `fixed`, and widths < 256px are not flagged.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { trackedSourceFiles } from '../../trackedFiles.js';
import { lineOf, maskComments, stringLiterals } from '../../classNameScan.js';
import { readText, REPO_ROOT } from '../../../../../scripts/lib/guardCorpus.js';

const CLIENT_ROOT = join(REPO_ROOT, 'client');

// Every token below is matched UNPREFIXED, because the base variant is the phone
// and the phone is the viewport that clips.
const ABSOLUTE = /^absolute$/;

/**
 * The narrowest viewport the app targets is 360px; a panel at or above 256px
 * (`w-64`) is close enough to it that an anchor offset plus a gutter can push it
 * over. Widths are compared in px so the numeric scale and an arbitrary value
 * answer to one threshold.
 */
const MIN_CLAMPED_PX = 256;
// `w-64` — the numeric scale, in 0.25rem steps at a 16px root. `min-w-80` and
// `max-w-96` are not fixed widths: the token doesn't start at `w-`.
const NUMERIC_WIDTH = /^w-(\d+(?:\.\d+)?)$/;
// `w-[19rem]`, `w-[384px]` — the same bug written as an arbitrary value.
const ARBITRARY_WIDTH = /^w-\[(\d+(?:\.\d+)?)(rem|px)\]$/;
const ARBITRARY_CLAMP = /^max-w-\[(.+)\]$/;
const RELATIVE_UNIT = /[dsl]?vw|%/;
const BARE_RELATIVE = /^(\d+(?:\.\d+)?)(?:[dsl]?vw|%)$/;

/** Fixed width in px, or 0 when the token doesn't declare one. */
function fixedWidthPx(token) {
  const numeric = NUMERIC_WIDTH.exec(token);
  if (numeric) return Number(numeric[1]) * 4;
  const arbitrary = ARBITRARY_WIDTH.exec(token);
  if (!arbitrary) return 0;
  return arbitrary[2] === 'rem' ? Number(arbitrary[1]) * 16 : Number(arbitrary[1]);
}

/**
 * Whether the token caps the element against the width actually available.
 * `max-w-96` / `max-w-lg` / `max-w-none` are absolute ceilings and do not — they
 * leave the panel overflowing a phone exactly as before.
 */
function isViewportClamp(token) {
  if (token === 'max-w-full' || token === 'max-w-screen') return true;
  const arbitrary = ARBITRARY_CLAMP.exec(token);
  if (!arbitrary) return false;
  const value = arbitrary[1];
  if (!RELATIVE_UNIT.test(value)) return false;
  // `calc(100vw+10rem)` is relative, but it widens rather than clamps.
  if (value.includes('+')) return false;
  // A bare `200vw` / `200%` is over the available width, not a bound on it.
  const bare = BARE_RELATIVE.exec(value);
  return !bare || Number(bare[1]) <= 100;
}

function violationsIn(rawSource, file) {
  const source = maskComments(rawSource);
  return stringLiterals(source)
    .filter(({ value }) => {
      const tokens = value.split(/\s+/).filter(Boolean);
      if (!tokens.some((token) => ABSOLUTE.test(token))) return false;
      if (Math.max(0, ...tokens.map(fixedWidthPx)) < MIN_CLAMPED_PX) return false;
      return !tokens.some(isViewportClamp);
    })
    .map(({ value, index }) => `${file}:${lineOf(source, index)} — "${value.trim()}"`);
}

const findViolations = (file) =>
  violationsIn(readText(join(CLIENT_ROOT, file)), file);

describe('popover viewport-clamp conventions', () => {
  const files = trackedSourceFiles(CLIENT_ROOT);

  it('scans a populated client tree', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  // Without this the suite would still pass if the detector silently stopped
  // matching anything — a green tree-wide guard proves nothing on its own.
  it('flags an unclamped fixed-width popover and clears every safe form', () => {
    const flagged = (markup) => violationsIn(`<div className="${markup}" />`, 'probe.jsx').length;
    expect(flagged('absolute top-12 right-3 z-20 p-4 w-96 shadow-xl')).toBe(1);
    expect(flagged('absolute right-0 mt-1 w-72 rounded-lg')).toBe(1);
    expect(flagged('absolute right-0 top-full w-64 max-h-80 overflow-y-auto')).toBe(1);
    // A max-height is not a width clamp.
    expect(flagged('absolute w-96 max-h-dvh-cap [--dvh-cap:80dvh]')).toBe(1);
    // The clamp, in either of the tree's two forms, plus the keyword equivalents.
    expect(flagged('absolute right-3 w-96 max-w-[calc(100vw-1rem)] p-4')).toBe(0);
    expect(flagged('absolute w-80 max-w-[90vw] p-3')).toBe(0);
    expect(flagged('absolute w-96 max-w-full')).toBe(0);
    expect(flagged('absolute w-96 max-w-[calc(100%-1rem)]')).toBe(0);
    // An absolute ceiling is not a clamp — it still overflows a 360px phone.
    expect(flagged('absolute w-96 max-w-none')).toBe(1);
    expect(flagged('absolute w-96 max-w-96')).toBe(1);
    expect(flagged('absolute w-96 max-w-lg')).toBe(1);
    expect(flagged('absolute w-96 max-w-screen-sm')).toBe(1);
    // A variant-gated clamp leaves the narrow viewport — the one that clips — bare.
    expect(flagged('absolute w-96 sm:max-w-[calc(100vw-1rem)]')).toBe(1);
    // `min-w-*` is not a fixed width, at any variant prefix.
    expect(flagged('absolute bottom-3 left-3 right-3 sm:right-auto sm:min-w-80')).toBe(0);
    expect(flagged('absolute min-w-96 w-full')).toBe(0);
    // A fixed width that belongs to a variant where the element is no longer
    // absolute is not the bug; the base viewport already clamps.
    expect(flagged('absolute md:static inset-y-0 left-0 w-[80vw] max-w-xs md:w-64')).toBe(0);
    // Narrow panels fit a 360px phone unclamped.
    expect(flagged('absolute right-0 w-56 rounded-lg')).toBe(0);
    // The same bug written as an arbitrary value.
    expect(flagged('absolute top-20 right-4 bottom-24 w-[19rem]')).toBe(1);
    expect(flagged('absolute w-[384px] rounded-lg')).toBe(1);
    expect(flagged('absolute w-[19rem] max-w-[calc(100vw-1rem)]')).toBe(0);
    expect(flagged('absolute w-[12rem] rounded-lg')).toBe(0);
    // Relative units that are not actually a bound.
    expect(flagged('absolute w-96 max-w-[200%]')).toBe(1);
    expect(flagged('absolute w-96 max-w-[calc(100vw+10rem)]')).toBe(1);
    // `fixed` escapes the shell's overflow box; it is positioned to the viewport.
    expect(flagged('fixed bottom-4 right-4 w-96 rounded-lg')).toBe(0);
    // A doc comment quoting an example class string is not markup.
    expect(violationsIn('// e.g. "absolute right-0 w-96"', 'probe.jsx')).toEqual([]);
  });

  it('never fixes a popover wider than a phone without a max-width', () => {
    expect(files.flatMap((file) => findViolations(file))).toEqual([]);
  });
});
