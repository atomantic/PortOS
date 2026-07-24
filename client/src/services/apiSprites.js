import { request } from './apiCore.js';

// Sprite Manager: record list/detail + production-asset import (#2895), and
// the phase-2 reference workflow — create characters, queue main/anchor
// candidate renders, lock reviewed candidates (#2896). `options` lets a
// caller suppress request()'s auto-toast with `{ silent: true }` when it owns
// its own error UI.

export const listSpriteRecords = (options = {}) => request('/sprites', options);
export const getSpriteRecord = (id, options = {}) => request(`/sprites/${encodeURIComponent(id)}`, options);

// Characters with a locked main reference — the pool to seed a new main from
// (i2i) or fork. Returns [{ id, name, kind, path }] (path = record-relative
// main reference image).
export const listSpriteReferenceSources = (options = {}) => request('/sprites/reference-sources', options);

// Representative Library-catalog thumbnails for EVERY record — `[{ id, path }]`
// (record-relative image). Characters use their locked main reference; other
// kinds (places, objects, imported prop atlases) use their first previewable
// asset. Records with no usable image are omitted.
export const listSpriteThumbnails = (options = {}) => request('/sprites/thumbnails', options);

// The generation prompt behind one on-disk asset (record-relative `path`) —
// reference candidate, locked main/anchor, or walk render. Returns
// `{ prompt, designPrompt, source }` or `null` when the asset has no prompt
// provenance. Callers own their (best-effort) UI, so pass `{ silent: true }`.
export const getSpriteAssetPrompt = (id, path, options = {}) => request(
  `/sprites/${encodeURIComponent(id)}/asset-prompt?path=${encodeURIComponent(path)}`,
  options,
);

export const createSpriteRecord = (body, options = {}) => request('/sprites', {
  method: 'POST', body: JSON.stringify(body), ...options,
});

export const updateSpriteRecord = (id, patch, options = {}) => request(`/sprites/${encodeURIComponent(id)}`, {
  method: 'PATCH', body: JSON.stringify(patch), ...options,
});

// Delete (tombstone) a whole sprite record — drops it from the library while
// its on-disk assets and its id stay reserved (a re-create must use a new id).
// Callers own their confirmation UI, so pass `{ silent: true }` to suppress the
// auto-toast. Returns the delete result.
export const deleteSpriteRecord = (id, options = {}) => request(`/sprites/${encodeURIComponent(id)}`, {
  method: 'DELETE', ...options,
});

// Delete one on-disk asset by its record-relative path — an old runtime atlas
// version (PNG + manifest removed together) or a superseded reference /
// candidate render. Refuses the live atlas (409 ATLAS_IN_USE) and the record's
// state index files (409 PROTECTED_STATE_FILE). Returns { deleted, removed }.
export const deleteSpriteAsset = (id, path, options = {}) => request(
  `/sprites/${encodeURIComponent(id)}/assets?path=${encodeURIComponent(path)}`,
  { method: 'DELETE', ...options },
);

// Import approved production assets from a source pipeline checkout.
// Returns { results: [...perSubject], totals }.
export const importSprites = (body, options = {}) => request('/sprites/import', {
  method: 'POST', body: JSON.stringify(body), ...options,
});

// Queue one reference candidate render. `referenceImageFile` (main target
// only) switches the POST to multipart so the design reference uploads with
// the fields. Returns { jobId, mode, target, anchorId }.
export const generateSpriteReference = (id, { referenceImageFile, ...fields }, options = {}) => {
  let body;
  if (referenceImageFile) {
    body = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null && value !== '') body.append(key, value);
    }
    body.append('referenceImage', referenceImageFile);
  } else {
    body = JSON.stringify(fields);
  }
  return request(`/sprites/${encodeURIComponent(id)}/reference/generate`, { method: 'POST', body, ...options });
};

// Freeze a reviewed candidate as the main reference or a directional anchor.
// Returns the updated { manifest, candidates } reference set.
export const lockSpriteReference = (id, body, options = {}) => request(`/sprites/${encodeURIComponent(id)}/reference/lock`, {
  method: 'POST', body: JSON.stringify(body), ...options,
});

// Fork `id` into a new character seeded (image+text→image) from its locked main
// reference. Body: { name, id?, designPrompt, mode?, model?, effort?,
// initImageStrength? }. Returns { record, jobId, mode, target, anchorId }.
export const forkSpriteRecord = (id, body, options = {}) => request(`/sprites/${encodeURIComponent(id)}/fork`, {
  method: 'POST', body: JSON.stringify(body), ...options,
});

