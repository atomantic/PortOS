/**
 * Repo-wide accessibility conventions.
 *
 * These encode the regressions that keep reappearing across a11y audit passes,
 * so a new component fails the suite instead of shipping the gap:
 *
 *   1. A hand-rolled `fixed inset-0 … bg-black/N` overlay instead of the shared
 *      `ui/Modal`, which owns the focus trap, the Esc stack, `role="dialog"`,
 *      and focus restore. A hand-rolled backdrop is click-to-dismiss only — a
 *      keyboard user has no way out and tabs straight through to the page
 *      behind it.
 *   2. A toggle-switch-shaped `<button>` (a pill track with a sliding knob)
 *      that never says it is a switch, so assistive tech announces "button"
 *      with no on/off state. `components/ToggleSwitch.jsx` is the shared
 *      widget; hand-rolled tracks must at least carry `role="switch"` +
 *      `aria-checked`.
 *   3. A `<input type="file">` hidden with `hidden`/`aria-hidden`/`tabIndex={-1}`
 *      and driven by a programmatic `ref.current.click()`. That is unreachable
 *      by keyboard and screen reader, and the synthetic click doesn't open the
 *      picker at all in WebKit-as-installed-PWA — the shape PortOS is opened in
 *      from a second machine over the tailnet. `components/ui/FilePickerButton.jsx`
 *      is the shared widget (sr-only input + native `<label for>` activation).
 *   4. A `duration: Infinity` toast whose content is JSX or a render prop but
 *      which passes no `label`. Such a toast collapses to a pill after
 *      COLLAPSE_AFTER_MS (so it stops covering the page), and the pill has no
 *      text of its own to name itself with.
 *
 * Scoped to git-tracked `.jsx` under `client/src` so an untracked scratch file
 * can't fail the suite.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { trackedJsxFiles as trackedJsx, trackedSourceFiles as trackedSources } from './test/trackedFiles.js';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Shared with the other repo-hygiene guards (see `src/test/trackedFiles.js` for
// why `.js` is included alongside `.jsx`: the OpenClaw composer's file-input ref
// lived in `hooks/useOpenClawAttachments.js`, exactly the hole a `.jsx`-only
// scan leaves open).
// Memoized: each call shells out to `git ls-files`, and the rules below ask for
// the list a dozen times over.
let trackedJsxCache = null;
let trackedSourceCache = null;
const trackedJsxFiles = () => (trackedJsxCache ??= trackedJsx(CLIENT_ROOT));
const trackedSourceFiles = () => (trackedSourceCache ??= trackedSources(CLIENT_ROOT));
const trackedSourceSet = (() => {
  let cached = null;
  return () => (cached ??= new Set(trackedSourceFiles()));
})();

// `maskComments` is the most expensive routine in this file — a per-character
// lexer over ~11MB of source — and several rules want the same file masked.
// Memoizing by path collapses that to one pass per file for the whole suite;
// it is also what lets `wrapperRegistry` key its cache by path, since the scan
// and the wrapper lookups then share one source *object*.
const maskedSourceByFile = new Map();

// Probe-only stand-in modules, keyed by the same client-relative path a real
// file would use. An import idiom with no live witness in the tree — a wrapped
// default export, a re-export barrel — is otherwise only testable by calling
// its decoder by hand, which proves the decoder and not the wiring. Installed
// for the duration of one `withVirtualSources` callback and torn down with
// every cache entry they seeded, so no rule that reads real source sees them.
const virtualSources = new Map();

function maskedSourceOf(file) {
  let masked = maskedSourceByFile.get(file);
  if (masked === undefined) {
    const raw = virtualSources.get(file) ?? readFileSync(join(CLIENT_ROOT, file), 'utf8');
    masked = maskComments(raw);
    maskedSourceByFile.set(file, masked);
  }
  return masked;
}

// The rules that read UNMASKED source — the toggle, file-input, role=switch and
// icon-only scans — each used to `readFileSync` the same file again. That was
// always redundant disk I/O, but it costs more now that the tag index is keyed
// by source STRING: a freshly-allocated string carries no cached hash, so every
// index lookup re-hashes the whole ~10KB key, and a second copy of a file gets
// a second index. One string per file per run makes both keys deterministic.
// Deliberately NOT virtual-source-aware, unlike `maskedSourceOf`: these rules
// only ever walk `trackedJsxFiles()`, which no stand-in path appears in.
const rawSourceByFile = new Map();

function rawSourceOf(file) {
  let raw = rawSourceByFile.get(file);
  if (raw === undefined) {
    raw = readFileSync(join(CLIENT_ROOT, file), 'utf8');
    rawSourceByFile.set(file, raw);
  }
  return raw;
}

/**
 * Slice out the full opening tag starting at `index`, or null when it never
 * closes. The walks below read this off the shared tag index instead; what is
 * left are the callers that already hold an index and only want the slice.
 *
 * Everything it has to see through — a `>` or a brace inside a quoted attribute
 * value, a whole element inside an attribute expression, a comment mid-tag — is
 * `jsxScanner`'s job; the tag simply ends at the first `>` still in tag context.
 */
function openingTagAt(src, index) {
  const end = tagEndAt(src, index);
  return end === -1 ? null : src.slice(index, end + 1);
}

// How an element name is spelled, wherever one is read out of source. `$` is a
// legal JS identifier character, so a `Fi$ld` wrapper is a real component; the
// class admitting it here is what lets `relativeImportBindings` (`[A-Z][\w$]*`)
// and `forEachLocalComponent` agree with the walk about which names exist.
// Reading names literally also means no element name is ever spliced into a
// pattern, so a `$` in one can no longer compile to an anchor that matches
// nothing and silently hides the controls that wrapper names.
const TAG_NAME_PATTERN = '[A-Za-z][\\w$.-]*';
// The two case-specific readers derive from the one spelling above instead of
// drifting into their own almost-the-same character classes.
const COMPONENT_TAG_NAME_PATTERN = TAG_NAME_PATTERN.replace('A-Za-z', 'A-Z');
const HOST_TAG_NAME_PATTERN = TAG_NAME_PATTERN.replace('A-Za-z', 'a-z');
const COMPONENT_TAG_NAME = new RegExp(`^${COMPONENT_TAG_NAME_PATTERN}$`);
const HOST_TAG_NAME = new RegExp(`^${HOST_TAG_NAME_PATTERN}$`);

// The element name starting at `from` (the index just past `<` or `</`), or
// null. Sticky rather than `src.slice(from).match(…)`: every caller runs this
// per tag over whole files, and the slice allocates a copy of the rest of the
// file each time. Safe to hoist despite the mutable `lastIndex` — nothing is
// called between the assignment and the `exec`, so no walk can interleave.
const TAG_NAME_AT = new RegExp(TAG_NAME_PATTERN, 'y');

function tagNameAt(src, from) {
  TAG_NAME_AT.lastIndex = from;
  return TAG_NAME_AT.exec(src)?.[0] ?? null;
}

/**
 * Every tag in `src`, in source order, built in ONE `jsxScanner` pass and
 * memoized by source — `hasUsableAriaLabelledByReference` used to re-sweep the
 * whole file per referenced id, the same waste `maskedSourceOf` memoizes away
 * for `maskComments`.
 *
 * A tag start is exactly a `<` that enters `jsx-tag` mode, so everything the
 * old regex walk had to approximate falls out by construction: a `<label`
 * written in a quoted attribute value is inside a string token and never
 * visited, and an element written in an attribute EXPRESSION
 * (`<Foo render={<span id="notes-h">Notes</span>} />`) IS visited, which the
 * regex walk's `lastIndex` advance stepped over. The scanner saves and restores
 * its half-read tag across brace frames, so `tagStart` pairs each `>` with the
 * `<` it really closes rather than with whatever the innermost open tag is.
 *
 * Each entry is `{ closing, name, index, tag, contentStart, selfClosing,
 * parent, matchingClose }`. The structural links are assigned after
 * lexing, once every opener knows whether it was self-closing.
 * An unterminated tag keeps `tag: null` — the walk reports it rather than
 * dropping it, because "is there a tag here" and "should an unreadable one
 * count" are different questions and only the caller knows the second.
 *
 * Keyed by SOURCE and its starting mode, not by path, so it is a pure-function
 * cache with nothing to invalidate: a probe's stand-in source and the real file
 * it stands in for are different strings, and no entry can ever answer for the
 * other. A JSX-text slice is not code, even when its characters equal another
 * slice that a caller reads as code.
 */
const tagIndexBySource = new Map();

function tagIndexOf(src, { startMode = 'code' } = {}) {
  const indexesByStartMode = tagIndexBySource.get(src);
  const cached = indexesByStartMode?.get(startMode);
  if (cached) return cached;
  const nodes = [];
  const openByStart = new Map();
  for (const token of jsxScanner(src, { mode: startMode })) {
    if (token.kind !== 'char') continue;
    if (token.opensTag) {
      const closing = src.startsWith('</', token.index);
      const node = {
        closing,
        name: tagNameAt(src, token.index + (closing ? 2 : 1)),
        index: token.index,
        tag: null,
        contentStart: null,
        selfClosing: false,
        parent: null,
        fragment: false,
        matchingClose: null,
      };
      // Pushed at its `<`, so entries stay in ascending `index` even though a
      // tag nested in an attribute expression is COMPLETED first — which
      // `openWrapperInstancesAt` relies on for its `break` and its stack.
      nodes.push(node);
      openByStart.set(token.index, node);
      continue;
    }
    if (token.char !== '>' || token.mode !== 'jsx-tag') continue;
    const node = openByStart.get(token.tagStart);
    if (!node) continue;
    node.tag = src.slice(node.index, token.index + 1);
    node.contentStart = token.index + 1;
    node.selfClosing = token.selfClosing;
  }

  // The tag index is more than a flat list: callers that answer child-order
  // questions need the lexer-established element structure, not another
  // cursor walk that guesses which `<` starts a tag. Fragments participate in
  // the stack too, even though they have no name, because they are real React
  // children and cloning an id onto one does not reach its descendants.
  const openElements = [];
  for (const node of nodes) {
    if (node.tag === null) continue;
    node.fragment = node.name === null && node.tag === (node.closing ? '</>' : '<>');
    if (node.closing) {
      const open = openElements.at(-1);
      const matches = open && open.name === node.name
        && (node.name !== null || (open.fragment && node.fragment));
      if (!matches) continue;
      open.matchingClose = node;
      openElements.pop();
      continue;
    }
    node.parent = openElements.at(-1) ?? null;
    if (!node.selfClosing) openElements.push(node);
  }
  const cache = indexesByStartMode ?? new Map();
  cache.set(startMode, nodes);
  tagIndexBySource.set(src, cache);
  return nodes;
}

// Every tag named `name` — closers and unterminated tags included. Omit `name`
// to walk every element; a name is matched literally against the name the
// scanner read, never as a pattern.
function* forEachTag(src, name, { startMode = 'code' } = {}) {
  // Lexing a whole file to look for a name that does not occur in it is the
  // one cost this walk added over the regex it replaced: a named regex walk
  // scanned natively and boundary-scanned only its own matches, where the index
  // lexes every tag. A substring test is sound as a pre-filter because `name`
  // is read literally out of the source right after the `<` — if the element is
  // there, the substring is — and it skips the ~30% of tracked files that hold
  // no `<button` or `<input` at all.
  if (name !== undefined && !src.includes(name)) return;
  for (const node of tagIndexOf(src, { startMode })) {
    if (name === undefined || node.name === name) yield node;
  }
}

// What almost every caller wants: openers only, and only those whose `>` was
// found. `openWrapperInstancesAt` and `callSiteIdVerdicts` are the two that
// want more — one needs closers for its open/close stack, the other needs an
// unreadable tag to contribute a `false` rather than vanish — and both walk
// `forEachTag` instead. Keeping that choice in a filter rather than inside the
// walk is what let the last hand-rolled scanner fold onto this one.
function* forEachOpeningTag(src, name, options) {
  for (const node of forEachTag(src, name, options)) {
    if (!node.closing && node.tag !== null) yield node;
  }
}

// Which element names this source renders at all — the "is it worth reading the
// imported file" precheck. Built from the memoized index rather than memoized
// itself: its one caller is `wrapperRegistry`, which is already cached per file.
const renderedTagNames = (src) => new Set(
  tagIndexOf(src).filter((node) => !node.closing && node.name).map((node) => node.name),
);

const lineOf = (src, index) => src.slice(0, index).split('\n').length;

// Index of the last non-whitespace character before `from`, stopping at `floor`
// rather than walking past it. Four walks spelled this out, each with its own
// idea of how far back it was allowed to look.
//
// This answers "what character precedes this one", which is only the same as
// "what token precedes this one" when no comment sits between them. Inside the
// scanner that distinction matters, so it tracks the previous TOKEN forward and
// uses this only to seed the walk; the one caller left needs the character.
const previousSignificant = (src, from, floor) => {
  let i = from - 1;
  while (i > floor && /\s/.test(src[i])) i--;
  return i;
};

// --- the token readers `jsxScanner` is built from -------------------------
// Each lands on the LAST character of what it consumed and lets the scanner's
// `for` step past. Nothing outside `jsxScanner` calls them: whether a quote,
// a slash, or a `<` is structural at all depends on the context the scanner is
// tracking, and every past defect in this file (#4318, #4327, #4333) came from
// one walk making that call for itself.

// Index of the quote closing the string that opens at `src[from]`, honoring
// backslash escapes. An unterminated string returns `src.length`, ending the
// walk.
function skipString(src, from) {
  let i = from + 1;
  for (; i < src.length && src[i] !== src[from]; i++) if (src[i] === '\\') i++;
  return i;
}

// Index of the LAST character of the comment opening at `src[from]`, or -1 when
// no comment opens there. An unterminated comment returns `src.length`.
//
// A `/` in JavaScript can also be division or a regex delimiter, but neither
// can OPEN with `/` or `*` — `//` is a line comment to the JS grammar itself,
// never an empty regex, and a regex may not start with a quantifier — so the
// two-character check is exact at the start of a token. Inside a regex BODY it
// is not (`/[//]/` would read as a comment), which is why the scanner consumes
// regex literals whole before it ever gets here.
function commentEnd(src, from) {
  if (src[from] !== '/') return -1;
  if (src[from + 1] === '/') {
    const newline = src.indexOf('\n', from + 2);
    return newline === -1 ? src.length : newline - 1;
  }
  if (src[from + 1] === '*') {
    const close = src.indexOf('*/', from + 2);
    return close === -1 ? src.length : close + 1;
  }
  return -1;
}

// Characters after which a `/` starts a regex literal rather than a division.
// Deliberately none of `)`, `]`, or an identifier/number character: those end a
// VALUE, and a `/` after a value is always division. Keywords cover the rest.
// `>` is here for `=>` — an arrow function returning a literal (`(d) => /a|b/`)
// is the single most common shape in this tree, and reading its `/` as division
// puts the literal's own characters back into the JavaScript walk.
const REGEX_PRECEDERS = '=([{,;:!&|?>';
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|throw|typeof|instanceof|case|default|in|of|new|delete|void|yield|await|do|else)$/;

// Index of the `/` closing the regex literal opening at `src[from]`, or -1 when
// that `/` is division. A regex body may hold any of `{ } ' " \` < >` — and a
// character class holds `/` itself — so leaving it to the JavaScript walk lets
// `/[<>]/` open a phantom JSX tag and `/it's/` a phantom string, the same class
// of runaway the string and comment states exist to prevent.
//
// A regex literal may not span a line, so an unmatched `/` on the line means
// this was division after all and the walk continues from the next character.
// That bound is what makes guessing safe: a wrong guess costs one character,
// never the rest of the file.
//
// `previous` is the last significant index the SCANNER saw, not one found by
// walking back over raw source: a backward walk stops at the `/` of a `*/` and
// calls `x = /* why */ /a|b/` a division. Only the forward pass knows that the
// comment was not a token.
function regexEnd(src, from, previous) {
  if (previous >= 0
    && !REGEX_PRECEDERS.includes(src[previous])
    && !REGEX_KEYWORDS.test(src.slice(Math.max(0, previous - 11), previous + 1))) return -1;

  let inClass = false;
  for (let i = from + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '\n') return -1;
    // A backslash escapes the next character but never the line bound — a `\`
    // before a newline is a syntax error, not a continuation. Stepping over it
    // blind walked straight past the bound, so a `/` on a later line closed the
    // "literal" with everything in between swallowed as one token.
    if (c === '\\') { if (src[i + 1] === '\n') return -1; i++; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return i;
  }
  return -1;
}

/**
 * Slice a call's full argument list, `(` through its matching `)`, starting at
 * the opening paren.
 *
 * Only parens in JavaScript-expression context count. A `(` in an element's
 * visible text is prose — `toast(<p>Retry (again)</p>)` — and an apostrophe
 * there is an ordinary character, not a string opener that swallows the closing
 * paren. That used to need a retry-without-strings second pass; the scanner
 * knows which context it is in, so there is nothing left to retry.
 */
function balancedCallAt(src, openIndex) {
  let depth = 0;
  for (const token of jsxScanner(src, { from: openIndex })) {
    if (token.kind !== 'char' || token.mode !== 'code') continue;
    if (token.char === '(') depth++;
    else if (token.char === ')' && --depth === 0) return src.slice(openIndex, token.index + 1);
  }
  return null;
}

// --- helpers for the icon-only-button-name and 44px-close-target rules ---

// A `<` opens a JSX tag, rather than being a less-than, when a name, `/`, or
// `>` follows it. That is the whole test inside an element's text, where a
// comparison cannot appear.
const opensJsxTagInText = (src, index) => src[index] === '<'
  && (src[index + 1] === '/' || /[A-Za-z>]/.test(src[index + 1] || ''));

// In JavaScript the same `<` also has to sit where an expression may start.
// Built on the text predicate so `matchingBraceEnd` and `maskComments` cannot
// drift on where the JavaScript/JSX line falls — widening one widens both.
// `}` is in the preceder set for the same reason `;` is: it ENDS a statement, so
// what follows is a fresh expression position. The other reading — an object
// literal compared with less-than (`{a: 1} < b`) — is not something JavaScript
// is written to say, while `function Wrapper() {…}` followed by the JSX that
// renders it is the shape every wrapper probe in this file is built from. Since
// the tag walks became scanner-driven this predicate is what decides whether
// such a tag exists at all, where the old regex walk found it either way.
const looksLikeJsxTagStart = (src, index, previous) => {
  if (!opensJsxTagInText(src, index)) return false;
  if (previous < 0 || '=([{},:;!?&|>'.includes(src[previous])) return true;
  return /(?:return|yield|=>)\s*$/.test(src.slice(Math.max(0, index - 12), index));
};

