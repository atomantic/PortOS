/** Give every existing persistent-mind runtime slice its stable trajectory id. */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { PERSISTENT_MIND_SCHEMA_VERSION } from '../../server/lib/persistentMind.js';
import { PERSISTENT_MIND_ID } from '../../server/lib/persistentMindTrajectory.js';
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
    const existing = state?.persistentMind;
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      return { updated: 0, reason: 'no-persistent-mind' };
    }
    if (existing.mindId === PERSISTENT_MIND_ID
        && existing.schemaVersion === PERSISTENT_MIND_SCHEMA_VERSION) {
      return { updated: 0, reason: 'already-applied' };
    }

    state.persistentMind = {
      ...existing,
      schemaVersion: PERSISTENT_MIND_SCHEMA_VERSION,
      mindId: typeof existing.mindId === 'string' && existing.mindId.trim()
        ? existing.mindId.trim().slice(0, 128)
        : PERSISTENT_MIND_ID,
    };
    await atomicWrite(statePath, state);
    console.log('🧠 migration 299: added stable persistent mind trajectory identity');
    return { updated: 1 };
  },
};
