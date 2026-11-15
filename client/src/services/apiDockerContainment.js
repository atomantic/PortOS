/**
 * Docker containment (#12844).
 *
 * `getDockerContainmentStatus()` (`GET /docker-containment/status`): engine verdict (Docker Desktop vs
 * native Engine, context, version) and which pinned Node images are pulled — no Docker call while the
 * feature is off. `pullDockerContainmentImage(major)` (`POST /docker-containment/pull`): the explicit
 * operator pull.
 */

import { request } from './apiCore.js';

// Docker containment (#12844): the engine verdict and pinned-image presence for
// Settings > Features. The server answers without any Docker call while the
// feature is off.
export const getDockerContainmentStatus = (options) => request('/docker-containment/status', options);

// Explicit operator action: pull one pinned Node image. Runs never pull.
export const pullDockerContainmentImage = (major, options) =>
  request('/docker-containment/pull', { method: 'POST', body: JSON.stringify({ major }), ...options });
