/**
 * Position invariance — the property every checked-in generated manifest owes
 * the people who rebase onto it.
 *
 * A `*.generated.json` is kept honest by a drift test that regenerates and
 * compares, which only works if the file changes when the thing it describes
 * changes — and *only* then. The "only" is the half that rots. A manifest
 * recording `foo.js:412` is rewritten by any edit that inserts a line above
 * 412: a comment, a rename, an unrelated handler. The drift test then fires on
 * commits that change nothing it describes, every parallel branch regenerates
 * it differently, and every rebase conflicts on it.
 *
 * The direct way to prove a generator is clean is to test the property rather
 * than guess at the vocabulary that violates it. Shift every position in the
 * inputs — without touching anything a manifest is supposed to describe — and
 * demand byte-identical output. That catches a `line`, and equally an `at`, a
 * `span`, a `row`, a `loc: [412, 8]` tuple, or a `foo.js#L412` anchor: every
 * spelling of a position, including the ones nobody thought to deny-list.
 *
 * `server/lib/generatedManifests.test.js` is the cheap tree-wide net that
 * catches a manifest whose generator never adopted this; this module is how a
 * generator proves it directly. Use both.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Two comment lines. Prepending them shifts every line number, byte offset,
 * and character index in the file below without altering one token of the
 * code a manifest actually describes.
 */
const SHIFT_HEADER = '// position-invariance probe: shifts every line and offset below it.\n'
  + '// Nothing a generated manifest describes lives in these two lines.\n';

/** Every file under `dir`, recursively. One `readdir` per directory, no `stat` per entry. */
export const walkFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? walkFiles(path) : [path];
});

/** Shift the positions in one in-memory source string. */
export const shiftSourceText = (source) => `${SHIFT_HEADER}${source}`;

/**
 * Shift the positions in every matching file under `root`, in place.
 *
 * Returns the files it rewrote so a caller can assert it actually shifted
 * something — a probe that silently matched no files proves nothing.
 */
export const shiftSourcePositions = (root, { extensions = ['.js'] } = {}) => {
  const targets = walkFiles(root).filter((path) => extensions.some((ext) => path.endsWith(ext)));
  for (const path of targets) writeFileSync(path, shiftSourceText(readFileSync(path, 'utf8')), 'utf8');
  return targets;
};

/**
 * Run `generate` against a fixture tree, shift every position in that tree,
 * and run it again — so a caller only has to compare the two results.
 *
 * Taking the generator as a thunk keeps the order right: it is the second
 * result that has to match the first, and building them in the wrong order
 * would quietly pass.
 */
export const generateAcrossShiftedSources = (root, generate, options) => {
  const before = generate();
  const shiftedFiles = shiftSourcePositions(root, options);
  return { before, after: generate(), shiftedFiles };
};

/** Explains a position-invariance failure in terms of what it costs. */
export const POSITION_INVARIANCE_FAILURE = [
  'Regenerating after an edit that changed no described content produced a different manifest,',
  'so this generator is recording a position (a line, offset, or file:line pointer) rather than',
  'content. Every rebase will conflict on the committed file and the drift test will fire on',
  'commits that change nothing. Key each record by the declaring file plus the semantic identity',
  'of what it declares, and keep positional detail in memory for the generator\'s own verification.',
].join(' ');
