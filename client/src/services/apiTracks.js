import { request } from './apiCore.js';

// Static-asset URL for a track's audio bytes in the shared music library
// (data/music/). Not an API call — a plain href for <audio>/download links.
export const trackAudioUrl = (filename) => `/data/music/${encodeURIComponent(filename)}`;

// ---- Music tracks ----
// A track is a single song/recording — standalone or part of an album. It stores
// a pointer (`audioFilename`) into the shared music library; the bytes are
// uploaded/generated there. `options` lets a caller suppress request()'s
// auto-toast with `{ silent: true }`.
export const listTracks = (options = {}) => request('/tracks', options);
export const getTrack = (id, options = {}) => request(`/tracks/${encodeURIComponent(id)}`, options);
export const createTrack = (data, requestOptions = {}) => request('/tracks', {
  method: 'POST',
  body: JSON.stringify(data),
  ...requestOptions,
});
export const updateTrack = (id, patch, requestOptions = {}) => request(`/tracks/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  body: JSON.stringify(patch),
  ...requestOptions,
});
export const deleteTrack = (id, requestOptions = {}) => request(`/tracks/${encodeURIComponent(id)}`, {
  method: 'DELETE',
  ...requestOptions,
});

// Shared music library (uploaded + generated tracks under data/music/). Used to
// attach an existing track without re-uploading.
export const listMusicLibrary = (options = {}) => request('/tracks/library', options);

// --- YouTube import (#1945) — download + extract a track's audio via yt-dlp,
// land it in the shared library, and create a Track. Kickoff returns { jobId };
// progress streams over SSE (subscribe with useSseProgress).
export const importTrackFromYoutube = (url, options = {}) => request('/tracks/import/youtube', {
  method: 'POST',
  body: JSON.stringify({ url }),
  ...options,
});

export const trackImportEventsUrl = (jobId) =>
  `/api/tracks/import/${encodeURIComponent(jobId)}/events`;

export const cancelTrackImport = (jobId, options = {}) => request(`/tracks/import/${encodeURIComponent(jobId)}/cancel`, {
  method: 'POST',
  ...options,
});

// Attach an existing library track (by stored filename) to this track.
export const attachTrackAudio = (id, filename, requestOptions = {}) => request(`/tracks/${encodeURIComponent(id)}/audio/attach`, {
  method: 'POST',
  body: JSON.stringify({ filename }),
  ...requestOptions,
});

// Clear the audio pointer (leaves the library file in place — it may be shared).
export const clearTrackAudio = (id, requestOptions = {}) => request(`/tracks/${encodeURIComponent(id)}/audio`, {
  method: 'DELETE',
  ...requestOptions,
});

// --- Render history ----
// A track keeps every generated/uploaded take in `track.renders[]`. The active
// take is mirrored onto the top-level `audioFilename`/`engine`/`modelId`/
// `durationSec`. Both endpoints return `{ track }` (the updated record).

// Make a past render the active one (re-points the player + gen-metadata badges).
export const selectTrackRender = (id, renderId, requestOptions = {}) => request(
  `/tracks/${encodeURIComponent(id)}/renders/${encodeURIComponent(renderId)}/select`,
  { method: 'POST', ...requestOptions },
);

// Remove a render from the history (the audio bytes stay in the shared library).
export const deleteTrackRender = (id, renderId, requestOptions = {}) => request(
  `/tracks/${encodeURIComponent(id)}/renders/${encodeURIComponent(renderId)}`,
  { method: 'DELETE', ...requestOptions },
);

// Upload an audio file (FormData with a `track` file field) into the library and
// attach it to this track. The caller builds the FormData; we pass it through as
// the request body so the multipart boundary header is set by the browser.
export const uploadTrackAudio = (id, formData, requestOptions = {}) => request(`/tracks/${encodeURIComponent(id)}/audio/upload`, {
  method: 'POST',
  body: formData,
  ...requestOptions,
});

// --- Chiptune scores (#2911) — prompt-based looping 8-bit background music.

// Generate (or iterate on) the track's chiptune score with an AI provider.
// `body`: { prompt, providerId?, model?, fresh? }.
export const generateTrackChiptune = (id, body, requestOptions = {}) => request(`/tracks/${encodeURIComponent(id)}/chiptune/generate`, {
  method: 'POST',
  body: JSON.stringify(body),
  ...requestOptions,
});

// Render the current score into the shared music library as a looping take.
export const renderTrackChiptune = (id, requestOptions = {}) => request(`/tracks/${encodeURIComponent(id)}/chiptune/render`, {
  method: 'POST',
  ...requestOptions,
});

// Publish the current score into a managed app's repo (OGG + score JSON).
// `body`: { appId, subdir?, slug? }.
export const publishTrackChiptune = (id, body, requestOptions = {}) => request(`/tracks/${encodeURIComponent(id)}/chiptune/publish`, {
  method: 'POST',
  body: JSON.stringify(body),
  ...requestOptions,
});

// Mirror server caps in server/services/tracks/logic.js — bump both sides.
export const TRACK_TITLE_MAX = 200;
export const TRACK_LYRICS_MAX = 20000;
export const TRACK_PROMPT_MAX = 8000;
export const TRACK_DURATION_MIN_SEC = 1;
export const TRACK_DURATION_MAX_SEC = 3600;
