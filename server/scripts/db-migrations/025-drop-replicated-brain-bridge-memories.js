/**
 * Remove Brain-bridge memories replicated from peers (#14260).
 *
 * Each install derives its own bridged rows from the synced Brain record, so a
 * peer's copy is a duplicate that a Brain deletion never reaches. Only a row
 * stamped with another install's origin and not referenced by a local
 * brain_memory_links row is removed: a null origin (pre-federation row) or a
 * local link marks a locally derived row, and so does this install's id or the
 * 'unknown' stamp written before its identity existed. An unlinked local row
 * from a legacy bridge map keeps its local origin and therefore stays.
 * Frozen: reads instances.json directly instead of importing server/services.
 */
import { dataPath, readJSONFile } from '../../lib/fileUtils.js';

const BRAIN_BRIDGE_SOURCE_AGENT_ID = 'brain-bridge';
const UNKNOWN_INSTANCE_ID = 'unknown';

// Strict: an unreadable identity file must not make every origin look foreign.
export async function readLocalInstanceId() {
  const data = await readJSONFile(dataPath('instances.json'), {}, { strict: true });
  return data?.self?.instanceId ?? null;
}

export async function up(client, readInstanceId = readLocalInstanceId) {
  const localIds = [UNKNOWN_INSTANCE_ID, await readInstanceId()].filter(Boolean);
  const { rowCount } = await client.query(
    `DELETE FROM memories m
     WHERE m.source_agent_id = $1
       AND m.origin_instance_id IS NOT NULL
       AND NOT (m.origin_instance_id = ANY($2::text[]))
       AND NOT EXISTS (SELECT 1 FROM brain_memory_links l WHERE l.memory_id = m.id)`,
    [BRAIN_BRIDGE_SOURCE_AGENT_ID, localIds],
  );
  console.log(`🧠 brain bridge repair: removed ${rowCount} replicated peer cop${rowCount === 1 ? 'y' : 'ies'}`);
}
