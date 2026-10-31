/**
 * Repo-wide touch rule for icon-only buttons (#14416).
 *
 * A `<button>` whose only child is an icon has a tap target the size of the
 * glyph (12–20px) unless its className sizes it. On a phone that is easy to
 * miss, or to mis-tap onto a neighbouring remove control. Mobile audits fixed
 * these one view at a time and new ones kept landing, so this guard holds the
 * line: an icon-only button's literal className carries a sizing utility
 * (`min-h-`/`min-w-`, `size-`, `h-8`+/`w-8`+, `p-2`+) or a `pointer-coarse:`
 * size. Dense desktop rows use `pointer-coarse:min-h-11 pointer-coarse:min-w-11`.
 * Bare `<summary>` disclosures get their touch height from the base rule in
 * `src/index.css`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { trackedSourceFiles } from './test/trackedFiles.js';
import { unsizedIconButtons } from './test/iconButtonScan.js';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('icon-only button touch conventions', () => {
  const files = trackedSourceFiles(CLIENT_ROOT);

  it('scans a populated client tree', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('flags a glyph-sized icon button and clears the sized forms', () => {
    const flagged = (markup) => unsizedIconButtons(markup).length;
    expect(flagged('<button onClick={() => go()} className="text-gray-500 hover:text-white"><X size={14} /></button>')).toBe(1);
    expect(flagged('<button className={`p-1 ${on ? "a" : "b"}`}>\n  <Trash2 className="w-4 h-4" />\n</button>')).toBe(1);
    expect(flagged('<button className="min-h-[44px] min-w-[44px]"><X size={14} /></button>')).toBe(0);
    expect(flagged('<button className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-1"><X size={14} /></button>')).toBe(0);
    expect(flagged('<button className="p-2"><X size={14} /></button>')).toBe(0);
    expect(flagged('<button className="h-9 w-9"><X size={14} /></button>')).toBe(0);
    // A label beside the icon makes the target as big as its text.
    expect(flagged('<button className="p-1"><X size={14} /> Remove</button>')).toBe(0);
  });

  it('sizes every icon-only button for touch', () => {
    const violations = files.flatMap((file) =>
      unsizedIconButtons(readFileSync(join(CLIENT_ROOT, file), 'utf8')).map(({ line }) => `${file}:${line}`));
    expect(violations).toEqual([]);
  });
});
