/**
 * The agent records an install kept in `data/cos/state.json`'s `agents` map
 * before they moved into `cos_agents` (#12738). Shared by migrations 020
 * (import) and 021 (retire the key), which must read the same input.
 *
 * Returns `{ state, agents }` — `agents` is null when there is nothing to move:
 * no file, a file that is not a JSON object (the runtime quarantines and resets
 * those already), or no `agents` map in it. An `agents` value that is not a
 * plain object is reported the same way, with a warning, since the runtime
 * never read such a value as records either.
 */
import { join } from 'node:path';
import { PATHS } from '../../lib/paths.js';
import { readJsonOrNull } from '../../../scripts/migrations/_lib.js';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export const cosStatePath = () => join(PATHS.cos, 'state.json');

export async function readCosStateAgents() {
  const state = await readJsonOrNull(cosStatePath());
  if (!isPlainObject(state) || !Object.hasOwn(state, 'agents')) return { state: isPlainObject(state) ? state : null, agents: null };
  if (!isPlainObject(state.agents)) {
    console.warn('⚠️ CoS agents: state.json carries a non-object agents value; nothing to import');
    return { state, agents: null };
  }
  return { state, agents: state.agents };
}
