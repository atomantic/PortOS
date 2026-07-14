/**
 * Collection Store — per-type, per-record JSON storage with explicit
 * `schemaVersion` stamping.
 *
 * Layout on disk:
 *
 *     {dir}/
 *     ├── index.json          // { schemaVersion, type, updatedAt, config: {…} }
 *     ├── <id-1>/
 *     │   └── index.json      // the record itself
 *     └── <id-2>/
 *         └── index.json
 *
 * Replaces the legacy "one big JSON file per type" pattern (where every write
 * rewrites the whole file and every load parses every record) once a
 * collection has outgrown it. See `data/runs/` for the proven prior-art shape
 * this generalizes.
 *
 * The `config` slot — type-level shared state (convention):
 *   The type index's `config` object holds cross-record state that belongs to
 *   the collection as a whole rather than to any single record — the things
 *   that would otherwise need their own sidecar file. The convention is
 *   grounded in the first real consumer (universeBuilder, see migration 034),
 *   which keeps a capped `config.runs[]` history log alongside its per-universe
 *   records. The agreed shape (see the `TypeIndexConfig` typedef below):
 *
 *     config: {
 *       runs?:         [],   // append-mostly cross-record history/audit log,
 *                            //   capped by the consumer (universeBuilder caps
 *                            //   at the last 200) — the established slot
 *       featureFlags?: {},   // reserved: per-collection toggles
 *       lockPolicies?: {},   // reserved: per-collection lock rules
 *       …                    // consumers MAY add their own keys; document the
 *                            //   shape next to the consumer that owns it
 *     }
 *
 *   `runs` is the only slot with a shipped consumer; `featureFlags` /
 *   `lockPolicies` are reserved names so the next consumer reuses them instead
 *   of inventing a synonym. Treat the slot as open-but-conventional: prefer a
 *   reserved name when one fits, and keep each key's value an object or array
 *   so the shallow-merge semantics below stay predictable.
 *
 *   Merge semantics: `saveTypeIndex({ config })` shallow-merges at the TOP
 *   level of `config` — `{ ...current.config, ...patch.config }`. A patch that
 *   sets `runs` REPLACES the whole `runs` array; it does NOT deep-merge into
 *   it. So a read-modify-write of an array (or nested-object) slot must load
 *   the current value, mutate a copy, and write the full replacement (see
 *   `recordRun` in universeBuilder). The merge is one level deep only.
 *
 *   Write-fence: `config`-slot writes all share ONE file (`index.json`) across
 *   every record in the type, so a read→modify→write cycle on a slot must run
 *   inside `queueTypeIndexWrite(fn)` to avoid clobbering a concurrent edit.
 *   `recordRun` is the canonical example: it loads the index, appends to
 *   `runs`, caps, and writes — all inside the type-index queue. Use
 *   `saveTypeIndex` for a simple patch (it queues internally); reach for
 *   `queueTypeIndexWrite` directly only when the read and the write must be
 *   fenced together. `defaultTypeIndexConfig` seeds the slot on a fresh type
 *   index (and on any read where `config` is missing or not a plain object);
 *   it is NOT re-applied on later writes.
 *
 * Two versioning concerns coexist:
 *   - The TYPE-LEVEL `schemaVersion` (this file): describes the on-disk
 *     storage layout. Bumped by a migration that changes layout (e.g. a split
 *     from a monolithic JSON to per-record dirs).
 *   - The RECORD-LEVEL `schemaVersion` (carried inside each record by some
 *     services, e.g. universeBuilder): describes the shape of one record's
 *     fields. Bumped by in-memory sanitizers when fields move/rename.
 *
 * These are distinct: a per-record sanitizer can mature without ever bumping
 * the type-level version, and a layout change can stamp a new type-level
 * version while record shape stays at v4.
 *
 * Concurrency model:
 *   - `queueRecordWrite(id, fn)` tail-chains per-id, so two concurrent
 *     read-modify-write cycles on the SAME record serialize, but writes to
 *     DIFFERENT records run in parallel. This is the scalability win over
 *     the single-file write queue.
 *   - `queueTypeIndexWrite(fn)` single-tail-chains writes to the type-level
 *     `index.json` so cross-record state (e.g. a shared `runs[]` log) doesn't
 *     race with itself.
 *   - `saveOne(id, record)` already wraps its write in `queueRecordWrite`, so
 *     plain mutations don't need explicit queueing. Wrap a custom RMW cycle
 *     in `queueRecordWrite(id, async () => { ... })` when an external read
 *     spans the load/save boundary, then call `saveOneNow` inside that queue
 *     so the queued function does not wait on itself.
 */

