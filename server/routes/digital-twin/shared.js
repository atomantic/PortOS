/**
 * Shared plumbing for the digital-twin sub-routers.
 *
 * Mirrors the apps/pipeline sub-router `shared.js` pattern — one small module of
 * common helpers every domain router imports, so splitting the former ~990-line
 * single file into domain routers preserves a single guard behavior across all
 * of `/api/digital-twin`.
 */

import * as digitalTwinService from '../../services/digital-twin.js';
import { ServerError } from '../../lib/errorHandler.js';

/**
 * Assert a persona id (when supplied) resolves to a stored persona, throwing
 * 404 otherwise. A test run with a stale/deleted personaId would otherwise
 * silently fall back to the base twin, mislabeling the result; this makes the
 * contract explicit — mirroring the same guard on PUT /personas/active.
 */
export async function assertPersonaExists(personaId) {
  if (personaId && !(await digitalTwinService.getPersonaById(personaId))) {
    throw new ServerError('Persona not found', { status: 404, code: 'NOT_FOUND' });
  }
}
