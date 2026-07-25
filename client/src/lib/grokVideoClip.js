// Client mirror of `server/lib/grokVideoClip.js` — the clip lengths grok's
// `image_to_video` tool actually delivers. Enforced by the "client mirror"
// suite in `server/lib/grokVideoClip.test.js`: if this drifts from the server
// list, that test fails. Update the SERVER file first, then this one.
//
// The values are measured, not documented (#3022): three renders requesting
// 2s / 3s / 6s all returned the same 6.04s clip, and grok's own agent reported
// that image_to_video "only supports 6 or 10 second durations". So a shorter
// request buys no render time — the picker offers exactly what grok delivers
// rather than advertising a saving that doesn't exist.

/** Clip lengths (seconds) grok's image_to_video delivers, ascending. */
export const GROK_VIDEO_DURATIONS = [6, 10];

/** Fallback when no clip length is chosen. */
export const GROK_VIDEO_DEFAULT_DURATION = 6;
