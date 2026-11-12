/**
 * One shot render of a Blender film: stills, or the preview / final frames
 * and the shot video encoded from them.
 *
 * Frames are written by Blender straight into renders/<shot>/<quality>/frames,
 * named by their absolute song frame, so a job that is cancelled or dies keeps
 * every finished frame. render.json beside them records what the frames were
 * made from; the next job resumes them only when the shot's source and the
 * render settings and song context are unchanged, and starts clean otherwise.
 */
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../../lib/fileCore.js';
import { blenderRenderFrame, blenderShotFrameRange, blenderShotHandleRanges, normalizeBlenderHandles, normalizeBlenderRecord } from '../../lib/musicVideoBlender.js';
import { blenderScratchDir, blenderShotDir, readBlenderJson } from './workspace.js';
import { readBlenderManifest } from './manifest.js';
import { BLENDER_NO_OPTIONS_HASH, blenderImportHashes, blenderImportsChanged, blenderOptionsHash, blenderSettingsHash, blenderShotHash, blenderSongHash, codeModuleClosures, filmCodeEntries, hashBlenderSources } from './hashing.js';
import { writeBlenderSong } from './song.js';
import { blenderJobBase, requireBlenderFilmTool, runBlenderDriver } from './driver.js';
import { encodeBlenderPoster, encodeBlenderShot } from './encode.js';
import { compositeFilmStill, renderFilmCodeFrames } from './codeRender.js';
import { updateBlenderJob } from './jobs.js';
import { openBlenderJobLog } from './logs.js';
import {
  blenderFilmOptions, blenderFrameName, blenderFramePattern, blenderFramesDir, blenderHandleFrameName, blenderLayerFrameName,
  blenderLayerFramePattern, blenderLayerFramesDir, blenderLayerHandleFrameName, blenderLayersRoot, blenderRenderFile, blenderShotPoster,
  blenderShotVideo, blenderStillThumbnail, blenderStillsFile, countBlenderFrames, countBlenderHandleFrames,
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

/** Every frame this quality writes, including handles, with song time and time since the shot began. */
function timedFrames(shot, fps, quality, times) {
  if (quality === 'still') {
    return blenderStillFrames(shot, fps, times).map((frame) => ({ frame, side: null, t: frame / fps, localT: frame / fps - shot.start }));
  }
  const range = blenderShotFrameRange(shot, fps);
  const handles = blenderShotHandleRanges(shot, fps);
  const frames = [];
  const push = (frame, side) => frames.push({ frame, side, t: frame / fps, localT: frame / fps - shot.start });
  for (let frame = handles.in.startFrame; frame < handles.in.endFrame; frame += 1) push(frame, 'in');
  for (let frame = range.startFrame; frame < range.endFrame; frame += 1) push(frame, null);
  for (let frame = handles.out.startFrame; frame < handles.out.endFrame; frame += 1) push(frame, 'out');
  return frames;
}

const platePath = (owner, shotId, quality, fps, frame) => {
  if (quality === 'still') return join(blenderShotDir(owner, shotId, 'stills'), blenderStillName(frame.frame, fps));
  const name = frame.side ? blenderHandleFrameName(frame.side, frame.frame, quality) : blenderFrameName(frame.frame, quality);
  return join(blenderFramesDir(owner, shotId, quality), name);
};

const layerPath = (directory, frame) => join(directory, frame.side
  ? blenderLayerHandleFrameName(frame.side, frame.frame) : blenderLayerFrameName(frame.frame));

async function dropHandleFramesOutside(directory, handleRanges) {
  const names = await readdir(directory).catch(() => []);
  for (const name of names) {
    const match = /^handle_(in|out)_(\d{6,})\.(?:jpg|png)$/.exec(name);
    if (!match) continue;
    const frame = Number(match[2]);
    const span = match[1] === 'in' ? handleRanges.in : handleRanges.out;
    if (frame < span.startFrame || frame >= span.endFrame) await rm(join(directory, name), { force: true });
  }
}

async function missingLayerFrames(directory, range, handleRanges) {
  const names = await readdir(directory).catch(() => []);
  let frames = 0;
  let inFrames = 0;
  let outFrames = 0;
  for (const name of names) {
    const main = /^frame_(\d{6,})\.png$/.exec(name);
    if (main) {
      const frame = Number(main[1]);
      if (frame >= range.startFrame && frame < range.endFrame) frames += 1;
      continue;
    }
    const handle = /^handle_(in|out)_(\d{6,})\.png$/.exec(name);
    if (!handle) continue;
    const frame = Number(handle[2]);
    const span = handle[1] === 'in' ? handleRanges.in : handleRanges.out;
    if (frame < span.startFrame || frame >= span.endFrame) continue;
    if (handle[1] === 'in') inFrames += 1;
    else outFrames += 1;
  }
  return (range.frameCount - frames) + (handleRanges.in.frameCount - inFrames) + (handleRanges.out.frameCount - outFrames);
}

async function recordStills(owner, shot, frames, { fps, srcHash, optionsHash, songHash, imports }) {
  const directory = blenderShotDir(owner, shot.id, 'stills');
  const file = blenderStillsFile(owner, shot.id);
  const listed = await readBlenderJson(file, []);
  const createdAt = new Date().toISOString();
  const fresh = frames.map((frame) => ({ file: blenderStillName(frame, fps), timeSec: Number((frame / fps).toFixed(6)), frame, srcHash, optionsHash, songHash, imports, createdAt }));
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
 * Run the render `request` (`{ owner, shotId, quality, force, times }`)
 * for the job `entry`. Resolves when the shot is rendered and, for preview and
 * final, encoded; rejects with the reason otherwise.
 */
export async function runBlenderShotRender(entry, { owner, shotId, quality, force = false, times = null }) {
  const { signal } = entry.abort;
  const log = await openBlenderJobLog(owner, entry.job.id);
  updateBlenderJob(entry, { status: 'running', logFile: log.file });
  const started = Date.now();
  const finish = async (work) => work().finally(() => log.close());
  return finish(async () => {
    const { settings } = normalizeBlenderRecord(await owner.readRecord());
    const manifest = await readBlenderManifest(owner);
    const shot = manifest?.shots.find((candidate) => candidate.id === shotId);
    if (!shot) throw jobFailure('This shot is no longer in the synced film. Sync shots from scripts and render again.');
    if (manifest.fps !== settings.fps) throw jobFailure(`The frame rate changed from ${manifest.fps} to ${settings.fps} since the last sync. Sync shots from scripts and render again.`);
    // A code shot never starts Blender. A Blender plate, with or without a code layer, still does.
    const codeShot = shot.renderer === 'code';
    const layers = Array.isArray(shot.layers) ? shot.layers : [];
    const tool = codeShot ? null : await requireBlenderFilmTool();
    const { files } = await hashBlenderSources(owner);
    const closures = await codeModuleClosures(owner, [shot]);
    const srcHash = blenderShotHash(shot, files, { closures });
    const closurePaths = [...new Set(filmCodeEntries(shot).flatMap((codeEntry) => closures.get(codeEntry) || [codeEntry]))];
    const codeImports = closurePaths.length ? blenderImportHashes(closurePaths, files) : null;
    const options = blenderFilmOptions(manifest, settings);
    const optionsHash = blenderOptionsHash(options);
    const song = await writeBlenderSong(owner, settings);
    const songHash = blenderSongHash(song);
    const still = quality === 'still';
    const frame = blenderRenderFrame(settings, quality);
    const range = blenderShotFrameRange(shot, settings.fps);
    const handleRanges = blenderShotHandleRanges(shot, settings.fps);
    const metaHandles = normalizeBlenderHandles(shot.handles);
    const settingsHash = still ? null : blenderSettingsHash(settings, quality);
    const stillFrames = still ? blenderStillFrames(shot, settings.fps, times) : null;
    if (still && !stillFrames.length) throw jobFailure('None of the requested times fall inside this shot');
    let resume = false;
    let meta = null;
    let resumedImports = null;
    if (!still) {
      const previous = await readBlenderJson(blenderRenderFile(owner, shotId, quality));
      const prevHandles = normalizeBlenderHandles(previous?.handles);
      const handlesChanged = previous != null && (Math.round(prevHandles.in * settings.fps) !== handleRanges.in.frameCount
        || Math.round(prevHandles.out * settings.fps) !== handleRanges.out.frameCount);
      // Frames built from other source, settings, options or song context are another picture: start clean.
      // When only handles changed on a completed render, resume the existing shot and overlapping handle frames.
      const resumeBase = !force && previous?.srcHash === srcHash && previous?.settingsHash === settingsHash
        && !blenderImportsChanged(previous?.imports, files)
        && (previous?.optionsHash ?? BLENDER_NO_OPTIONS_HASH) === optionsHash && previous?.songHash === songHash;
      resume = resumeBase && (previous?.complete !== true || handlesChanged);
      resumedImports = resume ? previous.imports : null;
      const framesDir = blenderFramesDir(owner, shotId, quality);
      const layersRoot = blenderLayersRoot(owner, shotId, quality);
      if (!resume) {
        await rm(framesDir, { recursive: true, force: true });
        await rm(layersRoot, { recursive: true, force: true });
      } else if (handlesChanged) {
        await dropHandleFramesOutside(framesDir, handleRanges);
        for (let index = 0; index < layers.length; index += 1) {
          await dropHandleFramesOutside(blenderLayerFramesDir(owner, shotId, quality, index), handleRanges);
        }
      }
      await mkdir(framesDir, { recursive: true });
      meta = {
        // A code shot records its module closure now. A Blender shot keeps the whole tree until the
        // driver reports the modules it actually imported, so a partial plate stays conservative.
        imports: codeShot ? (codeImports || {}) : Object.fromEntries(files),
        shotId, quality, srcHash, settingsHash, optionsHash, songHash, options, ...range,
        ...(metaHandles.in > 0 || metaHandles.out > 0 ? { handles: metaHandles } : {}),
        width: frame.width, height: frame.height, fps: settings.fps,
        samples: frame.samples, engine: settings.engine, blenderVersion: tool?.version ?? null, device: null,
        startedAt: new Date(started).toISOString(), finishedAt: null, durationMs: null, complete: false,
      };
      await atomicWrite(blenderRenderFile(owner, shotId, quality), meta);
    }
    log.write(`PortOS: ${still ? 'stills' : quality} of shot ${shotId}${resume ? ' (resuming finished frames)' : ''}${codeShot ? ' (code)' : ''}`);
    let rendered = 0;
    let renderedSec = 0;
    const noteFrame = (event) => {
      if (!event.skipped) { rendered += 1; renderedSec += event.sec; }
      updateBlenderJob(entry, {
        frame: event.frame, index: event.index, total: event.total,
        ...(rendered ? { secPerFrame: Number((renderedSec / rendered).toFixed(3)) } : {}),
      });
    };
    // Layers are canvas overlays. A code plate uses the shot's space; preview plates flatten to JPEG.
    const drawCode = async (codeEntry, fileFor, { alpha, space }) => {
      const listed = timedFrames(shot, settings.fps, quality, times).map((item) => ({ ...item, file: fileFor(item) }));
      try {
        await renderFilmCodeFrames({
          owner, jobId: entry.job.id, entry: codeEntry, space, song, width: frame.width, height: frame.height, alpha,
          paths: closures.get(codeEntry) || [codeEntry], frames: listed, signal, onFrame: noteFrame,
        });
      } catch (error) {
        if (signal.aborted || error?.name === 'AbortError') throw jobFailure('Canceled', { canceled: true });
        throw jobFailure(error.message || 'The code shot failed');
      }
    };
    let result = { ok: true, canceled: false, events: {} };
    if (codeShot) {
      if (still) await mkdir(blenderShotDir(owner, shotId, 'stills'), { recursive: true });
      await drawCode(shot.entry, (item) => platePath(owner, shotId, quality, settings.fps, item), {
        alpha: quality !== 'preview', space: shot.space || 'canvas',
      });
    } else {
      result = await runBlenderDriver({
        tool, song, signal,
        job: {
          ...blenderJobBase(owner, { settings, options }), mode: 'render', quality, scale: frame.scale, samples: frame.samples,
          resume, saveBlend: settings.saveBlend, shots: [shot], ...(still ? { frames: stillFrames } : {}),
        },
        onLog: log.write,
        onEvent: (event) => { if (event.event === 'frame') noteFrame(event); },
      });
    }
    // Reused frames may have imported modules in callbacks skipped by this run.
    const imports = !codeShot && Array.isArray(result.events.done?.imports)
      ? { ...resumedImports, ...blenderImportHashes(result.events.done.imports, files) } : null;
    if (meta && imports) {
      meta.imports = imports;
      await atomicWrite(blenderRenderFile(owner, shotId, quality), meta);
    }
    if (result.canceled || signal.aborted) throw jobFailure('Canceled', { canceled: true });
    if (!result.ok) {
      log.write(result.traceback || result.error);
      throw jobFailure(result.error);
    }
    const stillLayerRoot = join(blenderScratchDir(owner, `${entry.job.id}-layers`), 'stills');
    for (const [index, layer] of layers.entries()) {
      const directory = still ? join(stillLayerRoot, String(index)) : blenderLayerFramesDir(owner, shotId, quality, index);
      await mkdir(directory, { recursive: true });
      await drawCode(layer.entry, (item) => layerPath(directory, item), { alpha: true, space: 'canvas' });
    }
    if (still) {
      const stillsDir = blenderShotDir(owner, shotId, 'stills');
      for (const stillFrame of stillFrames) {
        const plate = join(stillsDir, blenderStillName(stillFrame, settings.fps));
        await compositeFilmStill(plate, layers.map((layer, index) => ({
          file: layerPath(join(stillLayerRoot, String(index)), { frame: stillFrame, side: null }),
          place: layer.place, blend: layer.blend,
        }))).catch((error) => { throw jobFailure(error.message || 'The code layer could not be composited'); });
      }
      await rm(stillLayerRoot, { recursive: true, force: true }).catch(() => {});
      const stillImports = codeShot ? codeImports : imports;
      await recordStills(owner, shot, stillFrames, { fps: settings.fps, srcHash, optionsHash, songHash, ...(stillImports ? { imports: stillImports } : {}) });
      return;
    }
    const present = await countBlenderFrames(owner, shotId, quality, range);
    const presentHandles = await countBlenderHandleFrames(owner, shotId, quality, handleRanges);
    let missing = (range.frameCount - present)
      + (handleRanges.in.frameCount - presentHandles.inFrames)
      + (handleRanges.out.frameCount - presentHandles.outFrames);
    for (let index = 0; index < layers.length; index += 1) {
      missing += await missingLayerFrames(blenderLayerFramesDir(owner, shotId, quality, index), range, handleRanges);
    }
    const expected = (range.frameCount + handleRanges.in.frameCount + handleRanges.out.frameCount) * (1 + layers.length);
    if (missing > 0) throw jobFailure(`The shot finished, but ${missing} of ${expected} frames are missing`);
    updateBlenderJob(entry, { status: 'encoding' });
    const framesDir = blenderFramesDir(owner, shotId, quality);
    await encodeBlenderShot({
      pattern: join(framesDir, blenderFramePattern(quality)),
      ...(layers.length ? { layers: layers.map((layer, index) => ({
        pattern: join(blenderLayerFramesDir(owner, shotId, quality, index), blenderLayerFramePattern()),
        place: layer.place, blend: layer.blend,
      })) } : {}),
      startFrame: range.startFrame, frameCount: range.frameCount, fps: settings.fps, quality,
      output: blenderShotVideo(owner, shotId, quality), signal,
    }).catch((error) => { throw jobFailure(signal.aborted ? 'Canceled' : error.message, { canceled: signal.aborted }); });
    // The list thumbnail: small, and still there after the frames are cleared. A render without one is still a render.
    const middleFrame = range.startFrame + Math.floor(range.frameCount / 2);
    const middle = join(framesDir, blenderFrameName(middleFrame, quality));
    let posterSource = middle;
    const posterScratch = blenderScratchDir(owner, `${entry.job.id}-poster`);
    if (layers.length) {
      posterSource = join(posterScratch, 'poster.png');
      await mkdir(posterScratch, { recursive: true });
      await compositeFilmStill(middle, layers.map((layer, index) => ({
        file: join(blenderLayerFramesDir(owner, shotId, quality, index), blenderLayerFrameName(middleFrame)),
        place: layer.place, blend: layer.blend,
      })), posterSource);
    }
    await encodeBlenderPoster({ frame: posterSource, output: blenderShotPoster(owner, shotId, quality), signal }).catch((error) => {
      if (signal.aborted) throw jobFailure('Canceled', { canceled: true });
      log.write(`PortOS: no poster for this render (${error.message})`);
    });
    if (layers.length) await rm(posterScratch, { recursive: true, force: true }).catch(() => {});
    if (signal.aborted) throw jobFailure('Canceled', { canceled: true });
    await atomicWrite(blenderRenderFile(owner, shotId, quality), {
      ...meta, blenderVersion: codeShot ? null : (result.events.start?.blender || tool?.version || null),
      device: codeShot ? null : (result.events.start?.device || null),
      finishedAt: new Date().toISOString(), durationMs: Date.now() - started, complete: true,
    });
  });
}
