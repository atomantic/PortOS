/**
 * Guard for the catalogs and barrels `.gitattributes` merges with `union`
 * (rationale: AGENTS.md "Module Organization"). Union keeps both sides of a
 * conflicting hunk — right for an insertion, wrong for an edit or deletion
 * beside one — so this catches the doubled or resurrected line nothing else
 * would, and pins the precondition: every `.js` listed is a pure re-export
 * barrel, where two edits to one line cannot both be right silently.
 *
 * Always-run: a README is documentation to the impact planner, so nothing
 * else would run this on a docs-only rebase.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRUCTURAL_BARRELS } from './ci-test-plan.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const CONFLICT_MARKER_RE = /^(?:<{7}|={7}|>{7})(?:\s|$)/m;
const BARREL_LINE_RE = /^export (?:\*|\* as \w+|\{[^}]+\}) from '(\.\/[^']+)';$/;
const CATALOG_ROW_RE = /^\|\s*`([^`]+)`/;

/** Paths `.gitattributes` assigns `merge=union`, repo-relative. */
export const unionMergedPaths = (gitattributes) => gitattributes
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#') && /\smerge=union(?:\s|$)/.test(line))
  .map((line) => line.split(/\s+/)[0]);

const duplicates = (values) => {
  const seen = new Set();
  const doubled = new Set();
  for (const value of values) (seen.has(value) ? doubled : seen).add(value);
  return [...doubled];
};

/** Non-blank, non-comment barrel lines that are not a single `export … from './x'`. */
export const nonBarrelLines = (lines) => lines
  .filter((line) => line.trim() && !line.trim().startsWith('//') && !BARREL_LINE_RE.test(line));

/**
 * Re-export lines a barrel repeats verbatim. Keyed on the whole line: a hooks
 * barrel legitimately re-exports one module twice (`default as useX`, then a
 * named helper), and only an identical line is the doubled-insertion shape.
 */
export const duplicateBarrelLines = (lines) => duplicates(lines.filter((line) => BARREL_LINE_RE.test(line)));

/** Backtick-named table rows a catalog README lists more than once. */
export const duplicateCatalogRows = (lines) => duplicates(
  lines.map((line) => CATALOG_ROW_RE.exec(line)?.[1]).filter(Boolean),
);

describe('union-merged catalogs and barrels', () => {
  const paths = unionMergedPaths(readFileSync(join(REPO_ROOT, '.gitattributes'), 'utf8'));
  const sources = new Map(paths.map((path) => [path, readFileSync(join(REPO_ROOT, path), 'utf8')]));
  const lines = (path) => sources.get(path).split('\n');
  const barrels = paths.filter((path) => path.endsWith('.js'));
  const catalogs = paths.filter((path) => path.endsWith('.md'));

  it('unions exactly the structural barrels and the catalog beside each', () => {
    // One list in .gitattributes, one in the planner: a barrel missing from
    // either loses union merging (daily conflicts return) or import-graph
    // exclusion, and nothing else would notice.
    expect(barrels.sort()).toEqual([...STRUCTURAL_BARRELS].sort());
    for (const barrel of barrels) {
      expect(catalogs, barrel).toContain(barrel.replace(/index\.js$/, 'README.md'));
    }
  });

  it('detects the shapes it guards against', () => {
    // Bypass probes: each detector must bite on a minimal bad input.
    expect(unionMergedPaths('# c\nfoo.md merge=union\nbar.js text\nbaz.js  merge=union'))
      .toEqual(['foo.md', 'baz.js']);
    expect(duplicateBarrelLines(["export * from './a.js';", "export * as b from './b.js';", "export * from './a.js';"]))
      .toEqual(["export * from './a.js';"]);
    expect(duplicateBarrelLines(["export { default as useA } from './useA.js';", "export { helper } from './useA.js';"]))
      .toEqual([]);
    expect(nonBarrelLines(['// note', "export * from './a.js';", 'const leaked = 1;'])).toEqual(['const leaked = 1;']);
    expect(duplicateCatalogRows(['| `a.js` | one |', '| `b.js` | two |', '| `a.js` | one again |'])).toEqual(['a.js']);
  });

  it('leaves no conflict markers behind', () => {
    for (const [path, source] of sources) expect(source, path).not.toMatch(CONFLICT_MARKER_RE);
  });

  it('only ever unions pure re-export barrels, never a file with code paths', () => {
    for (const path of barrels) {
      expect(nonBarrelLines(lines(path)), `${path} carries lines a union merge cannot arbitrate — drop it from .gitattributes`)
        .toEqual([]);
    }
  });

  it('has no doubled barrel re-export after a union merge', () => {
    for (const path of barrels) {
      expect(duplicateBarrelLines(lines(path)), `${path} repeats a re-export line — a union merge kept a line both branches touched; keep one`)
        .toEqual([]);
    }
  });

  it('has no doubled catalog row after a union merge', () => {
    for (const path of catalogs) {
      expect(duplicateCatalogRows(lines(path)), `${path} lists a module twice — a union merge kept a row both branches touched; keep one`)
        .toEqual([]);
    }
  });
});
