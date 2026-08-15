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
const trackedJsxFiles = () => trackedJsx(CLIENT_ROOT);
const trackedSourceFiles = () => trackedSources(CLIENT_ROOT);

/**
 * Slice out the full opening tag starting at `index`, tolerating `>` inside
 * JSX expression containers (`className={`a > b`}`) by tracking brace depth.
 */
function openingTagAt(src, index, nameLength) {
  let depth = 0;
  for (let i = index + nameLength; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return src.slice(index, i + 1);
  }
  return null;
}

const lineOf = (src, index) => src.slice(0, index).split('\n').length;

/**
 * Slice a call's full argument list, `(` through its matching `)`, starting at
 * the opening paren. Skips over string and template literals so a `)` inside
 * one can't close the call early.
 */
function balancedCallAt(src, openIndex, skipStrings = true) {
  let depth = 0;
  for (let i = openIndex; i < src.length; i++) {
    const c = src[i];
    if (skipStrings && (c === '\'' || c === '"' || c === '`')) {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(openIndex, i + 1);
  }
  // Falling off the end means a quote opened a "string" that never closed —
  // in practice an apostrophe in JSX text, `toast(<p>You're out of sync</p>,
  // { duration: Infinity })`. The scan swallows the closing paren, the caller
  // skips the unparseable call, and the toast rule silently misses the one
  // shape it exists to catch: JSX content, which is precisely what needs
  // `label`. Retry counting parens only — a `)` inside a real string could
  // close early, but a well-formed string already returned on the first pass.
  return skipStrings ? balancedCallAt(src, openIndex, false) : null;
}

// --- helpers for the icon-only-button-name and 44px-close-target rules ---

// Find the index of the `}` matching the `{` at `s[idx]`, respecting nested
// braces and quoted/template strings.
function matchingBraceEnd(s, idx) {
  let depth = 0;
  for (let i = idx; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === '\'' || c === '`') {
      const q = c;
      for (i++; i < s.length && s[i] !== q; i++) if (s[i] === '\\') i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// Find the top-level `>` closing a JSX opening tag starting at `s[idx]` (`<`),
// respecting `{...}` attribute-expression nesting and quoted strings inside
// them. Returns `{ end, selfClosing }`, `end` being the index just past `>`.
function tagBoundaryAt(s, idx) {
  let depth = 0;
  for (let i = idx + 1; i < s.length; i++) {
    const c = s[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if ((c === '"' || c === '\'' || c === '`') && depth > 0) {
      const q = c;
      for (i++; i < s.length && s[i] !== q; i++) if (s[i] === '\\') i++;
    } else if (c === '>' && depth === 0) {
      let back = i - 1;
      while (back > idx && /\s/.test(s[back])) back--;
      return { end: i + 1, selfClosing: s[back] === '/' };
    }
  }
  return null;
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
    return { kind: 'element', raw: s.slice(0, boundary.end), selfClosing: boundary.selfClosing };
  }
  if (s[0] === '{') {
    const end = matchingBraceEnd(s, 0);
    if (end === -1) return null;
    if (s.slice(end + 1).trim() !== '') return null; // more than one top-level node
    return { kind: 'expr', inner: s.slice(1, end).trim() };
  }
  return null; // bare text at top level
}

function matchTernaryIcons(inner) {
  let depth = 0;
  let qIdx = -1;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === '?' && depth === 0 && inner[i + 1] !== '.') { qIdx = i; break; }
  }
  if (qIdx === -1) return false;
  depth = 0;
  let cIdx = -1;
  for (let i = qIdx + 1; i < inner.length; i++) {
    const c = inner[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ':' && depth === 0) { cIdx = i; break; }
  }
  if (cIdx === -1) return false;
  const a = inner.slice(qIdx + 1, cIdx).trim();
  const b = inner.slice(cIdx + 1).trim();
  const iconRe = /^<[A-Z][\w.]*(\s[\s\S]*)?\/>$/;
  return iconRe.test(a) && iconRe.test(b);
}

// Unwrap presentational wrappers: a button whose body is `<span><X/></span>`
// (an extra element for padding, a hover background, or a badge) is still
// icon-only, but a walker that stops at the wrapper's opening tag reads its
// children as "more than one top-level node" and skips the button entirely.
// Recurse through lowercase host elements that carry no text of their own.
function unwrapPresentational(rawBody, depth = 0) {
  if (depth > 4) return rawBody;
  const s = stripJsxComments(rawBody).trim();
  const m = s.match(/^<([a-z][\w-]*)\b/);
  if (!m) return s;
  const boundary = tagBoundaryAt(s, 0);
  if (!boundary || boundary.selfClosing) return s;
  const close = `</${m[1]}>`;
  if (!s.endsWith(close)) return s;
  return unwrapPresentational(s.slice(boundary.end, s.length - close.length), depth + 1);
}

function isIconOnlyBody(rawBodyIn) {
  const rawBody = unwrapPresentational(rawBodyIn);
  const node = soleTopLevelNode(rawBody);
  if (!node) return false;
  if (node.kind === 'element') return node.selfClosing && /^<[A-Z]/.test(node.raw);
  const inner = node.inner;
  if (matchTernaryIcons(inner)) return true;
  const andMatch = inner.match(/^.*&&\s*(<[A-Z][\w.]*(\s[\s\S]*)?\/>)\s*$/s);
  if (!andMatch) return false;
  return /^<[A-Z][\w.]*(\s[\s\S]*)?\/>$/.test(andMatch[1].trim());
}

// Buttons don't nest in valid HTML/JSX, so the first `</button>` after the
// opening tag's end is its match.
function findButtonBody(src, openEnd) {
  const closeIdx = src.indexOf('</button>', openEnd);
  return closeIdx === -1 ? null : src.slice(openEnd, closeIdx);
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

// Keep source indexes stable while removing comments that may contain JSX
// examples. This is a small lexer rather than a quote-only scan: apostrophes,
// slashes, and URLs are ordinary JSX text and must not put the rest of a file
// into a fake JavaScript string/comment state.
function maskComments(src) {
  const chars = [...src];
  let mode = 'code';
  let quote = null;
  let braceDepth = 0;
  let tagBraceDepth = 0;
  let tagInfo = null;
  let tagParentMode = 'code';
  // Each entry marks whether the element started in JavaScript expression
  // context. A nested JSX expression can sit inside an outer element; when its
  // root closes, return to JavaScript rather than mistaking the outer element's
  // remaining stack entry for JSX text.
  const jsxStack = [];

  const jsxTagInfoAt = (index) => {
    const closing = src.startsWith('</', index);
    const fragment = src.startsWith('<>', index) || src.startsWith('</>', index);
    const name = src.slice(index + (closing ? 2 : 1)).match(/^([A-Za-z][\w.-]*)/)?.[1] || null;
    return { closing, fragment, name };
  };

  const looksLikeJsxTagStart = (index) => {
    const next = src[index + 1];
    if (!(next === '/' || next === '>' || /[A-Za-z]/.test(next || ''))) return false;
    let previous = index - 1;
    while (previous >= 0 && /\s/.test(src[previous])) previous--;
    if (previous < 0 || '=([{,:;!?&|>'.includes(src[previous])) return true;
    return /(?:return|yield|=>)\s*$/.test(src.slice(Math.max(0, index - 12), index));
  };

  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];

    if (mode === 'line-comment') {
      if (c === '\n') mode = 'code';
      else chars[i] = ' ';
      continue;
    }
    if (mode === 'block-comment') {
      if (c === '*' && chars[i + 1] === '/') {
        chars[i] = ' ';
        chars[++i] = ' ';
        mode = 'code';
      } else if (c !== '\n') {
        chars[i] = ' ';
      }
      continue;
    }
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (mode === 'jsx-text') {
      if (c === '{') {
        mode = 'code';
        braceDepth = 1;
      } else if (c === '<' && (src[i + 1] === '/' || /[A-Za-z>]/.test(src[i + 1] || ''))) {
        tagInfo = jsxTagInfoAt(i);
        tagParentMode = 'jsx-text';
        tagBraceDepth = 0;
        mode = 'jsx-tag';
      }
      continue;
    }
    if (mode === 'jsx-tag') {
      if (c === '/' && chars[i + 1] === '/') {
        chars[i] = ' ';
        chars[++i] = ' ';
        mode = 'line-comment';
        continue;
      }
      if (c === '/' && chars[i + 1] === '*') {
        chars[i] = ' ';
        chars[++i] = ' ';
        mode = 'block-comment';
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        quote = c;
        continue;
      }
      if (c === '{') {
        tagBraceDepth++;
        continue;
      }
      if (c === '}' && tagBraceDepth > 0) {
        tagBraceDepth--;
        continue;
      }
      if (c !== '>' || tagBraceDepth !== 0) continue;

      let previous = i - 1;
      while (previous >= 0 && /\s/.test(src[previous])) previous--;
      const selfClosing = src[previous] === '/';
      if (tagInfo.closing) {
        const entry = jsxStack.pop();
        mode = entry?.root ? 'code' : (jsxStack.length ? 'jsx-text' : 'code');
      } else if (selfClosing) {
        mode = tagParentMode;
      } else {
        jsxStack.push({ name: tagInfo.fragment ? null : tagInfo.name, root: tagParentMode === 'code' });
        mode = 'jsx-text';
      }
      tagInfo = null;
      continue;
    }

    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if (c === '/' && chars[i + 1] === '/') {
      chars[i] = ' ';
      chars[++i] = ' ';
      mode = 'line-comment';
      continue;
    }
    if (c === '/' && chars[i + 1] === '*') {
      chars[i] = ' ';
      chars[++i] = ' ';
      mode = 'block-comment';
      continue;
    }
    if (braceDepth > 0 && c === '{') {
      braceDepth++;
      continue;
    }
    if (braceDepth > 0 && c === '}') {
      braceDepth--;
      if (braceDepth === 0) mode = 'jsx-text';
      continue;
    }
    if (c === '<' && looksLikeJsxTagStart(i)) {
      tagInfo = jsxTagInfoAt(i);
      tagParentMode = 'code';
      tagBraceDepth = 0;
      mode = 'jsx-tag';
    }
  }
  return chars.join('');
}

