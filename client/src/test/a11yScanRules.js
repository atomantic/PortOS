import { trackedJsxFiles, maskedSourceOf, rawSourceOf, forEachOpeningTag, skipString, matchingBraceEnd } from './a11yScanCore.js';
import { attributeValue, normalizedAttributeValue } from './a11yScanNames.js';
import { isNamedByWrapper, hasAccessibleControlName, controlSourceAnchor } from './a11yScanWrappers.js';

// The <select>/<textarea> allowlist. The four rows are the limit of a source-level scan, which cannot follow a name across a component boundary:
//   * ArtistPicker / AuthorPicker forward an `id` prop to their <select>; call sites render them inside a FormField whose <label htmlFor> names it.
//   * AutoSizeTextarea / ProseEditor spread `{...rest}` onto their <textarea>, so the caller supplies the name; hardcoding one would mask a caller that passes none.
// Empty the list by teaching the scan to follow `id`/`{...rest}`, not by inventing names. A new unnamed control is named, not listed.
export const PREEXISTING_SELECT_TEXTAREA_NAME_ALLOWLIST = new Set([
  "src/components/music/ArtistPicker.jsx|select|id=id|value=value || ''",
  "src/components/pipeline/AuthorPicker.jsx|select|id=id|value=value || ''",
  "src/components/ui/AutoSizeTextarea.jsx|textarea|value=value|ref=ref",
  "src/components/ui/ProseEditor.jsx|textarea|placeholder=placeholder|value=value|ref=ref",
]);

// --- keyboard activation on non-interactive elements ---
// A `<div onClick>` takes no focus and ignores Enter/Space; `lib/a11yKeyboard.js`'s `clickableProps(handler)` (role + tabIndex + Enter/Space `onKeyDown`) is the repair.
export const CLICKABLE_HOST_TAGS = ['div', 'span', 'li', 'tr', 'td', 'section', 'article'];

// An `onClick` whose whole body is `e.stopPropagation()` is a propagation shim (e.g. a drag handle inside a clickable row), not an
// activation target; a role plus tab stop would add a dead stop.
export const PROPAGATION_SHIM_HANDLER = /^\(?\s*\w*\s*\)?\s*=>\s*\{?\s*\w+\s*\.\s*stopPropagation\(\)\s*;?\s*\}?$/;
export const BARE_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

// Roles whose keyboard contract does NOT live on the element, so a tab stop would be the defect:
//   - `presentation`/`none` (dismiss scrims under Modal/Drawer/palette; Esc on the owner is the keyboard route).
//   - `option`, focus-managed by its composite parent (CmdKSearch result rows).
//   - `dialog`/`alertdialog` on a click-to-dismiss surface (media/MediaLightbox), closed with Esc.
// Only roles the tree renders: seeding `tab`/`menuitem`/... early would exempt a `<div role="tab" onClick>` with no focus-managing parent.
// `button` and `link` are excluded permanently; they promise activation ON the element.
export const SELF_MANAGED_CLICK_ROLES = new Set([
  'presentation', 'none', 'dialog', 'alertdialog', 'option',
]);

// Attribute NAMES written on an opening tag, treating quoted values and brace expressions as opaque so `title=" alt="` is not accepted as an alt.
export function tagAttributes(tag) {
  const names = new Set();
  // Every SPREAD expression on the tag: `clickableProps` only counts when spread onto the element, not named in a `title` string or built and dropped.
  let spreads = '';
  for (let i = 0; i < tag.length; i++) {
    const char = tag[i];
    if (char === '"' || char === "'" || char === '`') { i = skipString(tag, i); continue; }
    if (char === '{') {
      const end = matchingBraceEnd(tag, i);
      if (end === -1) break;
      const body = tag.slice(i + 1, end);
      if (body.trimStart().startsWith('...')) spreads += `${body}\n`;
      i = end;
      continue;
    }
    const name = /^[A-Za-z_$][\w$:.-]*/.exec(tag.slice(i))?.[0];
    if (!name) continue;
    let after = i + name.length;
    while (/\s/.test(tag[after])) after++;
    if (tag[after] === '=') names.add(name);
    i = after - 1;
  }
  return { names, spreads };
}

