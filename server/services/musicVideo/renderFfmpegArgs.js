import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ServerError } from '../../lib/errorHandler.js';
import { BT709_CONTAINER_ARGS, H264_ENCODE_ARGS } from '../../lib/ffmpeg.js';
import { sumExpr } from '../../lib/ffmpegExpr.js';
import { musicVideoRenderCanvas } from '../../lib/musicVideo/musicVideoAspect.js';
import { cutEffectCuts } from '../../lib/musicVideo/musicVideoCutEffects.js';
import { cameraFrameWindow } from '../../lib/musicVideo/musicVideoFilmLook.js';
import { musicVideoGradeFilter } from '../../lib/musicVideo/musicVideoGrade.js';
import { musicVideoImageEffectFilter, photoSequenceArrivals, scenePhotoSequence } from '../../lib/musicVideo/musicVideoImageEffects.js';
import { STILL_PAN_TRAVEL, STILL_PUSH_ZOOM } from '../../lib/musicVideo/musicVideoLayers.js';
import { imageEffectGlitchFrames, mergeGlitchFrames, musicVideoTransitionFilter, shotGlitchFrames, transitionGlitchFrames } from '../../lib/musicVideo/musicVideoTransitions.js';
import { musicVideoWipeFilter, wipeCuts } from '../../lib/musicVideo/musicVideoWipes.js';
import { buildSongAudioMix, clipSoundVoices } from './clipSoundMix.js';

const round3 = (n) => Math.round(n * 1000) / 1000;

// The frame for a composed render with no footage to take dimensions from.
const DEFAULT_CANVAS = Object.freeze({ width: 1280, height: 720, fps: 24 });
const evenPx = (n) => Math.max(2, Math.round(n / 2) * 2);

