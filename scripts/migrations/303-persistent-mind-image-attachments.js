/** Add the bounded pending-attachment index to Persistent Mind state. */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { PERSISTENT_MIND_SCHEMA_VERSION } from '../../server/lib/persistentMind.js';
import { atomicWrite, safeJSONParse } from '../../server/lib/fileUtils.js';

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
    const existing = state.persistentMind;
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      return { updated: 0, reason: 'no-persistent-mind' };
    }
    if (existing.schemaVersion === PERSISTENT_MIND_SCHEMA_VERSION
        && Array.isArray(existing.pendingAttachments)
        && Array.isArray(existing.recentMessageFingerprints)) {
      return { updated: 0, reason: 'already-applied' };
    }

    state.persistentMind = {
      ...existing,
      schemaVersion: PERSISTENT_MIND_SCHEMA_VERSION,
      pendingAttachments: Array.isArray(existing.pendingAttachments)
        ? existing.pendingAttachments
        : [],
      recentMessageFingerprints: Array.isArray(existing.recentMessageFingerprints)
        ? existing.recentMessageFingerprints
        : [],
    };
    await atomicWrite(statePath, state);
    console.log('🧠 migration 303: added Persistent Mind image attachment state');
    return { updated: 1 };
  },
};
