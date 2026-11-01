/**
 * Music Video sequence-take split hook (#14241).
 *
 * A sequence job (musicVideo/sequenceCoverage.js `submitSequenceCoverage`) is
 * one fal clip covering several cutaway scenes. Its `musicVideo.sequence` tag
 * carries each scene's in/out point inside that clip, planned from the scenes'
 * own cut times when the job was queued. On completion this hook cuts the clip
 * at exactly those points (ffmpeg), registers each piece as its own video-history
 * row (the sent prompt and its labeled additions copied from the clip) and files
 * each piece as a take on its scene in one project write. No new cut times are
 * chosen here: a clip shorter than the planned run refuses the split rather than
 * desyncing the song, and every scene records the failure.
 *
 * The per-scene hooks ignore the job because its tag names no `sceneId`.
 */

import { randomUUID } from 'crypto';
import { join } from 'path';
import { createMediaJobImageHook } from './mediaJobImageHook.js';
import { appendTakesAcrossScenes, recordSceneFailure } from './musicVideo/projects.js';
import { musicVideoEvents } from './musicVideo/events.js';
import { getHistoryItem, mutateVideoHistory } from './videoGen/history.js';
import { discardUnpublishedVideo } from './videoGen/generateVideoHelpers.js';
import { PATHS } from '../lib/fileUtils.js';
import { cutVideoSegment, generateThumbnail, probeVideoDuration, safeUnder } from '../lib/ffmpeg.js';
import { omitRenderTiming } from '../lib/renderTiming.js';

// A provider clip may end a frame short of its requested length; more than that is a short clip.
const END_TOLERANCE_SEC = 0.05;
const round3 = (n) => Math.round(n * 1000) / 1000;

const validSpans = (spans) => Array.isArray(spans) && spans.length > 0 && spans.every((s) => typeof s?.sceneId === 'string'
  && Number.isFinite(s.clipStartSec) && Number.isFinite(s.clipEndSec) && s.clipEndSec > s.clipStartSec);

async function recordSequenceFailure({ projectId, spans }, error) {
  for (const { sceneId } of spans) {
    const scene = await recordSceneFailure(projectId, sceneId, { lane: 'video', error }).catch((err) => {
      console.log(`⚠️ music-video sequence failure not recorded on ${projectId.slice(0, 8)}/${sceneId}: ${err.message}`);
      return null;
    });
    if (scene) musicVideoEvents.emit('scene-failure', { projectId, sceneId, lastFailure: scene.lastFailure ?? null });
  }
}

/** Cut one span into a new history row cloned from the sequence clip. */
async function registerPiece(item, clipPath, span) {
  const id = randomUUID();
  const filename = `${id}.mp4`;
  const outPath = join(PATHS.videos, filename);
  const cut = await cutVideoSegment(clipPath, outPath, { startSec: span.clipStartSec, endSec: span.clipEndSec });
  if (!cut.ok) throw new Error(`could not cut ${span.sceneId}: ${cut.reason}`);
  let committed = false;
  try {
    const thumbnail = await generateThumbnail(outPath, id);
    const { numFrames: _frames, posterSec: _poster, ...source } = omitRenderTiming(item);
    const entry = {
      ...source,
      id, filename, thumbnail,
      createdAt: new Date().toISOString(),
      duration: round3(span.clipEndSec - span.clipStartSec),
      // Where this piece sits in the one sequence clip it was cut from.
      sequenceOf: item.id,
      sequenceSpan: { startSec: span.clipStartSec, endSec: span.clipEndSec },
      hidden: false,
    };
    await mutateVideoHistory((history) => { history.unshift(entry); return history; });
    committed = true;
    return entry;
  } finally {
    if (!committed) await discardUnpublishedVideo({ jobId: id, outputPath: outPath });
  }
}

