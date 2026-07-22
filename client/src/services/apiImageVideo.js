import { request, API_BASE, maybeRedirectToLogin } from './apiCore.js';

// Image gen — local backend extras (gallery, models, LoRAs, cancel, delete).
// generateImage / getImageGenStatus / generateAvatar live in apiSystem.js for
// backward compatibility with existing call sites.
export const listImageModels = () => request('/image-gen/models');
// Per-model download status: `[{ id, repo, cached, sizeBytes }]`. Drives the
// inline Available/Download badge on the image gen form.
export const getImageModelStatuses = () => request('/image-gen/models/status', { silent: true });
// Force an integrity re-scan of downloaded models. `deep:true` adds the
// per-file sha256 comparison (slower) on top of the cheap structural check the
// status poll already runs. Silent — callers own their own error UI.
export const verifyImageModels = ({ modelId, deep = false } = {}) => request('/image-gen/models/verify', {
  method: 'POST',
  body: JSON.stringify({ ...(modelId ? { modelId } : {}), deep }),
  silent: true,
});
// Delete the corrupt/truncated weight files for a model so the existing
// download path re-fetches clean copies. Returns `{ deleted, repos }`.
export const repairImageModel = (modelId, { deep = false } = {}) => request(`/image-gen/models/${encodeURIComponent(modelId)}/repair`, {
  method: 'POST',
  body: JSON.stringify({ deep }),
  silent: true,
});
export const listLoras = () => request('/image-gen/loras');
export const listImageGallery = () => request('/image-gen/gallery');
export const getActiveImageJob = () => request('/image-gen/active');
// cancelImageGen({ all: true }) cancels every queued/running image job.
// cancelImageGen({ jobId }) cancels a specific job. Plain cancelImageGen()
// cancels the most-recent queued/running job (legacy behavior).
export const cancelImageGen = (opts = {}, options = {}) => request('/image-gen/cancel', {
  method: 'POST',
  body: JSON.stringify(opts),
  ...options,
});
export const deleteImage = (filename, options = {}) => request(`/image-gen/${encodeURIComponent(filename)}`, { method: 'DELETE', ...options });
export const setImageHidden = (filename, hidden, options = {}) => request(`/image-gen/${encodeURIComponent(filename)}/visibility`, {
  method: 'POST',
  body: JSON.stringify({ hidden }),
  ...options,
});
export const cleanGalleryImage = (filename, options = {}) => request(`/image-gen/${encodeURIComponent(filename)}/clean`, {
  method: 'POST',
  body: JSON.stringify({}),
  ...options,
});
// Visible-watermark removal — erases the Gemini / Nano-Banana bottom-right ✦
// via a CPU-only localized inpaint. Synchronous (like Clean): returns the new
// `_nowatermark.png` variant directly. `opts` may carry `{ size }` or an
// explicit `{ region: { x, y, w, h } }` for off-spec placements; omit for the
// auto-sized corner box. `silent` so the lightbox owns its own error toast.
export const removeImageWatermark = (filename, opts = {}) =>
  request(`/image-gen/${encodeURIComponent(filename)}/remove-watermark`, {
    method: 'POST',
    body: JSON.stringify({
      ...(opts.size != null ? { size: opts.size } : {}),
      ...(opts.region != null ? { region: opts.region } : {}),
    }),
    silent: true,
  });
// SynthID-defeat regen (issue #912). Enqueues a local-FLUX img2img round-trip
// of a gallery image; returns the queue ack ({ jobId, position, ... }) — the
// finished render lands in the gallery via the normal queue-completion refresh.
// `silent` so the lightbox owns its own error toast (single-layer rule).
// `method: 'light'` runs the CPU-only spatial pass (synchronous — returns the
// new variant directly, not a queue ack), for installs without a FLUX runner.
export const regenerateGalleryImage = (filename, { strength, steps, prompt, method } = {}) =>
  request(`/image-gen/${encodeURIComponent(filename)}/regenerate`, {
    method: 'POST',
    body: JSON.stringify({
      ...(strength != null ? { strength } : {}),
      ...(steps != null ? { steps } : {}),
      ...(prompt != null ? { prompt } : {}),
      ...(method != null ? { method } : {}),
    }),
    silent: true,
  });
