/** Grant the standing media.delete capability to already-paired peers. */
import { join } from 'node:path';
import { readJsonOrNull, writeJsonAtomic } from './_lib.js';

export default {
  async up({ rootDir }) {
    const path = join(rootDir, 'data', 'instances.json');
    const data = await readJsonOrNull(path);
    if (!data || !Array.isArray(data.peers)) return { updated: 0, reason: 'no-peers' };
    let updated = 0;
    const peers = data.peers.map(peer => {
      // Only an absent field is filled; an explicit false is the operator's refusal.
      if (!peer || typeof peer !== 'object' || Object.hasOwn(peer, 'mediaDeleteAllowed')) return peer;
      updated++;
      return { ...peer, mediaDeleteAllowed: true };
    });
    if (updated) await writeJsonAtomic(path, { ...data, peers });
    return { updated };
  },
};
