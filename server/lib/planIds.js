/**
 * Plan-item IDs — utilities for giving every `- [ ]` checkbox in PLAN.md a
 * stable slug ID so concurrent agents can claim distinct items by encoding
 * the ID in their worktree branch name (`cos/<task.id>/<planId>/<agentId>`).
 *
 * Public API:
 *   - slugify(title, takenIds)            → string  (deterministic, unique within `takenIds`)
 *   - parsePlanItems(markdown)            → PlanItem[]
 *   - assignMissingIds(markdown, extraIds)→ { content, assigned[] }
 *   - extractAllIds(markdown)             → string[]   (every `[slug]` in PLAN.md)
 *   - findInProgressIds(repoPath, ids)    → Set<string> (subset present in branch/PR names)
 *   - pickFirstAvailable(items, takenIds) → PlanItem | null
 *
 * @typedef {Object} PlanItem
 * @property {number} lineNumber   1-indexed
 * @property {string} indent       leading whitespace
 * @property {boolean} checked     true for `- [x]`
 * @property {string|null} id      slug if present, else null
 * @property {string} rest         everything after the `[id]` slot (or after `[x]/[ ]` if no id)
 * @property {boolean} needsInput  true if line carries the `<!-- NEEDS_INPUT -->` marker
 * @property {boolean} drifted     true if the immediately-preceding line starts with `> ⚠️ DRIFT:`
 */

import { execGit } from './execGit.js';
import { spawn } from 'child_process';

const SLUG_MAX_LEN = 50;
const CHECKBOX_RE = /^(?<indent>\s*)-\s+\[(?<box>[ xX])\]\s+(?:\[(?<id>[a-z0-9][a-z0-9-]*)\]\s+)?(?<rest>.*)$/;
const NEEDS_INPUT_RE = /<!--\s*NEEDS_INPUT\s*-->/;
const DRIFT_LINE_RE = /^\s*>\s*⚠️\s*DRIFT:/;

/**
 * Strip common markdown wrappers from a title fragment.
 * - `**bold**`     → `bold`
 * - `~~struck~~`   → `struck`
 * - `` `code` ``   → `code`
 * - `[text](url)`  → `text`
 * - HTML comments  → removed
 */
function stripMarkdown(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/[*_~]/g, ' ');
}

/**
 * Lowercase + kebab-case a string, ASCII-only, collapse repeats.
 */
