import { trackedJsxFiles, maskedSourceOf, forEachOpeningTag, skipString, matchingBraceEnd } from './a11yScanCore.js';
import { attributeValue, normalizedAttributeValue } from './a11yScanNames.js';
import { isNamedByWrapper, hasAccessibleControlName, controlSourceAnchor } from './a11yScanWrappers.js';

// Pre-existing controls exposed when the rule was generalized; the migration is
// tracked in #4297. The list is EMPTY — every <input> in the tree now carries a
// real accessible name. The last two rows were EntityCombobox / TagPicker, the
// caller-supplied-id shape a same-file scan cannot resolve; `hasCallerSuppliedName`
// (#4321) reads the call sites instead of exempting the control.
//
// Keep it empty. A new unnamed <input> is a bug to fix at the control, not a row
// to add here — and never by bolting on an `aria-label` that shadows a visible
// label the caller already renders.
export const PREEXISTING_INPUT_NAME_ALLOWLIST = new Set([]);

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
export const PREEXISTING_SELECT_TEXTAREA_NAME_ALLOWLIST = new Set([
  "src/components/music/ArtistPicker.jsx|select|id=id|value=value || ''",
  "src/components/pipeline/AuthorPicker.jsx|select|id=id|value=value || ''",
  "src/components/ui/AutoSizeTextarea.jsx|textarea|value=value|ref=ref",
  "src/components/ui/ProseEditor.jsx|textarea|placeholder=placeholder|value=value|ref=ref",
]);

// The <a> half, added by #5674. "Anchor" here means the ELEMENT, not the
// `controlSourceAnchor` string the other two lists are keyed by — the rows are
// still those strings.
//
// It is EMPTY and stays empty: the eight unnamed links the rule exposed (the
// media lightbox / media card download links, the brain link-row and mood-board
// "open in new tab" links, the file browser and uploads download links, and the
// two LoRA source links) were named in the same change rather than seeded here.
//
// A link with no accessible name is announced as bare "link" — the destination
// is exactly what a screen-reader user is choosing between. `title` alone does
// not fill that gap, for the reasons the icon-only-button rule spells out, so
// the fix for a new offender is an `aria-label` alongside whatever `title` it
// already carries — never a row here.
export const PREEXISTING_ANCHOR_NAME_ALLOWLIST = new Set([]);

// --- keyboard activation on non-interactive elements ----------------------
// A `<button>`/`<a>`/`<input>` activates from the keyboard on its own; a
// `<div onClick>` does not — it takes no focus and Enter/Space do nothing, so
// the affordance simply does not exist for a keyboard or screen-reader user.
// `lib/a11yKeyboard.js`'s `clickableProps(handler)` is the repair (role +
// tabIndex + an Enter/Space `onKeyDown`), and the tree already follows it
// everywhere — which is exactly why the convention is worth pinning now, while
// the rule lands green with no allowlist to erode.
export const CLICKABLE_HOST_TAGS = ['div', 'span', 'li', 'tr', 'td', 'section', 'article'];

// An `onClick` whose entire body is `e.stopPropagation()` is a propagation
// shim, not an activation target: it exists so a click on a drag handle nested
// inside a clickable row never reaches the row (goals/GoalsListView.jsx's grip,
// fableloom/LoomSceneMedia.jsx's `stopNodeActivation`). There is nothing for a
// keyboard user to activate, and handing it a role plus a tab stop would ADD a
// dead stop to the tab order.
export const PROPAGATION_SHIM_HANDLER = /^\(?\s*\w*\s*\)?\s*=>\s*\{?\s*\w+\s*\.\s*stopPropagation\(\)\s*;?\s*\}?$/;
export const BARE_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

// Roles whose keyboard contract does NOT live on the element itself, so a tab
// stop here would be the defect rather than the fix:
//   - `presentation`/`none` take the element out of the a11y tree, exactly like
//     `aria-hidden` — that is how the dismiss scrim under every Modal, Drawer
//     and command palette is spelled, and the keyboard route out is the owning
//     component's Esc handler, not a focusable backdrop.
//   - `option` is focus-managed BY its composite parent (ARIA APG roving focus /
//     aria-activedescendant): CmdKSearch.jsx's result rows are the worked
//     example — the input owns the arrow keys and Enter, and making each row
//     individually tabbable would break that.
//   - `dialog`/`alertdialog` on a click-to-dismiss surface (media/MediaLightbox)
//     is closed with Esc.
// Deliberately only the roles the tree actually renders. The sibling
// composite-child roles (`tab`, `menuitem`, `treeitem`, `row`, `gridcell`) are
// the same argument and belong here the day one lands — but seeding them now
// would exempt a `<div role="tab" onClick>` that has no parent managing focus
// at all, which is the false negative this list is one bad guess away from.
// `button` and `link` are excluded permanently: those promise activation ON the
// element, which is the promise this rule exists to keep.
export const SELF_MANAGED_CLICK_ROLES = new Set([
  'presentation', 'none', 'dialog', 'alertdialog', 'option',
]);

