import { assertMusicVideoMediaSelections, musicVideoMediaMode } from '../../lib/musicVideoMediaPolicy.js';
import { musicVideoGradeFilter } from '../../lib/musicVideoGrade.js';
/**
 * Music Video — render a project's composition document over the song.
 *
 * `composition.mode === 'document'` renders the project-owned HTML composition
 * (compositionDocument.js) through the music-video owner of the sandboxed
 * composition browser. Per job the document folder is copied into a private
 * scratch directory (htmlComposition `stageMusicVideoComposition`), and PortOS
 * adds the data the document draws from, before the snapshot freezes:
 *
 *   portos-mv.js  `window.PORTOS_MV = { project, render, song, lyrics, lyricMarkers,
 *                  scenes, textCues, composition }` — read with a plain <script>,
 *                  no fetch (the sandbox refuses network).
 *   song.json     the same song block the code-rendered mode reads.
 *   media/        each scene's SELECTED take (video preferred, else its still)
 *                 as `media/scene-<sceneId>.<ext>`, named by `scenes[].media.src`.
 *
 * The document stays song-timed: a full render seeks 0…durationSec, an excerpt
 * seeks the SAME song times (`startSec + n / fps`), so a draft frame matches the
 * full render at that song time. The picture is captured silent; the master
 * song (plus the optional sound-design bed) is muxed after, trimmed to the
 * window. The page declares its own size; the project's aspect ratio picks the
 * frame, and a different aspect must be listed in `portosComposition.formats`
 * (the page's optional `layout({ width, height })` hook reframes it).
 */

import { constants as fsConstants } from 'fs';
import { copyFile, mkdir, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS } from '../../lib/fileUtils.js';
import { htmlCompositionContractSchemaFor } from '../../lib/validation.js';
import { selectedPerformanceInstruction } from '../../lib/musicVideoShotTiming.js';
import { documentSceneVisualLayer } from '../../lib/musicVideoLayers.js';
import { musicVideoAspect } from '../../lib/musicVideoAspect.js';
import { documentDirectoryForRender } from './compositionDocument.js';
import { musicVideoSongDocument } from './compositionRender.js';
import { buildSongDocument } from './codeTimeline.js';
import { resolveNarrativeEvents, narrativeFrameState } from '../../lib/musicVideoNarrativeEvents.js';

export const DOCUMENT_RENDER_FPS = 24;
// The frame each project aspect renders at (the composition browser's sizes).
export const DOCUMENT_FRAME_SIZES = Object.freeze({
  '16:9': Object.freeze({ width: 1920, height: 1080 }),
  '9:16': Object.freeze({ width: 1080, height: 1920 }),
  '1:1': Object.freeze({ width: 1080, height: 1080 }),
});
const SONG_CAP_SEC = 900;

const round3 = (n) => Math.round(n * 1000) / 1000;
const finite = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);
const scriptJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');
const safeSegment = (id) => String(id || 'scene').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 80) || 'scene';

/** The project's aspect ratio (brief), defaulting to 16:9 (lib/musicVideoAspect.js). */
export const documentAspect = musicVideoAspect;

const aspectOf = (width, height) => {
  const r = width / height;
  if (Math.abs(r - 16 / 9) < 0.01) return '16:9';
  if (Math.abs(r - 9 / 16) < 0.01) return '9:16';
  if (Math.abs(r - 1) < 0.01) return '1:1';
  return `${width}x${height}`;
};

/**
 * The frame to render a validated page contract at for this project: the
 * page's own size when its aspect matches, else a size it declares in
 * `formats`. Throws COMPOSITION_DOCUMENT_FORMAT otherwise.
 */
