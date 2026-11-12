/**
 * Shared vocabulary of the Music Video "Blender film" render style
 * (`composition.mode === 'blender'`): the settings shape, the id and path
 * rules, and the frame arithmetic the server, the Python driver and the client
 * must agree on. Pure and browser-safe. See docs/features/music-video-blender.md.
 */

// PortOS engine ids. `BLENDER_EEVEE_NEXT` is EEVEE on every supported Blender
// (the driver maps it to Blender 5's `BLENDER_EEVEE`).
export const MUSIC_VIDEO_BLENDER_ENGINES = Object.freeze(['BLENDER_EEVEE_NEXT', 'CYCLES']);
export const MUSIC_VIDEO_BLENDER_QUALITIES = Object.freeze(['still', 'preview', 'final']);
export const MUSIC_VIDEO_BLENDER_NOTE_STATUSES = Object.freeze(['todo', 'wip', 'review', 'approved']);
export const MUSIC_VIDEO_BLENDER_MAX_SHOTS = 400;

// A shot id names a folder under renders/; a source path names a file under src/.
export const MUSIC_VIDEO_BLENDER_SHOT_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
export const MUSIC_VIDEO_BLENDER_SOURCE_PATH = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*){0,5}$/;
export const MUSIC_VIDEO_BLENDER_TEXT_EXTENSIONS = Object.freeze(['py', 'json', 'txt', 'md']);
export const MUSIC_VIDEO_BLENDER_SOURCE_EXTENSIONS = Object.freeze([
  ...MUSIC_VIDEO_BLENDER_TEXT_EXTENSIONS, 'png', 'jpg', 'jpeg', 'webp', 'exr', 'hdr', 'ttf', 'otf', 'wav', 'mp4', 'glb', 'obj', 'blend',
]);
export const MUSIC_VIDEO_BLENDER_TEXT_MAX_BYTES = 2 * 1024 * 1024;

// Film options: what a film's describe(ctx) may declare for the operator to set.
export const MUSIC_VIDEO_BLENDER_OPTION_KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
export const MUSIC_VIDEO_BLENDER_OPTION_TYPES = Object.freeze(['choice', 'boolean', 'number', 'text']);
export const MUSIC_VIDEO_BLENDER_MAX_OPTIONS = 24;
export const MUSIC_VIDEO_BLENDER_MAX_CHOICES = 32;
export const MUSIC_VIDEO_BLENDER_OPTION_TEXT_MAX = 2000;
export const MUSIC_VIDEO_BLENDER_MAX_HANDLE_SEC = 4;
// Why a render is out of date, in the order the UI names them.
export const MUSIC_VIDEO_BLENDER_STALE_REASONS = Object.freeze(['source', 'timing', 'handles', 'settings', 'options', 'song']);

export const MUSIC_VIDEO_BLENDER_SETTING_LIMITS = Object.freeze({
  width: { min: 320, max: 7680 },
  height: { min: 180, max: 4320 },
  fps: { min: 12, max: 60 },
  previewScale: { min: 0.25, max: 1 },
  previewSamples: { min: 1, max: 1024 },
  finalSamples: { min: 1, max: 4096 },
  concurrency: { min: 1, max: 4 },
});

export const MUSIC_VIDEO_BLENDER_DEFAULT_SETTINGS = Object.freeze({
  engine: 'BLENDER_EEVEE_NEXT',
  width: 1920,
  height: 1080,
  fps: 24,
  previewScale: 0.5,
  previewSamples: 16,
  finalSamples: 64,
  concurrency: 2,
  saveBlend: false,
});

const inRange = (value, { min, max }, integer) => Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value));

/**
 * The stored settings with every missing or out-of-range field replaced by its
 * default, so a hand-edited or older record can never reach Blender with a
 * size or rate the routes would have refused.
 */
