/**
 * The persisted record of which model weights this machine has on disk.
 *
 * The downloaded-model inventory used to exist only while a page was open (Models → Status ran
 * a multi-store disk scan of the HF cache, `data/loras/`, Ollama's blob store and LM Studio's
 * tree). PortOS performs the installs and deletes, so this manifest records that knowledge in
 * `data/model-manifest.json`: the page renders instantly and a scan becomes a user-requested
 * RECONCILIATION.
 *
 * Two deliberately different write paths:
 *
 *  - **Recording.** `recordModelInstall` / `recordModelUninstall` are called from the install
 *    and delete chokepoints (one per backend). Best-effort, never failing their caller: an
 *    entry is worth less than the install it describes.
 *  - **Reconciliation.** `reconcileModelManifest` folds a real scan back in, adopting weights
 *    that arrived outside PortOS and dropping entries whose files are gone. Every full
 *    system-resource report reconciles as a side effect.
 *
 * **Reconciliation prunes only backends the scan could actually see.** A down Ollama or a
 * backend disabled in settings reports zero models; pruning on that would erase a correct
 * manifest. Untrusted backends are left exactly as they were.
 *
 * Storage: `ephemeral-file` — machine-local, never federated, re-derivable by scanning (absent
 * = nothing tracked, no seed), and a non-overridable backup exclude: restoring one machine's
 * inventory onto another describes weights it does not have.
 */

import { join } from 'path';
import { createCachedStore, PATHS } from '../lib/fileUtils.js';
import {
  MODEL_INVENTORY_BACKENDS,
  MODEL_STORE_BACKENDS,
  modelInventoryId,
  presentInventoryRow,
} from '../lib/modelInventory.js';

const MODEL_MANIFEST_SCHEMA_VERSION = 1;

const EMPTY_MANIFEST = { schemaVersion: MODEL_MANIFEST_SCHEMA_VERSION, reconciledAt: null, models: {} };

/**
 * The shared single-JSON-document store: one write tail, a short read cache, and a STRICT load.
 *
 * `mutate` is load → modify → persist, so a present-but-unreadable manifest must reject rather
 * than read as "no models installed" (the next write would stamp that emptiness over the
 * record). An ABSENT file yields the default.
 *
 * The single tail matters because writers overlap (a reconcile walks four backends while a
 * queued LM Studio download records itself) and this module is the file's only writer.
 *
 * Built on FIRST USE, not at module load: the install chokepoints import this module, which a
 * long tail of suites reach while partially mocking `fileUtils.js`; module-scope construction
 * would turn a missing mock export into an import-time crash.
 */
let store = null;
const manifestStore = () => (store ??= createCachedStore(
  join(PATHS.data, 'model-manifest.json'),
  EMPTY_MANIFEST,
  { context: 'model manifest' },
));

/** Test seam, mirroring `resetSystemResourceReportCache` on the surface this feeds. */
export const resetModelManifestCache = () => store?.invalidateCache();

// Read-time shape repair. The file survives downgrades and hand edits, so a
// missing or wrong-typed member reads as its empty form rather than throwing.
const normalize = (raw) => ({
  reconciledAt: typeof raw?.reconciledAt === 'string' ? raw.reconciledAt : null,
  models: raw?.models && typeof raw.models === 'object' && !Array.isArray(raw.models) ? raw.models : {},
});

/**
 * Serialized read-modify-write over the normalized manifest.
 *
 * `fn` returns `{ document, value }`: a null `document` leaves the file untouched and `value`
 * is what the caller wanted to learn (reconcile counts, whether an entry was there to remove).
 * It rides out of the mutation because the persisted document cannot distinguish "nothing
 * changed" from "the write failed".
 *
 * Every mutator is best-effort: a failed write logs and yields `fallback` rather than failing
 * the install or delete that triggered it.
 */
const mutateManifest = async (label, fn, fallback) => {
  let value = fallback;
  return manifestStore().mutate(async (raw) => {
    const outcome = await fn(normalize(raw));
    value = outcome.value;
    return outcome.document === null
      ? raw
      : { schemaVersion: MODEL_MANIFEST_SCHEMA_VERSION, ...outcome.document };
  }).then(() => value, (err) => {
    console.error(`❌ ${label}: ${err.message}`);
    return fallback;
  });
};

/**
 * The stored shape of one inventory row: the durable facts only.
 *
 * Residency and on-disk verification are LIVE facts; `presentInventoryRow` re-derives them on
 * read so a rule change fixes every existing row. `key` is not stored: it is the second half
 * of `id`.
 *
 * `installedAt` + `source` are what the page renders: a row adopted by a reconcile has an
 * `installedAt` of "when we first looked", so the UI says "tracked since" for those and
 * "installed" for ones PortOS performed.
 */
function storedEntry(row, { installedAt, source }) {
  const entry = { id: row.id, backend: row.backend, installedAt, source };
  for (const field of ['name', 'detail', 'sizeBytes', 'risk', 'cleanupReason', 'managePath', 'action', 'sourcePrune']) {
    if (row[field] != null) entry[field] = row[field];
  }
  if (row.sizeIsEstimate) entry.sizeIsEstimate = true;
  return entry;
}

/**
 * The manifest as the API and Status page consume it: rows sorted largest first, matching the
 * scan's ordering.
 *
 * @returns {Promise<{ reconciledAt: string|null, models: Array<Object> }>}
 */
export async function getModelManifest() {
  const manifest = normalize(await manifestStore().load());
  const models = Object.values(manifest.models)
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.id === 'string')
    .map(presentInventoryRow)
    .sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0));
  return { reconciledAt: manifest.reconciledAt, models };
}

