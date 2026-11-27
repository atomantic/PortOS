// Curated cross-backend catalog of popular local LLMs.
//
// Curated cross-backend (Ollama↔LM Studio) local-LLM catalog + install-id mapping for the migrate
// flow. Pure.
//
// PortOS supports two local-LLM backends — Ollama (content-addressed blob
// store) and LM Studio (plain GGUF files). Their model identifiers differ
// (`llama3.2` vs `lmstudio-community/Llama-3.2-3B-Instruct-GGUF`). The GGUF
// weights themselves ARE portable; only the on-disk layout differs, so the
// migrate flow copies the weights across locally when it can (see
// `localLlmDisk.js`) and re-pulls the equivalent only when it can't. This
// catalog is the mapping table that makes both the in-UI install picker and
// the migrate re-pull fallback work without guessing: each entry carries the
// canonical id for whichever backend(s) ship a well-known build of that model.
//
// This module is pure (no I/O, no network) so it can be unit-tested and
// imported anywhere. The installed-state overlay is applied by the caller
// (server/services/localLlm.js) which knows what's actually on disk.

import { localModelSafety } from './localModelSafety.js';
import { hardwareRequirementsForLocalLlm } from './systemCapabilities.js';

import { BACKENDS, LOCAL_LLM_CATALOG, RETIRED_MODEL_MAPPINGS } from './localLlmCatalogData.js';
export { BACKENDS, LOCAL_LLM_CATALOG, LOCAL_LLM_CATEGORIES, RETIRED_MODEL_MAPPINGS } from './localLlmCatalogData.js';

export const isBackend = (b) => BACKENDS.includes(b);

// Strip only the implicit `:latest` tag (`llama3.2:latest` → `llama3.2`) and
// lowercase. Meaningful tags (`gpt-oss:20b`, `qwen2.5:7b`) are preserved so a
// `7b` build can't normalize onto — and be mistaken for — a `20b` catalog entry.
const normalizeOllamaId = (id) =>
  String(id || '').trim().toLowerCase().replace(/:latest$/, '');

// Reduce an LM Studio / HuggingFace id to a comparable stem:
// `lmstudio-community/Llama-3.2-3B-Instruct-GGUF` → `llama-3.2-3b-instruct`.
const normalizeLmStudioId = (id) => String(id || '')
  .split('/').pop()
  .trim()
  .toLowerCase()
  .replace(/[-.]gguf$/i, '');

/**
 * Reduce an install id to the stem this backend compares by. Exported because
 * matching "is this pulled model that catalog entry?" must use the SAME
 * normalization the catalog itself does; a second, looser copy is how a 7b
 * build gets mistaken for a 20b entry.
 */
export const normalizeBackendModelId = (backend, id) =>
  backend === 'ollama' ? normalizeOllamaId(id) : normalizeLmStudioId(id);

const normalizeFor = normalizeBackendModelId;

/**
 * Every install id one catalog entry is recognized by on `backend` — the
 * current one plus the aliases a publisher retired. Callers that need to know
 * "which ids name this model" (scope mapping, installed-state matching) must
 * use this rather than reading `entry[backend]`, or an install that pulled the
 * model under its old id goes unrecognized.
 */
export const entryIdsForBackend = (entry, backend) => [
  entry[backend],
  ...(Array.isArray(entry[`${backend}Aliases`]) ? entry[`${backend}Aliases`] : [])
].filter(Boolean);

const entryMatchesBackendId = (entry, backend, normalizedId) =>
  entryIdsForBackend(entry, backend).some((id) => normalizeFor(backend, id) === normalizedId);

const SIZE_UNIT_BYTES = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };

/** Parse a catalog `size` string ('4.9 GB', '301 MB') to bytes; 0 if unparseable. */
const parseCatalogSizeBytes = (size) => {
  const match = /^([\d.]+)\s*(KB|MB|GB|TB)$/i.exec(String(size || '').trim());
  if (!match) return 0;
  return Math.round(Number(match[1]) * SIZE_UNIT_BYTES[match[2].toUpperCase()]);
};

/**
 * Bytes for a curated catalog entry's advertised download size, resolved by
 * the backend-specific install id (matched the same alias-aware way
 * `getOllamaImportSpec`/`getCatalog` match ids). 0 for an unrecognized id or
 * an entry whose `size` string doesn't parse — the disk preflight already
 * treats 0 as "unknown, never refuse," so a miss here fails open rather than
 * blocking an install PortOS just can't size.
 */
export function catalogSizeBytes(backend, modelId) {
  if (!isBackend(backend)) return 0;
  const normalizedId = normalizeFor(backend, modelId);
  const entry = LOCAL_LLM_CATALOG.find((candidate) => (
    candidate[backend] && entryMatchesBackendId(candidate, backend, normalizedId)
  ));
  return entry ? parseCatalogSizeBytes(entry.size) : 0;
}

/**
 * Return the trusted local-Safetensors import recipe for a curated Ollama id.
 * Unknown/free-text ids return null and continue through the normal pull path.
 */