function normalizeBlenderSettings(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const limits = MUSIC_VIDEO_BLENDER_SETTING_LIMITS;
  const defaults = MUSIC_VIDEO_BLENDER_DEFAULT_SETTINGS;
  const even = (key) => (inRange(raw[key], limits[key], true) && raw[key] % 2 === 0 ? raw[key] : defaults[key]);
  const whole = (key) => (inRange(raw[key], limits[key], true) ? raw[key] : defaults[key]);
  return {
    engine: MUSIC_VIDEO_BLENDER_ENGINES.includes(raw.engine) ? raw.engine : defaults.engine,
    width: even('width'),
    height: even('height'),
    fps: whole('fps'),
    previewScale: inRange(raw.previewScale, limits.previewScale) ? raw.previewScale : defaults.previewScale,
    previewSamples: whole('previewSamples'),
    finalSamples: whole('finalSamples'),
    concurrency: whole('concurrency'),
    saveBlend: raw.saveBlend === true,
    options: storedOptionValues(raw.options),
  };
}

const plainObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

const isOptionScalar = (value) => typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
  || (typeof value === 'string' && value.length <= MUSIC_VIDEO_BLENDER_OPTION_TEXT_MAX);

// The saved option values as stored: well-formed keys holding one scalar each.
// Whether a value suits its option is decided against the film's declaration.
function storedOptionValues(input) {
  return Object.fromEntries(Object.entries(plainObject(input))
    .filter(([key, value]) => MUSIC_VIDEO_BLENDER_OPTION_KEY.test(key) && isOptionScalar(value))
    .slice(0, MUSIC_VIDEO_BLENDER_MAX_OPTIONS));
}

/**
 * Why `value` cannot be the value of the declared `option`, as the end of a
 * sentence ("must be one of ..."), or null when it can.
 */
export function blenderOptionValueProblem(option, value) {
  if (option.type === 'boolean') return typeof value === 'boolean' ? null : 'must be true or false';
  if (option.type === 'choice') {
    const values = (option.choices || []).map((choice) => choice.value);
    return values.includes(value) ? null : `must be one of ${values.join(', ')}`;
  }
  if (option.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number';
    if (Number.isFinite(option.min) && value < option.min) return `must be at least ${option.min}`;
    if (Number.isFinite(option.max) && value > option.max) return `must be at most ${option.max}`;
    return null;
  }
  if (typeof value !== 'string') return 'must be text';
  return value.length <= MUSIC_VIDEO_BLENDER_OPTION_TEXT_MAX ? null : `must be at most ${MUSIC_VIDEO_BLENDER_OPTION_TEXT_MAX} characters`;
}

/** The saved values a film's `declared` options still accept; every other one is left out. */
export function blenderValidOptionValues(declared, saved) {
  const values = plainObject(saved);
  return Object.fromEntries((Array.isArray(declared) ? declared : [])
    .filter((option) => Object.hasOwn(values, option.key) && blenderOptionValueProblem(option, values[option.key]) === null)
    .map((option) => [option.key, values[option.key]]));
}

/**
 * What a film is built with: every declared option's default, overlaid with
 * the saved value where one is set and still valid. This is `ctx.options`.
 */
export function blenderEffectiveOptions(declared, saved) {
  const valid = blenderValidOptionValues(declared, saved);
  return Object.fromEntries((Array.isArray(declared) ? declared : [])
    .map((option) => [option.key, Object.hasOwn(valid, option.key) ? valid[option.key] : option.default]));
}

/**
 * A project's install-local `blender` field with every part present:
 * `{ settings, sceneMap, notes, syncedAt, manifestHash, final }`. `final` is
 * `{ jobId, signature }`: which final render was last joined from the shots,
 * and from which shot renders (so a shot rendered since shows it out of date).
 */
export function normalizeBlenderRecord(value) {
  const raw = plainObject(value);
  const final = plainObject(raw.final);
  return {
    settings: normalizeBlenderSettings(raw.settings),
    sceneMap: plainObject(raw.sceneMap),
    notes: plainObject(raw.notes),
    syncedAt: typeof raw.syncedAt === 'string' ? raw.syncedAt : null,
    manifestHash: typeof raw.manifestHash === 'string' ? raw.manifestHash : null,
    final: typeof final.jobId === 'string' && typeof final.signature === 'string' ? { jobId: final.jobId, signature: final.signature } : null,
  };
}