// Attribute NAMES written on an opening tag, reading quoted values and brace
// expressions as opaque. `attributeValue`'s bare regex is right for the paired
// -id lookups it serves, but a rule whose entire answer is "was this attribute
// written at all" must not accept `title=" alt="` as an alt — the one shape
// that would silently exempt the images this guard exists for.
export function tagAttributes(tag) {
  const names = new Set();
  // Every SPREAD expression on the tag, concatenated. `clickableProps` only
  // does anything when its result is spread onto the element, so both narrowings
  // matter: reading the raw tag would let a `title="clickableProps(x)"` stand in
  // for spreading it, and reading every brace expression would accept an
  // `onClick={() => clickableProps(select)}` that builds the props and drops
  // them on the floor.
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

// The shim written inline, or hoisted to a named `const`/`let`/`var` arrow in
// the same file. Resolution is by name across the whole file, which is only
// sound while that name is declared once — two component scopes sharing a
// `stop` would let one's shim exempt the other's real handler — so a name
// declared more than once resolves to nothing and the element is reported.
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
  // The explicit triple is the escape hatch, so a surface with its own ARIA
  // role is never forced through the helper. A PARTIAL triple is not one — a
  // `role="button"` with no tab stop is announced as a button the keyboard can
  // never reach, which is worse than the plain <div> it started as — and
  // neither is `tabIndex={-1}`, which is programmatic focus only.
  if (!names.has('role') || !names.has('tabIndex') || !names.has('onKeyDown')) return false;
  return !(normalizedAttributeValue(attributeValue(tag, 'tabIndex')) ?? '').startsWith('-');
}