export function getOllamaImportSpec(modelId) {
  const normalizedId = normalizeOllamaId(modelId);
  const entry = LOCAL_LLM_CATALOG.find((candidate) => (
    candidate.ollamaImport && entryMatchesBackendId(candidate, 'ollama', normalizedId)
  ));
  return entry ? { modelId: entry.ollama, ...entry.ollamaImport } : null;
}

/**
 * Return the catalog projected onto a single backend: only entries that ship
 * a known build for `backend`, each with the backend-specific install id
 * surfaced as `id`. Pure — pass installed ids to overlay an `installed` flag.
 *
 * @param {string} backend - 'ollama' | 'lmstudio'
 * @param {string[]} [installedIds] - ids currently installed on that backend
 * @param {{ appleSilicon?: boolean }} [options] - host capabilities used for platform-gated entries
 * @returns {Array<{ id, key, name, category, recommendedFor, featured, params, size, family, description, note, repository, gated, capabilities, format, hardwareRequirements, contextLength, installed }>}
 */
export function getCatalog(backend, installedIds = [], { appleSilicon } = {}) {
  if (!isBackend(backend)) return [];
  const installedNorm = new Set(installedIds.map((id) => normalizeFor(backend, id)));
  return LOCAL_LLM_CATALOG
    .filter((entry) => entry[backend] && (!entry.appleSiliconOnly || appleSilicon !== false))
    .map((entry) => {
      const recommendedFor = Array.isArray(entry.recommendedFor) && entry.recommendedFor.length
        ? [...entry.recommendedFor]
        : [entry.category];
      return {
        ...localModelSafety(entry.repository || entry.lmstudio || entry[backend]),
        id: entry[backend],
        key: entry.key,
        name: entry.name,
        category: entry.category,
        recommendedFor,
        featured: entry.featured ? { ...entry.featured } : null,
        params: entry.params,
        size: entry.size,
        family: entry.family,
        description: entry.description,
        note: entry.note || null,
        repository: entry.repository || null,
        gated: entry.gated === true,
        capabilities: entry.capabilities,
        format: entry.format || null,
        hardwareRequirements: hardwareRequirementsForLocalLlm(entry),
        // Native context window (tokens), when it's a documented spec; null otherwise.
        contextLength: Number.isFinite(entry.context) ? entry.context : null,
        installed: entryIdsForBackend(entry, backend)
          .some((id) => installedNorm.has(normalizeFor(backend, id)))
      };
    });
}

/**
 * Filter the per-backend catalog by a free-text query against name, id,
 * family, category, and description. Empty query returns the full catalog.
 */
export function searchCatalog(backend, query, installedIds = [], options = {}) {
  const all = getCatalog(backend, installedIds, options);
  const q = String(query || '').trim().toLowerCase();
  if (!q) return all;
  return all.filter((m) =>
    m.name.toLowerCase().includes(q) ||
    m.id.toLowerCase().includes(q) ||
    m.category.toLowerCase().includes(q) ||
    m.recommendedFor.some((category) => category.toLowerCase().includes(q)) ||
    m.family.toLowerCase().includes(q) ||
    m.capabilities.some((capability) => capability.toLowerCase().includes(q)) ||
    m.description.toLowerCase().includes(q));
}

/**
 * Map an installed model id on `fromBackend` to the equivalent install id on
 * `toBackend`, used by the migrate flow.
 *
 * Returns `{ targetId, exact }`:
 * - `exact: true`  — a curated (or retired-but-still-mapped) catalog entry
 *   matched and the target build is known.
 * - `exact: false` — best-effort derived name (only when the target is Ollama,
 *   which can pull bare model names); `targetId` is null when no reasonable
 *   guess exists (e.g. mapping an unknown model TO LM Studio needs a HF repo).
 */
export function mapModelToBackend(fromBackend, modelId, toBackend) {
  if (!isBackend(fromBackend) || !isBackend(toBackend) || fromBackend === toBackend) {
    return { targetId: null, exact: false };
  }
  const fromNorm = normalizeFor(fromBackend, modelId);
  // Suggested models first, then models retired from the picker — an install
  // that predates a catalog refresh still migrates exactly.
  const entry = [...LOCAL_LLM_CATALOG, ...RETIRED_MODEL_MAPPINGS].find(
    (e) => entryMatchesBackendId(e, fromBackend, fromNorm)
  );
  if (entry && entry[toBackend]) {
    return { targetId: entry[toBackend], exact: true };
  }
  // A known catalog entry without a build on the target backend is not an
  // unknown model: do not turn a native-format id (for example an MLX repo)
  // into a misleading best-effort Ollama stem.
  if (entry) return { targetId: null, exact: false };

  // No catalog match. Ollama can pull bare model names, so derive a stem and
  // try it best-effort. There's no safe way to guess a HuggingFace repo for
  // LM Studio, so bail with null and let the caller report the skip.
  if (toBackend === 'ollama') {
    const stem = fromBackend === 'lmstudio'
      ? normalizeLmStudioId(modelId).replace(/-instruct.*$/i, '').replace(/-\d+b.*$/i, '')
      : normalizeOllamaId(modelId);
    return { targetId: stem || null, exact: false };
  }
  return { targetId: null, exact: false };
}