// Half-up, then down to an even pixel count: the driver applies the same rule.
const evenPixels = (value) => {
  const rounded = Math.floor(value + 0.5);
  return Math.max(2, rounded - (rounded % 2));
};

/**
 * What one quality renders at: preview frames are scaled and use the preview
 * samples; finals and stills are full size with the final samples.
 */
export function blenderRenderFrame(settings, quality) {
  const scale = quality === 'preview' ? settings.previewScale : 1;
  return {
    scale,
    width: evenPixels(settings.width * scale),
    height: evenPixels(settings.height * scale),
    samples: quality === 'preview' ? settings.previewSamples : settings.finalSamples,
  };
}

/** A shot's absolute song frames `[startFrame, endFrame)` on `fps`. */
export function blenderShotFrameRange(shot, fps) {
  const startFrame = Math.round(shot.start * fps);
  const endFrame = Math.round(shot.end * fps);
  return { startFrame, endFrame, frameCount: Math.max(0, endFrame - startFrame) };
}

/** Normalized `{ in, out }` handle seconds declared on a shot (defaulting missing sides to 0). */
export function normalizeBlenderHandles(handles) {
  return {
    in: Math.max(0, Number(handles?.in) || 0),
    out: Math.max(0, Number(handles?.out) || 0),
  };
}

/**
 * A shot's handle frame ranges on `fps`:
 * - `in`: `[startFrame - inFrames, startFrame)` before the shot starts
 * - `out`: `[endFrame, endFrame + outFrames)` after the shot ends
 */
export function blenderShotHandleRanges(shot, fps) {
  const { startFrame, endFrame } = blenderShotFrameRange(shot, fps);
  const handles = normalizeBlenderHandles(shot?.handles);
  const inFrames = Math.round(handles.in * fps);
  const outFrames = Math.round(handles.out * fps);
  return {
    in: { startFrame: startFrame - inFrames, endFrame: startFrame, frameCount: inFrames },
    out: { startFrame: endFrame, endFrame: endFrame + outFrames, frameCount: outFrames },
  };
}

/** `'text'` (editable through the API), `'binary'` (listed only), or null for a path src/ may not hold. */
export function blenderSourceFileKind(path) {
  if (typeof path !== 'string' || !MUSIC_VIDEO_BLENDER_SOURCE_PATH.test(path)) return null;
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (!path.includes('.') || !MUSIC_VIDEO_BLENDER_SOURCE_EXTENSIONS.includes(extension)) return null;
  return MUSIC_VIDEO_BLENDER_TEXT_EXTENSIONS.includes(extension) ? 'text' : 'binary';
}

/**
 * Whether every shot in `progress` (`{ total, finalReady }`, computed at read
 * time by the server) has a complete, current final render: the Shots step.
 */
export const blenderShotsReady = (progress) => Boolean(progress && progress.total > 0 && progress.finalReady === progress.total);

/**
 * How far a film's final shots are: `{ total, finalReady, ready }`, from its
 * manifest shots and their renders (`{ [shotId]: { final? } }`). The server
 * attaches it to project reads as `blenderShots`; the open project's page
 * recomputes it from the film state as renders land.
 */
export function summarizeBlenderShots(shots, renders) {
  const list = Array.isArray(shots) ? shots : [];
  const progress = {
    total: list.length,
    finalReady: list.filter((shot) => renders?.[shot.id]?.final?.complete && !renders[shot.id].final.stale).length,
  };
  return { ...progress, ready: blenderShotsReady(progress) };
}

/**
 * Whether a render request takes a shot whose render at that quality is
 * `render` (undefined when it was never rendered). A render that is complete
 * and current is left alone unless `force`; `onlyStale` takes only a render
 * that exists and is out of date, so a shot never rendered is left out.
 */
export function blenderRenderWanted(render, { force = false, onlyStale = false } = {}) {
  if (onlyStale) return render?.stale === true;
  return force || !(render?.complete && !render.stale);
}
