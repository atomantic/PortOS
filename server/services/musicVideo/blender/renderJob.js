/**
 * One shot render of a Blender film: stills, or the preview / final frames
 * and the shot video encoded from them.
 *
 * Frames are written by Blender straight into renders/<shot>/<quality>/frames,
 * named by their absolute song frame, so a job that is cancelled or dies keeps
 * every finished frame. render.json beside them records what the frames were
 * made from; the next job resumes them only when the shot's source and the
 * render settings are unchanged, and starts clean otherwise.
 */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../../../lib/fileCore.js';
import { blenderRenderFrame, blenderShotFrameRange, normalizeBlenderRecord } from '../../../lib/musicVideoBlender.js';
import { requireProject } from '../requireProject.js';
import { blenderShotDir, readBlenderJson } from './workspace.js';
import { readBlenderManifest } from './manifest.js';
import { BLENDER_NO_OPTIONS_HASH, blenderImportHashes, blenderImportsChanged, blenderOptionsHash, blenderSettingsHash, blenderShotHash, hashBlenderSources } from './hashing.js';
import { writeBlenderSong } from './song.js';
import { blenderJobBase, requireBlenderFilmTool, runBlenderDriver } from './driver.js';
import { encodeBlenderPoster, encodeBlenderShot } from './encode.js';
import { updateBlenderJob } from './jobs.js';
import { openBlenderJobLog } from './logs.js';
import {
  blenderFilmOptions, blenderFrameName, blenderFramePattern, blenderFramesDir, blenderRenderFile, blenderShotPoster, blenderShotVideo,
  blenderStillThumbnail, blenderStillsFile, countBlenderFrames,
} from './renderIndex.js';

const STILLS_KEPT = 24;

/** A failure the job reports as its error; `canceled` marks an aborted run. */
const jobFailure = (message, { canceled = false } = {}) => Object.assign(new Error(message), { canceled });

/** The file name of the still at absolute song frame `frame` (song time in milliseconds). */
export const blenderStillName = (frame, fps) => `t${String(Math.round((frame / fps) * 1000)).padStart(9, '0')}.png`;

/** The absolute frames a still job renders for `shot`: the requested song times inside it, else its midpoint. */
export function blenderStillFrames(shot, fps, times = null) {
  const { startFrame, endFrame } = blenderShotFrameRange(shot, fps);
  if (!Array.isArray(times)) return [startFrame + Math.floor((endFrame - startFrame) / 2)];
  const frames = times.map((time) => Math.round(time * fps)).filter((frame) => frame >= startFrame && frame < endFrame);
  return [...new Set(frames)].sort((a, b) => a - b);
}

async function recordStills(projectId, shot, frames, { fps, srcHash, optionsHash, imports }) {
  const directory = blenderShotDir(projectId, shot.id, 'stills');
  const file = blenderStillsFile(projectId, shot.id);
  const listed = await readBlenderJson(file, []);
  const createdAt = new Date().toISOString();
  const fresh = frames.map((frame) => ({ file: blenderStillName(frame, fps), timeSec: Number((frame / fps).toFixed(6)), frame, srcHash, optionsHash, imports, createdAt }));
  const { default: sharp } = await import('sharp');
  for (const still of fresh) {
    const source = join(directory, still.file);
    await sharp(source).resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 70 }).toFile(blenderStillThumbnail(source));
  }
  const names = new Set(fresh.map((still) => still.file));
  const kept = [...fresh, ...(Array.isArray(listed) ? listed : []).filter((still) => typeof still?.file === 'string' && !names.has(still.file))];
  for (const dropped of kept.slice(STILLS_KEPT)) {
    await rm(join(directory, dropped.file), { force: true });
    await rm(join(directory, blenderStillThumbnail(dropped.file)), { force: true });
  }
  await atomicWrite(file, kept.slice(0, STILLS_KEPT));
}

/**
 * Run the render `request` (`{ projectId, shotId, quality, force, times }`)
 * for the job `entry`. Resolves when the shot is rendered and, for preview and
 * final, encoded; rejects with the reason otherwise.
 */
