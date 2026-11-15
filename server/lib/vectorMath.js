/**
 * Vector Math Utilities
 *
 * Vector math utilities (cosine, etc.).
 *
 * Pure functions for vector operations used in semantic search.
 */

/**
 * Calculate cosine similarity between two vectors
 * Returns value between -1 and 1, where 1 means identical direction
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Normalize a vector to unit length
 */
export function normalize(v) {
  if (!v || v.length === 0) return [];

  let norm = 0;
  for (let i = 0; i < v.length; i++) {
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm);

  if (norm === 0) return v.map(() => 0);
  return v.map(x => x / norm);
}

/**
 * Find top K most similar vectors from a collection
 * Returns array of { id, similarity } sorted by similarity descending
 */
export function findTopK(queryVector, vectors, k = 10) {
  if (!queryVector || !vectors || Object.keys(vectors).length === 0) {
    return [];
  }

  const similarities = Object.entries(vectors).map(([id, vector]) => ({
    id,
    similarity: cosineSimilarity(queryVector, vector)
  }));

  similarities.sort((a, b) => b.similarity - a.similarity);

  return similarities.slice(0, k);
}

/**
 * Find vectors above a similarity threshold
 * Returns array of { id, similarity } sorted by similarity descending
 */
export function findAboveThreshold(queryVector, vectors, threshold = 0.7) {
  if (!queryVector || !vectors || Object.keys(vectors).length === 0) {
    return [];
  }

  const results = Object.entries(vectors)
    .map(([id, vector]) => ({
      id,
      similarity: cosineSimilarity(queryVector, vector)
    }))
    .filter(item => item.similarity >= threshold);

  results.sort((a, b) => b.similarity - a.similarity);

  return results;
}

/**
 * Cluster vectors by similarity using simple single-linkage clustering
 * Returns array of clusters, each cluster is array of { id, vector }
 */
export function clusterBySimilarity(items, threshold = 0.9) {
  if (!items || items.length === 0) return [];

  const clusters = [];
  const assigned = new Set();

  for (const item of items) {
    if (assigned.has(item.id)) continue;

    const cluster = [item];
    assigned.add(item.id);

    for (const other of items) {
      if (assigned.has(other.id)) continue;

      const similarity = cosineSimilarity(item.embedding, other.embedding);
      if (similarity >= threshold) {
        cluster.push(other);
        assigned.add(other.id);
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}

/**
 * Clamp `value` into `[min, max]`. Propagates NaN (returns NaN) so callers' finite checks still see it.
 */
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
