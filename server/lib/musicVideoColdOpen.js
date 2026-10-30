/**
 * Music Video — the cold open: shots marked "Before the song" (`scene.preMusic`)
 * play first, in storyboard order, before the song's first note. The song's
 * own clock (lyric timing, beats, the Plan timing check, song shots'
 * `startSec`/`endSec`) never moves: the cold open runs on a clock of its own in
 * front of it, the way the ending runs after it. Each cold-open shot has its
 * own length and its own sound: silence, the clip's own audio, and/or sound
 * layers (an effect PortOS synthesizes, or a music-library track) placed in it.
 * Browser-safe.
 */

export const PRE_MUSIC_DURATION_RANGE = Object.freeze({ min: 0.5, max: 120 });
export const PRE_MUSIC_DEFAULT_DURATION_SEC = 4;
export const PRE_MUSIC_VOLUME_RANGE = Object.freeze({ min: 0, max: 2 });
export const PRE_MUSIC_LAYER_LIMIT = 8;

/**
 * Effects synthesized by ffmpeg (no file, no model): `source` is the lavfi
 * graph that plays it at full level; a one-shot has `oneShotSec`, the others
 * run for as long as the layer does.
 */
export const PRE_MUSIC_EFFECTS = Object.freeze([
  { id: 'play-button', label: 'Play button clunk', oneShotSec: 0.4,
    source: "aevalsrc=exprs='0.9*exp(-70*t)*sin(2*PI*1150*t)+0.7*gte(t,0.08)*exp(-55*(t-0.08))*sin(2*PI*190*(t-0.08))':s=48000:c=stereo" },
  { id: 'tape-hiss', label: 'Tape hiss',
    source: 'anoisesrc=color=white:amplitude=0.05:r=48000,highpass=f=2500,lowpass=f=12000,aformat=channel_layouts=stereo' },
  { id: 'room-tone', label: 'Room tone',
    source: 'anoisesrc=color=brown:amplitude=0.25:r=48000,lowpass=f=320,aformat=channel_layouts=stereo' },
  { id: 'mains-hum', label: 'Mains hum',
    source: "aevalsrc=exprs='0.05*sin(2*PI*60*t)+0.03*sin(2*PI*120*t)+0.015*sin(2*PI*180*t)':s=48000:c=stereo" },
]);
export const PRE_MUSIC_EFFECT_IDS = Object.freeze(PRE_MUSIC_EFFECTS.map((effect) => effect.id));
export const preMusicEffect = (id) => PRE_MUSIC_EFFECTS.find((effect) => effect.id === id) || null;

const round3 = (n) => Math.round(n * 1000) / 1000;
const clamp = (value, { min, max }) => Math.min(max, Math.max(min, value));
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function normalizeLayer(layer) {
  if (!layer || typeof layer !== 'object') return null;
  const effect = preMusicEffect(layer.effect);
  const trackId = typeof layer.trackId === 'string' && layer.trackId.trim() ? layer.trackId.trim() : null;
  if (!effect && !trackId) return null;
  return {
    ...(effect ? { effect: effect.id } : { trackId }),
    atSec: finite(layer.atSec) ? round3(Math.max(0, layer.atSec)) : 0,
    // null plays the sound to its end (or the shot's end, whichever comes first).
    durationSec: finite(layer.durationSec) && layer.durationSec > 0 ? round3(layer.durationSec) : null,
    volume: finite(layer.volume) ? round3(clamp(layer.volume, PRE_MUSIC_VOLUME_RANGE)) : 1,
  };
}

/**
 * A shot's cold-open settings, or null when it plays on the song. `clipVolume`
 * null leaves the clip's own audio out; no clip sound and no layers is silence.
 */
export function normalizePreMusic(value) {
  if (!value || typeof value !== 'object') return null;
  const durationSec = finite(value.durationSec)
    ? round3(clamp(value.durationSec, PRE_MUSIC_DURATION_RANGE))
    : PRE_MUSIC_DEFAULT_DURATION_SEC;
  const layers = (Array.isArray(value.layers) ? value.layers : []).map(normalizeLayer).filter(Boolean).slice(0, PRE_MUSIC_LAYER_LIMIT);
  return {
    durationSec,
    clipVolume: finite(value.clipVolume) ? round3(clamp(value.clipVolume, PRE_MUSIC_VOLUME_RANGE)) : null,
    layers,
  };
}

export const isPreMusicShot = (scene) => !!scene?.preMusic && typeof scene.preMusic === 'object';

const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);

/** The cold-open shots in play order. */
export const coldOpenScenes = (project) => (Array.isArray(project?.scenes) ? project.scenes : []).filter(isPreMusicShot).sort(byOrder);

/** The shots that play on the song (everything not marked before it), in their stored order. */
export const songScenes = (project) => (Array.isArray(project?.scenes) ? project.scenes : []).filter((scene) => !isPreMusicShot(scene));

/** The project as the song's own pipeline sees it: the cold open left out. */
export const withSongScenesOnly = (project) => (coldOpenScenes(project).length ? { ...project, scenes: songScenes(project) } : project);

/**
 * The cold open laid out on its own clock: `{ scene, preMusic, startSec, endSec }`
 * per shot in play order. Empty when no shot is marked.
 */
export function coldOpenPlan(project) {
  let at = 0;
  return coldOpenScenes(project).map((scene) => {
    const preMusic = normalizePreMusic(scene.preMusic);
    const startSec = at;
    at = round3(at + preMusic.durationSec);
    return { scene, preMusic, startSec, endSec: at };
  });
}

/** The seconds the cold open adds before the song (0 when no shot is marked). */
export const coldOpenSeconds = (project) => {
  const plan = coldOpenPlan(project);
  return plan.length ? plan[plan.length - 1].endSec : 0;
};

/** What a shot's cold-open sound is, in words: "Silence", "Clip sound", "Clip sound + 2 layers". */
export function preMusicSoundSummary(preMusic) {
  const settings = normalizePreMusic(preMusic);
  if (!settings) return null;
  const parts = [];
  if (settings.clipVolume != null && settings.clipVolume > 0) parts.push('Clip sound');
  if (settings.layers.length) {
    const named = settings.layers.length === 1 && settings.layers[0].effect ? preMusicEffect(settings.layers[0].effect).label : null;
    parts.push(named || `${settings.layers.length} sound layer${settings.layers.length === 1 ? '' : 's'}`);
  }
  return parts.length ? parts.join(' + ') : 'Silence';
}
