/**
 * The resolution floor below which a delivered video clip is low-res.
 *
 * A music video renders at 1080p, so a clip whose short side is under 720 px
 * is visibly soft once it is scaled up. Grok's CLI `image_to_video` defaults
 * to 480p (a 16:9 request arrives at 720×416), which is how #14491 found this.
 * The history card, its lightbox and the shot card share this one rule.
 */

/** Short side (px) a clip needs to count as 720p or better. */
export const LOW_RES_VIDEO_SHORT_SIDE = 720;

/**
 * True when a measured clip falls below 720p. An unmeasured axis is unknown, not
 * low-res, so a record with no recorded size is never flagged.
 * @param {{ width?: number|null, height?: number|null }} [size]
 */
export const isLowResVideo = ({ width, height } = {}) => {
  const w = Number(width);
  const h = Number(height);
  if (!(w > 0) || !(h > 0)) return false;
  return Math.min(w, h) < LOW_RES_VIDEO_SHORT_SIDE;
};
