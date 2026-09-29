import { request } from './apiCore.js';

// ---- Music artists ----
// Reusable musical personas (the Music studio's analogue of Authors): name,
// genre, bio, musical style, plus a physical description + portrait style used
// to generate an artist portrait. `options` lets a caller suppress request()'s
// auto-toast with `{ silent: true }`.
export const listArtists = (options = {}) => request('/artists', options);
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

// Caps come from the server leaf so client inputs and the server sanitizer can't drift.
export { NAME_MAX as ARTIST_NAME_MAX, GENRE_MAX as ARTIST_GENRE_MAX, BIO_MAX as ARTIST_BIO_MAX, MUSICAL_STYLE_MAX as ARTIST_MUSICAL_STYLE_MAX, PHYSICAL_DESCRIPTION_MAX as ARTIST_PHYSICAL_DESCRIPTION_MAX, PORTRAIT_STYLE_MAX as ARTIST_PORTRAIT_STYLE_MAX, PORTRAIT_IMAGE_URL_MAX as ARTIST_PORTRAIT_IMAGE_URL_MAX } from '../../../server/lib/artistLimits.js';