/**
 * The one lexer every scanner in this file runs on.
 *
 * Six walks used to re-derive this JSX/JavaScript state machine independently,
 * each learning about strings, comments, or element text on its own schedule —
 * which is what #4318, #4327 and #4333 all were: one scanner taught something
 * its siblings weren't. They now share this generator, which yields one token
 * per significant character together with the CONTEXT it sits in, and hands
 * back strings, comments, and regex literals as whole spans so no caller can
 * read into one by accident.
 *
 * Tokens:
 *   { kind: 'char',    index, char, mode, depth, opensTag, tagStart, selfClosing }
 *   { kind: 'string',  index, end,  mode }   — `end` is the closing quote
 *   { kind: 'comment', index, end,  mode }   — `end` is the comment's last char
 *   { kind: 'regex',   index, end,  mode }   — `end` is the closing slash
 *
 * `opensTag` marks the `<` that enters a tag — the one fact a tag walk needs
 * and the one thing no caller can decide for itself, since whether a `<` is a
 * tag or a less-than depends on the context this machine is tracking.
 * `tagStart` rides on every `jsx-tag` character and names the `<` of the tag
 * being read, so a `>` can be paired with its own opener even after an
 * attribute expression parked that tag on the brace stack.
 *
 * `mode` is where the character sits: `'code'` (a JavaScript expression),
 * `'jsx-tag'` (between a tag's `<` and the `>` that closes it), or `'jsx-text'`
 * (an element's visible body, where an apostrophe is an apostrophe and `//` is
 * two slashes). `depth` is `{…}` nesting relative to `from`, reported so that a
 * brace and its match share a depth: an opener reports the depth it opens FROM,
 * a closer the depth it leaves behind. So the `}` matching the `{` at `from` is
 * the first `}` at depth 0.
 *
 * `from` and `mode` together are what the arbitrary-substring callers need: a
 * slice is not always a whole file, and the machine has to be told where it is.
 */
function* jsxScanner(src, { from = 0, mode: startMode = 'code' } = {}) {
  let mode = startMode;
  // The tag being read whenever `mode` is 'jsx-tag'; `parentMode` is where a
  // self-closing tag hands back to. A caller that starts mid-tag gets a stand-in
  // so the first `>` still closes something.
  let tag = startMode === 'jsx-tag' ? { closing: false, parentMode: 'code', start: null } : null;
  // One frame per open brace, holding the state to resume when it closes: an
  // attribute expression returns to the tag holding it, a child expression to
  // the element's text. The half-read tag rides along, because an attribute
  // expression can itself hold a whole element (`label={<span>…</span>}`) whose
  // own `>` would otherwise be mistaken for the end of the outer tag. The stack
  // doubles as the brace depth, so there is no second counter to keep in step.
  const braceFrames = [];
  // One entry per open element, marking whether it was opened from JavaScript.
  // Its closing tag hands back there rather than to an enclosing element's text.
  const jsxStack = [];
  // Index of the last token that was really a token — whitespace and COMMENTS
  // are not. Deciding whether a `/` opens a regex, or a `<` opens a tag, means
  // asking what came before it, and a backward walk over raw source answers
  // that wrong: it stops at the `/` of a `*/` and calls `x = /* why */ /a|b/`
  // a division. Only the forward pass knows the comment was not a token.
  //
  // The SEED is the exception, and stays one: reading backwards cannot lex a
  // comment (`*/` and `* /` are indistinguishable without a forward pass from
  // the start of the file), and every caller that passes `from > 0` points it at
  // a structural character — a `{`, a `(`, or the position just after a `?` —
  // never at the token following a comment.
  let previous = previousSignificant(src, from, -1);

  for (let i = from; i < src.length; i++) {
    const c = src[i];

    // Strings, comments, and regex literals exist only outside element text —
    // in `<option>Use the provider's default</option>` the apostrophe is text,
    // and reading it as a string opener swallows the rest of the file (#4318).
    if (mode !== 'jsx-text') {
      const comment = commentEnd(src, i);
      if (comment !== -1) {
        yield { kind: 'comment', index: i, end: Math.min(comment, src.length - 1), mode };
        i = comment;
        continue;
      }
      if (c === '"' || c === '\'' || c === '`') {
        const end = skipString(src, i);
        yield { kind: 'string', index: i, end: Math.min(end, src.length - 1), mode };
        i = end;
        previous = Math.min(end, src.length - 1);
        continue;
      }
      if (mode === 'code' && c === '/') {
        const end = regexEnd(src, i, previous);
        if (end !== -1) {
          yield { kind: 'regex', index: i, end, mode };
          i = end;
          previous = end;
          continue;
        }
      }
    }
    const before = previous;
    if (!/\s/.test(c)) previous = i;

    // Braces nest the same way in all three contexts, so they are handled once.
    if (c === '{') {
      yield { kind: 'char', index: i, char: c, mode, depth: braceFrames.length };
      braceFrames.push({ mode, tag });
      mode = 'code';
      tag = null;
      continue;
    }
    if (c === '}') {
      // A slice can begin inside an expression, so the pop may come back empty;
      // an unmatched `}` then simply sits at depth 0 and changes no context.
      const frame = braceFrames.pop();
      yield { kind: 'char', index: i, char: c, mode, depth: braceFrames.length };
      if (frame) ({ mode, tag } = frame);
      continue;
    }

    // Decided here rather than by each walk for itself: `mode` and `before` are
    // this machine's state, and every past defect in this file came from a
    // scanner ruling on a `<` without them.
    const opensTag = c === '<' && (mode === 'jsx-text'
      ? opensJsxTagInText(src, i)
      : mode === 'code' && looksLikeJsxTagStart(src, i, before));

    yield {
      kind: 'char',
      index: i,
      char: c,
      mode,
      depth: braceFrames.length,
      opensTag,
      // The `<` of the tag this character belongs to, so a `>` pairs with its
      // own opener: an attribute expression parks the half-read tag on the
      // brace stack, and the innermost tag SEEN is not always the one closing.
      tagStart: mode === 'jsx-tag' ? tag.start : null,
      // Only meaningful on a tag's closing `>`. It rides along because `before`
      // is the last TOKEN, and a caller asking from outside can only find the
      // last character — which is the `/` of a `*/` in `<Foo /* note */ >`.
      selfClosing: mode === 'jsx-tag' && c === '>' && before >= from && src[before] === '/',
    };

    if (mode === 'jsx-text') {
      if (opensTag) {
        tag = { closing: src.startsWith('</', i), parentMode: 'jsx-text', start: i };
        mode = 'jsx-tag';
      }
      continue;
    }

    if (mode === 'jsx-tag') {
      if (c !== '>') continue;
      if (tag.closing) {
        // A closing tag can outnumber the opens in a slice that starts mid-
        // element, so the pop may come back empty — return to the mode that
        // described the slice rather than assuming its body was JavaScript.
        const entry = jsxStack.pop();
        mode = entry?.root ? 'code' : (jsxStack.length ? 'jsx-text' : startMode);
      } else if (before >= from && src[before] === '/') {
        mode = tag.parentMode;
      } else {
        jsxStack.push({ root: tag.parentMode === 'code' });
        mode = 'jsx-text';
      }
      tag = null;
      continue;
    }

    if (opensTag) {
      tag = { closing: src.startsWith('</', i), parentMode: 'code', start: i };
      mode = 'jsx-tag';
    }
  }
}

// Index of the `}` matching the `{` at `s[idx]`, or -1.
function matchingBraceEnd(s, idx) {
  for (const token of jsxScanner(s, { from: idx })) {
    if (token.kind === 'char' && token.char === '}' && token.depth === 0) return token.index;
  }
  return -1;
}

// The boundary of the tag that opens at `s[idx]` (`<`), or null: it ends at the
// first `>` still in TAG context at brace depth 0. A quoted value's `>` never
// reaches this walk at all, and an attribute expression can hold a whole element
// (`render={<span>don't</span>}`) whose own `>` is in tag context too — the
// depth is what tells the two apart. `end` is the index just past `>`.
function tagBoundaryAt(s, idx) {
  for (const token of jsxScanner(s, { from: idx + 1, mode: 'jsx-tag' })) {
    if (token.kind === 'char' && token.char === '>' && token.mode === 'jsx-tag' && token.depth === 0) {
      return { end: token.index + 1, selfClosing: token.selfClosing };
    }
  }
  return null;
}

// Index of that closing `>`, for the callers that only need the slice.
function tagEndAt(s, idx) {
  const boundary = tagBoundaryAt(s, idx);
  return boundary ? boundary.end - 1 : -1;
}

const stripJsxComments = (s) => s.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');

// A button body counts as icon-only when it is a SOLE top-level JSX child: a
// single self-closing capitalized component, or a `{...}` expression whose
// entire content is a ternary/`&&` between two such components (the
// play/pause, expand/collapse shape). A naive `^<Icon.../>$`-shaped regex
// over the raw body text is unsafe here — a wildcard greedily matches straight
// across sibling boundaries, so `<Icon/><span>text</span>` misreads as one
// self-closing element with a visible-text sibling silently absorbed into it.
// Walking to the true boundary of the first top-level node and checking
// nothing follows it is what catches that case (see ui/ProvenanceChip.jsx,
// whose icon + <span>label</span> + icon button must NOT be flagged, since
// the <span> already gives it an accessible name).
function soleTopLevelNode(rawBody) {
  const s = stripJsxComments(rawBody).trim();
  if (!s) return null;
  if (s[0] === '<') {
    const boundary = tagBoundaryAt(s, 0);
    if (!boundary) return null;
    if (s.slice(boundary.end).trim() !== '') return null; // more than one top-level node
    return {
      kind: 'element',
      name: tagNameAt(s, 1),
      selfClosing: boundary.selfClosing,
    };
  }
  if (s[0] === '{') {
    const end = matchingBraceEnd(s, 0);
    if (end === -1) return null;
    if (s.slice(end + 1).trim() !== '') return null; // more than one top-level node
    return { kind: 'expr', inner: s.slice(1, end).trim() };
  }
  return null; // bare text at top level
}

// Index of the first `char` at top level of the JavaScript expression `inner`,
// or -1. Strings, comments, and element text are the scanner's business — a `?`
// or `:` in any of them is not the ternary's, which is how `mode === 'a?b' ?
// <IconA/> : <IconB/>` and `cond ? <IconA title="a:b"/> : <IconB/>` used to read
// as "not a ternary" and quietly drop an icon-only button from the rule that
// requires it to have a name.
//
// Brace nesting comes from the scanner (`depth`) rather than a local counter:
// a `{…}` child expression opens in element text and closes in code, so
// counting only the braces this walk can see would go negative on the way out.
const topLevelOperatorIn = (inner, char, from) => {
  let depth = 0;
  for (const token of jsxScanner(inner, { from })) {
    if (token.kind !== 'char' || token.mode !== 'code' || token.depth !== 0) continue;
    const c = token.char;
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    // `?.` is optional chaining, not the start of a ternary.
    else if (c === char && depth === 0 && !(char === '?' && inner[token.index + 1] === '.')) return token.index;
  }
  return -1;
};

const isSelfClosingIconNode = (node) => (
  node?.kind === 'element'
  && node.selfClosing
  && node.name !== null
  && COMPONENT_TAG_NAME.test(node.name)
);

function matchTernaryIcons(inner) {
  const qIdx = topLevelOperatorIn(inner, '?', 0);
  if (qIdx === -1) return false;
  const cIdx = topLevelOperatorIn(inner, ':', qIdx + 1);
  if (cIdx === -1) return false;
  const a = inner.slice(qIdx + 1, cIdx).trim();
  const b = inner.slice(cIdx + 1).trim();
  return isSelfClosingIconNode(soleTopLevelNode(a)) && isSelfClosingIconNode(soleTopLevelNode(b));
}

function lastTopLevelAndIn(inner) {
  let from = 0;
  let result = -1;
  while (from < inner.length) {
    const index = topLevelOperatorIn(inner, '&', from);
    if (index === -1) break;
    if (inner[index + 1] === '&') {
      result = index;
      from = index + 2;
    } else {
      from = index + 1;
    }
  }
  return result;
}

// Unwrap presentational wrappers: a button whose body is `<span><X/></span>`
// (an extra element for padding, a hover background, or a badge) is still
// icon-only, but a walker that stops at the wrapper's opening tag reads its
// children as "more than one top-level node" and skips the button entirely.
// Recurse through lowercase host elements that carry no text of their own.
function unwrapPresentational(rawBody, depth = 0) {
  if (depth > 4) return rawBody;
  const s = stripJsxComments(rawBody).trim();
  const name = tagNameAt(s, 1);
  if (!name || !HOST_TAG_NAME.test(name)) return s;
  const boundary = tagBoundaryAt(s, 0);
  if (!boundary || boundary.selfClosing) return s;
  const close = `</${name}>`;
  if (!s.endsWith(close)) return s;
  return unwrapPresentational(s.slice(boundary.end, s.length - close.length), depth + 1);
}

function isIconOnlyBody(rawBodyIn) {
  const rawBody = unwrapPresentational(rawBodyIn);
  const node = soleTopLevelNode(rawBody);
  if (!node) return false;
  if (node.kind === 'element') return isSelfClosingIconNode(node);
  const inner = node.inner;
  if (matchTernaryIcons(inner)) return true;
  const andIndex = lastTopLevelAndIn(inner);
  return andIndex !== -1 && isSelfClosingIconNode(soleTopLevelNode(inner.slice(andIndex + 2)));
}

// Buttons don't nest in valid HTML/JSX, so the first `</button>` after the
// opening tag's end is its match.
function findButtonBody(src, openEnd) {
  const closeIdx = src.indexOf('</button>', openEnd);
  return closeIdx === -1 ? null : src.slice(openEnd, closeIdx);
}

// Is this <button> node an icon-only button with nothing to name it? Named
// rather than inlined in the rule so the `selfClosing` it reads is testable:
// this rule scans UNMASKED source, where a comment survives to the end of the
// tag — `<button /* pause */>` ends in `*/>`, which the old `endsWith('/>')`
// re-derivation called self-closing, skipping a button that has a body and
// needs a name.
function isUnnamedIconOnlyButton(src, { tag, contentStart, selfClosing }) {
  if (selfClosing) return false; // no body to judge
  if (/\baria-label\s*=/.test(tag) || /\baria-labelledby\s*=/.test(tag)) return false;
  const body = findButtonBody(src, contentStart);
  return body !== null && isIconOnlyBody(body);
}

// Tailwind `h-`/`w-`/`min-h-`/`min-w-` token → px, for both an arbitrary
// value (`min-h-[44px]`) and the spacing scale (`h-11` = 11 * 4px = 44px).
function tokenPx(token) {
  const arb = token.match(/^(?:min-)?[hw]-\[(\d+(?:\.\d+)?)px\]$/);
  if (arb) return parseFloat(arb[1]);
  const scale = token.match(/^(?:min-)?[hw]-(\d+(?:\.5)?)$/);
  if (scale) return parseFloat(scale[1]) * 4;
  return null;
}

function hasFortyFourMinTouchTarget(cls) {
  let hOk = false;
  let wOk = false;
  for (const token of cls.split(/\s+/)) {
    if (/^(?:min-)?h-/.test(token) && tokenPx(token) >= 44) hOk = true;
    if (/^(?:min-)?w-/.test(token) && tokenPx(token) >= 44) wOk = true;
  }
  return hOk && wOk;
}

// Return a static JSX attribute value, including the common expression forms
// used for paired input ids (`id={fieldId}` / `id={`field-${id}`}`). Dynamic
// expressions are compared as source text, which is sufficient for matching
// an input and its label when they share the same expression in one file.
function attributeValue(tag, name) {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=`).exec(tag);
  if (!match) return null;

  let index = match.index + match[0].length;
  while (/\s/.test(tag[index])) index++;

  if (tag[index] === '"' || tag[index] === "'" || tag[index] === '`') {
    const quote = tag[index];
    for (let end = index + 1; end < tag.length; end++) {
      if (tag[end] === '\\') { end++; continue; }
      if (tag[end] === quote) return tag.slice(index + 1, end);
    }
    return null;
  }

  if (tag[index] === '{') {
    const end = matchingBraceEnd(tag, index);
    if (end === -1) return null;
    return tag.slice(index + 1, end).trim();
  }

  const rest = tag.slice(index);
  const end = rest.search(/[\s/>]/);
  return rest.slice(0, end === -1 ? rest.length : end);
}

function normalizedAttributeValue(value) {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ['"', "'", '`'].includes(trimmed[0]) && trimmed.at(-1) === trimmed[0]) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// Keep source indexes stable while blanking the comments — a scan that reads a
// JSX example out of a doc comment reports offenders that do not exist. Only the
// comment spans are rewritten; strings, regex literals, and element text are
// left exactly as they are, since the point is to preserve every index.
//
// `startMode` is where the slice BEGINS. A whole file starts in `'code'` (the
// default), but a mid-file slice need not: an element's body is JSX text, and
// masking it as code opens a fake line comment on the first `//` of visible
// label text — `<label htmlFor="x">// see docs</label>` masked to
// `'// see docs'` → `'           '` reports a correctly labeled input as
// unnamed. That is #4318's defect exactly: the machine has to be told where it
// is, and the caller is the only one that knows.
function maskComments(src, { startMode = 'code' } = {}) {
  // Split by UTF-16 unit, not by code point: the scanner reports STRING indexes,
  // and a spread (`[...src]`) collapses each astral character to one slot, so
  // every index after the first emoji in a file would land a slot early.
  const chars = src.split('');
  for (const token of jsxScanner(src, { mode: startMode })) {
    if (token.kind !== 'comment') continue;
    // Newlines survive so line numbers — and a line comment's own terminator —
    // stay where they were.
    for (let i = token.index; i <= token.end; i++) if (chars[i] !== '\n') chars[i] = ' ';
  }
  return chars.join('');
}

// Keep the source's offsets and line breaks intact while making spans inert.
// The tag index reports source indexes, so preserving that coordinate system
// lets several consumers share one structural read without compensating for
// prior replacements.
function blankSourceSpans(src, spans) {
  const chars = src.split('');
  for (const { start, end } of spans) {
    for (let index = start; index < end; index++) {
      if (chars[index] !== '\n') chars[index] = ' ';
    }
  }
  return chars.join('');
}

