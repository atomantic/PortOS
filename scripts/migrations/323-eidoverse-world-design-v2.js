/**
 * Upgrade the install-local Eidoverse projection state to World Design V2.
 *
 * The migration is deliberately offline: it only rewrites PortOS's small
 * recipe/config file. Asset resolution and world reconciliation happen after
 * the Eidoverse runtime is online, without an AI call or external checkout
 * mutation.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite, safeJSONParse } from '../../server/lib/fileUtils.js';
import { migrateEidoverseWorldState } from '../../server/lib/eidoverseWorldDesign.js';

export default {
  async up({ rootDir }) {
    const statePath = join(rootDir, 'data', 'eidoverse', 'portos-world.json');
    const raw = await readFile(statePath, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (raw == null) return { updated: 0, reason: 'no-state' };

    const state = safeJSONParse(raw, null, { logError: false });
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      console.warn('⚠️ migration 323: skipped invalid Eidoverse world JSON; the feature will remain unavailable until its state file is repaired or restored');
      return { updated: 0, reason: 'invalid-json' };
    }
    const migration = migrateEidoverseWorldState(state);
    if (!migration.compatible) {
      const reason = migration.report?.reason || 'unknown';
      console.warn(`⚠️ migration 323: skipped incompatible Eidoverse world state (${reason}); the feature will surface repair or update guidance when opened`);
      return { updated: 0, reason };
    }
    if (state.schemaVersion === 2 && state.selectedDesignVersion === 2
      && JSON.stringify(migration.state) === JSON.stringify(state)) {
      return { updated: 0, reason: 'already-applied' };
    }
    await atomicWrite(statePath, migration.state);
    console.log(`🌐 migration 323: prepared Eidoverse World Design V2 with ${migration.report?.preservedOverrides?.length || 0} preserved override(s)`);
    return { updated: 1, preservedOverrides: migration.report?.preservedOverrides || [] };
  },
};
