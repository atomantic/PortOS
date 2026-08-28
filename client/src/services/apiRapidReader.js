import { request } from './apiCore.js';

export const ACCELERANDO_SOURCE_PAGE_URL = 'http://www.antipope.org/charlie/blog-static/fiction/accelerando/accelerando-intro.html';
export const ACCELERANDO_LICENSE_URL = 'https://creativecommons.org/licenses/by-nc-nd/2.5/';

export const getAccelerandoBook = (options) => request('/rapid-reader/accelerando', options);
export const listRapidReaderLibrary = (options) => request('/rapid-reader/library', options);
export const getRapidReaderLibraryEntry = (id, options) => request(`/rapid-reader/library/${encodeURIComponent(id)}`, options);
export const createRapidReaderLibraryEntry = (body, options) => request('/rapid-reader/library', { method: 'POST', body: JSON.stringify(body), ...options });
export const fetchRapidReaderLibraryEntry = (body, options) => request('/rapid-reader/library/fetch', { method: 'POST', body: JSON.stringify(body), ...options });
export const deleteRapidReaderLibraryEntry = (id, options) => request(`/rapid-reader/library/${encodeURIComponent(id)}`, { method: 'DELETE', ...options });
