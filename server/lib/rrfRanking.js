/**
 * Reciprocal Rank Fusion (RRF) scoring helper.
 *
 * Pure function — no imports from services. Extracted from
 * server/services/catalogDB.js hybridSearchIngredients (inline ~64 lines).
 *
 * RRF merges two ranked lists (e.g. FTS + vector similarity) into a single
 * score: score += weight / (K + rank) for each list the item appears in.
 * Default K=60 follows the original Cormack et al. paper.
 *
 * References:
 *   Cormack, G.V., Clarke, C.L., Buettcher, S. (2009). Reciprocal Rank Fusion
 *   outperforms Condorcet and individual Rank Learning Methods.
 */

/**
 * Merge two ranked result arrays via Reciprocal Rank Fusion.
 *
 * @param {Array<object>} textResults   - FTS results in rank order (best first).
 *   Each element must have an `id` field. The `row` property is passed through
 *   to the caller so the DB row can be mapped after scoring.
 * @param {Array<object>} vectorResults - Vector similarity results in rank order.
 * @param {object} [options]
 * @param {number} [options.k=60]           - RRF smoothing constant.
 * @param {number} [options.ftsWeight=0.4]  - Score contribution weight for FTS ranks.
 * @param {number} [options.vectorWeight=0.6] - Score contribution weight for vector ranks.
 * @returns {Map<string|number, { row: object, ftsRank: number|null, vectorRank: number|null, rrfScore: number }>}
 *   Map keyed by item id. Callers sort and slice as needed.
 */
export function reciprocalRankFusion(textResults, vectorResults, options = {}) {
  const { k = 60, ftsWeight = 0.4, vectorWeight = 0.6 } = options;
  const rrf = new Map();

  (textResults || []).forEach((row, rank) => {
    const cur = rrf.get(row.id) || { row, ftsRank: null, vectorRank: null, rrfScore: 0 };
    cur.row = row;
    cur.ftsRank = rank + 1;
    cur.rrfScore += ftsWeight / (k + rank + 1);
    rrf.set(row.id, cur);
  });

  (vectorResults || []).forEach((row, rank) => {
    const cur = rrf.get(row.id) || { row, ftsRank: null, vectorRank: null, rrfScore: 0 };
    if (!cur.row) cur.row = row;
    cur.vectorRank = rank + 1;
    cur.rrfScore += vectorWeight / (k + rank + 1);
    rrf.set(row.id, cur);
  });

  return rrf;
}
