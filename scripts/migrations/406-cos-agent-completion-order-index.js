/**
 * Backfill the CoS archive's completion-order projection.
 *
 * `data/cos/agents/index.json` records only agentId → YYYY-MM-DD, so paging the
 * completed-run history had to read every `metadata.json` in each day it visited
 * just to order it — a busy day paid that read again for every page inside it —
 * and the pending-feedback badge read one archive record per reference to produce
 * a single number. The sidecar written here (`index.order.json`) carries each
 * archived run's completion timestamp plus a completed / still-needs-feedback
 * bitfield, so both readers answer from memory and hydrate only the rows they
 * return.
 *
 * Gated on the presence of its INPUT (`index.json`), never on the absence of its
 * output: `setup-data.js` runs first, so an output-absence gate plus a shipped
 * seed is how #6182 replaced a user's records with defaults. This path therefore
 * ships no `data.reference/` seed and is declared in `migrationOwnedPaths.js`.
 *
 * Re-running is safe and cheap: unchanged entries are skipped, rows the index no
 * longer owns are pruned, and nothing is written when neither happened. The
 * runtime repairs whatever this misses — an unreadable record, an archive
 * imported from a peer later — by re-reading that one day and backfilling it.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite } from '../../server/lib/fileUtils.js';
import {
  decodeCompletionOrder,
  encodeCompletionOrder,
  projectArchivedAgent,
  sameCompletionProjection,
} from '../../server/lib/cosAgentCompletionOrder.js';

const AGENTS_REL = join('data', 'cos', 'agents');
const INDEX_FILE = 'index.json';
const ORDER_FILE = 'index.order.json';
const DATE_BUCKET = /^\d{4}-\d{2}-\d{2}$/;
// Matches the archive reader's fan-out so a long-lived install does not open
// every metadata file at once.
const READ_BATCH_SIZE = 50;

const readJSON = async (path) => {
  const raw = await readFile(path, 'utf-8').catch(() => null);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return null; }
};

export default {
  async up({ rootDir }) {
    const agentsDir = join(rootDir, AGENTS_REL);
    const index = await readJSON(join(agentsDir, INDEX_FILE));
    if (index === null) return { projected: 0, reason: 'no-index' };
    if (typeof index !== 'object' || Array.isArray(index)) {
      console.warn('⚠️ CoS archive: index.json is not an id→date map — skipping completion-order backfill');
      return { projected: 0, reason: 'unexpected-shape' };
    }

    const existing = await readJSON(join(agentsDir, ORDER_FILE));
    const projections = decodeCompletionOrder(existing);
    const owned = Object.entries(index)
      .filter(([agentId, date]) => agentId && typeof date === 'string' && DATE_BUCKET.test(date));

    let projected = 0;
    let unreadable = 0;
    for (let i = 0; i < owned.length; i += READ_BATCH_SIZE) {
      const batch = await Promise.all(owned.slice(i, i + READ_BATCH_SIZE).map(async ([agentId, date]) => {
        const metadata = await readJSON(join(agentsDir, date, agentId, 'metadata.json'));
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
        return [agentId, projectArchivedAgent(metadata)];
      }));
      for (const entry of batch) {
        if (!entry) { unreadable += 1; continue; }
        if (sameCompletionProjection(projections.get(entry[0]), entry[1])) continue;
        projections.set(entry[0], entry[1]);
        projected += 1;
      }
    }

    const ownedIds = new Set(owned.map(([agentId]) => agentId));
    let pruned = 0;
    for (const agentId of projections.keys()) {
      if (ownedIds.has(agentId)) continue;
      projections.delete(agentId);
      pruned += 1;
    }

    // A decodable file that needs no change is left alone; an absent or
    // unrecognized one is (re)written even when empty, so the next boot reads a
    // valid document instead of re-deriving nothing.
    if (projected === 0 && pruned === 0 && existing !== null && decodeCompletionOrder(existing).size === projections.size) {
      return { projected: 0, pruned: 0, unreadable };
    }

    await atomicWrite(join(agentsDir, ORDER_FILE), encodeCompletionOrder(projections));
    const suffix = unreadable > 0 ? `, ${unreadable} unreadable archive(s) left for the runtime to repair` : '';
    console.log(`📇 CoS archive: projected completion order for ${projected} run(s)${suffix}`);
    return { projected, pruned, unreadable };
  },
};
