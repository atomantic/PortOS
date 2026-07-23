/**
 * Layered Intelligence — slug + duplicate detection (#2842 split of layeredIntelligence.js).
 *
 * The `[lil-<slug>]` marker vocabulary, the closed-issue suppression window, the
 * exact-slug dedup check, and the pure cosine-similarity half of semantic dedup.
 * Also the park check (`isAppParked`) that reads the blocking-label issues.
 */

import { CLOSED_SUPPRESSION_MS, SEMANTIC_DEDUP_THRESHOLD } from './constants.js';

/** The HTML-comment slug marker embedded in a filed issue/ticket body. */
export function slugMarker(slug) {
  return `<!-- lil-slug: ${slug} -->`;
}

/** Extract a `lil-slug` marker's value from a body string (null if absent). */
export function extractSlugFromBody(body) {
  if (typeof body !== 'string') return null;
  const m = body.match(/<!--\s*lil-slug:\s*([a-z0-9][a-z0-9-]*)\s*-->/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Normalize a reasoner-chosen slug to a stable kebab id. Returns null for a
 * non-string or an input that reduces to empty (so a bad slug is a no-op, never
 * a mystery label).
 */
export function normalizeSlug(slug) {
  if (typeof slug !== 'string') return null;
  const norm = slug
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return norm || null;
}

/**
 * Whether an existing tracker issue is still within the dedup suppression window:
 * OPEN, or CLOSED within CLOSED_SUPPRESSION_MS. Only a closed-long-ago issue
 * falls out of the window so its work can be re-proposed. A closed issue with a
 * missing/unparseable `closedAt` is PERMANENTLY in-window (suppressed): the main
 * producer of that shape is a checked `- [x]` PLAN.md item (checkboxes carry no
 * timestamp), and a completed plan item never needs re-proposal — treating it as
 * "closed long ago" made the reasoner re-propose every done item on every run
 * (#2620). A tracker row missing its close time (e.g. a jira Done ticket with no
 * resolutiondate) is likewise suppressed rather than re-proposed — done work is
 * never worth re-reasoning. Shared by both the slug dedup and the semantic dedup
 * so the two guards agree on which issues still count.
 */
export function isIssueWithinDedupWindow(issue, now = Date.now()) {
  if ((issue?.state || '').toLowerCase() === 'open') return true;
  const closedAt = issue?.closedAt ? Date.parse(issue.closedAt) : NaN;
  if (!Number.isFinite(closedAt)) return true;
  return now - closedAt <= CLOSED_SUPPRESSION_MS;
}

/**
 * Deterministic dedup guard. Given the slug of the proposed item and the live
 * tracker's existing issues (each `{ slug, state, closedAt }`), suppress the
 * proposal when a match is open, OR closed within CLOSED_SUPPRESSION_MS.
 *
 * `slug` matching is case-insensitive on the normalized slug. `existingIssues`
 * may carry either a parsed `slug` or a raw `body`/`title` we extract from.
 */
export function isProposalDuplicate({ slug, existingIssues = [], now = Date.now() }) {
  const target = normalizeSlug(slug);
  if (!target) return false;
  for (const issue of existingIssues) {
    const issueSlug = issue.slug
      ? normalizeSlug(issue.slug)
      : extractSlugFromBody(issue.body) || extractSlugFromBody(issue.title);
    if (issueSlug !== target) continue;
    if (isIssueWithinDedupWindow(issue, now)) return true;
  }
  return false;
}

/**
 * Build the text to embed for a proposal OR an existing issue — title + body,
 * trimmed and length-capped so a single huge body can't blow the embedding
 * model's context. Both sides go through THIS helper so the proposal and the
 * candidates are embedded from the same seed shape (a fair comparison).
 */
export function issueEmbedSeed({ title = '', body = '' } = {}) {
  const parts = [title, body].map(s => (typeof s === 'string' ? s.trim() : '')).filter(Boolean);
  return parts.join('\n\n').slice(0, 2000);
}

/** Cosine similarity of two equal-length numeric vectors. Returns 0 for a shape
 * mismatch, empty vector, or a zero-magnitude vector (nothing meaningful to
 * compare) rather than NaN, so a bad embedding can never trip the dedup guard. */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Pure near-duplicate finder. Given the proposal's embedding and an array of
 * candidates (each `{ slug?, number?, title?, embedding }`), return the single
 * best candidate whose cosine similarity meets `threshold` (highest score wins),
 * or null when none qualify / the proposal embedding is unusable. Side-effect-free
 * and unit-tested; the I/O layer feeds it real embeddings.
 */
export function findSemanticDuplicate({ proposalEmbedding, candidates = [], threshold = SEMANTIC_DEDUP_THRESHOLD } = {}) {
  if (!Array.isArray(proposalEmbedding) || proposalEmbedding.length === 0) return null;
  let best = null;
  for (const c of candidates) {
    if (!Array.isArray(c?.embedding) || c.embedding.length === 0) continue;
    const score = cosineSimilarity(proposalEmbedding, c.embedding);
    if (score >= threshold && (!best || score > best.score)) {
      best = { slug: c.slug || null, number: c.number ?? null, title: c.title || '', score };
    }
  }
  return best;
}

/**
 * Whether the app is currently PARKED — i.e. has at least one OPEN blocking
 * issue. When parked, the sweep skips the app entirely (no gather, no reason),
 * resuming automatically once the blocking issue closes. Fully tracker-derived.
 */
export function isAppParked(blockingIssues = []) {
  return blockingIssues.some(i => (i.state || '').toLowerCase() === 'open');
}
