import { request } from './apiCore.js';

export const getPaletteManifest = (options) => request('/palette/manifest', options);

export const runPaletteAction = (id, args = {}) =>
  request(`/palette/action/${encodeURIComponent(id)}`, {
    method: 'POST',
    body: JSON.stringify({ args }),
  });
