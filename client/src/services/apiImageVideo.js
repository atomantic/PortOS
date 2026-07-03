import { request } from './apiCore.js';

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
export const cancelImageGen = (opts = {}) => request('/image-gen/cancel', {
  method: 'POST',
  body: JSON.stringify(opts),
});
export const deleteImage = (filename) => request(`/image-gen/${encodeURIComponent(filename)}`, { method: 'DELETE' });
export const setImageHidden = (filename, hidden) => request(`/image-gen/${encodeURIComponent(filename)}/visibility`, {
  method: 'POST',
  body: JSON.stringify({ hidden }),
});
export const cleanGalleryImage = (filename) => request(`/image-gen/${encodeURIComponent(filename)}/clean`, {
  method: 'POST',
  body: JSON.stringify({}),
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
export const getRegenAvailability = () => request('/image-gen/regen/availability', { silent: true });

// HuggingFace token (gated local Flux models). Stored in settings.imageGen.hfToken;
// reads fall back to HF_TOKEN env var and then ~/.cache/huggingface/token.
export const getHfTokenStatus = () => request('/image-gen/setup/hf-token-status', { silent: true });
export const saveHfToken = (token) => request('/image-gen/setup/hf-token', {
  method: 'POST',
  body: JSON.stringify({ token }),
});
export const clearHfToken = () => request('/image-gen/setup/hf-token', { method: 'DELETE' });

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
// Currently-running (or next-queued) video job — used on VideoGen mount to
// resume progress display after a page reload. Silent so a 5xx during status
// poll doesn't double-toast on every navigation.
export const getActiveVideoJob = () => request('/video-gen/active', { silent: true });
export const listVideoHistory = () => request('/video-gen/history');
export const deleteVideoHistoryItem = (id) => request(`/video-gen/history/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const setVideoHidden = (id, hidden) => request(`/video-gen/history/${encodeURIComponent(id)}/visibility`, {
  method: 'POST',
  body: JSON.stringify({ hidden }),
});
export const extractLastFrame = (id) => request(`/video-gen/last-frame/${encodeURIComponent(id)}`, { method: 'POST' });
export const upscaleVideo = (id) => request(`/video-gen/upscale/${encodeURIComponent(id)}`, { method: 'POST' });
export const stitchVideos = (videoIds) => request('/video-gen/stitch', {
  method: 'POST',
  body: JSON.stringify({ videoIds }),
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
export const createTimelineProject = (name) => request('/video-timeline/projects', {
  method: 'POST',
  body: JSON.stringify({ name }),
});
export const updateTimelineProject = (id, patch) => request(`/video-timeline/projects/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  body: JSON.stringify(patch),
});
export const deleteTimelineProject = (id) => request(`/video-timeline/projects/${encodeURIComponent(id)}`, {
  method: 'DELETE',
});
export const renderTimelineProject = (id) => request(`/video-timeline/projects/${encodeURIComponent(id)}/render`, {
  method: 'POST',
});
export const cancelTimelineRender = (jobId) => request(`/video-timeline/${encodeURIComponent(jobId)}/cancel`, {
  method: 'POST',
});

// Media collections — user-named buckets that can hold any mix of images
// and videos. An item key is "<kind>:<ref>" (e.g. "image:foo.png" or
// "video:<uuid>"); cover keys use the same format.
export const listMediaCollections = ({ silent = false } = {}) => request('/media/collections', { silent });
export const getMediaCollection = (id) => request(`/media/collections/${encodeURIComponent(id)}`);
export const createMediaCollection = ({ name, description = '' }) => request('/media/collections', {
  method: 'POST',
  body: JSON.stringify({ name, description }),
});
export const updateMediaCollection = (id, patch) => request(`/media/collections/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  body: JSON.stringify(patch),
});
export const deleteMediaCollection = (id) => request(`/media/collections/${encodeURIComponent(id)}`, {
  method: 'DELETE',
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
export const setMediaAnnotation = (key, patch) => request(`/media/annotations/${encodeURIComponent(key)}`, {
  method: 'PATCH',
  body: JSON.stringify(patch),
});

// Media sketches — freehand annotation strokes drawn over a generated image,
// keyed by "<kind>:<ref>" (only image:* is supported in phase 1 of #2036).
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

// Models management (HF cache + LoRAs)
export const listCachedModels = () => request('/image-video/models');
export const deleteCachedModel = (dirName) => request(`/image-video/models/hf/${encodeURIComponent(dirName)}`, { method: 'DELETE' });
export const deleteLora = (filename) => request(`/image-video/models/lora/${encodeURIComponent(filename)}`, { method: 'DELETE' });

// LoRA manager — Civitai-aware list/install/patch/delete. Reads sidecar
// metadata so the manager UI can show trigger words, base model, recommended
// scale, preview thumbnail. Used by /media/loras and the Image Gen LoRA picker.
export const listLorasFull = () => request('/loras');
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

// Civitai LoRA suggestions per runner family. Cached server-side for 1h.
// Pass `force: true` to bust the cache and re-fetch from Civitai.
export const getCivitaiSuggestions = ({ force = false } = {}) =>
  request(`/loras/suggestions${force ? '?force=1' : ''}`);

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
export const setCivitaiAuth = (apiKey) => request('/loras/auth/civitai', {
  method: 'POST',
  body: JSON.stringify({ apiKey }),
});
export const clearCivitaiAuth = () => request('/loras/auth/civitai', { method: 'DELETE' });
export const getLora = (filename) => request(`/loras/${encodeURIComponent(filename)}`);
export const patchLora = (filename, patch) => request(`/loras/${encodeURIComponent(filename)}`, {
  method: 'PATCH',
  body: JSON.stringify(patch),
});
export const deleteLoraFull = (filename) => request(`/loras/${encodeURIComponent(filename)}`, { method: 'DELETE' });
