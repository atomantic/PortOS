/**
 * Add the default-off persistent-mind runtime slice to existing CoS state.
 *
 * Fresh installs receive the same shape from cosState.DEFAULT_STATE. Existing
 * installs get an explicit durable slice so later child issues can evolve it
 * through schemaVersion without mistaking absence for user consent.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { createDefaultPersistentMindState } from '../../server/lib/persistentMind.js';
import { atomicWrite } from '../../server/lib/fileUtils.js';

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
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      return { updated: 0, reason: 'invalid-state' };
    }
    if (Object.hasOwn(state, 'persistentMind')) {
      return { updated: 0, reason: 'already-applied' };
    }

    state.persistentMind = createDefaultPersistentMindState();
    await atomicWrite(statePath, state);
    console.log('🧠 migration 298: added disabled persistent CoS mind runtime state');
    return { updated: 1 };
  },
};
