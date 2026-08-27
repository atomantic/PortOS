import { request } from './apiCore.js';

export const ACCELERANDO_SOURCE_PAGE_URL = 'http://www.antipope.org/charlie/blog-static/fiction/accelerando/accelerando-intro.html';
export const ACCELERANDO_LICENSE_URL = 'https://creativecommons.org/licenses/by-nc-nd/2.5/';

export const getAccelerandoBook = (options) => request('/rapid-reader/accelerando', options);
