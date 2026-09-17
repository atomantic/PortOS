/**
 * The persisted record of which model weights this machine has on disk.
 *
 * The downloaded-model inventory used to exist only for as long as a page was
 * open: Models → Status ran a multi-store disk scan (the Hugging Face cache,
 * `data/loras/`, Ollama's blob store, LM Studio's model tree) and threw the
 * result away on navigation, so the answer to "what have I downloaded?" cost a
 * fresh walk over tens of gigabytes every single time. PortOS already knows the
 * answer, though — it is the side that performs the installs and the deletes.
 * This manifest is that knowledge written down, so the page can render instantly
 * from `data/model-manifest.json` and a scan becomes a RECONCILIATION the user
 * asks for rather than the only way to see anything.
 *
 * Two write paths, and they are deliberately different:
 *
 *  - **Recording.** `recordModelInstall` / `recordModelUninstall` are called from
 *    the install and delete chokepoints (one per backend — see the comment at
 *    each call site). They are best-effort and never fail their caller: a
 *    manifest entry is worth strictly less than the install it describes.
 *  - **Reconciliation.** `reconcileModelManifest` folds a real scan back in,
 *    adopting weights that arrived outside PortOS and dropping entries whose
 *    files are gone. Every full system-resource report reconciles as a side
 *    effect, so the Refresh button and the Dev Tools storage report both heal the
 *    manifest without a second code path.
 *
 * **Reconciliation prunes only backends the scan could actually see.** An Ollama
 * server that is down, or a backend the user disabled in settings, reports zero
 * models — pruning on that would erase a correct manifest and silently tell the
 * user their weights are gone. Untrusted backends are left exactly as they were.
 *
 * Storage class: `ephemeral-file` (docs/STORAGE.md). It is machine-local and
 * fully re-derivable by scanning, which is also why it is excluded from backup:
 * restoring one machine's model inventory onto another describes weights that
 * machine does not have.
 */

import { join } from 'path';
import { createCachedStore, PATHS } from '../lib/fileUtils.js';
import {
  MODEL_INVENTORY_BACKENDS,
  modelInventoryId,
  presentInventoryRow,
} from '../lib/modelInventory.js';

const MODEL_MANIFEST_SCHEMA_VERSION = 1;

const EMPTY_MANIFEST = { schemaVersion: MODEL_MANIFEST_SCHEMA_VERSION, reconciledAt: null, models: {} };

/**
 * The shared single-JSON-document store: one write tail, a short read cache, and
 * — the part that matters here — a STRICT load.
 *
 * `mutate` is load → modify → persist, so a present-but-unreadable manifest must
 * reject rather than read as "no models installed": the very next write would
 * otherwise stamp that emptiness over the record. An ABSENT file still yields the
 * default, which is the pre-first-install state and the state of every install
 * upgrading into this feature.
 *
 * The single tail matters because the writers genuinely overlap — a reconcile
 * walks four backends while a queued LM Studio download finishes and records
 * itself — and this module is the only writer of the file.
 *
 * Built on FIRST USE rather than at module load. The install chokepoints import
 * this module, so it is reached transitively by a long tail of suites that mock
 * `fileUtils.js` partially — and constructing the store in module scope turns a
 * missing mock export into an import-time crash in a file that has nothing to do
 * with models. Lazily, the same suites simply never touch it.
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
 * `fn` returns `{ document, value }`, where a null `document` leaves the file
 * untouched and `value` is what the caller wanted to learn from the write — the
 * counts a reconcile produced, or whether an entry was really there to remove.
 * The value rides out of the mutation rather than being decoded from the persisted
 * document, which cannot distinguish "wrote nothing because nothing changed" from
 * "wrote nothing because the write failed".
 *
 * Every mutator is best-effort: a failed write logs and yields `fallback` rather
 * than failing the install or delete that triggered it.
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
 * Residency, and whether the on-disk folder could be verified, are LIVE facts a
 * stored row can never answer — `presentInventoryRow` re-derives them on read, so
 * changing that rule fixes every existing row instead of only newly written ones.
 * `key` is not stored either: it is the second half of `id` by construction.
 *
 * `installedAt` + `source` are the pair the page renders. `source` matters because
 * a row adopted by the first reconcile has an `installedAt` of "when we first
 * looked", not when the weights actually landed — the UI says "tracked since"
 * for those and "installed" for the ones PortOS performed itself.
 */
function storedEntry(row, { installedAt, source }) {
  const entry = { id: row.id, backend: row.backend, installedAt, source };
  for (const field of ['name', 'detail', 'sizeBytes', 'risk', 'cleanupReason', 'managePath', 'action']) {
    if (row[field] != null) entry[field] = row[field];
  }
  if (row.sizeIsEstimate) entry.sizeIsEstimate = true;
  return entry;
}

/**
 * The manifest as the API and the Status page consume it: rows sorted largest
 * first, matching the scan's own ordering so the two views do not reshuffle.
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
 * Idempotent on re-install: the original `installedAt` and `source` survive a
 * re-download, so a repair pass over a corrupt shard does not make a year-old
 * model look newly installed.
 *
 * @param {Object} row An inventory row from `lib/modelInventory.js`'s builders
 * @param {string} [row.source] How PortOS learned about it ('install' by default)
 * @returns {Promise<boolean>} Whether the manifest now holds the entry
 */
export function recordModelInstall({ source = 'install', ...row } = {}) {
  // Guards the whole contract, not just a typo: a row builder answers `id: null`
  // for a backend or key it could not use, and this function promises never to
  // fail the install it is describing.
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
 * A disabled or unreachable backend contributes zero rows, which is
 * indistinguishable from "you have no models there" — and acting on that reading
 * would delete a correct manifest. The scan's own `sourceErrors` / `disabledSources`
 * are the honest signal, so the mapping from those ids to backends lives here next
 * to the pruning that depends on it. A *residency* probe failure is deliberately
 * not disqualifying: it says nothing about what is on disk.
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
  for (const backend of ['ollama', 'lmstudio']) {
    if (disabled.has(backend) || failed.has(`${backend}-backend`) || failed.has(`${backend}-inventory`)) {
      trusted.delete(backend);
    }
  }
  return trusted;
}

/**
 * Fold a real disk scan back into the manifest.
 *
 * Adopts rows PortOS never saw installed (weights pulled by another tool, or by a
 * PortOS old enough to predate this manifest) and drops rows whose files are gone
 * (deleted outside the app). Both directions are scoped to the backends the scan
 * could see — see `trustedInventoryBackends`.
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
    // A row the backend listed but whose on-disk folder could not be verified is
    // not evidence of anything: it must neither be adopted as a tracked install
    // NOR counted as absent when pruning. Those are two separate exclusions, and
    // filtering such a row out of `scanned` alone only buys the first — it makes
    // the row look like it was never reported at all, so the pruning loop reads a
    // model the backend positively listed as deleted and drops its manifest entry.
    // `unverified` is what keeps the second half: the id was seen, just not
    // corroborated on disk, so the existing row stands unchanged.
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
      // A row PortOS installed itself keeps its real install date and provenance;
      // one the scan found first is dated "when we first looked", which is what
      // `source: 'scan'` tells the page so it does not claim a year-old model was
      // installed this afternoon.
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
