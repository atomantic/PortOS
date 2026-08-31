/**
 * Seed the dedicated, default-off Persistent Mind Eidoverse grant.
 *
 * Generic PortOS write access pre-dates this capability but must not imply
 * authority to build, grant roles, or speak in the private world. Existing
 * installs therefore receive an explicit false value during upgrade.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite, safeJSONParse } from '../../server/lib/fileUtils.js';

// Historical migrations pin their source/target versions. Importing the live
// schema constant would make a future schema bump reinterpret this migration
// and could revoke an explicit grant when an applied-migration ledger is
// rebuilt.
const TARGET_SCHEMA_VERSION = 5;

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

    const config = state.config && typeof state.config === 'object' && !Array.isArray(state.config)
      ? state.config
      : {};
    const existing = config.persistentMindCapabilities
      && typeof config.persistentMindCapabilities === 'object'
      && !Array.isArray(config.persistentMindCapabilities)
      ? config.persistentMindCapabilities
      : {};
    if (Number.isInteger(existing.schemaVersion)
      && existing.schemaVersion >= TARGET_SCHEMA_VERSION) {
      return { updated: 0, reason: 'already-applied' };
    }

    state.config = {
      ...config,
      persistentMindCapabilities: {
        ...existing,
        schemaVersion: TARGET_SCHEMA_VERSION,
        manageEidoverse: false,
      },
    };
    await atomicWrite(statePath, state);
    console.log('🌐 migration 320: seeded the default-off Persistent Mind Eidoverse grant');
    return { updated: 1 };
  },
};
