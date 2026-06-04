/**
 * Memory Query Helpers
 *
 * Pure, side-effect-free helpers used by the file-based memory service to
 * project index metadata, filter/sort index entries, apply post-search
 * metadata filters, and fuse BM25 + vector rankings via Reciprocal Rank
 * Fusion (RRF). No module state, no I/O — extracted from memory.js so the
 * orchestration layer stays focused on persistence + event wiring.
 */

/**
 * Project a full memory record down to the lightweight metadata stored in the
 * index. Used on create/update so the index stays consistent everywhere.
 *
 * @param {Object} memory - Full memory record.
 * @returns {Object} Lightweight index entry.
 */
export function projectIndexMeta(memory) {
  return {
    id: memory.id,
    type: memory.type,
    category: memory.category,
    tags: memory.tags,
    summary: memory.summary,
    importance: memory.importance,
    createdAt: memory.createdAt,
    status: memory.status,
    sourceAppId: memory.sourceAppId
  };
}

/**
 * Filter memory index entries by status/type/category/tags/app.
 *
 * @param {Array} memories - Index entries.
 * @param {Object} options - Filter options.
 * @returns {Array} Filtered entries.
 */
export function filterMemoryIndex(memories, options = {}) {
  // Filter by status
  const status = options.status || 'active';
  let filtered = memories.filter(m => m.status === status);

  // Filter by types
  if (options.types && options.types.length > 0) {
    filtered = filtered.filter(m => options.types.includes(m.type));
  }

  // Filter by categories
  if (options.categories && options.categories.length > 0) {
    filtered = filtered.filter(m => options.categories.includes(m.category));
  }

  // Filter by tags (any match)
  if (options.tags && options.tags.length > 0) {
    filtered = filtered.filter(m => m.tags.some(t => options.tags.includes(t)));
  }

  // Filter by app
  if (options.appId === '__not_brain') {
    filtered = filtered.filter(m => m.sourceAppId !== 'brain');
  } else if (options.appId) {
    filtered = filtered.filter(m => m.sourceAppId === options.appId);
  }

  return filtered;
}

/**
 * Comparator for sorting index entries by an arbitrary field, treating values
 * as dates when both parse, numbers when both numeric, strings otherwise.
 * Missing values sort last. Returns a comparator bound to the sort field/order.
 *
 * @param {string} sortBy - Field name to sort by.
 * @param {'asc'|'desc'} sortOrder - Sort direction.
 * @returns {(a: Object, b: Object) => number}
 */
export function compareMemoryEntries(sortBy = 'createdAt', sortOrder = 'desc') {
  return (a, b) => {
    const aRaw = a[sortBy];
    const bRaw = b[sortBy];

    // Missing values sort last
    const aMissing = aRaw === null || aRaw === undefined;
    const bMissing = bRaw === null || bRaw === undefined;
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;

    // Compare as dates if both parse as valid timestamps
    const aTime = (typeof aRaw === 'string' || aRaw instanceof Date) ? Date.parse(aRaw) : NaN;
    const bTime = (typeof bRaw === 'string' || bRaw instanceof Date) ? Date.parse(bRaw) : NaN;
    if (!Number.isNaN(aTime) && !Number.isNaN(bTime)) {
      const diff = aTime - bTime;
      return sortOrder === 'desc' ? (diff === 0 ? 0 : diff < 0 ? 1 : -1) : (diff === 0 ? 0 : diff < 0 ? -1 : 1);
    }

    // Numeric comparison
    if (typeof aRaw === 'number' && typeof bRaw === 'number') {
      const diff = aRaw - bRaw;
      return sortOrder === 'desc' ? (diff === 0 ? 0 : diff < 0 ? 1 : -1) : (diff === 0 ? 0 : diff < 0 ? -1 : 1);
    }

    // String fallback
    const aStr = String(aRaw);
    const bStr = String(bRaw);
    if (aStr === bStr) return 0;
    const cmp = aStr < bStr ? -1 : 1;
    return sortOrder === 'desc' ? -cmp : cmp;
  };
}

/**
 * Post-search metadata filter for semantic (vector) search. Requires the entry
 * to be active and pass any type/category/tag/app constraints. Handles the
 * `__not_brain` app sentinel.
 *
 * @param {Object|undefined} meta - Index entry for a search hit.
 * @param {Object} options - Search filter options.
 * @returns {boolean} Whether the entry passes all filters.
 */
export function passesSearchMetaFilters(meta, options = {}) {
  if (!meta || meta.status !== 'active') return false;
  if (options.types && options.types.length > 0 && !options.types.includes(meta.type)) return false;
  if (options.categories && options.categories.length > 0 && !options.categories.includes(meta.category)) return false;
  if (options.tags && options.tags.length > 0 && !meta.tags.some(t => options.tags.includes(t))) return false;
  if (options.appId === '__not_brain' && meta.sourceAppId === 'brain') return false;
  if (options.appId && options.appId !== '__not_brain' && meta.sourceAppId !== options.appId) return false;
  return true;
}

/**
 * Post-search metadata filter for hybrid search. Requires the entry to be
 * active and pass any type/category/tag/app constraints. Does NOT special-case
 * the `__not_brain` sentinel (matches the original inline behavior).
 *
 * @param {Object|undefined} meta - Index entry for a search hit.
 * @param {Object} options - Search filter options.
 * @returns {boolean} Whether the entry passes all filters.
 */
export function passesHybridMetaFilters(meta, options = {}) {
  if (!meta || meta.status !== 'active') return false;
  if (options.types?.length > 0 && !options.types.includes(meta.type)) return false;
  if (options.categories?.length > 0 && !options.categories.includes(meta.category)) return false;
  if (options.tags?.length > 0 && !meta.tags.some(t => options.tags.includes(t))) return false;
  if (options.appId && meta.sourceAppId !== options.appId) return false;
  return true;
}

/** Standard RRF constant. */
export const RRF_K = 60;

/**
 * Fuse BM25 and vector rankings via Reciprocal Rank Fusion (RRF).
 * RRF score = sum(weight / (k + rank)) across all rankings.
 *
 * @param {Array<{id: string}>} bm25Results - BM25 hits in rank order.
 * @param {Array<{id: string}>} vectorResults - Vector hits in rank order.
 * @param {Object} weights - { ftsWeight, vectorWeight }.
 * @returns {Map<string, {bm25Rank: number|null, vectorRank: number|null, rrfScore: number}>}
 */
export function fuseRankingsRRF(bm25Results, vectorResults, { ftsWeight, vectorWeight }) {
  const rrfScores = new Map();

  // Add BM25 contributions
  bm25Results.forEach((result, rank) => {
    const current = rrfScores.get(result.id) || { bm25Rank: null, vectorRank: null, rrfScore: 0 };
    current.bm25Rank = rank + 1;
    current.rrfScore += ftsWeight / (RRF_K + rank + 1);
    rrfScores.set(result.id, current);
  });

  // Add vector contributions
  vectorResults.forEach((result, rank) => {
    const current = rrfScores.get(result.id) || { bm25Rank: null, vectorRank: null, rrfScore: 0 };
    current.vectorRank = rank + 1;
    current.rrfScore += vectorWeight / (RRF_K + rank + 1);
    rrfScores.set(result.id, current);
  });

  return rrfScores;
}
