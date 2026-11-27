/**
 * PostgreSQL leaf I/O for saved storyboard recipes (the Make tab's library).
 * The sanitized record lives in `data` JSONB; name/updated_at are mirrored for
 * the list sort, and the tombstone pair keeps a later federation additive.
 *
 * Storage: `db-primary` — machine-local, not federated yet. A saved recipe is a template a
 * board loads as a copy, never a live link, and per-panel run state never travels with it.
 */

import { createJsonbLeafDb } from '../../lib/jsonbLeafDb.js';

export const { readRaw, listRaw, writeRaw } = createJsonbLeafDb({
  table: 'storyboard_recipes',
  orderBy: [['updated_at', 'DESC'], ['id', 'ASC']],
  softDelete: {},
  mirrorColumns: { name: record => record.name },
});
