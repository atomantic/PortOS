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

import { unlink } from 'fs/promises';
import { join } from 'path';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { spawn } from '../../lib/childProcess.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../../lib/sseUtils.js';
import { attachFfmpegRenderGuard } from '../../lib/ffmpegRenderGuard.js';
import { killWithEscalation } from '../../lib/killWithEscalation.js';
import { encodeFileContactSheetAtTimes } from '../htmlComposition/encode.js';
import { getProject, listProjects, mutateProjectRecord } from './projects.js';
import { planMusicVideoRender, buildMusicVideoFfmpegArgs, excerptBoundaryTimes } from './render.js';
import { renderableCues, sectionCardCues } from './composition.js';
import { renderTypographyOverlays, removeCompositionScratch } from './compositionRender.js';
import { startExcerptOnProject, applyExcerptPatch } from './excerpt.js';

const jobs = new Map();
const projectExcerptRenders = new Map();
const PENDING = Symbol('mv-excerpt-render-pending');

export const attachExcerptRenderSseClient = (jobId, res) => attachSse(jobs, jobId, res);

export function cancelExcerptRender(jobId) {
  const job = jobs.get(jobId);
  if (!job) return false;
  if (!job.process) {
    if (job.status !== 'running' || !job.overlayAbort || job.overlayAbort.signal.aborted) return false;
    job.overlayAbort.abort(new Error('Excerpt render cancelled'));
    return true;
  }
  const proc = job.process;
  killWithEscalation(proc, { label: 'music-video excerpt render', stillRunning: () => job.process === proc });
  return true;
}

