/**
 * Video tiling modes — the one list the video-gen routes validate against and
 * the client renders its options from (client/src/lib/videoTilingOptions.js).
 *
 * A leaf module (no imports) so the browser bundle can import it directly.
 */
export const VIDEO_TILING_MODES = Object.freeze(['auto', 'none', 'spatial', 'temporal']);
