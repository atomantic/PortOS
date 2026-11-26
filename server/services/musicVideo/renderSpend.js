/**
 * Music Video render spend: records each paid render a project's media jobs complete into the
 * spend ledger, summarizes it for project reads, and applies manual adjustments (#16506).
 *
 * A render's price is the one its executor recorded on the render itself (the video history
 * entry's or image sidecar's `estimatedCostUsd`), the same figure the gallery shows; a shot
 * card's quote stands in when the record has none. A lane with no price records the render
 * unpriced, so the project shows how many renders its total cannot include.
 */
import { renderSpendEntry, summarizeRenderSpend, mediaJobProjectId, METERED_RENDER_LANES } from '../../lib/musicVideo/musicVideoSpend.js';
import { addRenderSpendAdjustment, deleteRenderSpendAdjustment, findRenderSpendForAsset, listRenderSpend, recordRenderSpend } from './renderSpendStore.js';
import { musicVideoEvents } from './events.js';

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The asset a completed job produced and the price and model its record carries. */
async function renderRecord(job) {
  if (job.kind === 'video' || job.kind === 'video-upscale') {
    const assetId = (job.kind === 'video-upscale' && typeof job.result?.id === 'string' && job.result.id)
      || job.result?.generationId || job.id;
    const { getHistoryItem } = await import('../videoGen/history.js');
    const entry = await getHistoryItem(assetId);
    return { assetId, estimatedUsd: finite(entry?.estimatedCostUsd), modelId: entry?.modelId || null };
  }
  const assetId = typeof job.result?.filename === 'string' ? job.result.filename : null;
  if (!assetId) return { assetId: null, estimatedUsd: null, modelId: null };
  const { readImageSidecar } = await import('../imageGen/sidecarStore.js');
  const { metadata } = await readImageSidecar(assetId);
  return { assetId, estimatedUsd: finite(metadata?.estimatedCostUsd), modelId: metadata?.modelId || metadata?.model || null };
}

/** True when a completed job belongs in some project's ledger; cheap, so the hook filters first. */
export const isMeteredProjectRender = (job) => (job?.kind === 'image' || job?.kind === 'video' || job?.kind === 'video-upscale')
  && Boolean(mediaJobProjectId(job)) && METERED_RENDER_LANES.includes(job.params?.mode);

/** Record one completed job's spend and push the project's new summary. Returns the entry, or null. */
export async function recordCompletedRender(job) {
  if (!isMeteredProjectRender(job)) return null;
  const record = await renderRecord(job);
  const entry = renderSpendEntry({
    job,
    estimatedUsd: record.estimatedUsd ?? finite(job.params?.musicVideoCostUsd),
    modelId: record.modelId || job.params?.musicVideoCostModelId || null,
    assetId: record.assetId,
    at: job.completedAt || new Date().toISOString(),
  });
  await recordRenderSpend(entry);
  await emitProjectSpend(entry.projectId);
  return entry;
}

/** The `renderSpend` summary a presented project carries. */
export async function readProjectRenderSpend(project) {
  return summarizeRenderSpend(await listRenderSpend(project.id), project);
}

async function emitProjectSpend(projectId) {
  const { getProject } = await import('./projects.js');
  const project = await getProject(projectId).catch(() => null);
  if (!project) return null;
  const renderSpend = await readProjectRenderSpend(project);
  musicVideoEvents.emit('render-spend', { projectId, renderSpend });
  return renderSpend;
}

/**
 * Add a manual adjustment. `actualUsd` states what the lane really cost ("actual spend on fal.ai
 * is $X"): the adjustment is the difference from what the project shows for that lane now.
 * `usd` adds a signed amount directly. Returns the entry and the project's new summary.
 */
export async function adjustProjectSpend(project, { lane, actualUsd, usd, note }) {
  let delta = usd;
  if (actualUsd != null) {
    const row = (await readProjectRenderSpend(project)).lanes.find((r) => r.lane === lane);
    delta = Math.round((actualUsd - ((row?.usd || 0) + (row?.adjustmentUsd || 0))) * 1e4) / 1e4;
  }
  const adjustment = await addRenderSpendAdjustment(project.id, { lane, usd: delta, statedUsd: actualUsd ?? null, note });
  return { adjustment, renderSpend: await emitProjectSpend(project.id) };
}

export async function removeProjectSpendAdjustment(project, adjustmentId) {
  await deleteRenderSpendAdjustment(project.id, adjustmentId);
  return { renderSpend: await emitProjectSpend(project.id) };
}

/**
 * The cost fields a take imported from this project's own render carries (#16506), so the
 * per-shot view prices it like a shot-card take. The take names the render's job, so the
 * project total counts the ledger entry once. Empty for an unpriced render, a production
 * run's step (the run carries its spend) or an asset this project did not render.
 */
export async function renderedTakeCost(projectId, kind, assetId) {
  const entry = await findRenderSpendForAsset(projectId, kind === 'video' ? 'video' : 'image', assetId);
  if (!entry || entry.usd == null || entry.source === 'autopilot') return {};
  const modelId = entry.modelId?.startsWith(`${entry.lane}:`) ? entry.modelId.slice(entry.lane.length + 1) : entry.modelId;
  return { jobId: entry.jobId, costUsd: entry.usd, spendKind: entry.source, ...(modelId ? { costModelId: modelId } : {}) };
}
