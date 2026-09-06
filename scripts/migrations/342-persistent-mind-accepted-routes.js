/**
 * Stamp accepted-route support without deriving consent from today's presets.
 * CoS state remains machine-local runtime state; there is no new store or seed.
 * Old temporary messages keep their content and get an explicit missing-route
 * sentinel. Execution refuses them until the user submits a fresh message.
 */
import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite, safeJSONParse } from '../../server/lib/fileUtils.js';

export default {
  async up({ rootDir }) {
    const path = join(rootDir, 'data', 'cos', 'state.json');
    const raw = await readFile(path, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (raw === null) return { updated: 0, reason: 'no-state' };
    const state = safeJSONParse(raw, null, { logError: false });
    const mind = state?.persistentMind;
    if (!mind || typeof mind !== 'object' || Array.isArray(mind)) return { updated: 0, reason: 'no-mind' };
    if (mind.schemaVersion > 7) return { updated: 0, reason: 'newer-schema' };
    let changed = mind.schemaVersion !== 7;
    const markUnverified = (message) => {
      if (!message?.thinkingPresetId || Object.hasOwn(message, 'thinkingPreset')) return;
      message.thinkingPreset = null;
      changed = true;
    };
    for (const message of Array.isArray(mind.queuedMessages) ? mind.queuedMessages : []) markUnverified(message);
    if (mind.activeTurn?.wake?.kind === 'message') markUnverified(mind.activeTurn.wake.message);
    if (!changed) return { updated: 0, reason: 'already-applied' };
    mind.schemaVersion = 7;
    await atomicWrite(path, state);
    return { updated: 1 };
  },
};
