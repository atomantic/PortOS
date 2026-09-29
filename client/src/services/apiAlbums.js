import { request } from './apiCore.js';

// ---- Music albums ----
// Albums group ordered tracks under an artist, with cover art. `artistId` is the
// FK; `artist` is the denormalized name (renders before the artist record syncs).
// `options` lets a caller suppress request()'s auto-toast with `{ silent: true }`.
export const listAlbums = (options = {}) => request('/albums', options);
export const createAlbum = (data, requestOptions = {}) => request('/albums', {
  method: 'POST',
  body: JSON.stringify(data),
  ...requestOptions,
});
export const updateAlbum = (id, patch, requestOptions = {}) => request(`/albums/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  body: JSON.stringify(patch),
  ...requestOptions,
});
export const deleteAlbum = (id, requestOptions = {}) => request(`/albums/${encodeURIComponent(id)}`, {
  method: 'DELETE',
  ...requestOptions,
});

// Caps come from the server leaf so client inputs and the server sanitizer can't drift.
export { TITLE_MAX as ALBUM_TITLE_MAX, DESCRIPTION_MAX as ALBUM_DESCRIPTION_MAX, GENRE_MAX as ALBUM_GENRE_MAX, RELEASE_YEAR_MAX as ALBUM_RELEASE_YEAR_MAX } from '../../../server/lib/albumLimits.js';
export const ALBUM_RELEASE_YEAR_MIN = 1850;
