/**
 * Music Video — draft excerpt render (#8986, part of #8966).
 *
 * Renders a director-chosen `[startSec, endSec)` window through the SAME
 * composed pipeline as a full render (`planMusicVideoRender` +
 * `buildMusicVideoFfmpegArgs` in `render.js`), then samples a contact sheet at
 * every cut and typography-cue boundary the window contains
 * (`excerptBoundaryTimes` + `encodeFileContactSheetAtTimes`). A frame check
 * alone can't validate motion/audio sync, so the excerpt file itself is the
 * primary artifact — the contact sheet is a quick-scan companion, and its
 * failure doesn't fail the excerpt.
 *
 * Mirrors render.js's job/SSE/cancel machinery on a SEPARATE job map and
 * per-project mutex: an excerpt draft and a full render are different
 * artifacts writing different output files, so nothing stops a director
 * running both — the mutex here only rejects a duplicate excerpt render on
 * the SAME project while one is already in flight.
 */

import { documentSceneVisualLayer } from '../../lib/musicVideoLayers.js';
import { captureMusicVideoEvidence } from '../../lib/musicVideoDependencies.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { unlink } from 'fs/promises';
import { join } from 'path';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { spawn } from '../../lib/childProcess.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../../lib/sseUtils.js';
import { attachFfmpegRenderGuard } from '../../lib/ffmpegRenderGuard.js';
import { cancelMusicVideoRenderJob, isMusicVideoRenderCanceled } from './renderCancellation.js';
import { safeUnder } from '../../lib/ffmpeg.js';
import { encodeFileContactSheetAtTimes } from '../htmlComposition/encode.js';
import { getProject, listProjects, mutateProjectRecord } from './projects.js';
import { assertCurrentPerformanceTakes } from './performanceShot.js';
import { assertCurrentClipDependencies, planMusicVideoRender, buildMusicVideoFfmpegArgs, excerptBoundaryTimes, isLocalRenderMark, resolveMasterAudioPath, resolveSoundBedPath } from './render.js';
import { encodeCodeComposition, prepareCodeRender, writeCodeProofSheet } from './codeRender.js';
import { encodeDocumentComposition, prepareDocumentRender } from './documentRender.js';
import { projectTypographyPlan } from './composition.js';
import { renderTypographyOverlays, removeCompositionScratch } from './compositionRender.js';
import { startExcerptOnProject, applyExcerptPatch } from './excerpt.js';
import { markRevisionRendering, settleRevisionRender } from './revision.js';
import { ensureInstanceId } from '../instanceIdentity.js';
import { musicVideoAspect, musicVideoAtAspect } from '../../lib/musicVideoAspect.js';
import { musicVideoEvents } from './events.js';
import { pilotDependencies, productionPilotRenderProject } from './productionPilot.js';
import { musicVideoDependencyChanges } from '../../lib/musicVideoDependencies.js';
import { excerptRangeFits } from '../../lib/musicVideoExcerptRange.js';

const jobs = new Map();
const projectExcerptRenders = new Map();
const PENDING = Symbol('mv-excerpt-render-pending');

export const attachExcerptRenderSseClient = (jobId, res) => attachSse(jobs, jobId, res);

export function cancelExcerptRender(jobId) {
  return cancelMusicVideoRenderJob(jobs.get(jobId), { label: 'music-video excerpt render' });
}

const round3 = (n) => Math.round(n * 1000) / 1000;
const sheetFilenameFor = (filename) => `${filename.replace(/\.mp4$/, '')}-sheet.png`;
// A filename read back off a (possibly peer-synced) record is only ever
// resolved inside its own media directory.
const unlinkUnder = (root, filename) => {
  const path = safeUnder(root, filename);
  return path ? unlink(path).catch(() => {}) : Promise.resolve();
};

// The encoder wrote the excerpt and its contact sheet in place; the settling
// row that first names them commits under a backup lease (#9982), so a
// snapshot never dumps a row naming bytes its file copy missed.
const settleExcerptRecord = (projectId, excerptId, patch) => withBackupAssetPublication(() => mutateProjectRecord(projectId, (current) => ({
  project: settleRevisionRender(applyExcerptPatch(current, excerptId, { ...patch, partialFilename: null, renderingOn: null }), excerptId, patch),
})));

