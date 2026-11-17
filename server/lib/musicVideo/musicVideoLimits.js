/**
 * Music Video per-video sanity bounds (#16196): most subjects and visual references one video may hold.
 *
 * Far above real use so a director adding catalog items by hand is never blocked; the per-shot reference limit is enforced by each renderer, not here.
 */

export const MUSIC_VIDEO_MAX_SUBJECTS = 500;
export const MUSIC_VIDEO_MAX_VISUAL_REFERENCES = 500;
