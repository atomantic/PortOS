/**
 * Seed the durable outbound-call ledger on Persistent Mind state.
 *
 * The rate caps on the new `voice.call-user` capability are read from this
 * list, so it has to exist before the first call is considered. An absent list
 * would normalize to empty anyway; stamping it here means an install that never
 * wakes its mind still reads as migrated instead of pending forever.
 */

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
    if (existing.schemaVersion === PERSISTENT_MIND_SCHEMA_VERSION && Array.isArray(existing.callHistory)) {
      return { updated: 0, reason: 'already-applied' };
    }

    state.persistentMind = {
      ...existing,
      schemaVersion: PERSISTENT_MIND_SCHEMA_VERSION,
      // Never reset an existing ledger: the caps it backs must survive an
      // upgrade the same way they survive a restart.
      callHistory: Array.isArray(existing.callHistory) ? existing.callHistory : [],
    };
    await atomicWrite(statePath, state);
    console.log('🧠 migration 313: seeded the Persistent Mind outbound-call ledger');
    return { updated: 1 };
  },
};
