import { isFreeModelId, resolveModelRates, estimateCostUsd } from '../lib/modelPricing.js';
import { roundCents } from '../lib/subscriptionSavings.js';

/**
 * Pure report math over Claude Code per-day, per-model token counts (the shape
 * `claudeCodeTranscriptUsage.js` stores and federates): window sums, API-rate
 * pricing from the shared table, and fleet-wide merging. No I/O.
 */

const COUNT_FIELDS = ['messages', 'input', 'output', 'cacheRead', 'cacheWrite'];
const SUM_FIELDS = [...COUNT_FIELDS, 'total', 'estimatedCost'];

// Group rows by model, sum every field, round the money, and total — the one
// rollup behind both a single instance's window and the fleet-wide merge.
function rollUp(rows) {
  const byModel = new Map();
  for (const row of rows) {
    const acc = byModel.get(row.model) || { model: row.model, ...Object.fromEntries(SUM_FIELDS.map((f) => [f, 0])) };
    for (const f of SUM_FIELDS) acc[f] += row[f] || 0;
    byModel.set(row.model, acc);
  }
  const models = [...byModel.values()]
    .map((row) => ({ ...row, estimatedCost: roundCents(row.estimatedCost) }))
    .sort((a, b) => b.estimatedCost - a.estimatedCost || b.total - a.total);
  const totals = Object.fromEntries(SUM_FIELDS.map((f) => [f, models.reduce((sum, row) => sum + row[f], 0)]));
  totals.estimatedCost = roundCents(totals.estimatedCost);
  return { models, totals };
}

/**
 * Sum a day map over an inclusive window into per-model rows (highest cost
 * first), each priced at API rates. Cache tiers bill at their own rates;
 * local/free model ids cost nothing.
 */
export function summarizeTranscriptDays(days, { from = null, to = null } = {}) {
  const rows = [];
  for (const [day, models] of Object.entries(days || {})) {
    if ((from && day < from) || (to && day > to)) continue;
    for (const [model, c] of Object.entries(models)) {
      const cost = isFreeModelId(model)
        ? 0
        : estimateCostUsd(c.input, c.output, resolveModelRates('claude-code', model), { cacheReadTokens: c.cacheRead, cacheWriteTokens: c.cacheWrite });
      rows.push({ model, ...c, total: c.input + c.output + c.cacheRead + c.cacheWrite, estimatedCost: cost });
    }
  }
  return rollUp(rows);
}

/** Combine several instances' per-model rows into one fleet-wide per-model list. */
export const mergeModelRows = (rowSets) => rollUp(rowSets.flat());