/**
 * Kick off a draft excerpt render. Returns `{ jobId, excerptId }`.
 * `revisionId` (#8987) links the render to an open selective revision in the
 * same write that creates the excerpt, so its finish settles that revision.
 */
// A code-rendered or composition-document project excerpts the same seekable
// composition, windowed on song time, instead of the footage concat.
const SEEKED_EXCERPTS = Object.freeze({
  eidoverse: {
    label: 'Eidoverse Video',
    prepare: async (project) => {
      const plan = await (await import('./eidoverseRender.js')).prepareEidoverseRender(project);
      return { plan, totalSec: plan.durationSec, songSections: (project.scenes || [])
        .filter(s => s.endSec > s.startSec).map(s => ({ sceneId: s.sceneId, startSec: s.startSec, endSec: s.endSec })) };
    },
    encode: async ({ prepared, startSec, endSec, ...input }) => (await import('./eidoverseRender.js')).encodeEidoverseComposition({
      ...input, plan: prepared.plan, windowStart: startSec, windowEnd: endSec,
    }),
  },
  code: {
    label: 'code',
    prepare: async (project) => {
      const full = prepareCodeRender(project);
      return { full, totalSec: full.durationSec, songSections: full.song.sections.map((s) => ({ sceneId: s.sceneId || s.id, startSec: s.startSec, endSec: s.endSec })) };
    },
    encode: async ({ project, projectId, jobId, audioPath, outputPath, signal, onProgress, startSec, endSec, fade }) => {
      const plan = prepareCodeRender(project, { windowStart: startSec, windowEnd: endSec });
      await encodeCodeComposition({
        ...plan, audioPath, audioStartSec: startSec, outputPath, directory: `compositions/music-video/${projectId}/${jobId}`, signal, onProgress, fade,
      });
      return { width: plan.width, height: plan.height, fps: plan.fps, boundaryTimes: plan.sectionTimes };
    },
  },
  document: {
    label: 'composition document',
    soundBed: true,
    performanceTakes: true,
    prepare: async (project) => {
      const plan = await prepareDocumentRender(project);
      const songSections = (project.scenes || [])
        .filter((s) => s?.sceneId && typeof s.startSec === 'number' && typeof s.endSec === 'number' && s.endSec > s.startSec)
        .map((s) => ({ sceneId: s.sceneId, layer: documentSceneVisualLayer(project, s, { generated: project.composition?.document?.source?.kind === 'generated' }), startSec: s.startSec, endSec: s.endSec }));
      return { plan, totalSec: plan.durationSec, songSections };
    },
    encode: ({ prepared, project, jobId, audioPath, soundBed, outputPath, signal, onProgress, startSec, endSec, fade }) => encodeDocumentComposition({
      project, plan: prepared.plan, jobId, audioPath, soundBed, outputPath, signal, onProgress, windowStart: startSec, windowEnd: endSec, fade, collectFootageVisibility: true,
    }),
  },
});

