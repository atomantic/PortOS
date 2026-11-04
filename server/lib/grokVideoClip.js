/**
 * Clip lengths grok's `image_to_video` tool actually delivers.
 *
 * **Measured, not assumed** (#3022). PortOS never passes grok a `duration`
 * parameter — both the general video path (`buildGrokVideoPrompt`) and the
 * sprite walk path (`buildWalkTuiTask`) ask the grok *agent* in prose ("animate
 * this for N seconds"), and the agent picks its own tool-call arguments. So the
 * only way to know which lengths are real is to render one and probe the result.
 *
 * Three headless renders of the same source image, requesting 2s / 3s / 6s, all
 * returned an identical 6.04s clip (145 native frames; 73 frames at the 12fps
 * extraction rate the walk packer uses) in 37-46s wall clock. grok's own agent
 * reported the constraint unprompted in two of the three runs:
 *
 *   > `image_to_video` only supports 6 or 10 second durations, so this was
 *   > rendered at 6 seconds (the minimum).
 *
 * There is therefore **no render time to save by requesting a shorter clip** —
 * a 2s request costs exactly what a 6s request costs and returns the same
 * footage. Offering 1/2/3 in a picker would be advertising a saving that does
 * not exist, which is why this list is exactly what grok delivers.
 *
 * Its own module rather than `lib/grok.js` on cohesion grounds: that file is
 * CLI-argv conventions (kept importable from the standalone autofixer), while
 * this is capability data about the video tool. Being dependency-free is what
 * lets `lib/validation.js` and `routes/videoGen.js` derive their Zod schemas
 * from the same list the services gate on — the `walkBounds.js` reasoning, that
 * hand-copied literals in a schema are how a schema and its service drift apart
 * (as `[1,2,3,6,10]` here and `[6,10]` in the schema already had).
 *
 * 2026-10-12: xAI's video API (grok-imagine-video-1.5 / 1.5-lite) now takes a
 * `duration` of 1–15 s (default 8), so 15 s joins the list as the new longest
 * clip. The CLI tool was last measured at 6/10 only; `generateVideo` probes
 * every delivered clip and warns when one comes back shorter than requested,
 * which is the check that confirms 15 s through the CLI (and would show
 * whether shorter clips are now honored too).
 *
 * If grok's tool ever gains shorter clips, change this list — the walk picker,
 * both Zod schemas, and the service gates all follow from it. Confirm with a
 * probe (every packaged walk run stamps `sourceVideoSeconds` for exactly this
 * reason) rather than from a tool description.
 */

/** Clip lengths (seconds) grok's image_to_video delivers, ascending. */
export const GROK_VIDEO_DURATIONS = Object.freeze([6, 10, 15]);

/** Fallback when a caller omits (or requests an undeliverable) clip length. */
export const GROK_VIDEO_DEFAULT_DURATION = 6;

/**
 * The requested length grok will actually honor, or the default.
 *
 * Only a number or a numeric string is considered — multipart bodies deliver
 * `"10"`, but `Number()` alone would also coerce `[10]` (and `true`, and `""`)
 * into a "supported" length, so the type is checked before the value.
 */
export const resolveGrokDuration = (requested) => {
  if (typeof requested !== 'number' && typeof requested !== 'string') return GROK_VIDEO_DEFAULT_DURATION;
  const n = Number(requested);
  return GROK_VIDEO_DURATIONS.includes(n) ? n : GROK_VIDEO_DEFAULT_DURATION;
};

/**
 * The shortest deliverable length that still COVERS `requested`, for callers
 * translating a target duration authored against another backend's contract
 * (#3135: the Creative Director planner and the commission's
 * `targetDurationSeconds` are written in local-lane seconds, which are
 * continuous).
 *
 * Distinct from `resolveGrokDuration`, which validates an ALREADY-grok-shaped
 * request and defaults anything else to 6s: that's correct at the route boundary
 * (the picker only offers the listed lengths, so any other value is bad input), but wrong when
 * translating — an 8-second brief would silently become 6s and truncate the
 * beat. Rounds UP because there is no cost or render-time saving at a shorter
 * clip (see the measurement note above), so covering the request is free; a
 * request beyond the longest clip clamps to that longest.
 */
export const nearestGrokDuration = (requested) => {
  if (typeof requested !== 'number' && typeof requested !== 'string') return GROK_VIDEO_DEFAULT_DURATION;
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return GROK_VIDEO_DEFAULT_DURATION;
  return GROK_VIDEO_DURATIONS.find((d) => d >= n) ?? GROK_VIDEO_DURATIONS[GROK_VIDEO_DURATIONS.length - 1];
};

/**
 * Billable units for one accepted Grok video.
 *
 * Text-to-video has no source image: the agent generates a base still
 * (`images: 1`) and then feeds that still to `image_to_video` (`inputImages: 1`).
 * Image-to-video already has a still, so it bills the delivered seconds plus
 * that one input image and does not bill a second generated image. A
 * reference_to_video render also sends its `referenceImages` (cast sheets).
 * Delivered length wins; otherwise the length grok was asked for.
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

/**
 * `resolution_name` values grok's CLI `image_to_video` tool accepts. The tool
 * defaults to 480p "unless the user specifically requests higher quality", so
 * a 1280×720 request that never names one arrives at 720×416 (#14491).
 */
export const GROK_VIDEO_RESOLUTIONS = Object.freeze(['480p', '720p']);

/**
 * The `resolution_name` that covers a requested frame: 720p once the short side
 * is above 480, else 480p. Null when no size was requested, which leaves the
 * tool's own default in place.
 */
export const grokVideoResolution = (width, height) => {
  const w = Number(width);
  const h = Number(height);
  if (!(w > 0) || !(h > 0)) return null;
  return Math.min(w, h) > 480 ? '720p' : '480p';
};
