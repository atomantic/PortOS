/** List and manage the catalog ingredient type registry. */

import { Router } from 'express';
import * as catalogDB from '../services/catalog/catalogDB.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { catalogUserTypeSchema, catalogUserTypesSettingsSchema, catalogTypeDeleteQuerySchema } from '../lib/catalog/catalogValidation.js';
import { getActiveCatalogTypes, setUserCatalogTypes } from '../lib/catalog/catalogTypes.js';
import { updateUserTypes } from '../services/catalogUserTypes/store.js';

const router = Router();

// User types live in PostgreSQL (`catalog_user_types`, #1001 — formerly the
// settings.json `catalogUserTypes` slice) and merge into the active type
// registry. These routes are the CRUD surface the Settings → Catalog tab
// drives. Every mutating route persists through the catalogUserTypes store AND
// calls `setUserCatalogTypes` so the in-process registry refreshes without a
// restart. The GET returns the FULL active registry (system + user) normalized
// for the client merge, with each entry's `system` flag.

router.get('/types', asyncHandler(async (req, res) => {
  // Active registry (system first, then user). Each entry already carries
  // `system`, `label`, `primaryContentKey`, `snippetFallbackKeys`, and (for
  // user types) the `fields` list the generic editor renders.
  res.json({ types: getActiveCatalogTypes() });
}));

// Strip any client-supplied sync-control fields and stamp a fresh server-side
// `updatedAt` — the LWW federation merge relies on this timestamp being set by
// the writer, never trusted from the client. Clears any tombstone so a write
// always revives (an edit newer than a delete wins).
const stampUserType = (body) => {
  const { deletedAt: _d, updatedAt: _u, ...rest } = body;
  return { ...rest, updatedAt: new Date().toISOString(), deletedAt: null };
};

router.post('/types', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogUserTypeSchema, req.body);
  await updateUserTypes((slice) => {
    const current = Array.isArray(slice) ? slice : [];
    // A LIVE type with this id already exists → conflict. A tombstoned id (or a
    // fresh id) is fine: POST revives the tombstone / creates anew, replacing the
    // slot in place so the unique-id invariant holds.
    const idx = current.findIndex((t) => t.id === body.id);
    if (idx !== -1 && !current[idx].deletedAt) {
      throw new ServerError(`Catalog type "${body.id}" already exists`, { status: 409 });
    }
    const stamped = stampUserType(body);
    const next = idx === -1
      ? [...current, stamped]
      : current.map((t, i) => (i === idx ? stamped : t));
    // Validate the whole slice (unique-id + system-collision refinements) before
    // persisting — a system-id collision (e.g. "character") is rejected here.
    validateRequest(catalogUserTypesSettingsSchema, next);
    return next;
  }, setUserCatalogTypes);
  console.log(`🧩 Catalog: added user type "${body.id}"`);
  res.status(201).json({ types: getActiveCatalogTypes() });
}));

router.patch('/types/:id', asyncHandler(async (req, res) => {
  // Merge the path id onto the body so a partial PATCH still validates as a
  // full user-type (id is immutable — the path wins over any body id).
  const merged = validateRequest(catalogUserTypeSchema, { ...req.body, id: req.params.id });
  await updateUserTypes((slice) => {
    const current = Array.isArray(slice) ? slice : [];
    // Editing a tombstoned (deleted) type is a 404 — it must be re-created via POST.
    const idx = current.findIndex((t) => t.id === req.params.id && !t.deletedAt);
    if (idx === -1) throw new ServerError(`Catalog type "${req.params.id}" not found`, { status: 404 });
    const next = [...current];
    next[idx] = stampUserType(merged);
    validateRequest(catalogUserTypesSettingsSchema, next);
    return next;
  }, setUserCatalogTypes);
  console.log(`🧩 Catalog: updated user type "${req.params.id}"`);
  res.json({ types: getActiveCatalogTypes() });
}));

router.delete('/types/:id', asyncHandler(async (req, res) => {
  const force = validateRequest(catalogTypeDeleteQuerySchema, req.query).force === 'true';
  await updateUserTypes(async (slice) => {
    const current = Array.isArray(slice) ? slice : [];
    const idx = current.findIndex((t) => t.id === req.params.id && !t.deletedAt);
    if (idx === -1) throw new ServerError(`Catalog type "${req.params.id}" not found`, { status: 404 });
    // Refuse to delete a type that still has ingredients of that type unless the
    // caller explicitly forces it (`?force=true`) — otherwise those rows become
    // orphaned (their `type` no longer resolves in the active registry, so the
    // detail page falls back to the generic 'idea' editor and the type filter
    // drops them). force=true deletes the definition anyway; the rows survive
    // and just render under the fallback editor.
    if (!force) {
      const { items } = await catalogDB.listIngredients({ type: req.params.id, limit: 1, skipDecorations: true });
      if (items.length > 0) {
        throw new ServerError(
          `Catalog type "${req.params.id}" has ingredients — pass ?force=true to delete it anyway`,
          { status: 409, code: 'CATALOG_TYPE_IN_USE' },
        );
      }
    }
    // Soft-delete: KEEP the entry with a `deletedAt` tombstone (and a fresh
    // `updatedAt`) so the deletion federates to peers via the catalogTypes sync
    // block. A physical removal would let a peer that still has the definition
    // resurrect it on the next pull. setUserCatalogTypes filters tombstones out
    // of the active registry, so the type disappears from the UI immediately.
    const deletedAt = new Date().toISOString();
    const next = current.map((t, i) => (
      i === idx ? { ...t, deletedAt, updatedAt: deletedAt } : t
    ));
    validateRequest(catalogUserTypesSettingsSchema, next);
    return next;
  }, setUserCatalogTypes);
  console.log(`🧩 Catalog: deleted user type "${req.params.id}"${force ? ' (forced)' : ''}`);
  res.json({ types: getActiveCatalogTypes() });
}));

export default router;
