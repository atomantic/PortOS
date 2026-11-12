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
import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../../lib/fileCore.js';
import {
  MUSIC_VIDEO_BLENDER_SHEET_LIMITS, blenderRenderFrame, blenderShotFrameRange, blenderShotHandleRanges,
  normalizeBlenderHandles, normalizeBlenderRecord, normalizeBlenderSheetOptions,
} from '../../lib/musicVideoBlender.js';
import { blenderShotDir, readBlenderJson } from './workspace.js';
import { readBlenderManifest } from './manifest.js';
import { BLENDER_NO_OPTIONS_HASH, blenderImportHashes, blenderImportsChanged, blenderOptionsHash, blenderSettingsHash, blenderShotHash, blenderSongHash, hashBlenderSources } from './hashing.js';
import { writeBlenderSong } from './song.js';
import { blenderJobBase, requireBlenderFilmTool, runBlenderDriver } from './driver.js';
import { encodeBlenderPoster, encodeBlenderSheet, encodeBlenderShot } from './encode.js';
import { updateBlenderJob } from './jobs.js';
import { openBlenderJobLog } from './logs.js';
import {
  blenderFilmOptions, blenderFrameName, blenderFramePattern, blenderFramesDir, blenderRenderFile, blenderSheetName,
  blenderSheetsFile, blenderShotPoster, blenderShotVideo, blenderStillThumbnail, blenderStillsFile,
  countBlenderFrames, countBlenderHandleFrames, isBlenderRenderCurrent,
} from './renderIndex.js';

const STILLS_KEPT = 24;
const SHEETS_KEPT = 24;

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

/** The absolute frames a contact-sheet job tiles for `shot`. */
export function blenderSheetFrames(shot, fps, sheet = null) {
  const { startFrame, endFrame } = blenderShotFrameRange(shot, fps);
  const { every, range } = normalizeBlenderSheetOptions(sheet);
  let fromFrame = startFrame;
  let toFrame = endFrame;
  if (range) {
    const [startSec, endSec] = range;
    const rangeStart = Math.round(startSec * fps);
    const rangeEnd = startSec === endSec ? rangeStart + 1 : Math.round(endSec * fps);
    fromFrame = Math.max(startFrame, rangeStart);
    toFrame = Math.min(endFrame, rangeEnd);
  }
  const frames = [];
  for (let frame = fromFrame; frame < toFrame; frame += every) frames.push(frame);
  return frames;
}

const chunkArray = (items, size) => {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
};