function hasMatchingLabelElement(src, id) {
  for (const node of forEachOpeningTag(src, 'label')) {
    const htmlFor = normalizedAttributeValue(attributeValue(node.tag, 'htmlFor'));
    if (htmlFor !== id || !hasUsableElementText(src, node)) continue;
    return true;
  }
  return false;
}

// A `label` prop only names something when it carries text. Every literal that
// React renders as nothing has to be rejected, `true` included: `<Field label>`
// and `label={true}` are the same prop value, and `<label>{true}</label>` puts
// no text in the DOM. Reading it as a name would exempt a control that has none.
function isUsableLabelAttributeValue(value) {
  return Boolean(value) && !/^(?:undefined|null|false|true)$/i.test(value);
}

// Does this wrapper instance carry a usable name in the prop its own source
// names its label with? Every shape matcher asks it, so the three-deep read
// (`attributeValue` → `normalizedAttributeValue` → `isUsableLabelAttributeValue`)
// lives here rather than being respelled at each one.
function hasUsableLabelProp(tag, labelProp) {
  return isUsableLabelAttributeValue(normalizedAttributeValue(attributeValue(tag, labelProp)));
}

// A field wrapper can own the <label> AND take the control's id as a prop
// instead of wrapping it (LifestyleTab.jsx's `<FieldGroup label="Sleep …"
// htmlFor="lifestyle-sleep-hours">`). Wrapping is wrong there — an implicit
// <label> would swallow the live value readout and the hint paragraph sitting
// beside the control into the accessible name — so the control is explicitly
// labeled, just not by a `<label htmlFor>` written at the call site.
//
// The prop names come from the wrapper's own source rather than a hardcoded
// list: the forwarded id arrives as `htmlFor` in LifestyleTab's `FieldGroup`
// but as `id` in StackerNews's `Field({ id, label, children })`, and both name
// their control just as well. See `wrapperShapes` for how the shape is proved.
function forwardsLabelForId(src, { id }, { idProp, labelProp }, name) {
  if (!id) return false;
  for (const node of forEachOpeningTag(src, name)) {
    if (normalizedAttributeValue(attributeValue(node.tag, idProp)) !== id) continue;
    // A forwarder can take its text as JSX children rather than a prop
    // (`<FieldLabel htmlFor="world-logline">Logline</FieldLabel>`), in which
    // case there is no same-named attribute to read — the name is the element's
    // own body, judged by the same text check the aria-labelledby path uses.
    // Without this branch every children-shaped forwarder looked unnamed and
    // its controls stayed on the allowlist.
    if (labelProp === 'children') {
      if (hasUsableElementText(src, node)) return true;
      continue;
    }
    if (hasUsableLabelProp(node.tag, labelProp)) return true;
  }
  return false;
}

const HIDDEN_ACCESSIBILITY_ATTRIBUTE = new RegExp(String.raw`(?:^|\s)(?:aria-hidden\s*=\s*(?:["']true["']|\{\s*true\s*\})|hidden(?:\s*=\s*(?:["']true["']|\{\s*true\s*\}))?)(?=\s|/|>)`, 'i');
const isHiddenFromAccessibility = (tag) => HIDDEN_ACCESSIBILITY_ATTRIBUTE.test(tag);

function stripHiddenElementContent(body) {
  const spans = [];
  for (const node of forEachOpeningTag(body, undefined, { startMode: 'jsx-text' })) {
    if (!isHiddenFromAccessibility(node.tag)) continue;
    const end = node.selfClosing ? node.contentStart : node.matchingClose?.contentStart;
    if (end !== undefined) spans.push({ start: node.index, end });
  }
  return blankSourceSpans(body, spans);
}

// `node` is a tag-index entry: its `selfClosing` and `name` come from the
// scanner, so a comment mid-tag (`<Foo /* note */ >`) can no longer read as a
// self-closing element on unmasked source the way a `/\/\s*>$/` re-derivation
// did.
function hasUsableElementText(src, node) {
  const { tag, contentStart, name, selfClosing } = node;
  if (hasUsableAccessibleNameAttribute(tag, 'aria-label')) return true;
  if (selfClosing) return false;
  if (!name) return false;
  const closing = node.matchingClose;
  if (!closing) return false;
  // The slice is the element's BODY — JSX text, not code. See `maskComments`.
  const body = stripJsxTags(stripHiddenElementContent(maskComments(src.slice(contentStart, closing.index), { startMode: 'jsx-text' })))
    .trim();
  if (!body) return false;
  const staticText = body.replace(/\{[^{}]*\}/g, ' ').trim();
  if (staticText) return true;
  // "Does this expression render any text" is the same question
  // `isUsableLabelAttributeValue` answers for a `label` prop, so it is asked
  // there rather than respelled here — this copy had already drifted off it,
  // missing `true` (whose comment over there says exactly why `<label>{true}
  // </label>` names nothing) and the EMPTY expression. `<span id="x">{}</span>`
  // and `<span id="x">{/* todo */}</span>` (a comment, masked to spaces above)
  // render nothing, so an `aria-labelledby` pointing at one names nothing —
  // and this walk now reaches such an element inside an attribute expression
  // too, so the gap widened before it was closed.
  return [...body.matchAll(/\{([^{}]*)\}/g)].some(([, expression]) => (
    isUsableLabelAttributeValue(normalizedAttributeValue(expression))
  ));
}

function isNestedInLabel(src, index) {
  return openWrapperInstancesAt(src, 'label', index)
    .some((node) => hasUsableElementText(src, node));
}

function hasUsableAccessibleNameAttribute(tag, name) {
  return isUsableLabelAttributeValue(normalizedAttributeValue(attributeValue(tag, name)));
}

function hasUsableNativeInputName(tag) {
  const type = normalizedAttributeValue(attributeValue(tag, 'type'))?.toLowerCase() || 'text';
  if (type === 'hidden') return true;
  if (['submit', 'button', 'reset'].includes(type)) {
    const value = attributeValue(tag, 'value');
    return value === null || hasUsableAccessibleNameAttribute(tag, 'value');
  }
  return type === 'image' && hasUsableAccessibleNameAttribute(tag, 'alt');
}

// A FormField's only child is often a conditional rather than the control
// itself (`{field.type === 'select' ? <select/> : <input/>}`). React still
// clones the id onto whichever branch renders, because Children.map sees the
// expression's single result as child 0 — so the control inside it is named.
// Credit that only when the control really is what the expression yields:
// directly, at the expression's top level, and not one entry of a rendered
// list (Children.map flattens an array and clones only its FIRST element, so
// crediting every control in a `.map()` would exempt the ones that stay
// unnamed).
function isEnclosedInListCall(src, start, index) {
  // Only a call that STILL encloses the control disqualifies it — a `.map()`
  // in the ternary's other branch has already closed by then, so testing for
  // the text anywhere before the control would reject the whole shape.
  for (const call of src.slice(start, index).matchAll(/\.(?:map|flatMap)\s*\(/g)) {
    const openParen = start + call.index + call[0].length - 1;
    const args = balancedCallAt(src, openParen);
    if (!args || openParen + args.length > index) return true;
  }
  return false;
}

function isDirectElementInExpression(src, start, node) {
  if (isEnclosedInListCall(src, start, node.index)) return false;
  // A tag opened after the expression began is a real ancestor of this node,
  // so React sees the ancestor — not the control — as the expression result.
  // The parent links come from jsxScanner's tag stack, including fragments.
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.index >= start) return false;
  }
  return true;
}

// Which instances of `<Name>` are still open at `index`? Both ancestor-based
// wrapper shapes need exactly this fact — `implicit` to read the wrapper's own
// label prop, `cloned` to walk the wrapper's body — so it lives in one scanner
// rather than two. Keeping every still-open instance (not just the outermost)
// is what lets an inner `<Field label="…">` nested in an unlabeled outer one
// name the control. `contentStart` is where that instance's children begin, for
// callers that need to walk the body.
function openWrapperInstancesAt(src, name, index) {
  const open = [];
  for (const node of forEachTag(src, name)) {
    if (node.index >= index) break;
    if (node.closing) {
      open.pop();
      continue;
    }
    // An unterminated tag has no children to be nested in, and a self-closing
    // one wraps nothing.
    if (node.tag === null || node.selfClosing) continue;
    open.push(node);
  }
  return open;
}

// Is the control at `index` the FIRST direct child of `wrapper`? A cloning
// wrapper clones its id onto its first
// React child only, so a later control (DataDog's optional custom-site input)
// must remain actionable. The question is only ever "did ANYTHING precede the
// control" — a boolean, not the preceding node's identity, so that a control
// preceded by a literal `<input>` sibling can never read as the first child of
// a wrapper that never named it. The walk has to survive every JSX shape that
// can legitimately precede or contain the control inside a wrapper body:
// whitespace and text nodes, `{expr}` children, fragments, self-closing tags.
//
// PRECONDITION: `wrapper` is still OPEN at `index` — feed this only a node from
// `openWrapperInstancesAt`. Its scanner-derived parent link is the proof that
// the control is a child of this instance, rather than a tag a cursor happened
// to cross after the wrapper had closed.
function isFirstDirectChild(src, wrapper, index) {
  const nodesByIndex = new Map(tagIndexOf(src).map((node) => [node.index, node]));
  const node = nodesByIndex.get(index);
  if (!node || node.closing || node.parent !== wrapper) return false;

  let sawPrecedingChild = false;
  let cursor = wrapper.contentStart;
  while (cursor < index) {
    if (/\s/.test(src[cursor])) {
      cursor++;
      continue;
    }
    if (src[cursor] === '{') {
      const end = matchingBraceEnd(src, cursor);
      if (end === -1) return false;
      if (end >= index) {
        // The control lives inside this expression rather than after it.
        return !sawPrecedingChild && isDirectElementInExpression(src, cursor + 1, node);
      }
      if (src.slice(cursor + 1, end).trim()) sawPrecedingChild = true;
      cursor = end + 1;
      continue;
    }
    if (src[cursor] !== '<') {
      const nextTag = src.indexOf('<', cursor);
      const nextExpression = src.indexOf('{', cursor);
      const next = Math.min(
        nextTag === -1 ? index : nextTag,
        nextExpression === -1 ? index : nextExpression,
        index,
      );
      if (src.slice(cursor, next).trim()) sawPrecedingChild = true;
      cursor = next;
      continue;
    }

    const current = nodesByIndex.get(cursor);
    if (!current) {
      cursor++;
      continue;
    }
    if (current.closing) {
      cursor = current.contentStart;
      continue;
    }
    if (current.parent === wrapper) sawPrecedingChild = true;
    if (current.selfClosing) {
      cursor = current.contentStart;
      continue;
    }
    if (!current.matchingClose) return false;
    cursor = current.matchingClose.contentStart;
  }
  // `cursor === index` matters as much as the rest: a walk that broke out early
  // or overshot never proved anything about the control.
  return !sawPrecedingChild && cursor === index;
}

// The "cloned" shape: the wrapper generates the id itself and clones it onto
// its first React child (components/ui/FormField.jsx), so the control is named
// without either side writing a `<label htmlFor>` next to it.
function isNestedInLabeledCloner(src, { index }, { labelProp }, wrapperName) {
  if (index === undefined) return false;
  return openWrapperInstancesAt(src, wrapperName, index).some((wrapper) => (
    hasUsableLabelProp(wrapper.tag, labelProp) && isFirstDirectChild(src, wrapper, index)
  ));
}

// --- the wrapper registry -------------------------------------------------
//
// A control is often named by the component that wraps it rather than by markup
// written next to it. Whether the guard sees that has two independent
// dimensions, and flattening them into ad-hoc branches left half the
// combinations unreachable (#4317):
//
//   WHERE the wrapper is declared — in this file, or imported from a relative
//   path. Resolved by `wrapperRegistry`, which reads the imported file and runs
//   the very same detectors on it.
//
//   HOW it names — proved by `wrapperShapes` from the wrapper's own source:
//     implicit  `<label …>{children}</label>` — the control is wrapped in a
//               real <label> (PipelineSeries.jsx's `<Field label="…">`), so the
//               text that <label> carries names it.
//     forwarded `<label htmlFor={idProp}>{labelProp}</label>` — the wrapper
//               renders the <label>, the call site supplies the id and text
//               (LifestyleTab.jsx's `<FieldGroup>`).
//     cloned    the wrapper generates the id and clones it onto its first React
//               child (components/ui/FormField.jsx).
//
// Every entry is earned by reading the wrapper's source, never by matching its
// name. That is what stops the registry degenerating into "any component with a
// label-ish prop exempts its input", and it is why the imported branch can be
// trusted at all: an imported `FormField` is credited because its <label> was
// read, not because it is spelled FormField.

