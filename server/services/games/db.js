/**
 * PostgreSQL leaf I/O for Game records. The full sanitized record is stored in
 * JSONB; app_id/name/updated_at are mirrored for the common list/filter paths.
 *
 * Storage: `db-primary` — machine-local, never federated (no sync cursor or tombstone; hard
 * deletes), because app registration, sprite atlases and music bytes are machine-local.
 * Compiled manifests are immutable SHA-256-addressed files under `data/games/{id}/manifests/`;
 * the record holds only their pointers and hashes.
 */

import { createJsonbLeafDb } from '../../lib/jsonbLeafDb.js';

export const { readRaw, listRaw, writeRaw, deleteRaw } = createJsonbLeafDb({
  table: 'games',
  orderBy: [['updated_at', 'DESC'], ['id', 'ASC']],
  mirrorColumns: {
    app_id: record => record.appId,
    name: record => record.name,
  },
});
