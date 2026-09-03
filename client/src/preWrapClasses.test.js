/**
 * Repo-wide: a wrapping `<pre>` also has to break unbroken tokens.
 *
 * `Layout`'s root shell is `w-full max-w-full overflow-x-hidden`, so a child
 * wider than the viewport is CLIPPED rather than made scrollable — there is no
 * scrollbar to recover the overflowing edge. `whitespace-pre-wrap` only wraps at
 * *whitespace*, so a `<pre>` carrying it alone still runs off the clip edge the
 * moment its content holds one unbroken token: an absolute path, a URL, a
 * base64 blob, a minified JSON line, a stack frame (issue #5820, following the
 * two no-wrap-class blocks fixed in #5675).
 *
 * The rule: a `<pre>` opener whose class tokens include `whitespace-pre-wrap`
 * must also carry a break class. Which one depends on what the block renders,
 * and the split is deliberate:
 *
 *  - **Machine output** — logs, command output, JSON dumps, stack traces, raw
 *    model transcripts, API payloads — takes `break-all`, matching
 *    `components/ui/ProcessLogLines.jsx`, the canonical log renderer. A 400-char
 *    token there has no natural break point, and mid-token breaking is the only
 *    thing that keeps its tail on screen.
 *  - **Human-authored prose** — prompt templates, treatments, bios, user
 *    stories, wiki bodies — takes `break-words`, which breaks a word only when
 *    it cannot fit on a line of its own. Breaking mid-word on every line is
 *    worse to read than the rare long token in prose.
 *
 * `components/cos/JobCard.jsx` shows both in one component: `job.lastOutput` is
 * `break-all`, `job.promptTemplate` is `break-words`.
 *
 * Deliberately NOT the fix, and so not accepted by this guard:
 *  - Relaxing `Layout`'s `overflow-x-hidden` — it is what stops one wide child
 *    from giving the whole app a horizontal scrollbar. The fix belongs in the leaf.
 *  - `overflow-x-auto` on the block — a horizontal scroller inside a card is
 *    worse on touch, where a wrapped block keeps every character reachable at 360px.
 *
 * Deliberately out of scope: a `<pre>` with no wrap class at all (it is a
 * horizontal scroller by default, which a few blocks legitimately want) and
 * `<code>` spans.
 *
 * The opener is read as a whole tag rather than a line, because a JSX `<pre>`
 * routinely splits its attributes across lines — a line-scoped grep silently
 * passes over exactly those blocks. Every class token in the opener is pooled,
 * across a conditional's branches too, so a block that supplies its break class
 * from only one branch reads as covered; branch-precise checking would need the
 * component actually rendered, and the regression this catches is the far more
 * common one of a block with no break class on any path. Comments are masked
 * first so this doc block quoting an example class string is documentation, not
 * markup.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { trackedSourceFiles } from './test/trackedFiles.js';
import { lineOf, maskComments, stringLiterals } from './test/classNameScan.js';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// `<pre` followed by whitespace, `>`, `/`, or `{` — so `<prefetch>` and a
// `<pre>`-free identifier like `preview` are not openers.
const PRE_OPENER = /<pre(?=[\s/>{])/g;
const WRAP = 'whitespace-pre-wrap';
// `break-all` breaks anywhere; `break-words` (and Tailwind v4's `wrap-anywhere`
// / `break-anywhere`) break only when the word cannot fit alone. All three keep
// the tail of a long token on screen, which is the property under test.
const BREAKS = new Set(['break-all', 'break-words', 'break-anywhere', 'wrap-anywhere']);

/**
 * The full opening tag starting at `start`, quotes and `{…}` expressions
 * balanced, so a `>` inside `className={cond ? 'a>b' : ''}` doesn't end it early.
 */
function openingTag(source, start) {
  let i = start;
  let depth = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length && source[i] !== quote) i += source[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '>' && depth === 0) return source.slice(start, i + 1);
    i += 1;
  }
  return source.slice(start);
}

