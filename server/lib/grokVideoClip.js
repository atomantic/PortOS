/**
 * Clip lengths grok's `image_to_video` tool actually delivers.
 *
 * **Measured, not assumed** (#3022): PortOS never passes grok a `duration` (the grok *agent* picks
 * its own tool arguments from prose), and renders requesting 2s / 3s / 6s all returned a 6.04s
 * clip, so shorter requests save no render time and a 1/2/3 picker would advertise a saving that
 * does not exist. xAI's video API (grok-imagine-video-1.5) takes 1–15 s, so 15 s joins the list;
 * `generateVideo` warns when a delivered clip is shorter than requested. Confirm any change with a
 * probe (`sourceVideoSeconds` stamps), not a tool description.
 *
 * Dependency-free so `lib/sharedSchemas.js` and `routes/videoGen.js` derive their Zod schemas from
 * the list the services gate on.
 */

/** Clip lengths (seconds) grok's image_to_video delivers, ascending. */
export const GROK_VIDEO_DURATIONS = Object.freeze([6, 10, 15]);

/** Fallback when a caller omits (or requests an undeliverable) clip length. */
export const GROK_VIDEO_DEFAULT_DURATION = 6;

/** The requested length grok honors, or the default; type-checked first since `Number()` coerces `[10]`, `true` and `""`. */
export const resolveGrokDuration = (requested) => {
  if (typeof requested !== 'number' && typeof requested !== 'string') return GROK_VIDEO_DEFAULT_DURATION;
  const n = Number(requested);
  return GROK_VIDEO_DURATIONS.includes(n) ? n : GROK_VIDEO_DEFAULT_DURATION;
};

/**
 * The shortest deliverable length that COVERS `requested` (a target authored in another backend's
 * continuous seconds, #3135). Unlike `resolveGrokDuration` it rounds UP rather than defaulting to
 * 6s, and clamps to the longest clip.
 */
export const nearestGrokDuration = (requested) => {
  if (typeof requested !== 'number' && typeof requested !== 'string') return GROK_VIDEO_DEFAULT_DURATION;
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return GROK_VIDEO_DEFAULT_DURATION;
  return GROK_VIDEO_DURATIONS.find((d) => d >= n) ?? GROK_VIDEO_DURATIONS[GROK_VIDEO_DURATIONS.length - 1];
};

/**
 * Billable units for one accepted Grok video. Text-to-video generates a base still then feeds it to
 * `image_to_video`; image-to-video already has one, so no generated image is billed. Delivered
 * length wins over the requested one.
 * @param {{ requestedSeconds?: number|string, deliveredSeconds?: number|null, hasSourceImage?: boolean, referenceImages?: number }} [opts]
 * @returns {{ videoSeconds: number, images: number, inputImages: number }}
 */
export function grokVideoBillableUnits({ requestedSeconds, deliveredSeconds, hasSourceImage = false, referenceImages = 0 } = {}) {
  const delivered = typeof deliveredSeconds === 'number' && Number.isFinite(deliveredSeconds) && deliveredSeconds > 0
    ? deliveredSeconds
    : null;
  return {
    videoSeconds: delivered ?? resolveGrokDuration(requestedSeconds),
    images: hasSourceImage ? 0 : 1,
    inputImages: 1 + (Number.isInteger(referenceImages) && referenceImages > 0 ? referenceImages : 0),
  };
}

/** The `resolution_name` covering a frame (720p above 480 short side); null leaves the tool default. */
export const grokVideoResolution = (width, height) => {
  const w = Number(width);
  const h = Number(height);
  if (!(w > 0) || !(h > 0)) return null;
  return Math.min(w, h) > 480 ? '720p' : '480p';
};
