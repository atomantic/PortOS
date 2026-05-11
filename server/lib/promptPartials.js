/**
 * Mustache-style partial expansion for PortOS prompt templates.
 *
 * `applyTemplate` (server/lib/promptTemplate.js) is intentionally sync + pure
 * — it doesn't read the filesystem. Partial support lives here as a separate
 * pre-processing pass so `buildPrompt` can expand `{{> partial-name }}`
 * references into inline text before handing the result to `applyTemplate`
 * for variable + section substitution.
 *
 * Convention: partials live at `<promptsDir>/_partials/<name>.md`. The leading
 * underscore makes the directory clearly non-stage (the toolkit's stage
 * loader scans `<promptsDir>/stages/`, so partials don't pollute the
 * stage list). Partial names accept `[A-Za-z0-9_-]+`; no slashes — partials
 * are flat, one directory.
 *
 * Recursion: a partial may itself include another partial. The expander runs
 * to a fixed point with a depth guard (default 8 levels) so a self-referencing
 * partial fails loudly instead of looping forever.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

const PARTIAL_RE = /\{\{>\s*([A-Za-z0-9_-]+)\s*\}\}/g;
const MAX_DEPTH = 8;

/**
 * Find every `{{> name }}` reference in a template and return the unique
 * partial names. Used to pre-load partials before `applyTemplate` (so the
 * expansion step doesn't need to be async at every call site).
 */
export function listPartialReferences(template) {
  if (typeof template !== 'string' || !template) return [];
  const names = new Set();
  let m;
  PARTIAL_RE.lastIndex = 0;
  while ((m = PARTIAL_RE.exec(template)) !== null) names.add(m[1]);
  return [...names];
}

/**
 * Synchronous expander: takes a `(name) => string|null` resolver and rewrites
 * every `{{> name }}` reference to the partial body. Recurses to MAX_DEPTH —
 * a deeper chain throws so a partial cycle can't loop forever.
 */
export function expandPartialsWithResolver(template, resolve, depth = 0) {
  if (typeof template !== 'string') return '';
  if (!template.includes('{{>')) return template;
  if (depth >= MAX_DEPTH) {
    throw new Error(`Prompt partial expansion exceeded MAX_DEPTH=${MAX_DEPTH} — likely a cyclic partial`);
  }
  let changed = false;
  const next = template.replace(PARTIAL_RE, (_match, name) => {
    const body = resolve(name);
    if (body == null) {
      // A missing partial should fail loudly, not silently render an empty
      // block — otherwise a typo in `{{> visual-grammr }}` evaporates the
      // entire intended instruction without any signal at preview time.
      throw new Error(`Prompt partial not found: "${name}"`);
    }
    changed = true;
    return body;
  });
  return changed ? expandPartialsWithResolver(next, resolve, depth + 1) : next;
}

/**
 * Convenience async wrapper: pre-load every partial referenced in the
 * template (including transitively-referenced ones) from disk, build a
 * synchronous resolver, then expand.
 *
 * @param {string} template       — raw stage template text
 * @param {object} opts
 * @param {string} opts.partialsDir — absolute path to `<promptsDir>/_partials/`
 */
export async function expandPartials(template, { partialsDir } = {}) {
  if (typeof template !== 'string' || !template.includes('{{>')) return template;
  if (!partialsDir) throw new Error('expandPartials: partialsDir is required');

  const cache = new Map();
  async function loadOne(name) {
    if (cache.has(name)) return cache.get(name);
    const path = join(partialsDir, `${name}.md`);
    if (!existsSync(path)) {
      cache.set(name, null);
      return null;
    }
    const body = await readFile(path, 'utf-8');
    cache.set(name, body);
    return body;
  }

  // Walk the include graph breadth-first so every referenced partial is
  // cached before the synchronous expander runs. Without this pre-walk we'd
  // have to make the resolver async, which means making applyTemplate async,
  // which ripples into every caller.
  const queue = listPartialReferences(template);
  const visited = new Set();
  while (queue.length) {
    const name = queue.shift();
    if (visited.has(name)) continue;
    visited.add(name);
    const body = await loadOne(name);
    if (body) {
      for (const ref of listPartialReferences(body)) {
        if (!visited.has(ref)) queue.push(ref);
      }
    }
  }

  return expandPartialsWithResolver(template, (name) => cache.get(name) ?? null);
}
