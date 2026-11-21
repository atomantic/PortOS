import { tagIndexOf, forEachTag, forEachOpeningTag, balancedCallAt, jsxScanner, matchingBraceEnd, } from './a11yScanCore.js';

// Tailwind `h-`/`w-`/`min-h-`/`min-w-` token → px, for both an arbitrary
// value (`min-h-[44px]`) and the spacing scale (`h-11` = 11 * 4px = 44px).
export function tokenPx(token) {
  const arb = token.match(/^(?:min-)?[hw]-\[(\d+(?:\.\d+)?)px\]$/);
  if (arb) return parseFloat(arb[1]);
  const scale = token.match(/^(?:min-)?[hw]-(\d+(?:\.5)?)$/);
  if (scale) return parseFloat(scale[1]) * 4;
  return null;
}

export function hasFortyFourMinTouchTarget(cls) {
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
export function attributeValue(tag, name) {
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

export function normalizedAttributeValue(value) {
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
export function maskComments(src, { startMode = 'code' } = {}) {
  if (!src.includes('//') && !src.includes('/*')) return src;
  const chunks = [];
  let cursor = 0;
  for (const { index, end } of jsxScanner(src, { mode: startMode, commentsOnly: true })) {
    // Slice at the lexer's UTF-16 offsets and preserve newlines for diagnostics.
    chunks.push(src.slice(cursor, index), src.slice(index, end + 1).replace(/[^\n]/g, ' '));
    cursor = end + 1;
  }
  if (chunks.length === 0) return src;
  chunks.push(src.slice(cursor));
  return chunks.join('');
}

// Keep the source's offsets and line breaks intact while making spans inert.
// The tag index reports source indexes, so preserving that coordinate system
// lets several consumers share one structural read without compensating for
// prior replacements.
export function blankSourceSpans(src, spans) {
  const chars = src.split('');
  for (const { start, end } of spans) {
    for (let index = start; index < end; index++) {
      if (chars[index] !== '\n') chars[index] = ' ';
    }
  }
  return chars.join('');
}

export function hasMatchingLabelElement(src, id) {
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
export function isUsableLabelAttributeValue(value) {
  return Boolean(value) && !/^(?:undefined|null|false|true)$/i.test(value);
}

// Does this wrapper instance carry a usable name in the prop its own source
// names its label with? Every shape matcher asks it, so the three-deep read
// (`attributeValue` → `normalizedAttributeValue` → `isUsableLabelAttributeValue`)
// lives here rather than being respelled at each one.
export function hasUsableLabelProp(tag, labelProp) {
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
export function forwardsLabelForId(src, { id }, { idProp, labelProp }, name) {
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

export const HIDDEN_ACCESSIBILITY_ATTRIBUTE = new RegExp(String.raw`(?:^|\s)(?:aria-hidden\s*=\s*(?:["']true["']|\{\s*true\s*\})|hidden(?:\s*=\s*(?:["']true["']|\{\s*true\s*\}))?)(?=\s|/|>)`, 'i');
export const isHiddenFromAccessibility = (tag) => HIDDEN_ACCESSIBILITY_ATTRIBUTE.test(tag);

export function stripHiddenElementContent(body) {
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
export function hasUsableElementText(src, node) {
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

export function isNestedInLabel(src, index) {
  return openWrapperInstancesAt(src, 'label', index)
    .some((node) => hasUsableElementText(src, node));
}

export function hasUsableAccessibleNameAttribute(tag, name) {
  return isUsableLabelAttributeValue(normalizedAttributeValue(attributeValue(tag, name)));
}

export function hasUsableNativeInputName(tag) {
  const type = normalizedAttributeValue(attributeValue(tag, 'type'))?.toLowerCase() || 'text';
  if (type === 'hidden') return true;
  if (['submit', 'button', 'reset'].includes(type)) {
    const value = attributeValue(tag, 'value');
    return value === null || hasUsableAccessibleNameAttribute(tag, 'value');
  }
  return type === 'image' && hasUsableAccessibleNameAttribute(tag, 'alt');
}

// A `<span className="hidden sm:inline">Label</span>` genuinely leaves the
// accessibility tree below `sm` — `display:none` content is excluded from
// accessible-name computation — so a control whose ONLY text sits inside one
// of these wrappers announces as a bare "button"/"link" at that width. The
// fix keeps the text in the tree and hides it only visually
// (`max-sm:sr-only` / `@max-xs:sr-only`, see ui/TabPills.jsx:172), which is
// why a class carrying `sr-only` is never flagged even if it also carries a
// bare `hidden` token (`sr-only sm:hidden`, the complementary half of the
// same idiom).
export const RESPONSIVE_HIDDEN_DISPLAY_VARIANT = /^@?[\w.-]+:(?:inline-flex|inline|flex|block)$/;

export function isResponsiveHiddenLabelWrapper(tag) {
  const cls = normalizedAttributeValue(attributeValue(tag, 'className')) ?? '';
  const classes = cls.split(/\s+/).filter(Boolean);
  if (!classes.includes('hidden') || classes.includes('sr-only')) return false;
  return classes.some((token) => RESPONSIVE_HIDDEN_DISPLAY_VARIANT.test(token));
}

// Same shape as `stripHiddenElementContent` (blank the whole element — both
// tags and its body) but keyed on the responsive-hidden-label class pattern
// instead of `hidden`/`aria-hidden` attributes.
export function stripResponsiveHiddenLabelContent(body) {
  const spans = [];
  for (const node of forEachOpeningTag(body, undefined, { startMode: 'jsx-text' })) {
    if (!isResponsiveHiddenLabelWrapper(node.tag)) continue;
    const end = node.selfClosing ? node.contentStart : node.matchingClose?.contentStart;
    if (end !== undefined) spans.push({ start: node.index, end });
  }
  return blankSourceSpans(body, spans);
}

// The static-text-or-usable-expression check `hasUsableElementText` ends
// with, factored out so `isResponsiveHiddenOnlyLabelControl` can run it twice
// — once over the body with responsive-hidden wrappers blanked out (is there
// a name that survives at every width?), once over the untouched body (is
// there a name here at all, so a genuinely empty/icon-only control is left to
// the rule that already owns it?).
export function bodyHasUsableText(body) {
  if (!body) return false;
  const staticText = body.replace(/\{[^{}]*\}/g, ' ').trim();
  if (staticText) return true;
  return [...body.matchAll(/\{([^{}]*)\}/g)].some(([, expression]) => (
    isUsableLabelAttributeValue(normalizedAttributeValue(expression))
  ));
}

// No aria-label/aria-labelledby, and every text node inside sits under a
// `hidden <variant>:inline` (or `@<size>:…`) wrapper rather than the
// `max-<bp>:sr-only` fix form — so the control's name disappears exactly
// where that wrapper hides it.
export function isResponsiveHiddenOnlyLabelControl(src, node) {
  if (/\baria-label\s*=/.test(node.tag) || /\baria-labelledby\s*=/.test(node.tag)) return false;
  if (node.selfClosing) return false;
  const closing = node.matchingClose;
  if (!closing) return false;
  const rawBody = maskComments(src.slice(node.contentStart, closing.index), { startMode: 'jsx-text' });
  const withoutA11yHidden = stripHiddenElementContent(rawBody);
  // Any text left once the responsive-hidden wrappers are ALSO blanked is
  // visible at every width, so the control is never nameless.
  const alwaysVisibleBody = stripJsxTags(stripResponsiveHiddenLabelContent(withoutA11yHidden)).trim();
  if (bodyHasUsableText(alwaysVisibleBody)) return false;
  // Nothing survives — flag it only if that's because a responsive-hidden
  // wrapper swallowed real text, not because the control had none to begin
  // with (that shape is `isUnnamedIconOnlyButton`'s to catch).
  const fullBody = stripJsxTags(withoutA11yHidden).trim();
  return bodyHasUsableText(fullBody);
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
export function isEnclosedInListCall(src, start, index) {
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

export function isDirectElementInExpression(src, start, node) {
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
export function openWrapperInstancesAt(src, name, index) {
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
export function isFirstDirectChild(src, wrapper, index) {
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
export function isNestedInLabeledCloner(src, { index }, { labelProp }, wrapperName) {
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
export function forEachLocalComponent(src, visit) {
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
export function blockBodyAt(src, from) {
  const bodyStart = src.indexOf('{', from);
  if (bodyStart === -1) return null;
  const bodyEnd = matchingBraceEnd(src, bodyStart);
  return bodyEnd === -1 ? null : { start: bodyStart, text: src.slice(bodyStart, bodyEnd) };
}

// `=>` is what separates a component from an ordinary parenthesized
// initializer (`const RE = ('a' + 'b')`), which would otherwise register as a
// component whose "body" is the next brace block in the file.
export function arrowBodyAt(src, from) {
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
export function* labelElements(body) {
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
export function stripJsxTags(source) {
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
export function clonesChildrenParameter(body, cloneTarget, parameterNames) {
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
export function wrapperShapes(body, params) {
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

