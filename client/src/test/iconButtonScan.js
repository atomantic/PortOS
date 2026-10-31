/**
 * Finds icon-only `<button>`s whose literal className gives them no touch-size
 * utility, for `src/iconButtonTouchConventions.test.js`. Node-only, like the
 * other helpers in `src/test/`.
 */

import { lineOf, maskComments } from './classNameScan.js';

// Utilities that already give the button a hit area of about 32px or more, or
// that size it on a coarse pointer.
const SIZED = /(?:^|[\s"'`])(?:[a-z0-9-]+:)*(?:min-[hw]-|size-|[hw]-(?:[89]|\d\d|\[|full|screen)|p-(?:[2-9]|\d\d|\[)|pointer-coarse:)/;

// From `<` at `start`, the index just past the tag's closing `>` (brace-aware,
// so `=>` and `>` inside `{…}` expressions don't end it), or -1.
function tagEnd(source, start) {
  let depth = 0;
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth === 0) return i + 1;
  }
  return -1;
}

// The literal text of a className attribute: a quoted string, or the static
// parts of a template literal. Null when there is no literal className.
function literalClassName(openTag) {
  const quoted = /\bclassName=(["'])([^"']*)\1/.exec(openTag);
  if (quoted) return { text: quoted[2], index: quoted.index + 'className='.length + 1 };
  const template = /\bclassName=\{`([^`]*)`\}/.exec(openTag);
  if (template) return { text: template[1].replace(/\$\{[^}]*\}/g, ' '), index: template.index + 'className={`'.length };
  return null;
}

/**
 * Each unsized icon-only button: `{ line, index }` where `index` is the source
 * offset at which a class can be inserted into its literal className.
 */
export function unsizedIconButtons(rawSource) {
  const source = maskComments(rawSource);
  const out = [];
  for (const match of source.matchAll(/<button\b/g)) {
    const openEnd = tagEnd(source, match.index);
    if (openEnd < 0 || source[openEnd - 2] === '/') continue;
    const rest = source.slice(openEnd);
    const icon = /^\s*<([A-Z][A-Za-z0-9]*)\b/.exec(rest);
    if (!icon) continue;
    const iconStart = openEnd + icon.index + icon[0].indexOf('<');
    const iconEnd = tagEnd(source, iconStart);
    if (iconEnd < 0 || source[iconEnd - 2] !== '/') continue;
    if (!/^\s*<\/button>/.test(source.slice(iconEnd))) continue;
    const openTag = source.slice(match.index, openEnd);
    const className = literalClassName(openTag);
    if (!className || SIZED.test(` ${className.text} `)) continue;
    out.push({ line: lineOf(source, match.index), index: match.index + className.index });
  }
  return out;
}
