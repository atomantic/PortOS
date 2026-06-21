import { request } from './apiCore.js';

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

// Upload an audio file (FormData with a `track` file field) into the library and
// attach it to this track. The caller builds the FormData; we pass it through as
// the request body so the multipart boundary header is set by the browser.
export const uploadTrackAudio = (id, formData, requestOptions = {}) => request(`/tracks/${encodeURIComponent(id)}/audio/upload`, {
  method: 'POST',
  body: formData,
  ...requestOptions,
});

// Mirror server caps in server/services/tracks/logic.js — bump both sides.
export const TRACK_TITLE_MAX = 200;
export const TRACK_LYRICS_MAX = 20000;
export const TRACK_PROMPT_MAX = 8000;
export const TRACK_DURATION_MIN_SEC = 1;
export const TRACK_DURATION_MAX_SEC = 3600;
