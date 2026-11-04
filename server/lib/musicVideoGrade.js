/** LUT-free, opt-in Music Video grades shared by footage and document encoders. */
import { sumExpr } from './ffmpegExpr.js';
import { musicVideoWipeHeldMask } from './musicVideoWipes.js';

export const MUSIC_VIDEO_GRADE_PRESETS = ['neutral', 'teal-night', 'golden-hour', 'monochrome'];
export const MUSIC_VIDEO_GRADE_MAX_GRAIN = 0.03;
export const MUSIC_VIDEO_GRADE_DEFAULT_GRAIN = 0.012;

export function normalizeMusicVideoGrade(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const preset = (value) => MUSIC_VIDEO_GRADE_PRESETS.includes(value) ? value : 'neutral';
  const seen = new Set();
  const sections = (Array.isArray(input.sections) ? input.sections : []).filter((section) => {
    if (typeof section?.sceneId !== 'string' || !section.sceneId || section.sceneId.length > 120 || seen.has(section.sceneId)) return false;
    seen.add(section.sceneId);
    return true;
  }).slice(0, 1000).map((section) => ({ sceneId: section.sceneId, preset: preset(section.preset) }));
  return {
    preset: preset(input.preset),
    grain: Number.isFinite(input.grain) ? Math.max(0, Math.min(MUSIC_VIDEO_GRADE_MAX_GRAIN, input.grain)) : MUSIC_VIDEO_GRADE_DEFAULT_GRAIN,
    sections,
  };
}

// Curves preserve black and white. Maximum channel displacement stays below 8% and
// grain tapers to zero at both endpoints, so document text remains readable.
const CURVES = {
  'teal-night': [-0.22, 0.05, 0.2],
  'golden-hour': [0.22, 0.07, -0.18],
  monochrome: [0, 0, 0],
};

/**
 * One shared RGB filter chain. Sections are half-open SONG-time intervals.
 * Frame-addressed grain never uses RNG state, so an excerpt, a second render,
 * and different ffmpeg thread counts produce the same grain at the same time.
 * No selected effect means no colorspace round trip, preserving legacy output.
 *
 * A captured document has its wipes painted before this runs, so a section may
 * carry the `wipe` that runs into it (`scenes[].wipe`, on `wipeFps`, with `frame` the
 * capture's size): the region of those frames still showing the outgoing scene takes
 * that scene's preset, through a mask (`musicVideoWipeHeldMask`). A wipe between
 * two scenes with one preset changes nothing, down to the filter text.
 * `durationSec` bounds the capture, so a wipe past its end costs nothing.
 */
export function musicVideoGradeFilter(grade, sections, { fps = 24, offsetSec = 0, durationSec = null, frame = null, wipeFps = fps } = {}) {
  const settings = normalizeMusicVideoGrade(grade);
  if (!settings) return null;
  const overrides = new Map(settings.sections.map((section) => [section.sceneId, section.preset]));
  const presetOf = (sceneId) => overrides.get(sceneId) ?? settings.preset;
  const windows = new Map();
  for (const section of sections || []) {
    const preset = presetOf(section.sceneId);
    if (preset === 'neutral' || !Number.isFinite(section.startSec) || !Number.isFinite(section.endSec) || section.endSec <= section.startSec) continue;
    const start = Math.max(0, section.startSec - offsetSec);
    const end = section.endSec - offsetSec;
    if (end <= start) continue;
    const ranges = windows.get(preset) || [];
    ranges.push(`gte(t,${start})*lt(t,${end})`);
    windows.set(preset, ranges);
  }
  const captureFrames = Number.isFinite(durationSec) ? Math.round(durationSec * fps) : Infinity;
  // The first capture frame the page draws a wipe-clock frame on: it picks floor(t * wipeFps + 1e-6).
  const captureFrameOf = (clockFrame) => Math.ceil(((clockFrame - 1e-6) / wipeFps - offsetSec) * fps);
  const spans = (sections || []).flatMap(({ sceneId, wipe }) => {
    if (!wipe || presetOf(wipe.fromSceneId) === presetOf(sceneId)) return [];
    const first = Math.max(0, captureFrameOf(wipe.cutFrame));
    const last = Math.min(captureFrames - 1, captureFrameOf(wipe.cutFrame + wipe.frames) - 1);
    return last >= first ? [{ wipe, first, last, preset: presetOf(wipe.fromSceneId) }] : [];
  });
  if (!windows.size && !spans.length) return null;
  const songFrame = `floor((T+${offsetSec})*${fps}+0.5)`;
  // Integer modular hash: portable, cheap, spatially and temporally repeatable.
  const noise = `(mod(pow(mod(X*73+Y*151+(${songFrame})*199,4093),2)*157,4093)/4093-0.5)`;
  const grades = (byPreset) => [...byPreset].map(([preset, ranges]) => {
    const channels = ['r', 'g', 'b'].map((channel, i) => {
      const value = preset === 'monochrome' ? '(0.2126*r(X,Y)+0.7152*g(X,Y)+0.0722*b(X,Y))/255' : `${channel}(X,Y)/255`;
      const curve = CURVES[preset][i];
      // geq evaluates every term per pixel, so a zero term is left out, not multiplied by 0 (#14845).
      const terms = ['ld(0)', ...(curve ? [`${curve}*ld(0)*(1-ld(0))`] : []), '0.16*ld(0)*(1-ld(0))*(2*ld(0)-1)',
        ...(settings.grain ? [`${settings.grain}*${noise}*4*ld(0)*(1-ld(0))`] : [])];
      return `${channel}='st(0,${value});255*clip(${terms.join('+')},0,1)'`;
    });
    return `geq=${channels.join(':')}:enable='${sumExpr(ranges)}'`;
  });
  if (!spans.length) return ['format=gbrp', ...grades(windows)].join(',');
  const held = new Map();
  for (const { preset, first, last } of spans) {
    if (preset !== 'neutral') held.set(preset, [...(held.get(preset) || []), `between(n,${first},${last})`]);
  }
  const chain = (filters) => filters.join(',') || 'null';
  return [
    'format=gbrp,split[gradeWhole][gradeHeld]',
    `[gradeWhole]${chain(grades(windows))}[gradedWhole]`,
    `[gradeHeld]${chain(grades(held))}[gradedHeld]`,
    `${musicVideoWipeHeldMask(spans, { ...frame, fps, offsetSec, wipeFps })}[gradeMask]`,
    '[gradedWhole][gradedHeld][gradeMask]maskedmerge',
  ].join(';');
}
