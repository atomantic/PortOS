/**
 * Position invariance: the property every checked-in generated manifest owes the people who rebase onto it.
 *
 * A `*.generated.json` is kept honest by a drift test that regenerates and compares, which only works if the file changes when what it describes changes and *only* then. A manifest recording `foo.js:412` is rewritten by any edit above line 412, so the drift test fires on unrelated commits and every parallel branch conflicts.
 * Prove a generator is clean by testing the property: shift every position in the inputs without touching anything described and demand byte-identical output. That catches a `line`, `at`, `span`, `row`, `loc: [412, 8]` tuple or `foo.js#L412` anchor, including spellings nobody thought to deny-list.
 * `server/test/guards/repo/generatedManifests.test.js` is the cheap tree-wide net for a manifest whose generator never adopted this; this module is how a generator proves it directly. Use both.
 */

/**
 * Two comment lines: prepending them shifts every line number, byte offset and character index without altering a token of the code a manifest describes.
 */
const SHIFT_HEADER = '// position-invariance probe: shifts every line and offset below it.\n'
  + '// Nothing a generated manifest describes lives in these two lines.\n';

/** Shift the positions in one in-memory source string. */
export const shiftSourceText = (source) => `${SHIFT_HEADER}${source}`;

/** Explains a position-invariance failure in terms of what it costs. */
export const POSITION_INVARIANCE_FAILURE = [
  'Regenerating after an edit that changed no described content produced a different manifest,',
  'so this generator is recording a position (a line, offset, or file:line pointer) rather than',
  'content. Every rebase will conflict on the committed file and the drift test will fire on',
  'commits that change nothing. Key each record by the declaring file plus the semantic identity',
  'of what it declares, and keep positional detail in memory for the generator\'s own verification.',
].join(' ');
