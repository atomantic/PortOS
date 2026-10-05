/** Explicit, one-generation suffix repair over the existing revision workflow.
 * The accepted picture stays in its original file; two authored scene edit
 * points compose it with the continuation without baking or replacing it.
 */
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { unlink } from 'fs/promises';
import { join } from 'path';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { ServerError } from '../../lib/errorHandler.js';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { findFfmpeg, probeVideoStreamInfo, runFfmpegProcess, safeUnder } from '../../lib/ffmpeg.js';
import { canonicalSnapshotChecksum } from '../../lib/snapshotChecksum.js';
import { musicVideoDependencyChanges, musicVideoTakeChanges, presentMusicVideoDependencies } from '../../lib/musicVideoDependencies.js';
import { planPerformanceRepair } from '../../lib/musicVideoShotTiming.js';
import { getProject, mutateProjectRecord } from './projects.js';
import { startRevisionOnProject } from './revision.js';

const refuse = (message, code = 'PERFORMANCE_REPAIR_REVIEW_NEEDED') => new ServerError(message, { status: 409, code });
const basis = (project) => {
  // Readers derive dependency status; older persisted rows need not store it.
  // Compare the same projection on both sides of the frame-preparation race.
  const current = presentMusicVideoDependencies(project);
  return canonicalSnapshotChecksum({ trackId: current.trackId, uploadedAudioFilename: current.uploadedAudioFilename,
    performanceConditioningSource: current.performanceConditioningSource, vocalStemFilename: current.vocalStemFilename,
    scenes: current.scenes, videoSettings: current.videoSettings, lyricCues: current.lyricCues,
    composition: current.composition, autoReviews: current.autoReviews, productionRuns: current.productionRuns, revisions: current.revisions });
};

function repairContext(project, sceneId, input) {
  const scene = project?.scenes?.find((s) => s.sceneId === sceneId);
  if (!scene) throw new ServerError('Scene not found', { status: 404, code: 'NOT_FOUND' });
  if (['code', 'document'].includes(project.composition?.mode)) throw refuse('Review needed: update the authored composition document to preserve its edit points');
  if ((project.productionRuns || []).some((run) => ['running', 'stopped', 'limit-reached', 'blocked'].includes(run.status))
    || (project.autoReviews || []).some((run) => ['running', 'stopped', 'limit-reached'].includes(run.status))) {
    throw refuse('Finish or cancel the existing budgeted run before requesting a manual repair');
  }
  const attempts = (project.autoReviews || []).flatMap((run) => run.attempts || []).slice().reverse();
  const attempt = attempts.find((a) => a.review?.evidence?.temporal?.shots?.some((shot) => shot.sceneId === sceneId && shot.takeId === scene.videoHistoryId));
  if (attempt?.excerptId !== input.excerptId) throw refuse('Review the latest temporal evidence before choosing a repair boundary', 'PERFORMANCE_REPAIR_STALE');
  const take = scene.takes?.find((entry) => entry.kind === 'video' && entry.assetId === scene.videoHistoryId);
  if (musicVideoDependencyChanges(project, attempt.review.dependencies).length || musicVideoTakeChanges(project, scene, take).length) throw refuse('Review needed: the measured take dependencies changed or were not recorded');
  const evidence = attempt?.review?.evidence;
  const temporal = evidence?.temporal;
  const shot = temporal?.shots?.find((s) => s.sceneId === sceneId && s.takeId === scene.videoHistoryId);
  const plan = planPerformanceRepair({ scene, temporal: shot ? { ...shot, status: temporal.status, analyzer: temporal.analyzer } : null,
    excerptStartSec: evidence?.excerptStartSec, backend: project.videoSettings?.backend, videoSettings: project.videoSettings });
  if (!plan.ok) throw refuse(plan.message);
  if (input.sourceAssetId !== plan.sourceAssetId || input.boundarySec !== plan.boundarySec) throw refuse('The repair boundary changed — review the latest evidence', 'PERFORMANCE_REPAIR_STALE');
  const excerpt = project.excerpts?.find((e) => e.id === input.excerptId);
  if (!excerpt || excerpt.status !== 'complete') throw refuse('The reviewed draft is unavailable');
  const section = excerpt.sections?.find((s) => s.sceneId === sceneId);
  if (!section || section.startSec !== scene.startSec || section.endSec !== scene.endSec
    || section.performance?.takeId !== scene.videoHistoryId) throw refuse('The draft does not contain this complete selected performance shot');
  return { scene, plan, excerpt };
}

