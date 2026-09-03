/**
 * A detail page's `<h1>` is the only place the record's name appears on that
 * route, so truncating it away leaves the value unreachable.
 *
 * `truncate` is `overflow:hidden; text-overflow:ellipsis; white-space:nowrap`.
 * At a 360px viewport, after the back link, icon, badges and action buttons
 * sharing the header row, the heading gets roughly 150-180px — about fifteen
 * characters. A series named "Season 2 — The Reclamation Arc (draft)" renders
 * as "Season 2 — The…", and because the clipped text is neither selectable nor
 * expandable there is no way to read the rest on a phone. Desktop would at
 * least surface a native tooltip if `title` were set; it wasn't (issue #5694).
 *
 * The rule: an `<h1>` that renders a DYNAMIC value (its children contain a JSX
 * expression) and clips it with an unprefixed `truncate` must also carry a
 * `title` attribute, so the full value stays reachable. The tree's fix is to
 * drop `truncate` for `line-clamp-2 break-words` AND set `title` — two clamped
 * lines plus a tooltip — but the guard polices the reachability half only, so a
 * page that has a genuine reason to keep one ellipsised line stays legal as
 * long as the value can still be read.
 *
 * Deliberately NOT flagged:
 *  - A heading whose children are a STATIC string (`<h1 …>Media Gen</h1>`).
 *    Nothing is lost when a title the code itself wrote gets clipped, and the
 *    page's nav entry carries the same words.
 *  - `line-clamp-*`, which wraps rather than clipping to one line.
 *  - A variant-prefixed `md:truncate`, which leaves the phone — the viewport
 *    that actually runs out of room — unclipped.
 *  - `h2` and below: a section heading labels content that is itself on screen,
 *    not the record's only identifier.
 *
 * Scoped to git-tracked non-test sources; comments are masked first so a doc
 * block quoting example markup is documentation, not markup.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { trackedSourceFiles } from './test/trackedFiles.js';
import { lineOf, maskComments } from './test/classNameScan.js';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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
  violationsIn(readFileSync(join(CLIENT_ROOT, file), 'utf8'), file);

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