export async function runBlenderShotRender(entry, { projectId, shotId, quality, force = false, times = null }) {
  const { signal } = entry.abort;
  const log = await openBlenderJobLog(projectId, entry.job.id);
  updateBlenderJob(entry, { status: 'running', logFile: log.file });
  const started = Date.now();
  const finish = async (work) => work().finally(() => log.close());
  return finish(async () => {
    const tool = await requireBlenderFilmTool();
    const project = await requireProject(projectId);
    const { settings } = normalizeBlenderRecord(project.blender);
    const manifest = await readBlenderManifest(projectId);
    const shot = manifest?.shots.find((candidate) => candidate.id === shotId);
    if (!shot) throw jobFailure('This shot is no longer in the synced film. Sync shots from scripts and render again.');
    if (manifest.fps !== settings.fps) throw jobFailure(`The frame rate changed from ${manifest.fps} to ${settings.fps} since the last sync. Sync shots from scripts and render again.`);
    const { files } = await hashBlenderSources(projectId);
    const srcHash = blenderShotHash(shot, files);
    const options = blenderFilmOptions(manifest, settings);
    const optionsHash = blenderOptionsHash(options);
    const song = await writeBlenderSong(project, settings);
    const still = quality === 'still';
    const frame = blenderRenderFrame(settings, quality);
    const range = blenderShotFrameRange(shot, settings.fps);
    const settingsHash = still ? null : blenderSettingsHash(settings, quality);
    const stillFrames = still ? blenderStillFrames(shot, settings.fps, times) : null;
    if (still && !stillFrames.length) throw jobFailure('None of the requested times fall inside this shot');
    let resume = false;
    let meta = null;
    let resumedImports = null;
    if (!still) {
      const previous = await readBlenderJson(blenderRenderFile(projectId, shotId, quality));
      // Frames built from other source, settings or options are another picture: start clean.
      resume = !force && previous?.complete !== true && previous?.srcHash === srcHash && previous?.settingsHash === settingsHash
        && !blenderImportsChanged(previous?.imports, files)
        && (previous?.optionsHash ?? BLENDER_NO_OPTIONS_HASH) === optionsHash;
      resumedImports = resume ? previous.imports : null;
      const framesDir = blenderFramesDir(projectId, shotId, quality);
      if (!resume) await rm(framesDir, { recursive: true, force: true });
      await mkdir(framesDir, { recursive: true });
      meta = {
        // Until done reports actual imports, partial frames conservatively depend on the snapshot.
        imports: Object.fromEntries(files),
        shotId, quality, srcHash, settingsHash, optionsHash, options, ...range, width: frame.width, height: frame.height, fps: settings.fps,
        samples: frame.samples, engine: settings.engine, blenderVersion: tool.version, device: null,
        startedAt: new Date(started).toISOString(), finishedAt: null, durationMs: null, complete: false,
      };
      await atomicWrite(blenderRenderFile(projectId, shotId, quality), meta);
    }
    log.write(`PortOS: ${still ? 'stills' : quality} of shot ${shotId}${resume ? ' (resuming finished frames)' : ''}`);
    let rendered = 0;
    let renderedSec = 0;
    const result = await runBlenderDriver({
      tool, song, signal,
      job: {
        ...blenderJobBase(projectId, { settings, options }), mode: 'render', quality, scale: frame.scale, samples: frame.samples,
        resume, saveBlend: settings.saveBlend, shots: [shot], ...(still ? { frames: stillFrames } : {}),
      },
      onLog: log.write,
      onEvent: (event) => {
        if (event.event !== 'frame') return;
        if (!event.skipped) { rendered += 1; renderedSec += event.sec; }
        updateBlenderJob(entry, {
          frame: event.frame, index: event.index, total: event.total,
          ...(rendered ? { secPerFrame: Number((renderedSec / rendered).toFixed(3)) } : {}),
        });
      },
    });
    // Reused frames may have imported modules in callbacks skipped by this run.
    const imports = Array.isArray(result.events.done?.imports)
      ? { ...resumedImports, ...blenderImportHashes(result.events.done.imports, files) } : null;
    if (meta && imports) {
      meta.imports = imports;
      await atomicWrite(blenderRenderFile(projectId, shotId, quality), meta);
    }
    if (result.canceled || signal.aborted) throw jobFailure('Canceled', { canceled: true });
    if (!result.ok) {
      log.write(result.traceback || result.error);
      throw jobFailure(result.error);
    }
    if (still) {
      await recordStills(projectId, shot, stillFrames, { fps: settings.fps, srcHash, optionsHash, ...(imports ? { imports } : {}) });
      return;
    }
    const present = await countBlenderFrames(projectId, shotId, quality, range);
    if (present !== range.frameCount) throw jobFailure(`Blender finished, but ${range.frameCount - present} of ${range.frameCount} frames are missing`);
    updateBlenderJob(entry, { status: 'encoding' });
    await encodeBlenderShot({
      pattern: join(blenderFramesDir(projectId, shotId, quality), blenderFramePattern(quality)),
      startFrame: range.startFrame, frameCount: range.frameCount, fps: settings.fps, quality,
      output: blenderShotVideo(projectId, shotId, quality), signal,
    }).catch((error) => { throw jobFailure(signal.aborted ? 'Canceled' : error.message, { canceled: signal.aborted }); });
    // The list thumbnail: small, and still there after the frames are cleared. A render without one is still a render.
    await encodeBlenderPoster({
      frame: join(blenderFramesDir(projectId, shotId, quality), blenderFrameName(range.startFrame + Math.floor(range.frameCount / 2), quality)),
      output: blenderShotPoster(projectId, shotId, quality), signal,
    }).catch((error) => log.write(`PortOS: no poster for this render (${error.message})`));
    await atomicWrite(blenderRenderFile(projectId, shotId, quality), {
      ...meta, blenderVersion: result.events.start?.blender || tool.version, device: result.events.start?.device || null,
      finishedAt: new Date().toISOString(), durationMs: Date.now() - started, complete: true,
    });
  });
}
