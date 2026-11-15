/**
 * Music Video per-video sanity bounds (#16196): the most subjects, visual references and catalog description bases one video may hold, far above real use so a director adding catalog items by hand is never blocked; the per-shot reference limit is enforced by each renderer, not here.
 */

export const MUSIC_VIDEO_MAX_SUBJECTS = 500;
export const MUSIC_VIDEO_MAX_VISUAL_REFERENCES = 500;