/**
 * Record that weights are now on disk.
 *
 * Idempotent on re-install: the original `installedAt` and `source` survive a re-download, so a
 * repair pass doesn't make an old model look new.
 *
 * @param {Object} row An inventory row from `lib/modelInventory.js`'s builders
 * @param {string} [row.source] How PortOS learned about it ('install' by default)
 * @returns {Promise<boolean>} Whether the manifest now holds the entry
 */
export function recordModelInstall({ source = 'install', ...row } = {}) {
  // Guards the whole contract: a row builder answers `id: null` for a backend or key it could
  // not use, and this function promises never to fail the install it describes.
  if (!row.id) return Promise.resolve(false);
  return mutateManifest(`Could not record model install ${row.id}`, (manifest) => {
    const previous = manifest.models[row.id];
    return {
      document: {
        ...manifest,
        models: {
          ...manifest.models,
          [row.id]: storedEntry(row, {
            installedAt: previous?.installedAt || new Date().toISOString(),
            source: previous?.source || source,
          }),
        },
      },
      value: true,
    };
  }, false);
}

/**
 * Record that weights are gone from disk.
 *
 * @param {Object} input
 * @param {string} input.backend
 * @param {string} input.key The backend's own identifier for the weights
 * @returns {Promise<boolean>} Whether an entry was actually removed
 */
export function recordModelUninstall({ backend, key } = {}) {
  const id = modelInventoryId(backend, key);
  if (!id) return Promise.resolve(false);
  return mutateManifest(`Could not record model uninstall ${id}`, (manifest) => {
    if (!manifest.models[id]) return { document: null, value: false };
    const { [id]: _removed, ...models } = manifest.models;
    return { document: { ...manifest, models }, value: true };
  }, false);
}

/**
 * Which backends a scan actually observed, and may therefore be pruned against.
 *
 * A disabled or unreachable backend contributes zero rows, indistinguishable from "no models";
 * the scan's `sourceErrors` / `disabledSources` are the honest signal. A *residency* probe
 * failure is not disqualifying: it says nothing about what is on disk.
 *
 * @param {Object} [options]
 * @param {Array<string>} [options.sourceErrors]
 * @param {Array<string>} [options.disabledSources]
 * @returns {Set<string>}
 */
export function trustedInventoryBackends({ sourceErrors = [], disabledSources = [] } = {}) {
  const failed = new Set(sourceErrors);
  const disabled = new Set(disabledSources);
  const trusted = new Set(MODEL_INVENTORY_BACKENDS);
  if (failed.has('huggingface')) trusted.delete('huggingface');
  if (failed.has('loras')) trusted.delete('lora');
  // The file-system model stores report as storage areas under their backend id.
  for (const backend of Object.keys(MODEL_STORE_BACKENDS)) {
    if (failed.has(backend)) trusted.delete(backend);
  }
  for (const backend of ['ollama', 'lmstudio']) {
    if (disabled.has(backend) || failed.has(`${backend}-backend`) || failed.has(`${backend}-inventory`)) {
      trusted.delete(backend);
    }
  }
  return trusted;
}

/**
 * Fold a real disk scan back into the manifest: adopt rows PortOS never saw installed and drop
 * rows whose files are gone, both scoped to the backends the scan could see (see
 * `trustedInventoryBackends`).
 *
 * @param {Array<Object>} downloadedModels Rows from the system-resource scan
 * @param {Object} [options]
 * @param {Array<string>} [options.sourceErrors]
 * @param {Array<string>} [options.disabledSources]
 * @returns {Promise<{ reconciledAt: string, added: number, removed: number, trusted: Array<string> }|null>}
 */
export function reconcileModelManifest(downloadedModels, { sourceErrors = [], disabledSources = [] } = {}) {
  const trusted = trustedInventoryBackends({ sourceErrors, disabledSources });
  return mutateManifest('Could not reconcile model manifest', (manifest) => {
    const now = new Date().toISOString();
    // A row the backend listed but whose on-disk folder could not be verified is neither adopted
    // as a tracked install NOR counted as absent when pruning. Filtering it out of `scanned` alone
    // handles only the first (the pruning loop would read a listed model as deleted); `unverified`
    // keeps the second: seen, not corroborated, so the existing row stands.
    const reported = (downloadedModels || []).filter((row) => trusted.has(row.backend));
    const scanned = new Map(reported.filter((row) => !row.inventoryUnknown).map((row) => [row.id, row]));
    const unverified = new Set(reported.filter((row) => row.inventoryUnknown).map((row) => row.id));

    const models = {};
    let removed = 0;
    for (const [id, entry] of Object.entries(manifest.models)) {
      if (trusted.has(entry.backend) && !scanned.has(id) && !unverified.has(id)) removed += 1;
      else models[id] = entry;
    }
    let added = 0;
    for (const [id, row] of scanned) {
      const previous = models[id];
      if (!previous) added += 1;
      // A row PortOS installed keeps its real install date and provenance; one the scan found
      // first is dated "when we first looked" (`source: 'scan'`) so the page doesn't claim an old
      // model was installed this afternoon.
      models[id] = storedEntry(row, {
        installedAt: previous?.installedAt || now,
        source: previous?.source || 'scan',
      });
    }

    if (added || removed) console.log(`📓 Model manifest reconciled: +${added} / -${removed} (${[...trusted].join(', ') || 'no trusted backends'})`);
    return {
      document: { reconciledAt: now, models },
      value: { reconciledAt: now, added, removed, trusted: [...trusted] },
    };
  }, null);
}