// Whether the local FLUX regen backend is installed (hardware gate). Also carries
// the strength slider bounds: `{ available, modelId, reason, strengthMin, strengthMax, strengthDefault }`.
// Pass a source `filename` (issue #2036) to get the EXACT model a regen of that
// image would run — the backend picks by the source's own model on multi-model
// installs, so the annotate dialog can disclose the real model before rendering.
export const getRegenAvailability = (filename) =>
  request(`/image-gen/regen/availability${filename ? `?filename=${encodeURIComponent(filename)}` : ''}`, { silent: true });
// Annotation re-render (issue #2036 phase 2). Feeds the saved flattened sketch
// (source image + drawn strokes) back through the local-FLUX img2img regen as the
// init image; returns the queue ack ({ jobId, position, ... }). The annotation
// must already be saved (the flattened PNG sidecar is the init image). `silent`
// so the annotate page owns its own error toast (single-layer rule).
export const rerenderWithAnnotations = (filename, { strength, steps, prompt } = {}) =>
  request(`/image-gen/${encodeURIComponent(filename)}/regenerate`, {
    method: 'POST',
    body: JSON.stringify({
      annotated: true,
      ...(strength != null ? { strength } : {}),
      ...(steps != null ? { steps } : {}),
      ...(prompt != null ? { prompt } : {}),
    }),
    silent: true,
  });

// HuggingFace token (gated local Flux models). Stored in settings.imageGen.hfToken;
// reads fall back to HF_TOKEN env var and then ~/.cache/huggingface/token.
// Silent — callers own their own error UI. `signal` lets a page cancel a stale
// probe on unmount / model switch.
export const getHfTokenStatus = ({ signal } = {}) => request('/image-gen/setup/hf-token-status', { silent: true, signal });
export const saveHfToken = (token) => request('/image-gen/setup/hf-token', {
  method: 'POST',
  body: JSON.stringify({ token }),
});
export const clearHfToken = () => request('/image-gen/setup/hf-token', { method: 'DELETE' });

// FLUX.2 setup probe (weights/deps present for the selected model?). Silent so a
// stale poll doesn't toast; `signal` cancels it on model switch / unmount.
export const getFlux2Status = ({ modelId, signal } = {}) =>
  request(`/image-gen/setup/flux2-status${modelId ? `?modelId=${encodeURIComponent(modelId)}` : ''}`, { silent: true, signal });

// External/local image generation with an init or reference image attached —
// multipart because the payload carries File uploads. request() detects the
// FormData body and lets the browser set the multipart boundary itself.
export const generateImageMultipart = (formData, options = {}) => request('/image-gen/generate', {
  method: 'POST',
  body: formData,
  ...options,
});