function documentTargetFrame(contract, project) {
  const aspect = documentAspect(project);
  if (aspectOf(contract.width, contract.height) === aspect) return { ...contract };
  const { width, height } = DOCUMENT_FRAME_SIZES[aspect];
  const size = `${width}x${height}`;
  if (!contract.formats?.includes(size)) {
    throw new ServerError(`The composition document is ${contract.width}x${contract.height} and does not declare ${size} in portosComposition.formats (this project is ${aspect})`, {
      status: 422, code: 'COMPOSITION_DOCUMENT_FORMAT',
    });
  }
  return { ...contract, width, height };
}

/** The song length the document is timed against (analysis first). */
export function documentSongDuration(project) {
  const duration = finite(project?.audioAnalysis?.durationSec);
  return duration && duration > 0 ? Math.min(duration, SONG_CAP_SEC) : null;
}

/** Whole frames that fit inside the song at `fps` (the contract ceiling). */
export function documentRenderClock(songDurationSec, fps = DOCUMENT_RENDER_FPS) {
  const frames = Math.max(0, Math.floor(songDurationSec * fps + 1e-6));
  return { fps, frames, durationSec: frames / fps };
}

/**
 * Each scene's selected take as a file to stage: `Map<sceneId, { kind, path,
 * ext, inSec, outSec, fps, width, height }>`. Video is preferred over the still;
 * a scene whose selection is missing on disk gets no entry (media: null).
 * `history` is the video history list; `probe(path)` measures a clip the
 * history did not (hosted renders record no geometry).
 */
export async function resolveSceneMedia(project, { history = [], probe = async () => null, strictLayers = false } = {}) {
  assertMusicVideoMediaSelections(project);
  const byId = new Map((Array.isArray(history) ? history : []).map((entry) => [entry.id, entry]));
  const out = new Map();
  const { safeUnder } = await import('../../lib/ffmpeg.js');
  for (const scene of Array.isArray(project?.scenes) ? project.scenes : []) {
    if (!scene?.sceneId) continue;
    const layer = documentSceneVisualLayer(project, scene, { generated: strictLayers });
    // A code shot (#10297) is drawn by the document itself; it is handed no media.
    if (layer === 'code' || (strictLayers && layer === 'card')) continue;
    const entry = scene.videoHistoryId ? byId.get(scene.videoHistoryId) : null;
    const videoPath = entry?.filename ? safeUnder(PATHS.videos, entry.filename) : null;
    if ((!strictLayers || layer === 'footage') && videoPath && existsSync(videoPath)) {
      const measured = entry.numFrames && entry.fps && entry.width && entry.height ? entry : { ...entry, ...((await probe(videoPath)) || {}) };
      const duration = measured.numFrames && measured.fps ? measured.numFrames / measured.fps : null;
      const edit = selectedPerformanceInstruction(scene)?.edit ?? null;
      const ext = (/\.([a-z0-9]{2,5})$/i.exec(entry.filename)?.[1] || 'mp4').toLowerCase();
      out.set(scene.sceneId, {
        kind: 'video',
        path: videoPath,
        ext,
        inSec: edit ? round3(Math.min(edit.inSec, duration ?? edit.inSec)) : 0,
        outSec: edit ? round3(Math.min(edit.outSec, duration ?? edit.outSec)) : (duration ? round3(duration) : null),
        fps: finite(measured.fps),
        width: finite(measured.width),
        height: finite(measured.height),
      });
      continue;
    }
    const imagePath = (!strictLayers || layer === 'still') && scene.referenceImageId ? safeUnder(PATHS.images, scene.referenceImageId) : null;
    if (imagePath && existsSync(imagePath)) {
      const ext = (/\.([a-z0-9]{2,5})$/i.exec(scene.referenceImageId)?.[1] || 'png').toLowerCase();
      out.set(scene.sceneId, { kind: 'image', path: imagePath, ext: ext === 'jpeg' ? 'jpg' : ext, inSec: null, outSec: null, fps: null, width: null, height: null });
    }
  }
  return out;
}

const mediaSrc = (sceneId, media) => `media/scene-${safeSegment(sceneId)}.${media.ext}`;

