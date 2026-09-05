/** Add explicit default-off cross-instance chat authority without widening local grants. */
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicWrite } from '../../server/lib/fileUtils.js';
export default {
  async up({ rootDir }) {
    const path = join(rootDir, 'data', 'cos', 'config.json');
    const raw = await readFile(path, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (raw === null) return { updated: 0 };
    const record = JSON.parse(raw);
    record.persistentMindCapabilities = { visitEidoversePeers: false, ...record.persistentMindCapabilities, schemaVersion: 7 };
    await atomicWrite(path, record);
    return { updated: 1 };
  },
};
