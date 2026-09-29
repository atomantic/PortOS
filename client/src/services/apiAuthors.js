import { request } from './apiCore.js';

// ---- Author personas ----
// Reusable author/byline personas: name, writing style, bio, plus a physical
// description + headshot style used to generate a book-cover author headshot.
// `options` lets a caller suppress request()'s auto-toast with `{ silent: true }`.
export const listAuthors = (options = {}) => request('/authors', options);
export const createAuthor = (data, requestOptions = {}) => request('/authors', {
  method: 'POST',
  body: JSON.stringify(data),
  ...requestOptions,
});
export const updateAuthor = (id, patch, requestOptions = {}) => request(`/authors/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  body: JSON.stringify(patch),
  ...requestOptions,
});
export const deleteAuthor = (id, requestOptions = {}) => request(`/authors/${encodeURIComponent(id)}`, {
  method: 'DELETE',
  ...requestOptions,
});

// Caps come from the server leaf so client inputs and the server sanitizer can't drift.
export { NAME_MAX as AUTHOR_NAME_MAX, WRITING_STYLE_MAX as AUTHOR_WRITING_STYLE_MAX, BIO_MAX as AUTHOR_BIO_MAX, PHYSICAL_DESCRIPTION_MAX as AUTHOR_PHYSICAL_DESCRIPTION_MAX, HEADSHOT_STYLE_MAX as AUTHOR_HEADSHOT_STYLE_MAX, HEADSHOT_IMAGE_URL_MAX as AUTHOR_HEADSHOT_IMAGE_URL_MAX } from '../../../server/lib/authorLimits.js';