function sceneDirection(project, sceneId) {
  const direction = (project?.treatment?.shotDirections || []).find((d) => d?.sceneId === sceneId);
  if (!direction) return null;
  const { mode, route, focalSubject, framing, typographyRole, emphasis, transitionIn, transitionOut } = direction;
  return { mode, route, focalSubject, framing, typographyRole, emphasis, transitionIn, transitionOut };
}

/**
 * The `window.PORTOS_MV` payload (pure). `media` is resolveSceneMedia's map;
 * `frame` is `{ width, height }`; `clock` is documentRenderClock's result.
 */
export function buildDocumentData(project, { media = new Map(), frame, clock, songDurationSec, generated = false }) {
  const song = musicVideoSongDocument(project);
  const analysis = project?.audioAnalysis || {};
  const scenes = (Array.isArray(project?.scenes) ? project.scenes : [])
    .filter((scene) => scene?.sceneId)
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((scene) => {
      const m = media.get(scene.sceneId) || null;
      const start = finite(scene.startSec);
      const end = finite(scene.endSec);
      return {
        sceneId: scene.sceneId,
        label: typeof scene.label === 'string' ? scene.label : '',
        sectionLabel: typeof scene.sectionLabel === 'string' ? scene.sectionLabel : null,
        startSec: start,
        endSec: start != null && end != null && end > start ? end : null,
        shotMode: scene.shotMode === 'performance' ? 'performance' : 'cutaway',
        visualLayer: documentSceneVisualLayer(project, scene, { generated }),
        stillMove: typeof scene.stillMove === 'string' ? scene.stillMove : null,
        cardText: typeof scene.cardText === 'string' ? scene.cardText : null,
        cardColor: typeof scene.cardColor === 'string' ? scene.cardColor : null,
        lyricText: typeof scene.lyricText === 'string' ? scene.lyricText : null,
        visualIntent: typeof scene.visualIntent === 'string' ? scene.visualIntent : null,
        direction: sceneDirection(project, scene.sceneId),
        media: m ? {
          kind: m.kind, src: mediaSrc(scene.sceneId, m),
          inSec: m.inSec, outSec: m.outSec, fps: m.fps, width: m.width, height: m.height,
        } : null,
      };
    });
  const songDocument = buildSongDocument(project);
  const lyrics = songDocument.lyrics;
  const narrative = resolveNarrativeEvents(project, songDocument.sections, clock.fps);
  if (narrative.unresolved.length) throw new ServerError(`Rebind narrative events: ${narrative.unresolved.join(', ')}`, { status: 422, code: 'NARRATIVE_EVENT_UNRESOLVED' });
  if ((project.composition?.reactiveSections || []).some((entry) => !songDocument.sections.some((section) => section.id === entry.sectionId))) {
    throw new ServerError('Rebind reactive gain caps to current composition sections', { status: 422, code: 'NARRATIVE_SECTION_UNRESOLVED' });
  }
  const composition = project?.composition || {};
  return {
    version: 1,
    project: { id: project?.id ?? null, name: project?.name ?? '', aspect: documentAspect(project) },
    render: { width: frame.width, height: frame.height, fps: clock.fps, frames: clock.frames, durationSec: clock.durationSec },
    song: {
      durationSec: songDurationSec,
      bpm: finite(analysis.bpm) ?? finite(analysis.tempo),
      beats: song.beats,
      downbeats: song.downbeats,
      sections: song.sections,
      words: song.words || [],
      narrativeEvents: narrative.events,
      narrativeSections: songDocument.sections,
      reactiveSections: project.composition?.reactiveSections || [],
      features: analysis.features || null,
    },
    lyrics,
    lyricMarkers: Array.isArray(project?.lyricMarkers) ? project.lyricMarkers : [],
    scenes,
    textCues: (composition.textCues || []).filter((cue) => cue?.text && cue.startSec != null && cue.endSec != null),
    composition: {
      mode: composition.mode || 'concat',
      style: composition.style || null,
      posterSec: composition.posterSec ?? null,
      overlay: composition.overlay || null,
    },
  };
}