/** Kick off a draft excerpt render. Returns `{ jobId, excerptId }`. */
export async function startExcerptRender(projectId, { startSec, endSec }) {
  const project = await getProject(projectId);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });

  const existingJob = projectExcerptRenders.get(projectId);
  if (existingJob && (existingJob === PENDING || jobs.has(existingJob))) {
    throw new ServerError('An excerpt render is already in progress for this project', {
      status: 409, code: 'EXCERPT_RENDER_IN_PROGRESS', context: { jobId: existingJob === PENDING ? null : existingJob },
    });
  }
  projectExcerptRenders.set(projectId, PENDING);

  let handedOff = false;
  try {
    const { ffmpeg, audioPath, composed, clips, audioDurationSec } = await planMusicVideoRender(project);
    await ensureDir(PATHS.videos);
    await ensureDir(PATHS.videoThumbnails);

    // A probe pass (no `excerpt` option) gets the full-song plan's canonical
    // dims/fps/sections/cues in ABSOLUTE song time — the coordinate space
    // `startSec`/`endSec` and `excerptBoundaryTimes` are given in.
    const probe = buildMusicVideoFfmpegArgs(clips, audioPath, join(PATHS.videos, 'probe.mp4'), { audioDurationSec, frameGrid: composed });
    if (!(startSec >= 0) || !(endSec > startSec) || endSec > probe.totalDuration + 1e-6) {
      throw new ServerError(
        `The excerpt range must fall within the project's ${probe.totalDuration.toFixed(2)}s render`,
        { status: 422, code: 'INVALID_EXCERPT_RANGE', context: { totalDuration: probe.totalDuration } },
      );
    }
    const endClamped = Math.min(endSec, probe.totalDuration);

    // Persist the new `status: 'rendering'` excerpt against the FRESHEST
    // record (not the `project` snapshot planning read above), so a
    // concurrent note/edit on another excerpt can't be clobbered.
    const { excerpt } = await mutateProjectRecord(projectId, (current) => startExcerptOnProject(current, { startSec, endSec: endClamped }));
    const excerptId = excerpt.id;
    const jobId = excerptId;
    const filename = `music-video-excerpt-${projectId.slice(0, 8)}-${Date.now()}.mp4`;
    const outputPath = join(PATHS.videos, filename);

    // Only the cue/card windows overlapping the window are worth capturing —
    // typography outside it never survives the final trim.
    const allCues = composed
      ? [...renderableCues(project.composition, probe.totalDuration), ...sectionCardCues(clips, probe.sections, probe.totalDuration)]
        .sort((a, b) => a.startSec - b.startSec)
      : [];
    const cues = allCues.filter((c) => c.startSec < endClamped && c.endSec > startSec);
    const composition = cues.length > 0 ? project.composition : null;

    const totalDuration = endClamped - startSec;
    const job = { id: jobId, projectId, excerptId, status: 'running', clients: [], process: null, totalDuration };
    jobs.set(jobId, job);
    projectExcerptRenders.set(projectId, jobId);
    handedOff = true;

    console.log(`🎬 Rendering music-video excerpt [${jobId.slice(4, 12)}]: project=${projectId.slice(0, 8)} range=[${startSec.toFixed(2)},${endClamped.toFixed(2)}]s clips=${clips.length} cues=${cues.length}`);

    const finalize = async (patch) => {
      projectExcerptRenders.delete(projectId);
      await mutateProjectRecord(projectId, (current) => ({ project: applyExcerptPatch(current, excerptId, patch) })).catch((err) => {
        console.error(`❌ Music-video excerpt render [${jobId.slice(4, 12)}] project ${projectId.slice(0, 8)} status→${patch.status} write failed: ${err.message}`);
      });
      if (composition) await removeCompositionScratch(jobId).catch((err) => {
        console.warn(`⚠️ Music-video excerpt render [${jobId.slice(4, 12)}] could not remove its overlay scratch: ${err.message}`);
      });
      closeJobAfterDelay(jobs, jobId);
    };

    // A cut/cue contact sheet is a best-effort companion artifact — its
    // failure never fails an excerpt whose video encoded successfully.
    const buildContactSheet = async () => {
      try {
        const times = excerptBoundaryTimes(probe.sections, cues, startSec, endClamped);
        const sheetFilename = `${filename.replace(/\.mp4$/, '')}-sheet.png`;
        await encodeFileContactSheetAtTimes(outputPath, join(PATHS.videoThumbnails, sheetFilename), times, { width: probe.canonW, height: probe.canonH });
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
          broadcastSse(job, { type: 'error', error: reason });
          await finalize({ status: 'error', error: reason, filename: null, jobId: null });
        },
        onClose: async (code, signal) => {
          job.process = null;
          if (code !== 0) {
            const canceled = signal === 'SIGTERM' || signal === 'SIGKILL';
            job.status = canceled ? 'canceled' : 'error';
            const reason = canceled ? 'Render cancelled' : signal ? `Killed by signal ${signal}` : `ffmpeg exit ${code}`;
            job.lastError = reason;
            const logClose = canceled ? console.log : console.error;
            logClose(`${canceled ? '🛑' : '❌'} Music-video excerpt render ${canceled ? 'cancelled' : 'failed'} [${jobId.slice(4, 12)}]: ${reason}`);
            // #8986 acceptance: cancelling an excerpt removes its partial output.
            await unlink(outputPath).catch(() => {});
            broadcastSse(job, { type: canceled ? 'canceled' : 'error', error: reason });
            await finalize({ status: canceled ? 'canceled' : 'error', error: canceled ? null : reason, filename: null, jobId: null });
            return;
          }
          try {
            job.status = 'complete';
            const contactSheetFilename = await buildContactSheet();
            await finalize({ status: 'complete', filename, contactSheetFilename, error: null, jobId: null });
            console.log(`✅ Music-video excerpt rendered [${jobId.slice(4, 12)}]: ${filename}`);
            broadcastSse(job, { type: 'complete', result: { excerptId, filename, path: `/data/videos/${filename}`, contactSheetFilename, contactSheetPath: contactSheetFilename ? `/data/video-thumbnails/${contactSheetFilename}` : null } });
          } catch (err) {
            job.status = 'error';
            job.lastError = `Finalize failed: ${err.message}`;
            console.error(`❌ Music-video excerpt render finalize failed [${jobId.slice(4, 12)}]: ${err.message}`);
            broadcastSse(job, { type: 'error', error: 'Excerpt render finalize failed' });
            await finalize({ status: 'error', error: 'Finalize failed', filename: null, jobId: null });
          }
        },
      });
    };

    if (!composition) {
      const { args } = buildMusicVideoFfmpegArgs(clips, audioPath, outputPath, { audioDurationSec, frameGrid: composed, excerpt: { startSec, endSec: endClamped } });
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
      jobId, cues: captureCues, style: composition.style, width: probe.canonW, height: probe.canonH, fps: probe.fps, durationSec: endClamped, signal,
      onProgress: (fraction) => broadcastSse(job, { type: 'progress', progress: 0.5 * fraction }),
    }).then((overlays) => {
      signal.throwIfAborted();
      job.overlayAbort = null;
      const layered = buildMusicVideoFfmpegArgs(clips, audioPath, outputPath, { audioDurationSec, overlays, frameGrid: true, excerpt: { startSec, endSec: endClamped } });
      startEncode(layered.args, 0.5);
    }).catch(async (err) => {
      const canceled = signal.aborted;
      job.status = canceled ? 'canceled' : 'error';
      const reason = canceled ? 'Render cancelled' : `Typography overlay failed: ${err.message}`;
      job.lastError = reason;
      const log = canceled ? console.log : console.error;
      log(`${canceled ? '🛑' : '❌'} Music-video excerpt render ${canceled ? 'cancelled' : 'failed'} [${jobId.slice(4, 12)}]: ${reason}`);
      broadcastSse(job, { type: canceled ? 'canceled' : 'error', error: reason });
      await finalize({ status: canceled ? 'canceled' : 'error', error: canceled ? null : reason, filename: null, jobId: null });
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
// on that project).
export async function recoverStuckMusicVideoExcerpts() {
  const projects = await listProjects();
  let recovered = 0;
  for (const project of projects) {
    const stuck = (project.excerpts || []).filter((e) => e.status === 'rendering' && !projectExcerptRenders.has(project.id));
    if (stuck.length === 0) continue;
    await mutateProjectRecord(project.id, (current) => {
      let next = current;
      for (const excerpt of stuck) {
        next = { ...next, excerpts: (next.excerpts || []).map((e) => (e.id === excerpt.id ? { ...e, status: 'error', error: 'Interrupted by a server restart', jobId: null } : e)) };
      }
      return { project: next };
    }).then(() => { recovered += stuck.length; }, (err) => {
      console.error(`❌ Music Video excerpt recovery: project ${project.id.slice(0, 8)} write failed: ${err.message}`);
    });
  }
  if (recovered > 0) console.log(`🎬 Music Video excerpt boot recovery: demoted ${recovered} stuck excerpt render(s)`);
}