import { join } from 'path';
import { readdir, lstat, rm } from 'fs/promises';
import { atomicWrite, readJSONFile, ensureDir } from './fileUtils.js';
import { createFileWriteQueue, createRecordWriteQueue } from './fileWriteQueue.js';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The type-index `config` slot — cross-record state owned by the collection as
 * a whole. See the header doc block for the convention. All keys are optional;
 * a consumer that needs a slot not listed here MAY add its own (document it
 * next to the consumer), but should prefer a reserved name when one fits. Each
 * value should be an array or plain object so the top-level shallow-merge in
 * `saveTypeIndex` stays predictable.
 *
 * @typedef {object} TypeIndexConfig
 * @property {Array<object>} [runs]
 *   Append-mostly cross-record history/audit log. The consumer is responsible
 *   for capping growth (universeBuilder keeps the last 200) and for sanitizing
 *   each entry on read/write. The only slot with a shipped consumer today.
 * @property {Object<string, boolean>} [featureFlags]
 *   Reserved: per-collection on/off toggles.
 * @property {Object<string, object>} [lockPolicies]
 *   Reserved: per-collection lock rules.
 */

/**
 * Create a per-type collection store.
 *
 * @param {object} opts
 * @param {string} opts.dir
 *   Absolute path to the type's root directory, e.g. `${PATHS.data}/universes`.
 * @param {string} opts.type
 *   Stable type label (e.g. `'universes'`). Persisted in the type-level index;
 *   used in error/log messages so a misregistered store is obvious.
 * @param {number} opts.schemaVersion
 *   The layout version the code currently expects. `verifySchemaVersion()`
 *   asserts the on-disk type index matches this.
 * @param {(record: any) => any} [opts.sanitizeRecord]
 *   Optional record-level normalizer. Called on every `loadOne` result. Return
 *   `null` to treat the on-disk record as invalid (loadOne returns `null`).
 * @param {TypeIndexConfig} [opts.defaultTypeIndexConfig]
 *   Initial value for the `config` slot of a freshly-minted type index (and the
 *   fallback when an on-disk index is missing/has a non-object `config`).
 *   Defaults to `{}`. Seeds the slot on first read only — it is NOT re-applied
 *   on later `saveTypeIndex` writes, which shallow-merge over the current value.
 *   See the `TypeIndexConfig` typedef and the header `config`-slot convention.
 * @param {RegExp} [opts.idPattern]
 *   Allowlist for record-directory names. Defaults to a permissive pattern
 *   (`/^[A-Za-z0-9_-]{1,128}$/`) — services with stricter id rules should pass
 *   their own (e.g. UUID-only) so `listIds()` doesn't surface stray files.
 */
