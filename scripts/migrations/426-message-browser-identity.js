/** Pin legacy timeline identities before browser summaries adopt stable row IDs.
 * Input-gated, offline, and additive: no cache or seed is created. */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { retainLegacyActivityIdentities } from '../../server/lib/messageBrowserIdentity.js';
import { writeJsonAtomic } from './_lib.js';

export default {
  async up({ rootDir }) {
    const directory = join(rootDir, 'data', 'messages', 'cache');
    const files = await readdir(directory).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    let updated = 0;
    for (const name of files.filter(name => /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.json$/i.test(name))) {
      const path = join(directory, name);
      const raw = await readFile(path, 'utf8');
      let cache;
      try { cache = JSON.parse(raw); } catch { continue; }
      if (!Array.isArray(cache?.messages) || cache.messages.some(message => !message || typeof message !== 'object' || Array.isArray(message))) continue;
      const before = JSON.stringify(cache);
      retainLegacyActivityIdentities(cache.messages);
      if (JSON.stringify(cache) === before) continue;
      await writeJsonAtomic(path, cache);
      updated++;
    }
    return { updated };
  }
};
