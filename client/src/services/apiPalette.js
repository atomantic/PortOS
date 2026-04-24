import { request } from './apiCore.js';

export const getPaletteManifest = () => request('/palette/manifest');

export const runPaletteAction = (id, args = {}) =>
  request(`/palette/action/${encodeURIComponent(id)}`, {
    method: 'POST',
    body: JSON.stringify({ args }),
  });
