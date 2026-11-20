/**
 * Rule: A dynamic `<h1>` using an unprefixed `truncate` must also carry a `title` attribute so the full value stays reachable.
 * Fix: Drop `truncate` for `line-clamp-2 break-words` and/or add `title={…}`.
 * What this guard cannot see:
 *   - Scoped to git-tracked non-test sources (comments masked); static `<h1>` strings, `line-clamp-*`, `md:truncate`, and `<h2>`+ are not flagged.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { trackedSourceFiles } from '../../trackedFiles.js';
import { lineOf, maskComments } from '../../classNameScan.js';
import { readText, REPO_ROOT } from '../../../../../scripts/lib/guardCorpus.js';

const CLIENT_ROOT = join(REPO_ROOT, 'client');

// Unprefixed only — the base variant is the phone. `line-clamp-2` never matches:
// the token boundary in front of `truncate` rules out a longer enclosing word.
const TRUNCATE_TOKEN = /(?:^|[\s'"`{])truncate(?=[\s'"`}]|$)/;
const TITLE_ATTR = /(?:^|\s)title\s*=/;

/**
 * Walk an `<h1` opening tag to its closing `>`, ignoring any `>` that sits
 * inside a nested JSX expression or a quoted string — `title={a > b}` and a
 * `className={`…`}` template both put one there.
 */
function readOpenTag(source, start) {
  let i = start;
  let depth = 0;
  let quote = null;
  while (i < source.length) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '>' && depth === 0) return { attrs: source.slice(start, i), end: i + 1 };
    i += 1;
  }
  return null;
}

function violationsIn(rawSource, file) {
  const source = maskComments(rawSource);
  const found = [];
  const opener = /<h1(?=[\s/>])/g;
  let match;
  while ((match = opener.exec(source))) {
    const tag = readOpenTag(source, match.index + 3);
    if (!tag) break;
    opener.lastIndex = tag.end;
    const close = source.indexOf('</h1>', tag.end);
    const children = close === -1 ? '' : source.slice(tag.end, close);
    // A heading with no interpolation renders a string the code itself wrote.
    if (!children.includes('{')) continue;
    if (!TRUNCATE_TOKEN.test(tag.attrs)) continue;
    if (TITLE_ATTR.test(tag.attrs)) continue;
    found.push(`${file}:${lineOf(source, match.index)} — <h1${tag.attrs.replace(/\s+/g, ' ')}>`);
  }
  return found;
}

const findViolations = (file) =>
  violationsIn(readText(join(CLIENT_ROOT, file)), file);

describe('detail-heading truncation conventions', () => {
  const files = trackedSourceFiles(CLIENT_ROOT);

  it('scans a populated client tree', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  // Without this the suite would still pass if the detector silently stopped
  // matching anything — a green tree-wide guard proves nothing on its own.
  it('flags a truncated dynamic heading and clears every safe form', () => {
    const flagged = (markup) => violationsIn(markup, 'probe.jsx').length;
    expect(flagged('<h1 className="text-xl font-bold truncate">{record.name}</h1>')).toBe(1);
    expect(flagged('<h1 className="truncate">#{issue.number} — {issue.title}</h1>')).toBe(1);
    // A tooltip keeps the full value reachable, whatever the clipping style.
    expect(flagged('<h1 className="truncate" title={record.name}>{record.name}</h1>')).toBe(0);
    expect(flagged('<h1 title={n} className="truncate">{n}</h1>')).toBe(0);
    // The tree's canonical fix: wrap over two lines instead of clipping.
    expect(flagged('<h1 className="line-clamp-2 break-words" title={n}>{n}</h1>')).toBe(0);
    expect(flagged('<h1 className="line-clamp-2 break-words">{n}</h1>')).toBe(0);
    // A static heading loses nothing it doesn't already say elsewhere.
    expect(flagged('<h1 className="truncate">Media Gen</h1>')).toBe(0);
    // A variant-prefixed clip leaves the phone alone.
    expect(flagged('<h1 className="md:truncate">{n}</h1>')).toBe(0);
    // A `>` inside an attribute expression must not end the tag early.
    expect(flagged('<h1 className={n.length > 3 ? "truncate" : "x"}>{n}</h1>')).toBe(1);
    expect(flagged('<h1 className={n.length > 3 ? "truncate" : "x"} title={n}>{n}</h1>')).toBe(0);
    // Section headings are out of scope.
    expect(flagged('<h2 className="truncate">{n}</h2>')).toBe(0);
    // Example markup inside a doc block is documentation, not markup.
    expect(violationsIn('// <h1 className="truncate">{record.name}</h1>', 'probe.jsx')).toEqual([]);
  });

  it('never clips a dynamic page title out of reach', () => {
    expect(files.flatMap((file) => findViolations(file))).toEqual([]);
  });
});
