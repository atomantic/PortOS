// Additive upgrade: existing rows start at version 1 without rewriting their text.
import { memoryHistoryDdl } from '../../lib/db/schema/core.js';

export async function up(client) {
  for (const statement of memoryHistoryDdl) await client.query(statement);
}