async function launchSeekedExcerpt({ projectId, project: stored, startSec, endSec, revisionId, handOff, renderer, aspect = null, fade = false }) {
  // A social cut renders the same composition at another frame (#9280): the
  // re-framed view drives planning, staging and capture; the record keeps its own aspect.
  const project = musicVideoAtAspect(stored, aspect);
  const prepared = await renderer.prepare(project);
  // Same order as a full render: a missing master throws before the
  // excerpt is marked rendering.
  const audioPath = await resolveMasterAudioPath(project);
  if (renderer.performanceTakes) {
    assertCurrentClipDependencies(project);
    await assertCurrentPerformanceTakes(project, audioPath);
  }
  const soundBed = renderer.soundBed ? await resolveSoundBedPath(project) : null;
  if (!excerptRangeFits(startSec, endSec, prepared.totalSec, prepared.plan?.fps ?? prepared.full?.fps)) {
    throw new ServerError(
      `The excerpt range must fall within the project's ${prepared.totalSec.toFixed(2)}s song`,
      { status: 422, code: 'INVALID_EXCERPT_RANGE', context: { totalDuration: prepared.totalSec } },
    );
  }
  const endClamped = Math.min(endSec, prepared.totalSec);
  await ensureDir(PATHS.videos);
  await ensureDir(PATHS.videoThumbnails);
  const filename = `music-video-excerpt-${projectId.slice(0, 8)}-${Date.now()}.mp4`;
  const outputPath = join(PATHS.videos, filename);
  const sections = prepared.songSections
    .filter((section) => section.startSec < endClamped && section.endSec > startSec)
    .map((section) => ({
      sceneId: section.sceneId,
      startSec: round3(Math.max(section.startSec, startSec)),
      endSec: round3(Math.min(section.endSec, endClamped)),
    }));
  const renderingOn = await ensureInstanceId();
  const { excerpt } = await mutateProjectRecord(projectId, (current) => {
    const started = startExcerptOnProject(current, { startSec, endSec: endClamped, sections, performanceProject: project, dependencies: captureMusicVideoEvidence(project, { sceneIds: sections.map((section) => section.sceneId), startSec, endSec: endClamped }), partialFilename: filename, renderingOn, aspect: musicVideoAspect(project), fade });
    return revisionId ? { ...started, project: markRevisionRendering(started.project, revisionId, started.excerpt.id) } : started;
  });
  const excerptId = excerpt.id;
  const jobId = excerptId;
  const totalDuration = endClamped - startSec;
  const job = { id: jobId, projectId, excerptId, status: 'running', clients: [], process: null, totalDuration, overlayAbort: new AbortController() };
  jobs.set(jobId, job);
  projectExcerptRenders.set(projectId, jobId);
  handOff();
  const Label = `${renderer.label[0].toUpperCase()}${renderer.label.slice(1)}`;
  console.log(`🎬 Rendering ${renderer.label} music-video excerpt [${jobId.slice(4, 12)}]: project=${projectId.slice(0, 8)} range=[${startSec.toFixed(2)},${endClamped.toFixed(2)}]s footage=off`);
  const { signal } = job.overlayAbort;
  const finalize = async (patch) => {
    projectExcerptRenders.delete(projectId);
    const persisted = await settleExcerptRecord(projectId, excerptId, patch).then(() => true, (err) => {
      console.error(`❌ Music-video ${renderer.label} excerpt [${jobId.slice(4, 12)}] project ${projectId.slice(0, 8)} status→${patch.status} write failed: ${err.message}`);
      return false;
    });
    closeJobAfterDelay(jobs, jobId);
    if (persisted) musicVideoEvents.emit('excerpt-render', { projectId, excerptId, status: patch.status });
    return persisted;
  };
  Promise.resolve().then(() => renderer.encode({
    prepared, project, projectId, jobId, audioPath, soundBed, outputPath, signal, startSec, endSec: endClamped, fade,
    onProgress: (fraction) => broadcastSse(job, { type: 'progress', progress: fraction }),
  })).then(async (encoded) => {
    job.overlayAbort = null;
    job.status = 'complete';
    let contactSheetFilename = null;
    try {
      contactSheetFilename = sheetFilenameFor(filename);
      await writeCodeProofSheet(outputPath, join(PATHS.videoThumbnails, contactSheetFilename), encoded.boundaryTimes, {
        width: encoded.width, height: encoded.height, fps: encoded.fps,
      });
    } catch (err) {
      console.warn(`⚠️ Music-video ${renderer.label} excerpt contact sheet failed [${jobId.slice(4, 12)}]: ${err.message}`);
      contactSheetFilename = null;
    }
    const persisted = await finalize({ status: 'complete', filename, contactSheetFilename, error: null, jobId: null, width: encoded.width ?? null, height: encoded.height ?? null, ...(encoded.footageVisibility ? { footageVisibility: encoded.footageVisibility } : {}) });
    if (!persisted) {
      await unlink(outputPath).catch(() => {});
      broadcastSse(job, { type: 'error', error: 'The excerpt rendered, but saving the result failed — reload the project and try again' });
      return;
    }
    console.log(`✅ ${Label} music-video excerpt rendered [${jobId.slice(4, 12)}]: ${filename}`);
    broadcastSse(job, { type: 'complete', result: { excerptId, filename, path: `/data/videos/${filename}`, contactSheetFilename, contactSheetPath: contactSheetFilename ? `/data/video-thumbnails/${contactSheetFilename}` : null } });
  }).catch(async (err) => {
    const canceled = signal.aborted || err?.code === 'CANCELED';
    job.status = canceled ? 'canceled' : 'error';
    const reason = canceled ? 'Render cancelled' : `${Label} excerpt failed: ${err.message}`;
    job.lastError = reason;
    const log = canceled ? console.log : console.error;
    log(`${canceled ? '🛑' : '❌'} Music-video ${renderer.label} excerpt ${canceled ? 'cancelled' : 'failed'} [${jobId.slice(4, 12)}]: ${reason}`);
    await unlink(outputPath).catch(() => {});
    await finalize({ status: canceled ? 'canceled' : 'error', error: canceled ? null : reason, filename: null, jobId: null });
    broadcastSse(job, { type: canceled ? 'canceled' : 'error', error: reason });
  });
  return { jobId, excerptId };
}