function kebab(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Truncate a kebab string at the last `-` boundary at or before `max`.
 * Falls back to a hard cut if no boundary exists in range.
 */
function truncateOnBoundary(slug, max) {
  if (slug.length <= max) return slug;
  const cut = slug.lastIndexOf('-', max);
  return (cut > 0 ? slug.slice(0, cut) : slug.slice(0, max)).replace(/-+$/, '');
}

/**
 * Derive a unique slug for `title`, avoiding any string in `takenIds`.
 * Deterministic for the same (title, takenIds) inputs.
 *
 * `takenIds` may be a Set or an array. It is not mutated.
 */
export function slugify(title, takenIds = new Set()) {
  const taken = takenIds instanceof Set ? takenIds : new Set(takenIds);
  const base = truncateOnBoundary(kebab(stripMarkdown(String(title || ''))), SLUG_MAX_LEN) || 'item';
  if (!taken.has(base)) return base;
  // Collision: append -2, -3, ... — keep the suffix inside SLUG_MAX_LEN.
  for (let n = 2; n < 10000; n++) {
    const suffix = `-${n}`;
    const trimmedBase = base.length + suffix.length > SLUG_MAX_LEN
      ? truncateOnBoundary(base, SLUG_MAX_LEN - suffix.length)
      : base;
    const candidate = `${trimmedBase}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`slugify exhausted collision space for title: ${title}`);
}

/**
 * Parse every `- [ ]` / `- [x]` line in a PLAN.md-style markdown document.
 * Returns one PlanItem per checkbox line, in document order.
 */
export function parsePlanItems(markdown) {
  if (!markdown) return [];
  const lines = markdown.split('\n');
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const m = CHECKBOX_RE.exec(lines[i]);
    if (!m) continue;
    const { indent, box, id, rest } = m.groups;
    items.push({
      lineNumber: i + 1,
      indent: indent || '',
      checked: box.toLowerCase() === 'x',
      id: id || null,
      rest: rest || '',
      needsInput: NEEDS_INPUT_RE.test(rest || ''),
      drifted: DRIFT_LINE_RE.test(lines[i - 1] || '')
    });
  }
  return items;
}

/**
 * Return every `[slug]` ID that appears in a PLAN.md-style document.
 * Captures both checkbox-prefixed IDs (parsePlanItems) AND any `[slug]`
 * marker embedded inline in narrative copy (e.g. cross-references in
 * design-log entries left as `- [x] [slug] …` for posterity).
 */
export function extractAllIds(markdown) {
  if (!markdown) return [];
  const ids = new Set();
  for (const item of parsePlanItems(markdown)) {
    if (item.id) ids.add(item.id);
  }
  // Pick up inline `[slug]` markers not on checkbox lines (e.g. design-log
  // back-references in `## Shipped` sections or PR descriptions inlined here).
  // Length range 2–81 chars is intentionally wider than slugify()'s 50-char
  // cap so historical slugs that exceeded the modern length limit are still
  // recognized for the uniqueness check (we never want to re-issue one).
  const inlineRe = /\[([a-z0-9][a-z0-9-]{1,80})\]/g;
  let m;
  while ((m = inlineRe.exec(markdown)) !== null) {
    // Skip markdown links: `[text](url)` — only count when not immediately followed by `(`
    const after = markdown[m.index + m[0].length];
    if (after === '(') continue;
    ids.add(m[1]);
  }
  return [...ids];
}

/**
 * Assign a slug ID to every `- [ ]` / `- [x]` line that doesn't already have one.
 * Idempotent: existing IDs are preserved verbatim. `extraIds` lets the caller
 * pass IDs from sibling sources (e.g. an in-flight branch scan) into the
 * uniqueness check.
 *
 * @param {string} markdown
 * @param {string[]|Set<string>} extraIds
 * @returns {{ content: string, assigned: Array<{ id: string, title: string, lineNumber: number }> }}
 */
export function assignMissingIds(markdown, extraIds = []) {
  if (!markdown) return { content: markdown || '', assigned: [] };
  const taken = new Set([...extractAllIds(markdown), ...extraIds]);
  const lines = markdown.split('\n');
  const assigned = [];
  for (let i = 0; i < lines.length; i++) {
    const m = CHECKBOX_RE.exec(lines[i]);
    if (!m) continue;
    if (m.groups.id) continue;
    const rest = m.groups.rest || '';
    const id = slugify(rest, taken);
    taken.add(id);
    lines[i] = `${m.groups.indent || ''}- [${m.groups.box}] [${id}] ${rest}`;
    assigned.push({ id, title: rest, lineNumber: i + 1 });
  }
  return { content: lines.join('\n'), assigned };
}

/**
 * Classify why no PLAN.md item is currently dispatchable, for `plan-task`
 * gating. Returns null when an agent dispatch should proceed (an item is
 * pickable, or the state is recoverable — e.g. missing IDs that `do-replan`
 * will fix on its own pass). Returns a human-readable reason string when
 * the dispatch should be skipped entirely so the LLM isn't spun up just
 * to exit cleanly.
 *
 * Skip cases:
 *   - PLAN.md missing or empty.
 *   - No `- [ ]` items at all.
 *   - Every unchecked item is blocked on human input (`<!-- NEEDS_INPUT -->`
 *     annotation, or the preceding line starts with `> ⚠️ DRIFT:`).
 *   - Every unchecked item is either blocked on human input OR already
 *     claimed by another agent (in-flight by branch/PR scan).
 *
 * Either `planMd` or `parsedItems` must be supplied. When the caller has
 * already run `parsePlanItems(planMd)` (e.g. `applyPlanIdMetadata` does this
 * for the pick step), passing `parsedItems` here avoids a redundant parse;
 * `planMd` can then be passed as `null`.
 *
 * @param {string|null} planMd                 PLAN.md content, or null if parsedItems is supplied
 * @param {Set<string>|string[]} inFlightIds   IDs currently claimed elsewhere
 * @param {PlanItem[]|null} [parsedItems]      pre-parsed items, avoids re-parsing planMd
 * @returns {string | null}                    skip reason, or null when dispatch should proceed
 */
export function diagnoseUnpickablePlan(planMd, inFlightIds = new Set(), parsedItems = null) {
  if (!planMd && !parsedItems) return 'PLAN.md missing or empty';
  const inFlight = inFlightIds instanceof Set ? inFlightIds : new Set(inFlightIds);
  const items = parsedItems || parsePlanItems(planMd);
  const unchecked = items.filter(i => !i.checked);
  if (unchecked.length === 0) return 'PLAN.md has no unchecked items';

  const isBlockedByHuman = (i) => i.needsInput || i.drifted;
  if (unchecked.every(isBlockedByHuman)) {
    return 'all PLAN.md items are blocked on human input (NEEDS_INPUT / DRIFT)';
  }
  if (unchecked.every(i => isBlockedByHuman(i) || (i.id && inFlight.has(i.id)))) {
    return 'all PLAN.md items are claimed by other agents or blocked on human input';
  }
  return null;
}

/**
 * Pick the first `- [ ]` item that is not checked, not annotated NEEDS_INPUT,
 * not already in flight, and (if `requireId`) carries an ID.
 *
 * @param {PlanItem[]} items
 * @param {Set<string>|string[]} takenIds  IDs currently claimed by another agent
 * @param {{ requireId?: boolean }} [options]
 */
export function pickFirstAvailable(items, takenIds = new Set(), options = {}) {
  const taken = takenIds instanceof Set ? takenIds : new Set(takenIds);
  const requireId = options.requireId !== false; // default true
  for (const item of items) {
    if (item.checked) continue;
    if (item.needsInput) continue;
    if (item.drifted) continue;
    if (requireId && !item.id) continue;
    if (item.id && taken.has(item.id)) continue;
    return item;
  }
  return null;
}

/**
 * Promise-wrapped `gh pr list` — separated from execGit because `gh` is
 * not always installed on every host. Returns an empty array on any failure.
 */
function listOpenPullRequestHeadRefs(repoPath) {
  return new Promise(resolve => {
    const child = spawn('gh', ['pr', 'list', '--state', 'open', '--json', 'headRefName', '-q', '.[].headRefName'], {
      cwd: repoPath,
      shell: false,
      windowsHide: true
    });
    let out = '';
    let errored = false;
    child.on('error', () => { errored = true; resolve([]); });
    child.stdout.on('data', chunk => { out += chunk.toString(); });
    child.on('close', code => {
      if (errored) return;
      if (code !== 0) return resolve([]);
      resolve(out.split('\n').map(s => s.trim()).filter(Boolean));
    });
    setTimeout(() => { try { child.kill(); } catch { /* noop */ } resolve([]); }, 15000);
  });
}

/**
 * Extract the PLAN.md slug from a git ref ONLY when the ref matches one of
 * the two documented claim patterns:
 *   - `claim/<slug>`                       (human / TUI / scheduler path)
 *   - `cos/<task>/<slug>/<agent>`          (CoS sub-agent path)
 * after stripping any single leading remote prefix (e.g. `origin/`).
 *
 * Returns null for refs that don't match — e.g. `feature/foo`, `main`,
 * `release`, or `origin/HEAD`. Without this gate, the segment-walking
 * approach would falsely flag any slug literally named `main`, `fix`,
 * `feature`, `release`, `dev`, etc. as in-flight against virtually every
 * branch in the repo, which would then suppress every plan-task dispatch.
 */
export function extractSlugFromRef(ref) {
  if (typeof ref !== 'string' || !ref) return null;
  const stripped = /^[^/]+\/(claim|cos)\//.test(ref)
    ? ref.replace(/^[^/]+\//, '')
    : ref;
  const m1 = /^claim\/(.+)$/.exec(stripped);
  if (m1) return m1[1];
  const m2 = /^cos\/[^/]+\/([^/]+)\/[^/]+$/.exec(stripped);
  if (m2) return m2[1];
  return null;
}

/**
 * Find which of `knownIds` are currently in flight, as evidenced by an open
 * git branch (local or remote) or open PR with the slug encoded into a
 * documented claim ref pattern (`claim/<slug>` or `cos/<task>/<slug>/<agent>`).
 *
 * `repoPath` is the repository to query. Best-effort: missing git, missing gh,
 * or fetch failure all degrade silently and return what evidence is available.
 *
 * @param {string} repoPath
 * @param {string[]|Set<string>} knownIds
 * @returns {Promise<Set<string>>}
 */
export async function findInProgressIds(repoPath, knownIds) {
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds);
  if (known.size === 0) return new Set();

  // Best-effort fetch so remote branches are current
  await execGit(['fetch', '--prune'], repoPath).catch(() => {});

  const [branchOutput, prHeadRefs] = await Promise.all([
    execGit(
      ['branch', '-a', '--no-color', '--format=%(refname:short)'],
      repoPath,
      { ignoreExitCode: true }
    ).then(r => r.stdout || '').catch(() => ''),
    listOpenPullRequestHeadRefs(repoPath)
  ]);

  const refs = [
    ...branchOutput.split('\n'),
    ...prHeadRefs
  ].map(s => s.trim()).filter(Boolean);

  const inFlight = new Set();
  for (const ref of refs) {
    const slug = extractSlugFromRef(ref);
    if (slug && known.has(slug)) inFlight.add(slug);
  }
  return inFlight;
}
