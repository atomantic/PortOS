/**
 * Layered Intelligence — embedding-backed semantic dedup (#2842 split of
 * layeredIntelligence.js). The I/O half of `./dedup.js`'s pure cosine helpers:
 * lazily resolves the embedder and scores a proposal against recent issues.
 */

import { SEMANTIC_DEDUP_THRESHOLD, SEMANTIC_DEDUP_MAX_CANDIDATES } from './constants.js';
import { isIssueWithinDedupWindow, issueEmbedSeed, findSemanticDuplicate } from './dedup.js';

/** Lazily resolve the default embedder to keep the embeddings graph out of this pure module; tests inject `embed`. */
async function defaultEmbed(text) {
  const { embedText } = await import('../embeddings.js');
  return embedText(text);
}

/**
 * SEMANTIC dedup guard: the embedding layer on top of slug/label dedup
 * (`isProposalDuplicate`), run only after slug dedup passes. Returns
 * `{ available, duplicate, match }`; `available:false` (nothing embeddable, provider off,
 * embed failed) is a sentinel distinct from "checked, no near-dup": the handler proceeds
 * to file. `match` is the highest-scoring near-duplicate. `embed` degrades to
 * `{ skipped:true }` with no provider (no cold-bootstrap) and is injectable for tests.
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

  // A failing embed must degrade to the available:false sentinel, not reject through
  // processApp. Deferring into a promise chain absorbs both async rejection and a sync throw.
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
