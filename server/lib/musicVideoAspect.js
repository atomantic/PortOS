/**
 * Music Video frame aspect (shared by the server and the client board).
 *
 * A project's aspect is its treatment brief's `aspectRatio`, defaulting to
 * 16:9. Every generated reference frame is requested at that aspect: an image
 * backend left to choose on its own picks per prompt (a close-up of hands
 * came back portrait), and the render then pillarboxes that shot.
 */
export const MUSIC_VIDEO_ASPECTS = Object.freeze(['16:9', '9:16', '1:1']);

/** The project's aspect ratio (brief), defaulting to 16:9. */
export function musicVideoAspect(project) {
  const aspect = project?.treatment?.brief?.aspectRatio;
  return MUSIC_VIDEO_ASPECTS.includes(aspect) ? aspect : '16:9';
}

// Reference-frame sizes for image backends: long edge 1536, both sides
// multiples of 32, so local diffusion models and cloud hints accept them.
export const MUSIC_VIDEO_FRAME_GEN_SIZES = Object.freeze({
  '16:9': Object.freeze({ width: 1536, height: 864 }),
  '9:16': Object.freeze({ width: 864, height: 1536 }),
  '1:1': Object.freeze({ width: 1024, height: 1024 }),
});

/**
 * The project framed at another aspect for ONE render (a 9:16 social cut of a
 * 16:9 video), leaving the stored record untouched. Every renderer reads the
 * aspect through `musicVideoAspect`, so re-framing the brief is enough.
 */
export function musicVideoAtAspect(project, aspect) {
  if (!MUSIC_VIDEO_ASPECTS.includes(aspect) || aspect === musicVideoAspect(project)) return project;
  const treatment = project?.treatment || {};
  return { ...project, treatment: { ...treatment, brief: { ...(treatment.brief || {}), aspectRatio: aspect } } };
}

/** `{ width, height }` to request a project's reference frames at. */
export const musicVideoFrameGenSize = (project) => ({ ...MUSIC_VIDEO_FRAME_GEN_SIZES[musicVideoAspect(project)] });
