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
 * If grok's tool ever gains shorter clips, change this list — the walk picker,
 * both Zod schemas, and the service gates all follow from it. Confirm with a
 * probe (every packaged walk run stamps `sourceVideoSeconds` for exactly this
 * reason) rather than from a tool description.
 */

/** Clip lengths (seconds) grok's image_to_video delivers, ascending. */
export const GROK_VIDEO_DURATIONS = Object.freeze([6, 10]);

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