// Local Python-runtime setup probes (LocalSetupPanel). These use fetch() rather
// than request() because the caller distinguishes intentional AbortError (a
// superseded/unmounted probe) from a real failure — request()'s catch collapses
// abort into a generic error. Return the parsed body on 2xx, null on a non-OK
// response; abort/network rejections propagate so the caller can inspect them.
export async function checkImageGenSetup({ pythonPath, signal } = {}) {
  const res = await fetch(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent(pythonPath)}`, { signal });
  return res.ok ? res.json() : null;
}

export async function detectImageGenPython() {
  const res = await fetch('/api/image-gen/setup/python');
  return res.ok ? res.json() : null;
}

export async function createImageGenVenv() {
  const res = await fetch('/api/image-gen/setup/create-venv', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (res.ok) return res.json();
  const json = await res.json().catch(() => ({}));
  throw new Error(json.error || 'Venv creation failed');
}

// Video gen
export const getVideoGenStatus = () => request('/video-gen/status');
export const listVideoModels = (options) => request('/video-gen/models', options);
// `{ models: [...], textEncoder: { repo, cached, sizeBytes } }`. Same shape
// contract as the image variant + a text-encoder block since the active
// encoder is a separate multi-GB pull.
export const getVideoModelStatuses = () => request('/video-gen/models/status', { silent: true });
// Integrity re-scan / repair — mirrors the image-gen helpers above.
export const verifyVideoModels = ({ modelId, deep = false } = {}) => request('/video-gen/models/verify', {
  method: 'POST',
  body: JSON.stringify({ ...(modelId ? { modelId } : {}), deep }),
  silent: true,
});
export const repairVideoModel = (modelId, { deep = false } = {}) => request(`/video-gen/models/${encodeURIComponent(modelId)}/repair`, {
  method: 'POST',
  body: JSON.stringify({ deep }),
  silent: true,
});
// Repair the shared text encoder — delete its corrupt files so the existing
// /text-encoder/download SSE re-fetches clean copies. The encoder isn't a model
// id, so it needs this scalar endpoint rather than repairVideoModel.
export const repairTextEncoder = ({ deep = false } = {}) => request('/video-gen/text-encoder/repair', {
  method: 'POST',
  body: JSON.stringify({ deep }),
  silent: true,
});
export const cancelVideoGen = () => request('/video-gen/cancel', { method: 'POST' });
// Per-runtime BYOV setup probe (venv/deps present?) run BEFORE the user hits
// Generate so a missing-runtime install banner can surface instead of a
// buildArgs-time 500. Silent — VideoGen owns its own error handling and passes
// an AbortController `signal` so a stale probe can be cancelled on model switch.
export const getVideoGenRuntimeStatus = (runtime, { signal } = {}) =>
  request(`/video-gen/setup/runtime-status?runtime=${encodeURIComponent(runtime)}`, { silent: true, signal });
// Currently-running (or next-queued) video job — used on VideoGen mount to
// resume progress display after a page reload. Silent so a 5xx during status
// poll doesn't double-toast on every navigation.
export const getActiveVideoJob = () => request('/video-gen/active', { silent: true });
export const listVideoHistory = (options = {}) => request('/video-gen/history', options);
export const deleteVideoHistoryItem = (id, options = {}) => request(`/video-gen/history/${encodeURIComponent(id)}`, { method: 'DELETE', ...options });
export const setVideoHidden = (id, hidden, options = {}) => request(`/video-gen/history/${encodeURIComponent(id)}/visibility`, {
  method: 'POST',
  body: JSON.stringify({ hidden }),
  ...options,
});
export const extractLastFrame = (id, options = {}) => request(`/video-gen/last-frame/${encodeURIComponent(id)}`, { method: 'POST', ...options });
export const upscaleVideo = (id, options = {}) => request(`/video-gen/upscale/${encodeURIComponent(id)}`, { method: 'POST', ...options });
export const stitchVideos = (videoIds, options = {}) => request('/video-gen/stitch', {
  method: 'POST',
  body: JSON.stringify({ videoIds }),
  ...options,
});

// Build a FormData payload, skipping null/undefined/empty fields. Arrays are
// appended one element per key (Express's multer parses repeated keys into
// req.body[key] = [...]). Blobs (File objects, etc.) pass through unchanged.
export function buildFormData(fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v == null || v === '') continue;
    if (v instanceof Blob) fd.append(k, v);
    else if (Array.isArray(v)) v.forEach((item) => fd.append(k, String(item)));
    else fd.append(k, String(v));
  }
  return fd;
}

// generateVideo always sends multipart/form-data via FormData. Bypass the
// JSON-only request() helper because the server route expects multipart for
// the optional sourceImage upload (and uniform multipart parsing for both
// upload and no-upload paths is simpler than branching on Content-Type).
export async function generateVideo(fields) {
  const res = await fetch('/api/video-gen', { method: 'POST', body: buildFormData(fields) });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.code = body.code;
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Video timeline projects (non-linear editor)
export const listTimelineProjects = () => request('/video-timeline/projects');
export const getTimelineProject = (id) => request(`/video-timeline/projects/${encodeURIComponent(id)}`);
export const createTimelineProject = (name, options = {}) => request('/video-timeline/projects', {
  method: 'POST',
  body: JSON.stringify({ name }),
  ...options,
});
export const updateTimelineProject = (id, patch, options = {}) => request(`/video-timeline/projects/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  body: JSON.stringify(patch),
  ...options,
});
export const deleteTimelineProject = (id, options = {}) => request(`/video-timeline/projects/${encodeURIComponent(id)}`, {
  method: 'DELETE',
  ...options,
});
export const renderTimelineProject = (id, options = {}) => request(`/video-timeline/projects/${encodeURIComponent(id)}/render`, {
  method: 'POST',
  ...options,
});
export const cancelTimelineRender = (jobId) => request(`/video-timeline/${encodeURIComponent(jobId)}/cancel`, {
  method: 'POST',
});

