import { request } from './apiCore.js';

// ---- Music artists ----
// Reusable musical personas (the Music studio's analogue of Authors): name,
// genre, bio, musical style, plus a physical description + portrait style used
// to generate an artist portrait. `options` lets a caller suppress request()'s
// auto-toast with `{ silent: true }`.
export const listArtists = (options = {}) => request('/artists', options);
export const getArtist = (id, options = {}) => request(`/artists/${encodeURIComponent(id)}`, options);
export const createArtist = (data, requestOptions = {}) => request('/artists', {
  method: 'POST',
  body: JSON.stringify(data),
  ...requestOptions,
});
export const updateArtist = (id, patch, requestOptions = {}) => request(`/artists/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  body: JSON.stringify(patch),
  ...requestOptions,
});
export const deleteArtist = (id, requestOptions = {}) => request(`/artists/${encodeURIComponent(id)}`, {
  method: 'DELETE',
  ...requestOptions,
});

// Mirror server caps in server/services/artists/logic.js — bump both sides.
export const ARTIST_NAME_MAX = 120;
export const ARTIST_GENRE_MAX = 120;
export const ARTIST_BIO_MAX = 4000;
export const ARTIST_MUSICAL_STYLE_MAX = 4000;
export const ARTIST_PHYSICAL_DESCRIPTION_MAX = 2000;
export const ARTIST_PORTRAIT_STYLE_MAX = 2000;
export const ARTIST_PORTRAIT_IMAGE_URL_MAX = 1000;