function hasMatchingExplicitLabel(src, id) {
  const re = /<label\b/g;
  let match;
  while ((match = re.exec(src))) {
    const tag = openingTagAt(src, match.index, '<label'.length);
    if (!tag) continue;
    const htmlFor = normalizedAttributeValue(attributeValue(tag, 'htmlFor'));
    if (htmlFor !== id || !hasUsableElementText(src, match.index, tag)) continue;
    return true;
  }
  return false;
}

function stripHiddenElementContent(body) {
  const hiddenAttribute = String.raw`(?:aria-hidden\s*=\s*(?:["']true["']|\{\s*true\s*\})|\bhidden(?:\s*=\s*(?:["']true["']|\{\s*true\s*\}))?)`;
  return body
    .replace(new RegExp(`<([A-Za-z][\\w.-]*)\\b[^>]*${hiddenAttribute}[^>]*/\\s*>`, 'gi'), ' ')
    .replace(new RegExp(`<([A-Za-z][\\w.-]*)\\b[^>]*${hiddenAttribute}[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi'), ' ');
}

function hasUsableElementText(src, index, tag) {
  if (hasUsableAccessibleNameAttribute(tag, 'aria-label')) return true;
  if (/\/\s*>$/.test(tag)) return false;
  const name = tag.match(/^<([A-Za-z][\w.-]*)\b/)?.[1];
  if (!name) return false;
  const closeIndex = src.indexOf(`</${name}>`, index + tag.length);
  if (closeIndex === -1) return false;
  const body = stripHiddenElementContent(maskComments(src.slice(index + tag.length, closeIndex)))
    .replace(/<\/?[A-Za-z][^>]*>/g, ' ')
    .trim();
  if (!body) return false;
  const staticText = body.replace(/\{[^{}]*\}/g, ' ').trim();
  if (staticText) return true;
  return [...body.matchAll(/\{([^{}]*)\}/g)].some(([, expression]) => (
    !/^(?:''|""|``|null|undefined|false)\s*$/.test(expression.trim())
  ));
}

function isNestedInLabel(src, index) {
  const labels = [];
  const re = /<\/?label\b/g;
  let match;
  while ((match = re.exec(src)) && match.index < index) {
    if (match[0].startsWith('</')) {
      labels.pop();
      continue;
    }
    const tag = openingTagAt(src, match.index, '<label'.length);
    if (!tag) continue;
    if (!/\/\s*>$/.test(tag)) labels.push({ index: match.index, tag });
    re.lastIndex = match.index + tag.length;
  }
  return labels.some(({ index: labelIndex, tag }) => hasUsableElementText(src, labelIndex, tag));
}

function hasUsableAccessibleNameAttribute(tag, name) {
  const value = normalizedAttributeValue(attributeValue(tag, name));
  if (value === null || value === '') return false;
  const trimmed = value.trim();
  return trimmed !== '' && !/^(?:undefined|null)$/i.test(trimmed);
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

function isNestedInLabeledFormField(src, index) {
  const formRe = /<FormField\b/g;
  let formMatch;
  while ((formMatch = formRe.exec(src)) && formMatch.index < index) {
    const formTag = openingTagAt(src, formMatch.index, '<FormField'.length);
    if (!formTag || /\/\s*>$/.test(formTag)) continue;
    const label = normalizedAttributeValue(attributeValue(formTag, 'label'));
    if (label === null || label === '' || /^(?:undefined|null|false)$/i.test(label)) continue;

    let depth = 0;
    let firstChild = null;
    let closed = false;
    let cursor = formMatch.index + formTag.length;
    while (cursor < index) {
      if (/\s/.test(src[cursor])) {
        cursor++;
        continue;
      }
      if (src[cursor] === '{') {
        const end = matchingBraceEnd(src, cursor);
        if (end === -1 || end >= index) break;
        if (src.slice(cursor + 1, end).trim()) firstChild = firstChild || 'expression';
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
        if (depth === 0 && src.slice(cursor, next).trim()) firstChild = firstChild || 'text';
        cursor = next;
        continue;
      }

      const closing = src.startsWith('</', cursor);
      const name = src.slice(cursor + (closing ? 2 : 1)).match(/^([A-Za-z][\w.-]*)/)?.[1];
      if (!name) {
        if (src.startsWith('<>', cursor)) {
          if (depth === 0) firstChild = firstChild || 'fragment';
          depth++;
          cursor += 2;
          continue;
        }
        if (src.startsWith('</>', cursor)) {
          depth = Math.max(0, depth - 1);
          cursor += 3;
          continue;
        }
        cursor++;
        continue;
      }
      if (closing) {
        const end = src.indexOf('>', cursor);
        if (end === -1) break;
        if (depth > 0) depth--;
        else if (name === 'FormField') { closed = true; break; }
        cursor = end + 1;
        continue;
      }
      const tag = tagBoundaryAt(src, cursor);
      if (!tag) break;
      if (depth === 0) firstChild = firstChild || name;
      if (!tag.selfClosing) depth++;
      cursor = tag.end;
    }
    if (!closed && depth === 0 && firstChild === null && cursor === index) firstChild = 'input';
    // FormField clones only its first React child. The current input is named
    // by the wrapper only when it is that first, direct child; a later control
    // (DataDog's optional custom-site input) must remain actionable here.
    if (!closed && depth === 0 && firstChild === 'input') return true;
  }
  return false;
}

// Page-local field wrappers (PipelineSeries.jsx's `<Field label="…">`) render
// their children inside a real <label>, so the control they wrap is implicitly
// named — the <label> just lives in the component definition instead of at the
// call site. Recognise those wrappers from their own source so a correctly
// labeled control isn't forced to carry a redundant aria-label that would
// shadow the visible text. Only same-file definitions count; a wrapper imported
// from elsewhere stays unknown (FormField has its own dedicated check), and
// only `function` declarations are matched — a missed wrapper is a false
// negative that simply leaves its controls on the allowlist.
const labelWrapperNamesBySource = new Map();

function localLabelWrapperNames(src) {
  const cached = labelWrapperNamesBySource.get(src);
  if (cached) return cached;
  const names = new Set();
  const re = /function\s+([A-Z][\w]*)\s*\(/g;
  let match;
  while ((match = re.exec(src))) {
    let depth = 1;
    let cursor = match.index + match[0].length;
    for (; cursor < src.length && depth > 0; cursor++) {
      if (src[cursor] === '(') depth++;
      else if (src[cursor] === ')') depth--;
    }
    const bodyStart = src.indexOf('{', cursor);
    if (bodyStart === -1) continue;
    const bodyEnd = matchingBraceEnd(src, bodyStart);
    if (bodyEnd === -1) continue;
    const body = src.slice(bodyStart, bodyEnd);
    // The wrapper must render {children} between a <label> and its </label>.
    if (/<label\b[\s\S]*?\{\s*children\s*\}[\s\S]*?<\/label>/.test(body)) names.add(match[1]);
  }
  labelWrapperNamesBySource.set(src, names);
  return names;
}

function isNestedInLabelWrappingComponent(src, index) {
  for (const name of localLabelWrapperNames(src)) {
    const re = new RegExp(`</?${name}\\b`, 'g');
    let depth = 0;
    let outerLabel = null;
    let match;
    while ((match = re.exec(src)) && match.index < index) {
      if (match[0].startsWith('</')) {
        depth = Math.max(0, depth - 1);
        continue;
      }
      const tag = openingTagAt(src, match.index, name.length + 1);
      if (!tag) continue;
      re.lastIndex = match.index + tag.length;
      if (/\/\s*>$/.test(tag)) continue;
      if (depth === 0) outerLabel = normalizedAttributeValue(attributeValue(tag, 'label'));
      depth++;
    }
    if (depth === 0 || outerLabel === null || outerLabel === '') continue;
    if (!/^(?:undefined|null|false)$/i.test(outerLabel)) return true;
  }
  return false;
}

function hasUsableAriaLabelledByReference(src, tag) {
  const raw = attributeValue(tag, 'aria-labelledby');
  const value = normalizedAttributeValue(raw);
  if (!value || !/^[A-Za-z][\w:.-]*(?:\s+[A-Za-z][\w:.-]*)*$/.test(value)) return false;
  return value.split(/\s+/).every((id) => {
    const re = /<[A-Za-z][\w.-]*\b/g;
    let match;
    while ((match = re.exec(src))) {
      const referencedTag = openingTagAt(src, match.index, 1);
      if (!referencedTag) continue;
      if (normalizedAttributeValue(attributeValue(referencedTag, 'id')) !== id) continue;
      if (/\baria-hidden\s*=\s*['"`]true['"`]/.test(referencedTag)) return false;
      if (hasUsableElementText(src, match.index, referencedTag)) return true;
    }
    return false;
  });
}