// Media collections — user-named buckets that can hold any mix of images
// and videos. An item key is "<kind>:<ref>" (e.g. "image:foo.png" or
// "video:<uuid>"); cover keys use the same format.
export const listMediaCollections = ({ silent = false } = {}) => request('/media/collections', { silent });
export const getMediaCollection = (id, options = {}) => request(`/media/collections/${encodeURIComponent(id)}`, options);
export const createMediaCollection = ({ name, description = '' }, options = {}) => request('/media/collections', {
  method: 'POST',
  body: JSON.stringify({ name, description }),
  ...options,
});
export const updateMediaCollection = (id, patch, options = {}) => request(`/media/collections/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  body: JSON.stringify(patch),
  ...options,
});
export const deleteMediaCollection = (id, options = {}) => request(`/media/collections/${encodeURIComponent(id)}`, {
  method: 'DELETE',
  ...options,
});
export const addMediaCollectionItem = (id, { kind, ref }, { silent = false } = {}) => request(`/media/collections/${encodeURIComponent(id)}/items`, {
  method: 'POST',
  body: JSON.stringify({ kind, ref }),
  silent,
});
export const removeMediaCollectionItem = (id, key, { silent = false } = {}) => request(`/media/collections/${encodeURIComponent(id)}/items/${encodeURIComponent(key)}`, {
  method: 'DELETE',
  silent,
});

// Media annotations — per-item star + free-text note, keyed by "<kind>:<ref>"
// (same shape as collections + the client-side `item.key` from normalize.js).
// Decoupled from generation pipeline data so favorites survive job pruning.
// GET returns `{ annotations: { [key]: { starred, note, updatedAt } } }`.
// PATCH partial-merges; the entry is removed entirely when both fields end
// up empty — `entry` in the response is `null` to signal that.
export const listMediaAnnotations = () => request('/media/annotations');
export const setMediaAnnotation = (key, patch, options = {}) => request(`/media/annotations/${encodeURIComponent(key)}`, {
  method: 'PATCH',
  body: JSON.stringify(patch),
  ...options,
});

// Media sketches — freehand strokes over a generated image ("image:<ref>",
// phases 1–2 of #2036) OR a free-standing blank canvas ("sketch:<uuid>",
// phase 3, attachable to a pipeline storyboard scene).
// GET returns `{ key, sketch: { width, height, strokes, updatedAt, hasPng } | null }`.
// PUT persists strokes + an optional flattened PNG data URL. The persisted PNG
// is retrievable at GET /media/sketches/:key/png (consumed by phase 2's
// img2img feedback; the UI's own Export button flattens client-side).
export const getMediaSketch = (key, { silent = false } = {}) =>
  request(`/media/sketches/${encodeURIComponent(key)}`, { silent });
export const saveMediaSketch = (key, payload, { silent = false } = {}) =>
  request(`/media/sketches/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
    silent,
  });
// Mint a fresh blank-canvas sketch key ("sketch:<uuid>"). Server-generated
// because PortOS is served over plain HTTP (crypto.randomUUID is unavailable on
// an insecure origin). Returns `{ key }`.
export const createBlankSketch = ({ silent = false } = {}) =>
  request('/media/sketches', { method: 'POST', silent });

// Models management (HF cache + LoRAs)
export const listCachedModels = (options = {}) => request('/image-video/models', options);
export const deleteCachedModel = (dirName, options = {}) => request(`/image-video/models/hf/${encodeURIComponent(dirName)}`, { method: 'DELETE', ...options });
export const deleteLora = (filename, options = {}) => request(`/image-video/models/lora/${encodeURIComponent(filename)}`, { method: 'DELETE', ...options });

// Media-model REGISTRY (the catalog of pickable image/video base models,
// distinct from listCachedModels which reports on-disk HF cache usage). Returns
// `{ video: [...], image: [...] }` with a `builtIn` flag per entry so the
// manager renders built-ins read-only and user-added entries editable.
export const listMediaModelRegistry = () => request('/image-video/models/registry');

