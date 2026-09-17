/**
 * The identity and durable shape of a downloaded-model inventory row.
 *
 * A row is addressed as `<prefix>:<key>`, where the key is the backend's OWN
 * identifier for the weights — a Hugging Face cache directory (`models--org--repo`),
 * a LoRA filename, an Ollama tag, an LM Studio model id. That pairing is what lets
 * a scan row, a persisted manifest entry, and a delete action refer to the same
 * thing: the id is stable across a rescan because the backend key is, and the
 * delete action can be reconstructed from the two halves.
 *
 * Both halves of the scheme carry a separator that also appears inside the
 * payload — an Ollama tag is `qwen3:8b`, an LM Studio id is `org/repo` — so the
 * split and the join are written once, here, rather than as templates at each
 * site.
 *
 * **Why the row BUILDERS live here too.** The same four row shapes are produced
 * from two directions: `services/systemResources.js` mints them from a disk scan,
 * and `services/modelManifest.js` records them from the install chokepoints, which
 * never run a scan. A second copy of a row's `risk`, `managePath`, `action` or
 * cleanup sentence is not a cosmetic duplication — the manifest row is rendered by
 * the same component and armed by the same `modelCleanupCandidates`, so a drifted
 * copy is a delete button pointed at the wrong place, or a one-click delete on
 * weights the scan would have refused to arm.
 *
 * Pure and dependency-free, so the install services can reach the builders without
 * pulling the scan's module graph (Ollama, LM Studio, the HF cache, the data
 * manager) into their own.
 */

/** Backends whose downloaded weights PortOS inventories. */
export const MODEL_INVENTORY_BACKENDS = ['huggingface', 'lora', 'ollama', 'lmstudio'];

// The on-the-wire prefix per backend. `huggingface` shortens to `hf` for the same
// reason the cache directories do — it is the longest of the four and appears in
// every row id.
const BACKEND_PREFIX = {
  huggingface: 'hf',
  lora: 'lora',
  ollama: 'ollama',
  lmstudio: 'lmstudio',
};

const PREFIX_BACKEND = new Map(Object.entries(BACKEND_PREFIX).map(([backend, prefix]) => [prefix, backend]));

/**
 * The inventory id for a model, or null when the backend or key is not usable.
 *
 * Returning null rather than throwing is deliberate: the callers are recording a
 * side effect of an install that already succeeded, and a manifest entry is worth
 * less than the install it describes.
 *
 * @param {string} backend One of MODEL_INVENTORY_BACKENDS
 * @param {string} key The backend's own identifier for the weights
 * @returns {string|null}
 */
export function modelInventoryId(backend, key) {
  const prefix = BACKEND_PREFIX[backend];
  const trimmed = typeof key === 'string' ? key.trim() : '';
  if (!prefix || !trimmed) return null;
  return `${prefix}:${trimmed}`;
}

/**
 * Split an inventory id back into `{ backend, key }`, or null when it is not one.
 *
 * Splits on the FIRST colon only — an Ollama tag (`qwen3:8b`) contains colons of
 * its own, so a greedy split would truncate the key the delete action needs.
 *
 * @param {string} id
 * @returns {{ backend: string, key: string }|null}
 */
export function parseModelInventoryId(id) {
  if (typeof id !== 'string') return null;
  const separator = id.indexOf(':');
  if (separator <= 0) return null;
  const backend = PREFIX_BACKEND.get(id.slice(0, separator));
  const key = id.slice(separator + 1);
  return backend && key ? { backend, key } : null;
}

/**
 * A downloaded Hugging Face repo, addressed by its cache directory name.
 *
 * `dirName` rather than the repo string, because that is what the scan reads off
 * disk and what `DELETE /image-video/models/hf/:dirName` takes. Callers holding a
 * repo id convert with `repoToDirName` (`lib/hfCache.js`), which owns the Hub's
 * layout rule.
 */
export const hfInventoryRow = ({ dirName, name, detail, sizeBytes, sizeIsEstimate = false }) => ({
  id: modelInventoryId('huggingface', dirName),
  backend: 'huggingface',
  name: name || dirName,
  detail: detail || null,
  sizeBytes,
  sizeIsEstimate,
  managePath: '/models/media',
  action: { type: 'hf-model', dirName },
});

/** A LoRA adapter in `data/loras/`. High risk: it may be the only copy in existence. */
export const loraInventoryRow = ({ filename, name, sizeBytes }) => ({
  id: modelInventoryId('lora', filename),
  backend: 'lora',
  name: name || filename,
  detail: 'LoRA adapter',
  sizeBytes,
  sizeIsEstimate: false,
  risk: 'high',
  cleanupReason: 'A trained or imported LoRA adapter may be the only copy and can take hours to reproduce.',
  managePath: '/models/loras',
  action: { type: 'lora', filename },
});

/**
 * An Ollama tag or an LM Studio model folder.
 *
 * Ollama sizes are upper-bound estimates because tags share underlying layers, so
 * deleting one reclaims less than its displayed size — the inventory renders that
 * with a `≈`. Deleting an LM Studio entry takes the whole repo folder with it,
 * which is why that one carries a cleanup warning and Ollama does not.
 *
 * `action` is nullable: a backend that is not available cannot be asked to delete.
 */
export const localModelInventoryRow = ({ backend, modelId, name, detail, sizeBytes, deletable = true }) => ({
  id: modelInventoryId(backend, modelId),
  backend,
  name: name || modelId,
  detail: detail || null,
  sizeBytes,
  sizeIsEstimate: backend === 'ollama',
  cleanupReason: backend === 'lmstudio'
    ? 'Deleting this entry removes the whole LM Studio model folder, including every downloaded quantization in it.'
    : null,
  managePath: '/models/llms',
  action: deletable ? { type: 'local-model', backend, modelId } : null,
});

/**
 * Apply the LIVE facts to a stored row on read.
 *
 * Residency, and whether the on-disk folder could be verified, are answers only a
 * running backend can give — a manifest read knows the weights were on disk, never
 * whether they are resident right now. Local backends therefore present as
 * "residency unknown", which the Status panel overrides the moment its residency
 * probe reports, and which keeps a one-click delete off a row nobody has verified
 * is unloaded. Deriving it here rather than storing it means changing the rule
 * fixes every existing row, not just newly written ones.
 *
 * @param {Object} entry A stored manifest entry
 * @returns {Object} The entry as the inventory renders it
 */
export const presentInventoryRow = (entry) => ({
  ...entry,
  loaded: false,
  residencyUnknown: entry.backend === 'ollama' || entry.backend === 'lmstudio',
  inventoryUnknown: false,
});