/**
 * Render [startSec, endSec) of a seekable composition (document, code, Eidoverse) at `aspect`
 * straight to `outputPath`, with no excerpt record: the publishing kit's native 9:16 cut.
 * Resolves the encode's frame (`{ width, height, … }`), or null when the project has no
 * seekable composition. A document that does not lay itself out at that frame throws
 * COMPOSITION_DOCUMENT_FORMAT, which the caller takes as "not available".
 * `deps` (tests): `renderers` stands in for the seeked renderers, `resolveAudio` for the master lookup.
 */
export async function renderSeekedWindow(stored, { startSec, endSec, aspect, fade = false, outputPath, jobId, signal, onProgress }, { renderers = SEEKED_EXCERPTS, resolveAudio = resolveMasterAudioPath } = {}) {
  const renderer = renderers[stored?.composition?.mode];
  if (!renderer) return null;
  const project = musicVideoAtAspect(stored, aspect);
  const prepared = await renderer.prepare(project);
  const audioPath = await resolveAudio(project);
  if (renderer.performanceTakes) {
    assertCurrentClipDependencies(project);
    await assertCurrentPerformanceTakes(project, audioPath);
  }
  const soundBed = renderer.soundBed ? await resolveSoundBedPath(project) : null;
  return renderer.encode({
    prepared, project, projectId: project.id, jobId, audioPath, soundBed, outputPath, signal,
    startSec, endSec: Math.min(endSec, prepared.totalSec), fade, onProgress,
  });
}

