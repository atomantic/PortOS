import { request } from './apiCore.js';

// User-defined catalog ingredient TYPE API surface. Mirrors apiCatalog.js
// style — every helper takes an optional `options` second arg so a caller with
// its own `.catch` toast can pass `{ silent: true }` (avoids the double-toast
// the shared `request` helper would otherwise produce).
//
// GET /types returns the FULL active registry (system + user) so the client can
// merge it with the static fallback registry. The mutating routes persist
// through settings.json server-side and return the refreshed active registry.

const enc = encodeURIComponent;

// List the active type registry (system + user-defined). Returns { types }.
export const listCatalogTypes = (options) => request('/catalog/types', options);

// Create a user-defined type. `body` is { id, label, primaryContentKey, fields }.
export const createCatalogType = (body = {}, options) =>
  request('/catalog/types', { method: 'POST', body: JSON.stringify(body), ...options });

// Update a user-defined type (id is immutable; the path id wins).
export const updateCatalogType = (id, body = {}, options) =>
  request(`/catalog/types/${enc(id)}`, { method: 'PATCH', body: JSON.stringify(body), ...options });

// Delete a user-defined type. Pass `{ force: true }` to delete a type that
// still has ingredients (otherwise the server refuses with a 409). The orphaned
// rows survive and render under the fallback editor.
export const deleteCatalogType = (id, { force = false, ...options } = {}) =>
  request(`/catalog/types/${enc(id)}${force ? '?force=true' : ''}`, { method: 'DELETE', ...options });
