/** Backfill archival completion policies after their indexed tables have been installed. */
import { join } from 'node:path';
import { PATHS } from '../../lib/fileUtils.js';
import { readArchivePolicyBackfill, readBranchPolicyArchiveStamp, replaceArchivePolicyRows } from '../../lib/cos/branchPolicyArchiveRows.js';

export async function up(client) {
  const dir = join(PATHS.cos, 'agents');
  const source = await readBackfill(dir).catch(error => {
    // An unreadable archive must hold policy lookups without preventing startup.
    console.warn(`⚠️ CoS branch policy backfill deferred: ${error.message}`);
    return null;
  });
  if (!source) return;
  // Projection failures leave the source authoritative. In particular, a
  // legacy key that cannot fit a PostgreSQL index must not block every boot.
  await client.query('SAVEPOINT branch_policy_backfill');
  try {
    await replaceArchivePolicyRows(client, source.stamp, source.rows);
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT branch_policy_backfill');
    console.warn(`⚠️ CoS branch policy backfill deferred: ${error.message}`);
  }
  await client.query('RELEASE SAVEPOINT branch_policy_backfill');
}

async function readBackfill(dir) {
  const stamp = await readBranchPolicyArchiveStamp(dir);
  const rows = stamp && await readArchivePolicyBackfill(dir, stamp);
  return rows ? { stamp, rows } : null;
}