/** Pure checkpoint transform, run under the persisted project's write lock. */
function startPerformanceRepairOnProject(project, sceneId, input, referenceImageId, referenceFrameSec = null) {
  const { scene, plan, excerpt } = repairContext(project, sceneId, input);
  const originalTake = scene.takes.find((t) => t.kind === 'video' && t.assetId === scene.videoHistoryId);
  const suffixSceneId = `mvs-${randomUUID()}`;
  const provenance = { version: 1, sourceSceneId: sceneId, sourceAssetId: scene.videoHistoryId,
    sourceTakeId: originalTake.takeId, referenceFrameSec: referenceFrameSec ?? Math.max(originalTake.shotInstruction.edit.inSec, plan.referenceClipSec - 1 / 24), excerptId: excerpt.id, boundarySec: plan.boundarySec, referenceClipSec: plan.referenceClipSec,
    sourceInterval: { startSec: scene.startSec, endSec: scene.endSec } };
  const prefixInstruction = structuredClone(originalTake.shotInstruction);
  prefixInstruction.songInterval.endSec = plan.boundarySec;
  prefixInstruction.edit.outSec = plan.referenceClipSec;
  prefixInstruction.edit.targetSec = plan.boundarySec - scene.startSec;
  prefixInstruction.repair = { ...provenance, role: 'accepted-prefix' };
  // The original immutable take is captured on the revision. The prefix uses a
  // derived take with the same source bytes and its shorter composition edit.
  const prefix = { ...scene, endSec: plan.boundarySec, beatAligned: false, loop: false,
    takes: scene.takes.map((t) => t === originalTake ? { ...t, takeId: `mvt-${randomUUID()}`, source: 'accepted-prefix', shotInstruction: prefixInstruction } : t) };
  const suffix = { ...scene, sceneId: suffixSceneId, startSec: plan.boundarySec, beatAligned: false, loop: false,
    referenceImageId, videoHistoryId: null, takes: [], performanceRepair: provenance };
  const scenes = project.scenes.flatMap((s) => s.sceneId === sceneId ? [prefix, suffix] : [s]).map((s, order) => ({ ...s, order }));
  const sections = excerpt.sections.flatMap((s) => s.sceneId === sceneId ? [
    { ...s, endSec: plan.boundarySec }, { ...s, sceneId: suffixSceneId, startSec: plan.boundarySec, performance: null },
  ] : [s]);
  const next = { ...project, scenes, excerpts: project.excerpts.map((e) => e.id === excerpt.id ? { ...e, sections } : e) };
  const started = startRevisionOnProject(next, excerpt.id, { sceneIds: [suffixSceneId] });
  const repair = { ...provenance, suffixSceneId, originalTake: structuredClone(originalTake),
    maxGenerations: 1, generations: 0, costUsd: plan.costUsd, submitted: false };
  const revision = { ...started.revision, repair };
  return { ...started, revision, project: { ...started.project, excerpts: project.excerpts,
    scenes: started.project.scenes.map((s) => s.sceneId === suffixSceneId ? { ...s, performanceRepair: { ...provenance, revisionId: revision.id } } : s),
    revisions: started.project.revisions.map((r) => r.id === revision.id ? revision : r) } };
}

/** Prepare only a local boundary frame, then atomically open the checkpoint.
 * No provider call occurs here. Generation uses the ordinary revision resume.
 */
export async function startPerformanceRepair(projectId, sceneId, input) {
  const project = await getProject(projectId);
  const { scene, plan } = repairContext(project, sceneId, input);
  const { assertCurrentPerformanceTakes } = await import('./performanceShot.js');
  const { resolveMasterAudioPath } = await import('./render.js');
  await assertCurrentPerformanceTakes(project, await resolveMasterAudioPath(project));
  const { getHistoryItem } = await import('../videoGen/local.js');
  const entry = await getHistoryItem(scene.videoHistoryId);
  const path = entry?.filename ? safeUnder(PATHS.videos, entry.filename) : null;
  const ffmpeg = await findFfmpeg();
  if (!path || !existsSync(path) || !ffmpeg) throw refuse('Review needed: the accepted clip or frame extractor is unavailable');
  await ensureDir(PATHS.images);
  const filename = `mv-repair-${randomUUID()}.png`;
  const output = join(PATHS.images, filename);
  const fps = entry.fps || (await probeVideoStreamInfo(path)).fps;
  if (!Number.isFinite(fps) || fps <= 0) throw refuse('Review needed: the accepted clip has no verified frame rate');
  const referenceFrameSec = Math.max(scene.takes.find((take) => take.assetId === scene.videoHistoryId)?.shotInstruction?.edit?.inSec || 0, plan.referenceClipSec - 1 / fps);
  const result = await runFfmpegProcess({ bin: ffmpeg, signal: AbortSignal.timeout(30_000), args: ['-v', 'error', '-i', path, '-ss', String(referenceFrameSec), '-frames:v', '1', '-y', output] });
  if (!result.ok || !existsSync(output)) {
    await unlink(output).catch(() => {});
    throw refuse('Review needed: the accepted boundary frame could not be extracted');
  }
  // ffmpeg wrote the boundary frame in place; the row that first names it
  // commits under a backup lease (#9982). A refused commit unlinks the frame.
  return withBackupAssetPublication(() => mutateProjectRecord(projectId, (current) => {
    if (basis(current) !== basis(project)) throw refuse('The project changed during frame preparation — review it again', 'PERFORMANCE_REPAIR_STALE');
    return startPerformanceRepairOnProject(current, sceneId, input, filename, referenceFrameSec);
  })).catch(async (error) => { await unlink(output).catch(() => {}); throw error; });
}
