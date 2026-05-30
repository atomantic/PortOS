/**
 * Provider-agnostic embedding service.
 *
 * Reads `settings.embeddings = { provider, model }` and routes embedText() to
 * the configured backend (Ollama or LM Studio). When `provider === 'none'` or
 * unset, returns `{ skipped: true }` — callers persist the row without an
 * embedding and a future re-embed admin action backfills.
 *
 * Vector dim is pinned to 768 (matches the `vector(768)` column on memories +
 * catalog_ingredients). Output dim is validated; a mismatch surfaces clearly
 * rather than corrupting the index by silently inserting the wrong-shape vec.
 */

import { getSettings } from './settings.js';
import * as ollama from './ollamaManager.js';
import * as lmstudio from './lmStudioManager.js';

export const EMBEDDING_DIM = 768;

/**
 * Read the configured provider + model.
 * Defaults to `{ provider: 'none' }` so a missing settings slice cleanly
 * degrades to no-embedding mode (rows persist; semantic search returns empty).
 */
export async function getEmbeddingsConfig() {
  const settings = await getSettings();
  const cfg = settings?.embeddings || {};
  return {
    provider: cfg.provider || 'none',
    model: cfg.model || null,
  };
}

/**
 * Embed a single text. Returns:
 *   - `{ skipped: true, reason }` when provider is 'none'/unset
 *   - `{ success: true, embedding, model, provider, dimensions }` on success
 *   - `{ success: false, error, provider, model }` on failure
 */
export async function embedText(text, options = {}) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return { skipped: true, reason: 'empty-text' };
  }

  const cfg = await getEmbeddingsConfig();
  const provider = options.provider || cfg.provider;
  const model = options.model || cfg.model || undefined;

  if (provider === 'none' || !provider) {
    return { skipped: true, reason: 'provider-disabled' };
  }

  let raw;
  if (provider === 'ollama') {
    raw = await ollama.getEmbeddings(text, { model, timeout: options.timeout });
  } else if (provider === 'lmstudio') {
    raw = await lmstudio.getEmbeddings(text, { model, timeout: options.timeout });
  } else {
    return { success: false, error: `Unknown embeddings provider: ${provider}`, provider, model };
  }

  if (!raw?.success) {
    return { success: false, error: raw?.error || 'Embedding request failed', provider, model: raw?.model || model };
  }

  const embedding = raw.embedding || [];
  if (embedding.length !== EMBEDDING_DIM) {
    return {
      success: false,
      error: `Embedding model returned dim=${embedding.length}, expected ${EMBEDDING_DIM}. Pick a 768-dim model (e.g. nomic-embed-text).`,
      provider,
      model: raw.model || model,
    };
  }

  return {
    success: true,
    embedding,
    model: raw.model || model,
    provider,
    dimensions: embedding.length,
  };
}

/**
 * Build the embedding seed text for an ingredient — name + the few payload
 * fields that carry narrative weight. Used by every catalog write path so
 * the seed is consistent across commit, manual create, manual edit, and
 * the admin backfill.
 *
 * Returns `''` when there's nothing worth embedding so callers can skip.
 */
export function ingredientEmbedSeed({ name, payload } = {}) {
  const p = payload || {};
  return [name, p.description, p.summary, p.notes, p.background]
    .filter(Boolean)
    .join(' ')
    .slice(0, 4000);
}

/**
 * Convenience wrapper: build the seed, embed it, and return the
 * `{ embedding, embeddingModel }` slice ready to spread into createIngredient
 * / updateIngredient. Returns `{}` when there's nothing to embed, the
 * provider is unavailable, or the embed failed — the spread becomes a no-op.
 *
 * Logs non-skipped failures (provider down, dim mismatch, unknown error) so
 * a quiet "search is broken" symptom has a paper trail. The batch path in
 * embedBatch already logs; this single-text path was silent before.
 */
export async function embedIngredient(ingredient) {
  const seed = ingredientEmbedSeed(ingredient);
  if (!seed) return {};
  const out = await embedText(seed).catch((err) => {
    console.error(`🧬 embedIngredient threw: ${err?.message || err}`);
    return null;
  });
  if (!out) return {};
  if (out.skipped) return {};
  if (!out.success) {
    console.error(`🧬 embedIngredient failed: ${out.error || 'unknown'} (provider=${out.provider}, model=${out.model || 'unset'})`);
    return {};
  }
  return { embedding: out.embedding, embeddingModel: out.model };
}

/**
 * Embed an array of texts in parallel with a concurrency cap.
 *
 * Used by the catalog backfill and the `/api/catalog/embeddings/backfill`
 * admin action. Per-text failures don't abort the batch — the corresponding
 * slot in the result is `null`, the caller decides whether to skip or retry.
 */
export async function embedBatch(texts, options = {}) {
  const concurrency = Math.max(1, options.concurrency || 4);
  const results = new Array(texts.length).fill(null);

  let next = 0;
  const worker = async () => {
    while (next < texts.length) {
      const i = next++;
      const out = await embedText(texts[i], options);
      if (out.success) {
        results[i] = { embedding: out.embedding, model: out.model, provider: out.provider };
      } else if (out.skipped) {
        results[i] = null;
      } else {
        console.error(`🧬 embedBatch[${i}] failed: ${out.error}`);
        results[i] = null;
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}
