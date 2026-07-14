/**
 * Universe Builder — storage facade (shared by crud + sync).
 *
 * Universe storage facade (#1014). PostgreSQL-backed (`universes` +
 * `universe_runs`) on normal installs; the per-record file store
 * (collectionStore) only under MEMORY_BACKEND=file / NODE_ENV=test. The facade
 * is SYNCHRONOUS — it owns the per-id write queue + the mutation epoch + applies
 * `sanitizeTemplate` on read — and defers backend selection into each method, so
 * this service keeps calling `store()` exactly as it did the collectionStore.
 * Methods used here: loadOne / loadOneRaw / listIds / queueRecordWrite /
 * writeRecord(id, rec) / deleteRecord(id) / loadRuns / appendRun /
 * removeRunsForUniverses. `writeRecord`/`deleteRecord` replace the inline
 * ensureDir+atomicWrite(recordPath) / rm(recordDir) the file layout used, and
 * bump the mutation epoch so dataSync re-sends the universe snapshot to peers
 * (the storage swap stays invisible to federation — see the schema-design doc).
 *
 * Split out of the former monolithic `universeBuilder.js` (#2529) so the CRUD
 * and sync modules share one facade getter.
 */

import { getUniverseStore } from './store.js';
import { sanitizeTemplate } from './sanitize.js';

export const store = () => getUniverseStore(sanitizeTemplate);

/**
 * Exported for the boot-time verifier in `server/index.js`. The facade getter
 * is cheap + memoized; calling it at boot picks up the right PATHS.data root.
 */
export const universeStore = () => store();