// Splits on everything a Tailwind class cannot contain — whitespace, but also
// the quotes, braces and `$` of a template literal — so a class supplied through
// an interpolated branch (`` `whitespace-pre-wrap ${dense ? "break-all" : ""}` ``)
// is read as the token it renders to rather than as `"break-all"`.
const classTokens = (tag) =>
  stringLiterals(tag)
    .flatMap(({ value }) => value.split(/[^A-Za-z0-9_:/[\].%-]+/))
    .filter(Boolean);

function violationsIn(rawSource, file) {
  const source = maskComments(rawSource);
  const found = [];
  PRE_OPENER.lastIndex = 0;
  let match;
  while ((match = PRE_OPENER.exec(source))) {
    const tag = openingTag(source, match.index);
    const tokens = classTokens(tag);
    if (!tokens.includes(WRAP)) continue;
    if (tokens.some((token) => BREAKS.has(token))) continue;
    found.push(`${file}:${lineOf(source, match.index)}`);
  }
  return found;
}

const findViolations = (file) =>
  violationsIn(readFileSync(join(CLIENT_ROOT, file), 'utf8'), file);

describe('<pre> wrap/break class conventions', () => {
  const files = trackedSourceFiles(CLIENT_ROOT);

  it('scans a populated client tree', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  // Without this the suite would still pass if the detector silently stopped
  // matching anything — a green tree-wide guard proves nothing on its own.
  it('flags a wrapping <pre> with no break class and clears every safe form', () => {
    const flagged = (markup) => violationsIn(markup, 'probe.jsx').length;
    expect(flagged('<pre className="text-xs whitespace-pre-wrap">{log}</pre>')).toBe(1);
    expect(flagged('<pre className="whitespace-pre-wrap break-all">{log}</pre>')).toBe(0);
    expect(flagged('<pre className="whitespace-pre-wrap break-words">{prose}</pre>')).toBe(0);
    // A `<pre>` with no wrap class is a horizontal scroller by design.
    expect(flagged('<pre className="text-xs font-mono">{log}</pre>')).toBe(0);
    expect(flagged('<pre>{log}</pre>')).toBe(0);
    // The opener routinely spans lines; a line-scoped scan would miss this one.
    expect(flagged('<pre\n  className="p-2 font-mono whitespace-pre-wrap"\n>\n  {log}\n</pre>')).toBe(1);
    expect(flagged('<pre\n  className="whitespace-pre-wrap break-all"\n>\n  {log}\n</pre>')).toBe(0);
    // Both halves of a composed class string count as one token set.
    expect(flagged('<pre className={`whitespace-pre-wrap ${dense ? "break-all" : "break-words"}`}>{x}</pre>')).toBe(0);
    expect(flagged('<pre className={`whitespace-pre-wrap ${dense ? "text-xs" : "text-sm"}`}>{x}</pre>')).toBe(1);
    // A `>` inside the class expression does not end the opening tag early — if
    // it did, the scan would see no class tokens at all and report nothing.
    expect(flagged('<pre className={n > 2 ? "whitespace-pre-wrap" : "text-xs"}>{x}</pre>')).toBe(1);
    // Neither `overflow-x-auto` nor a max-height substitutes for a break class:
    // the shell clips rather than scrolls, so the overflow is unreachable.
    expect(flagged('<pre className="whitespace-pre-wrap overflow-x-auto max-h-48">{log}</pre>')).toBe(1);
    // A sibling tag whose name merely starts with "pre" is not a <pre>.
    expect(flagged('<preview className="whitespace-pre-wrap" />')).toBe(0);
    // A doc comment quoting an example opener is not markup.
    expect(violationsIn('// e.g. <pre className="whitespace-pre-wrap">', 'probe.jsx')).toEqual([]);
  });

  it('never leaves a wrapping <pre> able to overflow the clipped shell', () => {
    expect(files.flatMap((file) => findViolations(file))).toEqual([]);
  });
});
