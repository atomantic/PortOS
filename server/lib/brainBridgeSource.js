/**
 * `memories.source_agent_id` of rows the Brain → memory bridge derives from a
 * Brain record. Each install derives its own from the synced Brain record, so
 * the memory federation stream never carries them (#14260).
 */
export const BRAIN_BRIDGE_SOURCE_AGENT_ID = 'brain-bridge';
