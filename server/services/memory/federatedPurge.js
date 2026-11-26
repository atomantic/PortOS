/**
 * PostgreSQL memory purge markers and peer eligibility.
 *
 * Storage: `db-primary` — only the deleted UUID and its clock federate.
 * Keep the marker across cursor rewinds and offline peers' replays.
 */
import { PERSISTENT_MIND_ID } from '../../lib/persistent/persistentMindTrajectory.js';
import { PERSISTENT_MIND_CHOSEN_NAME_TAG } from '../../lib/persistent/persistentMindChosenName.js';
import { BRAIN_BRIDGE_SOURCE_AGENT_ID } from '../../lib/brainBridgeSource.js';

const localAgents = [PERSISTENT_MIND_ID, BRAIN_BRIDGE_SOURCE_AGENT_ID];
export const exclusionParams = [localAgents, PERSISTENT_MIND_CHOSEN_NAME_TAG];

export const canFederate = (agent, tags) => !localAgents.includes(agent) && !tags?.includes(PERSISTENT_MIND_CHOSEN_NAME_TAG);

// All identifiers and parameter positions come from the query at the call site.
export const federatedRow = (alias, param) =>
  `(COALESCE(${alias}.source_agent_id, '') <> ALL($${param}::text[])
    AND NOT ($${param + 1} = ANY(COALESCE(${alias}.tags, '{}'::text[]))))`;

// A missing UUID has no row to lock. Serialize peer batches and hard purges
// before either reads the other table, including when both start from absence.
export const lockPurgeMarkers = client => client.query('LOCK TABLE memory_tombstones IN SHARE ROW EXCLUSIVE MODE');

export async function recordDeletions(client, markers) {
  const ids = markers.map(m => m.id);
  await client.query(
    `INSERT INTO memory_tombstones (id, deleted_at)
     SELECT t.id, MAX(t.deleted_at) FROM unnest($1::uuid[], $2::timestamptz[]) AS t(id, deleted_at)
     WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = t.id AND NOT ${federatedRow('m', 3)})
     GROUP BY t.id
     ON CONFLICT (id) DO UPDATE SET deleted_at = EXCLUDED.deleted_at, sync_sequence = DEFAULT
     WHERE memory_tombstones.deleted_at < EXCLUDED.deleted_at`,
    [ids, markers.map(m => m.deletedAt), ...exclusionParams]
  );
}

export async function applyDeletions(client, markers) {
  await recordDeletions(client, markers);
  // Return absent tombstoned IDs too. If notification cleanup failed after
  // a previous commit, retrying the page must still scrub its local previews.
  const { rows } = await client.query(
    `WITH targets AS (
       SELECT t.id, t.deleted_at FROM memory_tombstones t WHERE t.id = ANY($1::uuid[])
     ), removed AS (
       DELETE FROM memories m USING targets t
       WHERE m.id = t.id AND ${federatedRow('m', 2)}
         AND date_trunc('milliseconds', m.updated_at) <= t.deleted_at
       RETURNING m.id, m.status, m.source_agent_id
     )
     SELECT id, status, source_agent_id, true AS deleted FROM removed
     UNION ALL
     SELECT t.id, NULL, NULL, false FROM targets t WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = t.id)`,
    [markers.map(m => m.id), ...exclusionParams]
  );
  return rows;
}
