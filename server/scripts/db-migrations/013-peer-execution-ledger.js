// Additive receiver-local consumption records; creates no execution authority.
import { peerExecutionDdl } from '../../lib/db/schema/peerExecution.js';

export async function up(client) {
  for (const statement of peerExecutionDdl) await client.query(statement);
}
