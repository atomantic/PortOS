/**
 * Fold `data/peer-media-holdings.json` (the file times each paired peer
 * reported, used for origin attribution) into the shared holders record
 * `data/media-holders.json` under `reports`, then retire the old file (#14141).
 * One record now carries both what a peer holds and when its copy was made.
 *
 * Derived data: gated on the OLD file's presence and shipped without a
 * `data.reference/` seed. A report already in the shared record is newer than
 * anything the old file held for that scope only if its `at` says so, so the
 * later of the two wins. An unreadable shared record is left alone and the old
 * file kept for the next boot. Writes go straight to the files: the frozen
 * transform must not import services.
 */
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { readJsonOrNull, writeJsonAtomic } from './_lib.js';

export const OWNED_OUTPUT_PATHS = ['media-holders.json'];

const KINDS = ['video', 'image'];
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isReport = (r) => isPlainObject(r) && isPlainObject(r.mtimes) && Array.isArray(r.checked) && Number.isFinite(Date.parse(r.at));

export default {
  async up({ rootDir }) {
    const dataDir = join(rootDir, 'data');
    const oldPath = join(dataDir, 'peer-media-holdings.json');
    if (!existsSync(oldPath)) return { folded: 0, reason: 'no-input' };
    const storePath = join(dataDir, 'media-holders.json');
    const store = existsSync(storePath) ? await readJsonOrNull(storePath) : { version: 1, holdings: {}, releases: [] };
    if (!isPlainObject(store)) return { folded: 0, reason: 'unreadable-store' };
    const old = await readJsonOrNull(oldPath);
    if (old === null) return { folded: 0, reason: 'unreadable-input' };

    const reports = isPlainObject(store.reports) ? store.reports : {};
    let folded = 0;
    for (const [instanceId, kinds] of Object.entries(isPlainObject(old.peers) ? old.peers : {})) {
      if (!isPlainObject(kinds)) continue;
      for (const kind of KINDS) {
        for (const [scope, report] of Object.entries(isPlainObject(kinds[kind]) ? kinds[kind] : {})) {
          if (!isReport(report)) continue;
          const current = reports[instanceId]?.[kind]?.[scope];
          if (isReport(current) && Date.parse(current.at) >= Date.parse(report.at)) continue;
          reports[instanceId] = { ...reports[instanceId], [kind]: { ...reports[instanceId]?.[kind], [scope]: report } };
          folded += 1;
        }
      }
    }
    await writeJsonAtomic(storePath, { ...store, version: store.version ?? 1, reports });
    await rm(oldPath, { force: true });
    return { folded };
  },
};