async function recordSheets(owner, shot, frameChunks, { every, columns, fps, fromPreview, srcHash, optionsHash, songHash, imports }) {
  const directory = blenderShotDir(owner, shot.id, 'sheets');
  const file = blenderSheetsFile(owner, shot.id);
  const listed = await readBlenderJson(file, []);
  const createdAt = new Date().toISOString();
  const fresh = frameChunks.map((chunk) => ({
    file: blenderSheetName(chunk[0], chunk.at(-1), every),
    firstFrame: chunk[0],
    lastFrame: chunk.at(-1),
    every,
    columns,
    tiles: chunk.length,
    startSec: Number((chunk[0] / fps).toFixed(6)),
    endSec: Number((chunk.at(-1) / fps).toFixed(6)),
    fromPreview,
    srcHash,
    optionsHash,
    songHash,
    imports,
    createdAt,
  }));
  const names = new Set(fresh.map((sheet) => sheet.file));
  const kept = [...fresh, ...(Array.isArray(listed) ? listed : []).filter((sheet) => typeof sheet?.file === 'string' && !names.has(sheet.file))];
  for (const dropped of kept.slice(SHEETS_KEPT)) {
    await rm(join(directory, dropped.file), { force: true });
  }
  await atomicWrite(file, kept.slice(0, SHEETS_KEPT));
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

async function runContactSheet({ entry, owner, shot, settings, options, song, files, srcHash, optionsHash, songHash, sheet, log, signal }) {
  const sheetOpts = normalizeBlenderSheetOptions(sheet);
  const sheetFrames = blenderSheetFrames(shot, settings.fps, sheetOpts);
  if (!sheetFrames.length) throw jobFailure('None of the requested range falls inside this shot');

  const previewSettingsHash = blenderSettingsHash(settings, 'preview');
  const previewMeta = await isBlenderRenderCurrent(owner, shot, 'preview', {
    fps: settings.fps, shotHash: srcHash, settingsHash: previewSettingsHash, optionsHash, songHash, files,
  });
  const previewFramesDir = blenderFramesDir(owner, shot.id, 'preview');
  const previewFramePaths = previewMeta ? sheetFrames.map((f) => join(previewFramesDir, blenderFrameName(f, 'preview'))) : null;
  const hasAllPreviewFrames = previewFramePaths
    ? (await Promise.all(previewFramePaths.map((path) => lstat(path).then((info) => info.isFile(), () => false)))).every(Boolean)
    : false;

  const sheetsDir = blenderShotDir(owner, shot.id, 'sheets');
  const scratchName = `.frames-${entry.job.id}`;
  const scratchDir = join(sheetsDir, scratchName);
  let framePaths = previewFramePaths;
  let imports = previewMeta?.imports || null;

  try {
    if (hasAllPreviewFrames) {
      log.write(`PortOS: contact sheet of shot ${shot.id} from existing preview frames (${sheetFrames.length} frames, step ${sheetOpts.every})`);
    } else {
      const tool = await requireBlenderFilmTool();
      const frame = blenderRenderFrame(settings, 'sheet');
      await mkdir(scratchDir, { recursive: true });
      log.write(`PortOS: contact sheet of shot ${shot.id} (${sheetFrames.length} frames, step ${sheetOpts.every})`);
      let rendered = 0;
      let renderedSec = 0;
      const result = await runBlenderDriver({
        tool, song, signal,
        job: {
          ...blenderJobBase(owner, { settings, options }), mode: 'render', quality: 'sheet',
          scale: frame.scale, samples: frame.samples, resume: false, saveBlend: false,
          shots: [shot], frames: sheetFrames, framesDir: scratchName,
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
      imports = Array.isArray(result.events.done?.imports) ? blenderImportHashes(result.events.done.imports, files) : null;
      if (result.canceled || signal.aborted) throw jobFailure('Canceled', { canceled: true });
      if (!result.ok) {
        log.write(result.traceback || result.error);
        throw jobFailure(result.error);
      }
      framePaths = sheetFrames.map((f) => join(scratchDir, blenderFrameName(f, 'sheet')));
    }

    await mkdir(sheetsDir, { recursive: true });
    updateBlenderJob(entry, { status: 'encoding' });
    const frameChunks = chunkArray(sheetFrames, MUSIC_VIDEO_BLENDER_SHEET_LIMITS.maxTiles);
    const pathChunks = chunkArray(framePaths, MUSIC_VIDEO_BLENDER_SHEET_LIMITS.maxTiles);
    for (let index = 0; index < frameChunks.length; index += 1) {
      const chunkFrames = frameChunks[index];
      const output = join(sheetsDir, blenderSheetName(chunkFrames[0], chunkFrames.at(-1), sheetOpts.every));
      const listFile = join(sheetsDir, `.concat-${entry.job.id}-${index}.txt`);
      try {
        await encodeBlenderSheet({ frames: pathChunks[index], columns: sheetOpts.columns, listFile, output, signal });
      } finally {
        await rm(listFile, { force: true });
      }
    }
    if (signal.aborted) throw jobFailure('Canceled', { canceled: true });
    await recordSheets(owner, shot, frameChunks, {
      every: sheetOpts.every, columns: sheetOpts.columns, fps: settings.fps,
      fromPreview: hasAllPreviewFrames, srcHash, optionsHash, songHash, ...(imports ? { imports } : {}),
    });
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

/**
 * Run the render `request` (`{ owner, shotId, quality, force, times, sheet }`)
 * for the job `entry`. Resolves when the shot is rendered and, for preview and
 * final, encoded; rejects with the reason otherwise.
 */
export async function runBlenderShotRender(entry, { owner, shotId, quality, force = false, times = null, sheet = null }) {
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
    const { files } = await hashBlenderSources(owner);
    const srcHash = blenderShotHash(shot, files);
    const options = blenderFilmOptions(manifest, settings);
    const optionsHash = blenderOptionsHash(options);
    const song = await writeBlenderSong(owner, settings);
    const songHash = blenderSongHash(song);
    if (quality === 'sheet') {
      return runContactSheet({ entry, owner, shot, settings, options, song, files, srcHash, optionsHash, songHash, sheet, log, signal });
    }
    const tool = await requireBlenderFilmTool();
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
      if (!resume) await rm(framesDir, { recursive: true, force: true });
      else if (handlesChanged) {
        const names = await readdir(framesDir).catch(() => []);
        for (const name of names) {
          const match = /^handle_(in|out)_(\d{6,})\.(?:jpg|png)$/.exec(name);
          if (!match) continue;
          const f = Number(match[2]);
          const span = match[1] === 'in' ? handleRanges.in : handleRanges.out;
          if (f < span.startFrame || f >= span.endFrame) await rm(join(framesDir, name), { force: true });
        }
      }
      await mkdir(framesDir, { recursive: true });
      meta = {
        // Until done reports actual imports, partial frames conservatively depend on the snapshot.
        imports: Object.fromEntries(files),
        shotId, quality, srcHash, settingsHash, optionsHash, songHash, options, ...range,
        ...(metaHandles.in > 0 || metaHandles.out > 0 ? { handles: metaHandles } : {}),
        width: frame.width, height: frame.height, fps: settings.fps,
        samples: frame.samples, engine: settings.engine, blenderVersion: tool.version, device: null,
        startedAt: new Date(started).toISOString(), finishedAt: null, durationMs: null, complete: false,
      };
      await atomicWrite(blenderRenderFile(owner, shotId, quality), meta);
    }
    log.write(`PortOS: ${still ? 'stills' : quality} of shot ${shotId}${resume ? ' (resuming finished frames)' : ''}`);
    let rendered = 0;
    let renderedSec = 0;
    const result = await runBlenderDriver({
      tool, song, signal,
      job: {
        ...blenderJobBase(owner, { settings, options }), mode: 'render', quality, scale: frame.scale, samples: frame.samples,
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
      await atomicWrite(blenderRenderFile(owner, shotId, quality), meta);
    }
    if (result.canceled || signal.aborted) throw jobFailure('Canceled', { canceled: true });
    if (!result.ok) {
      log.write(result.traceback || result.error);
      throw jobFailure(result.error);
    }
    if (still) {
      await recordStills(owner, shot, stillFrames, { fps: settings.fps, srcHash, optionsHash, songHash, ...(imports ? { imports } : {}) });
      return;
    }
    const present = await countBlenderFrames(owner, shotId, quality, range);
    const presentHandles = await countBlenderHandleFrames(owner, shotId, quality, handleRanges);
    const missing = (range.frameCount - present)
      + (handleRanges.in.frameCount - presentHandles.inFrames)
      + (handleRanges.out.frameCount - presentHandles.outFrames);
    const expected = range.frameCount + handleRanges.in.frameCount + handleRanges.out.frameCount;
    if (missing > 0) throw jobFailure(`Blender finished, but ${missing} of ${expected} frames are missing`);
    updateBlenderJob(entry, { status: 'encoding' });
    await encodeBlenderShot({
      pattern: join(blenderFramesDir(owner, shotId, quality), blenderFramePattern(quality)),
      startFrame: range.startFrame, frameCount: range.frameCount, fps: settings.fps, quality,
      output: blenderShotVideo(owner, shotId, quality), signal,
    }).catch((error) => { throw jobFailure(signal.aborted ? 'Canceled' : error.message, { canceled: signal.aborted }); });
    // The list thumbnail: small, and still there after the frames are cleared. A render without one is still a render.
    await encodeBlenderPoster({
      frame: join(blenderFramesDir(owner, shotId, quality), blenderFrameName(range.startFrame + Math.floor(range.frameCount / 2), quality)),
      output: blenderShotPoster(owner, shotId, quality), signal,
    }).catch((error) => {
      if (signal.aborted) throw jobFailure('Canceled', { canceled: true });
      log.write(`PortOS: no poster for this render (${error.message})`);
    });
    if (signal.aborted) throw jobFailure('Canceled', { canceled: true });
    await atomicWrite(blenderRenderFile(owner, shotId, quality), {
      ...meta, blenderVersion: result.events.start?.blender || tool.version, device: result.events.start?.device || null,
      finishedAt: new Date().toISOString(), durationMs: Date.now() - started, complete: true,
    });
  });
}
