/**
 * Standalone Production film projects: timeline/audio attachment and the shared film-panel transport.
 */

import { createBlenderFilmApi } from './apiBlenderFilm.js';
import { request } from './apiCore.js';

// A film from a published Blender model (turntable, assembly, controls, close-ups, reference). Starts no job; answers the film.
export const createShowcaseFilm = (modelId, options = {}) =>
  request('/code-animation/films/showcase', { method: 'POST', body: JSON.stringify({ modelId }), ...options });

export const codeAnimationFilmApi = createBlenderFilmApi(id => `/code-animation/films/${encodeURIComponent(id)}/blender`);

export const createFilm = (input, options) => request('/code-animation/films', { method: 'POST', body: JSON.stringify(input), ...options });
export const patchFilm = (id, input, options) => request(`/code-animation/films/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input), ...options });
export const attachAudio = (id, input, options) => request(`/code-animation/films/${encodeURIComponent(id)}/audio`, { method: 'POST', body: JSON.stringify(input), ...options });
export const promoteFilm = (id, input, options = {}) => request(`/code-animation/films/${encodeURIComponent(id)}/promote`, { method: 'POST', body: JSON.stringify(input), ...options });
