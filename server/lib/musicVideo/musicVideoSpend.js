/**
 * Music Video spend: the render spend ledger's entry and summary shapes, and the project spend
 * every surface shows (`projectSpend`), split by lane with unpriced renders counted (#16506).
 *
 * The ledger (services/musicVideo/renderSpendStore.js) holds one entry per paid render a
 * project's media jobs completed, whether or not the result became a take, plus manual
 * adjustments. The server reads it at presentation time and attaches `summarizeRenderSpend`'s
 * bounded summary as `project.renderSpend`; `projectSpend` merges that with the production runs'
 * own usage and with take estimates recorded before the ledger existed, so nothing is counted
 * twice and nothing recorded earlier is dropped. Without `renderSpend` it is the take-and-run
 * sum it always was.
 *
 * Dependency-free: `client/src/lib/musicVideoStages.js` re-exports `projectSpend` and the labels.
 */

/** Render backends billed per render. Subscription and browser lanes (Grok, Codex, Agy, Gemini) are not. */
export const METERED_RENDER_LANES = Object.freeze(['fal', 'runway', 'higgsfield', 'google', 'reactor', 'topaz']);

/** Lanes a manual adjustment can name: the metered lanes and `other`. */
export const SPEND_ADJUSTMENT_LANES = Object.freeze([...METERED_RENDER_LANES, 'other']);

export const SPEND_LANE_LABELS = Object.freeze({
  fal: 'fal.ai', runway: 'Runway', higgsfield: 'Higgsfield', google: 'Google', reactor: 'reactor.inc', topaz: 'Topaz Labs', other: 'Other',
  earlier: 'Earlier estimates',
});

export const spendLaneLabel = (lane) => SPEND_LANE_LABELS[lane] || lane;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round = (v) => Math.round(v * 1e4) / 1e4;
const finiteCost = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** The music video a media job was rendered for, from either tag the submit paths set. */
export function mediaJobProjectId(job) {
  const id = job?.params?.musicVideoProjectId || job?.params?.musicVideo?.projectId;
  return typeof id === 'string' && id ? id : null;
}

/**
 * The ledger entry for one completed media job, or null when it was not rendered for a music
 * video or ran on an unmetered lane. `estimatedUsd` is the price the render recorded (its video
 * history entry or image sidecar); null means the lane has no price for it and the entry counts
 * as an unpriced render.
 */
export function renderSpendEntry({ job, estimatedUsd = null, modelId = null, assetId = null, at }) {
  const projectId = mediaJobProjectId(job);
  const lane = job?.params?.mode;
  if (!projectId || !METERED_RENDER_LANES.includes(lane) || (job.kind !== 'image' && job.kind !== 'video' && job.kind !== 'video-upscale')) return null;
  const tag = job.params.musicVideo || {};
  return {
    id: `render:${job.id}`,
    entryKind: 'render',
    projectId,
    jobId: job.id,
    mediaKind: job.kind === 'video-upscale' ? 'video' : job.kind,
    assetId: typeof assetId === 'string' && assetId ? assetId : null,
    lane,
    modelId: typeof modelId === 'string' && modelId ? modelId : null,
    usd: finiteCost(estimatedUsd),
    // A production-run step is the run's spend; a revision-tagged one an auto-review take.
    source: tag.productionRunId ? 'autopilot' : tag.revisionId ? 'autoReview' : 'manual',
    ...(tag.productionRunId ? { productionRunId: tag.productionRunId } : {}),
    at,
  };
}

/**
 * The bounded summary attached to a presented project as `renderSpend`. `project` supplies the
 * takes whose recorded estimate predates the ledger (their job is not in it).
 */
