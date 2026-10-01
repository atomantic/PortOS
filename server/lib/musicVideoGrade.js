/** LUT-free, opt-in Music Video grades shared by footage and document encoders. */
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
 */
export function musicVideoGradeFilter(grade, sections, { fps = 24, offsetSec = 0 } = {}) {
  const settings = normalizeMusicVideoGrade(grade);
  if (!settings) return null;
  const overrides = new Map(settings.sections.map((section) => [section.sceneId, section.preset]));
  const windows = new Map();
  for (const section of sections || []) {
    const preset = overrides.get(section.sceneId) ?? settings.preset;
    if (preset === 'neutral' || !Number.isFinite(section.startSec) || !Number.isFinite(section.endSec) || section.endSec <= section.startSec) continue;
    const start = Math.max(0, section.startSec - offsetSec);
    const end = section.endSec - offsetSec;
    if (end <= start) continue;
    const ranges = windows.get(preset) || [];
    ranges.push(`gte(t,${start})*lt(t,${end})`);
    windows.set(preset, ranges);
  }
  if (!windows.size) return null;
  const frame = `floor((T+${offsetSec})*${fps}+0.5)`;
  // Integer modular hash: portable, cheap, spatially and temporally repeatable.
  const noise = `(mod(pow(mod(X*73+Y*151+(${frame})*199,4093),2)*157,4093)/4093-0.5)`;
  const filters = ['format=gbrp'];
  for (const [preset, ranges] of windows) {
    const channels = ['r', 'g', 'b'].map((channel, i) => {
      const value = preset === 'monochrome' ? '(0.2126*r(X,Y)+0.7152*g(X,Y)+0.0722*b(X,Y))/255' : `${channel}(X,Y)/255`;
      const curve = CURVES[preset][i];
      return `${channel}='st(0,${value});255*clip(ld(0)+${curve}*ld(0)*(1-ld(0))+0.16*ld(0)*(1-ld(0))*(2*ld(0)-1)+${settings.grain}*${noise}*4*ld(0)*(1-ld(0)),0,1)'`;
    });
    filters.push(`geq=${channels.join(':')}:enable='${ranges.join('+')}'`);
  }
  return filters.join(',');
}
