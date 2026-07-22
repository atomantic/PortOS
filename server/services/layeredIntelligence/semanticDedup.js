/**
 * Layered Intelligence — embedding-backed semantic dedup (#2842 split of
 * layeredIntelligence.js). The I/O half of `./dedup.js`'s pure cosine helpers:
 * lazily resolves the embedder and scores a proposal against recent issues.
 */

import { SEMANTIC_DEDUP_THRESHOLD, SEMANTIC_DEDUP_MAX_CANDIDATES } from './constants.js';
import { isIssueWithinDedupWindow, issueEmbedSeed, findSemanticDuplicate } from './dedup.js';

/** Lazily resolve the default embedder so the pure module doesn't statically pull
 * in the embeddings/settings/provider graph (matches the handler's dynamic-import
 * pattern for heavy deps). Only reached in production — tests inject `embed`. */
async function defaultEmbed(text) {
  const { embedText } = await import('../embeddings.js');
  return embedText(text);
}

/**
 * SEMANTIC dedup guard — the embedding-similarity layer ON TOP OF the exact
 * slug/label dedup (`isProposalDuplicate`). Catches a proposal that describes the
 * same work as an existing issue but was worded differently (so its slug differs).
 * Runs only AFTER slug dedup passes, so it's a best-effort extra catch.
 *
 * Returns `{ available, duplicate, match }`:
 *   - `available:false` when semantic dedup couldn't run (no embeddable candidates,
 *     or the embeddings provider is off / the proposal embed failed). This is a
 *     SENTINEL, distinct from `available:true, duplicate:false` ("checked, no
 *     near-dup"): the handler treats unavailable as "proceed to file" because slug
 *     dedup already guarded the exact case — losing the semantic catch just
 *     restores pre-feature behavior, it never files a slug-duplicate.
 *   - `duplicate:true` with `match` = the highest-scoring near-duplicate issue.
 *
 * No cold-bootstrap risk: `embed` degrades to `{ skipped:true }` when no
 * embeddings provider is configured, and this only runs inside the user-enabled
 * scheduled sweep. `embed` is injectable for tests.
 */
export async function checkSemanticDuplicate({ proposal, existingIssues = [], now = Date.now(), embed = defaultEmbed, threshold = SEMANTIC_DEDUP_THRESHOLD } = {}) {
  const unavailable = { available: false, duplicate: false, match: null };
  if (!proposal || typeof proposal !== 'object') return unavailable;

  // Only issues still within the dedup window with SOMETHING to embed are worth
  // comparing; a plan-tracked slug-only issue (no title/body) can't be embedded.
  const candidates = existingIssues
    .filter(i => isIssueWithinDedupWindow(i, now) && (i.body || i.title))
    .slice(0, SEMANTIC_DEDUP_MAX_CANDIDATES);
  if (candidates.length === 0) return unavailable;

  // A failing embed (transient provider blip, malformed response) must degrade to
  // the available:false sentinel — NOT reject through processApp and mark the
  // whole app run 'error'. Deferring the call into a promise chain then catching
  // absorbs BOTH an async rejection AND a synchronous throw from the (injectable)
  // embedder, mirroring this file's fetchHttpSource / jira-search failure idiom
  // (no non-boundary try/catch).
  const safeEmbed = (text) => Promise.resolve().then(() => embed(text)).catch(() => null);

  const proposalRes = await safeEmbed(issueEmbedSeed({ title: proposal.title, body: proposal.body }));
  if (!proposalRes?.success || !Array.isArray(proposalRes.embedding)) return unavailable;

  const embedded = [];
  for (const c of candidates) {
    const res = await safeEmbed(issueEmbedSeed({ title: c.title, body: c.body }));
    if (res?.success && Array.isArray(res.embedding)) {
      embedded.push({ slug: c.slug || null, number: c.number ?? null, title: c.title || '', embedding: res.embedding });
    }
  }
  if (embedded.length === 0) return unavailable;

  const match = findSemanticDuplicate({ proposalEmbedding: proposalRes.embedding, candidates: embedded, threshold });
  return { available: true, duplicate: !!match, match };
}
