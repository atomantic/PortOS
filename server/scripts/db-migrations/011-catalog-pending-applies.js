// Receiver-local durable inbox; no source records or replay cursors are changed.
import { catalogPendingAppliesDdl } from '../../lib/db/schema/catalog.js';

export async function up(client) {
  for (const statement of catalogPendingAppliesDdl) await client.query(statement);
}