// The shim inline, or hoisted to a named arrow in the same file. Resolved by name across the file, so a name declared more than once resolves to nothing and the element is reported.
export function isPropagationShim(src, handler) {
  if (PROPAGATION_SHIM_HANDLER.test(handler)) return true;
  if (!BARE_IDENTIFIER.test(handler)) return false;
  const declarations = [...src.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${handler}\\s*=\\s*([^;\\n]+)`, 'g'))];
  return declarations.length === 1 && PROPAGATION_SHIM_HANDLER.test(declarations[0][1].trim());
}

export function isKeyboardActivatable(src, tag) {
  const { names, spreads } = tagAttributes(tag);
  if (!names.has('onClick')) return true;
  if (isPropagationShim(src, normalizedAttributeValue(attributeValue(tag, 'onClick')) ?? '')) return true;
  // `clickableProps(` is the canonical spelling.
  if (/\bclickableProps\s*\(/.test(spreads)) return true;
  if (normalizedAttributeValue(attributeValue(tag, 'aria-hidden')) === 'true') return true;
  const role = normalizedAttributeValue(attributeValue(tag, 'role'));
  if (role !== null && SELF_MANAGED_CLICK_ROLES.has(role)) return true;
  // The explicit role+tabIndex+onKeyDown triple is the escape hatch. A PARTIAL triple is not (`role="button"` with no tab stop is unreachable), nor is `tabIndex={-1}`.
  if (!names.has('role') || !names.has('tabIndex') || !names.has('onKeyDown')) return false;
  return !(normalizedAttributeValue(attributeValue(tag, 'tabIndex')) ?? '').startsWith('-');
}

// Every non-interactive element in `src` carrying a mouse-only `onClick`; shared by the rule and its fixture probes.
export function* mouseOnlyClickables(src) {
  if (!src.includes('onClick')) return;
  for (const name of CLICKABLE_HOST_TAGS) {
    for (const node of forEachOpeningTag(src, name)) {
      if (node.tag.includes('onClick') && !isKeyboardActivatable(src, node.tag)) yield node;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Conditional error renders must announce themselves (#7266): an inert <div> announces nothing (WCAG 4.1.3); use <Banner> or an explicit role.

// Host elements that carry the failure text; links/buttons are reached by tabbing and components own their semantics.
export const ERROR_TEXT_HOST_TAGS = new Set(['div', 'p', 'span', 'section', 'article']);

// role="alert"/"status" carry implicit live semantics; aria-live is the
// explicit spelling. Any of the three satisfies the rule.
export const LIVE_REGION_ATTRIBUTE = /(?:^|\s)(?:aria-live\s*=|role\s*=\s*(?:["'{]\s*)?["']?(?:alert|status|log|progressbar)\b)/;
export const hasLiveRegion = (tag) => LIVE_REGION_ATTRIBUTE.test(tag);

// The expression directly guarding the element at `index`, or null when it is not the direct result of a `{… && <tag>}` render.
export const guardExpressionBefore = (src, index) => {
  let i = index - 1;
  while (i >= 0 && /[\s(]/.test(src[i])) i -= 1;
  if (i < 1 || src[i] !== '&' || src[i - 1] !== '&') return null;
  const end = i - 1;
  let start = end;
  // Walk back to the `{` opening the JSX expression container. `>` does NOT stop the walk: inside a guard it is a comparison or arrow tail.
  while (start > 0 && !'{};'.includes(src[start - 1])) start -= 1;
  if (start === 0 || src[start - 1] !== '{') return null;
  const expression = src.slice(start, end).trim();
  // A guard holds no `<`; its presence means the walk crossed the enclosing element's opening tag (JSX text with a bare `&&`).
  return expression.includes('<') ? null : expression;
};

// The last path segment names the value (`status.error`), so `preferredTone` nested in a live section isn't matched by substring.
export const ERROR_NAMED_SEGMENT = /(?:error|^errs?$)/i;
export const guardsOnError = (expression) => {
  // `{a && b && <div>}` guards on the LAST operand, `{c ? x : y && <div>}` on the last ternary arm. `?(?!\.)` keeps the peel from eating optional chaining.
  const operand = expression.split('&&').pop().split(/\?(?!\.)|:/).pop().trim();
  // A NEGATED error guard renders the SUCCESS path, which must not be announced as a status.
  if (operand.startsWith('!') && !operand.startsWith('!=')) return false;
  const segments = operand.split(/[.[\]()]/).map((part) => part.trim()).filter(Boolean);
  const namesError = (text) => Boolean(text) && ERROR_NAMED_SEGMENT.test(text);
  // Only a truthiness check counts: `status !== 'error'` is a SUCCESS guard.
  const comparison = operand.match(/(!|=)==?/);
  if (comparison) {
    // `x !== y` is the success path or a detail beside an already-visible error.
    if (comparison[1] === '!') return false;
    const right = operand.slice(comparison.index + comparison[0].length).trim();
    // `error === null` is the success branch spelled the other way round.
    if (/^(?:null|undefined|false|''|""|0)$/.test(right)) return false;
    return namesError(right) || namesError(segments[0]) || namesError(segments.at(-1));
  }
  // The tail names the value (`status.error`), but a standard Error is read through its properties, so the ROOT names it too (`error.message`).
  return namesError(segments.at(-1)) || namesError(segments[0]);
};

// A live region already covers the element (an ancestor, or one it renders); otherwise the text is silent.
export const announcesTag = (node) => node.tag && (hasLiveRegion(node.tag) || node.name === 'Banner');

export const isCoveredByLiveRegion = (node, nodes) => {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (announcesTag(parent)) return true;
  }
  return nodes.some((other) => announcesTag(other) && isDescendantOf(other, node));
};

export const isDescendantOf = (node, ancestor) => {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent === ancestor) return true;
  }
  return false;
};

// Conditional renders deliberately not announced, keyed by guard EXPRESSION so an edit above can't retire or resurrect an entry.
export const JUSTIFIED_SILENT_ERROR_RENDERS = new Map([
  // Wraps <AppOperationBanner>, which declares role="status" itself (a one-file walk can't see across the import).
  // `expandedSections.errors` is a disclosure toggle over static historical categories, not a status message.
  ['src/components/cos/tabs/LearningTab.jsx', new Set([
    'expandedSections.errors',
    // Both render INSIDE that disclosure: static analytics, already on screen when the section opens.
    'error.affectedTypes?.length > 0',
    'err.details',
  ])],
  // A truncation qualifier inside the <p> that already reports the count; a clause, not a message.
  ['src/components/apps/tabs/DatadogTab.jsx', new Set(['errors.length >= 100'])],
  // Guards the whole ingest-history section; the error text renders inside <InfiniteScrollFooter>, which declares role="alert" (invisible to a one-file walk).
  ['src/components/brain/YoutubeIngestSettings.jsx', new Set([
    '(ingests.length > 0 || ingestsPage.loading || Boolean(ingestsPage.error))',
  ])],
]);

// Cheap prechecks before the walk: a file that never writes `&& <div` cannot hold the shape, and lexing costs a full pass.
export const MAY_GUARD_ERROR_RENDER = /&&\s*\(?\s*<(?:div|p|span|section|article)[\s>/]/;

export function* silentErrorRenders(src, file) {
  if (!MAY_GUARD_ERROR_RENDER.test(src) || !/err/i.test(src)) return;
  // Materialized only once a candidate is found; few files reach it.
  let nodes = null;
  for (const node of forEachOpeningTag(src)) {
    if (!ERROR_TEXT_HOST_TAGS.has(node.name)) continue;
    if (hasLiveRegion(node.tag)) continue;
    const expression = guardExpressionBefore(src, node.index);
    if (!expression || !guardsOnError(expression)) continue;
    nodes ??= [...forEachOpeningTag(src)];
    if (isCoveredByLiveRegion(node, nodes)) continue;
    if (JUSTIFIED_SILENT_ERROR_RENDERS.get(file)?.has(expression)) continue;
    yield node;
  }
}


// Every rule asks the same question of every tracked file, so they share one scan per tag (two copies re-lex ~11MB and could drift on "unnamed").
export const unnamedAnchorsByTag = new Map();
export const unnamedControlAnchors = (tagName) => {
  const cached = unnamedAnchorsByTag.get(tagName);
  if (cached) return cached;
  const anchors = new Set();
  for (const file of trackedJsxFiles()) {
    // Masking only removes text: a raw source that never spells the tag has none masked.
    if (!rawSourceOf(file).includes(`<${tagName}`)) continue;
    const scanSrc = maskedSourceOf(file);
    for (const node of forEachOpeningTag(scanSrc, tagName)) {
      if (hasAccessibleControlName(scanSrc, node, tagName, file)) continue;
      anchors.add(controlSourceAnchor(file, scanSrc, node, tagName));
    }
  }
  unnamedAnchorsByTag.set(tagName, anchors);
  return anchors;
};

// One rule per tag so a failure names the tag. `remedy` rides on the rule because the fix differs (a form control wants a `<label>`, a link
// wants its own text; `aria-label` is the fallback for both). A rule with no `allowlist` has none by design: every <input> and <a> is named
// at the control (never via an `aria-label` that shadows a visible label, and a link's `title` alone is not a name).
export const CONTROL_NAME_RULES = [
  { tag: 'input', issue: '#4297', remedy: 'add aria-label/aria-labelledby or an explicit/implicit <label>, or exclude type="hidden"' },
  { tag: 'select', listName: 'PREEXISTING_SELECT_TEXTAREA_NAME_ALLOWLIST', allowlist: PREEXISTING_SELECT_TEXTAREA_NAME_ALLOWLIST, issue: '#4309', remedy: 'add aria-label/aria-labelledby or an explicit/implicit <label>' },
  { tag: 'textarea', listName: 'PREEXISTING_SELECT_TEXTAREA_NAME_ALLOWLIST', allowlist: PREEXISTING_SELECT_TEXTAREA_NAME_ALLOWLIST, issue: '#4309', remedy: 'add aria-label/aria-labelledby or an explicit/implicit <label>' },
  { tag: 'a', issue: '#5674', remedy: 'an icon-only link is announced as bare "link" — give it visible text or an aria-label naming the destination; a title alone is not read as the accessible name, and an aria-hidden icon leaves the name empty' },
];

// Fixtures are scanned as if they lived here so relative imports like `../ui/FormField` resolve against real components; only the directory matters.
export const FIXTURE_HOST = 'src/components/settings/FixtureHost.jsx';
// Reads the control off the same tag index as the real scan, so a fixture asks the recognizer what a tracked file would.
export const isNamed = (src, tagName = 'input', file = FIXTURE_HOST) => {
  const [node] = forEachOpeningTag(src, tagName);
  return node !== undefined && hasAccessibleControlName(src, node, tagName, file);
};
// The id-keyed half: is a control with this `id` named by a wrapper the source renders?
export const namesId = (src, id) => isNamedByWrapper(src, { id });

