import { request } from './apiCore.js';

// Where each media file is used: { items: { '<kind>:<ref>': [{ source, label, id, title, role, href }] } }.
export const getMediaUsages = (options = {}) => request('/media/usages', options);
