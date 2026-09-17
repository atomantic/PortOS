/**
 * Block and line comments removed from a source string, for the tree-wide
 * convention guards that grep source rather than parse it. The `[^:\\]`
 * guard before `//` keeps a `https://` URL (or an escaped slash) from being
 * read as a line comment; string literals are NOT stripped.
 */
export const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
