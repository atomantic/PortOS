/**
 * Command-palette manifest + action dispatch.
 */

import { request } from './apiCore.js';

export const getPaletteManifest = ({ actionsOnly, ...options } = {}) =>
  request(actionsOnly ? '/palette/manifest?actionsOnly=1' : '/palette/manifest', options);

export const runPaletteAction = (id, args = {}) =>
  request(`/palette/action/${encodeURIComponent(id)}`, {
    method: 'POST',
    body: JSON.stringify({ args }),
  });
