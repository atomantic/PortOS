/** Add opt-in local thinking authority and durable request state; never infer. */
import { join } from 'path';
import { readFile } from 'fs/promises';
import { atomicWrite } from '../../server/lib/fileUtils.js';
import { PERSISTENT_MIND_CAPABILITIES_SCHEMA_VERSION } from '../../server/lib/persistentMindCapabilities.js';
import { PERSISTENT_MIND_SCHEMA_VERSION } from '../../server/lib/persistentMind.js';
export default {
  async up({ rootDir }) {
    let updated = 0;
    for (const name of ['config', 'state']) {
      const path = join(rootDir, 'data', 'cos', `${name}.json`);
      const raw = await readFile(path, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (raw === null) continue;
      const record = JSON.parse(raw);
      if (name === 'config') {
        record.persistentMindCapabilities = {
          chooseThinkingPreset: false, thinkingPresetAllowlist: [], thinkingPresetGrants: {},
          ...record.persistentMindCapabilities, schemaVersion: PERSISTENT_MIND_CAPABILITIES_SCHEMA_VERSION,
        };
      } else if (record.persistentMind) {
        record.persistentMind = { thinkingRequests: { pending: null, history: [] },
          ...record.persistentMind, schemaVersion: PERSISTENT_MIND_SCHEMA_VERSION };
      } else continue;
      await atomicWrite(path, record);
      updated += 1;
    }
    return { updated };
  },
};
