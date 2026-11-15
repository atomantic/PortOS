import { posix } from 'path';
import { trackedJsxFiles, trackedSourceSet, maskedSourceByFile, virtualSources, maskedSourceOf, COMPONENT_TAG_NAME, forEachTag, forEachOpeningTag, renderedTagNames } from './a11yScanCore.js';
import { attributeValue, normalizedAttributeValue, maskComments, hasMatchingLabelElement, hasUsableLabelProp, forwardsLabelForId, isHiddenFromAccessibility, stripHiddenElementContent, hasUsableElementText, isNestedInLabel, hasUsableAccessibleNameAttribute, hasUsableNativeInputName, openWrapperInstancesAt, isNestedInLabeledCloner, forEachLocalComponent, wrapperShapes } from './a11yScanNames.js';

// Resolve a relative import specifier to a client-relative path, the way the
// bundler would. Restricted to git-tracked sources for the same reason the scan
// is: an untracked scratch file must not be able to name a control either.
// posix join: tracked paths come from `git ls-files` with `/` separators, and
// win32 `join` would emit `\\` and never match them.
export function resolveRelativeImport(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = posix.join(posix.dirname(fromFile), specifier);
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
export function addNamedClauseBindings(bindings, clause, file) {
  for (const entry of clause.split(',')) {
    const [exported, local] = entry.trim().split(/\s+as\s+/);
    if (exported) bindings.set(local ?? exported, { file, exportedName: exported });
  }
}

// Local binding name -> { file, exportedName } for every relatively-imported
// component. `default` stands in for a default import; the imported file
// resolves it to the component it actually points at.
export function relativeImportBindings(src, file) {
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
export function defaultExportName(src) {
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
export function reExportBindings(src, file) {
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

export const importedShapesByFile = new Map();

export function importedComponentShapes(file, exportedName) {
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

export const wrapperRegistryByFile = new Map();

// name -> shape[] for every wrapper this file can render.
//
// Cached by path, not by source: the scan hands over the file's own memoized
// masked source, so the two are the same string object and `===` settles it in
// a pointer compare. The probe fixtures pass a synthetic source under a real
// directory (they only need it to resolve their relative imports) and build
// fresh each time, which is cheap for a handful of one-line sources.
export function wrapperRegistry(src, file) {
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
export function withVirtualSources(sources, run) {
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

export function isNestedInLabelWrapper(src, { index }, { labelProp }, name) {
  if (index === undefined) return false;
  return openWrapperInstancesAt(src, name, index).some(({ tag }) => hasUsableLabelProp(tag, labelProp));
}

// One matcher per shape `wrapperShapes` can emit. Adding a naming strategy is a
// detector branch plus an entry here — not another recognizer function plus
// another hand-written line in `hasAccessibleControlName`.
export const SHAPE_MATCHERS = {
  implicit: isNestedInLabelWrapper,
  forwarded: forwardsLabelForId,
  cloned: isNestedInLabeledCloner,
};

// Is the control described by `context` named by one of the wrappers this file
// can render? `context` carries the control's source `index` (for the two
// ancestor-based shapes), its `id` (for the id-forwarding shape), and the
// `file` whose relative imports the registry may follow.
export function isNamedByWrapper(src, context) {
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
export function enclosingParameterizedComponent(src, index, param) {
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
export function exportedNamesOf(src, name) {
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
export function callSiteIdVerdicts(src, name, idProp) {
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
export function hasCallerSuppliedName(src, tag, index, sites) {
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
export let importerIndexCache = null;

export function callSitesOf(file) {
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

export function hasUsableAriaLabelledByReference(src, tag) {
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

// The element's BODY, prepared the way `hasUsableElementText` prepares it:
// comments masked, `aria-hidden` subtrees removed — so the two content-name
// checks cannot drift on what "hidden" means.
export function accessibleBodyOf(src, { contentStart, matchingClose }) {
  if (!matchingClose) return null;
  return stripHiddenElementContent(
    maskComments(src.slice(contentStart, matchingClose.index), { startMode: 'jsx-text' }),
  );
}

// `alt` names an element only where HTML says it does. A `<div alt="…">` or a
// `<Thumb alt={caption} />` is inert markup as far as the accessibility tree is
// concerned — reading it as a name would exempt an unnamed link on the strength
// of an attribute no browser looks at. `<input type="image">` is left out
// deliberately: it is not phrasing content inside a link, and `<input>` has its
// own name rule two branches down.
export const ALT_NAMED_TAGS = new Set(['img', 'area']);

// Which components declared in THIS file render text of their own? An anchor
// wrapping one is named by whatever that component renders — KanbanBoard's
// `<a><TicketCard ticket={ticket} /></a>` announces the ticket's key, summary,
// priority and type — and an `aria-label` on such a link would REPLACE that
// whole subtree with a terser name rather than add to it.
//
// Only a LOCAL declaration is credited, and only one that actually renders
// text. Every link this rule exists to catch wraps an IMPORTED icon
// (`<Download />`, `<ExternalLink />`), and a file-local icon wrapper renders no
// text either — so neither is exempted. Crediting any component child, or
// following imports, would hand the rule the one bypass that makes it vacuous.
export const textRenderingLocalComponentsBySource = new Map();

export function textRenderingLocalComponents(src) {
  const cached = textRenderingLocalComponentsBySource.get(src);
  if (cached) return cached;
  const names = new Set();
  forEachLocalComponent(src, (name, body) => {
    if (names.has(name)) return;
    for (const node of forEachOpeningTag(body)) {
      if (isHiddenFromAccessibility(node.tag)) continue;
      if (!hasUsableElementText(body, node)) continue;
      names.add(name);
      return;
    }
  });
  textRenderingLocalComponentsBySource.set(src, names);
  return names;
}

// Everything an <a> can be named by that is NOT its own plain text: a
// descendant image's `alt` (a thumbnail link — an `aria-label` bolted onto one
// would OVERRIDE that alt rather than add to it, a regression dressed up as a
// fix), and a same-file component that renders text.
//
// One walk of the prepared body answers both. It is the expensive half of the
// rule, so it runs only after `hasUsableElementText` has already cleared the
// ordinary text links, and the local-component set is resolved lazily — a body
// with no component child at all never builds one.
export function hasAccessibleLinkContent(src, node) {
  const body = accessibleBodyOf(src, node);
  if (body === null) return false;
  const componentChildren = new Set();
  for (const child of forEachOpeningTag(body, undefined, { startMode: 'jsx-text' })) {
    if (ALT_NAMED_TAGS.has(child.name) && hasUsableAccessibleNameAttribute(child.tag, 'alt')) return true;
    if (child.name && COMPONENT_TAG_NAME.test(child.name)) componentChildren.add(child.name);
  }
  if (componentChildren.size === 0) return false;
  const local = textRenderingLocalComponents(src);
  return [...componentChildren].some((name) => local.has(name));
}

// `type`-derived names are an <input>-only affordance: a submit button names
// itself from `value`, an image button from `alt`, and a hidden input is not in
// the a11y tree at all. <select> and <textarea> have no such escape hatch, so
// the caller passes the tag name rather than this reading `type` off anything
// that happens to carry one.
//
// Takes the tag-index NODE, not a `(tag, index)` pair: the <a> branch needs the
// element's BODY, and `matchingClose` is the lexer's answer to where that ends.
// Re-deriving it from an index inside here would be a second answer to a
// question the scan already settled — the same trap `controlSourceAnchor`
// documents.
export function hasAccessibleControlName(src, node, tagName, file) {
  const { tag, index } = node;
  if (hasUsableAccessibleNameAttribute(tag, 'aria-label')) return true;
  if (hasUsableAccessibleNameAttribute(tag, 'aria-labelledby') && hasUsableAriaLabelledByReference(src, tag)) return true;
  if (tagName === 'input' && hasUsableNativeInputName(tag)) return true;
  // Unlike a form control, a link names itself from its own CONTENT — its text,
  // a descendant image's `alt`, or a same-file component that renders either.
  // The overwhelming majority of anchors in the tree are ordinary text links,
  // and without these branches the rule would report every one of them. All
  // three read the body through the one `accessibleBodyOf` preparation, so an
  // `aria-hidden` subtree contributes to none of them: an anchor whose only
  // child is `<Icon aria-hidden="true" />` computes an EMPTY name in the browser
  // and is correctly reported as unnamed here.
  if (tagName === 'a' && (hasUsableElementText(src, node) || hasAccessibleLinkContent(src, node))) return true;
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
// `href` is what distinguishes one <a> from another — without it a page's links
// all share the empty semantic anchor and the offender list reads as
// `file|a||occurrence=7`, which names nothing a reader can find. No <input>,
// <select> or <textarea> carries one, so adding it cannot move an existing row.
export const CONTROL_ANCHOR_ATTRIBUTES = [
  'id', 'name', 'type', 'placeholder', 'value', 'ref', 'title', 'role', 'href',
  'aria-label', 'aria-labelledby', 'autoFocus', 'min', 'max', 'step', 'rows',
];

export function controlSemanticAnchor(tag) {
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
export function controlSourceAnchor(file, src, { tag, index }, tagName) {
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

