import { join } from 'node:path';
import { atomicWrite, readJSONFileStrict } from '../../server/lib/fileUtils.js';
import { persistPrivateKeys } from '../../server/services/privateKeyStore.js';

export default {
  async up({ rootDir }) {
    const file = join(rootDir, 'data/settings.json');
    const { ok, value } = await readJSONFileStrict(file, null);
    if (!ok) throw new Error('Cannot migrate unreadable settings');
    if (!value) return { success: true, skipped: 'no settings' };
    // Write keys before removing legacy copies. A retry preserves newer keys.
    const settings = await persistPrivateKeys(value, join(rootDir, 'data'), { preserveExisting: true });
    await atomicWrite(file, settings);
    return { success: true };
  },
};