// A component is either a `function` declaration or an arrow assigned to a
// capitalized binding. Both forms count: an arrow-shaped label wrapper names
// its control just as well, and treating it as invisible pushes new code toward
// an `aria-label` that shadows the visible label the wrapper already renders.
// A concise arrow body that is neither `{…}` nor `(…)` (`= (p) => <label…>`) is
// still skipped — there is no cheap end boundary for it, and the repo wraps
// multi-line JSX in parens.
// `[\w$]` matches `relativeImportBindings` on the other side of the import: `$`
// is a legal identifier character, and a detector that admits `Fi$ld` as an
// imported binding while this one refuses to declare it left such a wrapper
// invisible from both directions at once — which is why no fixture could
// witness the disagreement.
function forEachLocalComponent(src, visit) {
  const re = /(?:function\s+([A-Z][\w$]*)\s*\(|(?:const|let|var)\s+([A-Z][\w$]*)\s*=\s*(?:async\s+)?\()/g;
  let match;
  while ((match = re.exec(src))) {
    // Skip the parameter list with the string-aware scanner — a default value
    // like `{ label = ')' }` would close the parens early on a naive count and
    // point the body start at the destructuring instead of the body.
    const [, declaredName, arrowName] = match;
    const parenIndex = match.index + match[0].length - 1;
    const params = balancedCallAt(src, parenIndex);
    if (!params) continue;
    const afterParams = parenIndex + params.length;
    const body = declaredName === undefined
      ? arrowBodyAt(src, afterParams)
      : blockBodyAt(src, afterParams);
    if (body === null) continue;
    visit(declaredName ?? arrowName, body.text, params, body.start);
  }
}

// `{ start, text }` rather than the bare slice: `enclosingParameterizedComponent`
// has to decide whether a control's source index falls inside a component, and
// the slice alone cannot answer that.
function blockBodyAt(src, from) {
  const bodyStart = src.indexOf('{', from);
  if (bodyStart === -1) return null;
  const bodyEnd = matchingBraceEnd(src, bodyStart);
  return bodyEnd === -1 ? null : { start: bodyStart, text: src.slice(bodyStart, bodyEnd) };
}

// `=>` is what separates a component from an ordinary parenthesized
// initializer (`const RE = ('a' + 'b')`), which would otherwise register as a
// component whose "body" is the next brace block in the file.
function arrowBodyAt(src, from) {
  const arrow = /^\s*=>\s*/.exec(src.slice(from));
  if (!arrow) return null;
  const bodyStart = from + arrow[0].length;
  if (src[bodyStart] === '{') return blockBodyAt(src, bodyStart);
  if (src[bodyStart] === '(') {
    const text = balancedCallAt(src, bodyStart);
    return text === null ? null : { start: bodyStart, text };
  }
  return null;
}

// Every `<label>` element in a component body, as `{ tag, inner }`. A
// self-closing `<label />` wraps nothing and carries no text, so it is skipped.
function* labelElements(body) {
  for (const { tag, contentStart, selfClosing } of forEachOpeningTag(body, 'label')) {
    if (selfClosing) continue;
    const close = body.indexOf('</label>', contentStart);
    if (close === -1) continue;
    yield { tag, inner: body.slice(contentStart, close) };
  }
}

// Strip JSX tags, leaving only what renders as text. A quoted attribute value
// or a `{…}` expression can hold a `>` (`<span title=">" data-tooltip={label}/>`),
// so the shared tag index tracks both rather than stopping at the first one —
// otherwise the tail of a tag survives as "text" and its attributes read as
// rendered props.
function stripJsxTags(source) {
  const nodes = tagIndexOf(source, { startMode: 'jsx-text' });
  const incomplete = nodes.find((node) => node.tag === null);
  const spans = nodes
    .filter((node) => node.tag !== null)
    .map((node) => ({ start: node.index, end: node.contentStart }));
  // An unterminated tag swallows the rest: nothing after it is text.
  if (incomplete) spans.push({ start: incomplete.index, end: source.length });
  return blankSourceSpans(source, spans);
}

// `Children.map(children, (child, i) => …)` — proof that `cloneTarget` is the
// CALLER's child rather than an element the wrapper built for itself. Without
// it, `cloneElement(internalControl, { id })` looks like the FormField shape
// while the caller's control never receives the id at all.
function clonesChildrenParameter(body, cloneTarget, parameterNames) {
  const re = /Children\.map\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*\(?\s*([A-Za-z_$][\w$]*)/g;
  let match;
  while ((match = re.exec(body))) {
    const [, mapped, element] = match;
    if (parameterNames.has(mapped) && element === cloneTarget) return true;
  }
  return false;
}

// Which naming strategies a component's source proves it implements. Reads
// whatever source it is handed; the scan hands over `maskComments(src)`, which
// is what keeps a commented-out wrapper from registering.
function wrapperShapes(body, params) {
  if (!body.includes('<label')) return [];
  const parameterNames = new Set(params.match(/[A-Za-z_$][\w$]*/g) ?? []);
  const shapes = [];
  for (const { tag, inner } of labelElements(body)) {
    // Every shape has to prove the <label> really carries text before the call
    // site's attributes can be trusted — that is the one invariant all three
    // share, and dropping it would turn the registry into "any component with a
    // label-ish prop exempts its input". `labelProp` names where that text comes
    // from: a parameter the <label> renders, or `children` (the call site's
    // element body). A <label> holding neither is not a naming wrapper.
    //
    // Nested markup is stripped first, so only expressions in TEXT position
    // count. A prop passed to a nested element's attribute renders no text:
    // `<label><span className={label} aria-hidden />{children}</label>` puts
    // nothing in the accessible name, and reading its `label` prop as the name
    // would exempt a genuinely unnamed control.
    const renderedText = stripJsxTags(inner);
    const rendered = [...renderedText.matchAll(/\{\s*([A-Za-z_$][\w$]*)\s*\}/g)].map(([, name]) => name);
    const childrenInLabel = rendered.includes('children');
    const labelProp = rendered.find((name) => name !== 'children' && parameterNames.has(name)) ?? null;

    // `{children}` inside the <label> means the control itself is wrapped, so
    // the name has to come from somewhere ELSE in that <label>.
    if (childrenInLabel && labelProp !== null) shapes.push({ kind: 'implicit', labelProp });

    const idRef = /\bhtmlFor\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*\}/.exec(tag)?.[1];
    if (!idRef) continue;
    if (parameterNames.has(idRef)) {
      // The id comes from the call site, so the call site's same-named
      // attribute is this control's id. A <label> pointed at a module-level
      // constant forwards nothing, and reading the call site's attributes then
      // would exempt an unrelated control — hence the parameter check.
      //
      // Here the control is NOT the wrapper's children, so `{children}` in the
      // <label> is the name, supplied as the element's body at the call site
      // (`<FieldLabel htmlFor="world-logline">Logline</FieldLabel>`).
      const forwardedLabelProp = labelProp ?? (childrenInLabel ? 'children' : null);
      if (forwardedLabelProp !== null) shapes.push({ kind: 'forwarded', idProp: idRef, labelProp: forwardedLabelProp });
      continue;
    }
    // The id is generated here. It only reaches a child if the wrapper clones
    // it on, so demand the clone as proof rather than assuming the shape.
    //
    // The target must be the `Children.map` callback parameter, since that is
    // the only thing the call-site check can then credit. An indexed target
    // (`cloneElement(children[1], …)`) names the SECOND child while the check
    // below credits the FIRST, and an element the wrapper built for itself
    // (`cloneElement(internalControl, …)`) never touches the caller's child at
    // all — both would exempt a control the wrapper never named.
    if (labelProp === null) continue;
    const cloneTarget = new RegExp(`cloneElement\\s*\\(\\s*([A-Za-z_$][\\w$]*)\\s*,\\s*\\{[^}]*\\bid\\s*:\\s*${idRef}\\b`).exec(body)?.[1];
    if (cloneTarget && clonesChildrenParameter(body, cloneTarget, parameterNames)) {
      shapes.push({ kind: 'cloned', labelProp });
    }
  }
  return shapes;
}

// Resolve a relative import specifier to a client-relative path, the way the
// bundler would. Restricted to git-tracked sources for the same reason the scan
// is: an untracked scratch file must not be able to name a control either.
function resolveRelativeImport(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = join(dirname(fromFile), specifier);
  const candidates = [base, `${base}.jsx`, `${base}.js`, `${base}/index.jsx`, `${base}/index.js`];
  // The virtual set is consulted without being folded into `trackedSourceSet()`
  // — that Set is memoized for the whole suite, and seeding it would outlive
  // the probe that installed the module.
  return candidates.find((candidate) => virtualSources.has(candidate) || trackedSourceSet().has(candidate)) ?? null;
}

// `export { A }` / `export { A as B }` / `import { A as B }` all bind the same
// way: the left name is what the SOURCE module exports, the right one is what
// this module calls it. Shared so an import clause and a re-export clause can
// never drift apart on the aliasing.
function addNamedClauseBindings(bindings, clause, file) {
  for (const entry of clause.split(',')) {
    const [exported, local] = entry.trim().split(/\s+as\s+/);
    if (exported) bindings.set(local ?? exported, { file, exportedName: exported });
  }
}

// Local binding name -> { file, exportedName } for every relatively-imported
// component. `default` stands in for a default import; the imported file
// resolves it to the component it actually points at.
function relativeImportBindings(src, file) {
  const bindings = new Map();
  const re = /import\s+([^'";]+?)\s+from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = re.exec(src))) {
    const [, clause, specifier] = match;
    const resolved = resolveRelativeImport(file, specifier);
    if (!resolved) continue;
    const named = /\{([^}]*)\}/.exec(clause);
    if (named) addNamedClauseBindings(bindings, named[1], resolved);
    const defaultBinding = clause.replace(/\{[^}]*\}/, ' ').replace(/,/g, ' ').trim();
    if (/^[A-Z][\w$]*$/.test(defaultBinding)) bindings.set(defaultBinding, { file: resolved, exportedName: 'default' });
  }
  return bindings;
}

// Which component a file's default export actually points at:
//
//   export default FormField              -> FormField
//   export default function FormField()   -> FormField
//   export default memo(Field)            -> Field
//   export default React.memo(Field)      -> Field
//   export default memo(forwardRef(Field))-> Field
//   export default forwardRef(function Field(props) {…}) -> Field
//
// Each pass steps over one `identifier(` prefix, so what is credited is the
// innermost thing the export really names rather than the HOC wrapping it. A
// default that is neither a reference nor a call — an inline arrow, an object
// literal, an anonymous `memo(({label}) => …)` — yields null: there is no
// declared component to look up, and guessing at a neighbouring capitalized
// name would credit a wrapper the export does not point at. The depth bound is
// a backstop; real HOC stacks in this tree are one or two deep.
function defaultExportName(src) {
  const start = /export\s+default\s+/.exec(src);
  if (!start) return null;
  let rest = src.slice(start.index + start[0].length).trimStart();
  for (let depth = 0; depth < 4; depth++) {
    const ref = /^(function\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*/.exec(rest);
    if (!ref) return null;
    const [, isDeclaration, reference] = ref;
    const after = rest.slice(ref[0].length);
    // A declaration owns its parens (they are its parameter list), so it is the
    // name — only a bare reference followed by `(` is a call to unwrap.
    if (isDeclaration || !after.startsWith('(')) {
      const name = reference.split('.').pop();
      return /^[A-Z]/.test(name) ? name : null;
    }
    rest = after.slice(1).trimStart();
  }
  return null;
}

// `export { Field } from './Field'` / `export { default as Field } from './Field'`
// — the barrel idiom this tree writes. A barrel declares no components of its
// own, so `forEachLocalComponent` finds nothing in it and the registry reports
// "not a wrapper" for a wrapper it simply never opened. Re-exports are chased
// through `importedComponentShapes`, which already publishes its map before
// filling it, so a barrel cycle resolves to no shapes instead of recursing.
//
// `export * from './x'` is still undecoded: it forwards names without listing
// them, so resolving one means reading every star target on every miss. No
// barrel in this tree star-exports a label wrapper (they star only constants
// modules), and the miss direction is the safe one — a control stays on the
// allowlist rather than being falsely exempted.
function reExportBindings(src, file) {
  const bindings = new Map();
  const re = /export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = re.exec(src))) {
    const [, clause, specifier] = match;
    const resolved = resolveRelativeImport(file, specifier);
    if (resolved) addNamedClauseBindings(bindings, clause, resolved);
  }
  return bindings;
}

const importedShapesByFile = new Map();

function importedComponentShapes(file, exportedName) {
  let byName = importedShapesByFile.get(file);
  if (!byName) {
    // Publish the (empty) map before building it: two components that import
    // each other would otherwise recurse forever. A cycle resolves to no shapes
    // for whichever file is re-entered, which is a false negative that leaves
    // its controls on the allowlist.
    byName = new Map();
    importedShapesByFile.set(file, byName);
    const src = maskedSourceOf(file);
    for (const [name, shapes] of wrapperRegistry(src, file)) byName.set(name, shapes);
    // The local binding at the call site can be spelled anything, so the
    // default export is resolved to the component it names (#4327).
    const defaultName = defaultExportName(src);
    if (defaultName && byName.has(defaultName)) byName.set('default', byName.get(defaultName));
    // A barrel's own declarations win over what it forwards: a module cannot
    // export the same name twice, so this only fills names it has none for.
    for (const [name, forwarded] of reExportBindings(src, file)) {
      if (byName.has(name)) continue;
      const shapes = importedComponentShapes(forwarded.file, forwarded.exportedName);
      if (shapes.length) byName.set(name, shapes);
    }
    importedShapesByFile.set(file, byName);
  }
  return byName.get(exportedName) ?? [];
}

const wrapperRegistryByFile = new Map();

// name -> shape[] for every wrapper this file can render.
//
// Cached by path, not by source: the scan hands over the file's own memoized
// masked source, so the two are the same string object and `===` settles it in
// a pointer compare. The probe fixtures pass a synthetic source under a real
// directory (they only need it to resolve their relative imports) and build
// fresh each time, which is cheap for a handful of one-line sources.
function wrapperRegistry(src, file) {
  const cacheable = file !== undefined && src === maskedSourceByFile.get(file);
  if (cacheable && wrapperRegistryByFile.has(file)) return wrapperRegistryByFile.get(file);

  const registry = new Map();
  // A module cannot bind the same identifier twice, so a plain `set` is enough
  // — a local declaration and an import can never collide on one name.
  const add = (name, shapes) => {
    if (shapes.length) registry.set(name, shapes);
  };
  forEachLocalComponent(src, (name, body, params) => add(name, wrapperShapes(body, params)));
  if (file !== undefined) {
    // Only pay to read a file whose component this one actually renders. Asked
    // of the tag index rather than a pattern: the index already knows every
    // element name in this source, and reading the binding literally is what
    // keeps a `$` in it from compiling to an anchor that matches nothing.
    const rendered = renderedTagNames(src);
    for (const [localName, { file: importedFile, exportedName }] of relativeImportBindings(src, file)) {
      if (!rendered.has(localName)) continue;
      add(localName, importedComponentShapes(importedFile, exportedName));
    }
  }
  if (cacheable) wrapperRegistryByFile.set(file, registry);
  return registry;
}

// Install stand-in modules for one callback, then drop them along with every
// cache entry they seeded — `finally`, so a failing assertion inside cannot
// leak a virtual module into the rules that read real source. Test-only:
// nothing in the scan reaches it.
function withVirtualSources(sources, run) {
  for (const [file, src] of Object.entries(sources)) virtualSources.set(file, src);
  try {
    return run();
  } finally {
    for (const file of Object.keys(sources)) {
      virtualSources.delete(file);
      maskedSourceByFile.delete(file);
      wrapperRegistryByFile.delete(file);
      importedShapesByFile.delete(file);
    }
  }
}

function isNestedInLabelWrapper(src, { index }, { labelProp }, name) {
  if (index === undefined) return false;
  return openWrapperInstancesAt(src, name, index).some(({ tag }) => hasUsableLabelProp(tag, labelProp));
}

// One matcher per shape `wrapperShapes` can emit. Adding a naming strategy is a
// detector branch plus an entry here — not another recognizer function plus
// another hand-written line in `hasAccessibleControlName`.
const SHAPE_MATCHERS = {
  implicit: isNestedInLabelWrapper,
  forwarded: forwardsLabelForId,
  cloned: isNestedInLabeledCloner,
};

// Is the control described by `context` named by one of the wrappers this file
// can render? `context` carries the control's source `index` (for the two
// ancestor-based shapes), its `id` (for the id-forwarding shape), and the
// `file` whose relative imports the registry may follow.
function isNamedByWrapper(src, context) {
  for (const [name, shapes] of wrapperRegistry(src, context.file)) {
    for (const shape of shapes) {
      if (SHAPE_MATCHERS[shape.kind](src, context, shape, name)) return true;
    }
  }
  return false;
}

// The mirror image of the wrapper shapes: instead of a component that renders
// the <label> around someone else's control, a REUSABLE CONTROL that takes its
// own `id` as a prop and leaves the <label> to whoever renders it
// (components/EntityCombobox.jsx, components/TagPicker.jsx). Nothing in the
// control's own file names it, and an `aria-label` here would OVERRIDE the
// caller's visible label — a regression, not a fix — so the name has to be
// proved where it actually lives: at the call sites.
//
// Which component owns `index`, if that component takes `param` as a prop. The
// innermost match wins: a file can declare a small control inside a page
// component, and it is the nearest enclosing parameter list that supplies the
// id. Returns the component's name so its exports can be resolved.
function enclosingParameterizedComponent(src, index, param) {
  let owner = null;
  const parameterRe = new RegExp(`\\b${param}\\b`);
  forEachLocalComponent(src, (name, body, params, bodyStart) => {
    if (index < bodyStart || index >= bodyStart + body.length) return;
    if (!parameterRe.test(params)) return;
    if (!owner || bodyStart > owner.bodyStart) owner = { name, bodyStart };
  });
  return owner?.name ?? null;
}

// Under which names can another module import `name` from this source? The
// local declaration name for a named export, and `default` when the file's
// default export points at it — the same two spellings `relativeImportBindings`
// records on the other side of the import.
function exportedNamesOf(src, name) {
  const names = new Set();
  const declared = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|var)\\s+${name}\\b`);
  const listed = new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`);
  if (declared.test(src) || listed.test(src)) names.add(name);
  if (/export\s+default\s+(?:function\s+)?([A-Z][\w$]*)/.exec(src)?.[1] === name) names.add('default');
  return names;
}

// One verdict per `<Name …>` in `src`: does this call site pass `idProp` a
// value AND pair a <label htmlFor> carrying text for it? Both halves are
// required — an id with no label names nothing, and a label with no id names
// something else.
//
// The one caller that walks `forEachTag` rather than `forEachOpeningTag`: it
// quantifies over these verdicts, so an unreadable tag has to contribute a
// `false` rather than drop out of the count. Skipping it is correct for a
// scanner asking "which tags are there", wrong for one asking "did every call
// site do its half", which would quietly weaken to "every PARSEABLE call site".
// That is exactly why the walk yields unterminated tags instead of deciding for
// its callers what to do with one.
function callSiteIdVerdicts(src, name, idProp) {
  const verdicts = [];
  for (const { closing, tag } of forEachTag(src, name)) {
    if (closing) continue;
    if (tag === null) {
      verdicts.push(false);
      continue;
    }
    const id = normalizedAttributeValue(attributeValue(tag, idProp));
    verdicts.push(id !== null && id !== '' && hasMatchingLabelElement(src, id));
  }
  return verdicts;
}

// `sites` are the files importing this one, each with the local name it bound
// the component to. EVERY rendered call site has to do its half: one that
// passes the id and no label leaves the control unnamed on that screen, which
// is exactly what the rule scans for. Without that quantifier this degenerates
// into "any component with an id prop is exempt" — the same bypass the wrapper
// shapes demand proof against. An unrendered import proves nothing either way,
// so a component with no call sites at all is never credited.
function hasCallerSuppliedName(src, tag, index, sites) {
  // Anchored on whitespace the way `attributeValue` is: a `\b` would read
  // `data-id={rowId}` as the control's own id and credit an unrelated prop.
  const idProp = /(?:^|\s)id\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*\}/.exec(tag)?.[1];
  if (!idProp) return false;
  const owner = enclosingParameterizedComponent(src, index, idProp);
  if (!owner) return false;
  const exported = exportedNamesOf(src, owner);
  const verdicts = sites
    .filter(({ exportedName }) => exported.has(exportedName))
    .flatMap((site) => callSiteIdVerdicts(site.src, site.localName, idProp));
  return verdicts.length > 0 && verdicts.every(Boolean);
}

// file -> [{ src, localName, exportedName }] for every tracked file importing
// it. Built once over the whole tree: resolving importers is the half a
// per-file scan cannot do, and the sources are the same memoized masked strings
// the scan already reads.
let importerIndexCache = null;

function callSitesOf(file) {
  if (!importerIndexCache) {
    importerIndexCache = new Map();
    for (const importer of trackedJsxFiles()) {
      const src = maskedSourceOf(importer);
      for (const [localName, { file: target, exportedName }] of relativeImportBindings(src, importer)) {
        if (!importerIndexCache.has(target)) importerIndexCache.set(target, []);
        importerIndexCache.get(target).push({ src, localName, exportedName });
      }
    }
  }
  return importerIndexCache.get(file) ?? [];
}

function hasUsableAriaLabelledByReference(src, tag) {
  const raw = attributeValue(tag, 'aria-labelledby');
  const value = normalizedAttributeValue(raw);
  if (!value || !/^[A-Za-z][\w:.-]*(?:\s+[A-Za-z][\w:.-]*)*$/.test(value)) return false;
  // One pass over the memoized tag index per id, not a fresh lex of the file.
  return value.split(/\s+/).every((id) => {
    for (const node of forEachOpeningTag(src)) {
      if (normalizedAttributeValue(attributeValue(node.tag, 'id')) !== id) continue;
      if (isHiddenFromAccessibility(node.tag)) return false;
      if (hasUsableElementText(src, node)) return true;
    }
    return false;
  });
}

// `type`-derived names are an <input>-only affordance: a submit button names
// itself from `value`, an image button from `alt`, and a hidden input is not in
// the a11y tree at all. <select> and <textarea> have no such escape hatch, so
// the caller passes the tag name rather than this reading `type` off anything
// that happens to carry one.
function hasAccessibleControlName(src, tag, index, tagName, file) {
  if (hasUsableAccessibleNameAttribute(tag, 'aria-label')) return true;
  if (hasUsableAccessibleNameAttribute(tag, 'aria-labelledby') && hasUsableAriaLabelledByReference(src, tag)) return true;
  if (tagName === 'input' && hasUsableNativeInputName(tag)) return true;
  if (isNestedInLabel(src, index)) return true;

  const id = normalizedAttributeValue(attributeValue(tag, 'id'));
  if (id !== null && id !== '' && hasMatchingLabelElement(src, id)) return true;
  if (isNamedByWrapper(src, { index, id: id || null, file })) return true;
  return file !== undefined && hasCallerSuppliedName(src, tag, index, callSitesOf(file));
}

// Keep exceptions tied to stable source anchors rather than line numbers, so
// inserting code above a control does not move the exception to a different
// control; remove each entry as its control receives a real name. The tag name
// is part of the anchor so a <select> and a <textarea> that happen to share a
// file and an attribute set can't exempt each other.
const CONTROL_ANCHOR_ATTRIBUTES = [
  'id', 'name', 'type', 'placeholder', 'value', 'ref', 'title', 'role',
  'aria-label', 'aria-labelledby', 'autoFocus', 'min', 'max', 'step', 'rows',
];

function controlSemanticAnchor(tag) {
  return CONTROL_ANCHOR_ATTRIBUTES.map((name) => {
    const value = attributeValue(tag, name);
    return value === null ? null : `${name}=${value.replace(/\s+/g, ' ')}`;
  }).filter(Boolean).join('|');
}

