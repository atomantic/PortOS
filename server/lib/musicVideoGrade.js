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

// Grain's integer hash reads only 73X+151Y+199F mod 4093, so it repeats along (54,1) and (11,76)
// and a frame's noise is frame 0's moved 227 columns (73*227 = 199 mod 4093). Every shift lands
// inside 65 extra columns and 76 extra rows, so one plane drawn once and cropped per frame is all
// of it. geq per pixel costs about 1 s per 1080p frame (#14853); this costs under one frame's worth once.
// A noise frame starts half a frame early: lut2 takes the latest at or before a frame's time, so it
// picks the nearest song frame even where concat has rounded that time to the microsecond.
const NOISE_PERIOD = 4093;
const noisePlane = ({ width, height }, { fps, offsetSec, labels }) => {
  const code = `255*mod(pow(mod(X*73+Y*151,${NOISE_PERIOD}),2)*157,${NOISE_PERIOD})/${NOISE_PERIOD}+0.5`;
  // A negative offset is a lead-in: the noise clock would crop a negative column until the song starts.
  const clock = offsetSec < 0 ? `max(0,t+(${offsetSec}))` : `t+${offsetSec}`;
  const shift = `mod(227*floor((${clock})*${fps}+0.5),${NOISE_PERIOD})`;
  const row = `floor(${shift}/54)`;
  return `color=c=black:s=${width + 65}x${height + 76}:r=${fps},trim=end_frame=1,format=gbrp,geq=r='${code}':g='${code}':b='${code}',`
    + `loop=loop=-1:size=1,crop=${width}:${height}:x='mod(${shift},54)+11*gt(${row},0)':y='mod(76-${row},76)',settb=1/${2 * fps},setpts=PTS-1,split=${labels.length}${labels.join('')}`;
};

// Mixing at 8 bits rounds each term, which misses by 2 codes and turns white to 254.
const LUMA = [0.2126, 0.7152, 0.0722];
const MONOCHROME_MIX = ['r', 'g', 'b'].flatMap((out) => ['r', 'g', 'b'].map((from, i) => `${out}${from}=${LUMA[i]}`)).join(':');

// lutrgb and lut2 truncate like geq did, so a table entry is the value geq drew.
const toneExpr = (input, curve, grainTerm) => {
  const terms = ['ld(0)', ...(curve ? [`${curve}*ld(0)*(1-ld(0))`] : []), '0.16*ld(0)*(1-ld(0))*(2*ld(0)-1)', ...(grainTerm ? [grainTerm] : [])];
  return `st(0,${input}/255);255*clip(${terms.join('+')},0,1)`;
};

/**
 * One shared RGB filter chain. Sections are half-open SONG-time intervals.
 * Frame-addressed grain never uses RNG state, so an excerpt, a second render,
 * and different ffmpeg thread counts produce the same grain at the same time.
 * No selected effect means no colorspace round trip, preserving legacy output.
 * Every grade is a per-channel lookup table, so a grade adds no per-pixel expression.
 *
 * `frame` is the size of the frames this filters; grain and wipe masks need it. Graded
 * grain is a labeled graph that still reads as a chain, open at both ends: a caller
 * prefixes its input and appends its next filters, and gives each use in one graph its
 * own `key`, which keeps the labels apart.
 *
 * A captured document has its wipes painted before this runs, so a section may
 * carry the `wipe` that runs into it (`scenes[].wipe`, on `wipeFps`, with `frame` the
 * capture's size): the region of those frames still showing the outgoing scene takes
 * that scene's preset, through a mask (`musicVideoWipeHeldMask`). A wipe between
 * two scenes with one preset changes nothing, down to the filter text.
 * `durationSec` bounds the capture, so a wipe past its end costs nothing.
 */
export function musicVideoGradeFilter(grade, sections, { fps = 24, offsetSec = 0, durationSec = null, frame = null, wipeFps = fps, key = '' } = {}) {
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
  const label = (name) => `[grade${key}${name}]`;
  const noiseLabels = [];
  const grades = (byPreset) => [...byPreset].map(([preset, ranges]) => {
    const enable = `enable='${sumExpr(ranges)}'`;
    const luma = preset === 'monochrome' ? ['format=gbrp16le', `colorchannelmixer=${MONOCHROME_MIX}:${enable}`, 'format=gbrp'] : [];
    const [r, g, b] = CURVES[preset];
    if (!settings.grain) return [...luma, `lutrgb=r='${toneExpr('val', r)}':g='${toneExpr('val', g)}':b='${toneExpr('val', b)}':${enable}`].join(',');
    const input = label(`Tone${noiseLabels.length}`);
    const noise = label(`Noise${noiseLabels.length}`);
    noiseLabels.push(noise);
    const grainTerm = `${settings.grain}*(y/255-0.5)*4*ld(0)*(1-ld(0))`;
    // gbrp planes run g, b, r.
    return `${[...luma, 'null'].join(',')}${input};${input}${noise}lut2=c0='${toneExpr('x', g, grainTerm)}':c1='${toneExpr('x', b, grainTerm)}':c2='${toneExpr('x', r, grainTerm)}':shortest=1:${enable}`;
  }).join(',');
  const held = new Map();
  for (const { preset, first, last } of spans) {
    if (preset !== 'neutral') held.set(preset, [...(held.get(preset) || []), `between(n,${first},${last})`]);
  }
  const whole = grades(windows);
  const heldChain = grades(held);
  const noise = noiseLabels.length ? [noisePlane(frame, { fps, offsetSec, labels: noiseLabels })] : [];
  // The chain that opens the graph comes first: a caller's input joins the first open chain.
  if (!spans.length) return noise.length ? [`format=gbrp${label('In')}`, ...noise, `${label('In')}${whole}`].join(';') : `format=gbrp,${whole}`;
  return [
    `format=gbrp,split${label('Whole')}${label('Held')}`,
    ...noise,
    `${label('Whole')}${whole || 'null'}${label('GradedWhole')}`,
    `${label('Held')}${heldChain || 'null'}${label('GradedHeld')}`,
    `${musicVideoWipeHeldMask(spans, { ...frame, fps, offsetSec, wipeFps })}${label('Mask')}`,
    `${label('GradedWhole')}${label('GradedHeld')}${label('Mask')}maskedmerge`,
  ].join(';');
}