function hasAccessibleInputName(src, tag, index) {
  if (hasUsableAccessibleNameAttribute(tag, 'aria-label')) return true;
  if (hasUsableAccessibleNameAttribute(tag, 'aria-labelledby') && hasUsableAriaLabelledByReference(src, tag)) return true;
  if (hasUsableNativeInputName(tag)) return true;
  if (isNestedInLabel(src, index) || isNestedInLabeledFormField(src, index)) return true;
  if (isNestedInLabelWrappingComponent(src, index)) return true;

  const id = normalizedAttributeValue(attributeValue(tag, 'id'));
  return id !== null && id !== '' && hasMatchingExplicitLabel(src, id);
}

// These are pre-existing controls exposed when the rule was generalized. The
// migration is tracked in #4297. Keep exceptions tied to stable source anchors
// rather than line numbers, so inserting code above a control does not move
// the exception to a different input; remove each entry as its control receives
// a real name.
const INPUT_ANCHOR_ATTRIBUTES = [
  'id', 'name', 'type', 'placeholder', 'value', 'ref', 'title', 'role',
  'aria-label', 'aria-labelledby', 'autoFocus', 'min', 'max', 'step',
];

function inputSemanticAnchor(tag) {
  return INPUT_ANCHOR_ATTRIBUTES.map((name) => {
    const value = attributeValue(tag, name);
    return value === null ? null : `${name}=${value.replace(/\s+/g, ' ')}`;
  }).filter(Boolean).join('|');
}