// Bundled pixel face for the camcorder date. A missing font still draws the record box.
const OSD_FONT = join(dirname(fileURLToPath(import.meta.url)), '../../../client/public/fonts/GeistPixel-Square.ttf');
let osdFontCached;
const osdFont = () => {
  if (osdFontCached === undefined) osdFontCached = existsSync(OSD_FONT) ? OSD_FONT : null;
  return osdFontCached;
};
const filterQuoted = (value) => String(value).replace(/\\/g, '/').replace(/'/g, '').replace(/:/g, '\\:');
export const osdDateText = (value) => String(value || '').replace(/[^0-9A-Za-z :./-]/g, '').slice(0, 24).trim();

/** Crop this percent off each edge before the picture is fitted. Empty when there is nothing to hide. */
function overscanPrefix(overscan) {
  const n = Number(overscan);
  if (!Number.isFinite(n) || n <= 0) return '';
  const keep = Math.round((100 - 2 * Math.min(8, n)) * 1000) / 100000;
  return keep > 0 && keep < 1 ? `crop=iw*${keep}:ih*${keep}:(iw-ow)/2:(ih-oh)/2,` : '';
}

/** The picture rectangle inside the video canvas. Full canvas when this camera has no different frame. */
function pictureBox(c, canonW, canonH) {
  const window = c.cameraFrame?.aspect ? cameraFrameWindow(canonW, canonH, c.cameraFrame.aspect) : null;
  if (!window) return { w: canonW, h: canonH, framed: false, matte: '000000' };
  const matte = String(c.cameraFrame.matte || '').replace('#', '');
  return { w: window.w, h: window.h, framed: true, matte: /^[0-9a-f]{6}$/i.test(matte) ? matte.toLowerCase() : '000000' };
}

function osdFilter(osd, box) {
  if (!osd?.record && !osd?.date) return '';
  const font = osdFont();
  const size = Math.max(12, Math.round(Math.min(box.w, box.h) * 0.028));
  const margin = Math.max(8, Math.round(size * 0.8));
  const parts = [];
  if (osd.record) {
    parts.push(`drawbox=x=${margin}:y=${margin}:w=${size}:h=${size}:color=red@0.95:t=fill`);
    if (font) parts.push(`drawtext=fontfile='${filterQuoted(font)}':text='REC':x=${margin + size + 6}:y=${margin}:fontsize=${size}:fontcolor=white`);
  }
  const date = osdDateText(osd.date);
  if (date && font) {
    parts.push(`drawtext=fontfile='${filterQuoted(font)}':text='${filterQuoted(date)}':x=${margin}:y=${Math.max(margin, box.h - size - margin)}:fontsize=${size}:fontcolor=white`);
  }
  return parts.join(',');
}

// One overlay per photo arrival is the exact stacking order; past this many in
// one rendered section the graph is refused rather than thinned.
const PHOTO_STACK_RENDER_LIMIT = 240;

// #14277: a stacked photo sequence. Every arrival visible in this section is
// overlaid in sequence order onto a black ground at the still's cover size, then
// the shot's Move plays over the composed picture as it does over one still.
// A laid-out photo is fitted whole, scaled, faded and turned about its centre;
// a photo without a layout is cover-cropped like an ordinary still.
function stackedPhotoChain(c, inputRefs, sequence, { coverW, coverH, fps, frames, after, zoom = '' }) {
  const id = inputRefs.clip;
  const inputs = [id, ...(inputRefs.photos || [])];
  const offset = Math.round((c.photoAtSec ?? c.effectAtSec ?? 0) * fps);
  // A preroll (incoming cut effect) starts before the shot; its frames clamp to the
  // shot's first frame, so the first photo shows there as it does in a plain sequence.
  const arrivals = photoSequenceArrivals(sequence, Math.max(0, offset), Math.max(1, offset + frames));
  if (arrivals.length > PHOTO_STACK_RENDER_LIMIT) {
    throw new ServerError(`This photo sequence overlaps ${arrivals.length} photo arrivals in one shot; the render supports ${PHOTO_STACK_RENDER_LIMIT}. Shorten the overlap, lengthen the interval or split the shot.`, {
      status: 422, code: 'PHOTO_STACK_TOO_DEEP', context: { sceneId: c.sceneId, arrivals: arrivals.length, limit: PHOTO_STACK_RENDER_LIMIT },
    });
  }
  const frame = `max(0,t*${fps}+${offset}+0.000001)`;
  const copies = new Map();
  for (const arrival of arrivals) copies.set(arrival.index, (copies.get(arrival.index) || 0) + 1);
  const parts = [...copies].map(([index, count]) => {
    const layout = sequence.layouts[index];
    const labels = Array.from({ length: count }, (_, n) => `[stk${id}p${index}_${n}]`).join('');
    if (!layout) return `[${inputs[index]}:v]fps=${fps},${zoom}scale=${coverW}:${coverH}:force_original_aspect_ratio=increase,crop=${coverW}:${coverH},setsar=1,split=${count}${labels}`;
    const angle = Number((layout.rotation * Math.PI / 180).toFixed(6));
    return `[${inputs[index]}:v]fps=${fps},${zoom}scale=${Math.max(2, Math.round(coverW * layout.scale))}:${Math.max(2, Math.round(coverH * layout.scale))}:force_original_aspect_ratio=decrease,setsar=1,format=rgba`
      + (layout.opacity < 1 ? `,colorchannelmixer=aa=${layout.opacity}` : '')
      + (angle ? `,rotate=${angle}:c=none:ow=rotw(${angle}):oh=roth(${angle})` : '')
      + `,split=${count}${labels}`;
  });
  parts.push(`color=c=black:s=${coverW}x${coverH}:r=${fps},setsar=1[stk${id}_0]`);
  const used = new Map();
  arrivals.forEach((arrival, k) => {
    const n = used.get(arrival.index) || 0;
    used.set(arrival.index, n + 1);
    const layout = sequence.layouts[arrival.index];
    const at = layout ? `x='(W-w)/2+${Number((layout.x * coverW).toFixed(3))}':y='(H-h)/2+${Number((layout.y * coverH).toFixed(3))}'` : 'x=0:y=0';
    const end = Number.isFinite(arrival.end) ? `*lt(${frame},${arrival.end})` : '';
    parts.push(`[stk${id}_${k}][stk${id}p${arrival.index}_${n}]overlay=${at}:enable='gte(${frame},${arrival.start})${end}'[stk${id}_${k + 1}]`);
  });
  return `${parts.join(';')};[stk${id}_${arrivals.length}]${after}`;
}

// One section's video chain (without its output label). A footage clip is
// fitted, letterboxed and trimmed; a still (#8985) is cover-cropped and moved
// deterministically (every frame is a pure function of its frame number); a
// card is a solid colour the typography layer writes its text over. On the
// frame grid every section is cut to an exact frame count. `inputRefs` names
// the allocated ffmpeg inputs: clip (null for a card), optional end or still.
function sectionChain(c, inputRefs, { canonW, canonH, fps, frames, frameGrid, beats = [] }) {
  // On the frame grid a footage in-point (a performance edit, an intercut
  // piece #9290) is a start frame; stills and cards always start at 0.
  const startFrame = !c.layer && c.inSec > 0 ? Math.round(c.inSec * fps) : 0;
  const trim = frameGrid
    ? (startFrame > 0 ? `trim=start_frame=${startFrame}:end_frame=${startFrame + frames}` : `trim=end_frame=${frames}`)
    : `trim=start=${c.inSec}:end=${c.outSec}`;
  const options = { canonW, canonH, fps, frames, frameGrid, beats, trim };
  if (c.layer === 'card') return cardSectionChain(c, options);
  if (c.layer === 'still') return stillSectionChain(c, inputRefs, options);
  return footageSectionChain(c, inputRefs, options);
}

function cardSectionChain(c, { canonW, canonH, fps, trim }) {
  return `color=c=0x${c.cardColor.slice(1)}:s=${canonW}x${canonH}:r=${fps},setsar=1,format=yuv420p,${trim},setpts=PTS-STARTPTS`;
}

function stillSectionChain(c, inputRefs, { canonW, canonH, fps, frames, beats, trim }) {
  const box = pictureBox(c, canonW, canonH);
  const zoom = overscanPrefix(c.overscan);
  const scale = c.move === 'push' ? 2 : c.move === 'pan' ? 1 + STILL_PAN_TRAVEL : 1;
  const coverW = evenPx(box.w * scale);
  const coverH = evenPx(box.h * scale);
  const move = c.move === 'push'
    // Rendered from a 2x cover so the slow zoom does not step pixel by pixel.
    ? `zoompan=z='1+${STILL_PUSH_ZOOM}*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${box.w}x${box.h}:fps=${fps},setsar=1,`
    : c.move === 'pan' ? `crop=${box.w}:${box.h}:x='(iw-ow)*n/${Math.max(1, frames - 1)}':y='(ih-oh)/2',` : '';
  // An end frame (an end-frame image effect) is fitted and moved exactly like the still.
  // Overscan crops the source first, into the camera window, so a 4:3 frame is not a center crop of a 16:9 cover.
  const fitted = (id) => `[${id}:v]fps=${fps},${zoom}scale=${coverW}:${coverH}:force_original_aspect_ratio=increase,crop=${coverW}:${coverH},setsar=1,`
    + `${move}format=yuv420p,${trim},setpts=PTS-STARTPTS`;
  const id = inputRefs.clip;
  const end = inputRefs.end != null ? `${fitted(inputRefs.end)}[fxend${id}];` : '';
  const sequence = c.photoSequence
    ? scenePhotoSequence({ visualLayer: 'still', photoSequence: c.photoSequence, startSec: c.photoStartSec, endSec: c.photoEndSec }, { fps, beats })
    : null;
  let picture = sequence?.stacked
    ? stackedPhotoChain(c, inputRefs, sequence, { coverW, coverH, fps, frames, zoom, after: `${move}format=yuv420p,${trim},setpts=PTS-STARTPTS` })
    : fitted(id);
  if (inputRefs.photos?.length && !sequence?.stacked) {
    const frame = `max(0,t*${fps}+${Math.round((c.photoAtSec ?? c.effectAtSec ?? 0) * fps)}+0.000001)`;
    const step = sequence.switchFrames ? (sumExpr(sequence.switchFrames.map(f => `gte(${frame},${f})`)) || '0') : `floor(${frame}/${sequence.intervalFrames})`;
    inputRefs.photos.forEach((photo, i) => {
      picture += `[seq${id}_${i}];${fitted(photo)}[photo${id}_${i}];[seq${id}_${i}][photo${id}_${i}]overlay=shortest=1:enable='eq(mod(${step},${sequence.imageIds.length}),${i + 1})'`;
    });
  }
  const effect = musicVideoImageEffectFilter(c.effect, { width: box.w, height: box.h, fps, key: id, atSec: c.effectAtSec || 0, end: end ? `fxend${id}` : null });
  const finish = [osdFilter(c.osd, box), box.framed ? `pad=${canonW}:${canonH}:(ow-iw)/2:(oh-ih)/2:color=0x${box.matte}` : ''].filter(Boolean).join(',');
  return end + picture + effect + (finish ? `,${finish}` : '');
}

function footageSectionChain(c, inputRefs, { canonW, canonH, fps, frameGrid, trim }) {
  // A non-looping shot a hair longer than its source holds the last frame for
  // the remainder instead of ending early and drifting every later cut. On the
  // frame grid it also pads the rounding frame, so it always fills its count.
  const holdSec = c.loop === false ? (c.outSec - c.inSec) - (c.sourceSec ?? c.duration) : 0;
  const padSec = c.loop === false && frameGrid ? Math.max(0, holdSec) + 2 / fps : holdSec;
  const hold = padSec > 0 ? `tpad=stop_mode=clone:stop_duration=${round3(padSec)},` : '';
  // A hand-set speed retimes the clip and a negative offset holds its first frame, both before the trim.
  const speed = c.rate && c.rate !== 1 ? `setpts=(PTS-STARTPTS)/${Number(c.rate.toFixed(6))},` : '';
  const lead = c.leadSec > 0 ? `tpad=start_mode=clone:start_duration=${round3(c.leadSec)},` : '';
  // A reversed clip plays from its last frame, before any speed, offset or trim.
  const reverse = c.reverse ? 'reverse,setpts=PTS-STARTPTS,' : '';
  const timed = `${reverse}${speed}${lead}fps=${fps},${hold}${trim},setpts=PTS-STARTPTS`;
  const box = pictureBox(c, canonW, canonH);
  const zoom = overscanPrefix(c.overscan);
  const cover = `${zoom}scale=${box.w}:${box.h}:force_original_aspect_ratio=increase,crop=${box.w}:${box.h},setsar=1`;
  const fit = `${zoom}scale=${box.w}:${box.h}:force_original_aspect_ratio=decrease,setsar=1`;
  const centered = `overlay=(W-w)/2:(H-h)/2:shortest=1`;
  const osd = osdFilter(c.osd, box);
  const pad = box.framed ? `pad=${canonW}:${canonH}:(ow-iw)/2:(oh-ih)/2:color=0x${box.matte}` : '';
  const tail = [osd, pad].filter(Boolean).join(',');
  const id = inputRefs.clip;
  if (c.frameFit === 'fill') return `[${id}:v]${cover}${tail ? `,${tail}` : ''},${timed}`;
  // The shot's still, cover-fitted like a still section, fills the gaps beside the whole clip.
  if (c.frameFit === 'still' && inputRefs.still != null) {
    return `[${inputRefs.still}:v]fps=${fps},${cover}[edge${id}];[${id}:v]${fit},${timed}[clip${id}];[edge${id}][clip${id}]${centered}${tail ? `,${tail}` : ''}`;
  }
  // The clip itself, zoomed, blurred, faded and noisy with scanlines, like a worn tape behind it.
  if (c.frameFit === 'vhs') {
    return `[${id}:v]${fit},${timed},split[clip${id}][tape${id}];`
      + `[tape${id}]${cover},boxblur=lr=min(h\\,w)/20:lp=2:cr=min(ch\\,cw)/20:cp=2,eq=saturation=0.55:brightness=-0.12,noise=alls=24:allf=t+u,`
      + `drawgrid=w=iw:h=3:t=1:c=black@0.35[edge${id}];[edge${id}][clip${id}]${centered}${tail ? `,${tail}` : ''}`;
  }
  // Contain into the camera window, draw the OSD on that window, then matte it into the video.
  if (box.framed) {
    return `[${id}:v]${fit},pad=${box.w}:${box.h}:(ow-iw)/2:(oh-ih)/2:color=0x${box.matte}${osd ? `,${osd}` : ''},pad=${canonW}:${canonH}:(ow-iw)/2:(oh-ih)/2:color=0x${box.matte},${timed}`;
  }
  return `[${id}:v]${fit},pad=${canonW}:${canonH}:(ow-iw)/2:(oh-ih)/2${osd ? `,${osd}` : ''},${timed}`;
}

function planSections(clips, { fps, frameGrid }) {
  let cursorSec = 0;
  let cursorFrame = 0;
  const plan = [];
  for (const c of clips) {
    const startSec = cursorSec;
    cursorSec += c.outSec - c.inSec;
    const endFrame = Math.round(cursorSec * fps);
    const frames = endFrame - cursorFrame;
    const section = frameGrid
      ? { c, frames, startSec: cursorFrame / fps, endSec: endFrame / fps }
      : { c, frames, startSec, endSec: cursorSec };
    cursorFrame = endFrame;
    // A section shorter than half a frame has no frame of its own on the grid.
    if (!frameGrid || frames > 0) plan.push(section);
  }
  if (plan.length === 0) throw new Error('buildMusicVideoFfmpegArgs: no section spans a frame');

  return plan;
}

function buildGraphInputs(fps) {
  const args = [];
  let count = 0;
  const addFile = (path, ...options) => {
    args.push(...options, '-i', path);
    return count++;
  };
  const addStill = (path) => addFile(path, '-loop', '1', '-framerate', String(fps));
  // A generated scene clip is a reusable shot source, while the director's
  // timeline owns how long that shot appears in the music video. A LOOPING
  // clip input repeats so a 6–10s Grok/local result can fill a longer verse or
  // chorus span; the per-input trim below still makes every loop finite. A
  // non-looping clip (#8964, `loop: false`) is read once — the render preflight
  // guarantees its span fits, within COVERAGE_TOLERANCE_SEC. A still loops its
  // single image; a card needs no input (its colour is a filter source).
  const addSection = (c) => {
    if (c.layer === 'card') return { clip: null };
    if (c.layer === 'still') {
      const clip = addStill(c.imagePath);
      const photos = (c.photoPaths || []).slice(1).map(addStill);
      return c.endImagePath ? { clip, photos, end: addStill(c.endImagePath) } : { clip, photos };
    }
    const clip = c.loop === false ? addFile(c.videoPath) : addFile(c.videoPath, '-stream_loop', '-1');
    return !c.layer && c.frameFit === 'still' && c.stillPath ? { clip, still: addStill(c.stillPath) } : { clip };
  };
  return { args, addFile, addSection };
}

function buildSectionGraph(plan, layout, grade) {
  const { canonW, canonH, fps, frameGrid, beats } = layout;
  const inputs = buildGraphInputs(fps);
  // A beat toggle or dissolve (musicVideoCutEffects.js) shows the next shot's clip over
  // the end of a shot: flipping to it on the beats, or fading it in. That clip runs on the
  // song's clock, read from an input of its own, so its own section starts exactly where
  // it would without the effect. A fade through black darkens the sections either side.
  const sectionFrame = (sec) => Math.round(sec * fps);
  const cutEffects = cutEffectCuts(plan.map(({ c, startSec, endSec }) => ({
    sceneId: c.sceneId, startFrame: sectionFrame(startSec), endFrame: sectionFrame(endSec),
    partner: !!c.intercutOf, cutEffect: c.cutEffect,
  })), { fps, beats });
  const fades = cutEffects.filter((t) => t.style === 'fade-black');
  const prerolls = cutEffects.filter((t) => t.incoming).map((t) => {
    const { c } = plan[t.index + 1];
    // The footage just before the incoming shot's in-point, on the output timebase
    // its speed and offset already set. With less footage than the window before
    // the in-point it plays on from the clip's first frame instead: the flips
    // always show moving footage, never a held frame.
    const windowSec = t.windowFrames / fps;
    const { leadSec = 0, ...shot } = c;
    const inSec = Math.max(0, c.inSec - windowSec);
    const clip = c.layer ? { ...c, outSec: c.inSec + windowSec, ...(c.photoSequence ? { photoAtSec: (c.effectAtSec || 0) - windowSec } : {}) } : {
      ...shot,
      inSec,
      outSec: inSec + windowSec,
      sourceSec: (c.sourceSec ?? c.duration) - leadSec + (c.inSec - inSec),
    };
    return { ...t, clip };
  });
  const fadeChain = (i, frames) => [
    ...fades.filter((f) => f.index === i - 1 && f.inFrames > 0).map((f) => `,fade=t=in:s=0:n=${f.inFrames}`),
    ...fades.filter((f) => f.index === i).map((f) => `,fade=t=out:s=${Math.max(0, frames - f.outFrames)}:n=${f.outFrames}`),
  ].join('');
  // A wipe (musicVideoWipes.js) plays over the start of the incoming shot, the outgoing
  // shot's last frame held under it: that frame is read again from the outgoing
  // shot's own input and chain, so a segment render draws it without the other segment.
  const wipes = wipeCuts(plan.map(({ c, startSec, endSec }) => ({
    sceneId: c.sceneId, startFrame: sectionFrame(startSec), endFrame: sectionFrame(endSec),
    partner: !!c.intercutOf, wipeIn: c.wipeIn, wipeOut: c.wipeOut, transitionOut: c.transitionOut, cutEffect: c.cutEffect,
  })), { fps });
  const postrolls = wipes.map((wipe) => ({ ...wipe, into: wipe.index + 1, clip: plan[wipe.index].c }));
  // The finishing grade's windows, starting a wiped shot after its wipe (graded in its own chain).
  const gradeSections = (indexes) => indexes.map((i) => {
    const { c, startSec, endSec } = plan[i];
    const wipe = postrolls.find((p) => p.into === i);
    return { sceneId: c.sceneId, startSec: wipe ? Math.max(startSec, (wipe.cutFrame + wipe.frames) / fps) : startSec, endSec };
  });
  // One section's chain, ending on `out`: a wipe in lays the outgoing shot's held frame over its
  // start, and an incoming cut effect lays the next shot's preroll over its end.
  const sectionFilters = (i, input, out) => {
    const preroll = prerolls.find((p) => p.index === i);
    const postroll = postrolls.find((p) => p.into === i);
    const { c, frames, startSec } = plan[i];
    let head = `${sectionChain(c, input, { canonW, canonH, fps, frames, frameGrid, beats })}${fadeChain(i, frames)}`;
    const wiped = [];
    if (postroll) {
      const from = plan[postroll.index];
      // Each picture takes its own shot's grade over the wipe's frames (on song time, as the
      // finishing grade would), and the finishing grade skips them: the held frame keeps its look.
      const gradeOver = (sceneId, key) => musicVideoGradeFilter(grade, [{ sceneId, startSec: postroll.cutFrame / fps, endSec: (postroll.cutFrame + postroll.frames) / fps }],
        { fps, offsetSec: postroll.cutFrame / fps, frame: { width: canonW, height: canonH }, key });
      const heldGrade = gradeOver(from.c.sceneId, `Held${i}`);
      const baseGrade = gradeOver(c.sceneId, `Base${i}`);
      const held = `${sectionChain(from.c, postroll.input, { canonW, canonH, fps, frames: from.frames, frameGrid, beats })},`
        + `trim=start_frame=${Math.max(0, from.frames - 1)},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop=${postroll.frames},setpts=PTS-STARTPTS${heldGrade ? `,${heldGrade}` : ''}`;
      const filter = musicVideoWipeFilter(postroll, { width: canonW, height: canonH, fps, outgoing: `wpost${i}`, incoming: `wbase${i}`, out: `wiped${i}`, key: i });
      if (filter) {
        wiped.push(`${head}${baseGrade ? `,${baseGrade},format=yuv420p` : ''}[wbase${i}]`, `${held}[wpost${i}]`, ...filter);
        head = `[wiped${i}]null`;
      }
    }
    if (!preroll) return [...wiped, `${head}[${out}]`];
    const start = sectionFrame(startSec);
    const pad = Math.max(0, frames - preroll.windowFrames);
    const shown = preroll.incoming.map(([a, b]) => `between(n,${a - start},${b - start - 1})`).join('+');
    // A dissolve fades the incoming clip in across its window, fully in on the cut.
    const fadeIn = preroll.style === 'dissolve' ? `format=yuva420p,fade=t=in:s=0:n=${preroll.windowFrames + 1}:alpha=1,` : '';
    return [
      ...wiped,
      `${head}[vraw${i}]`,
      `${sectionChain(preroll.clip, preroll.input, { canonW, canonH, fps, frames: preroll.windowFrames, frameGrid, beats })}[pre${i}]`,
      `[pre${i}]${fadeIn}tpad=start=${pad}:color=black,setpts=N/(${fps}*TB)[prepad${i}]`,
      `[vraw${i}][prepad${i}]overlay=eof_action=pass:enable='${shown}'[${out}]`,
    ];
  };
  // Cut transitions repaint a few frames around their cuts, under the typography, and add no time.
  const pieces = plan.map(({ c, startSec, endSec }) => ({
    sceneId: c.sceneId, startFrame: Math.round(startSec * fps), endFrame: Math.round(endSec * fps),
    partner: !!c.intercutOf, transitionIn: c.transitionIn, transitionOut: c.transitionOut, wipeOut: c.wipeOut, effect: c.effect, effectAtSec: c.effectAtSec,
    shotGlitches: c.shotGlitches,
  }));
  // A still's glitch to its end frame paints with the same frames.
  // So do the glitches a shot sets at moments inside it.
  const glitches = mergeGlitchFrames(transitionGlitchFrames(pieces), imageEffectGlitchFrames(pieces, fps), shotGlitchFrames(pieces, fps));

  const buildSegment = (index) => {
    const own = inputs.addSection(plan[index].c);
    const preroll = prerolls.find((p) => p.index === index);
    if (preroll) preroll.input = inputs.addSection(preroll.clip);
    const postroll = postrolls.find((p) => p.into === index);
    if (postroll) postroll.input = inputs.addSection(postroll.clip);
    return sectionFilters(index, own, 'v0');
  };
  const buildAll = () => {
    const refs = plan.map(({ c }) => inputs.addSection(c));
    for (const preroll of prerolls) preroll.input = inputs.addSection(preroll.clip);
    for (const postroll of postrolls) postroll.input = inputs.addSection(postroll.clip);
    return plan.flatMap((_, i) => sectionFilters(i, refs[i], `v${i}`));
  };
  const finishingFilter = (indexes, { offsetSec = 0, localGlitches = glitches } = {}) => {
    const frame = { width: canonW, height: canonH };
    return [
      musicVideoGradeFilter(grade, gradeSections(indexes), { fps, offsetSec, frame }),
      musicVideoTransitionFilter(localGlitches, frame),
    ].filter(Boolean).join(',');
  };
  const segmentFinishingFilter = (index) => {
    const { frames, startSec } = plan[index];
    const startFrame = sectionFrame(startSec);
    const localGlitches = glitches.filter((g) => g.frame >= startFrame && g.frame < startFrame + frames)
      .map((g) => ({ ...g, frame: g.frame - startFrame }));
    return finishingFilter([index], { offsetSec: startSec, localGlitches });
  };

  return { inputs, buildSegment, buildAll, segmentFinishingFilter, finishingFilter };
}

// One plan section of a composed render as its own silent, video-only encode
// (shotSegments.js): the section's chain on the full film's timeline (cut
// effects borrowing the next shot, fades either side, its grade and glitches on
// absolute song frames, the typography windows over it), so the encoded frames
// are the ones the whole-film render draws there. `segment` is `{ index,
// maxFrames?, tagFilter? }`; `overlays` here are this window's captures, each
// with its absolute song `startSec`.
function buildSegmentArgs(segment, plan, graph, { layout, overlays, outputPath }) {
  const { canonW, canonH, fps } = layout;
  const index = segment.index;
  if (!Number.isInteger(index) || !plan[index]) throw new Error(`buildMusicVideoFfmpegArgs: no section ${index}`);
  const { c, frames, startSec } = plan[index];
  const startFrame = Math.round(startSec * fps);
  const filters = graph.buildSegment(index);
  const overlayInputs = overlays.map((overlay) => graph.inputs.addFile(overlay.path, '-itsoffset', String(round3(overlay.startSec - startSec))));
  const finishing = graph.segmentFinishingFilter(index);
  let label = 'v0';
  if (finishing) { filters.push(`[v0]${finishing}[graded]`); label = 'graded'; }
  overlayInputs.forEach((input, k) => {
    filters.push(`[${label}][${input}:v]overlay=eof_action=pass:format=auto[ov${k}]`);
    label = `ov${k}`;
  });
  // Every segment is tagged the way the composition encoder tags its own, so
  // shot segments, film-look passes and the outro join by stream copy.
  filters.push(`[${label}]format=yuv420p${segment.tagFilter ? `,${segment.tagFilter}` : ''}[outv]`);
  const outFrames = Number.isInteger(segment.maxFrames) ? Math.max(0, Math.min(frames, segment.maxFrames)) : frames;
  const args = [
    ...graph.inputs.args,
    '-filter_complex', filters.join(';'),
    '-map', '[outv]',
    '-frames:v', String(outFrames),
    '-r', String(fps),
    ...H264_ENCODE_ARGS,
    ...BT709_CONTAINER_ARGS,
    '-an',
    '-movflags', '+faststart',
    '-y',
    outputPath,
  ];
  // `shotId` is the shot whose span this section plays in: an intercut partner
  // piece or a hook card belongs to the shot it cuts into.
  return { args, sceneId: c.sceneId, shotId: c.intercutOf || c.cardOf || c.sceneId, layer: c.layer || 'footage', frames: outFrames, startFrame, startSec, endSec: (startFrame + outFrames) / fps, canonW, canonH, fps, sections: plan.length };
}

// Pure: build the ffmpeg args for the master-bed render. Concats the clips
// video-only (each scaled/padded to the canonical dims + fps and trimmed to its
// snapped out-point) and maps ONE external audio input as the sole output audio.
// `-shortest` ends the output at the shorter of (concatenated video, track).
// `overlays` (a composed render, #8984) are transparent typography clips, each
// offset to its song time and laid over the cut footage — the footage passes
// through untouched outside them, and the master audio is never re-cut.
//
// `frameGrid` (a composed render, #8985 — implied by any still/card section)
// cuts every section to a whole number of frames derived from its cumulative
// song-time boundary, so the edit never drifts more than half a frame from the
// authored timeline however many sections it has. Returns `sections`, each
// section's `[startSec, endSec)` on the output timebase.
//
// `excerpt` (#8986 — a draft excerpt render) windows the SAME full-song plan
// down to `[startSec, endSec)` with one extra filter stage after the cut/overlay
// chain is built: `trim`/`atrim` the finished `[outv]`/audio down to the window
// and re-zero their timestamps, so a footage cut and every overlay keep the
// exact absolute song-time alignment they'd have in a full render — only the
// output's first/last frame move. `sections` reports only the spans that
// overlap the window, clipped to it and re-based to the excerpt's own timeline
// (0 = `startSec`) so a contact sheet built from the excerpt file can sample
// cut boundaries directly. `totalDuration` becomes the excerpt's own length.
export function buildMusicVideoFfmpegArgs(clips, audioPath, outputPath, { audioDurationSec = null, audioStartSec = 0, overlays = [], frameGrid: gridOption = false, excerpt = null, soundBed = null, grade = null, aspect = null, beats = [], segment = null, canvas = null } = {}) {
  if (!Array.isArray(clips) || clips.length === 0) throw new Error('buildMusicVideoFfmpegArgs: empty clips');
  const frameGrid = gridOption || clips.some((c) => c.layer);
  // Stills and cards have no dimensions of their own: the first footage clip
  // sets the frame, or a default one when the render has no footage at all.
  // The project's aspect (when given) wins over a lead clip of another shape.
  // `canvas` ({ width, height, fps }) pins the frame outright: the cold open
  // is cut on the song's frame so the two join.
  const lead = clips.find((c) => !c.layer) || DEFAULT_CANVAS;
  const { width: canonW, height: canonH } = canvas || (aspect ? musicVideoRenderCanvas(aspect, lead) : lead);
  const fps = canvas?.fps || lead.fps || 24;

  const layout = { canonW, canonH, fps, frameGrid, beats };
  const plan = planSections(clips, { fps, frameGrid });
  const graph = buildSectionGraph(plan, layout, grade);
  if (segment) return buildSegmentArgs(segment, plan, graph, { layout, overlays, outputPath });
  return buildSongArgs(plan, graph, { layout, audioPath, outputPath, audioDurationSec, audioStartSec, overlays, excerpt, soundBed });
}

function buildSongArgs(plan, graph, { layout, audioPath, outputPath, audioDurationSec, audioStartSec, overlays, excerpt, soundBed }) {
  const { canonW, canonH, fps } = layout;
  const filters = graph.buildAll();
  const audioIdx = audioStartSec > 0
    ? graph.inputs.addFile(audioPath, '-ss', String(audioStartSec))
    : graph.inputs.addFile(audioPath);
  const overlayInputs = overlays.map((overlay) => graph.inputs.addFile(overlay.path, '-itsoffset', String(overlay.startSec)));
  const cutLabel = overlays.length > 0 ? 'cut0' : 'outv';
  const finishing = graph.finishingFilter(plan.map((_, i) => i));
  filters.push(`${plan.map((_, i) => `[v${i}]`).join('')}concat=n=${plan.length}:v=1:a=0[${finishing ? 'ungraded' : cutLabel}]`);
  if (finishing) filters.push(`[ungraded]${finishing}[${cutLabel}]`);
  overlayInputs.forEach((input, k) => {
    const out = k === overlayInputs.length - 1 ? 'outv' : `cut${k + 1}`;
    filters.push(`[cut${k}][${input}:v]overlay=eof_action=pass:format=auto[${out}]`);
  });

  const videoTotal = plan[plan.length - 1].endSec;
  const fullDuration = audioDurationSec != null ? Math.min(videoTotal, audioDurationSec) : videoTotal;

  let videoMap = '[outv]';
  // The song is the sole audio master unless a sound-design bed was explicitly
  // chosen (#8988) — then the bed is mixed UNDER it through the shared bed
  // chain, trimmed to the song so it can never extend or replace the master.
  let audioSrc = `[${audioIdx}:a]`;
  let audioMap = `${audioIdx}:a`;
  // A song shot may also play its own clip sound over the song (musicVideoClipSound.js).
  const voices = clipSoundVoices(plan);
  const mix = buildSongAudioMix({ mainLabel: `[${audioIdx}:a]`, soundBed, voices, firstInputIdx: audioIdx + 1 + overlays.length, durationSec: fullDuration, outLabel: '[mixa]' });
  if (mix) {
    graph.inputs.args.push(...mix.inputs);
    filters.push(...mix.filters);
    audioSrc = '[mixa]';
    audioMap = '[mixa]';
  }
  let totalDuration = fullDuration;
  let sections = plan.map(({ c, startSec, endSec }) => ({ sceneId: c.sceneId, layer: c.layer || 'footage', startSec, endSec }));

  if (excerpt) {
    const excerptStart = Math.max(0, Math.min(excerpt.startSec, fullDuration));
    const excerptEnd = Math.max(excerptStart, Math.min(excerpt.endSec, fullDuration));
    filters.push(`[outv]trim=start=${excerptStart}:end=${excerptEnd},setpts=PTS-STARTPTS[outvx]`);
    filters.push(`${audioSrc}atrim=start=${excerptStart}:end=${excerptEnd},asetpts=PTS-STARTPTS[outax]`);
    videoMap = '[outvx]';
    audioMap = '[outax]';
    totalDuration = excerptEnd - excerptStart;
    sections = sections
      .filter((s) => s.startSec < excerptEnd && s.endSec > excerptStart)
      .map((s) => ({ ...s, startSec: Math.max(0, s.startSec - excerptStart), endSec: Math.min(totalDuration, s.endSec - excerptStart) }));
  }

  const args = [
    ...graph.inputs.args,
    '-filter_complex', filters.join(';'),
    '-map', videoMap,
    '-map', audioMap,
    // Pin the output rate to the project's: left to its default, ffmpeg 7.0
    // can fall back to 25 fps and re-time the graph's frames (#11476).
    '-r', String(fps),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    '-movflags', '+faststart',
    '-progress', 'pipe:2',
    '-y',
    outputPath,
  ];
  return { args, totalDuration, canonW, canonH, fps, sections, voices };
}
