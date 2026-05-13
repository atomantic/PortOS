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
  const loraNames = (pickLoraFilenames(i) || []).filter(Boolean);
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
  const loraNames = (pickLoraFilenames(v) || []).filter(Boolean);
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

// Resolve `loraFilenames` from a raw sidecar with four fallbacks:
//   1. raw.loraFilenames    — new gen records, already basenames
//   2. raw.lora_filenames   — same shape, snake_case writer
//   3. raw.loraPaths        — legacy records pre-refactor, absolute paths
//   4. raw.lora_paths       — same legacy shape, snake_case
// Legacy paths are reduced to basenames so the requeued payload matches the
// new `loraFilenames` contract on the server.
function pickLoraFilenames(raw) {
  if (Array.isArray(raw.loraFilenames)) return raw.loraFilenames;
  if (Array.isArray(raw.lora_filenames)) return raw.lora_filenames;
  const paths = Array.isArray(raw.loraPaths) ? raw.loraPaths
    : Array.isArray(raw.lora_paths) ? raw.lora_paths
    : null;
  if (!paths) return undefined;
  return paths
    .map((p) => (typeof p === 'string' ? p.split(/[\\/]/).pop() : ''))
    .filter(Boolean);
}

// Sidecar field knowledge co-located with the normalize functions. Sidecars
// were written with both snake_case (Python writer) and camelCase (Node
// writer) over the project's history; the fallback chains keep older renders
// queueable from <PromptRefineModal> without forcing a one-shot migration.
//
// Returns the subset of fields the queue-render API accepts for the given
// kind. The `mode` here is the *original* render mode (defaulted when
// missing); callers may override it (e.g. PromptRefineModal forces
// `mode: 'text'` for video requeues so a missing source-image doesn't drop
// the render).
export function getRenderConfigForItem(item) {
  if (!item) return {};
  const raw = item.raw || {};
  if (item.kind === 'image') {
    return {
      mode: item.mode || 'local',
      modelId: item.modelId,
      width: item.width,
      height: item.height,
      steps: item.steps,
      guidance: item.guidance,
      cfgScale: raw.cfgScale ?? raw.cfg_scale,
      seed: item.seed,
      quantize: item.quantize,
      loraFilenames: pickLoraFilenames(raw),
      loraScales: raw.loraScales ?? raw.lora_scales,
    };
  }
  if (item.kind === 'video') {
    return {
      mode: item.mode || 'text',
      modelId: item.modelId,
      width: item.width,
      height: item.height,
      numFrames: item.numFrames,
      fps: item.fps,
      steps: raw.steps,
      // Nullish coalescing — a deliberate `0` guidanceScale is valid for some
      // video models and must survive the round-trip back into the queued payload.
      guidanceScale: raw.guidanceScale ?? raw.guidance_scale ?? raw.guidance,
      seed: raw.seed,
      tiling: raw.tiling,
      disableAudio: raw.disableAudio ?? raw.disable_audio,
      loraFilenames: pickLoraFilenames(raw),
      loraScales: raw.loraScales ?? raw.lora_scales,
    };
  }
  return {};
}