function inputSourceAnchor(file, src, index) {
  const tag = openingTagAt(src, index, '<input'.length);
  if (!tag) return `${file}|unknown-input`;
  const semantic = inputSemanticAnchor(tag);
  const matchingInputs = [];
  for (const match of src.matchAll(/<input\b/g)) {
    const otherTag = openingTagAt(src, match.index, '<input'.length);
    if (inputSemanticAnchor(otherTag) === semantic) matchingInputs.push(match.index);
  }
  if (matchingInputs.length === 1) return `${file}|${semantic}`;
  const occurrence = matchingInputs.indexOf(index) + 1;
  return `${file}|${semantic}|occurrence=${occurrence}`;
}

const PREEXISTING_INPUT_NAME_ALLOWLIST = new Set([
  "src/components/CronInput.jsx|type=text|placeholder=0 7 * * *|value=expr",
  "src/components/EntityCombobox.jsx|id=inputId|type=text|placeholder=placeholder || `Search ${noun}s or type a new name…`|value=value|role=combobox",
  "src/components/TagPicker.jsx|id=id|type=text|placeholder=value.length >= maxTags ? `Max ${maxTags} tags` : placeholder|value=input",
  "src/components/agents/tabs/ToolsTab.jsx|type=text|placeholder=Post title...|value=postTitle",
  "src/components/agents/tabs/WorldTab.jsx|type=number|placeholder=X|value=newActionParams.x || ''|occurrence=1",
  "src/components/agents/tabs/WorldTab.jsx|type=number|placeholder=Y|value=newActionParams.y || ''|occurrence=1",
  "src/components/agents/tabs/WorldTab.jsx|type=text|placeholder=Thinking (optional)|value=newActionParams.thinking || ''",
  "src/components/agents/tabs/WorldTab.jsx|type=text|placeholder=Thought text|value=newActionParams.thought || ''",
  "src/components/agents/tabs/WorldTab.jsx|type=number|placeholder=X|value=newActionParams.x || ''|occurrence=2",
  "src/components/agents/tabs/WorldTab.jsx|type=number|placeholder=Y|value=newActionParams.y || ''|occurrence=2",
  "src/components/agents/tabs/WorldTab.jsx|type=number|placeholder=Z|value=newActionParams.z || ''",
  "src/components/agents/tabs/WorldTab.jsx|type=text|placeholder=Message|value=newActionParams.message || ''",
  "src/components/agents/tabs/WorldTab.jsx|type=text|placeholder=To Agent ID (optional)|value=newActionParams.sayTo || ''",
  "src/components/agents/tabs/WorldTab.jsx|type=text|placeholder=Thinking... (optional)|value=moveThinking",
  "src/components/agents/tabs/WorldTab.jsx|type=text|placeholder=What is this agent thinking?|value=thought",
  "src/components/agents/tabs/WorldTab.jsx|type=text|placeholder=Message to nearby agents...|value=sayMessage",
  "src/components/agents/tabs/WorldTab.jsx|type=text|placeholder=To Agent ID (optional — leave blank for broadcast)|value=sayTo",
  "src/components/apps/ReferenceReposPanel.jsx|placeholder=Display name (e.g. phosphene)|value=form.name",
  "src/components/apps/ReferenceReposPanel.jsx|placeholder=Branch (default: main)|value=form.branch",
  "src/components/apps/ReferenceReposPanel.jsx|placeholder=Repo URL (https://github.com/owner/repo.git) or local path|value=form.repoUrl",
  "src/components/apps/tabs/CustomTasksSection.jsx|type=text|placeholder=Task name *|value=form.name",
  "src/components/apps/tabs/CustomTasksSection.jsx|type=text|placeholder=Description|value=form.description",
  "src/components/apps/tabs/CustomTasksSection.jsx|type=text|placeholder=0 7 * * *|value=form.cronExpression || ''|title=Cron expression: minute hour dayOfMonth month dayOfWeek",
  "src/components/apps/tabs/CustomTasksSection.jsx|type=time|value=form.scheduledTime || ''|title=Run at a specific time (leave empty for any time)",
  "src/components/apps/tabs/GitTab.jsx|type=text|placeholder=Commit message...|value=commitMessage",
  "src/components/brain/tabs/DailyLogTab.jsx|type=text|placeholder=Quick append — adds a new paragraph…|value=quickAppend",
  "src/components/brain/tabs/FeedsTab.jsx|type=text|placeholder=Paste an RSS or Atom feed URL...|value=inputUrl|ref=inputRef",
  "src/components/brain/tabs/InboxTab.jsx|type=text|placeholder=One thought at a time...|value=inputText|ref=inputRef",
  "src/components/brain/tabs/LinksTab.jsx|type=text|placeholder=Paste a URL (GitHub repos auto-clone)...|value=inputUrl|ref=inputRef",
  "src/components/brain/tabs/LinksTab.jsx|type=text|placeholder=Search links by title, URL, description, or tag...|value=search",
  "src/components/brain/tabs/LinksTab.jsx|type=text|placeholder=Tags (comma-separated)|value=editForm.tags",
  "src/components/brain/tabs/MemoryTab.jsx|type=text|placeholder=Name|value=form.name || ''",
  "src/components/brain/tabs/MemoryTab.jsx|type=text|placeholder=Follow-ups (comma separated)|value=(form.followUps || []).join(', ')",
  "src/components/brain/tabs/MemoryTab.jsx|type=text|placeholder=Project name|value=form.name || ''",
  "src/components/brain/tabs/MemoryTab.jsx|type=text|placeholder=Next action (concrete, actionable step)|value=form.nextAction || ''",
  "src/components/brain/tabs/MemoryTab.jsx|type=text|placeholder=Title|value=form.title || ''|occurrence=1",
  "src/components/brain/tabs/MemoryTab.jsx|type=text|placeholder=One-liner (core insight)|value=form.oneLiner || ''",
  "src/components/brain/tabs/MemoryTab.jsx|type=text|placeholder=Title|value=form.title || ''|occurrence=2",
  "src/components/brain/tabs/MemoryTab.jsx|type=date|placeholder=Due date|value=form.dueDate ? form.dueDate.split('T')[0] : ''",
  "src/components/brain/tabs/MemoryTab.jsx|type=text|placeholder=Next action|value=form.nextAction || ''",
  "src/components/brain/tabs/MemoryTab.jsx|type=text|placeholder=Title (e.g. 'DnD session tonight')|value=form.title || ''",
  "src/components/brain/tabs/MemoryTab.jsx|type=text|placeholder=Mood (e.g. happy, reflective, tired)|value=form.mood || ''",
  "src/components/brain/tabs/MemoryTab.jsx|type=text|placeholder=Tags (comma separated)|value=form.tagInput ?? (form.tags || []).join(', ')",
  "src/components/brain/tabs/MemoryTab.jsx|type=text|placeholder=`Search ${DESTINATIONS[activeType]?.label?.toLowerCase() || 'records'}...`|value=searchQuery",
  "src/components/brain/tabs/NotesTab.jsx|placeholder=Search notes...|value=searchQuery|ref=searchRef",
  "src/components/brain/tabs/NotesTab.jsx|placeholder=folder/note-name|value=newNotePath",
  "src/components/brain/tabs/NotesTab.jsx|placeholder=/path/to/obsidian/vault|value=customPath",
  "src/components/calendar/AgendaTab.jsx|type=text|placeholder=Search events...|value=search",
  "src/components/calendar/ConfigTab.jsx|type=text|placeholder=Client ID (e.g. 123456789-abc.apps.googleusercontent.com)|value=oauthForm.clientId",
  "src/components/calendar/ConfigTab.jsx|type=password|placeholder=Client Secret (e.g. GOCSPX-...)|value=oauthForm.clientSecret",
  "src/components/calendar/ReviewTab.jsx|type=date|value=date",
  "src/components/calendar/ReviewTab.jsx|type=number|placeholder=min|value=editForm.durationMinutes|min=1|max=1440",
  "src/components/calendar/ReviewTab.jsx|type=text|placeholder=Note (optional)|value=editForm.note",
  "src/components/cos/TaskAddForm.jsx|type=text|placeholder=Template name...|value=templateNameInput",
  "src/components/cos/tabs/AgentCard.jsx|type=text|placeholder=Send additional context to agent...|value=btwInput",
  "src/components/cos/tabs/AgentCard.jsx|type=text|placeholder=What made this work well or poorly?|value=feedbackComment",
  "src/components/cos/tabs/ConfigRow.jsx|type=number|value=inputValue",
  "src/components/cos/tabs/ConfigRow.jsx|type=checkbox",
  "src/components/cos/tabs/JobsTab.jsx|type=text|placeholder=0 7 * * *|value=data.cronExpression || ''|title=Cron expression: minute hour dayOfMonth month dayOfWeek",
  "src/components/cos/tabs/JobsTab.jsx|type=time|value=data.scheduledTime || ''|title=Run at specific time (leave empty for any time)",
  "src/components/cos/tabs/JobsTab.jsx|type=text|placeholder=Job name|value=editData.name",
  "src/components/cos/tabs/JobsTab.jsx|type=text|placeholder=Description|value=editData.description",
  "src/components/cos/tabs/JobsTab.jsx|type=text|placeholder=Job name *|value=newJob.name",
  "src/components/cos/tabs/JobsTab.jsx|type=text|placeholder=Category|value=newJob.category",
  "src/components/cos/tabs/JobsTab.jsx|type=text|placeholder=Description|value=newJob.description",
  "src/components/cos/tabs/MemoryEditModal.jsx|type=text|placeholder=Add tag...|value=newTag",
  "src/components/cos/tabs/TaskItem.jsx|type=text|value=editData.description",
  "src/components/cos/tabs/TaskItem.jsx|type=text|placeholder=e.g., Waiting for API access, Needs design review...|value=blockedReason|ref=blockedInputRef",
  "src/components/cos/tabs/workflow/ScheduleEditor.jsx|type=time|value=parseSimpleCron(form.recheckCron)?.time ?? ''",
  "src/components/dashboard/LayoutEditor.jsx|id=layout-editor-window-end|type=time|value=activateWindow.end",
  "src/components/dashboard/LayoutEditor.jsx|type=text|placeholder=Name for new layout|value=dupName",
  "src/components/digital-twin/tabs/DocumentsTab.jsx|type=range|value=selectedDoc.weight || 5|min=1|max=10|occurrence=1",
  "src/components/digital-twin/tabs/DocumentsTab.jsx|type=range|value=selectedDoc.weight || 5|min=1|max=10|occurrence=2",
  "src/components/digital-twin/tabs/GoalsTab.jsx|type=date|value=birthDateInput",
  "src/components/digital-twin/tabs/GoalsTab.jsx|type=text|placeholder=Goal title...|value=newGoal.title",
  "src/components/digital-twin/tabs/GoalsTab.jsx|type=text|placeholder=Add milestone...|value=newMilestone.title",
  "src/components/digital-twin/tabs/GoalsTab.jsx|type=date|value=newMilestone.targetDate",
  "src/components/digital-twin/tabs/TimeCapsuleTab.jsx|type=text|placeholder=Snapshot label (e.g., Spring 2026, Pre-career-change)|value=label",
  "src/components/digital-twin/tabs/TimeCapsuleTab.jsx|type=checkbox",
  "src/components/goals/GoalEditForm.jsx|type=number|value=form.timeBlockConfig?.sessionDurationMinutes || 60|min=15|max=480",
  "src/components/goals/GoalEditForm.jsx|type=text|placeholder=Add tag...|value=tagInput",
  "src/components/goals/GoalEditForm.jsx|type=text|value=form.title",
  "src/components/goals/GoalLinkedCalendars.jsx|type=text|placeholder=Match pattern (optional)|value=calendarMatchPattern",
  "src/components/goals/GoalMilestones.jsx|type=text|placeholder=Add milestone...|value=newMilestone.title",
  "src/components/goals/GoalPlanSection.jsx|type=text|value=ms.title",
  "src/components/goals/GoalPlanSection.jsx|type=text|placeholder=Description...|value=ms.description || ''",
  "src/components/goals/GoalPlanSection.jsx|type=text|value=phase.title",
  "src/components/goals/GoalPlanSection.jsx|type=text|placeholder=Description...|value=phase.description || ''",
  "src/components/goals/GoalPlanSection.jsx|type=date|value=phase.targetDate",
  "src/components/goals/GoalProgressLog.jsx|type=date|value=progressForm.date",
  "src/components/goals/GoalProgressLog.jsx|type=number|placeholder=Minutes (optional)|value=progressForm.durationMinutes|min=1|max=1440",
  "src/components/goals/GoalTodoList.jsx|type=text|placeholder=Add todo...|value=newTodoTitle",
  "src/components/goals/GoalTodoList.jsx|type=number|placeholder=Est. min|value=newTodoEstimate|min=1",
  "src/components/goals/GoalsListView.jsx|type=text|placeholder=Search goals...|value=searchQuery",
  "src/components/goals/GoalsListView.jsx|type=text|placeholder=Add goal...|value=quickAdd",
  "src/components/goals/GoalsListView.jsx|type=text|placeholder=Goal title...|value=newGoal.title",
  "src/components/goals/GoalsTreeView.jsx|type=text|placeholder=Search...|value=searchQuery",
  "src/components/goals/GoalsTreeView.jsx|type=text|placeholder=Goal title...|value=newGoal.title",
  "src/components/imageGen/HfTokenBanner.jsx|type=password|placeholder=hf_…|value=token",
  "src/components/imageGen/LoraPicker.jsx|type=number|value=sel.scale|min=0|max=2|step=0.1",
  "src/components/insights/GoalScorecardTab.jsx|type=text|placeholder=extra keywords, comma-separated|value=drafts[rule.id] ?? ''",
  "src/components/loraTraining/ImportGalleryDialog.jsx|type=text|placeholder=Search prompt, model, seed, LoRA…|value=query",
  "src/components/meatspace/EpigeneticTracker.jsx|type=text|placeholder=Intervention name|value=customForm.name",
  "src/components/meatspace/EpigeneticTracker.jsx|type=text|placeholder=Target dosage (e.g. 5g/day)|value=customForm.dosage",
  "src/components/meatspace/EpigeneticTracker.jsx|type=text|placeholder=Unit (g, mg, min, etc.)|value=customForm.trackingUnit",
  "src/components/meatspace/EpigeneticTracker.jsx|type=number|placeholder=`Amount (${intervention.trackingUnit})`|value=logAmounts[key] || ''|min=0|step=any",
  "src/components/meatspace/post/ElementsSong.jsx|type=text|placeholder=...|value=answer|ref=inputRef",
  "src/components/meatspace/post/ElementsSong.jsx|type=text|placeholder=`${blankedWords.length} element${blankedWords.length > 1 ? 's' : ''}...`|value=answer|ref=inputRef",
  "src/components/meatspace/post/ElementsSong.jsx|type=text|placeholder=Search...|value=searchQuery",
  "src/components/meatspace/post/MemoryPractice.jsx|type=text|placeholder=`${blankWords.length} word${blankWords.length > 1 ? 's' : ''} missing...`|value=answer|ref=inputRef",
  "src/components/meatspace/post/MorseTrainer.jsx|placeholder=????|value=input|ref=inputRef",
  "src/components/meatspace/post/MorseTrainer.jsx|type=range|value=value|min=min|max=max|step=step",
  "src/components/meatspace/post/PostCognitiveDrillRunner.jsx|type=text|placeholder=Digits|value=input|ref=inputRef",
  "src/components/meatspace/post/PostDrillRunner.jsx|type=isTextDrill ? 'text' : 'number'|placeholder=Answer|value=inputValue|ref=inputRef",
  "src/components/meatspace/post/PostLlmDrillRunner.jsx|type=text|placeholder=Your answer...|value=i === items.length ? inputValue : ''|ref=i === items.length ? inputRef : undefined|autoFocus=i === items.length",
  "src/components/meatspace/post/PostLlmDrillRunner.jsx|type=text|placeholder=Type an item and press Enter...|value=inputValue|ref=inputRef",
  "src/components/meatspace/post/PostLlmDrillRunner.jsx|type=text|placeholder=Type a creative use and press Enter...|value=inputValue|ref=inputRef",
  "src/components/meatspace/post/WordplayDrillUI.jsx|type=text|placeholder=Type the full compound or just the other half...|value=inputValue|ref=inputRef",
  "src/components/meatspace/post/WordplayDrillUI.jsx|type=text|placeholder=The bridge word is...|value=inputValue|ref=inputRef",
  "src/components/meatspace/tabs/AgeTab.jsx|type=date|value=input",
  "src/components/meatspace/tabs/AlcoholTab.jsx|type=text|placeholder=Name|value=buttonForm.name",
  "src/components/meatspace/tabs/AlcoholTab.jsx|type=number|placeholder=buttonVolumeUnit === 'oz' ? 'Oz' : 'mL'|value=buttonForm.oz|min=0.1|step=0.1|occurrence=1",
  "src/components/meatspace/tabs/AlcoholTab.jsx|type=number|placeholder=ABV%|value=buttonForm.abv|min=0|max=100|step=0.1|occurrence=1",
  "src/components/meatspace/tabs/AlcoholTab.jsx|type=text|placeholder=New button name|value=buttonForm.name",
  "src/components/meatspace/tabs/AlcoholTab.jsx|type=number|placeholder=buttonVolumeUnit === 'oz' ? 'Oz' : 'mL'|value=buttonForm.oz|min=0.1|step=0.1|occurrence=2",
  "src/components/meatspace/tabs/AlcoholTab.jsx|type=number|placeholder=ABV%|value=buttonForm.abv|min=0|max=100|step=0.1|occurrence=2",
  "src/components/meatspace/tabs/AlcoholTab.jsx|type=number|placeholder=volumeUnit === 'oz' ? '12' : '355'|value=oz|min=0.1|step=0.1",
  "src/components/meatspace/tabs/AlcoholTab.jsx|type=date|value=editForm.date",
  "src/components/meatspace/tabs/AlcoholTab.jsx|type=text|value=editForm.name",
  "src/components/meatspace/tabs/AlcoholTab.jsx|type=number|value=editForm.oz|min=0.1|step=0.1",
  "src/components/meatspace/tabs/AlcoholTab.jsx|type=number|value=editForm.abv|min=0|max=100|step=0.1",
  "src/components/meatspace/tabs/AlcoholTab.jsx|type=number|value=editForm.count|min=1|max=100",
  "src/components/meatspace/tabs/GenomeTab.jsx|type=text|placeholder=rs1801133|value=searchRsid",
  "src/components/meatspace/tabs/LifestyleTab.jsx|type=range|value=lifestyle?.exerciseMinutesPerWeek ?? 150|min=0|max=600|step=15",
  "src/components/meatspace/tabs/LifestyleTab.jsx|type=range|value=lifestyle?.sleepHoursPerNight ?? 7.5|min=3|max=12|step=0.5",
  "src/components/meatspace/tabs/LifestyleTab.jsx|type=number|placeholder=e.g. 22.5|value=lifestyle?.bmi ?? ''|min=10|max=80|step=0.1",
  "src/components/meatspace/tabs/NicotineTab.jsx|type=text|placeholder=Name|value=buttonForm.name",
  "src/components/meatspace/tabs/NicotineTab.jsx|type=number|placeholder=mg|value=buttonForm.mgPerUnit|step=0.1|occurrence=1",
  "src/components/meatspace/tabs/NicotineTab.jsx|type=text|placeholder=New product name|value=buttonForm.name",
  "src/components/meatspace/tabs/NicotineTab.jsx|type=number|placeholder=mg|value=buttonForm.mgPerUnit|step=0.1|occurrence=2",
  "src/components/meatspace/tabs/NicotineTab.jsx|type=date|value=editForm.date",
  "src/components/meatspace/tabs/NicotineTab.jsx|type=text|value=editForm.product",
  "src/components/meatspace/tabs/NicotineTab.jsx|type=number|value=editForm.mgPerUnit|step=0.1",
  "src/components/meatspace/tabs/NicotineTab.jsx|type=number|value=editForm.count|min=1",
  "src/components/media/CollectionPickerShell.jsx|type=text|placeholder=searchPlaceholder|value=query",
  "src/components/media/CollectionPickerShell.jsx|type=text|placeholder=newCollectionPlaceholder|value=newName",
  "src/components/messages/InboxTab.jsx|type=text|placeholder=Search messages...|value=search",
  "src/components/music/AlbumsManager.jsx|placeholder=Album title|value=form.title",
  "src/components/music/AlbumsManager.jsx|placeholder=dream pop|value=form.genre",
  "src/components/music/AlbumsManager.jsx|type=number|placeholder=2026|value=form.releaseYear|min=ALBUM_RELEASE_YEAR_MIN|max=ALBUM_RELEASE_YEAR_MAX",
  "src/components/music/ArtistsManager.jsx|placeholder=Nova Vale|value=form.name",
  "src/components/music/ArtistsManager.jsx|placeholder=indie folk, dream pop|value=form.genre",
  "src/components/music/ArtistsManager.jsx|placeholder=/images/… or https://…|value=form.portraitImageUrl",
  "src/components/music/MusicGenPanel.jsx|placeholder=org/model-repo|value=installRepo",
  "src/components/music/TracksManager.jsx|placeholder=Track title|value=form.title",
  "src/components/pipeline/CanonCard.jsx|type=text|placeholder=Outfit name (e.g. Wedding)|value=draftFor('name')",
  "src/components/pipeline/arcCanvas/AddSeasonRow.jsx|placeholder=Volume / Season title…|value=title",
  "src/components/pipeline/arcCanvas/DeriveFromManuscriptPreview.jsx|placeholder=Volume title|value=volume.title",
  "src/components/pipeline/arcCanvas/SeasonActions.jsx|placeholder=Issue / Episode title…|value=newTitle",
  "src/components/pipeline/arcCanvas/SeasonEditor.jsx|placeholder=Title|value=draft.title || ''",
  "src/components/pipeline/arcCanvas/SeasonEditor.jsx|type=number|placeholder=#|value=draft.number || 0|min=0|max=99",
  "src/components/pipeline/arcCanvas/SeasonEditor.jsx|placeholder=One-sentence logline|value=draft.logline || ''",
  "src/components/pipeline/arcCanvas/SeasonEditor.jsx|placeholder=Ending hook|value=draft.endingHook || ''",
  "src/components/pipeline/arcCanvas/SeasonEditor.jsx|type=number|placeholder=Issue / episode target|value=draft.episodeCountTarget || 0|title=Issue / episode count target for this volume / season|min=0",
  "src/components/pipeline/arcCanvas/TickingClockEditor.jsx|id=ticking-clock-label|type=text|placeholder=What the reader counts down to (e.g. “The storm makes landfall”)|value=c.label || ''",
  "src/components/pipeline/stages/IdeaStage.jsx|type=text|placeholder=Your answer (optional — leave blank for LLM's choice)|value=answers[i] || ''",
  "src/components/pipeline/stages/StoryboardsStage.jsx|placeholder=INT. FOUNDRY — NIGHT|value=scene.slugline || ''",
  "src/components/pipeline/stages/StoryboardsStage.jsx|type=number|value=shot.durationSeconds ?? 4|title=Duration in seconds|min=1|max=30",
  "src/components/settings/VoiceTab.jsx|type=text|value=cfg.hotkey",
  "src/components/settings/VoiceTab.jsx|type=number|value=cfg.tts.rate ?? 1.0|min=0.5|max=2|step=0.1",
  "src/components/settings/VoiceTab.jsx|type=text|value=cfg.stt.endpoint",
  "src/components/settings/VoiceTab.jsx|type=text|value=cfg.llm.personality?.name ?? ''",
  "src/components/settings/VoiceTab.jsx|type=text|value=cfg.llm.personality?.role ?? ''",
  "src/components/settings/VoiceTab.jsx|type=text|value=cfg.llm.personality?.speechStyle ?? ''",
  "src/components/settings/VoiceTab.jsx|type=text|value=(cfg.llm.personality?.traits || []).join(', ')",
  "src/components/settings/VoiceTab.jsx|type=time|value=cfg.llm.proactive?.quietHours?.start || '22:00'",
  "src/components/settings/VoiceTab.jsx|type=time|value=cfg.llm.proactive?.quietHours?.end || '07:00'",
  "src/components/settings/VoiceTab.jsx|type=number|value=fastPathCfg.browser?.temperature ?? 0.7|min=0|max=2|step=0.1",
  "src/components/settings/VoiceTab.jsx|type=number|value=fastPathCfg.browser?.topK ?? 3|min=1|max=128|step=1",
  "src/components/sharing/DuplicateGroup.jsx|value=name",
  "src/components/shell/TerminalHotKeys.jsx|type=text|placeholder=Tap & paste here|ref=pasteInputRef",
  "src/components/universe/CharacterDetailEditor.jsx|type=text",
  "src/components/universeBuilder/CompositeSheetsEditor.jsx|placeholder=newKind === 'world_pitch_poster' ? 'World summary concept pitch poster' : 'Gas-Giant Drifters costume sheet'|value=newLabel",
  "src/components/universeBuilder/CompositeSheetsEditor.jsx|value=editLabel",
  "src/components/universeBuilder/InfluenceChipsInput.jsx|type=text|placeholder=placeholder|value=input",
  "src/components/universeBuilder/UniverseBibleTab.jsx|id=world-logline|type=text|placeholder=One-sentence hook — A foundry city goes silent, and the only survivor is a child.|value=draft.logline || ''",
  "src/components/universeBuilder/UniverseBuilderPage.jsx|type=text|placeholder=colonies, factions, species|value=newCategoryName",
  "src/components/universeBuilder/UniverseCategoryEditor.jsx|type=number|placeholder=Custom|value=genCustom|min=GENERATE_CUSTOM_MIN|max=GENERATE_CUSTOM_MAX",
  "src/components/universeBuilder/UniverseCategoryEditor.jsx|placeholder=Label (e.g. Crystalline canyon basin)|value=newLabel",
  "src/components/universeBuilder/UniverseCategoryEditor.jsx|value=editLabel",
  "src/components/universeBuilder/UniverseTrunkPanels.jsx|type=text|placeholder=trunk.kind === 'characters' ? 'heroes, villains, factions' : trunk.kind === 'places' ? 'colonies, ruins' : 'weapons, vehicles'|value=newBucketName",
  "src/components/voice/VoiceWidget.jsx|type=text|placeholder=Type a message…|value=draft",
  "src/components/wiki/tabs/SearchTab.jsx|placeholder=Search wiki pages and raw sources...|value=query|ref=inputRef",
  "src/components/writers-room/LibraryPane.jsx|placeholder=Folder name|value=folderName",
  "src/components/writers-room/LibraryPane.jsx|placeholder=Title|value=workTitle",
  "src/pages/AIProviders.jsx|type=isSecret ? 'password' : 'text'|value=value",
  "src/pages/AIProviders.jsx|type=text|placeholder=KEY|value=newEnvKey",
  "src/pages/AIProviders.jsx|type=newEnvSecret ? 'password' : 'text'|placeholder=value|value=newEnvValue",
  "src/pages/Authors.jsx|placeholder=Jane Doe|value=form.name",
  "src/pages/Authors.jsx|placeholder=/images/… or https://…|value=form.headshotImageUrl",
  "src/pages/MediaCollectionDetail.jsx|type=text|value=nameDraft",
  "src/components/meatspace/post/PostDrillConfig.jsx|type=number|value=drillConfig[field.key] ?? ''|min=field.min|max=field.max",
  "src/pages/AIProviders.jsx|type=text|placeholder=claude-sonnet-4-20250514|value=formData.defaultModel",
  "src/pages/AIProviders.jsx|type=text|placeholder=haiku|value=formData.lightModel",
  "src/pages/AIProviders.jsx|type=text|placeholder=sonnet|value=formData.mediumModel",
  "src/pages/AIProviders.jsx|type=text|placeholder=opus|value=formData.heavyModel",
  "src/pages/AIProviders.jsx|type=text|placeholder=Use fallback provider's default|value=formData.fallbackModel",
  "src/pages/StackerNews.jsx|id=`${prefix}-label`|value=form.label|occurrence=1",
  "src/pages/StackerNews.jsx|id=`${prefix}-label`|value=form.label|occurrence=2",
  "src/pages/StackerNews.jsx|id=`${prefix}-tone`|value=form.tone",
  "src/pages/StackerNews.jsx|id=`${prefix}-allowed`|value=form.allowedThemes",
  "src/pages/StackerNews.jsx|id=`${prefix}-disallowed`|value=form.disallowedThemes",
  "src/pages/StackerNews.jsx|id=`${prefix}-escalation`|value=form.escalationCues",
  "src/pages/StackerNews.jsx|id=action-title|value=draft.title",
  "src/pages/StackerNews.jsx|id=`${prefix}-${id}`|value=form[key]",
  "src/pages/StackerNews.jsx|id=`${prefix}-${id}`|type=number|value=form[key]|min=min|max=max",
  "src/pages/StackerNews.jsx|id=`${prefix}-label`|value=form.label",
  "src/pages/StackerNews.jsx|id=`${prefix}-username`|value=form.username",
  "src/pages/StackerNews.jsx|id=`${prefix}-api-key`|type=password|value=form.apiKey",
  "src/pages/StackerNews.jsx|id=`${prefix}-slug`|value=form.slug",
  "src/pages/VideoTimeline.jsx|type=text|placeholder=New project name…|value=name",
  "src/pages/DataDog.jsx|name=site|type=text|placeholder=e.g., api.custom-datadog.com|value=formData.site",
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
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
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
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
      const re = /<button\b/g;
      let m;
      while ((m = re.exec(src))) {
        const tag = openingTagAt(src, m.index, '<button'.length);
        if (!tag) continue;
        if (!/rounded-full/.test(tag) || !TRACK_SIZES.test(tag)) continue;
        if (/role="switch"/.test(tag)) continue;
        offenders.push(`${file}:${lineOf(src, m.index)}`);
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
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
      const re = /<input\b/g;
      let m;
      while ((m = re.exec(src))) {
        const tag = openingTagAt(src, m.index, '<input'.length);
        // Match against the whole opening tag, not a quoted-attribute-shaped
        // regex: `type='file'` / `type={'file'}` and a `hidden` arriving via a
        // template literal or ternary (`className={cond ? 'hidden' : ''}`) are
        // the same bug, and a quote-specific pattern waves them through.
        if (!tag || !/\btype\s*=\s*[{'"]*\s*['"]?file\b/.test(tag)) continue;
        const hidden = /\bhidden\b/.test(tag) || /display:\s*['"]?none/.test(tag);
        const ariaHidden = /aria-hidden/.test(tag);
        const untabbable = /tabIndex\s*=\s*\{\s*-1\s*\}/.test(tag);
        if (!hidden && !ariaHidden && !untabbable) continue;
        offenders.push(`${file}:${lineOf(src, m.index)}`);
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
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
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
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
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
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
      const re = /<button\b/g;
      let m;
      while ((m = re.exec(src))) {
        const tag = openingTagAt(src, m.index, '<button'.length);
        if (!tag || !/role="switch"/.test(tag)) continue;
        if (/aria-checked/.test(tag)) continue;
        offenders.push(`${file}:${lineOf(src, m.index)}`);
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
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
      const re = /<button\b/g;
      let m;
      while ((m = re.exec(src))) {
        const tag = openingTagAt(src, m.index, '<button'.length);
        if (!tag || tag.endsWith('/>')) continue; // self-closing — no body to judge
        if (/\baria-label\s*=/.test(tag) || /\baria-labelledby\s*=/.test(tag)) continue;
        const openEnd = m.index + tag.length;
        const body = findButtonBody(src, openEnd);
        if (body === null || !isIconOnlyBody(body)) continue;
        offenders.push(`${file}:${lineOf(src, m.index)}`);
      }
    }
    expect(offenders, `Icon-only <button> with no aria-label/aria-labelledby — title alone isn't touch-discoverable and isn't reliably read as the accessible name; see media/MediaCard.jsx's Annotate button for the convention:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('gives every input an accessible name', () => {
    // These controls live in compact peer-management rows where visible labels
    // would break the layout. Keep explicit names on each input so placeholders
    // never become their only screen-reader context.
    const offenders = [];
    for (const file of trackedJsxFiles()) {
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
      const scanSrc = maskComments(src);
      const re = /<input\b/g;
      let m;
      while ((m = re.exec(scanSrc))) {
        const tag = openingTagAt(scanSrc, m.index, '<input'.length);
        const location = inputSourceAnchor(file, scanSrc, m.index);
        if (!tag || hasAccessibleInputName(scanSrc, tag, m.index) || PREEXISTING_INPUT_NAME_ALLOWLIST.has(location)) continue;
        offenders.push(location);
      }
    }
    expect(offenders, `Input without an accessible name — add aria-label/aria-labelledby or an explicit/implicit <label>, or exclude type="hidden":\n${offenders.join('\n')}`).toEqual([]);
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
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
      const re = /<button\b/g;
      let m;
      while ((m = re.exec(src))) {
        const tag = openingTagAt(src, m.index, '<button'.length);
        if (!tag || !CLOSE_LABEL_RE.test(tag)) continue;
        if (/\binset-0\b/.test(tag)) continue;
        const clsMatch = tag.match(/className\s*=\s*"([^"]*)"/);
        if (!clsMatch) continue; // dynamic className — reviewed by hand, not scanned here
        if (hasFortyFourMinTouchTarget(clsMatch[1])) continue;
        offenders.push(`${file}:${lineOf(src, m.index)}`);
      }
    }
    expect(offenders, `Close button under the 44px touch-target minimum — add min-h-[44px] min-w-[44px] + flex items-center justify-center (see Drawer.jsx:106):\n${offenders.join('\n')}`).toEqual([]);
  });
});
