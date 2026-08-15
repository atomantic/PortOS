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
  // remaining stack entry for JSX text. Each entry also parks the enclosing
  // `braceDepth`: an element rendered from inside an expression
  // (`{list.map((x) => <option>{x.name}</option>)}`) has expression braces open
  // around it, and its own `{x.name}` would otherwise close them — leaving the
  // lexer in `code` mode where the following `</select>` reads as a
  // less-than, never pops, and strands the rest of the file in `jsx-text`.
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
        braceDepth = entry?.braceDepth ?? 0;
        mode = entry?.root ? 'code' : (jsxStack.length ? 'jsx-text' : 'code');
      } else if (selfClosing) {
        mode = tagParentMode;
      } else {
        jsxStack.push({ name: tagInfo.fragment ? null : tagInfo.name, root: tagParentMode === 'code', braceDepth });
        braceDepth = 0;
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
  return hasMatchingForwardedLabel(src, id);
}

// A `label` prop only names something when it carries text. Every literal that
// React renders as nothing has to be rejected, `true` included: `<Field label>`
// and `label={true}` are the same prop value, and `<label>{true}</label>` puts
// no text in the DOM. Reading it as a name would exempt a control that has none.
function isUsableLabelAttributeValue(value) {
  return Boolean(value) && !/^(?:undefined|null|false|true)$/i.test(value);
}

// A page-local field wrapper can own the <label> AND take the control's id as a
// prop instead of wrapping it (LifestyleTab.jsx's `<FieldGroup label="Sleep …"
// htmlFor="lifestyle-sleep-hours">`). Wrapping is wrong there — an implicit
// <label> would swallow the live value readout and the hint paragraph sitting
// beside the control into the accessible name — so the control is explicitly
// labeled, just not by a `<label htmlFor>` written at the call site. Recognise
// those forwarders the same way and under the same limits as
// localLabelWrapperNames: same-file `function` declarations only, so a missed
// one is a false negative that leaves its controls on the allowlist.
//
// The two prop names are read out of the wrapper rather than hardcoded: the
// forwarded id arrives as `htmlFor` in LifestyleTab's `FieldGroup` but as `id`
// in StackerNews's `Field({ id, label, children })`, and both name their
// control just as well. Hardcoding `htmlFor` left the second shape's controls
// looking unnamed.
//
// Both helpers below read whatever source they are handed. The input scan hands
// them `maskComments(src)`, which is what keeps a commented-out wrapper — or a
// commented-out call site — from registering; same as localLabelWrapperNames.
const htmlForForwardersBySource = new Map();

function localHtmlForForwarders(src) {
  const cached = htmlForForwardersBySource.get(src);
  if (cached) return cached;
  const forwarders = new Map();
  forEachLocalComponent(src, (name, body, params) => {
    // The <label> has to do both jobs before the call site's attributes can be
    // trusted: point at one prop, and render another prop as its own text. A
    // component that forwards the id onto a <label> it never fills with text
    // names nothing.
    const shape = /<label\b[^>]*\bhtmlFor\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*\}(?:[^>]*[^/>])?>(?:(?!<\/label>)[\s\S])*?\{\s*([A-Za-z_$][\w$]*)\s*\}/.exec(body);
    if (!shape) return;
    const [, idProp, labelProp] = shape;
    // Both names must be parameters of this component. A <label> pointed at a
    // module-level constant forwards nothing from the call site, so reading the
    // call site's same-named attribute would exempt an unrelated control.
    const parameterNames = new Set(params.match(/[A-Za-z_$][\w$]*/g));
    if (!parameterNames.has(idProp) || !parameterNames.has(labelProp)) return;
    forwarders.set(name, { idProp, labelProp });
  });
  htmlForForwardersBySource.set(src, forwarders);
  return forwarders;
}

