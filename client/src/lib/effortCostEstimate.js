/**
 * Fill the gaps in an Artificial Analysis reasoning-effort curve.
 *
 * AA publishes `cost per Intelligence Index task` for only a fraction of the
 * catalog — typically the headline (max-effort) variant of a model, never the
 * lower-effort ones. Their own model pages render "Cost per Intelligence Index
 * task: Unknown" for those rows, so the number is not available to research or
 * to a re-sync; it simply is not published. The chart's published-cost basis
 * therefore drops every sub-max effort point and a model that ships a full
 * low → max curve (Claude Fable 5.1, Gemini 3.8 Flash, Claude Sonnet 5)
 * collapses to a single dot with no curve at all.
 *
 * What IS published for those rows is the model's quality at each effort, and
 * a cost anchor at one effort of the same model. Cost per task across efforts
 * is driven by reasoning-token volume, which scales with effort in a shape
 * that is consistent between model families: every family that publishes a
 * complete curve spends roughly 1/6 of its max-effort cost at low, 1/3 at
 * medium, 1/2 at high and 3/4 at xhigh. `deriveEffortCostRatios` measures that
 * shape from the catalog itself rather than hardcoding it — the table
 * re-calibrates on every sync — and `withEstimatedCosts` rescales it onto each
 * family's own published anchor.
 *
 * The result is an ESTIMATE and is marked as one (`costEstimated`): measured
 * against the families that do publish a full curve, leave-one-out error is
 * ~24% median. That is well inside the order-of-magnitude spread of the cost
 * axis, which is what the chart is read against — but it is never written to
 * the catalog and never presented as a published figure.
 */

// Reasoning efforts that form an ordered cost ladder. 'unspecified' and the
// bare 'reasoning'/'non-reasoning' pair are model-level configurations rather
// than points on a ladder, so they neither calibrate nor receive an estimate.
export const EFFORT_LADDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];

const rank = effort => EFFORT_LADDER.indexOf(effort);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** A ladder row carrying a published cost is what both calibration and anchoring run on. */
const isPriced = row =>
  rank(row.effort) >= 0 && Number.isFinite(row.costPerTask?.value) && row.costPerTask.value > 0;

const familyKey = row => `${row.benchmark} :: ${row.model}`;

function groupByFamily(observations) {
  const families = new Map();
  for (const row of observations) {
    const key = familyKey(row);
    if (!families.has(key)) families.set(key, []);
    families.get(key).push(row);
  }
  return families;
}

/** Highest-effort priced row of a family — its anchor. Linear, no sort. */
function anchorOf(rows) {
  let anchor;
  for (const row of rows) {
    if (!isPriced(row)) continue;
    if (!anchor || rank(row.effort) > rank(anchor.effort)) anchor = row;
  }
  return anchor;
}

function ratiosFromFamilies(families) {
  const calibrating = [];
  for (const rows of families.values()) {
    const priced = rows.filter(isPriced);
    if (priced.length >= 2) calibrating.push({ priced, anchor: anchorOf(priced) });
  }
  // Every sample has to share one denominator. A family whose top published cost
  // is xhigh contributes xhigh/xhigh = 1 to the same pool as a complete family's
  // xhigh/max ≈ 0.72, and the median across those two denominators is not a ratio
  // of anything — so the baseline is the highest effort any family is anchored at,
  // and only families anchored there calibrate. Reading it from the data rather
  // than naming 'max' keeps it right if the ladder grows a rung above it.
  const baseline = calibrating.reduce(
    (best, family) => (best === null || rank(family.anchor.effort) > rank(best) ? family.anchor.effort : best),
    null
  );

  const samples = new Map();
  for (const { priced, anchor } of calibrating) {
    if (anchor.effort !== baseline) continue;
    for (const row of priced) {
      if (!samples.has(row.effort)) samples.set(row.effort, []);
      samples.get(row.effort).push(row.costPerTask.value / anchor.costPerTask.value);
    }
  }
  const ratios = new Map();
  for (const [effort, values] of samples) ratios.set(effort, median(values));
  return ratios;
}

/**
 * Median published cost of each effort relative to its family's anchor effort.
 * Only families publishing two or more ladder costs can calibrate a shape.
 */
export function deriveEffortCostRatios(observations) {
  return ratiosFromFamilies(groupByFamily(observations));
}

/**
 * Returns the observations with an `estimatedCostPerTask` on every ladder row
 * that has no published cost but whose model publishes one at another effort.
 * Rows keep their original `costPerTask` untouched and `costEstimated` flags the
 * ones whose plotted cost came from the ratio model; a row that gets no estimate
 * is returned unchanged, so downstream identity checks still hold.
 */
export function withEstimatedCosts(observations) {
  const families = groupByFamily(observations);
  const ratios = ratiosFromFamilies(families);
  const anchors = new Map();
  for (const [key, rows] of families) {
    const anchor = anchorOf(rows);
    if (anchor && ratios.has(anchor.effort)) anchors.set(key, anchor);
  }

  return observations.map(row => {
    if (Number.isFinite(row.costPerTask?.value)) return row;
    const anchor = anchors.get(familyKey(row));
    const ratio = ratios.get(row.effort);
    if (!anchor || !ratio) return row;
    const scaled = (anchor.costPerTask.value * ratio) / ratios.get(anchor.effort);
    if (!Number.isFinite(scaled) || scaled <= 0) return row;
    return {
      ...row,
      costEstimated: true,
      estimatedCostPerTask: { value: Math.round(scaled * 10000) / 10000, anchorEffort: anchor.effort },
    };
  });
}
