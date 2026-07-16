/**
 * Stamp the Creative Commission collection's type-level index at schemaVersion 1
 * (issue #2657, Autonomous Creation Engine — Phase 1).
 *
 * The commissions live in a `createCollectionStore` collection at
 * `data/creative-commissions/`. A fresh collection has no records and no
 * `index.json`; the boot verifier tolerates a missing index (treats it as a
 * fresh install), and the store stamps the index on its first write. But to keep
 * the on-disk shape explicit and let a future schemaVersion bump detect existing
 * v1 data, this migration creates the type index up front if it's absent.
 *
 * There is NO legacy monolith to split — commissions are a brand-new record kind
 * — so this is a pure stamp, not a data transform.
 *
 * Idempotent: a second run finds an index at version ≥ 1 and writes nothing.
 * Forward-only: never downgrades an index the code already advanced past 1.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const TYPE = 'creative-commissions';
const SCHEMA_VERSION = 1;

const readJson = async (path) => {
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
};

export async function up({ rootDir }) {
  const dir = join(rootDir, 'data', TYPE);
  const indexPath = join(dir, 'index.json');
  const existing = await readJson(indexPath);

  if (existing && typeof existing.schemaVersion === 'number' && existing.schemaVersion >= SCHEMA_VERSION) {
    console.log(`✅ creative-commissions: type index already at v${existing.schemaVersion} — no changes`);
    return { migrated: false };
  }

  await mkdir(dir, { recursive: true });
  const index = {
    schemaVersion: SCHEMA_VERSION,
    type: TYPE,
    updatedAt: new Date().toISOString(),
    config: {},
  };
  await writeFile(indexPath, JSON.stringify(index, null, 2) + '\n');
  console.log(`🎬 creative-commissions: stamped type index → v${SCHEMA_VERSION}`);
  return { migrated: true };
}

export default { up };
