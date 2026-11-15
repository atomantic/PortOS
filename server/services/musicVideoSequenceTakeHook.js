/**
 * Music Video sequence-take hook (#16128). A sequence take (musicVideo/sequenceTakes.js)
 * is one hosted clip written as several shots with hard cuts. On completion this
 * hook finds the cuts (ffmpeg scene change), proposes each covered shot's
 * in-point, and files the WHOLE clip as a candidate take on every covered shot
 * in one project write, each take carrying its own in-point. No selection
 * changes here: picking the take on a shot sets that shot's offset
 * (takes.js `selectSceneTake`). A clip too short for one of its shots is not
 * filed, and every covered shot records why.
 *
 * The per-scene hooks and the sequence-coverage hook ignore the job: its tag
 * names no `sceneId` and carries `sequenceTake`, not `sequence`.
 */

import { createMediaJobImageHook } from './mediaJobImageHook.js';
import { appendTakesAcrossScenes, recordSceneFailure } from './musicVideo/projects.js';
import { musicVideoEvents } from './musicVideo/events.js';
import { getHistoryItem } from './videoGen/history.js';
import { PATHS } from '../lib/fileUtils.js';
import { probeVideoDuration, safeUnder } from '../lib/ffmpeg.js';
import { detectVideoSceneCuts } from '../lib/videoSceneCuts.js';
import { proposeSequenceTakeOffsets } from '../lib/musicVideoSequenceTake.js';

const round3 = (n) => Math.round(n * 1000) / 1000;

const validWindows = (windows) => Array.isArray(windows) && windows.length >= 2 && windows.every((w) => typeof w?.sceneId === 'string'
  && Number.isFinite(w.startSec) && Number.isFinite(w.endSec) && w.endSec > w.startSec);

async function recordSequenceTakeFailure({ projectId, windows }, error) {
  for (const { sceneId } of windows) {
    const scene = await recordSceneFailure(projectId, sceneId, { lane: 'video', error }).catch((err) => {
      console.log(`⚠️ music-video sequence take failure not recorded on ${projectId.slice(0, 8)}/${sceneId}: ${err.message}`);
      return null;
    });
    if (scene) musicVideoEvents.emit('scene-failure', { projectId, sceneId, lastFailure: scene.lastFailure ?? null });
  }
}

/** File the clip on each covered shot with its proposed in-point. Null when it was refused. */
async function fileSequenceTake({ projectId, windows, videoHistoryId, job }, deps = {}) {
  const { probe = probeVideoDuration, detectCuts = detectVideoSceneCuts, history = getHistoryItem, append = appendTakesAcrossScenes } = deps;
  const item = await history(videoHistoryId);
  const clipPath = item?.filename ? safeUnder(PATHS.videos, item.filename) : null;
  if (!clipPath) throw new Error(`sequence take ${videoHistoryId.slice(0, 8)} is not in the video history`);
  const clipSec = await probe(clipPath);
  // A failed detection falls back to the planned in-points; it never blocks filing.
  const cutsSec = Number.isFinite(clipSec) ? await detectCuts(clipPath).catch(() => null) : null;
  const proposal = proposeSequenceTakeOffsets({ windows, cutsSec, clipSec });
  if (!proposal.ok) {
    await recordSequenceTakeFailure({ projectId, windows }, `The sequence take was not filed: ${proposal.reason}.`);
    return null;
  }
  const sceneIds = windows.map((w) => w.sceneId);
  const totalSec = windows.at(-1).endSec;
  const costUsd = job.params?.musicVideoCostUsd;
  const dependencies = job.params?.musicVideoSequenceDependencies || {};
  const { project, appended } = await append(projectId, proposal.offsets.map((offset, index) => {
    const window = windows[index];
    return {
      sceneId: offset.sceneId,
      kind: 'video',
      assetId: videoHistoryId,
      source: 'generated',
      provider: 'fal',
      jobId: typeof job.id === 'string' ? job.id : null,
      prompt: typeof job.params?.prompt === 'string' ? job.params.prompt : null,
      sourceImageId: dependencies[offset.sceneId]?.references?.[0]?.assetId ?? null,
      dependencies: dependencies[offset.sceneId] ?? null,
      // The director picks the take per shot; filing it never changes a selection.
      autoSelect: false,
      sequence: { sceneIds, index, offsetFrames: offset.offsetFrames, from: offset.from },
      // One request was paid for; each shot's take carries its share so project spend sums to it.
      costUsd: Number.isFinite(costUsd) ? round3(costUsd * ((window.endSec - window.startSec) / totalSec)) : null,
      costModelId: job.params?.musicVideoCostModelId ?? null,
      spendKind: 'manual',
    };
  }));
  const found = proposal.offsets.filter((o) => o.from === 'cut').length;
  console.log(`🎞️ music-video sequence take ${projectId.slice(0, 8)} ← ${videoHistoryId.slice(0, 8)} (${round3(clipSec)}s, ${cutsSec == null ? 'cut detection unavailable' : `${found}/${windows.length - 1} cuts matched`}) filed on ${appended.length} shots`);
  return { project, appended };
}

const hook = createMediaJobImageHook({
  label: 'music-video sequence-take',
  initLog: '🎞️ Music Video sequence-take hook initialized',
  kind: 'video',
  tagKey: 'musicVideo',
  extractResult: (job) => {
    const videoHistoryId = (typeof job.result?.generationId === 'string' && job.result.generationId)
      || (typeof job.id === 'string' ? job.id : null);
    return videoHistoryId ? { videoHistoryId } : null;
  },
  identify: (tag) => (tag?.projectId && !tag.sceneId && validWindows(tag.sequenceTake?.windows)
    ? { projectId: tag.projectId, windows: tag.sequenceTake.windows }
    : null),
  serializeKey: ({ projectId }) => projectId,
  describe: ({ projectId, windows }) => `${projectId}/[${windows.map((w) => w.sceneId).join(',')}]`,
  attach: (ctx) => fileSequenceTake(ctx),
  onAttached: ({ projectId }, { project, appended }) => {
    for (const { sceneId, take } of appended.filter(Boolean)) {
      const scene = project.scenes.find((s) => s.sceneId === sceneId);
      musicVideoEvents.emit('scene-video', {
        projectId, sceneId, videoHistoryId: scene?.videoHistoryId ?? null, takes: scene?.takes ?? [],
        lastFailure: scene?.lastFailure ?? null, takeId: take?.takeId ?? null,
      });
    }
  },
  onTerminal: (ctx, status, job) => (status === 'failed' ? recordSequenceTakeFailure(ctx, job?.error) : undefined),
});

export function initMusicVideoSequenceTakeHook() {
  hook.init();
}

export const __testing = { ...hook.__testing, fileSequenceTake };
