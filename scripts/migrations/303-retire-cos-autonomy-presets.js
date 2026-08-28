/** Remove retired global CoS preset fields while preserving per-job autonomy. */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite } from '../../server/lib/fileUtils.js';

export const RETIRED_COS_CONFIG_KEYS = [
  'autonomyLevel',
  'comprehensiveAppImprovement',
  'immediateExecution',
];

export default {
  async up({ rootDir }) {
    const statePath = join(rootDir, 'data', 'cos', 'state.json');
    const raw = await readFile(statePath, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (raw == null) return { updated: 0, reason: 'no-state' };

    let state;
    try {
      state = JSON.parse(raw);
    } catch {
      return { updated: 0, reason: 'invalid-state' };
    }
    if (!state || typeof state !== 'object' || Array.isArray(state)
      || !state.config || typeof state.config !== 'object' || Array.isArray(state.config)) {
      return { updated: 0, reason: 'invalid-state' };
    }

    const removed = RETIRED_COS_CONFIG_KEYS.filter((key) => Object.hasOwn(state.config, key));
    if (removed.length === 0) return { updated: 0, reason: 'already-applied' };

    for (const key of removed) delete state.config[key];
    await atomicWrite(statePath, state);
    console.log(`🧹 migration 303: retired ${removed.length} obsolete CoS config field(s)`);
    return { updated: 1, removed };
  },
};
