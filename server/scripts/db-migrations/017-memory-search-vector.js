// Backfill stored lexemes before retiring the expression index. Keeping both
// would tokenize the same text twice on writes. The boot DDL may already have
// added the new column/index; these statements also work on a pre-upgrade table.
import { memorySearchDdl } from '../../lib/db/schema/core.js';

export async function up(client) {
  for (const statement of memorySearchDdl) await client.query(statement);
  await client.query('DROP INDEX IF EXISTS idx_memories_fts');
}