export function summarizeRenderSpend(entries, project) {
  const lanes = new Map();
  const laneRow = (lane) => {
    if (!lanes.has(lane)) lanes.set(lane, { lane, usd: 0, count: 0, unpriced: 0, adjustmentUsd: 0 });
    return lanes.get(lane);
  };
  const bySource = { manual: 0, autoReview: 0 };
  const byRun = {};
  const adjustments = [];
  const ledgerJobs = new Set();
  let unpriced = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.entryKind === 'adjustment') {
      laneRow(entry.lane).adjustmentUsd += num(entry.usd);
      adjustments.push({ id: entry.id, lane: entry.lane, usd: num(entry.usd), statedUsd: entry.statedUsd ?? null, note: entry.note || null, at: entry.at });
      continue;
    }
    if (entry?.entryKind !== 'render') continue;
    ledgerJobs.add(entry.jobId);
    const row = laneRow(entry.lane);
    row.count += 1;
    const usd = finiteCost(entry.usd);
    if (usd == null) { row.unpriced += 1; unpriced += 1; }
    row.usd += usd ?? 0;
    if (entry.productionRunId) byRun[entry.productionRunId] = (byRun[entry.productionRunId] || 0) + (usd ?? 0);
    else bySource[entry.source === 'autoReview' ? 'autoReview' : 'manual'] += usd ?? 0;
  }
  const legacy = { manual: 0, autoReview: 0 };
  for (const scene of Array.isArray(project?.scenes) ? project.scenes : []) {
    for (const take of Array.isArray(scene?.takes) ? scene.takes : []) {
      if (!take?.spendKind || (take.jobId && ledgerJobs.has(take.jobId))) continue;
      legacy[take.spendKind === 'autoReview' ? 'autoReview' : 'manual'] += num(take.costUsd);
    }
  }
  const roundAll = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, round(v)]));
  return {
    lanes: [...lanes.values()].map((row) => ({ ...row, usd: round(row.usd), adjustmentUsd: round(row.adjustmentUsd) })),
    bySource: roundAll(bySource),
    byRun: roundAll(byRun),
    legacy: roundAll(legacy),
    adjustments,
    unpriced,
  };
}

/**
 * What the project has spent on paid generation, against the cap that applies now (`run` is the
 * live/latest production run, else the autopilot brief's budget caps it; null when nothing does).
 * `lanes` lists each paid lane's renders, unpriced count and adjustments, plus an "earlier" row for
 * estimates recorded before per-render tracking; it is empty when the project has no ledger.
 */
export function projectSpend(project, run = null) {
  const runs = Array.isArray(project?.productionRuns) ? project.productionRuns : [];
  const capUsd = run?.limits?.spendCapUsd ?? project?.automation?.budgetUsd ?? null;
  const ledger = project?.renderSpend;
  if (!ledger) {
    const autopilot = runs.reduce((sum, r) => sum + num(r?.usage?.spentUsd), 0);
    let manual = 0;
    let autoReview = 0;
    for (const scene of Array.isArray(project?.scenes) ? project.scenes : []) {
      for (const take of Array.isArray(scene?.takes) ? scene.takes : []) {
        if (take?.spendKind === 'autoReview') autoReview += num(take.costUsd);
        else if (take?.spendKind === 'manual') manual += num(take.costUsd);
      }
    }
    const spentUsd = autopilot + manual + autoReview;
    return { spentUsd, capUsd, autopilot, manual, autoReview, adjustmentsUsd: 0, unpriced: 0, lanes: [], total: spentUsd };
  }
  // A run's own usage and its ledger renders price the same steps: count the larger, once.
  const byRun = ledger.byRun || {};
  let autopilot = 0;
  let unledgeredRunUsd = 0;
  for (const r of runs) {
    const used = num(r?.usage?.spentUsd);
    const rendered = num(byRun[r?.id]);
    autopilot += Math.max(used, rendered);
    unledgeredRunUsd += Math.max(0, used - rendered);
  }
  const knownRuns = new Set(runs.map((r) => r?.id));
  for (const [runId, usd] of Object.entries(byRun)) if (!knownRuns.has(runId)) autopilot += num(usd);
  const legacyManual = num(ledger.legacy?.manual);
  const legacyAutoReview = num(ledger.legacy?.autoReview);
  const manual = num(ledger.bySource?.manual) + legacyManual;
  const autoReview = num(ledger.bySource?.autoReview) + legacyAutoReview;
  const adjustmentsUsd = (ledger.adjustments || []).reduce((sum, a) => sum + num(a.usd), 0);
  const spentUsd = round(autopilot + manual + autoReview + adjustmentsUsd);
  const lanes = (ledger.lanes || []).map((row) => ({ ...row, label: spendLaneLabel(row.lane), totalUsd: round(num(row.usd) + num(row.adjustmentUsd)) }));
  const earlier = round(legacyManual + legacyAutoReview + unledgeredRunUsd);
  if (earlier > 0) lanes.push({ lane: 'earlier', label: spendLaneLabel('earlier'), usd: earlier, count: 0, unpriced: 0, adjustmentUsd: 0, totalUsd: earlier });
  lanes.sort((a, b) => b.totalUsd - a.totalUsd);
  return {
    spentUsd, capUsd, autopilot: round(autopilot), manual: round(manual), autoReview: round(autoReview),
    adjustmentsUsd: round(adjustmentsUsd), unpriced: num(ledger.unpriced), lanes, total: spentUsd,
  };
}
