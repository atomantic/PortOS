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
 *      and driven by a programmatic click on the ref's element. That is unreachable
 *      by keyboard and screen reader, and the synthetic click doesn't open the
 *      picker at all in WebKit-as-installed-PWA — the shape PortOS is opened in
 *      from a second machine over the tailnet. `components/ui/FilePickerButton.jsx`
 *      is the shared widget (sr-only input + native `<label for>` activation).
 *   4. A `duration: Infinity` toast whose content is JSX or a render prop but
 *      which passes no `label`. Such a toast collapses to a pill after
 *      COLLAPSE_AFTER_MS (so it stops covering the page), and the pill has no
 *      text of its own to name itself with.
 *   5. A non-interactive element (`<div>`, `<li>`, `<tr>`, …) carrying an
 *      `onClick` and nothing else. It takes no focus and Enter/Space do
 *      nothing, so the affordance does not exist at all for a keyboard or
 *      screen-reader user. `lib/a11yKeyboard.js`'s `clickableProps(handler)`
 *      supplies the missing role, tab stop and Enter/Space handler.
 *   6. An icon-only `<button>` sized to its bare icon (`p-1` around a
 *      12-14px glyph = a 22px target) instead of the 44px floor the rest of
 *      the app enforces.
 *   7. A `DndContext` whose sensor list has no `KeyboardSensor`. dnd-kit's
 *      `attributes` make every drag handle a tab stop that announces itself as
 *      draggable and points at "press the space bar to pick up" instructions,
 *      so a pointer-only sensor list actively instructs the user to use an
 *      interaction nothing is listening for.
 *
 * A missing `<img alt>` and a `role="switch"` without `aria-checked` are not
 * scanned here: Biome's `a11y/useAltText` and `a11y/useAriaPropsForRole`
 * (`client/biome.jsonc`) reject both with a real parser, spreads included.
 *
 * Scoped to git-tracked `.jsx` under `client/src` so an untracked scratch file
 * can't fail the suite.
 *
 * The scanner behind these guards is split across `src/test/a11yScan*.js`; the rules
 * live one family per file in `src/test/guards/a11y/`.
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { trackedJsxFiles as trackedJsx, trackedSourceFiles as trackedSources } from '../test/trackedFiles.js';
import { maskComments, } from './a11yScanNames.js';
import { readText } from '../../../scripts/lib/guardCorpus.js';