// The anchor has to enumerate controls the same way the scan that produced
// `node` did, or `matching.indexOf(node.index)` numbers occurrences against a
// set the scan never visited: a `<input` written in an attribute VALUE is not a
// control, and one ghost whose semantic anchor collides renames every later
// occurrence — silently invalidating the hand-maintained allowlist row keyed on
// the old name. Both sides read the one tag index, so they cannot disagree.
// `node` rather than a bare index for the same reason: re-slicing the tag it
// was handed is a second answer to a question already settled.
function controlSourceAnchor(file, src, { tag, index }, tagName) {
  if (!tag) return `${file}|${tagName}|unknown`;
  const semantic = controlSemanticAnchor(tag);
  const matching = [];
  for (const { tag: otherTag, index: otherIndex } of forEachOpeningTag(src, tagName)) {
    if (controlSemanticAnchor(otherTag) === semantic) matching.push(otherIndex);
  }
  const base = `${file}|${tagName}|${semantic}`;
  if (matching.length === 1) return base;
  return `${base}|occurrence=${matching.indexOf(index) + 1}`;
}

// Pre-existing controls exposed when the rule was generalized; the migration is
// tracked in #4297. The list is EMPTY — every <input> in the tree now carries a
// real accessible name. The last two rows were EntityCombobox / TagPicker, the
// caller-supplied-id shape a same-file scan cannot resolve; `hasCallerSuppliedName`
// (#4321) reads the call sites instead of exempting the control.
//
// Keep it empty. A new unnamed <input> is a bug to fix at the control, not a row
// to add here — and never by bolting on an `aria-label` that shadows a visible
// label the caller already renders.
const PREEXISTING_INPUT_NAME_ALLOWLIST = new Set([]);

// The <select>/<textarea> half of the same rule, seeded when #4309 widened the
// scan past <input>. The live backlog is now EMPTY: the last 121 real offenders
// were named in the #4930 sweep. The four rows left are not unnamed controls —
// they are the limit of a source-level scan, which cannot follow a name across
// a component boundary:
//
//   * ArtistPicker / AuthorPicker take an `id` prop and forward it to their
//     own <select>. Every call site renders them inside a FormField, whose
//     <label htmlFor> points at that same id — so the control IS labelled, one
//     file away from where the scan can see it.
//   * AutoSizeTextarea / ProseEditor spread `{...rest}` onto their <textarea>,
//     so the accessible name arrives from the caller. A name hardcoded here
//     would be wrong for every caller and would MASK a caller that passes none.
//
// Do not "burn these down" by inventing a name for them. The way to empty this
// list is to teach the scan to follow an `id`/`{...rest}` prop through a
// component boundary; until then these four rows are the honest answer.
// A NEW unnamed control does not belong here — name it instead (a paired
// `<label htmlFor>` first, `aria-label` only where a visible label would
// break the layout).
const PREEXISTING_SELECT_TEXTAREA_NAME_ALLOWLIST = new Set([
  "src/components/music/ArtistPicker.jsx|select|id=id|value=value || ''",
  "src/components/pipeline/AuthorPicker.jsx|select|id=id|value=value || ''",
  "src/components/ui/AutoSizeTextarea.jsx|textarea|value=value|ref=ref",
  "src/components/ui/ProseEditor.jsx|textarea|placeholder=placeholder|value=value|ref=ref",
]);