export async function startExcerptRender(projectId, { startSec, endSec, aspect = null, fade = false }, { revisionId = null, pilotSceneId = null, verifyCurrent = null } = {}) {
  const stored = await getProject(projectId);
  if (!stored) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  await verifyCurrent?.(stored);
  const project = pilotSceneId ? productionPilotRenderProject(stored, pilotSceneId) : stored;
  const pilotEvidence = pilotSceneId ? pilotDependencies(stored, pilotSceneId) : null;
  if (pilotSceneId) {
    const scene = stored.scenes.find((s) => s.sceneId === pilotSceneId);
    if (startSec !== scene.startSec || endSec !== scene.endSec) throw new ServerError('The pilot must review its exact song window', { status: 422, code: 'INVALID_EXCERPT_RANGE' });
  }

  const existingJob = projectExcerptRenders.get(projectId);
  if (existingJob && (existingJob === PENDING || jobs.has(existingJob))) {
    throw new ServerError('An excerpt render is already in progress for this project', {
      status: 409, code: 'EXCERPT_RENDER_IN_PROGRESS', context: { jobId: existingJob === PENDING ? null : existingJob },
    });
  }
  projectExcerptRenders.set(projectId, PENDING);

  let handedOff = false;
  try {
    const seeked = SEEKED_EXCERPTS[project.composition?.mode];
    if (seeked) {
      return await launchSeekedExcerpt({
        projectId, project, startSec, endSec, revisionId, handOff: () => { handedOff = true; }, renderer: seeked, aspect, fade,
      });
    }
    // A footage (ffmpeg) render has no frame of its own to re-lay-out: cropping
    // the 16:9 cut would slice through its type and cards (#9280).
    if ((aspect && aspect !== musicVideoAspect(project)) || fade) {
      throw new ServerError('Social cuts (another aspect, faded edges) need a composition-document or code-rendered project', {
        status: 422, code: 'EXCERPT_ASPECT_UNSUPPORTED',
      });
    }
    const { ffmpeg, audioPath, composed, clips, audioDurationSec, soundBed } = await planMusicVideoRender(project);
    await ensureDir(PATHS.videos);
    await ensureDir(PATHS.videoThumbnails);

    // A probe pass (no `excerpt` option) gets the full-song plan's canonical
    // dims/fps/sections/cues in ABSOLUTE song time — the coordinate space
    // `startSec`/`endSec` and `excerptBoundaryTimes` are given in.
    const probe = buildMusicVideoFfmpegArgs(clips, audioPath, join(PATHS.videos, 'probe.mp4'), { audioDurationSec, frameGrid: composed });
    if (!(startSec >= 0) || !(endSec > startSec) || endSec > probe.totalDuration + (pilotSceneId ? 1 / probe.fps : 1e-6)) {
      throw new ServerError(
        `The excerpt range must fall within the project's ${probe.totalDuration.toFixed(2)}s render`,
        { status: 422, code: 'INVALID_EXCERPT_RANGE', context: { totalDuration: probe.totalDuration } },
      );
    }
    const endClamped = Math.min(endSec, probe.totalDuration);
    const filename = `music-video-excerpt-${projectId.slice(0, 8)}-${Date.now()}.mp4`;
    const outputPath = join(PATHS.videos, filename);
    // #8987: the sections this draft cuts, in absolute song time and clipped to
    // the window — a flagged review note maps onto one of these when the
    // director asks for a selective revision.
    const sections = probe.sections
      .filter((s) => s.startSec < endClamped && s.endSec > startSec)
      .map((s) => ({ sceneId: s.sceneId, layer: s.layer, startSec: round3(Math.max(s.startSec, startSec)), endSec: round3(Math.min(s.endSec, endClamped)) }));

    // Persist the new `status: 'rendering'` excerpt against the FRESHEST
    // record (not the `project` snapshot planning read above), so a
    // concurrent note/edit on another excerpt can't be clobbered. The output
    // filename is recorded now so a restart mid-encode can delete the partial,
    // and the mark names this instance so a synced peer's boot recovery can't
    // demote it (#9010).
    const renderingOn = await ensureInstanceId();
    await verifyCurrent?.(await getProject(projectId));
    const { excerpt } = await mutateProjectRecord(projectId, (current) => {
      if (pilotEvidence && musicVideoDependencyChanges(current, pilotEvidence).length) throw new ServerError('The selected pilot changed before rendering', { status: 409, code: 'COMPOSITION_DRAFT_STALE' });
      const started = startExcerptOnProject(current, { startSec, endSec: endClamped, sections, performanceProject: stored, dependencies: pilotEvidence || captureMusicVideoEvidence(project, { sceneIds: sections.map((section) => section.sceneId), startSec, endSec: endClamped }), partialFilename: filename, renderingOn, aspect: musicVideoAspect(project) });
      return revisionId ? { ...started, project: markRevisionRendering(started.project, revisionId, started.excerpt.id) } : started;
    });
    const excerptId = excerpt.id;
    const jobId = excerptId;

    // Only the cue/card windows overlapping the window are worth capturing —
    // typography outside it never survives the final trim.
    const { cues: plannedCues, style } = projectTypographyPlan(project, clips, probe.sections, probe.totalDuration);
    const allCues = composed ? plannedCues : [];
    const cues = allCues.filter((c) => c.startSec < endClamped && c.endSec > startSec);
    const composition = cues.length > 0 ? project.composition : null;

    const totalDuration = endClamped - startSec;
    const job = { id: jobId, projectId, excerptId, status: 'running', clients: [], process: null, totalDuration };
    jobs.set(jobId, job);
    projectExcerptRenders.set(projectId, jobId);
    handedOff = true;

    console.log(`🎬 Rendering music-video excerpt [${jobId.slice(4, 12)}]: project=${projectId.slice(0, 8)} range=[${startSec.toFixed(2)},${endClamped.toFixed(2)}]s clips=${clips.length} cues=${cues.length}`);

    // Returns whether the persistence write succeeded — the success path below
    // gates its 'complete' broadcast on it, so a director is never told an
    // excerpt is ready when the record never actually recorded it (the project
    // would otherwise stay stuck 'rendering' while the client believes it's
    // done). Error/cancel paths attempt persistence before notifying clients
    // to refresh; boot recovery clears a record if that write also fails.
    const finalize = async (patch) => {
      projectExcerptRenders.delete(projectId);
      const persisted = await settleExcerptRecord(projectId, excerptId, patch)
        .then(() => true, (err) => {
          console.error(`❌ Music-video excerpt render [${jobId.slice(4, 12)}] project ${projectId.slice(0, 8)} status→${patch.status} write failed: ${err.message}`);
          return false;
        });
      if (composition) await removeCompositionScratch(jobId).catch((err) => {
        console.warn(`⚠️ Music-video excerpt render [${jobId.slice(4, 12)}] could not remove its overlay scratch: ${err.message}`);
      });
      closeJobAfterDelay(jobs, jobId);
      // #8988: an auto-review run waiting on this draft continues from here.
      if (persisted) musicVideoEvents.emit('excerpt-render', { projectId, excerptId, status: patch.status });
      return persisted;
    };

    // A cut/cue contact sheet is a best-effort companion artifact — its
    // failure never fails an excerpt whose video encoded successfully.
    const buildContactSheet = async () => {
      try {
        const times = excerptBoundaryTimes(probe.sections, cues, startSec, endClamped, { fps: probe.fps });
        const sheetFilename = sheetFilenameFor(filename);
        await encodeFileContactSheetAtTimes(outputPath, join(PATHS.videoThumbnails, sheetFilename), times, { width: probe.canonW, height: probe.canonH, fps: probe.fps });
        return sheetFilename;
      } catch (err) {
        console.warn(`⚠️ Music-video excerpt render [${jobId.slice(4, 12)}] contact sheet failed: ${err.message}`);
        return null;
      }
    };

    const startEncode = (encodeArgs, progressBase = 0) => {
      const encodeProgress = (fraction) => progressBase + (1 - progressBase) * fraction;
      const proc = spawn(ffmpeg, encodeArgs, safeChildProcessOptions({ stdio: ['ignore', 'ignore', 'pipe'] }));
      job.process = proc;

      let stderrBuf = '';
      proc.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString();
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop();
        for (const raw of lines) {
          const line = raw.trim();
          const eq = line.indexOf('=');
          if (eq <= 0) continue;
          const key = line.slice(0, eq);
          const val = line.slice(eq + 1);
          if (key === 'out_time_us') {
            const us = parseInt(val, 10);
            if (Number.isFinite(us) && totalDuration > 0) {
              broadcastSse(job, { type: 'progress', progress: encodeProgress(Math.min(1, (us / 1_000_000) / totalDuration)) });
            }
          } else if (key === 'progress' && val === 'end') {
            broadcastSse(job, { type: 'progress', progress: 1 });
          }
        }
      });

      attachFfmpegRenderGuard(proc, {
        label: `Music-video excerpt render [${jobId.slice(4, 12)}]`,
        onProcessError: (err) => {
          job.lastError = `ffmpeg process error: ${err.message}`;
          console.log(`⚠️ Music-video excerpt render post-spawn error [${jobId.slice(4, 12)}]: ${err.message}`);
        },
        onSpawnError: async (err) => {
          job.process = null;
          job.status = 'error';
          const reason = `Failed to spawn ffmpeg: ${err.message}`;
          job.lastError = reason;
          console.error(`❌ Music-video excerpt render spawn error [${jobId.slice(4, 12)}]: ${reason}`);
          // Persist before broadcasting: a client that reloads the instant it
          // sees the terminal frame must not race ahead of the write and read
          // back a stale `status: 'rendering'`.
          await finalize({ status: 'error', error: reason, filename: null, jobId: null });
          broadcastSse(job, { type: 'error', error: reason });
        },
        onClose: async (code, signal) => {
          job.process = null;
          if (code !== 0) {
            const canceled = isMusicVideoRenderCanceled(job, signal);
            job.status = canceled ? 'canceled' : 'error';
            const reason = canceled ? 'Render cancelled' : signal ? `Killed by signal ${signal}` : `ffmpeg exit ${code}`;
            job.lastError = reason;
            const logClose = canceled ? console.log : console.error;
            logClose(`${canceled ? '🛑' : '❌'} Music-video excerpt render ${canceled ? 'cancelled' : 'failed'} [${jobId.slice(4, 12)}]: ${reason}`);
            // #8986 acceptance: cancelling an excerpt removes its partial output.
            await unlink(outputPath).catch(() => {});
            await finalize({ status: canceled ? 'canceled' : 'error', error: canceled ? null : reason, filename: null, jobId: null });
            broadcastSse(job, { type: canceled ? 'canceled' : 'error', error: reason });
            return;
          }
          try {
            job.status = 'complete';
            const contactSheetFilename = await buildContactSheet();
            const persisted = await finalize({ status: 'complete', filename, contactSheetFilename, error: null, jobId: null });
            if (!persisted) {
              // The record write never landed, so nothing else could have
              // learned these filenames to reference them — clean up rather
              // than leaving them as permanently unreferenced orphans on disk.
              await unlink(outputPath).catch(() => {});
              if (contactSheetFilename) await unlink(join(PATHS.videoThumbnails, contactSheetFilename)).catch(() => {});
              broadcastSse(job, { type: 'error', error: 'The excerpt rendered, but saving the result failed — reload the project and try again' });
              return;
            }
            console.log(`✅ Music-video excerpt rendered [${jobId.slice(4, 12)}]: ${filename}`);
            broadcastSse(job, { type: 'complete', result: { excerptId, filename, path: `/data/videos/${filename}`, contactSheetFilename, contactSheetPath: contactSheetFilename ? `/data/video-thumbnails/${contactSheetFilename}` : null } });
          } catch (err) {
            job.status = 'error';
            job.lastError = `Finalize failed: ${err.message}`;
            console.error(`❌ Music-video excerpt render finalize failed [${jobId.slice(4, 12)}]: ${err.message}`);
            await finalize({ status: 'error', error: 'Finalize failed', filename: null, jobId: null });
            broadcastSse(job, { type: 'error', error: 'Excerpt render finalize failed' });
          }
        },
      });
    };

    if (!composition) {
      const { args } = buildMusicVideoFfmpegArgs(clips, audioPath, outputPath, { audioDurationSec, frameGrid: composed, excerpt: { startSec, endSec: endClamped }, soundBed, grade: composed ? project.composition?.grade : null });
      startEncode(args);
      return { jobId, excerptId };
    }

    job.overlayAbort = new AbortController();
    const { signal } = job.overlayAbort;
    // Clamp each cue's capture start to the excerpt window: a title-card cue
    // (#8985) can span a whole song section, and capturing it from its TRUE
    // start would re-render everything before the window too, defeating the
    // point of a fast draft preview. The final `[outv]` trim below discards
    // anything before `startSec` anyway, so nothing visible is lost.
    const captureCues = cues.map((c) => ({ ...c, startSec: Math.max(c.startSec, startSec) }));
    renderTypographyOverlays({
      jobId, cues: captureCues, style, width: probe.canonW, height: probe.canonH, fps: probe.fps, durationSec: endClamped, signal,
      onProgress: (fraction) => broadcastSse(job, { type: 'progress', progress: 0.5 * fraction }),
    }).then((overlays) => {
      signal.throwIfAborted();
      job.overlayAbort = null;
      const layered = buildMusicVideoFfmpegArgs(clips, audioPath, outputPath, { audioDurationSec, overlays, frameGrid: true, excerpt: { startSec, endSec: endClamped }, soundBed, grade: composed ? project.composition?.grade : null });
      startEncode(layered.args, 0.5);
    }).catch(async (err) => {
      const canceled = signal.aborted;
      job.status = canceled ? 'canceled' : 'error';
      const reason = canceled ? 'Render cancelled' : `Typography overlay failed: ${err.message}`;
      job.lastError = reason;
      const log = canceled ? console.log : console.error;
      log(`${canceled ? '🛑' : '❌'} Music-video excerpt render ${canceled ? 'cancelled' : 'failed'} [${jobId.slice(4, 12)}]: ${reason}`);
      await finalize({ status: canceled ? 'canceled' : 'error', error: canceled ? null : reason, filename: null, jobId: null });
      broadcastSse(job, { type: canceled ? 'canceled' : 'error', error: reason });
    });

    return { jobId, excerptId };
  } finally {
    if (!handedOff) projectExcerptRenders.delete(projectId);
  }
}