function hasMatchingForwardedLabel(src, id) {
  for (const [name, { idProp, labelProp }] of localHtmlForForwarders(src)) {
    const re = new RegExp(`<${name}\\b`, 'g');
    let match;
    while ((match = re.exec(src))) {
      const tag = openingTagAt(src, match.index, name.length + 1);
      if (!tag) continue;
      re.lastIndex = match.index + tag.length;
      if (normalizedAttributeValue(attributeValue(tag, idProp)) !== id) continue;
      // A forwarder can take its text as JSX children rather than a prop
      // (`<FieldLabel htmlFor="world-logline">Logline</FieldLabel>`), in which
      // case there is no same-named attribute to read — the name is the
      // element's own body, judged by the same text check the aria-labelledby
      // path uses. Without this branch every children-shaped forwarder looked
      // unnamed and its controls stayed on the allowlist.
      if (labelProp === 'children') {
        if (hasUsableElementText(src, match.index, tag)) return true;
        continue;
      }
      if (isUsableLabelAttributeValue(normalizedAttributeValue(attributeValue(tag, labelProp)))) return true;
    }
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

function isDirectElementInExpression(src, start, index) {
  if (isEnclosedInListCall(src, start, index)) return false;
  let depth = 0;
  let cursor = start;
  while (cursor < index) {
    // Only an element start matters here; a bare `<` is a comparison operator
    // (`{count < 3 ? <input/> : null}`) and must not open a phantom element.
    if (src[cursor] !== '<' || !/^<\/?[A-Za-z]/.test(src.slice(cursor, cursor + 3))) {
      cursor++;
      continue;
    }
    if (src.startsWith('</', cursor)) {
      const close = src.indexOf('>', cursor);
      if (close === -1) return false;
      if (depth > 0) depth--;
      cursor = close + 1;
      continue;
    }
    const tag = tagBoundaryAt(src, cursor);
    if (!tag) return false;
    if (!tag.selfClosing) depth++;
    cursor = tag.end;
  }
  return depth === 0;
}

// The other two recognizers read a wrapper's own source before trusting it.
// This one cannot — FormField is imported, not declared here — so at minimum
// require that the name really is the shared component. Without the check a
// file that declares or imports its own `FormField` exempts every control
// under it, and that is the guard's widest exemption by far.
// Matches every specifier the tree actually uses — `../ui/FormField`,
// `../components/ui/FormField`, the one `.jsx`-suffixed import, and
// `./FormField` from inside components/ui itself.
function importsSharedFormField(src) {
  return /\bfrom\s+['"](?:[^'"]*\/)?(?:ui\/)?FormField(?:\.jsx?)?['"]/.test(src);
}

function isNestedInLabeledFormField(src, index) {
  if (!importsSharedFormField(src)) return false;
  const formRe = /<FormField\b/g;
  let formMatch;
  while ((formMatch = formRe.exec(src)) && formMatch.index < index) {
    const formTag = openingTagAt(src, formMatch.index, '<FormField'.length);
    if (!formTag || /\/\s*>$/.test(formTag)) continue;
    const label = normalizedAttributeValue(attributeValue(formTag, 'label'));
    if (!isUsableLabelAttributeValue(label)) continue;

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
        if (end === -1) break;
        if (end >= index) {
          // The control lives inside this expression rather than after it.
          if (depth === 0 && firstChild === null && isDirectElementInExpression(src, cursor + 1, index)) return true;
          break;
        }
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
    // `#control` rather than `'input'`: `firstChild` otherwise holds a real tag
    // name, so a control preceded by a literal `<input>` sibling would read as
    // "the control IS the first child" and be credited by a wrapper that never
    // named it. Harmless while the scan only ever asked about `<input>`; a live
    // bypass now that a `<select>` can follow one.
    if (!closed && depth === 0 && firstChild === null && cursor === index) firstChild = '#control';
    // FormField clones only its first React child. The current control is named
    // by the wrapper only when it is that first, direct child; a later control
    // (DataDog's optional custom-site input) must remain actionable here.
    if (!closed && depth === 0 && firstChild === '#control') return true;
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
// Both wrapper recognizers below need the same three things out of a same-file
// component — its name, its body, and (for one of them) its parameter list —
// so they walk
// declarations through this one iterator rather than each re-deriving the
// boundaries. Only `function` declarations are matched; an arrow-function
// component stays invisible, which is a false negative that simply leaves its
// controls on the allowlist (tracked in #4317).
function forEachLocalComponent(src, visit) {
  const re = /function\s+([A-Z][\w]*)\s*\(/g;
  let match;
  while ((match = re.exec(src))) {
    // Skip the parameter list with the string-aware scanner — a default value
    // like `{ label = ')' }` would close the parens early on a naive count and
    // point `bodyStart` at the destructuring instead of the body.
    const parenIndex = match.index + match[0].length - 1;
    const params = balancedCallAt(src, parenIndex);
    if (!params) continue;
    const bodyStart = src.indexOf('{', parenIndex + params.length);
    if (bodyStart === -1) continue;
    const bodyEnd = matchingBraceEnd(src, bodyStart);
    if (bodyEnd === -1) continue;
    visit(match[1], src.slice(bodyStart, bodyEnd), params);
  }
}

const labelWrapperNamesBySource = new Map();

function localLabelWrapperNames(src) {
  const cached = labelWrapperNamesBySource.get(src);
  if (cached) return cached;
  const names = new Set();
  forEachLocalComponent(src, (name, body) => {
    // {children} must sit inside a <label> — no </label> may intervene, or a
    // component rendering `<label>Header</label>{children}<label>Footer</label>`
    // would register as a wrapper and exempt controls it never labels. The
    // opening tag must also not be self-closing (`<label … />` wraps nothing,
    // so anything after it is outside the label).
    if (/<label\b(?:[^>]*[^/>])?>(?:(?!<\/label>)[\s\S])*?\{\s*children\s*\}/.test(body)) names.add(name);
  });
  labelWrapperNamesBySource.set(src, names);
  return names;
}

function isNestedInLabelWrappingComponent(src, index) {
  for (const name of localLabelWrapperNames(src)) {
    const re = new RegExp(`</?${name}\\b`, 'g');
    // Keep the label of every wrapper instance still open at `index`, not just
    // the outermost: an inner `<Field label="…">` nested in an unlabeled outer
    // one still names the control.
    const open = [];
    let match;
    while ((match = re.exec(src)) && match.index < index) {
      if (match[0].startsWith('</')) {
        open.pop();
        continue;
      }
      const tag = openingTagAt(src, match.index, name.length + 1);
      if (!tag) continue;
      re.lastIndex = match.index + tag.length;
      if (/\/\s*>$/.test(tag)) continue;
      open.push(normalizedAttributeValue(attributeValue(tag, 'label')));
    }
    if (open.some(isUsableLabelAttributeValue)) return true;
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

// `type`-derived names are an <input>-only affordance: a submit button names
// itself from `value`, an image button from `alt`, and a hidden input is not in
// the a11y tree at all. <select> and <textarea> have no such escape hatch, so
// the caller passes the tag name rather than this reading `type` off anything
// that happens to carry one.
function hasAccessibleControlName(src, tag, index, tagName) {
  if (hasUsableAccessibleNameAttribute(tag, 'aria-label')) return true;
  if (hasUsableAccessibleNameAttribute(tag, 'aria-labelledby') && hasUsableAriaLabelledByReference(src, tag)) return true;
  if (tagName === 'input' && hasUsableNativeInputName(tag)) return true;
  if (isNestedInLabel(src, index) || isNestedInLabeledFormField(src, index)) return true;
  if (isNestedInLabelWrappingComponent(src, index)) return true;

  const id = normalizedAttributeValue(attributeValue(tag, 'id'));
  return id !== null && id !== '' && hasMatchingExplicitLabel(src, id);
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

const controlTagRe = (tagName) => new RegExp(`<${tagName}\\b`, 'g');

function controlSourceAnchor(file, src, index, tagName) {
  const nameLength = tagName.length + 1;
  const tag = openingTagAt(src, index, nameLength);
  if (!tag) return `${file}|${tagName}|unknown`;
  const semantic = controlSemanticAnchor(tag);
  const matching = [];
  for (const match of src.matchAll(controlTagRe(tagName))) {
    const otherTag = openingTagAt(src, match.index, nameLength);
    if (otherTag && controlSemanticAnchor(otherTag) === semantic) matching.push(match.index);
  }
  const base = `${file}|${tagName}|${semantic}`;
  if (matching.length === 1) return base;
  return `${base}|occurrence=${matching.indexOf(index) + 1}`;
}

// These are pre-existing controls exposed when the rule was generalized; the
// migration is tracked in #4297. What is left is no longer a backlog of unnamed
// controls — all three are shapes the scan cannot resolve, not gaps in the UI:
//   * EntityCombobox / TagPicker take the control's `id` as a prop and every
//     caller pairs its own `<label htmlFor>`, which lives in the caller's file.
//     A same-file scan cannot see it, and an `aria-label` here would OVERRIDE
//     the caller's visible label — a regression, not a fix. Tracked in #4321.
//   * AIProviders' fallback-model input sits in a labeled `<FormField>` whose
//     conditional child holds an apostrophe in JSX text; `matchingBraceEnd`
//     reads it as a string opener and loses the expression bounds (#4318).
// So: do not "fix" these by bolting an aria-label onto the control. Fix the
// recognizer, then delete the row.
const PREEXISTING_INPUT_NAME_ALLOWLIST = new Set([
  "src/components/EntityCombobox.jsx|input|id=inputId|type=text|placeholder=placeholder || `Search ${noun}s or type a new name…`|value=value|role=combobox",
  "src/components/TagPicker.jsx|input|id=id|type=text|placeholder=value.length >= maxTags ? `Max ${maxTags} tags` : placeholder|value=input",
  "src/pages/AIProviders.jsx|input|type=text|placeholder=Use fallback provider's default|value=formData.fallbackModel",
]);

// The <select>/<textarea> half of the same rule, seeded when #4309 widened the
// scan past <input>. Unlike the list above this one IS a live backlog: every
// row is a real dropdown or free-text box a screen reader announces with no
// name. It only shrinks — name the control (a paired `<label htmlFor>` first,
// `aria-label` only where a visible label would break the layout), then delete
// its row. Burn-down tracked in #4309.
const PREEXISTING_SELECT_TEXTAREA_NAME_ALLOWLIST = new Set([
  "src/components/agents/tabs/ActivityTab.jsx|select|value=actionFilter",
  "src/components/agents/tabs/OverviewTab.jsx|select|value=fnConfig.model || ''",
  "src/components/agents/tabs/OverviewTab.jsx|select|value=fnConfig.providerId || ''",
  "src/components/agents/tabs/PublishedTab.jsx|select|value=publishedDays",
  "src/components/agents/tabs/ToolsTab.jsx|select|value=feedSort",
  "src/components/agents/tabs/ToolsTab.jsx|select|value=selectedSubmolt",
  "src/components/agents/tabs/ToolsTab.jsx|textarea|placeholder=Comment content (markdown)...|value=commentContent|rows=4",
  "src/components/agents/tabs/ToolsTab.jsx|textarea|placeholder=Post content (markdown)...|value=postContent|rows=6",
  "src/components/agents/tabs/WorldTab.jsx|select|value=blockType",
  "src/components/agents/tabs/WorldTab.jsx|select|value=buildAction",
  "src/components/agents/tabs/WorldTab.jsx|select|value=historyFilter",
  "src/components/agents/tabs/WorldTab.jsx|select|value=newActionType",
  "src/components/apps/ReferenceReposPanel.jsx|textarea|placeholder=Notes — what features in our app use this repo? (Helps the watch agent prioritize.)|value=form.notes|rows=3",
  "src/components/apps/ReferenceReposPanel.jsx|textarea|placeholder=What features rely on this repo? The watch agent reads this to know which commits matter.|value=notesDraft|rows=4",
  "src/components/apps/tabs/AutomationTab.jsx|select|value=cronEditing[taskType] !== undefined || isCronExpression(overrideInterval) ? 'cron' : (overrideInterval ?? 'null')",
  "src/components/apps/tabs/CustomTasksSection.jsx|select|value=form.autonomyLevel",
  "src/components/apps/tabs/CustomTasksSection.jsx|select|value=form.interval",
  "src/components/apps/tabs/CustomTasksSection.jsx|select|value=form.priority",
  "src/components/apps/tabs/DocumentsTab.jsx|textarea|value=editContent",
  "src/components/brain/tabs/DailyLogTab.jsx|textarea|placeholder=isToday ? \"What's on your mind today? Type freely, append voice segments, or toggle dictation above…\" : 'This day\\'s entry is empty.'|value=content|ref=editorRef",
  "src/components/brain/tabs/FeedsTab.jsx|select|value=selectedFeedId || ''",
  "src/components/brain/tabs/InboxTab.jsx|select|value=fixDestination|title=Select new destination",
  "src/components/brain/tabs/InboxTab.jsx|textarea|value=editText|rows=3|occurrence=1",
  "src/components/brain/tabs/InboxTab.jsx|textarea|value=editText|rows=3|occurrence=2",
  "src/components/brain/tabs/LinksTab.jsx|select|value=editForm.linkType",
  "src/components/brain/tabs/LinksTab.jsx|textarea|placeholder=Description (optional)|value=editForm.description|rows=2",
  "src/components/brain/tabs/NotesTab.jsx|select|value=selectedVaultId || ''",
  "src/components/brain/tabs/NotesTab.jsx|textarea|value=noteContent|ref=editorRef",
  "src/components/brain/tabs/TrustTab.jsx|select|value=statusFilter",
  "src/components/calendar/AgendaTab.jsx|select|value=accountFilter",
  "src/components/calendar/ConfigTab.jsx|select|value=account.syncMethod || 'claude-mcp'",
  "src/components/calendar/ReviewTab.jsx|select|value=editForm.goalId",
  "src/components/cos/tabs/BriefingTab.jsx|select|value=selectedDate || ''",
  "src/components/cos/tabs/DigestTab.jsx|select|value=selectedWeek || currentDigest?.weekId || ''",
  "src/components/cos/tabs/JobsTab.jsx|select|value=data.interval",
  "src/components/cos/tabs/JobsTab.jsx|select|value=editData.appId || ''",
  "src/components/cos/tabs/JobsTab.jsx|select|value=editData.autonomyLevel",
  "src/components/cos/tabs/JobsTab.jsx|select|value=editData.priority",
  "src/components/cos/tabs/JobsTab.jsx|select|value=editData.triggerAction",
  "src/components/cos/tabs/JobsTab.jsx|select|value=editData.type",
  "src/components/cos/tabs/JobsTab.jsx|select|value=newJob.appId || ''",
  "src/components/cos/tabs/JobsTab.jsx|select|value=newJob.autonomyLevel",
  "src/components/cos/tabs/JobsTab.jsx|select|value=newJob.priority",
  "src/components/cos/tabs/JobsTab.jsx|select|value=newJob.triggerAction",
  "src/components/cos/tabs/JobsTab.jsx|textarea|placeholder=Prompt template for the agent *|value=newJob.promptTemplate",
  "src/components/cos/tabs/JobsTab.jsx|textarea|placeholder=Prompt template for the agent|value=editData.promptTemplate",
  "src/components/cos/tabs/JobsTab.jsx|textarea|placeholder=Shell command *|value=newJob.command",
  "src/components/cos/tabs/JobsTab.jsx|textarea|placeholder=Shell command|value=editData.command",
  "src/components/cos/tabs/TaskItem.jsx|select|value=editData.model",
  "src/components/cos/tabs/TaskItem.jsx|select|value=editData.provider",
  "src/components/cos/tabs/schedule/AppOverrideRow.jsx|select|value=cronEditing || hasCron ? 'cron' : (currentInterval || '')",
  "src/components/cos/tabs/schedule/PromptEditor.jsx|textarea|placeholder=Enter task prompt|value=promptValue|rows=12",
  "src/components/digital-twin/ListEnrichment.jsx|textarea|value=documentContent|rows=15",
  "src/components/digital-twin/NextActionBanner.jsx|textarea|placeholder=Type your answer...|value=answer|rows=3",
  "src/components/digital-twin/tabs/AutobiographyTab.jsx|textarea|placeholder=Start writing your story... Take about 5 minutes.|value=storyContent",
  "src/components/digital-twin/tabs/AutobiographyTab.jsx|textarea|value=editContent",
  "src/components/digital-twin/tabs/DocumentsTab.jsx|textarea|placeholder=Write your soul document here...|value=editContent",
  "src/components/digital-twin/tabs/EnrichTab.jsx|textarea|placeholder=Type your answer here...|value=answer|rows=6",
  "src/components/digital-twin/tabs/EnrichTab.jsx|textarea|placeholder=`Paste writing sample ${index + 1} here (emails, messages, docs)...`|value=sample.value|rows=4",
  "src/components/digital-twin/tabs/InterviewTab.jsx|textarea|placeholder=Paste your personality assessment here (from ChatGPT, Claude, etc.)...|value=content|rows=8",
  "src/components/digital-twin/tabs/OverviewTab.jsx|select|value=selectedProvider ? `${selectedProvider.providerId}:${selectedProvider.model}` : ''",
  "src/components/digital-twin/tabs/TasteTab.jsx|select|value=selectedProvider ? `${selectedProvider.providerId}:${selectedProvider.model}` : ''",
  "src/components/digital-twin/tabs/TasteTab.jsx|textarea|placeholder=Share your thoughts... be as specific as possible.|value=answer|rows=6",
  "src/components/goals/GoalLinkedActivities.jsx|select|value=selectedActivity",
  "src/components/goals/GoalsListView.jsx|select|value=newGoal.category",
  "src/components/goals/GoalsListView.jsx|select|value=newGoal.horizon",
  "src/components/gsd/GsdDocumentsPanel.jsx|textarea|value=editContent",
  "src/components/meatspace/EpigeneticTracker.jsx|select|value=customForm.category",
  "src/components/meatspace/EpigeneticTracker.jsx|select|value=customForm.frequency",
  "src/components/meatspace/post/MemoryPractice.jsx|textarea|placeholder=Type the line...|value=answer|ref=inputRef|rows=2",
  "src/components/meatspace/post/MemoryPractice.jsx|textarea|placeholder=Type the next line...|value=answer|ref=inputRef|rows=2",
  "src/components/meatspace/post/PostLlmDrillRunner.jsx|textarea|placeholder=placeholder|value=value|ref=inputRef|rows=3",
  "src/components/meatspace/post/WordplayDrillUI.jsx|textarea|placeholder=Write a sentence using both meanings...|value=inputValue|ref=inputRef|rows=3",
  "src/components/meatspace/post/WordplayDrillUI.jsx|textarea|placeholder=Your twisted idiom...|value=inputValue|ref=inputRef|rows=3",
  "src/components/meatspace/tabs/GenomeTab.jsx|select|value=clinvarStarFilter",
  "src/components/media/MediaLightbox.jsx|textarea|placeholder=Add a note — use this for cover, reshoot at 24fps, etc.|value=noteDraft|rows=3",
  "src/components/media/PromptFromMedia.jsx|textarea|value=value|rows=4",
  "src/components/messages/InboxTab.jsx|select|value=selectedAccount",
  "src/components/music/ArtistPicker.jsx|select|id=id|value=value || ''",
  "src/components/musicVideo/SceneCard.jsx|textarea|placeholder=Reference frame prompt — the still that seeds this shot (defaults to the shot prompt)|value=scene.framePrompt || ''|rows=2",
  "src/components/musicVideo/SceneCard.jsx|textarea|placeholder=Shot prompt — what this scene's video should show|value=scene.prompt || ''|rows=2",
  "src/components/pipeline/AuthorPicker.jsx|select|id=id|value=value || ''",
  "src/components/pipeline/CanonCard.jsx|textarea|placeholder=What's the character wearing? (image-gen-ready prose)|value=draftFor('description')|rows=2",
  "src/components/pipeline/CanonCard.jsx|textarea|placeholder=placeholder|value=draft.value|rows=3",
  "src/components/pipeline/arcCanvas/ArcContent.jsx|textarea|placeholder=Multi-volume / multi-season summary (~500 words)|value=draft.summary || ''|rows=6",
  "src/components/pipeline/arcCanvas/ArcContent.jsx|textarea|placeholder=One-sentence whole-arc pitch|value=draft.logline || ''|rows=2",
  "src/components/pipeline/arcCanvas/ArcContent.jsx|textarea|placeholder=Protagonist arc across all volumes / seasons|value=draft.protagonistArc || ''|rows=3",
  "src/components/pipeline/arcCanvas/IssueRow.jsx|select|value=issue.seasonId || ''|title=Move to a different season",
  "src/components/pipeline/arcCanvas/SeasonEditor.jsx|select|value=draft.status || 'draft'",
  "src/components/pipeline/arcCanvas/SeasonEditor.jsx|textarea|placeholder=Season synopsis (~200 words)|value=draft.synopsis || ''|rows=4",
  "src/components/pipeline/arcCanvas/TickingClockEditor.jsx|textarea|id=ticking-clock-stakes|placeholder=Stakes — what happens if the clock runs out|value=c.stakes || ''|rows=2",
  "src/components/pipeline/arcCanvas/VolumeCoverEditorBox.jsx|textarea|placeholder=placeholder|value=draft|rows=3",
  "src/components/pipeline/manuscript/AnnotatedManuscriptSection.jsx|textarea|value=content|rows=rowsFor(content)",
  "src/components/pipeline/manuscript/ManuscriptLiveSection.jsx|textarea|value=content|ref=(el) => { taRef.current = el; }|rows=rowsFor(content)",
  "src/components/pipeline/stages/AudioStage.jsx|textarea|value=textValue|rows=2",
  "src/components/pipeline/stages/ComicPagesStage.jsx|textarea|placeholder=Panel subject: wide shot, foundry crucible, dusk light, Lina silhouetted against the glow.|value=panel.description || ''|rows=2",
  "src/components/pipeline/stages/ComicScriptStage.jsx|textarea|placeholder=Back cover concept — illustration only. No text, no masthead. A quiet companion image: a single object, an aftermath beat, a distant silhouette.|value=draftBackCoverScript|rows=3",
  "src/components/pipeline/stages/ComicScriptStage.jsx|textarea|placeholder=Cover concept — describe the hero image, mood, lighting, framing. Series masthead and issue-number tag included in the prompt automatically.|value=draftCoverScript|rows=3",
  "src/components/pipeline/stages/ComicScriptStage.jsx|textarea|placeholder=`## Page ${pageIndex + 1}\\n\\n### Panel 1\\n**Description:** ...`|value=draft|rows=18",
  "src/components/pipeline/stages/StoryboardsStage.jsx|textarea|placeholder=One camera setup. Subject + framing + motion + mood.|value=shot.description || ''|rows=2",
  "src/components/pipeline/stages/StoryboardsStage.jsx|textarea|placeholder=Subject + framing + mood. The series style notes are prepended automatically.|value=scene.description || ''|rows=3",
  "src/components/pipeline/stages/VisualGenSettings.jsx|select|value=cfg.imageModelId || ''",
  "src/components/settings/VoiceTab.jsx|select|value=activeVoice || ''",
  "src/components/ui/AutoSizeTextarea.jsx|textarea|value=value|ref=ref",
  "src/components/ui/ProseEditor.jsx|textarea|placeholder=placeholder|value=value|ref=ref",
  "src/components/universeBuilder/CompositeSheetsEditor.jsx|select|value=editKind",
  "src/components/universeBuilder/CompositeSheetsEditor.jsx|select|value=newKind",
  "src/components/universeBuilder/CompositeSheetsEditor.jsx|textarea|placeholder=newKind === 'world_pitch_poster' ? 'Create a cinematic world summary concept pitch poster with a hero panorama, inset environments, cultures, creatures, visual language, palette, materials, and theme icons...' : 'Create a clean illustrated costume reference sheet...'|value=newPrompt|rows=6",
  "src/components/universeBuilder/CompositeSheetsEditor.jsx|textarea|value=editPrompt|rows=8",
  "src/components/universeBuilder/UniverseBibleTab.jsx|textarea|placeholder=moebius and scavengers reign meets Prophet inspired sci fi universe|value=draft.starterPrompt|rows=2",
  "src/components/universeBuilder/UniverseCategoryEditor.jsx|textarea|placeholder=Prompt fragment (subject only)|value=newPrompt|rows=2",
  "src/components/universeBuilder/UniverseCategoryEditor.jsx|textarea|value=editPrompt|rows=3",
  "src/components/wiki/tabs/BrowseTab.jsx|textarea|value=noteContent|ref=editorRef",
  "src/components/writers-room/ExercisePanel.jsx|textarea|placeholder=Just write…|value=text",
  "src/components/writers-room/LibraryPane.jsx|select|value=workKind",
  "src/components/writers-room/StagePromptModelPicker.jsx|select|value=stage.model || 'default'",
  "src/components/writers-room/StoryboardConfigTab.jsx|select|value=value.presetId",
  "src/pages/AIProviders.jsx|select|value=activeProviderId || ''",
  "src/pages/AIProviders.jsx|select|value=formData.fallbackModel",
  "src/pages/AIProviders.jsx|select|value=selectedWorkspace",
  "src/pages/AIProviders.jsx|textarea|placeholder=Enter your prompt...|value=runPrompt|rows=3",
  "src/pages/Ask.jsx|select|id=e.target.value;",
  "src/pages/Ask.jsx|textarea|placeholder=mode === 'draft' ? 'Describe what you want drafted (recipient, tone, key points)…' : 'Ask yourself anything…'|value=question|rows=2",
  "src/pages/Importer.jsx|textarea|id=`iss-${idx}-prose`|value=issue.proseExcerpt || ''",
  "src/pages/JiraReports.jsx|select|value=filterAppId",
  "src/pages/Loops.jsx|textarea|placeholder=What should this loop do? e.g., check if the deployment finished and report status|value=prompt|rows=2",
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
      const scanSrc = maskComments(readFileSync(join(CLIENT_ROOT, file), 'utf8'));
      const re = controlTagRe(tagName);
      let m;
      while ((m = re.exec(scanSrc))) {
        const tag = openingTagAt(scanSrc, m.index, tagName.length + 1);
        if (!tag || hasAccessibleControlName(scanSrc, tag, m.index, tagName)) continue;
        anchors.add(controlSourceAnchor(file, scanSrc, m.index, tagName));
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

  it('reads a name for <select>/<textarea> from every escape hatch, and from nothing else', () => {
    // The rules above are only honest if the recognizer really rejects a bare
    // control. Probe each direction on the two tags #4309 added: without this
    // the whole widening could be vacuous (every control "named", allowlist
    // never shrinking because nothing was ever unnamed).
    const isNamed = (src, tagName) => {
      const index = src.indexOf(`<${tagName}`);
      return hasAccessibleControlName(src, openingTagAt(src, index, tagName.length + 1), index, tagName);
    };

    expect(isNamed('<select value={sort}><option>a</option></select>', 'select')).toBe(false);
    expect(isNamed('<textarea value={notes} rows={3} />', 'textarea')).toBe(false);

    expect(isNamed('<select aria-label="Sort by" value={sort} />', 'select')).toBe(true);
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

    expect(hasMatchingExplicitLabel(`${forwarder}\n${namedCall}`, 'sleep-hours')).toBe(true);
    expect(hasMatchingExplicitLabel(`${forwarder}\n${unnamedCall}`, 'sleep-hours')).toBe(false);
    expect(hasMatchingExplicitLabel(`${emptyForwarder}\n${namedCall}`, 'sleep-hours')).toBe(false);
    // A different id on the same wrapper must not be swept up either.
    expect(hasMatchingExplicitLabel(`${forwarder}\n${namedCall}`, 'other-id')).toBe(false);
    // `label` with no value is `label={true}`, which renders no text.
    expect(hasMatchingExplicitLabel(`${forwarder}\n${namedCall.replace('label="Sleep"', 'label={true}')}`, 'sleep-hours')).toBe(false);
    // The scan masks comments before any of this runs, so a commented-out
    // wrapper must not register as one. Probe the source the way the scan
    // hands it over, or this helper looks safe for the wrong reason.
    const commentedForwarder = `function Group({ label, htmlFor, children }) {
  // <label htmlFor={htmlFor}>{label}</label>
  return <div>{children}</div>;
}`;
    expect(hasMatchingExplicitLabel(maskComments(`${commentedForwarder}\n${namedCall}`), 'sleep-hours')).toBe(false);

    // The forwarded prop does not have to be called `htmlFor` — StackerNews's
    // `Field({ id, label })` does the same job through `id`. Both halves stay
    // required, and the id must still be read from the prop the wrapper
    // actually forwards, not from any attribute that happens to be present.
    const idPropForwarder = forwarder.replace('label, htmlFor, children', 'id, label, children').replace('htmlFor={htmlFor}', 'htmlFor={id}');
    const idPropCall = `<Group id="sleep-hours" label="Sleep"><input id="sleep-hours" type="range" /></Group>`;
    expect(hasMatchingExplicitLabel(`${idPropForwarder}\n${idPropCall}`, 'sleep-hours')).toBe(true);
    expect(hasMatchingExplicitLabel(`${idPropForwarder}\n${idPropCall.replace(' label="Sleep"', '')}`, 'sleep-hours')).toBe(false);
    // `htmlFor=` on the call site is not the forwarded prop here, so it must
    // not stand in for the `id` this wrapper reads.
    expect(hasMatchingExplicitLabel(`${idPropForwarder}\n${idPropCall.replace('id="sleep-hours" label', 'htmlFor="sleep-hours" label')}`, 'sleep-hours')).toBe(false);

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
    expect(hasMatchingExplicitLabel(`${childrenForwarder}\n${childrenCall}`, 'sleep-hours')).toBe(true);
    expect(hasMatchingExplicitLabel(`${childrenForwarder}\n${childrenCall.replace('>Sleep<', '><')}`, 'sleep-hours')).toBe(false);
    expect(hasMatchingExplicitLabel(`${childrenForwarder}\n${childrenCall}`, 'other-id')).toBe(false);
  });

  it('credits a FormField whose only child is a conditional, but not a list', () => {
    // A FormField's child is frequently a ternary rather than the control
    // itself (`{isSelect ? <select/> : <input/>}`); React clones the generated
    // id onto whichever branch renders, so the control really is named. The
    // veto that matters is a rendered LIST — Children.map flattens it and
    // clones only the first element, so crediting each control in a `.map()`
    // would exempt every one after the first.
    // The wrapper is only credited when the file really imports the shared
    // component, so every fixture carries the import a real call site would.
    const field = (child) => `import FormField from '../ui/FormField';\n<FormField label="Rounds">\n  ${child}\n</FormField>`;
    const index = (src) => src.indexOf('<input');

    const ternary = field(`{isSelect ? (<select><option>a</option></select>) : (<input type="number" />)}`);
    expect(isNestedInLabeledFormField(ternary, index(ternary))).toBe(true);

    // A `.map()` in the OTHER branch has already closed by the time the control
    // is reached, so it must not disqualify the shape.
    const ternaryWithListedOptions = field(`{isSelect ? (<select>{opts.map((o) => (<option key={o}>{o}</option>))}</select>) : (<input type="number" />)}`);
    expect(isNestedInLabeledFormField(ternaryWithListedOptions, index(ternaryWithListedOptions))).toBe(true);

    const list = field(`{fields.map((f) => (<input key={f} type="number" />))}`);
    expect(isNestedInLabeledFormField(list, index(list))).toBe(false);

    // A sibling that happens to BE an <input> must not stand in for the
    // "control is the first child" marker — the second control is not cloned,
    // so a <select> after an <input> is still unnamed.
    const afterInput = field('<input type="text" />\n  <select><option>a</option></select>');
    expect(isNestedInLabeledFormField(afterInput, afterInput.indexOf('<select'))).toBe(false);

    // Only the element the expression yields directly is cloned; a control
    // nested inside a wrapper element gets no id.
    const wrapped = field(`{isSelect ? (<select />) : (<div><input type="number" /></div>)}`);
    expect(isNestedInLabeledFormField(wrapped, index(wrapped))).toBe(false);

    // An unlabeled FormField names nothing, whatever its child looks like.
    const unlabeled = ternary.replace(' label="Rounds"', '');
    expect(isNestedInLabeledFormField(unlabeled, index(unlabeled))).toBe(false);

    // This recognizer trusts a component it cannot read the source of, so the
    // name alone must not be enough — a file with its own local `FormField`
    // would otherwise exempt every control under it, and that is the widest
    // exemption the guard grants.
    const foreign = ternary.replace("from '../ui/FormField'", "from './LocalFormField'");
    expect(isNestedInLabeledFormField(foreign, index(foreign))).toBe(false);
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
