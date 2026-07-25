// Client mirror of `server/lib/grokVideoClip.js` — the clip lengths grok's
// `image_to_video` tool actually delivers (measured, #3022; see that file for
// the evidence). Enforced by the "client mirror" suite in
// `server/lib/grokVideoClip.test.js`: if this drifts from the server list, that
// test fails. Update the SERVER file first, then this one.

/** Clip lengths (seconds) grok's image_to_video delivers, ascending. */
export const GROK_VIDEO_DURATIONS = [6, 10];

/** Fallback when no clip length is chosen. */
export const GROK_VIDEO_DEFAULT_DURATION = 6;
