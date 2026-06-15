import { request } from './apiCore.js';

// ---- Author personas ----
// Reusable author/byline personas: name, writing style, bio, plus a physical
// description + headshot style used to generate a book-cover author headshot.
// `options` lets a caller suppress request()'s auto-toast with `{ silent: true }`.
export const listAuthors = (options = {}) => request('/authors', options);
export const getAuthor = (id, options = {}) => request(`/authors/${encodeURIComponent(id)}`, options);
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

// Mirror server caps in server/services/authors/logic.js — bump both sides.
export const AUTHOR_NAME_MAX = 120;
export const AUTHOR_WRITING_STYLE_MAX = 4000;
export const AUTHOR_BIO_MAX = 4000;
export const AUTHOR_PHYSICAL_DESCRIPTION_MAX = 2000;
export const AUTHOR_HEADSHOT_STYLE_MAX = 2000;
export const AUTHOR_HEADSHOT_IMAGE_URL_MAX = 1000;
