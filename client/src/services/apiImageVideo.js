import { request } from './apiCore.js';

// Image gen — local backend extras (gallery, models, LoRAs, cancel, delete).
// generateImage / getImageGenStatus / generateAvatar live in apiSystem.js for
// backward compatibility with existing call sites.
export const listImageModels = () => request('/image-gen/models');
export const listLoras = () => request('/image-gen/loras');
export const listImageGallery = () => request('/image-gen/gallery');
export const getActiveImageJob = () => request('/image-gen/active');
export const cancelImageGen = () => request('/image-gen/cancel', { method: 'POST' });
export const deleteImage = (filename) => request(`/image-gen/${encodeURIComponent(filename)}`, { method: 'DELETE' });
export const setImageHidden = (filename, hidden) => request(`/image-gen/${encodeURIComponent(filename)}/visibility`, {
  method: 'POST',
  body: JSON.stringify({ hidden }),
});

// Video gen
export const getVideoGenStatus = () => request('/video-gen/status');
export const listVideoModels = () => request('/video-gen/models');
export const cancelVideoGen = () => request('/video-gen/cancel', { method: 'POST' });
export const listVideoHistory = () => request('/video-gen/history');
export const deleteVideoHistoryItem = (id) => request(`/video-gen/history/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const setVideoHidden = (id, hidden) => request(`/video-gen/history/${encodeURIComponent(id)}/visibility`, {
  method: 'POST',
  body: JSON.stringify({ hidden }),
});
export const extractLastFrame = (id) => request(`/video-gen/last-frame/${encodeURIComponent(id)}`, { method: 'POST' });
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

// Models management (HF cache + LoRAs)
export const listCachedModels = () => request('/image-video/models');
export const deleteCachedModel = (dirName) => request(`/image-video/models/hf/${encodeURIComponent(dirName)}`, { method: 'DELETE' });
export const deleteLora = (filename) => request(`/image-video/models/lora/${encodeURIComponent(filename)}`, { method: 'DELETE' });
