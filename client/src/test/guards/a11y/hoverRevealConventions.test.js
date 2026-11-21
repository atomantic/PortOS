/**
 * Rule: A class string that hides a control (`opacity-0`, `hidden`, `invisible`) and reveals it on hover must scope the hide to hover-capable devices (`[@media(hover:hover)]:…`) or restore it on touch (`pointer-coarse:opacity-100`).
 * Fix: Prefix the hide with `[@media(hover:hover)]:` or add `[@media(hover:none)]:opacity-100` / `pointer-coarse:opacity-100`.
 * What this guard cannot see:
 *   - Scoped to git-tracked non-test sources (comments masked); state hides like `disabled:opacity-0` and non-hiding hovers are not flagged.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { trackedSourceFiles } from '../../trackedFiles.js';
import { lineOf, maskComments, stringLiterals } from '../../classNameScan.js';
import { readText, REPO_ROOT } from '../../../../../scripts/lib/guardCorpus.js';

const CLIENT_ROOT = join(REPO_ROOT, 'client');

// A hide at the base viewport or behind breakpoint variants only. A state
// variant (`disabled:`, `group-focus:`) is not a hover-dependent hide.
const HIDE = /^(?:(?:sm|md|lg|xl|2xl):)*(?:opacity-0|hidden|invisible)$/;
const HOVER_GATED_HIDE = /^\[@media\(hover:hover\)\]:/;
// Only a hover variant that SHOWS something is a reveal; `group-hover:text-white`
// beside a plain responsive `hidden md:inline` is not.
const HOVER_REVEAL = /(?:^|:)(?:group|peer)-hover(?:\/[\w-]+)?:(?:opacity-\d+|visible|flex|block|inline|inline-flex|inline-block|grid)$/;
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
  violationsIn(readText(join(CLIENT_ROOT, file)), file);

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
    expect(flagged('hidden md:inline group-hover:text-white')).toBe(0);
    expect(violationsIn('// e.g. "sm:opacity-0 sm:group-hover:opacity-100"', 'probe.jsx')).toEqual([]);
  });

  it('never hides a hover-revealed control from touch devices', () => {
    expect(files.flatMap((file) => findViolations(file))).toEqual([]);
  });
});
