// Durable retry identity for Catalog scrap commits (#8684); additive and
// machine-local — receipts are never federated.
import { catalogCommitReceiptsDdl } from '../../lib/db/schema/catalog.js';

export async function up(client) {
  for (const statement of catalogCommitReceiptsDdl) await client.query(statement);
}