describe('a11y conventions', () => {
  // Modal.jsx IS the shared implementation; Drawer and Layout use the same
  // backdrop treatment for a slide-in panel / mobile nav scrim, both of which
  // already own Esc + focus handling of their own.
  // MediaLightbox documents its opt-out at the top of the file (viewport-edge
  // chevrons + a layered Esc cascade Modal's stack would swallow) and supplies
  // the dialog semantics itself: role="dialog"/aria-modal, useFocusTrap, and a
  // window-level Esc handler.
  const MODAL_BACKDROP_ALLOWLIST = new Set([
    'src/components/ui/Modal.jsx',
    'src/components/Drawer.jsx',
    'src/components/Layout.jsx',
    'src/components/media/MediaLightbox.jsx',
  ]);

  it('routes full-screen dark overlays through the shared <Modal>', () => {
    const offenders = [];
    for (const file of trackedJsxFiles()) {
      if (MODAL_BACKDROP_ALLOWLIST.has(file)) continue;
      const src = rawSourceOf(file);
      // Only a dimming backdrop counts — `fixed inset-0` alone is also used for
      // non-modal chrome (HUD panels, drag overlays, canvas layers).
      const re = /fixed inset-0[^"'`]*bg-black\//g;
      let m;
      while ((m = re.exec(src))) {
        offenders.push(`${file}:${lineOf(src, m.index)}`);
      }
    }
    expect(offenders, `Hand-rolled modal backdrop — use components/ui/Modal.jsx (focus trap + Esc stack + role=dialog):\n${offenders.join('\n')}`).toEqual([]);
  });

  it('marks toggle-switch buttons with role="switch"', () => {
    // Pill-track dimensions used by the hand-rolled toggles in this codebase.
    // A switch is always a fixed-size rounded-full track roughly twice as wide
    // as it is tall; ordinary rounded-full buttons (icon buttons, chips) don't
    // pin both dimensions like this.
    const TRACK_SIZES = /\b(h-6 w-11|w-11 h-6|w-10 h-5|h-5 w-10|h-5 w-9|w-9 h-5|h-8 w-14|w-14 h-8|h-7 w-12|w-12 h-7)\b/;
    const offenders = [];
    for (const file of trackedJsxFiles()) {
      const src = rawSourceOf(file);
      for (const { tag, index } of forEachOpeningTag(src, 'button')) {
        if (!/rounded-full/.test(tag) || !TRACK_SIZES.test(tag)) continue;
        if (/role="switch"/.test(tag)) continue;
        offenders.push(`${file}:${lineOf(src, index)}`);
      }
    }
    expect(offenders, `Toggle-switch button without role="switch" + aria-checked — prefer components/ToggleSwitch.jsx:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('keeps every file input focusable and label-activated', () => {
    // Two failures ride on the same markup, and neither reproduces for the
    // author: `display:none` (Tailwind `hidden`) drops the input from the tab
    // order AND the a11y tree, and a `<button onClick={ref.current.click()}>`
    // paired with it is a synthetic click several engines refuse to honor —
    // notably WebKit with PortOS installed as a standalone PWA, which is how it
    // gets opened from a second machine over the tailnet. The picker simply
    // never appears. components/ui/FilePickerButton.jsx is the shared fix
    // (sr-only input + a real <label for>); this test is what stops the old
    // idiom from creeping back in one component at a time.
    const offenders = [];
    for (const file of trackedSourceFiles()) {
      const src = rawSourceOf(file);
      for (const { tag, index } of forEachOpeningTag(src, 'input')) {
        // Match against the whole opening tag, not a quoted-attribute-shaped
        // regex: `type='file'` / `type={'file'}` and a `hidden` arriving via a
        // template literal or ternary (`className={cond ? 'hidden' : ''}`) are
        // the same bug, and a quote-specific pattern waves them through.
        if (!/\btype\s*=\s*[{'"]*\s*['"]?file\b/.test(tag)) continue;
        const hidden = /\bhidden\b/.test(tag) || /display:\s*['"]?none/.test(tag);
        const ariaHidden = /aria-hidden/.test(tag);
        const untabbable = /tabIndex\s*=\s*\{\s*-1\s*\}/.test(tag);
        if (!hidden && !ariaHidden && !untabbable) continue;
        offenders.push(`${file}:${lineOf(src, index)}`);
      }
    }
    expect(offenders, `File input hidden from keyboard/AT — use components/ui/FilePickerButton.jsx (sr-only input + native <label for> activation), never className="hidden" / aria-hidden / tabIndex={-1} / display:none:\n${offenders.join('\n')}`).toEqual([]);
  });

  // A programmatic ref click is legitimate for a synthesized <a download> — the
  // rule below is about file inputs, so real non-input uses get an escape hatch
  // (mirroring MODAL_BACKDROP_ALLOWLIST) rather than a misleading failure.
  const REF_CLICK_ALLOWLIST = new Set([]);

  it('never opens a file picker with a programmatic ref click', () => {
    // The other half of the same bug: even a correctly-focusable input is
    // unopenable in those engines if a button reaches over and clicks it.
    const offenders = [];
    for (const file of trackedSourceFiles()) {
      if (REF_CLICK_ALLOWLIST.has(file)) continue;
      const src = rawSourceOf(file);
      const re = /\.current\s*\??\.\s*click\(\)/g;
      let m;
      while ((m = re.exec(src))) {
        offenders.push(`${file}:${lineOf(src, m.index)}`);
      }
    }
    expect(offenders, `Programmatic .click() on a ref — if it targets a file input the picker never opens in WebKit/PWA; use components/ui/FilePickerButton.jsx. If the ref is genuinely NOT a file input (e.g. a synthesized <a download>), add the file to REF_CLICK_ALLOWLIST above with a comment:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('names every never-dismissing toast that cannot name itself', () => {
    // A `duration: Infinity` toast folds into an icon-only pill after
    // COLLAPSE_AFTER_MS so it stops covering the page (components/ui/Toast.jsx).
    // The pill takes its accessible name from string content — but JSX and
    // render-prop content have no text to take, so without `label` the whole
    // name is "Show notification" and the notice becomes unidentifiable to a
    // screen reader for the rest of its (unbounded) life. Nothing at runtime
    // complains, so this is the only thing that catches it.
    const offenders = [];
    for (const file of trackedSourceFiles()) {
      const src = rawSourceOf(file);
      const re = /\btoast(?:\.\w+)?\s*\(/g;
      let m;
      while ((m = re.exec(src))) {
        const call = balancedCallAt(src, re.lastIndex - 1);
        if (!call || !/\bduration:\s*Infinity\b/.test(call)) continue;
        // Only content that demonstrably isn't a string needs `label`: inline
        // JSX and render props. A literal or a variable is left alone — the
        // pill reads a string straight off `t.content`.
        const firstArg = call.slice(1).trimStart();
        const isJsx = firstArg.startsWith('<');
        const isRenderProp = /^(\([^)]*\)|\w+)\s*=>/.test(firstArg);
        if (!isJsx && !isRenderProp) continue;
        if (/\blabel:/.test(call)) continue;
        offenders.push(`${file}:${lineOf(src, m.index)}`);
      }
    }
    expect(offenders, `A duration: Infinity toast with JSX/render-prop content must pass \`label\` — it collapses to a pill that has no other accessible name (see COLLAPSE_AFTER_MS in components/ui/Toast.jsx):\n${offenders.join('\n')}`).toEqual([]);
  });

  it('slices toast calls whose JSX text contains an apostrophe', () => {
    // The rule above is only as good as the slicer. An apostrophe in JSX text
    // opens a "string" that never closes, so the scan runs past the closing
    // paren — and a `null` slice is skipped silently, letting the exact shape
    // the rule targets (JSX content, no `label`) ship unflagged.
    const jsx = `toast(<div>You're out of sync</div>, { duration: Infinity })`;
    expect(balancedCallAt(jsx, jsx.indexOf('('))).toContain('duration: Infinity');

    // Skipping strings still has to win where it matters: a `)` inside a
    // string literal must not close the call early.
    const str = `toast('done (mostly)', { duration: Infinity })`;
    expect(balancedCallAt(str, str.indexOf('('))).toBe(str.slice(str.indexOf('(')));
  });

  it('gives every role="switch" an aria-checked state', () => {
    const offenders = [];
    for (const file of trackedJsxFiles()) {
      const src = rawSourceOf(file);
      for (const { tag, index } of forEachOpeningTag(src, 'button')) {
        if (!/role="switch"/.test(tag)) continue;
        if (/aria-checked/.test(tag)) continue;
        offenders.push(`${file}:${lineOf(src, index)}`);
      }
    }
    expect(offenders, `role="switch" without aria-checked:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('gives every icon-only button an accessible name', () => {
    // A <button> whose entire body is an icon (including one chosen by a
    // ternary, e.g. play/pause, expand/collapse) has no text content for a
    // screen reader to announce. `title` alone doesn't fill that gap — it's
    // mouse-hover-only (no touch discoverability, and this app is opened from
    // other devices over the tailnet) and browser/AT support for `title` as
    // the accessible name is inconsistent. aria-label (or aria-labelledby) is
    // required; media/MediaCard.jsx's Annotate button (title + a paired
    // aria-label) is the existing convention.
    const offenders = [];
    for (const file of trackedJsxFiles()) {
      const src = rawSourceOf(file);
      for (const node of forEachOpeningTag(src, 'button')) {
        if (!isUnnamedIconOnlyButton(src, node)) continue;
        offenders.push(`${file}:${lineOf(src, node.index)}`);
      }
    }
    expect(offenders, `Icon-only <button> with no aria-label/aria-labelledby — title alone isn't touch-discoverable and isn't reliably read as the accessible name; see media/MediaCard.jsx's Annotate button for the convention:\n${offenders.join('\n')}`).toEqual([]);
  });

  // Every rule below asks the same question of every tracked file and differs
  // only in which tag it asks about and which direction it compares the answer
  // against the allowlist, so they share one scan per tag. Two copies would each
  // re-lex ~11MB of source, and — worse — could drift on what "unnamed" means,
  // which would quietly turn the burn-down checks vacuously green.
  const unnamedAnchorsByTag = new Map();
  const unnamedControlAnchors = (tagName) => {
    const cached = unnamedAnchorsByTag.get(tagName);
    if (cached) return cached;
    const anchors = new Set();
    for (const file of trackedJsxFiles()) {
      const scanSrc = maskedSourceOf(file);
      for (const node of forEachOpeningTag(scanSrc, tagName)) {
        if (hasAccessibleControlName(scanSrc, node.tag, node.index, tagName, file)) continue;
        anchors.add(controlSourceAnchor(file, scanSrc, node, tagName));
      }
    }
    unnamedAnchorsByTag.set(tagName, anchors);
    return anchors;
  };

  // One rule per tag rather than one merged rule, so a failure names the tag
  // and each backlog burns down on its own schedule. `<select>` and `<textarea>`
  // share an allowlist because they were seeded together by the same widening.
  const CONTROL_NAME_RULES = [
    { tag: 'input', listName: 'PREEXISTING_INPUT_NAME_ALLOWLIST', allowlist: PREEXISTING_INPUT_NAME_ALLOWLIST, issue: '#4297' },
    { tag: 'select', listName: 'PREEXISTING_SELECT_TEXTAREA_NAME_ALLOWLIST', allowlist: PREEXISTING_SELECT_TEXTAREA_NAME_ALLOWLIST, issue: '#4309' },
    { tag: 'textarea', listName: 'PREEXISTING_SELECT_TEXTAREA_NAME_ALLOWLIST', allowlist: PREEXISTING_SELECT_TEXTAREA_NAME_ALLOWLIST, issue: '#4309' },
  ];

  for (const { tag, listName, allowlist, issue } of CONTROL_NAME_RULES) {
    it(`gives every <${tag}> an accessible name`, () => {
      // A control with no name is announced as bare "edit text" / "combo box".
      // Prefer a paired `<label htmlFor>`; aria-label is for the compact rows
      // (peer management, inline filters) where a visible label breaks layout.
      const offenders = [...unnamedControlAnchors(tag)].filter((anchor) => !allowlist.has(anchor));
      expect(offenders, `<${tag}> without an accessible name — add aria-label/aria-labelledby or an explicit/implicit <label>${tag === 'input' ? ', or exclude type="hidden"' : ''}:\n${offenders.join('\n')}`).toEqual([]);
    });

    it(`keeps no stale <${tag}> entries in ${listName} (${issue})`, () => {
      // The allowlists only shrink. An entry whose control has since been named —
      // or deleted, or renamed so its anchor no longer resolves — is dead weight
      // that quietly re-exempts the next control to land on that same anchor.
      // Fail on it so the burn-down stays honest instead of drifting. A shared
      // allowlist is filtered to this tag's own rows (field 2 of the anchor) so
      // the <select> pass can't call a live <textarea> row stale.
      const unnamed = unnamedControlAnchors(tag);
      const stale = [...allowlist].filter((entry) => entry.split('|')[1] === tag && !unnamed.has(entry));
      expect(stale, `${listName} entries that no longer match an unnamed <${tag}> — delete them:\n${stale.join('\n')}`).toEqual([]);
    });
  }

  // Fixture sources are scanned as if they lived here, so a relative
  // `../ui/FormField` resolves against the real components/ui/FormField.jsx the
  // way a call site's would. Only the directory matters — the file itself need
  // not exist.
  const FIXTURE_HOST = 'src/components/settings/FixtureHost.jsx';
  const isNamed = (src, tagName = 'input', file = FIXTURE_HOST) => {
    const index = src.indexOf(`<${tagName}`);
    return hasAccessibleControlName(src, openingTagAt(src, index), index, tagName, file);
  };
  // The id-keyed half of the same question: is a control carrying this `id`
  // named by one of the wrappers the source renders? These fixtures declare
  // their wrapper inline, so no host path is needed.
  const namesId = (src, id) => isNamedByWrapper(src, { id });

  it('reads a name for <select>/<textarea> from every escape hatch, and from nothing else', () => {
    // The rules above are only honest if the recognizer really rejects a bare
    // control. Probe each direction on the two tags #4309 added: without this
    // the whole widening could be vacuous (every control "named", allowlist
    // never shrinking because nothing was ever unnamed).
    expect(isNamed('<select value={sort}><option>a</option></select>', 'select')).toBe(false);
    expect(isNamed('<textarea value={notes} rows={3} />', 'textarea')).toBe(false);

    expect(isNamed('<select aria-label="Sort by" value={sort} />', 'select')).toBe(true);
    expect(isNamed('<select aria-label={false} value={sort} />', 'select')).toBe(false);
    expect(isNamed('<select aria-label={true} value={sort} />', 'select')).toBe(false);
    expect(isNamed('<label htmlFor="sort">Sort by</label>\n<select id="sort" />', 'select')).toBe(true);
    expect(isNamed('<label>Sort by<select value={sort} /></label>', 'select')).toBe(true);
    expect(isNamed('<span id="notes-h">Notes</span>\n<textarea aria-labelledby="notes-h" />', 'textarea')).toBe(true);
    expect(isNamed("import FormField from '../ui/FormField';\n<FormField label=\"Notes\"><textarea value={notes} /></FormField>", 'textarea')).toBe(true);
    expect(isNamed('function Field({ label, children }) {\n  return (<label className="block"><span>{label}</span>{children}</label>);\n}\n<Field label="Sort by"><select value={sort} /></Field>', 'select')).toBe(true);

    // `type` names an <input> and nothing else. A `type` attribute on the other
    // two tags is meaningless markup, and reading it as a name would exempt
    // them wholesale — the widest bypass this change could have introduced.
    expect(isNamed('<input type="hidden" value={token} />', 'input')).toBe(true);
    expect(isNamed('<select type="hidden" value={sort} />', 'select')).toBe(false);
    expect(isNamed('<textarea type="submit" value="Send" />', 'textarea')).toBe(false);
  });

  it('masks JSX examples written in comments after an expression-rendered list', () => {
    // maskComments exists so a `<select>` mentioned in prose isn't scanned as
    // markup. One shape stranded it: an element rendered from inside an
    // expression (`{options.map(…)}`), whose own `{o.label}` closed the
    // enclosing expression's braces. The following `</select>` then read as a
    // less-than and never popped, so the file finished one element deep — and
    // in `jsx-text` mode `//` no longer starts a comment, which made every
    // later prose mention of a control scan as real markup. PipelineSeries.jsx
    // is the live instance: a comment describing its labeled <select> showed up
    // as an unnamed control 500 lines below the expression that broke the lexer.
    const listThenProse = `function Picker({ options }) {
  return (
    <div>
      <select value={value} onChange={onChange}>
        {options.map((o) => <option key={o.id}>{o.label}</option>)}
      </select>
    </div>
  );
}

// A blank-first labeled <select> lives in SgSelect — prose, not markup.
`;
    const masked = maskComments(listThenProse);
    expect(masked).toContain('<select value={value}');
    expect(masked.split('\n').at(-2)).not.toContain('<select>');
  });

  it('only credits an htmlFor-forwarding wrapper that really names the control', () => {
    // The rule above now accepts a page-local wrapper that renders the <label>
    // and takes the control's id as a prop. That is only a real name when the
    // wrapper does BOTH halves of the job, so probe the bypasses: a wrapper
    // that forwards the id onto a <label> holding no text names nothing, and a
    // call site that omits `label=` supplies no text either. Without these, the
    // recognizer degenerates into "any component with an htmlFor prop exempts
    // its input" — which would silently hide the exact gap the rule scans for.
    const forwarder = `function Group({ label, htmlFor, children }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block">{label}</label>
      {children}
    </div>
  );
}`;
    const emptyForwarder = forwarder.replace('{label}', '');
    const namedCall = `<Group label="Sleep" htmlFor="sleep-hours"><input id="sleep-hours" type="range" /></Group>`;
    const unnamedCall = `<Group htmlFor="sleep-hours"><input id="sleep-hours" type="range" /></Group>`;

    expect(namesId(`${forwarder}\n${namedCall}`, 'sleep-hours')).toBe(true);
    expect(namesId(`${forwarder}\n${unnamedCall}`, 'sleep-hours')).toBe(false);
    expect(namesId(`${emptyForwarder}\n${namedCall}`, 'sleep-hours')).toBe(false);
    // A different id on the same wrapper must not be swept up either.
    expect(namesId(`${forwarder}\n${namedCall}`, 'other-id')).toBe(false);
    // `label` with no value is `label={true}`, which renders no text.
    expect(namesId(`${forwarder}\n${namedCall.replace('label="Sleep"', 'label={true}')}`, 'sleep-hours')).toBe(false);
    // The scan masks comments before any of this runs, so a commented-out
    // wrapper must not register as one. Probe the source the way the scan
    // hands it over, or this helper looks safe for the wrong reason.
    const commentedForwarder = `function Group({ label, htmlFor, children }) {
  // <label htmlFor={htmlFor}>{label}</label>
  return <div>{children}</div>;
}`;
    expect(namesId(maskComments(`${commentedForwarder}\n${namedCall}`), 'sleep-hours')).toBe(false);

    // The forwarded prop does not have to be called `htmlFor` — StackerNews's
    // `Field({ id, label })` does the same job through `id`. Both halves stay
    // required, and the id must still be read from the prop the wrapper
    // actually forwards, not from any attribute that happens to be present.
    const idPropForwarder = forwarder.replace('label, htmlFor, children', 'id, label, children').replace('htmlFor={htmlFor}', 'htmlFor={id}');
    const idPropCall = `<Group id="sleep-hours" label="Sleep"><input id="sleep-hours" type="range" /></Group>`;
    expect(namesId(`${idPropForwarder}\n${idPropCall}`, 'sleep-hours')).toBe(true);
    expect(namesId(`${idPropForwarder}\n${idPropCall.replace(' label="Sleep"', '')}`, 'sleep-hours')).toBe(false);
    // `htmlFor=` on the call site is not the forwarded prop here, so it must
    // not stand in for the `id` this wrapper reads.
    expect(namesId(`${idPropForwarder}\n${idPropCall.replace('id="sleep-hours" label', 'htmlFor="sleep-hours" label')}`, 'sleep-hours')).toBe(false);

    // A forwarder can take its text as JSX children instead of a prop
    // (UniverseBibleTab's `<FieldLabel htmlFor="world-logline">Logline`). There
    // is no `children=` attribute to read at the call site, so the name has to
    // come from the element's own body — and an empty body still names nothing.
    const childrenForwarder = `function FieldLabel({ htmlFor, children }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="text-xs">{children}</label>
    </div>
  );
}`;
    const childrenCall = '<FieldLabel htmlFor="sleep-hours">Sleep</FieldLabel>\n<input id="sleep-hours" type="range" />';
    expect(namesId(`${childrenForwarder}\n${childrenCall}`, 'sleep-hours')).toBe(true);
    expect(namesId(`${childrenForwarder}\n${childrenCall.replace('>Sleep<', '><')}`, 'sleep-hours')).toBe(false);
    expect(namesId(`${childrenForwarder}\n${childrenCall}`, 'other-id')).toBe(false);
  });

  it('credits a caller-supplied id only when every call site names it', () => {
    // The mirror of the wrapper probes above: here the reusable component IS
    // the control, and the <label> lives in the caller's file. The exemption is
    // only real when every call site does its half, so probe both bypasses — a
    // caller that passes the id and no label, and one that omits the id — plus
    // the "one bad call site spoils it" quantifier. Without these the rule
    // degenerates into "any component with an id prop is exempt", which would
    // hide the exact gap it scans for.
    const control = `export default function Combo({ inputId, value, onChange }) {
  return <input id={inputId} type="text" value={value} onChange={onChange} />;
}`;
    const site = (src, localName = 'Combo') => ({ src, localName, exportedName: 'default' });
    const credits = (...sites) => {
      const index = control.indexOf('<input');
      return hasCallerSuppliedName(control, openingTagAt(control, index), index, sites);
    };

    const labeled = '<label htmlFor="rounds">Rounds</label>\n<Combo inputId="rounds" value={v} />';
    const noLabel = '<Combo inputId="rounds" value={v} />';
    const noId = '<label htmlFor="rounds">Rounds</label>\n<Combo value={v} />';

    expect(credits(site(labeled))).toBe(true);
    expect(credits(site(noLabel))).toBe(false);
    expect(credits(site(noId))).toBe(false);
    // A label whose htmlFor points somewhere else names a different control.
    expect(credits(site(labeled.replace('htmlFor="rounds"', 'htmlFor="other"')))).toBe(false);
    // …and a <label> carrying no text names nothing, here as everywhere.
    expect(credits(site(labeled.replace('>Rounds<', '><')))).toBe(false);

    // Every call site, not any: the unlabeled screen is still unlabeled.
    expect(credits(site(labeled), site(noLabel))).toBe(false);
    expect(credits(site(labeled), site(labeled.replace(/rounds/g, 'laps')))).toBe(true);

    // A renamed default import is the same component, and must be read under
    // the local binding the caller actually renders.
    expect(credits(site(labeled.replace(/Combo/g, 'Wrapped'), 'Wrapped'))).toBe(true);
    // A site importing a DIFFERENT export of the same file proves nothing about
    // this component, so it is neither credited nor counted against it.
    expect(credits({ ...site(labeled), exportedName: 'Other' })).toBe(false);
    // No call site at all is not proof of a name — an unrendered control cannot
    // borrow one from a caller that does not exist.
    expect(credits()).toBe(false);

    // An UNREADABLE call site is a `false`, not a skipped one. This is the
    // reason the shared walk yields unterminated tags instead of deciding for
    // its callers (#4341): every other walk wants "which tags are there" and
    // drops it, this one asks "did every call site do its half" and cannot.
    const unterminated = '<label htmlFor="rounds">Rounds</label>\n<Combo inputId="rounds"';
    expect(credits(site(unterminated))).toBe(false);
    expect(credits(site(labeled), site(unterminated))).toBe(false);

    // The id has to be CALLER-supplied. A locally generated one is not the
    // caller's to name — `<Combo inputId="rounds">` would then exempt an input
    // whose id the caller never saw — so a non-parameter id is not this shape.
    const localId = `export default function Combo({ value, onChange }) {
  const inputId = useId();
  return <input id={inputId} type="text" value={value} onChange={onChange} />;
}`;
    const localIndex = localId.indexOf('<input');
    expect(hasCallerSuppliedName(localId, openingTagAt(localId, localIndex), localIndex, [site(labeled)])).toBe(false);

    // …and the id has to be the control's OWN. A same-named prop on another
    // attribute (`data-id={inputId}`) never reaches the a11y tree.
    const dataId = control.replace('id={inputId}', 'data-id={inputId}');
    const dataIndex = dataId.indexOf('<input');
    expect(hasCallerSuppliedName(dataId, openingTagAt(dataId, dataIndex), dataIndex, [site(labeled)])).toBe(false);
  });

  it('credits a FormField whose only child is a conditional, but not a list', () => {
    // A FormField's child is frequently a ternary rather than the control
    // itself (`{isSelect ? <select/> : <input/>}`); React clones the generated
    // id onto whichever branch renders, so the control really is named. The
    // veto that matters is a rendered LIST — Children.map flattens it and
    // clones only the first element, so crediting each control in a `.map()`
    // would exempt every one after the first.
    // The wrapper is credited only once its own source has been read, so every
    // fixture carries the import a real call site would.
    const field = (child) => `import FormField from '../ui/FormField';\n<FormField label="Rounds">\n  ${child}\n</FormField>`;
    const credits = (src, tagName = 'input') => isNamed(src, tagName);

    const ternary = field(`{isSelect ? (<select><option>a</option></select>) : (<input type="number" />)}`);
    expect(credits(ternary)).toBe(true);

    // A `.map()` in the OTHER branch has already closed by the time the control
    // is reached, so it must not disqualify the shape.
    const ternaryWithListedOptions = field(`{isSelect ? (<select>{opts.map((o) => (<option key={o}>{o}</option>))}</select>) : (<input type="number" />)}`);
    expect(credits(ternaryWithListedOptions)).toBe(true);

    const list = field(`{fields.map((f) => (<input key={f} type="number" />))}`);
    expect(credits(list)).toBe(false);

    // A sibling that happens to BE an <input> must not stand in for the
    // "control is the first child" marker — the second control is not cloned,
    // so a <select> after an <input> is still unnamed.
    const afterInput = field('<input type="text" />\n  <select><option>a</option></select>');
    expect(credits(afterInput, 'select')).toBe(false);

    // Only the element the expression yields directly is cloned; a control
    // nested inside a wrapper element gets no id.
    const wrapped = field(`{isSelect ? (<select />) : (<div><input type="number" /></div>)}`);
    expect(credits(wrapped)).toBe(false);

    // An unlabeled FormField names nothing, whatever its child looks like.
    const unlabeled = ternary.replace(' label="Rounds"', '');
    expect(credits(unlabeled)).toBe(false);

    // The registry never trusts a component by name — a same-named wrapper
    // imported from somewhere else is a different component, and crediting it
    // on the strength of the identifier `FormField` would be the widest
    // exemption the guard grants. Here the specifier resolves to nothing, so
    // there is no source to read and no shape to credit.
    const foreign = ternary.replace("from '../ui/FormField'", "from './LocalFormField'");
    expect(credits(foreign)).toBe(false);
    // Same for a locally-declared `FormField` that is not a cloning wrapper.
    const shadowed = `function FormField({ label, children }) {\n  return <div>{label}{children}</div>;\n}\n${ternary.replace(/^import[^\n]*\n/, '')}`;
    expect(credits(shadowed)).toBe(false);
  });

  it('shares one open-wrapper scanner between the implicit and cloned matchers (#4328)', () => {
    // Both ancestor-based shapes ask `openWrapperInstancesAt` the same question,
    // so both DIRECTIONS of it need pinning — and through BOTH matchers, or the
    // fold that stopped the two from drifting is witnessed on one path only.
    const implicitWrapper = 'const Field = ({ label, children }) => (\n  <label className="block"><span>{label}</span>{children}</label>\n);\n';
    const clonedWrapper = "import FormField from '../ui/FormField';\n";

    // A wrapper that has already CLOSED names nothing after it. The control has
    // to be the first thing following the close: with a preceding sibling the
    // cloned path would reject it via the first-direct-child walk instead, for
    // a reason that has nothing to do with openness.
    const afterClose = (wrapper, name) => `${wrapper}<${name} label="Rounds"></${name}>\n<select><option>a</option></select>`;
    expect(isNamed(afterClose(implicitWrapper, 'Field'), 'select')).toBe(false);
    expect(isNamed(afterClose(clonedWrapper, 'FormField'), 'select')).toBe(false);

    // An inner labeled wrapper nested in an unlabeled outer one still names its
    // own first child — the reason the scanner keeps EVERY open instance rather
    // than just the outermost.
    const nested = (wrapper, name) => `${wrapper}<${name}>\n  <${name} label="Rounds">\n    <select><option>a</option></select>\n  </${name}>\n</${name}>`;
    expect(isNamed(nested(implicitWrapper, 'Field'), 'select')).toBe(true);
    expect(isNamed(nested(clonedWrapper, 'FormField'), 'select')).toBe(true);
  });

  it('never reads markup out of an attribute value (#4337)', () => {
    // Each scanner used to re-derive a `re.lastIndex = contentStart` advance to
    // keep its walk out of the tag it had just read — and one of them
    // (`hasMatchingLabelElement`) never had it, so it matched markup written in
    // an attribute VALUE as an element. That is a false POSITIVE in a guard: a
    // control with no label of its own is credited by label-shaped prose
    // belonging to some other element, and drops off the offender list
    // silently. #4341 retired the advance along with the regex walk — an
    // attribute value is a string token now, so no walk can enter one at all —
    // but the verdicts it protected are the same, and still pinned here.
    expect(isNamed('<label htmlFor="other" title=\'<label htmlFor="x">Rounds</label>\'>Other</label>\n<input id="x" type="text" />')).toBe(false);
    // The walk resumes at the opening tag's END, not past the whole ELEMENT, so
    // a real label nested in that tag's body is still found. Nesting it is what
    // makes this discriminate: a label written after `</label>` would be found
    // under either policy, so it would prove nothing.
    expect(isNamed('<label htmlFor="other" title=\'<label>\'>Other <label htmlFor="x">Rounds</label></label>\n<input id="x" type="text" />')).toBe(true);
  });

  it('credits a name written inside an attribute expression (#4341)', () => {
    // The boundary #4337 documented, now crossed. The regex walk's
    // `re.lastIndex = contentStart` advance stepped over a whole opening tag, so
    // an element written inside an attribute EXPRESSION was never visited and
    // `notes-h` never resolved. The scanner enters that expression the same way
    // React does, so the <span> really does render and really does name the
    // textarea.
    expect(isNamed('<Foo render={<span id="notes-h">Notes</span>} />\n<textarea aria-labelledby="notes-h" />', 'textarea')).toBe(true);
    // The same id written as a real sibling element resolves too — the walk
    // gained a shape rather than trading one for another.
    expect(isNamed('<span id="notes-h">Notes</span>\n<textarea aria-labelledby="notes-h" />', 'textarea')).toBe(true);
    // What the advance actually existed to stop is still stopped, and by
    // construction now: markup in a quoted attribute VALUE is a string to the
    // scanner, so it names nothing.
    expect(isNamed('<Foo render=\'<span id="notes-h">Notes</span>\' />\n<textarea aria-labelledby="notes-h" />', 'textarea')).toBe(false);
    // An id that resolves to an element carrying no text still names nothing,
    // wherever it is written — the descent widened which elements are seen, not
    // what counts as a name. An EMPTY expression body is one of those: it
    // renders nothing, and reading it as text credited a control with no name.
    expect(isNamed('<Foo render={<span id="notes-h" />} />\n<textarea aria-labelledby="notes-h" />', 'textarea')).toBe(false);
    expect(isNamed('<span id="notes-h">{}</span>\n<textarea aria-labelledby="notes-h" />', 'textarea')).toBe(false);
    expect(isNamed('<span id="notes-h">{/* todo */}</span>\n<textarea aria-labelledby="notes-h" />', 'textarea')).toBe(false);
    // `{true}` renders nothing either — the sibling check on `label` props has
    // said so since it was written, and this one had drifted off it.
    expect(isNamed('<span id="notes-h">{true}</span>\n<textarea aria-labelledby="notes-h" />', 'textarea')).toBe(false);
    // A non-empty expression is still text, or the fix would have swung past it.
    expect(isNamed('<span id="notes-h">{heading}</span>\n<textarea aria-labelledby="notes-h" />', 'textarea')).toBe(true);

    // Descending into an expression must not make a wrapper opened INSIDE one
    // an ancestor of anything outside it: the nested `<Field label>` opens and
    // closes within `title={…}`, so the input is still nested only in the
    // UNLABELED outer wrapper and stays on the offender list.
    const field = 'function Field({ label, children }) {\n  return <label>{label}{children}</label>;\n}';
    expect(isNamed(`${field}\n<Field>\n<Header title={<Field label="Helper"><span>T</span></Field>} />\n<input id="x" type="text" />\n</Field>`)).toBe(false);
    // …and the labeled outer wrapper does name it, so the assertion above is
    // about where the label sits, not about the shape failing to parse.
    expect(isNamed(`${field}\n<Field label="Helper">\n<input id="x" type="text" />\n</Field>`)).toBe(true);
  });

  it('does not read a tag out of a comment (#4341)', () => {
    // The regex walk matched `<label` anywhere, comment text included, so a
    // commented-out label named a live control — a false NEGATIVE, the
    // direction that actually ships a bug. Masking hid it from the control scan
    // but not from the rules that read raw source. The scanner hands a comment
    // back as one span, so no walk can see into it, whether or not the caller
    // masked first.
    expect(isNamed('/* <label htmlFor="u">Commented</label> */\n<input id="u" type="text" />')).toBe(false);
    expect(isNamed('// <label htmlFor="u">Commented</label>\n<input id="u" type="text" />')).toBe(false);
    // The same label written as real markup names it, so this is about the
    // comment and not about the label going unread.
    expect(isNamed('<label htmlFor="u">Live</label>\n<input id="u" type="text" />')).toBe(true);
  });

  it('reads self-closing from the scanner, not off the end of the tag (#4341)', () => {
    // `tagEndAt` used to throw away `tagBoundaryAt`'s `selfClosing`, so four
    // callers re-derived it from the tag TEXT — and on UNMASKED source, which
    // two rules scan, a comment survives to the last two characters. Both
    // re-derivations then read a tag that has a body as self-closing and skip
    // it, which is a control dropping silently off the offender list.
    const commented = '<button /* pause */>{on ? <IconA /> : <IconB />}</button>';
    const [button] = [...forEachOpeningTag(commented, 'button')];
    expect(button.tag.endsWith('/>')).toBe(true); // what the rule used to ask
    expect(button.selfClosing).toBe(false); // what the scanner knows
    expect(isUnnamedIconOnlyButton(commented, button)).toBe(true);
    // The same shape through `hasUsableElementText`, whose re-derivation was the
    // `/\/\s*>$/` spelling: a commented <label> stops naming its input.
    expect(isNamed('<label htmlFor="rounds" /* which */ >Rounds</label>\n<input id="rounds" type="text" />')).toBe(true);

    // A genuinely self-closing tag still reads as one, or the fix would just
    // have moved the failure to the other direction.
    const [selfClosed] = [...forEachOpeningTag('<button />', 'button')];
    expect(selfClosed.selfClosing).toBe(true);
    expect(isUnnamedIconOnlyButton('<button />', selfClosed)).toBe(false);
    expect(isNamed('<label htmlFor="rounds" />\n<input id="rounds" type="text" />')).toBe(false);
  });

  it('derives every remaining lexical fact from the shared tag index (#4343)', () => {
    // A raw `/>` suffix is not proof of a self-closing JSX node: this is an
    // opening component tag whose comment happens to end in `/>`. The icon
    // rule must leave that malformed-but-readable shape out of its match.
    expect(isIconOnlyBody('{on ? <IconA /* note */> : <IconB />}')).toBe(false);
    expect(isIconOnlyBody('{on && <IconA /* note */>}')).toBe(false);

    // `$` is part of the tag spelling everywhere else. Ternary, &&, and a
    // presentational host wrapper must agree instead of each carrying a
    // narrower ad-hoc class.
    expect(isIconOnlyBody('{on ? <Ic$n /> : <IconB />}')).toBe(true);
    expect(isIconOnlyBody('{on && <Ic$n />}')).toBe(true);
    expect(isIconOnlyBody('<spa$n><IconA /></spa$n>')).toBe(true);

    // A nested hidden subtree must remain hidden through its ACTUAL matching
    // close, not only through the first same-named closer a non-greedy regex
    // reaches. A quoted `>` likewise stays inside its opening tag and cannot
    // leak an attribute quote back as rendered label text.
    expect(isNamed('<label htmlFor="x"><span aria-hidden="true"><span>Hidden</span>still hidden</span></label>\n<input id="x" />')).toBe(false);
    expect(isNamed('<label htmlFor="x"><span title=">"></span></label>\n<input id="x" />')).toBe(false);
    expect(isNamed('<label htmlFor="x"><span title=">">Rounds</span></label>\n<input id="x" />')).toBe(true);
    expect(isNamed('<span id="x" aria-hidden={true}>Hidden</span>\n<input aria-labelledby="x" />')).toBe(false);

    // These helpers receive an element BODY, so their first character is JSX
    // text rather than JavaScript. An apostrophe there must not open a fake
    // string and hide the structural tags that follow it.
    const apostropheThenHidden = "don't <span aria-hidden=\"true\">Hidden</span>";
    const hiddenStripped = stripHiddenElementContent(apostropheThenHidden);
    expect(hiddenStripped).not.toContain('Hidden');
    expect(hiddenStripped).not.toContain('<span');
    const tagsStripped = stripJsxTags("don't <span>Visible</span>");
    expect(tagsStripped).toContain("don't");
    expect(tagsStripped).toContain('Visible');
    expect(tagsStripped).not.toContain('<span');
    expect(tagsStripped).not.toContain('</span>');

    // Closing the only tag must also return to the slice's JSX-text context.
    // Otherwise the later apostrophe opens a fake JavaScript string and hides
    // the second tag from both the tag stripper and hidden-content pass.
    const apostropheAfterTag = "Before <span>Visible</span> don't <span>Later</span>";
    const afterCloseTagsStripped = stripJsxTags(apostropheAfterTag);
    expect(afterCloseTagsStripped).not.toContain('<span');
    expect(afterCloseTagsStripped).not.toContain('</span>');
    const visibleThenHidden = "Before <span>Visible</span> don't <span aria-hidden=\"true\">Hidden later</span>";
    expect(stripHiddenElementContent(visibleThenHidden)).not.toContain('Hidden later');

    // An expression can contain a string that looks like a tag. It is still
    // one direct child of FormField, so the clone reaches the real input; only
    // the scanner can distinguish that string from a nested JSX ancestor.
    const field = (child) => `import FormField from '../ui/FormField';\n<FormField label="Rounds">${child}</FormField>`;
    expect(isNamed(field('{enabled && "<div>" && <input type="number" />}'))).toBe(true);
    // A Fragment, by contrast, is its own React child. Cloning the Fragment's
    // id does not forward it to the input inside.
    expect(isNamed(field('<><input type="number" /></>'))).toBe(false);
  });

  it('sees a component whose name holds a `$` (#4341)', () => {
    // `relativeImportBindings` admitted `$` and `forEachLocalComponent` did not,
    // so a `Fi$ld` wrapper was invisible from both directions at once and no
    // fixture could witness the disagreement. Now every detector — and the walk,
    // which matches names literally instead of splicing them into a pattern
    // where `$` is an anchor — spells an identifier the same way.
    const wrapper = 'function Fi$ld({ label, children }) {\n  return (<label className="block"><span>{label}</span>{children}</label>);\n}';
    expect(isNamed(`${wrapper}\n<Fi$ld label="Rounds"><select value={v} /></Fi$ld>`, 'select')).toBe(true);
    // …and it is the wrapper's LABEL doing the naming, not its name being seen.
    expect(isNamed(`${wrapper}\n<Fi$ld><select value={v} /></Fi$ld>`, 'select')).toBe(false);
  });

  it('starts a tag after a statement brace, but not after a value (#4341)', () => {
    // Since the walks became scanner-driven, `looksLikeJsxTagStart` is the only
    // thing standing between a wrapper and the registry — the regex walk found
    // the tag either way — so both directions of it need pinning.
    const wrapper = 'function Field({ label, children }) {\n  return (<label>{label}{children}</label>);\n}';
    expect(isNamed(`${wrapper}\n<Field label="Rounds"><select value={v} /></Field>`, 'select')).toBe(true);
    // A `<` after a VALUE is a comparison. Reading it as a tag would open a
    // phantom element that swallows source up to the next `>`, taking every
    // real tag in between out of the scan with it.
    expect([...forEachTag('const ok = size() <limit;')].map((node) => node.name)).toEqual([]);
    // The `}` widening's own risky direction — an object literal rather than a
    // statement — is bounded by the text predicate underneath it: a `<` only
    // opens a tag when a name, `/`, or `>` follows it immediately, and the
    // comparison this could be confused with is written with a space.
    expect([...forEachTag('const m = { a: 1 } < limit;')].map((node) => node.name)).toEqual([]);
  });

  it('builds one tag index per source and shares it between interleaved walks (#4341)', () => {
    // The regex walk had to construct a fresh `/g` regex per call: these walks
    // genuinely interleave — the control scan is mid-walk when it asks
    // `hasMatchingLabelElement` about the same `'label'` — and a shared
    // `lastIndex` would leave the outer walk wherever the inner one finished.
    // An index is immutable, so re-entrancy costs nothing and the file is lexed
    // once instead of once per walk.
    const src = '<label htmlFor="a">A</label>\n<label htmlFor="b">B</label>';
    expect(tagIndexOf(src)).toBe(tagIndexOf(src));
    const outer = [];
    for (const node of forEachOpeningTag(src, 'label')) {
      outer.push(node.index);
      expect([...forEachOpeningTag(src, 'label')]).toHaveLength(2);
    }
    expect(outer).toHaveLength(2);
  });

  it('reads a quoted attribute as a string, not as tag structure (#4333)', () => {
    // Between a tag name and its `>` there is only attribute-value or
    // expression context, so a quote there always opens a string. Prose in an
    // attribute used to break `openingTagAt` two ways — both FALSE NEGATIVES,
    // which is why the suite stayed green with them present.
    // 1. A `>` ended the tag early, losing every attribute after it.
    expect(isNamed('<input type="text" placeholder="a > b" aria-label="Search" />')).toBe(true);
    // 2. A lone brace drove the depth negative and returned null. All 18 call
    //    sites read null as `continue`, so the <label> left the scan entirely
    //    and the input it names read as unnamed.
    expect(isNamed('<label htmlFor="a" title="use { to open">Rounds</label>\n<input id="a" type="text" />')).toBe(true);
    //    Same when the unbalanced brace is on the CONTROL's own tag.
    expect(isNamed('<input id="b" title="a } brace" aria-label="Search" />')).toBe(true);
    // The fix must not credit a control that still has no name: `placeholder`
    // is an anchor attribute, never an accessible name.
    expect(isNamed('<input type="text" placeholder="a > b" />')).toBe(false);

    // Inside `{…}` the context is no longer "tag", so the quote skip must NOT
    // apply there: `render={<span>don't</span>}` puts JSX text mid-tag, where an
    // apostrophe is an ordinary character. Reading it as a string opener runs
    // off the end of the file and returns null — the same class of bug, one
    // shape rarer. The expression is handed to `matchingBraceEnd` instead.
    const attrExpressions = [
      "<Foo render={<span>don't</span>} />",
      "<Foo x={/* don't */ 1} />",
      '<Foo c={`a > b`} />', // the case the original brace counting existed for
    ];
    for (const shape of attrExpressions) expect(openingTagAt(shape, 0)).toBe(shape);

    // `tagBoundaryAt` answers the same question for the icon rules and skipped
    // strings only at depth > 0, so a `>` in a top-level attribute value ended
    // the tag at the wrong character AND reported `selfClosing: false` — which
    // is how a self-closing icon stops looking self-closing.
    const iconTag = '<Icon title="a > b" />';
    expect(tagBoundaryAt(iconTag, 0)).toEqual({ end: iconTag.length, selfClosing: true });
  });

  it('hands a comment back to the context that opened it (#4333)', () => {
    // A comment can open from JavaScript or from inside a TAG. `maskComments`
    // reset to 'code' on exit either way, which dropped the lexer out of the
    // half-read tag: the tag's `>` no longer closed it, the element never
    // reached 'jsx-text', and the visible text after it was lexed as JavaScript
    // — so a `//` in ordinary label text got masked away. That is the #4318
    // failure again, reached through the comment states instead.
    for (const opener of ['// note\n', '/* note */']) {
      const src = `<Foo ${opener} bar="x">see // docs</Foo>`;
      expect(maskComments(src).endsWith('>see // docs</Foo>')).toBe(true);
    }
    // A comment opened from JavaScript still hands back to JavaScript.
    expect(maskComments('const a = 1; // note\nconst b = 2;')).toBe('const a = 1;        \nconst b = 2;');
  });

  it('reads a ternary operator through quoted attributes and strings (#4333)', () => {
    // An icon-only button whose ternary carries a `?` or `:` inside a string
    // used to read as "not a ternary" and drop out of the rule that requires it
    // to have a name — a false negative in a guard.
    const isIconOnly = (body) => {
      const src = `<button onClick={run}>${body}</button>`;
      const open = src.indexOf('<button');
      const tag = openingTagAt(src, open);
      return isIconOnlyBody(findButtonBody(src, open + tag.length));
    };
    expect(isIconOnly("{mode === 'a?b' ? <IconA /> : <IconB />}")).toBe(true);
    expect(isIconOnly('{cond ? <IconA title="a:b" /> : <IconB />}')).toBe(true);
    // Optional chaining is still not a ternary, and a non-icon branch still
    // disqualifies the shape — the string skip must not widen either.
    expect(isIconOnly('{cond ? <IconA /> : "Save"}')).toBe(false);
    expect(isIconOnly('{icons?.primary}')).toBe(false);
  });

  it('masks an element body as JSX text, not as code (#4333)', () => {
    // `hasUsableElementText` hands `maskComments` a mid-file slice that is an
    // element BODY. Started in 'code' the machine opened a fake line comment on
    // the first `//` of visible label text, blanking the rest of the line — so a
    // correctly labeled input was reported UNNAMED.
    expect(maskComments('Discount 50 // 50', { startMode: 'jsx-text' })).toBe('Discount 50 // 50');
    expect(maskComments('Discount 50 // 50')).toBe('Discount 50      ');
    expect(isNamed('<label htmlFor="x">// see docs</label>\n<input id="x" type="text" />')).toBe(true);
    // A genuinely empty label still names nothing.
    expect(isNamed('<label htmlFor="y"></label>\n<input id="y" type="text" />')).toBe(false);
  });

  it('reads comments inside a brace expression as comments (#4333)', () => {
    // `matchingBraceEnd` is reached from UNMASKED source, and `soleTopLevelNode`
    // strips only `{/* … */}` — so a `//` or inline `/* */` inside the
    // expression reaches this walk raw. Both cases are silent: no error, just a
    // button that leaves the icon-only rule.
    const isIconOnly = (body) => {
      const src = `<button onClick={run}>${body}</button>`;
      const open = src.indexOf('<button');
      const tag = openingTagAt(src, open);
      return isIconOnlyBody(findButtonBody(src, open + tag.length));
    };
    // A line comment whose text holds an apostrophe used to open a string that
    // never closed, so `matchingBraceEnd` returned -1 and the button vanished
    // from the rule entirely — a live false negative.
    expect(isIconOnly("{ // don't\n  open ? <Up /> : <Down /> }")).toBe(true);
    // A `}` inside a block comment used to be read as the closing brace: wrong
    // bounds with no error. This one is latent — no verdict flips today, since
    // a bare `{<Icon />}` is not an icon-only shape either way — so it is
    // pinned on the helper directly rather than through a rule that would pass
    // for the wrong reason.
    const blockComment = '{ /* } */ <Icon /> }';
    expect(matchingBraceEnd(blockComment, 0)).toBe(blockComment.length - 1);
    // Same inside a TAG, the walk's other JavaScript-ish context: an apostrophe
    // in the comment opened a string that ran to the end of the slice, and a
    // `>` in the comment ended the tag early and left the walk in element text.
    const tagComments = ["{ <Up /* don't */ /> }", '{ <Up /* a > b */ /> }'];
    for (const shape of tagComments) expect(matchingBraceEnd(shape, 0)).toBe(shape.length - 1);
    // Division and regex literals must not be mistaken for comment openers.
    expect(isIconOnly('{ ratio / 2 > 1 ? <Up /> : <Down /> }')).toBe(true);
    expect(isIconOnly('{ /up/.test(dir) ? <Up /> : <Down /> }')).toBe(true);
  });

  it('reads a regex literal as one token, not as JSX or a comment (#4333)', () => {
    // The last context outside the old model. A regex BODY may hold any of
    // `{ } ' " < >` and a character class may hold `/` itself, so every scanner
    // that walked one character by character could be started down a phantom
    // tag, string, or comment by ordinary product source.
    const isIconOnly = (body) => {
      const src = `<button onClick={run}>${body}</button>`;
      const open = src.indexOf('<button');
      return isIconOnlyBody(findButtonBody(src, open + openingTagAt(src, open).length));
    };
    // `<` followed by `>` inside a character class opened a JSX tag: the rest of
    // the expression lexed as element text, so the `?` was no longer a top-level
    // operator and the button left the icon-only rule.
    expect(isIconOnly('{ /[<>]/.test(dir) ? <Up /> : <Down /> }')).toBe(true);
    // An apostrophe in a regex opened a string that never closed.
    expect(isIconOnly("{ /it's/.test(dir) ? <Up /> : <Down /> }")).toBe(true);
    // A `//` inside a character class read as a line comment and blanked the
    // rest of the line — including, here, the label text that follows it.
    expect(maskComments('const re = /[//]/;\n<label htmlFor="x">Rounds</label>'))
      .toBe('const re = /[//]/;\n<label htmlFor="x">Rounds</label>');
    // Guessing has to stay conservative in the other direction: a `/` after a
    // VALUE is division, and a regex may not span a line, so an unmatched `/`
    // was division after all. Neither may swallow the code that follows.
    expect(maskComments('const r = (a) / b; // note\nconst s = c[0] / d;'))
      .toBe('const r = (a) / b;        \nconst s = c[0] / d;');
    expect(maskComments('const r = x = / not a regex\nconst s = 1; // note'))
      .toBe('const r = x = / not a regex\nconst s = 1;        ');
  });

  it('asks what TOKEN precedes a slash, not what character does (#4333)', () => {
    // Whether a `/` opens a regex — and whether a `<` opens a tag — is a
    // question about the preceding TOKEN. Two shapes where that is not the
    // preceding CHARACTER, each putting the literal's own `<>` back into the
    // JavaScript walk, where it opens a tag that never closes and leaves the
    // rest of the expression lexing as element text.
    const isIconOnly = (body) => {
      const src = `<button onClick={run}>${body}</button>`;
      const open = src.indexOf('<button');
      return isIconOnlyBody(findButtonBody(src, open + openingTagAt(src, open).length));
    };
    // 1. An arrow function returning a literal — the most common regex shape in
    //    this tree. The preceding character is the `>` of `=>`, which ends no
    //    value, so `>` has to count as a regex preceder.
    expect(isIconOnly('{ ((d) => /[<>]/.test(d))(x) ? <Up /> : <Down /> }')).toBe(true);
    // 2. A comment between the operator and the literal. A backward walk over
    //    raw source stops at the `/` of the `*/` and calls this division; only
    //    the forward pass knows the comment was not a token.
    expect(isIconOnly('{ /* why */ /[<>]/.test(d) ? <Up /> : <Down /> }')).toBe(true);
    // The same blind spot decided whether a `<` opened a tag, so a comment
    // before an element left the lexer in JavaScript — and the visible text of
    // a correctly labeled control masked away as code.
    const commented = 'const el = /* why */ <label htmlFor="r">see // docs</label>;\n<input id="r" type="text" />';
    expect(maskComments(commented)).toBe(commented.replace('/* why */', '         '));
    expect(isNamed(commented)).toBe(true);
    // And it decides whether a tag closed itself, where the character before the
    // `>` is the `/` of a `*/` — an opening tag that reads as self-closing takes
    // its whole body out of every rule that walks children.
    expect(tagBoundaryAt('<Foo /* note */ >', 0)).toEqual({ end: 17, selfClosing: false });
    expect(tagBoundaryAt('<Foo /* note */ />', 0)).toEqual({ end: 18, selfClosing: true });
  });

  it('bounds a regex literal at the line, and reads the keywords that open one (#4333)', () => {
    // Latent today — no tracked file hits either — so both are pinned on the
    // helper directly rather than through a rule that would pass for the wrong
    // reason. Getting either wrong hands the literal's own characters back to
    // the JavaScript walk, which is what the state exists to prevent.
    //
    // A `\` escapes the next character but never the line bound, so a trailing
    // one is a syntax error, not a continuation. Stepping over it blind let a
    // `/` on a later line close the "literal".
    expect(regexEnd('x = /a\\\n/;', 4, 2)).toBe(-1);
    expect(regexEnd('x = /a\\//;', 4, 2)).toBe(8);
    // `throw` and `default` open a regex exactly as `return` does.
    expect(regexEnd('throw /[<>]/;', 6, 4)).toBe(11);
    expect(regexEnd('export default /[<>]/;', 15, 13)).toBe(20);
    // A `/` after a VALUE is still division, keyword-shaped names included.
    expect(regexEnd('const rethrow = a / b;', 18, 16)).toBe(-1);
  });

  it('keeps the mask in the same index space as the source (#4333)', () => {
    // `jsxScanner` reports STRING indexes, so the mask has to be a UTF-16 split.
    // Against a code-point split (`[...src]`) an astral character collapses to
    // one slot, and from the first emoji onward every blank lands a slot early —
    // here leaving a stray `/` behind and eating the newline's neighbour. 72
    // tracked client files carry an emoji, so this is live, not theoretical.
    expect(maskComments('const icon = \'🚀\'; // note\nconst b = 2;'))
      .toBe('const icon = \'🚀\';        \nconst b = 2;');
    // And the shifted reads take the lexer with them: the `<` of a tag is no
    // longer where the machine looks, so it never enters tag context and the
    // visible text of a correctly labeled control masks away as code.
    const labelled = 'const icon = \'🚀\';\n<label htmlFor="x">see // docs</label>\n<input id="x" type="text" />';
    expect(maskComments(labelled)).toBe(labelled);
    expect(isNamed(labelled)).toBe(true);
  });

  it('reads a call\'s arguments through unbalanced parens in JSX text (#4333)', () => {
    // The toast rule slices `toast(…)` out of raw source. A `(` or `)` in an
    // element's visible text is prose, not structure — `:(` alone left the call
    // unbalanced, so the slice came back null and the rule silently skipped the
    // one shape it exists to catch: JSX content with no `label`.
    const smiley = 'toast(<p>Sync failed :( sorry</p>, { duration: Infinity })';
    expect(balancedCallAt(smiley, smiley.indexOf('('))).toBe(smiley.slice(smiley.indexOf('(')));
    const closer = 'toast(<p>Sync failed :) sorry</p>, { duration: Infinity })';
    expect(balancedCallAt(closer, closer.indexOf('('))).toBe(closer.slice(closer.indexOf('(')));
  });

  it('takes brace nesting from the scanner, not a local counter (#4333)', () => {
    // `topLevelOperatorIn` sees only JavaScript-context characters, and a `{…}`
    // child expression opens in ELEMENT TEXT and closes in JavaScript. A local
    // `{`/`}` counter therefore misses the open and still sees the close, going
    // negative and never matching `depth === 0` again — so nothing after the
    // first rendered expression is ever found. Latent today (no verdict flips),
    // and pinned on the helper for the same reason the block-comment case is.
    const withChildExpression = 'render(<p>{x}</p>) ? <Up /> : <Down />';
    expect(topLevelOperatorIn(withChildExpression, '?', 0)).toBe(withChildExpression.indexOf('?'));
    expect(topLevelOperatorIn(withChildExpression, ':', withChildExpression.indexOf('?') + 1))
      .toBe(withChildExpression.indexOf(':'));
  });

  it('reads an apostrophe in JSX text as text, not a string opener (#4318)', () => {
    // `matchingBraceEnd` used to treat `'` as a string delimiter everywhere. In
    // JSX element text it is an ordinary character, so a brace expression
    // containing one never found its closing brace: the helper returned -1 and
    // every recognizer built on it — the conditional-child credit above, the
    // component-body walk the wrapper registry runs on — silently saw nothing.
    // This is the shape that left pages/AIProviders.jsx's fallback-model
    // controls on the allowlists while their four identical siblings passed.
    const field = (child) => `import FormField from '../ui/FormField';\n<FormField label="Fallback Model">\n  ${child}\n</FormField>`;

    const apostrophe = field(`{opts.length > 0 ? (<select><option value="">Use the provider's default</option></select>) : (<input type="text" placeholder="Use the provider's default" />)}`);
    expect(isNamed(apostrophe, 'select')).toBe(true);
    expect(isNamed(apostrophe, 'input')).toBe(true);

    // A quote in JavaScript-expression context is still a delimiter, so a `}`
    // inside a string cannot pass for the expression's end — that would cut the
    // scan short of the control and lose the credit the other way.
    const braceInString = field(`{mode === 'a}b' ? (<select><option>a</option></select>) : (<input type="text" />)}`);
    expect(isNamed(braceInString, 'select')).toBe(true);

    // The fix widens what the scanner can READ, not what it credits: with the
    // apostrophe in element text — the position that used to blind the scan —
    // the rendered-list veto still applies now that the bounds are legible.
    const list = field(`{fields.map((f) => (<select key={f}><option>it's here</option></select>))}`);
    expect(isNamed(list, 'select')).toBe(false);
  });

  it('recognizes a wrapper wherever it is declared and however it names', () => {
    // The registry splits "where the wrapper lives" from "how it names", so
    // every combination has to work — the arrow-function and imported-wrapper
    // quadrants were unreachable before #4317, and the cheapest way to make a
    // new control pass a guard that misses its wrapper is an `aria-label` that
    // shadows the visible label the wrapper already renders.
    // An arrow-function implicit wrapper, in both body forms.
    const parenArrow = 'const Field = ({ label, children }) => (\n  <label className="block"><span>{label}</span>{children}</label>\n);\n<Field label="Rounds"><input type="number" /></Field>';
    expect(isNamed(parenArrow)).toBe(true);
    expect(isNamed(parenArrow.replace('label="Rounds"', ''))).toBe(false);
    const blockArrow = `const Field = ({ label, children }) => {
  return (<label className="block"><span>{label}</span>{children}</label>);
};
<Field label="Rounds"><input type="number" /></Field>`;
    expect(isNamed(blockArrow)).toBe(true);

    // An arrow-function htmlFor forwarder.
    const arrowForwarder = 'const Group = ({ id, label, children }) => (\n  <div><label htmlFor={id}>{label}</label>{children}</div>\n);\n<Group id="rounds" label="Rounds"><input id="rounds" type="number" /></Group>';
    expect(isNamed(arrowForwarder)).toBe(true);
    expect(isNamed(arrowForwarder.replace(' label="Rounds"', ''))).toBe(false);

    // An IMPORTED wrapper, resolved and read: components/ui/FormField.jsx is
    // the cloning shape, and its default export is credited through whatever
    // name the call site binds it to.
    const importedCloner = "import FormField from '../ui/FormField';\n<FormField label=\"Rounds\"><input type=\"number\" /></FormField>";
    expect(isNamed(importedCloner)).toBe(true);
    const renamedBinding = 'import Wrapped from \'../ui/FormField\';\n<Wrapped label="Rounds"><input type="number" /></Wrapped>';
    expect(isNamed(renamedBinding)).toBe(true);
    // An unresolvable specifier is not credited: there is no source to read, so
    // the name alone proves nothing.
    expect(isNamed(importedCloner.replace("'../ui/FormField'", "'./NotAFile'"))).toBe(false);
    // Neither is a resolvable import of a component that names no control.
    const importedNonWrapper = 'import Drawer from \'../Drawer\';\n<Drawer label="Rounds"><input type="number" /></Drawer>';
    expect(isNamed(importedNonWrapper)).toBe(false);

    // A same-file cloning wrapper — the quadrant the hardcoded `FormField`
    // name could never reach. The clone is what proves the generated id gets
    // to the child; without it the <label> points at a local that goes nowhere.
    const localCloner = `function Boxed({ label, children }) {
  const controlId = useId();
  const augmented = Children.map(children, (child, i) => (i === 0 ? cloneElement(child, { id: controlId }) : child));
  return (<div><label htmlFor={controlId}>{label}</label>{augmented}</div>);
}
<Boxed label="Rounds"><input type="number" /></Boxed>`;
    expect(isNamed(localCloner)).toBe(true);
    expect(isNamed(localCloner.replace('cloneElement(child, { id: controlId })', 'child'))).toBe(false);
    expect(isNamed(localCloner.replace(' label="Rounds"', ''))).toBe(false);
    // A <label> that renders no text names nothing, in any quadrant.
    expect(isNamed(localCloner.replace('>{label}<', '><'))).toBe(false);
    expect(isNamed(parenArrow.replace('<span>{label}</span>', ''))).toBe(false);

    // A prop the <label> passes to a nested element's ATTRIBUTE renders no
    // text — `<span className={label} aria-hidden />` puts nothing in the
    // accessible name. Reading it as the label's text would exempt a control
    // that really is unnamed, which is the one failure direction this guard
    // cannot afford.
    const attributeOnlyProp = 'const Field = ({ label, children }) => (\n  <label><span className={label} aria-hidden="true" />{children}</label>\n);\n<Field label="theme-icon"><input type="text" /></Field>';
    expect(isNamed(attributeOnlyProp)).toBe(false);
    const forwarderAttributeOnlyProp = `function TooltipLabel({ htmlFor, label, children }) {
  return (<label htmlFor={htmlFor}><span data-tooltip={label} aria-hidden="true" />{children}</label>);
}
<TooltipLabel htmlFor="rounds" label="tooltip text" />
<input id="rounds" type="number" />`;
    expect(isNamed(forwarderAttributeOnlyProp)).toBe(false);

    // A cloning wrapper that clones onto an INDEXED child names that child, not
    // the first one — and the call-site check credits the first. Only a bare
    // `Children.map` callback parameter counts as the clone target.
    const indexedClone = localCloner.replace('cloneElement(child, { id: controlId })', 'cloneElement(children[1], { id: controlId })');
    expect(isNamed(indexedClone)).toBe(false);
    // …and a wrapper that clones onto an element it built for ITSELF never
    // touches the caller's child, so the caller's control stays unnamed.
    const internalClone = `function Boxed({ label, children }) {
  const controlId = useId();
  const own = <div />;
  const cloned = cloneElement(own, { id: controlId });
  return (<div><label htmlFor={controlId}>{label}</label>{cloned}{children}</div>);
}
<Boxed label="Rounds"><input type="number" /></Boxed>`;
    expect(isNamed(internalClone)).toBe(false);

    // A `>` inside a quoted attribute value must not end the tag early — the
    // rest of the tag would survive as "text" and its attributes would read as
    // rendered props, re-opening the attribute-only bypass above.
    const angleBracketInAttribute = 'const Field = ({ label, children }) => (\n  <label><span title=">" data-tooltip={label} />{children}</label>\n);\n<Field label="Help text"><input type="text" /></Field>';
    expect(isNamed(angleBracketInAttribute)).toBe(false);
  });

  it('decodes a wrapped default export and a re-export barrel (#4327)', () => {
    // The registry resolves an imported wrapper by READING the imported file,
    // so an export idiom it cannot decode reports "not a wrapper" for a wrapper
    // it never opened — the absent-vs-empty collapse, and the same silent false
    // negative #4317 was filed to close. Neither idiom has a live label-wrapper
    // witness in the tree (this repo's barrels forward pages, not wrappers, and
    // its `export default memo(…)` components are not label wrappers), so the
    // fixtures stand in as virtual modules and the assertion still runs through
    // the real scan rather than through a hand-called decoder.
    const DIR = 'src/components/settings';
    const implicit = (name) => `function ${name}({ label, children }) {
  return (<label className="block"><span>{label}</span>{children}</label>);
}`;
    const callSite = (specifier, binding, clause = binding) =>
      `import ${clause} from '${specifier}';\n<${binding} label="Rounds"><input type="number" /></${binding}>`;

    // 1. A default export wrapped in HOC calls. `export default memo(Field)` is
    // a live idiom here (grep `export default memo(`), and the old
    // `export default (function )?Name` pattern yields nothing for all of these
    // — `memo` is not the component, and it is not capitalized either.
    for (const wrapped of ['memo(Field)', 'React.memo(Field)', 'memo(forwardRef(Field))']) {
      const src = `${implicit('Field')}\nexport default ${wrapped};`;
      const named = withVirtualSources({ [`${DIR}/Wrapped.jsx`]: src }, () =>
        isNamed(callSite('./Wrapped', 'Field')));
      expect(named, `default export \`${wrapped}\` was not decoded`).toBe(true);
    }
    // The declaration form inside the HOC, where the parens after the name are
    // a parameter list rather than a call to unwrap.
    const inlineDeclaration = `export default forwardRef(function Field({ label, children }) {
  return (<label className="block"><span>{label}</span>{children}</label>);
});`;
    expect(withVirtualSources({ [`${DIR}/Inline.jsx`]: inlineDeclaration }, () =>
      isNamed(callSite('./Inline', 'Field')))).toBe(true);

    // An anonymous wrapped default names no declared component, so there is
    // nothing to look up — and guessing would credit whatever capitalized name
    // sat nearby. Unnamed is the safe direction: the control stays allowlisted.
    const anonymous = 'export default memo(({ label, children }) => (\n  <label className="block"><span>{label}</span>{children}</label>\n));';
    expect(withVirtualSources({ [`${DIR}/Anon.jsx`]: anonymous }, () =>
      isNamed(callSite('./Anon', 'Field')))).toBe(false);
    // …as is a wrapped default whose component is not a wrapper at all.
    const notAWrapper = 'function Field({ label, children }) {\n  return (<div>{label}{children}</div>);\n}\nexport default memo(Field);';
    expect(withVirtualSources({ [`${DIR}/Plain.jsx`]: notAWrapper }, () =>
      isNamed(callSite('./Plain', 'Field')))).toBe(false);

    // 2. A re-export barrel. `resolveRelativeImport` already resolves `../ui`
    // to its index file; before this, that index declared no components and the
    // registry stopped there.
    const barrel = (line) => ({
      [`${DIR}/kit/index.js`]: line,
      [`${DIR}/kit/Field.jsx`]: `${implicit('Field')}\nexport default Field;`,
      [`${DIR}/kit/Named.jsx`]: implicit('Named').replace('function', 'export function'),
    });
    expect(withVirtualSources(barrel("export { default as Field } from './Field';"), () =>
      isNamed(callSite('./kit', 'Field', '{ Field }')))).toBe(true);
    // The aliasing has to survive the hop: `Named` is what the source module
    // exports, `Field` is what the call site renders.
    expect(withVirtualSources(barrel("export { Named as Field } from './Named';"), () =>
      isNamed(callSite('./kit', 'Field', '{ Field }')))).toBe(true);
    // A barrel that forwards a name it cannot resolve credits nothing.
    expect(withVirtualSources(barrel("export { default as Field } from './Missing';"), () =>
      isNamed(callSite('./kit', 'Field', '{ Field }')))).toBe(false);
    // Neither does one whose target is a component that names no control.
    expect(withVirtualSources({
      ...barrel("export { default as Field } from './Field';"),
      [`${DIR}/kit/Field.jsx`]: 'function Field({ label, children }) {\n  return (<div>{label}{children}</div>);\n}\nexport default Field;',
    }, () => isNamed(callSite('./kit', 'Field', '{ Field }')))).toBe(false);

    // The stand-ins are torn down with the caches they seeded, so a rule that
    // reads real source can never observe one.
    expect(virtualSources.size).toBe(0);
    expect(maskedSourceByFile.has(`${DIR}/kit/index.js`)).toBe(false);
  });

  it('meets the 44px touch-target minimum on Close buttons', () => {
    // Close buttons keep shipping sized to their bare icon (w-4 h-4, p-1,
    // p-1.5) instead of a real tap target. components/Drawer.jsx:106 is the
    // convention: min-h-[44px] min-w-[44px] + flex items-center
    // justify-center, so the icon stays centered in the larger box.
    //
    // `inset-0` buttons are exempt: a full-bleed tap-anywhere-to-dismiss
    // backdrop (e.g. brain/tabs/DailyLogTab.jsx's mobile history scrim)
    // already covers the entire screen/panel, so a min-w/min-h floor is
    // meaningless — the element's box is already forced to fill its
    // positioned ancestor.
    // Matches both a literal `aria-label="Close…"` and an expression form
    // `aria-label={cond ? 'Close panel' : …}` / {`Close ${x}`} / {closeLabel}.
    // Scanning only the literal form is how a live 16px close button in
    // apps/DeployPanel.jsx (dynamic label, no sizing at all) hid from this
    // guard while it reported zero offenders — the canonical Drawer.jsx close
    // button uses a dynamic label too, so the literal-only form misses the
    // exact shape the convention was written from.
    const CLOSE_LABEL_RE = /aria-label\s*=\s*(?:"Close[^"]*"|\{[^}]*(?:['"`]Close|[Cc]loseLabel)[^}]*\})/;
    const offenders = [];
    for (const file of trackedJsxFiles()) {
      const src = rawSourceOf(file);
      for (const { tag, index } of forEachOpeningTag(src, 'button')) {
        if (!CLOSE_LABEL_RE.test(tag)) continue;
        if (/\binset-0\b/.test(tag)) continue;
        const clsMatch = tag.match(/className\s*=\s*"([^"]*)"/);
        if (!clsMatch) continue; // dynamic className — reviewed by hand, not scanned here
        if (hasFortyFourMinTouchTarget(clsMatch[1])) continue;
        offenders.push(`${file}:${lineOf(src, index)}`);
      }
    }
    expect(offenders, `Close button under the 44px touch-target minimum — add min-h-[44px] min-w-[44px] + flex items-center justify-center (see Drawer.jsx:106):\n${offenders.join('\n')}`).toEqual([]);
  });
});