// Boot recovery: like recoverStuckMusicVideoRenders in render.js, no excerpt
// render survives a restart — the job map is memory-only. Demote any excerpt
// left `status: 'rendering'` with no live job to `error` so it isn't shown as
// perpetually in-flight (and its slot doesn't 409 every later excerpt render
// on that project). #8987: delete the partial video/contact sheet the
// interrupted encode was writing, and return a selective revision that was
// rendering that draft to `open` — resumable from its checkpoint, re-rendering
// without generating anything its sections already hold. #9010: an excerpt
// whose `renderingOn` names another instance is that peer's live render, not
// ours to demote.
export async function recoverStuckMusicVideoExcerpts() {
  const instanceId = await ensureInstanceId();
  const projects = await listProjects();
  let recovered = 0;
  for (const project of projects) {
    const stuck = (project.excerpts || []).filter((e) => e.status === 'rendering'
      && !projectExcerptRenders.has(project.id) && isLocalRenderMark(e.renderingOn, instanceId));
    if (stuck.length === 0) continue;
    // Re-checked against the FRESHEST record under the write lock: a peer sync
    // landing after the list may have finished the draft or handed it to
    // another instance, and only a still-stuck local mark is demoted.
    const stuckIds = new Set(stuck.map((e) => e.id));
    const outcome = await mutateProjectRecord(project.id, (current) => {
      const demoted = (current.excerpts || []).filter((e) => stuckIds.has(e.id) && e.status === 'rendering'
        && !projectExcerptRenders.has(project.id) && isLocalRenderMark(e.renderingOn, instanceId));
      let next = current;
      for (const excerpt of demoted) {
        next = { ...next, excerpts: (next.excerpts || []).map((e) => (e.id === excerpt.id ? { ...e, status: 'error', error: 'Interrupted by a server restart', jobId: null, partialFilename: null, renderingOn: null } : e)) };
        next = settleRevisionRender(next, excerpt.id, { status: 'error', error: 'The draft render was interrupted by a server restart' });
      }
      return { project: next, demoted };
    }).catch((err) => {
      console.error(`❌ Music Video excerpt recovery: project ${project.id.slice(0, 8)} write failed: ${err.message}`);
      return null;
    });
    // Only once the record no longer points at them, so a failed write can't
    // leave a record naming a file that is gone.
    if (!outcome) continue;
    recovered += outcome.demoted.length;
    for (const { partialFilename } of outcome.demoted) {
      if (typeof partialFilename !== 'string' || !partialFilename) continue;
      await unlinkUnder(PATHS.videos, partialFilename);
      await unlinkUnder(PATHS.videoThumbnails, sheetFilenameFor(partialFilename));
    }
  }
  if (recovered > 0) console.log(`🎬 Music Video excerpt boot recovery: demoted ${recovered} stuck excerpt render(s)`);
}
