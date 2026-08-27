/**
 * Add the default-off persistent-mind provider profile to existing CoS state.
 *
 * The runtime slice arrived in migration 298. Keeping the profile in config
 * makes its schema independently evolvable and, crucially, never turns an
 * existing install's persistent mind on during upgrade.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite } from '../../server/lib/fileUtils.js';
import { createDefaultPersistentMindProfile } from '../../server/lib/persistentMindProfile.js';

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

    state.config = state.config && typeof state.config === 'object' && !Array.isArray(state.config)
      ? state.config
      : {};
    if (Object.hasOwn(state.config, 'persistentMindProfile')) {
      return { updated: 0, reason: 'already-applied' };
    }

    state.config.persistentMindProfile = createDefaultPersistentMindProfile();
    await atomicWrite(statePath, state);
    console.log('🧠 migration 300: added disabled persistent mind provider profile');
    return { updated: 1 };
  },
};