// Search the HuggingFace Hub for candidate base-model repos. `pipeline` scopes
// to e.g. 'text-to-image'/'text-to-video'. `silent` (default true) because the
// caller owns its own error UI. Returns `{ items: [{ id, likes, downloads, pipeline_tag }] }`.
export const searchHfMediaModels = ({ query = '', pipeline, limit, silent = true } = {}) => {
  const params = new URLSearchParams();
  if (query) params.set('query', query);
  if (pipeline) params.set('pipeline', pipeline);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  return request(`/image-video/models/search${qs ? `?${qs}` : ''}`, { silent });
};

// Add a custom base model from a HuggingFace repo. The server strictly refuses
// GGUF-only / wan / hunyuan / unclassifiable repos, so a rejection carries a
// typed `.code` (HF_UNSUPPORTED_FORMAT, HF_UNKNOWN_KIND, HF_UNKNOWN_RUNNER, …)
// the page can surface inline. `kind`/`runtime`/`runner` are optional overrides
// for a mis-detected repo; `name`/`steps`/`guidance` override derived defaults.
// `silent` lets the page route the typed errors into its own inline UI.
export const addMediaModelFromHf = ({ url, kind, runtime, runner, name, steps, guidance, silent = false } = {}) => {
  const body = { url };
  if (kind) body.kind = kind;
  if (runtime) body.runtime = runtime;
  if (runner) body.runner = runner;
  if (name) body.name = name;
  if (steps != null) body.steps = steps;
  if (guidance != null) body.guidance = guidance;
  return request('/image-video/models/install/huggingface', {
    method: 'POST',
    body: JSON.stringify(body),
    silent,
  });
};

// Edit a user-added model's name/steps/guidance. Built-ins return 403.
// `silent` lets a caller with its own error toast suppress the apiCore toast.
export const patchCustomMediaModel = (id, patch, { silent = false } = {}) => request(`/image-video/models/custom/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  body: JSON.stringify(patch),
  silent,
});

// Remove a user-added model entry (weights stay in the HF cache). Built-ins
// return 403; unknown ids 404. `silent` as above.
export const removeCustomMediaModel = (id, { silent = false } = {}) => request(`/image-video/models/custom/${encodeURIComponent(id)}`, {
  method: 'DELETE',
  silent,
});

// LoRA manager — Civitai-aware list/install/patch/delete. Reads sidecar
// metadata so the manager UI can show trigger words, base model, recommended
// scale, preview thumbnail. Used by /media/loras and the Image Gen LoRA picker.
export const listLorasFull = (options = {}) => request('/loras', options);
// `silent: true` suppresses the auto-toast in apiCore so the page can route
// CIVITAI_AUTH errors into the in-UI key prompt instead of a fire-and-forget
// red toast the user can't act on.
export const installLoraFromCivitai = ({ url, silent = false } = {}) => request('/loras/install', {
  method: 'POST',
  body: JSON.stringify({ url }),
  silent,
});

// Install a video LoRA from a HuggingFace repo (fal / Lightricks LTX LoRAs).
// `family` is an optional override (e.g. 'ltx-video') when autodetection from
// the repo id/tags can't classify it. `silent` lets the page route HF_AUTH /
// HF_UNKNOWN_FAMILY errors into its own inline UI.
export const installLoraFromHuggingface = ({ url, family, silent = false } = {}) => request('/loras/install/huggingface', {
  method: 'POST',
  body: JSON.stringify(family ? { url, family } : { url }),
  silent,
});

// Streaming HF LoRA install — same install as installLoraFromHuggingface but
// reads a byte-level progress stream. Resolves with the new sidecar on the
// `complete` frame; rejects with an Error carrying `.code` (e.g.
// 'HF_UNKNOWN_FAMILY', 'HF_ALREADY_INSTALLED') on an `error` frame, so the page
// can drive the same inline family-confirm retry it does for the POST path.
// `onProgress({ received, total, progress })` fires per throttled download tick
// — `progress` is 0..1, or null when the server had no Content-Length to divide.
//
// Uses fetch() + a stream reader rather than EventSource, mirroring
// streamLocalLlmTest: (1) a POST (not an EventSource GET) — this install mutates
// state, and a state-changing GET would be CSRF-reachable via a top-level
// cross-origin navigation; (2) EventSource auto-reconnects on any transport
// drop, which for this NON-idempotent install would silently start a second
// multi-GB download — a single fetch never retries; (3) it honors session expiry
// — a 401 AUTH_REQUIRED bounces to /login via maybeRedirectToLogin exactly like
// request(), instead of dead-ending on a generic stream error. Frames are
// SSE-encoded (`data: {json}\n\n`).
export async function installLoraFromHuggingfaceStream({ url, family, onProgress, signal } = {}) {
  const response = await fetch(`${API_BASE}/loras/install/huggingface/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(family ? { url, family } : { url }),
    signal,
  });
  if (!response.ok || !response.body?.getReader) {
    const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    maybeRedirectToLogin(response, err);
    const e = new Error(err.error || `HTTP ${response.status}`);
    e.code = err.code || null;
    throw e;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sidecar;
  let streamError = null;

  const consume = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return; // skip SSE blank separators / comments
    let frame;
    try { frame = JSON.parse(trimmed.slice(5).trim()); } catch { return; }
    if (frame.type === 'progress') onProgress?.(frame);
    else if (frame.type === 'complete') sidecar = frame.sidecar;
    else if (frame.type === 'error') {
      streamError = new Error(frame.message || 'HuggingFace install failed');
      streamError.code = frame.code || null;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) consume(line);
    }
    if (buffer.trim()) consume(buffer);
  } finally {
    await reader.cancel().catch(() => {});
  }

  // An `error` frame is the server's terminal failure signal — surface it (with
  // its code) over a truncation error.
  if (streamError) throw streamError;
  // Clean EOF that never delivered a `complete` frame (server killed mid-stream,
  // proxy cut the body) — throw so the caller's spinner clears; an intentional
  // cancel sets signal.aborted and the caller suppresses that.
  if (!sidecar && !signal?.aborted) throw new Error('Download stream ended before completing');
  return sidecar;
}

