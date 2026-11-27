/** Read one live or archived CoS agent record without loading its transcript. */
import { join } from 'path';
import { safeJSONParse, tryReadFile } from '../../lib/fileUtils.js';
import { AGENTS_DIR, loadState } from './cosState.js';
import { loadAgentIndex } from './cosAgentIndex.js';

/**
 * The agent record WITHOUT its transcript — in-memory state first, falling back
 * to the on-disk `metadata.json` the index points at.
 *
 * Split out of `getAgent` so callers that only need the record's fields (the
 * worktree/provider metadata, the status) don't pay to read and line-split a
 * completed agent's entire output.txt — which for a long TUI run is megabytes,
 * and whose read failing would otherwise take the whole lookup down with it.
 * `releaseRetryHold` is the motivating caller (#3368).
 */
export async function getAgentRecord(agentId) {
  const state = await loadState();
  const agent = state.agents[agentId];
  if (agent) return agent;

  // Fall back to disk metadata via index if not in state
  const idx = await loadAgentIndex();
  const dateStr = idx.get(agentId);
  if (!dateStr) return null;
  const content = await tryReadFile(join(AGENTS_DIR, dateStr, agentId, 'metadata.json'));
  if (!content) return null;
  const raw = safeJSONParse(content, null);
  if (!raw) return null;
  const { output, ...rest } = raw;
  return { ...rest, id: raw.id || raw.agentId || agentId, status: raw.status || 'completed' };
}