export const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Shared with the other repo-hygiene guards (see `src/test/trackedFiles.js` for
// why `.js` is included alongside `.jsx`: the OpenClaw composer's file-input ref
// lived in `hooks/useOpenClawAttachments.js`, exactly the hole a `.jsx`-only
// scan leaves open).
// Memoized: each call shells out to `git ls-files`, and the rules below ask for
// the list a dozen times over.
export let trackedJsxCache = null;
export let trackedSourceCache = null;
export const trackedJsxFiles = () => (trackedJsxCache ??= trackedJsx(CLIENT_ROOT));
export const trackedSourceFiles = () => (trackedSourceCache ??= trackedSources(CLIENT_ROOT));
export const trackedSourceSet = (() => {
  let cached = null;
  return () => (cached ??= new Set(trackedSourceFiles()));
})();

// `maskComments` is the most expensive routine in this file — a per-character
// lexer over ~11MB of source — and several rules want the same file masked.
// Memoizing by path collapses that to one pass per file for the whole suite;
// it is also what lets `wrapperRegistry` key its cache by path, since the scan
// and the wrapper lookups then share one source *object*.
export const maskedSourceByFile = new Map();

// Probe-only stand-in modules, keyed by the same client-relative path a real
// file would use. An import idiom with no live witness in the tree — a wrapped
// default export, a re-export barrel — is otherwise only testable by calling
// its decoder by hand, which proves the decoder and not the wiring. Installed
// for the duration of one `withVirtualSources` callback and torn down with
// every cache entry they seeded, so no rule that reads real source sees them.
export const virtualSources = new Map();

export function maskedSourceOf(file) {
  let masked = maskedSourceByFile.get(file);
  if (masked === undefined) {
    const raw = virtualSources.get(file) ?? rawSourceOf(file);
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
export const rawSourceByFile = new Map();

export function rawSourceOf(file) {
  let raw = rawSourceByFile.get(file);
  if (raw === undefined) {
    raw = readText(join(CLIENT_ROOT, file));
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
export function openingTagAt(src, index) {
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
export const TAG_NAME_PATTERN = '[A-Za-z][\\w$.-]*';
// The two case-specific readers derive from the one spelling above instead of
// drifting into their own almost-the-same character classes.
export const COMPONENT_TAG_NAME_PATTERN = TAG_NAME_PATTERN.replace('A-Za-z', 'A-Z');
export const HOST_TAG_NAME_PATTERN = TAG_NAME_PATTERN.replace('A-Za-z', 'a-z');
export const COMPONENT_TAG_NAME = new RegExp(`^${COMPONENT_TAG_NAME_PATTERN}$`);
export const HOST_TAG_NAME = new RegExp(`^${HOST_TAG_NAME_PATTERN}$`);

// The element name starting at `from` (the index just past `<` or `</`), or
// null. Sticky rather than `src.slice(from).match(…)`: every caller runs this
// per tag over whole files, and the slice allocates a copy of the rest of the
// file each time. Safe to hoist despite the mutable `lastIndex` — nothing is
// called between the assignment and the `exec`, so no walk can interleave.
export const TAG_NAME_AT = new RegExp(TAG_NAME_PATTERN, 'y');

export function tagNameAt(src, from) {
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
export const tagIndexBySource = new Map();

export function tagIndexOf(src, { startMode = 'code' } = {}) {
  const indexesByStartMode = tagIndexBySource.get(src);
  const cached = indexesByStartMode?.get(startMode);
  if (cached) return cached;
  const nodes = [];
  const openByStart = new Map();
  for (const token of jsxScanner(src, { mode: startMode, tokens: 'tags' })) {
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
export function* forEachTag(src, name, { startMode = 'code' } = {}) {
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
export function* forEachOpeningTag(src, name, options) {
  for (const node of forEachTag(src, name, options)) {
    if (!node.closing && node.tag !== null) yield node;
  }
}

// Which element names this source renders at all — the "is it worth reading the
// imported file" precheck. Built from the memoized index rather than memoized
// itself: its one caller is `wrapperRegistry`, which is already cached per file.
export const renderedTagNames = (src) => new Set(
  tagIndexOf(src).filter((node) => !node.closing && node.name).map((node) => node.name),
);

export const lineOf = (src, index) => src.slice(0, index).split('\n').length;

// Index of the last non-whitespace character before `from`, stopping at `floor`
// rather than walking past it. Four walks spelled this out, each with its own
// idea of how far back it was allowed to look.
//
// This answers "what character precedes this one", which is only the same as
// "what token precedes this one" when no comment sits between them. Inside the
// scanner that distinction matters, so it tracks the previous TOKEN forward and
// uses this only to seed the walk; the one caller left needs the character.
export const previousSignificant = (src, from, floor) => {
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
export function skipString(src, from) {
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
export function commentEnd(src, from) {
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
export const REGEX_PRECEDERS = '=([{,;:!&|?>';
export const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|throw|typeof|instanceof|case|default|in|of|new|delete|void|yield|await|do|else)$/;

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
export function regexEnd(src, from, previous) {
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
export function balancedCallAt(src, openIndex) {
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
export const opensJsxTagInText = (src, index) => src[index] === '<'
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
export const looksLikeJsxTagStart = (src, index, previous) => {
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
// Tag indexing and comment masking need the same lexer state, but only need their own events.
export function* jsxScanner(src, { from = 0, mode: startMode = 'code', tokens = 'all' } = {}) {
  const allTokens = tokens === 'all';
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
    if (!allTokens) {
      // These characters cannot change lexer mode or emit a tag/comment.
      const code = src.charCodeAt(i);
      if (code === 32 || code === 10 || code === 9 || code === 13) continue;
      if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57)) {
        previous = i;
        continue;
      }
    }

    // Strings, comments, and regex literals exist only outside element text —
    // in `<option>Use the provider's default</option>` the apostrophe is text,
    // and reading it as a string opener swallows the rest of the file (#4318).
    if (mode !== 'jsx-text') {
      if (c === '/') {
        const comment = commentEnd(src, i);
        if (comment !== -1) {
          if (tokens !== 'tags') yield { kind: 'comment', index: i, end: Math.min(comment, src.length - 1), mode };
          i = comment;
          continue;
        }
        if (mode === 'code') {
          const end = regexEnd(src, i, previous);
          if (end !== -1) {
            if (allTokens) yield { kind: 'regex', index: i, end, mode };
            i = end;
            previous = end;
            continue;
          }
        }
      }
      if (c === '"' || c === '\'' || c === '`') {
        const end = skipString(src, i);
        if (allTokens) yield { kind: 'string', index: i, end: Math.min(end, src.length - 1), mode };
        i = end;
        previous = Math.min(end, src.length - 1);
        continue;
      }
    }
    const before = previous;
    // Printable non-space ASCII dominates these sources. Keep JS whitespace
    // semantics for other characters without running a regex on every token.
    if ((c > ' ' && c <= '~') || !/\s/.test(c)) previous = i;

    // Braces nest the same way in all three contexts, so they are handled once.
    if (c === '{') {
      if (allTokens) yield { kind: 'char', index: i, char: c, mode, depth: braceFrames.length };
      braceFrames.push({ mode, tag });
      mode = 'code';
      tag = null;
      continue;
    }
    if (c === '}') {
      // A slice can begin inside an expression, so the pop may come back empty;
      // an unmatched `}` then simply sits at depth 0 and changes no context.
      const frame = braceFrames.pop();
      if (allTokens) yield { kind: 'char', index: i, char: c, mode, depth: braceFrames.length };
      if (frame) ({ mode, tag } = frame);
      continue;
    }

    // Decided here rather than by each walk for itself: `mode` and `before` are
    // this machine's state, and every past defect in this file came from a
    // scanner ruling on a `<` without them.
    const opensTag = c === '<' && (mode === 'jsx-text'
      ? opensJsxTagInText(src, i)
      : mode === 'code' && looksLikeJsxTagStart(src, i, before));

    if (allTokens || (tokens === 'tags' && (opensTag || (mode === 'jsx-tag' && c === '>')))) yield {
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
export function matchingBraceEnd(s, idx) {
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
export function tagBoundaryAt(s, idx) {
  for (const token of jsxScanner(s, { from: idx + 1, mode: 'jsx-tag' })) {
    if (token.kind === 'char' && token.char === '>' && token.mode === 'jsx-tag' && token.depth === 0) {
      return { end: token.index + 1, selfClosing: token.selfClosing };
    }
  }
  return null;
}

// Index of that closing `>`, for the callers that only need the slice.
export function tagEndAt(s, idx) {
  const boundary = tagBoundaryAt(s, idx);
  return boundary ? boundary.end - 1 : -1;
}

export const stripJsxComments = (s) => s.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');

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
export function soleTopLevelNode(rawBody) {
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
export const topLevelOperatorIn = (inner, char, from) => {
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

export const isSelfClosingIconNode = (node) => (
  node?.kind === 'element'
  && node.selfClosing
  && node.name !== null
  && COMPONENT_TAG_NAME.test(node.name)
);

export function matchTernaryIcons(inner) {
  const qIdx = topLevelOperatorIn(inner, '?', 0);
  if (qIdx === -1) return false;
  const cIdx = topLevelOperatorIn(inner, ':', qIdx + 1);
  if (cIdx === -1) return false;
  const a = inner.slice(qIdx + 1, cIdx).trim();
  const b = inner.slice(cIdx + 1).trim();
  return isSelfClosingIconNode(soleTopLevelNode(a)) && isSelfClosingIconNode(soleTopLevelNode(b));
}

export function lastTopLevelAndIn(inner) {
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
export function unwrapPresentational(rawBody, depth = 0) {
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

export function isIconOnlyBody(rawBodyIn) {
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
export function findButtonBody(src, openEnd) {
  const closeIdx = src.indexOf('</button>', openEnd);
  return closeIdx === -1 ? null : src.slice(openEnd, closeIdx);
}

// Is this <button> node one whose entire body is an icon? Named rather than
// inlined in the rule so the `selfClosing` it reads is testable: these rules
// scan UNMASKED source, where a comment survives to the end of the tag —
// `<button /* pause */>` ends in `*/>`, which the old `endsWith('/>')`
// re-derivation called self-closing, skipping a button that has a body.
//
// Two rules ask about the same shape for different reasons: the naming rule
// wants the ones with nothing to announce, the touch-target rule wants all of
// them (an aria-label makes a 22px button announceable, not tappable).
export function isIconOnlyButton(src, { contentStart, selfClosing }) {
  if (selfClosing) return false; // no body to judge
  const body = findButtonBody(src, contentStart);
  return body !== null && isIconOnlyBody(body);
}

export function isUnnamedIconOnlyButton(src, node) {
  if (/\baria-label\s*=/.test(node.tag) || /\baria-labelledby\s*=/.test(node.tag)) return false;
  return isIconOnlyButton(src, node);
}

