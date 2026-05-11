// Friendly display name for a LoRA basename. The on-disk filenames look like
// `lora-realstagram-v7.safetensors` — strip the `lora-` prefix, the version
// suffix (`-v123`), and the extension, then re-spaceify dashes. Idempotent
// for legacy filenames that don't follow the convention.
export function loraDisplayName(filename) {
  if (typeof filename !== 'string' || !filename) return '';
  return filename
    .replace(/^lora-/, '')
    .replace(/\.safetensors$/i, '')
    .replace(/-v\d+$/, '')
    .replace(/[-_]+/g, ' ')
    .trim();
}

// Normalizes raw image-gallery / video-history records into a single shape
// consumed by <MediaCard>. Lets the same card render in any history grid.
export function normalizeImage(i) {
  // Sidecar field shapes: new gen records use loraFilenames (basenames);
  // legacy records pre-refactor used loraPaths (absolute paths). Reduce both
  // to a list of basenames so the card can render the same chip regardless.
  const fromFilenames = Array.isArray(i.loraFilenames) ? i.loraFilenames : [];
  const fromPaths = Array.isArray(i.loraPaths)
    ? i.loraPaths.map((p) => (typeof p === 'string' ? p.split(/[\\/]/).pop() : ''))
    : [];
  const loraNames = (fromFilenames.length ? fromFilenames : fromPaths).filter(Boolean);
  // modelId display falls back through several sidecar shapes:
  //   1. modelId — local-runner sidecars (mflux/flux2/z-image/ernie)
  //   2. model   — codex sidecars (older path), and future Gemini etc.
  //   3. mode    — pre-model-field codex sidecars saved before the default
  //                was added; surface the provider tag so the card still
  //                shows where the image came from.
  const modelId = i.modelId || i.model || (i.mode && i.mode !== 'local' ? i.mode : null);
  return {
    kind: 'image',
    key: `image:${i.filename}`,
    filename: i.filename,
    previewUrl: i.path || `/data/images/${i.filename}`,
    downloadUrl: i.path || `/data/images/${i.filename}`,
    prompt: i.prompt || i.metadata?.prompt || '(no prompt)',
    negativePrompt: i.negativePrompt || i.negative_prompt || null,
    modelId,
    width: i.width,
    height: i.height,
    steps: i.steps,
    guidance: i.guidance,
    quantize: i.quantize,
    seed: i.seed,
    // Codex (gpt-image-2) doesn't expose a seed — `codexSessionId` is the
    // run-identifier from the codex CLI banner, surfaced in the lightbox so
    // each codex image has a unique trace even though it isn't reproducible.
    codexSessionId: i.codexSessionId,
    mode: i.mode,
    loraNames,
    createdAt: i.createdAt,
    hidden: !!i.hidden,
    extractedFromVideoId: i.extractedFromVideoId || null,
    extractedFromVideoFilename: i.extractedFromVideoFilename || null,
    raw: i,
  };
}

export function normalizeVideo(v) {
  const fromFilenames = Array.isArray(v.loraFilenames) ? v.loraFilenames : [];
  const fromPaths = Array.isArray(v.loraPaths)
    ? v.loraPaths.map((p) => (typeof p === 'string' ? p.split(/[\\/]/).pop() : ''))
    : [];
  const loraNames = (fromFilenames.length ? fromFilenames : fromPaths).filter(Boolean);
  return {
    kind: 'video',
    key: `video:${v.id}`,
    id: v.id,
    filename: v.filename,
    previewUrl: v.thumbnail ? `/data/video-thumbnails/${v.thumbnail}` : null,
    downloadUrl: `/data/videos/${v.filename}`,
    prompt: v.prompt || '(no prompt)',
    negativePrompt: v.negativePrompt || v.negative_prompt || null,
    modelId: v.modelId,
    width: v.width,
    height: v.height,
    numFrames: v.numFrames,
    fps: v.fps,
    mode: v.mode,
    stitchedFrom: v.stitchedFrom,
    upscaledFrom: v.upscaledFrom,
    loraNames,
    createdAt: v.createdAt,
    hidden: !!v.hidden,
    raw: v,
  };
}
