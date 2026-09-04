/**
 * Introduce saved temporary thinking presets for the Persistent Mind (#6273).
 *
 * Two independent stamps, each gated on the file it reads:
 *
 * - `data/cos/config.json` gains an empty `persistentMindThinkingPresets` list.
 *   An absent list already normalizes to empty, so this changes no behavior; it
 *   means an install that never opens the Mind page still reads as migrated
 *   rather than pending forever, and it makes the new setting visible to anyone
 *   inspecting the config file.
 * - `data/cos/state.json` records the bumped Persistent Mind schema version,
 *   because a queued or active message may now carry a `thinkingPresetId`.
 *
 * Nothing is derived and nothing is seeded: an existing list is never replaced,
 * and the home profile's provider/model/effort selection is untouched. An
 * install that rolls back to a reader without temporary sessions simply drops
 * the field, and the message answers on the unchanged default route.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { PERSISTENT_MIND_SCHEMA_VERSION } from '../../server/lib/persistentMind.js';
import { createDefaultPersistentMindThinkingPresets } from '../../server/lib/persistentMindThinkingPresets.js';
import { atomicWrite, safeJSONParse } from '../../server/lib/fileUtils.js';

const readRecord = async (path) => {
  const raw = await readFile(path, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (raw == null) return { missing: true };
  const parsed = safeJSONParse(raw, null, { logError: false });
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? { record: parsed }
    : { invalid: true };
};

async function stampConfig(rootDir) {
  const configPath = join(rootDir, 'data', 'cos', 'config.json');
  const { record: config, missing, invalid } = await readRecord(configPath);
  if (missing || invalid) return false;
  if (config.persistentMindThinkingPresets && typeof config.persistentMindThinkingPresets === 'object') return false;
  await atomicWrite(configPath, {
    ...config,
    persistentMindThinkingPresets: createDefaultPersistentMindThinkingPresets(),
  });
  return true;
}

async function stampMindSchemaVersion(rootDir) {
  const statePath = join(rootDir, 'data', 'cos', 'state.json');
  const { record: state, missing, invalid } = await readRecord(statePath);
  if (missing || invalid) return false;
  const mind = state.persistentMind;
  if (!mind || typeof mind !== 'object' || Array.isArray(mind)) return false;
  if (mind.schemaVersion === PERSISTENT_MIND_SCHEMA_VERSION) return false;
  await atomicWrite(statePath, {
    ...state,
    persistentMind: { ...mind, schemaVersion: PERSISTENT_MIND_SCHEMA_VERSION },
  });
  return true;
}

export default {
  async up({ rootDir }) {
    const configStamped = await stampConfig(rootDir);
    const stateStamped = await stampMindSchemaVersion(rootDir);
    const updated = Number(configStamped) + Number(stateStamped);
    if (updated > 0) {
      console.log(`🧠 migration 342: prepared ${updated} Persistent Mind file(s) for temporary thinking sessions`);
    }
    return updated > 0 ? { updated } : { updated: 0, reason: 'already-applied' };
  },
};
