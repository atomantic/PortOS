/** Share CLI/TUI enablement without invalidating saved execution IDs or pins. */
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicWrite } from '../../server/lib/fileUtils.js';
import { unifyProviderModes } from '../../server/lib/aiToolkit/internal/providerModes.js';

export default {
  async up({ rootDir }) {
    const path = join(rootDir, 'data', 'providers.json');
    const raw = await readFile(path, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (raw === null) return { updated: 0 };
    const data = JSON.parse(raw);
    const changed = unifyProviderModes(data);
    if (changed) await atomicWrite(path, data);
    return { updated: changed ? 1 : 0 };
  },
};
