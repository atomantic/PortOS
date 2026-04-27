// Normalizes raw image-gallery / video-history records into a single shape
// consumed by <MediaCard>. Lets the same card render in any history grid.
export function normalizeImage(i) {
  return {
    kind: 'image',
    key: `image:${i.filename}`,
    filename: i.filename,
    previewUrl: i.path || `/data/images/${i.filename}`,
    downloadUrl: i.path || `/data/images/${i.filename}`,
    prompt: i.prompt || i.metadata?.prompt || '(no prompt)',
    negativePrompt: i.negativePrompt || i.negative_prompt || null,
    modelId: i.modelId || i.model || null,
    width: i.width,
    height: i.height,
    steps: i.steps,
    guidance: i.guidance,
    quantize: i.quantize,
    seed: i.seed,
    createdAt: i.createdAt,
    raw: i,
  };
}

export function normalizeVideo(v) {
  return {
    kind: 'video',
    key: `video:${v.id}`,
    id: v.id,
    filename: v.filename,
    previewUrl: v.thumbnail ? `/data/video-thumbnails/${v.thumbnail}` : null,
    downloadUrl: `/data/videos/${v.filename}`,
    prompt: v.prompt || '(no prompt)',
    modelId: v.modelId,
    width: v.width,
    height: v.height,
    numFrames: v.numFrames,
    fps: v.fps,
    stitchedFrom: v.stitchedFrom,
    createdAt: v.createdAt,
    raw: v,
  };
}
