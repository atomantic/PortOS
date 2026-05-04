/**
 * Enhanced prompt template engine — Mustache-flavored, dot-notation aware.
 *
 * This replaces the templating in `portos-ai-toolkit`'s prompts service so
 * PortOS templates can reference nested objects naturally:
 *
 *   {{project.name}}                — looks up `data.project.name`
 *   {{#scene}}{{intent}}{{/scene}}  — opens scope into `data.scene`, then
 *                                      `intent` resolves against the scene
 *   {{#frames}} {{label}} {{/frames}} — iterates the array, opening scope
 *                                      into each item per iteration
 *   {{^frames}}fallback{{/frames}}   — renders only when frames is empty/falsy
 *   {{{html}}}                       — emits the value as-is (no future-proof
 *                                      escaping; aligns with markdown prompts)
 *
 * Why this exists: the upstream toolkit engine matches `\w+` for keys, which
 * silently drops every `{{a.b}}` reference and leaves the literal text in
 * the output — a real bug today (cos-evaluate.md `{{metadata.context}}` is
 * dead code). Routing every prompt through this engine fixes those legacy
 * templates AND lets new templates author dotted lookups directly.
 *
 * The engine is intentionally small: lookups, sections, inverted sections,
 * triple-mustache. No partials, no lambdas, no caching — prompts are built
 * once per agent task, the cost is negligible, and a smaller surface keeps
 * the templates predictable for users editing them in the Prompts Manager.
 */

// Resolve a dotted key path against a context, walking one segment at a
// time. Returns `undefined` for any miss so the caller can decide whether
// to render an empty string (variable miss) or skip a section (falsy guard).
const resolveKey = (context, key) => {
  if (!context || typeof context !== 'object') return undefined;
  if (key === '.') {
    // During primitive-array iteration the engine stashes the current item
    // under the literal `'.'` key on a wrapper object — return that
    // ahead of the wrapper itself. For object-array iteration no `'.'` is
    // set; fall back to the spread context.
    return Object.prototype.hasOwnProperty.call(context, '.') ? context['.'] : context;
  }
  const segments = key.split('.');
  let cursor = context;
  for (const segment of segments) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = cursor[segment];
  }
  return cursor;
};

// Mustache-truthy: empty arrays and empty strings are falsy (matches Mustache
// spec; deliberately stricter than JS truthiness so optional sections behave
// intuitively when a list comes back empty).
const isTruthySectionValue = (value) => {
  if (value == null || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.length > 0;
  return true;
};

const SECTION_RE = /\{\{#([\w.]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;
const INVERTED_RE = /\{\{\^([\w.]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;
const TRIPLE_RE = /\{\{\{([\w.]+)\}\}\}/g;
const VAR_RE = /\{\{([\w.]+)\}\}/g;

// Sections must be processed before inverted sections to avoid the inverted
// regex matching a `{{^x}}...{{/x}}` that's nested inside a `{{#y}}`. Both
// run before variable substitution so the section bodies can themselves
// reference variables resolved against the section's scope. We loop until
// no further rewrites happen so nested sections at any depth resolve.
export function applyTemplate(template, data = {}) {
  if (typeof template !== 'string') return '';
  let result = template;
  let prev;
  // Sections (including nested) — repeat until stable.
  do {
    prev = result;
    result = result.replace(SECTION_RE, (_match, key, content) => {
      const value = resolveKey(data, key);
      if (!isTruthySectionValue(value)) return '';
      if (Array.isArray(value)) {
        return value
          .map((item) => {
            // Mustache spec: when iterating an array of primitives, `{{.}}`
            // refers to the current item; when iterating objects, the item
            // becomes the new context (with the parent context still
            // shadowed for the duration of the section body).
            const itemCtx = (item && typeof item === 'object') ? { ...data, ...item } : { ...data, '.': item };
            return applyTemplate(content, itemCtx);
          })
          .join('');
      }
      if (value && typeof value === 'object') {
        // Object section — narrow the context by spreading the object on
        // top of the parent so dotted lookups inside still see ambient
        // variables (matches the cos-agent-briefing pattern of opening
        // {{#task}} then referencing {{task.id}} or just {{id}}).
        return applyTemplate(content, { ...data, ...value });
      }
      // Truthy primitive (non-empty string, true, number) — keep parent
      // context, just render the body.
      return applyTemplate(content, data);
    });
    result = result.replace(INVERTED_RE, (_match, key, content) => {
      const value = resolveKey(data, key);
      return isTruthySectionValue(value) ? '' : applyTemplate(content, data);
    });
  } while (result !== prev);

  // Triple-mustache emits raw value (already-formatted markdown blocks pass
  // through without HTML-escape semantics — we don't HTML-escape anyway, but
  // surface the distinction so authors can document intent.)
  result = result.replace(TRIPLE_RE, (_match, key) => {
    const value = resolveKey(data, key);
    return value == null ? '' : String(value);
  });
  result = result.replace(VAR_RE, (_match, key) => {
    const value = resolveKey(data, key);
    return value == null ? '' : String(value);
  });
  return result;
}
