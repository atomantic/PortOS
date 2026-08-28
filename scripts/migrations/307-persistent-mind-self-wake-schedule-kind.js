/** Classify durable Persistent Mind self-wakes without inferring from display text. */

import { readFile } from 'fs/promises';
import { join } from 'path';
import {
  PERSISTENT_MIND_SCHEMA_VERSION,
  PERSISTENT_MIND_SELF_WAKE_SCHEDULE_KINDS,
} from '../../server/lib/persistentMind.js';
import { atomicWrite, safeJSONParse } from '../../server/lib/fileUtils.js';

const classifySelfWake = (wake) => {
  if (!wake || typeof wake !== 'object' || Array.isArray(wake) || wake.kind !== 'self') return wake;
  if (PERSISTENT_MIND_SELF_WAKE_SCHEDULE_KINDS.includes(wake.scheduleKind)) return wake;
  // Legacy wake reasons are model-authored text. Treat them as requested so a
  // cadence increase never postpones a possibly intentional follow-up.
  return { ...wake, scheduleKind: 'requested' };
};

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

    const selfWake = classifySelfWake(existing.selfWake);
    const activeWake = classifySelfWake(existing.activeTurn?.wake);
    const activeTurn = activeWake === existing.activeTurn?.wake
      ? existing.activeTurn
      : { ...existing.activeTurn, wake: activeWake };
    if (existing.schemaVersion === PERSISTENT_MIND_SCHEMA_VERSION
        && selfWake === existing.selfWake
        && activeTurn === existing.activeTurn) {
      return { updated: 0, reason: 'already-applied' };
    }

    state.persistentMind = {
      ...existing,
      schemaVersion: PERSISTENT_MIND_SCHEMA_VERSION,
      selfWake,
      activeTurn,
    };
    await atomicWrite(statePath, state);
    console.log('🧠 migration 307: classified Persistent Mind self-wake schedules');
    return { updated: 1 };
  },
};
