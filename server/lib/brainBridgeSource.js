/**
 * `BRAIN_BRIDGE_SOURCE_AGENT_ID` — the `source_agent_id` of memories the Brain bridge derives per
 * install.
 *
 * The memory federation stream excludes them in both directions.
 */

/**
 * `memories.source_agent_id` of rows the Brain → memory bridge derives from a
 * Brain record. Each install derives its own from the synced Brain record, so
 * the memory federation stream never carries them (#14260).
 */
export const BRAIN_BRIDGE_SOURCE_AGENT_ID = 'brain-bridge';