/**
 * Everything a document render needs before the page opens. Throws
 * COMPOSITION_DOCUMENT_MISSING (409) or NO_TIMELINE (422).
 */
export async function prepareDocumentRender(project) {
  const directory = await documentDirectoryForRender(project);
  const songDurationSec = documentSongDuration(project);
  if (!songDurationSec) {
    throw new ServerError('A composition document is timed against the song — analyze the track first', { status: 422, code: 'NO_TIMELINE' });
  }
  const clock = documentRenderClock(songDurationSec);
  if (clock.frames < 1) throw new ServerError('The song is shorter than one frame', { status: 422, code: 'NO_TIMELINE' });
  const frame = DOCUMENT_FRAME_SIZES[documentAspect(project)];
  return { directory, songDurationSec, clock, frame, width: frame.width, height: frame.height, fps: clock.fps, durationSec: clock.durationSec };
}

/** Write portos-mv.js and copy the selected takes into a staged document folder. */
async function stageDocumentData(compositionDir, data, media) {
  await mkdir(join(compositionDir, 'media'), { recursive: true });
  for (const scene of data.scenes) {
    const m = scene.media && media.get(scene.sceneId);
    if (!m) continue;
    const target = join(compositionDir, scene.media.src);
    // Clone where the file system can (APFS), refuse to overwrite a file the
    // document shipped under PortOS's reserved name.
    await copyFile(m.path, target, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE).catch((error) => {
      if (error.code === 'EEXIST') throw new ServerError(`The composition document ships ${scene.media.src}, a name PortOS writes at render time`, { status: 422, code: 'COMPOSITION_DOCUMENT_INVALID' });
      throw error;
    });
  }
  await writeFile(join(compositionDir, 'portos-mv.js'), `window.PORTOS_MV = ${scriptJson(data)};\nwindow.PORTOS_MV_EVENT_STATE = ${narrativeFrameState.toString()};\n`);
}

/**
 * The window a render seeks, on the document's own frame grid: the full
 * contract, or `[startSec, endSec)` snapped down to a frame boundary.
 */
function documentRenderWindow(contract, { windowStart = null, windowEnd = null } = {}) {
  if (windowStart == null && windowEnd == null) return { startSec: 0, durationSec: contract.durationSec, frames: Math.round(contract.durationSec * contract.fps) };
  const fps = contract.fps;
  if (!(windowStart >= 0) || !(windowEnd > windowStart) || windowStart >= contract.durationSec - 1e-6) {
    throw new ServerError('The excerpt range must fall within the composition document', {
      status: 422, code: 'INVALID_EXCERPT_RANGE', context: { totalDuration: contract.durationSec },
    });
  }
  const firstFrame = Math.floor(windowStart * fps + 1e-6);
  const lastFrame = Math.min(Math.round(contract.durationSec * fps), Math.ceil(Math.min(windowEnd, contract.durationSec) * fps - 1e-6));
  const frames = Math.max(1, lastFrame - firstFrame);
  return { startSec: firstFrame / fps, durationSec: frames / fps, frames };
}

/** Scene boundaries inside the window, relative to it (contact-sheet sample times). */
function documentBoundaryTimes(data, window) {
  const end = window.startSec + window.durationSec;
  const times = new Set([0]);
  for (const scene of data.scenes) {
    for (const t of [scene.startSec, scene.endSec]) {
      if (t == null || t < window.startSec - 1e-6 || t >= end - 1e-3) continue;
      times.add(round3(Math.max(0, t - window.startSec)));
    }
  }
  return [...times].sort((a, b) => a - b);
}