/** Split the sequence clip onto its scenes. */
async function splitSequenceTake({ projectId, spans, videoHistoryId, job }) {
  const item = await getHistoryItem(videoHistoryId);
  const clipPath = item?.filename ? safeUnder(PATHS.videos, item.filename) : null;
  if (!clipPath) throw new Error(`sequence clip ${videoHistoryId.slice(0, 8)} is not in the video history`);
  const clipSec = await probeVideoDuration(clipPath);
  const needSec = spans.at(-1).clipEndSec;
  if (!Number.isFinite(clipSec) || clipSec + END_TOLERANCE_SEC < needSec) {
    const error = `The sequence clip is ${Number.isFinite(clipSec) ? round3(clipSec) : 'an unknown length'}s but its shots need ${needSec}s, so it was not split.`;
    await recordSequenceFailure({ projectId, spans }, error);
    return null;
  }
  const pieces = [];
  for (const span of spans) pieces.push(await registerPiece(item, clipPath, { ...span, clipEndSec: Math.min(span.clipEndSec, clipSec) }));
  const totalSec = spans.reduce((sum, s) => sum + (s.clipEndSec - s.clipStartSec), 0);
  const costUsd = job.params?.musicVideoCostUsd;
  const dependencies = job.params?.musicVideoSequenceDependencies || {};
  const { project, appended } = await appendTakesAcrossScenes(projectId, spans.map((span, i) => ({
    sceneId: span.sceneId,
    kind: 'video',
    assetId: pieces[i].id,
    source: 'generated',
    provider: 'portos',
    jobId: typeof job.id === 'string' ? job.id : null,
    prompt: typeof job.params?.prompt === 'string' ? job.params.prompt : null,
    sourceImageId: dependencies[span.sceneId]?.references?.[0]?.assetId ?? null,
    dependencies: dependencies[span.sceneId] ?? null,
    // One request was paid for; each piece carries its share so project spend sums to it.
    costUsd: Number.isFinite(costUsd) ? round3(costUsd * ((span.clipEndSec - span.clipStartSec) / totalSec)) : null,
    costModelId: job.params?.musicVideoCostModelId ?? null,
    spendKind: 'manual',
  })));
  return { project, appended };
}

const hook = createMediaJobImageHook({
  label: 'music-video sequence-video',
  initLog: '🎞️ Music Video sequence-video hook initialized',
  kind: 'video',
  tagKey: 'musicVideo',
  extractResult: (job) => {
    const videoHistoryId = (typeof job.result?.generationId === 'string' && job.result.generationId)
      || (typeof job.id === 'string' ? job.id : null);
    return videoHistoryId ? { videoHistoryId } : null;
  },
  identify: (tag) => (tag?.projectId && !tag.sceneId && validSpans(tag.sequence?.spans)
    ? { projectId: tag.projectId, spans: tag.sequence.spans }
    : null),
  serializeKey: ({ projectId }) => projectId,
  describe: ({ projectId, spans }) => `${projectId}/[${spans.map((s) => s.sceneId).join(',')}]`,
  attach: (ctx) => splitSequenceTake(ctx),
  onAttached: ({ projectId, videoHistoryId }, { project, appended }) => {
    for (const { sceneId, take } of appended.filter(Boolean)) {
      const scene = project.scenes.find((s) => s.sceneId === sceneId);
      musicVideoEvents.emit('scene-video', {
        projectId, sceneId, videoHistoryId: scene?.videoHistoryId ?? null, takes: scene?.takes ?? [],
        lastFailure: scene?.lastFailure ?? null, takeId: take?.takeId ?? null,
      });
    }
    console.log(`🎞️ music-video sequence ${projectId.slice(0, 8)} ← ${videoHistoryId.slice(0, 8)} split onto ${appended.length} scenes`);
  },
  onTerminal: (ctx, status, job) => (status === 'failed' ? recordSequenceFailure(ctx, job?.error) : undefined),
});

export function initMusicVideoSequenceVideoHook() {
  hook.init();
}

export const __testing = hook.__testing;