export function createCollectionStore({
  dir,
  type,
  schemaVersion,
  sanitizeRecord = null,
  defaultTypeIndexConfig = {},
  idPattern = /^[A-Za-z0-9_-]{1,128}$/,
} = {}) {
  if (typeof dir !== 'string' || !dir) {
    throw new Error('createCollectionStore: `dir` is required');
  }
  if (typeof type !== 'string' || !type) {
    throw new Error('createCollectionStore: `type` is required');
  }
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new Error('createCollectionStore: `schemaVersion` must be a positive integer');
  }

  const typeIndexPath = () => join(dir, 'index.json');
  const recordDir = (id) => join(dir, id);
  const recordPath = (id) => join(dir, id, 'index.json');
  // Process-local fallback for tests that mock fileUtils' read/write helpers
  // without backing them with a real directory tree. Production listIds still
  // uses readdir as the source of truth whenever the collection dir exists.
  const knownIds = new Set();

  const isValidId = (id) => typeof id === 'string' && idPattern.test(id);

  // Per-record write queue. Tail-chained per `id` so two writes against the
  // same record serialize while writes against different records proceed in
  // parallel. The shared `createRecordWriteQueue` helper carries the id-keyed
  // silence/self-prune discipline; the assert throws synchronously on a bad id
  // before anything is enqueued.
  const queueRecordWrite = createRecordWriteQueue((id) => {
    if (!isValidId(id)) {
      throw new Error(`collectionStore[${type}]: invalid record id "${id}" — must match ${idPattern}`);
    }
  });

  // Type-index single-tail queue. Used by `saveTypeIndex` and by callers that
  // need a write-fence around config-slot updates (`runs[]`, feature flags).
  const queueTypeIndexWrite = createFileWriteQueue();

  const buildEmptyTypeIndex = () => ({
    schemaVersion,
    type,
    updatedAt: new Date().toISOString(),
    config: { ...defaultTypeIndexConfig },
  });

  /**
   * Load the type-level index.json. Returns the default shape (with the
   * code-expected `schemaVersion`) when the file is missing — does NOT write
   * to disk. Use `saveTypeIndex` / `saveOne` to persist.
   */
  async function loadTypeIndex() {
    const raw = await readJSONFile(typeIndexPath(), null, { logError: false });
    if (!isPlainObject(raw)) return buildEmptyTypeIndex();
    return {
      schemaVersion: Number.isInteger(raw.schemaVersion) ? raw.schemaVersion : schemaVersion,
      type: typeof raw.type === 'string' && raw.type ? raw.type : type,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
      config: isPlainObject(raw.config) ? raw.config : { ...defaultTypeIndexConfig },
    };
  }

  /**
   * Persist a patch into the type-level index. `schemaVersion` / `type` are
   * replaced only when the patch supplies a valid value (else preserved);
   * `config` is SHALLOW-merged one level deep (`{ ...current, ...patch.config }`,
   * so a patched slot like `runs` replaces the whole array — see the header
   * `config`-slot convention); `updatedAt` is restamped automatically.
   * Serialized through `queueTypeIndexWrite` so concurrent callers can't stomp
   * each other's config-slot edits. For a read-modify-write that must read the
   * current slot value before writing (e.g. appending to `runs`), do the load
   * and the write together inside one `queueTypeIndexWrite(fn)` rather than
   * leaning on this patch form.
   *
   * @param {{ schemaVersion?: number, type?: string, config?: TypeIndexConfig }} [patch]
   */
  function saveTypeIndex(patch = {}) {
    return queueTypeIndexWrite(async () => {
      await ensureDir(dir);
      const current = await loadTypeIndex();
      const next = {
        schemaVersion: Number.isInteger(patch.schemaVersion) ? patch.schemaVersion : current.schemaVersion,
        type: typeof patch.type === 'string' && patch.type ? patch.type : current.type,
        config: isPlainObject(patch.config) ? { ...current.config, ...patch.config } : current.config,
        updatedAt: new Date().toISOString(),
      };
      await atomicWrite(typeIndexPath(), next);
      return next;
    });
  }

  /**
   * List the on-disk record ids. Source of truth is `readdir(dir)`, not a
   * manifest — keeps `index.json` from drifting against the actual directory
   * contents. Filters out the type-level `index.json`, hidden entries, and
   * anything that doesn't match `idPattern` or isn't a directory.
   */
  async function listIds() {
    const entries = await readdir(dir).catch((err) => {
      if (err?.code === 'ENOENT') return null;
      throw err;
    });
    if (entries === null) return [...knownIds].filter(isValidId);
    const candidates = entries.filter((name) =>
      name !== 'index.json'
      && !name.startsWith('.')
      && isValidId(name)
    );
    // lstat (not stat) so symlinks are NOT followed — a symlink whose target
    // is a directory would otherwise be accepted as a valid record dir, with
    // future deleteOne calls rm-rf'ing the symlink AND its target's contents.
    // PortOS is single-user/Tailscale-private so this is defense-in-depth
    // rather than a real attack vector, but it closes the foot-gun where a
    // user symlinks a record dir to external storage. lstat rejects the
    // symlink as non-directory; legitimate same-volume directories pass.
    const stats = await Promise.all(candidates.map((name) =>
      lstat(join(dir, name)).then((s) => (s.isDirectory() ? name : null), () => null)
    ));
    return stats.filter(Boolean);
  }

  /**
   * Load one record by id. Returns `null` when the record dir is missing or
   * the on-disk JSON fails to parse; runs the configured `sanitizeRecord` on
   * the parsed payload (sanitizer can also return `null` to reject).
   */
  async function loadOne(id) {
    if (!isValidId(id)) return null;
    const parsed = await readJSONFile(recordPath(id), null, { allowArray: false, logError: false });
    if (!isPlainObject(parsed)) return null;
    if (typeof sanitizeRecord === 'function') {
      return sanitizeRecord(parsed);
    }
    return parsed;
  }

  /**
   * Load one record WITHOUT running `sanitizeRecord`. Some callers need to
   * compare the raw on-disk shape to the sanitized shape (e.g. detect "this
   * record's nested ids need persisting" — sanitize mints missing ids on the
   * fly but doesn't persist them until the next write). Returns the parsed
   * JSON or `null`; ignores the sanitizer entirely.
   */
  async function loadOneRaw(id) {
    if (!isValidId(id)) return null;
    const parsed = await readJSONFile(recordPath(id), null, { allowArray: false, logError: false });
    return isPlainObject(parsed) ? parsed : null;
  }

  /**
   * Load every record in parallel. O(N) cost — acceptable while record counts
   * are bounded (typical PortOS collections sit in the tens-to-hundreds), but
   * callers iterating very large collections should prefer `listIds` +
   * targeted `loadOne` rather than slurping the whole set.
   */
  async function loadAll() {
    const ids = await listIds();
    const records = await Promise.all(ids.map((id) => loadOne(id)));
    return records.filter((r) => r != null);
  }

  /**
   * Persist a record. Serialized per-id so two concurrent writes against the
   * same id chain on each other; writes against different ids run in parallel.
   * Throws on missing/invalid id; sanitizer is NOT applied on write (callers
   * are expected to pre-sanitize before calling — same convention as the
   * monolithic-state services).
   */
  async function saveOneNow(id, record) {
    if (!isValidId(id)) {
      throw new Error(`collectionStore[${type}]: invalid record id "${id}" — must match ${idPattern}`);
    }
    if (!isPlainObject(record)) {
      throw new Error(`collectionStore[${type}]: record must be a plain object`);
    }
    await ensureDir(recordDir(id));
    await atomicWrite(recordPath(id), record);
    knownIds.add(id);
    return record;
  }

  function saveOne(id, record) {
    if (!isValidId(id)) {
      throw new Error(`collectionStore[${type}]: invalid record id "${id}" — must match ${idPattern}`);
    }
    if (!isPlainObject(record)) {
      throw new Error(`collectionStore[${type}]: record must be a plain object`);
    }
    return queueRecordWrite(id, async () => {
      return saveOneNow(id, record);
    });
  }

  /**
   * Hard-delete a record WITHOUT the per-id queue. Removes the entire
   * `{dir}/{id}/` subtree AND drops the id from `knownIds` (the readdir-ENOENT
   * fallback source). The delete-side counterpart to `saveOneNow`: call it
   * INSIDE a `queueRecordWrite(id, …)` block when an external recheck must span
   * the load→delete boundary atomically (e.g. tombstone GC re-checking that the
   * record is still deleted before removing it). Idempotent — missing dir is a
   * no-op. Outside a queue, prefer `deleteOne`.
   */
  async function deleteOneNow(id) {
    if (!isValidId(id)) {
      throw new Error(`collectionStore[${type}]: invalid record id "${id}" — must match ${idPattern}`);
    }
    await rm(recordDir(id), { recursive: true, force: true });
    knownIds.delete(id);
  }

  /**
   * Hard-delete a record. Removes the entire `{dir}/{id}/` subtree so any
   * sidecar files (per-record images, derived assets) go with it. Serialized
   * on the per-record queue so a delete can't race with an in-flight write.
   * Idempotent — missing dir is a no-op.
   */
  function deleteOne(id) {
    if (!isValidId(id)) {
      throw new Error(`collectionStore[${type}]: invalid record id "${id}" — must match ${idPattern}`);
    }
    return queueRecordWrite(id, () => deleteOneNow(id));
  }

  /**
   * Boot-time verifier — confirms the on-disk type index matches the code's
   * expected `schemaVersion`. Returns a status object rather than throwing so
   * `server/index.js` can log all collections in one pass.
   *
   *   ok=true   — on-disk version matches code (or type index is missing,
   *               which is treated as a fresh install — the next write
   *               stamps the correct version).
   *   ok=false  — on-disk version is older OR newer than code. Older → a
   *               pending migration didn't run. Newer → code rolled back
   *               below a forward-only migration.
   */
  async function verifySchemaVersion() {
    const raw = await readJSONFile(typeIndexPath(), null, { logError: false });
    if (!isPlainObject(raw) || raw.schemaVersion == null) {
      return {
        ok: true,
        onDisk: null,
        expected: schemaVersion,
        type,
        message: `collection "${type}": no index.json (fresh install) — first write will stamp schemaVersion=${schemaVersion}`,
      };
    }
    const onDisk = Number.isInteger(raw.schemaVersion) ? raw.schemaVersion : null;
    if (onDisk === schemaVersion) {
      return { ok: true, onDisk, expected: schemaVersion, type, message: `collection "${type}" @ v${schemaVersion}` };
    }
    if (onDisk != null && onDisk < schemaVersion) {
      return {
        ok: false,
        onDisk,
        expected: schemaVersion,
        type,
        message: `collection "${type}": on-disk v${onDisk}, code expects v${schemaVersion} — a migration didn't run. Check scripts/migrations/ and run \`npm run migrations\`.`,
      };
    }
    return {
      ok: false,
      onDisk,
      expected: schemaVersion,
      type,
      message: `collection "${type}": on-disk v${onDisk}, code expects v${schemaVersion} — code rolled back below a forward-only migration. Roll forward or restore from a backup.`,
    };
  }

  return {
    // Paths (mostly for tests + migration scripts)
    dir,
    type,
    schemaVersion,
    typeIndexPath,
    recordDir,
    recordPath,
    // Type-level index
    loadTypeIndex,
    saveTypeIndex,
    // Per-record CRUD
    listIds,
    loadOne,
    loadOneRaw,
    loadAll,
    saveOneNow,
    saveOne,
    deleteOneNow,
    deleteOne,
    // Concurrency primitives
    queueRecordWrite,
    queueTypeIndexWrite,
    // Boot-time verifier
    verifySchemaVersion,
  };
}

/**
 * Walk a list of stores, run `verifySchemaVersion()` on each, log the result,
 * and return the per-store status array. Used at server boot AFTER migrations
 * run so a missed migration produces a loud, single-line log per collection.
 *
 * PortOS is single-user — a hard exit on mismatch is worse than a noisy log,
 * so this never throws (the caller decides whether to keep booting).
 */
export async function verifyCollectionVersions(stores = []) {
  const statuses = [];
  for (const store of stores) {
    const status = await store.verifySchemaVersion();
    if (status.ok) {
      console.log(`📋 ${status.message}`);
    } else {
      console.error(`❌ ${status.message}`);
    }
    statuses.push(status);
  }
  return statuses;
}