// Mux the silent picture with the master song (and the optional bed), both
// cut to the window on SONG time.
function documentMuxArgs(videoPath, audioPath, outputPath, { startSec, durationSec, songDurationSec, soundBed = null, buildBed, audioNorm, fade = '' }) {
  if (!soundBed?.path) {
    const args = ['-hide_banner', '-loglevel', 'error', '-i', videoPath];
    if (startSec > 0) args.push('-ss', String(startSec));
    args.push('-i', audioPath, '-map', '0:v:0', '-map', '1:a:0', '-t', String(durationSec), '-c:v', 'copy',
      '-af', `atrim=duration=${durationSec},apad=whole_dur=${durationSec},asetpts=PTS-STARTPTS${fade}`,
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-y', outputPath);
    return args;
  }
  const bed = buildBed({
    beds: [{ assetPath: soundBed.path, offsetSec: 0, durationSec: songDurationSec, volume: soundBed.volume }],
    firstInputIdx: 2, mainLabel: '[master]', outLabel: '[mixa]', limitPeak: true,
  });
  const filters = [`[1:a]${audioNorm}[master]`, ...bed.filters,
    `[mixa]atrim=start=${startSec}:end=${startSec + durationSec},asetpts=PTS-STARTPTS,apad=whole_dur=${durationSec}${fade}[outa]`];
  return ['-hide_banner', '-loglevel', 'error', '-i', videoPath, '-i', audioPath, ...bed.inputs,
    '-filter_complex', filters.join(';'), '-map', '0:v:0', '-map', '[outa]', '-t', String(durationSec), '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-y', outputPath];
}

/**
 * Stage, open, capture and mux one document render (full song or a window).
 * Resolves `{ width, height, fps, durationSec, startSec, boundaryTimes }`.
 */
export async function encodeDocumentComposition({
  project, plan, jobId, audioPath, soundBed = null, outputPath, signal, onProgress, windowStart = null, windowEnd = null, fade = false,
}) {
  const { findFfmpeg, runFfmpegProcess, probeVideoGeometry, edgeFadeFilter } = await import('../../lib/ffmpeg.js');
  const { stageMusicVideoComposition } = await import('../htmlComposition/index.js');
  const { openComposition } = await import('../htmlComposition/browser.js');
  const { encodeComposition } = await import('../htmlComposition/encode.js');
  const { loadHistory } = await import('../videoGen/history.js');
  const { AUDIO_NORM, buildAudioBedMix } = await import('../videoTimeline/audioBedMix.js');
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new ServerError('ffmpeg not found on PATH', { status: 500, code: 'FFMPEG_MISSING' });
  const history = (project.scenes || []).some((s) => s?.videoHistoryId) ? await loadHistory() : [];
  const media = await resolveSceneMedia(project, { history, probe: probeVideoGeometry, strictLayers: project.composition?.document?.source?.kind === 'generated' });
  const data = buildDocumentData(project, { media, frame: plan.frame, clock: plan.clock, songDurationSec: plan.songDurationSec,
    generated: project.composition?.document?.source?.kind === 'generated' });
  const silent = `${outputPath}.silent.mp4`;
  let staged;
  let page;
  try {
    staged = await stageMusicVideoComposition(plan.directory, jobId, musicVideoSongDocument(project), {
      prepare: (dir) => stageDocumentData(dir, data, media),
    });
    signal?.throwIfAborted();
    page = await openComposition(staged.directory, { signal, streamMedia: true, mediaMode: musicVideoMediaMode(project), ownedBrowser: true });
    const metadata = await page.evaluate(`(() => {
      const c = globalThis.portosComposition;
      if (!c || typeof c.seek !== 'function') throw new Error('portosComposition.seek is required');
      return { durationSec: c.durationSec, fps: c.fps, width: c.width, height: c.height, motionBlur: c.motionBlur, formats: c.formats, layout: typeof c.layout === 'function' };
    })()`);
    const frames = metadata.durationSec * metadata.fps;
    if (Number.isFinite(frames) && metadata.fps > 0 && Math.abs(frames - Math.round(frames)) > 1e-8) {
      const lowerFrames = Math.floor(frames);
      throw new ServerError(`The composition document declares ${metadata.durationSec}s at ${metadata.fps} fps (${Number(frames.toFixed(8))} frames). Edit portosComposition.durationSec to a whole-frame duration, for example ${lowerFrames}/${metadata.fps} (${Number((lowerFrames / metadata.fps).toFixed(8))}s), and re-import the document. Review the song ending before choosing a shorter duration; PortOS has not rounded or trimmed the document.`, {
        status: 422, code: 'COMPOSITION_DOCUMENT_FRAME_ALIGNMENT',
        context: { durationSec: metadata.durationSec, fps: metadata.fps, frames },
      });
    }
    // The managed browser is Google Chrome by default; a Chromium build without
    // proprietary codecs cannot decode the H.264 takes. Say so up front instead
    // of failing on the first scene's <video> error.
    if ([...media.values()].some((m) => m.ext === 'mp4' || m.ext === 'mov')) {
      const h264 = await page.evaluate(`document.createElement('video').canPlayType('video/mp4; codecs="avc1.640028"')`);
      if (!h264) {
        throw new ServerError('The managed browser cannot decode H.264 video (a Chromium build without proprietary codecs) — point Settings › Browser at Google Chrome', {
          status: 422, code: 'COMPOSITION_BROWSER_CODEC',
        });
      }
    }
    const parsed = htmlCompositionContractSchemaFor(Math.max(1, plan.songDurationSec)).safeParse(metadata);
    if (!parsed.success) {
      throw new ServerError(`The composition document's contract is invalid — ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`, {
        status: 422, code: 'COMPOSITION_DOCUMENT_CONTRACT',
      });
    }
    const target = documentTargetFrame(parsed.data, project);
    const window = documentRenderWindow(target, { windowStart, windowEnd });
    await encodeComposition(page, { ...target, durationSec: window.durationSec }, silent, {
      videoFilter: musicVideoGradeFilter(project.composition?.grade, data.scenes, { fps: target.fps, offsetSec: window.startSec }),
      signal, offsetSec: window.startSec, onProgress: (fraction) => onProgress?.(fraction * 0.95),
    });
    page.check();
    await page.close({ verify: true });
    page = null;
    signal?.throwIfAborted();
    const mux = await runFfmpegProcess({
      bin: ffmpeg, signal,
      args: documentMuxArgs(silent, audioPath, outputPath, {
        startSec: window.startSec, durationSec: window.durationSec, songDurationSec: plan.songDurationSec,
        soundBed, buildBed: buildAudioBedMix, audioNorm: AUDIO_NORM, fade: fade ? edgeFadeFilter(window.durationSec) : '',
      }),
    });
    if (!mux.ok) {
      if (signal?.aborted || /cancelled/.test(mux.reason || '')) {
        const canceled = new Error('Render cancelled');
        canceled.code = 'CANCELED';
        throw canceled;
      }
      throw new Error(mux.reason || 'audio mux failed');
    }
    onProgress?.(1);
    return {
      width: target.width, height: target.height, fps: target.fps,
      durationSec: window.durationSec, startSec: window.startSec,
      boundaryTimes: documentBoundaryTimes(data, window),
    };
  } finally {
    if (page) await page.close().catch(() => {});
    if (staged?.scratchRoot) await rm(staged.scratchRoot, { recursive: true, force: true }).catch(() => {});
    await rm(silent, { force: true }).catch(() => {});
  }
}

/** Boot sweep: no document render survives a restart, so its scratch is stale. */
export async function sweepDocumentScratch() {
  const { MUSIC_VIDEO_SCRATCH_DIR } = await import('../htmlComposition/index.js');
  await rm(join(PATHS.data, MUSIC_VIDEO_SCRATCH_DIR), { recursive: true, force: true });
}
