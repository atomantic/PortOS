/** Add the editable persistent-mind identity and operating prompt. */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite, safeJSONParse } from '../../server/lib/fileUtils.js';
import { createDefaultPersistentMindPrompt } from '../../server/lib/persistentMindPrompt.js';

export default {
  async up({ rootDir }) {
    const statePath = join(rootDir, 'data', 'cos', 'state.json');
    const raw = await readFile(statePath, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (raw == null) return { updated: 0, reason: 'no-state' };

    const state = safeJSONParse(raw, null, { logError: false });
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      return { updated: 0, reason: 'invalid-state' };
    }
    state.config = state.config && typeof state.config === 'object' && !Array.isArray(state.config)
      ? state.config
      : {};
    if (Object.hasOwn(state.config, 'persistentMindPrompt')) {
      return { updated: 0, reason: 'already-applied' };
    }

    state.config.persistentMindPrompt = createDefaultPersistentMindPrompt();
    await atomicWrite(statePath, state);
    console.log('🧠 migration 302: added editable persistent mind prompt');
    return { updated: 1 };
  },
};