// Civitai LoRA suggestions per runner family. Cached server-side for 1h.
// Pass `force: true` to bust the cache and re-fetch from Civitai.
export const getCivitaiSuggestions = ({ force = false } = {}, options = {}) =>
  request(`/loras/suggestions${force ? '?force=1' : ''}`, options);

// Live keyword search + cursor pagination within one runner family. Backs the
// per-category search box and "Load more" button on /media/loras. `query`
// blank pages the plain top-ranking; pass the previous response's `nextCursor`
// to load the next page. Returns `{ runnerFamily, query, items, nextCursor }`.
// `silent` defaults true because the caller (SuggestionsSection.fetchPage) owns
// its own error toast — leaving it false would double-toast on a failed search.
export const searchCivitaiLoras = ({ runner, query = '', cursor = null, limit, silent = true } = {}) => {
  const params = new URLSearchParams();
  params.set('runner', runner);
  if (query) params.set('query', query);
  if (cursor) params.set('cursor', cursor);
  if (limit) params.set('limit', String(limit));
  return request(`/loras/search?${params.toString()}`, { silent });
};

// Civitai auth — read/save/clear the API key. The key never round-trips back
// to the client; the GET only returns `{ hasKey, source }`.
export const getCivitaiAuth = () => request('/loras/auth/civitai');
export const setCivitaiAuth = (apiKey, options = {}) => request('/loras/auth/civitai', {
  method: 'POST',
  body: JSON.stringify({ apiKey }),
  ...options,
});
export const clearCivitaiAuth = (options = {}) => request('/loras/auth/civitai', { method: 'DELETE', ...options });
export const getLora = (filename) => request(`/loras/${encodeURIComponent(filename)}`);
export const patchLora = (filename, patch) => request(`/loras/${encodeURIComponent(filename)}`, {
  method: 'PATCH',
  body: JSON.stringify(patch),
});
export const deleteLoraFull = (filename, options = {}) => request(`/loras/${encodeURIComponent(filename)}`, { method: 'DELETE', ...options });