// Every non-interactive element in `src` carrying a mouse-only `onClick`. The
// rule and its fixture probes both walk this, so a probe asks the rule's own
// question instead of a copy that can drift green.
export function* mouseOnlyClickables(src) {
  for (const name of CLICKABLE_HOST_TAGS) {
    for (const node of forEachOpeningTag(src, name)) {
      if (!isKeyboardActivatable(src, node.tag)) yield node;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Conditional error renders must announce themselves (#7266).
//
// The shape is always the same: an async action fails, a flag flips, and red
// text appears somewhere below the form while focus stays on the button that
// started it. An inert <div> announces nothing, so a screen-reader user's
// mental model after a failed save is "it worked" (WCAG 4.1.3 Status Messages).
// The answer is either <Banner>, which now supplies role="alert"/"status"
// itself, or an explicit role on the element.

// Which host elements this rule is about: the ones that carry the failure text.
// A conditionally-rendered <a>/<button> is a control the user reaches by
// tabbing, and a component tag owns its own semantics — both are out of remit.
export const ERROR_TEXT_HOST_TAGS = new Set(['div', 'p', 'span', 'section', 'article']);

// role="alert"/"status" carry implicit live semantics; aria-live is the
// explicit spelling. Any of the three satisfies the rule.
export const LIVE_REGION_ATTRIBUTE = /(?:^|\s)(?:aria-live\s*=|role\s*=\s*(?:["'{]\s*)?["']?(?:alert|status|log|progressbar)\b)/;
export const hasLiveRegion = (tag) => LIVE_REGION_ATTRIBUTE.test(tag);

// The expression immediately guarding the element at `index`, or null when the
// element is not the direct result of a `{… && <tag>}` render. Only whitespace
// and grouping parens may sit between the `&&` and the `<`: a tag that opened
// after the guard is a child of some other element, not the guarded node.
export const guardExpressionBefore = (src, index) => {
  let i = index - 1;
  while (i >= 0 && /[\s(]/.test(src[i])) i -= 1;
  if (i < 1 || src[i] !== '&' || src[i - 1] !== '&') return null;
  const end = i - 1;
  let start = end;
  // Walk back to the `{` that opened the JSX expression container. A closing
  // brace or a statement terminator means this `&&` is not a JSX guard at all.
  // `>` deliberately does NOT stop the walk — inside a guard it is a comparison
  // (`missing.length > 0 &&`) or an arrow tail far more often than a tag
  // boundary, and stopping on it blinded the rule to every such guard.
  while (start > 0 && !'{};'.includes(src[start - 1])) start -= 1;
  if (start === 0 || src[start - 1] !== '{') return null;
  const expression = src.slice(start, end).trim();
  // What `>` was there to catch: JSX TEXT containing a bare `&&`, where the walk
  // crosses the enclosing element's own opening tag. A guard expression holds no
  // `<` (`a < b` in one is rare enough to lose), so its presence means the walk
  // left the expression container.
  return expression.includes('<') ? null : expression;
};

// Does this guard name an error? The last path segment is the one that names
// the value — `status.error`, `fork?.error`, `s.result?.error` — so a
// `preferredTone` or an `err.details` nested inside an already-live section is
// not dragged in by a substring match on the whole expression.
export const ERROR_NAMED_SEGMENT = /(?:error|^errs?$)/i;
export const guardsOnError = (expression) => {
  // `{a && b && <div>}` guards on the LAST operand — the earlier ones are
  // preconditions that say nothing about what the element renders — and
  // `{cond ? x : y && <div>}` on the last ternary arm. Peel both before asking
  // what the guard names.
  // `?(?!\.)` so the ternary peel does not eat optional chaining — splitting
  // `errorContext?.missing?.length > 0` on a bare `?` leaves `.length > 0`, and
  // the guard stops naming the error it is guarding on.
  const operand = expression.split('&&').pop().split(/\?(?!\.)|:/).pop().trim();
  // A NEGATED error guard renders the SUCCESS path — `{!loadError && <Viewer/>}`
  // is the model, not the failure message — and announcing the normal content
  // of a page as a status message is its own defect.
  if (operand.startsWith('!') && !operand.startsWith('!=')) return false;
  const segments = operand.split(/[.[\]()]/).map((part) => part.trim()).filter(Boolean);
  const namesError = (text) => Boolean(text) && ERROR_NAMED_SEGMENT.test(text);
  // A comparison is not a truthiness check, and reading only its tail turns
  // `status !== 'error'` — a SUCCESS guard — into an error render.
  const comparison = operand.match(/(!|=)==?/);
  if (comparison) {
    // `x !== y` renders when the two differ: the success path, or a detail
    // beside an error already on screen. Either way, not the error itself.
    if (comparison[1] === '!') return false;
    const right = operand.slice(comparison.index + comparison[0].length).trim();
    // `error === null` is the success branch spelled the other way round.
    if (/^(?:null|undefined|false|''|""|0)$/.test(right)) return false;
    return namesError(right) || namesError(segments[0]) || namesError(segments.at(-1));
  }
  // The tail names the value (`status.error`, `fork?.error`), but a standard
  // Error is read through its properties, so the ROOT names it too
  // (`error.message`). Everything between is a container, not the name.
  return namesError(segments.at(-1)) || namesError(segments[0]);
};

// Does a live region already cover this element — one it sits inside, or one it
// renders? Either way the text is announced exactly once, which is the point;
// only an element with none anywhere on its path is silent.
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

// The conditional renders this rule deliberately does not ask to announce,
// keyed by the guard EXPRESSION rather than a line number so an edit above them
// cannot silently retire the entry (or resurrect a stale one).
export const JUSTIFIED_SILENT_ERROR_RENDERS = new Map([
  // Wraps <AppOperationBanner>, which declares role="status" itself. A one-file
  // walk cannot see across the import, and a second role here would nest two
  // live regions around the same text.
  // Not a status message: `expandedSections.errors` is a disclosure toggle over
  // a static list of historical error CATEGORIES. It appears because the user
  // opened it, so announcing it would duplicate the button they just pressed.
  ['src/components/cos/tabs/LearningTab.jsx', new Set([
    'expandedSections.errors',
    // Both of these render INSIDE that disclosure: a static analytics list of
    // historical error categories and samples, already on screen when the user
    // opens the section. Nothing appears in response to anything.
    'error.affectedTypes?.length > 0',
    'err.details',
  ])],
  // A truncation qualifier — "(results may be truncated)" — inside the <p> that
  // already reports the count. It is a clause of that sentence, not a message,
  // and announced on its own it says nothing.
  ['src/components/apps/tabs/DatadogTab.jsx', new Set(['errors.length >= 100'])],
  // Guards the whole ingest-history section (populated list, loading, OR an
  // error), not the error text itself — the failure message renders inside
  // the shared <InfiniteScrollFooter>, which declares role="alert" itself. A
  // one-file walk cannot see across that import, same shape as the
  // RepositorySourcePanel entry above.
  ['src/components/brain/YoutubeIngestSettings.jsx', new Set([
    '(ingests.length > 0 || ingestsPage.loading || Boolean(ingestsPage.error))',
  ])],
]);

// Two substring-cheap prechecks before the walk: a file that never writes
// `&& <div` cannot hold the shape at all, and lexing one into the tag index
// costs a pass over its whole text.
export const MAY_GUARD_ERROR_RENDER = /&&\s*\(?\s*<(?:div|p|span|section|article)[\s>/]/;

export function* silentErrorRenders(src, file) {
  if (!MAY_GUARD_ERROR_RENDER.test(src) || !/err/i.test(src)) return;
  // Materialized only once a candidate is actually found: the coverage check
  // needs every node, and the files that reach it are a small minority.
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


// Every rule below asks the same question of every tracked file and differs
// only in which tag it asks about and which direction it compares the answer
// against the allowlist, so they share one scan per tag. Two copies would each
// re-lex ~11MB of source, and — worse — could drift on what "unnamed" means,
// which would quietly turn the burn-down checks vacuously green.
export const unnamedAnchorsByTag = new Map();
export const unnamedControlAnchors = (tagName) => {
  const cached = unnamedAnchorsByTag.get(tagName);
  if (cached) return cached;
  const anchors = new Set();
  for (const file of trackedJsxFiles()) {
    const scanSrc = maskedSourceOf(file);
    for (const node of forEachOpeningTag(scanSrc, tagName)) {
      if (hasAccessibleControlName(scanSrc, node, tagName, file)) continue;
      anchors.add(controlSourceAnchor(file, scanSrc, node, tagName));
    }
  }
  unnamedAnchorsByTag.set(tagName, anchors);
  return anchors;
};

// One rule per tag rather than one merged rule, so a failure names the tag
// and each backlog burns down on its own schedule. `<select>` and `<textarea>`
// share an allowlist because they were seeded together by the same widening.
//
// `remedy` rides on the rule rather than being spelled inline, because the fix
// is not the same for every tag: a form control wants a `<label>`, and a link
// wants its own text — an `aria-label` is the fallback for both, and telling
// someone to put a `<label>` on an anchor is advice that does not work.
export const CONTROL_NAME_RULES = [
  { tag: 'input', listName: 'PREEXISTING_INPUT_NAME_ALLOWLIST', allowlist: PREEXISTING_INPUT_NAME_ALLOWLIST, issue: '#4297', remedy: 'add aria-label/aria-labelledby or an explicit/implicit <label>, or exclude type="hidden"' },
  { tag: 'select', listName: 'PREEXISTING_SELECT_TEXTAREA_NAME_ALLOWLIST', allowlist: PREEXISTING_SELECT_TEXTAREA_NAME_ALLOWLIST, issue: '#4309', remedy: 'add aria-label/aria-labelledby or an explicit/implicit <label>' },
  { tag: 'textarea', listName: 'PREEXISTING_SELECT_TEXTAREA_NAME_ALLOWLIST', allowlist: PREEXISTING_SELECT_TEXTAREA_NAME_ALLOWLIST, issue: '#4309', remedy: 'add aria-label/aria-labelledby or an explicit/implicit <label>' },
  { tag: 'a', listName: 'PREEXISTING_ANCHOR_NAME_ALLOWLIST', allowlist: PREEXISTING_ANCHOR_NAME_ALLOWLIST, issue: '#5674', remedy: 'an icon-only link is announced as bare "link" — give it visible text or an aria-label naming the destination; a title alone is not read as the accessible name, and an aria-hidden icon leaves the name empty' },
];

// Fixture sources are scanned as if they lived here, so a relative
// `../ui/FormField` resolves against the real components/ui/FormField.jsx the
// way a call site's would. Only the directory matters — the file itself need
// not exist.
export const FIXTURE_HOST = 'src/components/settings/FixtureHost.jsx';
// Reads the control off the same tag index the real scan walks, so a fixture
// asks the recognizer exactly the question a tracked file would — and the
// node carries the `matchingClose` the <a> branch reads its body from.
export const isNamed = (src, tagName = 'input', file = FIXTURE_HOST) => {
  const [node] = forEachOpeningTag(src, tagName);
  return node !== undefined && hasAccessibleControlName(src, node, tagName, file);
};
// The id-keyed half of the same question: is a control carrying this `id`
// named by one of the wrappers the source renders? These fixtures declare
// their wrapper inline, so no host path is needed.
export const namesId = (src, id) => isNamedByWrapper(src, { id });

