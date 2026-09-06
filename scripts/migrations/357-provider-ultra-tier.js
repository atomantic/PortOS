/** Add the optional frontier tier without changing existing routing or custom pins. */
import { join } from 'node:path';
import { atomicWrite, readJSONFileStrict } from '../../server/lib/fileUtils.js';

export default {
  async up({ rootDir }) {
    const path = join(rootDir, 'data/providers.json');
    const { ok, value: data } = await readJSONFileStrict(path, null);
    if (!ok || !data?.providers) return { success: true, skipped: 'no readable providers' };
    let updated = 0;
    for (const provider of Object.values(data.providers)) {
      if (Object.hasOwn(provider, 'ultraModel')) continue;
      // Only select a model this install already advertises. Custom catalogs
      // and intentionally empty pins stay under the user's control.
      const models = Array.isArray(provider.models) ? provider.models : [];
      const candidates = provider.command === 'codex' ? ['gpt-6-astra']
        : provider.command === 'claude' ? ['claude-fable-5-1', 'claude-fable-5', 'fable'] : [];
      provider.ultraModel = candidates.find(model => models.includes(model)) || null;
      updated++;
    }
    if (updated) await atomicWrite(path, data);
    return { success: true, updated };
  },
};
