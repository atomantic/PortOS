import { request } from './apiCore.js';

// ---- Music albums ----
// Albums group ordered tracks under an artist, with cover art. `artistId` is the
// FK; `artist` is the denormalized name (renders before the artist record syncs).
// `options` lets a caller suppress request()'s auto-toast with `{ silent: true }`.
export const listAlbums = (options = {}) => request('/albums', options);
export const getAlbum = (id, options = {}) => request(`/albums/${encodeURIComponent(id)}`, options);
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

// Mirror server caps in server/services/albums/logic.js — bump both sides.
export const ALBUM_TITLE_MAX = 200;
export const ALBUM_DESCRIPTION_MAX = 4000;
export const ALBUM_GENRE_MAX = 120;
export const ALBUM_COVER_IMAGE_URL_MAX = 1000;
export const ALBUM_RELEASE_YEAR_MIN = 1850;
export const ALBUM_RELEASE_YEAR_MAX = 2200;