// Phase 3 (#2897): walk-animation workflow — one grok i2v clip per locked
// directional anchor, deterministic server-side packaging, per-direction
// approval into the finalized walk set.

// Queue one walk video render. Returns { jobId, runId, direction, duration }.
export const generateSpriteWalk = (id, body, options = {}) => request(`/sprites/${encodeURIComponent(id)}/walk/generate`, {
  method: 'POST', body: JSON.stringify(body), ...options,
});

// Approve a packaged candidate run for its direction. Returns the updated
// { runs, selection, walkSet } walk state.
export const approveSpriteWalk = (id, body, options = {}) => request(`/sprites/${encodeURIComponent(id)}/walk/approve`, {
  method: 'POST', body: JSON.stringify(body), ...options,
});

// Re-run the deterministic postprocess on a run whose video already landed.
export const postprocessSpriteWalk = (id, body, options = {}) => request(`/sprites/${encodeURIComponent(id)}/walk/postprocess`, {
  method: 'POST', body: JSON.stringify(body), ...options,
});

// Pin the walk set's cycle target (#2985). Body: { frameCount, fps }. Returns
// the refreshed walk state, whose `walkTarget` carries the resolved value, its
// provenance, and the packaged directions that now drift from it.
export const setSpriteWalkTarget = (id, body, options = {}) => request(`/sprites/${encodeURIComponent(id)}/walk/target`, {
  method: 'PUT', body: JSON.stringify(body), ...options,
});

// Un-freeze a finalized walk set so its directions can be regenerated/re-approved.
export const unlockSpriteWalk = (id, options = {}) => request(`/sprites/${encodeURIComponent(id)}/walk/unlock`, {
  method: 'POST', ...options,
});

// Re-open ONE approved direction (finer-grained than unlock) so it can be
// regenerated/reprocessed/re-approved. Body: { direction }.
export const reopenSpriteWalk = (id, body, options = {}) => request(`/sprites/${encodeURIComponent(id)}/walk/reopen`, {
  method: 'POST', body: JSON.stringify(body), ...options,
});

// Every frame one run's source video produced (#2980): `{ available, reason,
// frames, cycle, selectedSourceIndices, current, target, editable, lockReason }`.
// `available: false` carries a reason ('no-source-video' | 'run-not-packaged')
// rather than an empty list, so "nothing to show" never reads like "no frames".
// Re-extracts server-side on demand when the clip is on disk but `raw/` was
// cleaned, so a slow first call is expected for such a run.
export const getSpriteWalkSourceFrames = (id, runId, options = {}) => request(
  `/sprites/${encodeURIComponent(id)}/walk/runs/${encodeURIComponent(runId)}/source-frames`,
  options,
);

// Save a non-destructive loop trim (strip + GIF + manifest, versioned).
export const trimSpriteWalk = (id, body, options = {}) => request(`/sprites/${encodeURIComponent(id)}/walk/trim`, {
  method: 'POST', body: JSON.stringify(body), ...options,
});

// Phase 4 (#2898): runtime atlas compile + publish into a managed app.

// Compile (idempotently) the immutable runtime atlas from the finalized walk
// set. Returns the current pointer ({ version, atlasPath, atlasSha256, ... }
// plus created).
export const compileSpriteAtlas = (id, body = {}, options = {}) => request(`/sprites/${encodeURIComponent(id)}/atlas/compile`, {
  method: 'POST', body: JSON.stringify(body), ...options,
});

// Set (binding object) or clear (null) the record's publish binding.
export const setSpritePublishBinding = (id, binding, options = {}) => request(`/sprites/${encodeURIComponent(id)}/publish-binding`, {
  method: 'PUT', body: JSON.stringify({ binding }), ...options,
});

// Publish the compiled atlas into the bound managed app's repo. Pass
// { acknowledgeOverwrite: true } after a 409 PUBLISH_DEST_OCCUPIED to
// consent to replacing a destination atlas PortOS never published.
export const publishSpriteAtlas = (id, body = {}, options = {}) => request(`/sprites/${encodeURIComponent(id)}/atlas/publish`, {
  method: 'POST', body: JSON.stringify(body), ...options,
});
