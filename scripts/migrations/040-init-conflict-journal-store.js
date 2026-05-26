/**
 * Initialize the conflict-journal collection store.
 *
 * The non-blocking conflict journal (server/lib/conflictJournal.js) archives
 * the losing local version when a cross-install LWW merge would overwrite a
 * record that BOTH sides edited independently. It is purely local runtime
 * state (never synced to peers), stored at `data/conflict-journal/{id}/index.json`
 * with a type-level `data/conflict-journal/index.json` stamping schemaVersion 1.
 *
 * The store self-initializes on first write, and the boot-time
 * verifyCollectionVersions tolerates a missing index (reads as the expected
 * version). This migration stamps the type index up front so an existing
 * install lands in the same clean state as a fresh one — idempotent: a second
 * run (or an install that already wrote a journal entry) is a no-op.
 *
 * Dependency-light (fs + path only), per the migration convention. No
 * data.reference/ seed — an empty runtime store ships nothing.
 */

import { mkdir, readFile, writeFile, stat } from 'fs/promises';
import { join } from 'path';

const TYPE_SCHEMA_VERSION = 1;

const fileExists = (p) => stat(p).then(() => true, (e) => { if (e.code === 'ENOENT') return false; throw e; });

export default {
  async up({ rootDir }) {
    const typeDir = join(rootDir, 'data', 'conflict-journal');
    const typeIndexPath = join(typeDir, 'index.json');

    if (await fileExists(typeIndexPath)) {
      const raw = await readFile(typeIndexPath, 'utf-8').catch(() => null);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && parsed.schemaVersion >= TYPE_SCHEMA_VERSION) {
        console.log('🪢 migration 040: conflict-journal store already initialized — no-op');
        return { ok: true, reason: 'already-applied' };
      }
    }

    await mkdir(typeDir, { recursive: true });
    await writeFile(typeIndexPath, JSON.stringify({
      schemaVersion: TYPE_SCHEMA_VERSION,
      type: 'conflictJournal',
      updatedAt: new Date().toISOString(),
      config: {},
    }, null, 2) + '\n');
    console.log(`🪢 migration 040: stamped data/conflict-journal/index.json @ v${TYPE_SCHEMA_VERSION}`);
    return { ok: true, reason: 'initialized' };
  },
};
