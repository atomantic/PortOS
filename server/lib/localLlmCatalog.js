// Curated cross-backend catalog of popular local LLMs.
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

export const BACKENDS = ['ollama', 'lmstudio'];

export const isBackend = (b) => BACKENDS.includes(b);

// Each entry: { key, name, params, size, family, description, capabilities,
//               ollama?, lmstudio? }
// `ollama` / `lmstudio` are the exact pull/download ids for that backend.
// A missing id means there is no well-known build of that model for that
// backend (the user can still free-text install one).
export const LOCAL_LLM_CATALOG = [
  {
    key: 'llama3.2',
    name: 'Llama 3.2 3B',
    params: '3B',
    size: '2.0 GB',
    family: 'llama',
    description: "Meta's compact general-purpose chat model. Fast on most machines.",
    capabilities: ['chat', 'tools'],
    ollama: 'llama3.2',
    lmstudio: 'lmstudio-community/Llama-3.2-3B-Instruct-GGUF'
  },
  {
    key: 'llama3.1',
    name: 'Llama 3.1 8B',
    params: '8B',
    size: '4.7 GB',
    family: 'llama',
    description: "Meta's mid-size instruct model — a solid general default.",
    capabilities: ['chat', 'tools'],
    ollama: 'llama3.1',
    lmstudio: 'lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF'
  },
  {
    key: 'qwen2.5',
    name: 'Qwen2.5 7B',
    params: '7B',
    size: '4.7 GB',
    family: 'qwen',
    description: "Alibaba's strong multilingual instruct model with good tool use.",
    capabilities: ['chat', 'tools'],
    ollama: 'qwen2.5',
    lmstudio: 'lmstudio-community/Qwen2.5-7B-Instruct-GGUF'
  },
  {
    key: 'qwen2.5-coder',
    name: 'Qwen2.5 Coder 7B',
    params: '7B',
    size: '4.7 GB',
    family: 'qwen',
    description: 'Code-specialised Qwen2.5 — strong at completion and refactors.',
    capabilities: ['chat', 'code'],
    ollama: 'qwen2.5-coder',
    lmstudio: 'lmstudio-community/Qwen2.5-Coder-7B-Instruct-GGUF'
  },
  {
    key: 'mistral',
    name: 'Mistral 7B',
    params: '7B',
    size: '4.1 GB',
    family: 'mistral',
    description: 'Fast, capable 7B instruct model that runs well on modest GPUs.',
    capabilities: ['chat'],
    ollama: 'mistral',
    lmstudio: 'lmstudio-community/Mistral-7B-Instruct-v0.3-GGUF'
  },
  {
    key: 'gemma2',
    name: 'Gemma 2 9B',
    params: '9B',
    size: '5.4 GB',
    family: 'gemma',
    description: "Google's Gemma 2 instruct model — strong reasoning for its size.",
    capabilities: ['chat'],
    ollama: 'gemma2',
    lmstudio: 'lmstudio-community/gemma-2-9b-it-GGUF'
  },
  {
    key: 'phi3',
    name: 'Phi-3 Mini',
    params: '3.8B',
    size: '2.3 GB',
    family: 'phi',
    description: "Microsoft's small-but-capable model with a long context window.",
    capabilities: ['chat'],
    ollama: 'phi3',
    lmstudio: 'lmstudio-community/Phi-3.1-mini-128k-instruct-GGUF'
  },
  {
    key: 'deepseek-r1',
    name: 'DeepSeek-R1 Distill 7B',
    params: '7B',
    size: '4.7 GB',
    family: 'deepseek',
    description: 'Reasoning-tuned distill — good local "thinking" model.',
    capabilities: ['chat', 'reasoning'],
    ollama: 'deepseek-r1',
    lmstudio: 'lmstudio-community/DeepSeek-R1-Distill-Qwen-7B-GGUF'
  },
  {
    key: 'gpt-oss-20b',
    name: 'GPT-OSS 20B',
    params: '20B',
    size: '12 GB',
    family: 'gpt-oss',
    description: 'Open-weights 20B model — the default local thinking model.',
    capabilities: ['chat', 'reasoning'],
    ollama: 'gpt-oss:20b',
    lmstudio: 'lmstudio-community/gpt-oss-20b-GGUF'
  },
  {
    key: 'llava',
    name: 'LLaVA 7B (vision)',
    params: '7B',
    size: '4.5 GB',
    family: 'llava',
    description: 'Vision-language model — answers questions about images.',
    capabilities: ['chat', 'vision'],
    ollama: 'llava',
    lmstudio: 'lmstudio-community/llava-v1.5-7b-GGUF'
  },
  {
    key: 'codellama',
    name: 'Code Llama 7B',
    params: '7B',
    size: '3.8 GB',
    family: 'llama',
    description: "Meta's code-specialised Llama for completion and infilling.",
    capabilities: ['chat', 'code'],
    ollama: 'codellama',
    lmstudio: 'lmstudio-community/CodeLlama-7b-Instruct-GGUF'
  },
  {
    key: 'smollm2',
    name: 'SmolLM2 1.7B',
    params: '1.7B',
    size: '1.1 GB',
    family: 'smollm',
    description: 'Tiny, fast model for quick classification and routing tasks.',
    capabilities: ['chat'],
    ollama: 'smollm2',
    lmstudio: 'lmstudio-community/SmolLM2-1.7B-Instruct-GGUF'
  },
  {
    key: 'nomic-embed-text',
    name: 'Nomic Embed Text',
    params: '137M',
    size: '274 MB',
    family: 'embedding',
    description: 'Text embedding model for semantic search / memory recall.',
    capabilities: ['embeddings'],
    ollama: 'nomic-embed-text',
    lmstudio: 'nomic-ai/nomic-embed-text-v1.5-GGUF'
  }
];

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

const normalizeFor = (backend, id) =>
  backend === 'ollama' ? normalizeOllamaId(id) : normalizeLmStudioId(id);

/**
 * Return the catalog projected onto a single backend: only entries that ship
 * a known build for `backend`, each with the backend-specific install id
 * surfaced as `id`. Pure — pass installed ids to overlay an `installed` flag.
 *
 * @param {string} backend - 'ollama' | 'lmstudio'
 * @param {string[]} [installedIds] - ids currently installed on that backend
 * @returns {Array<{ id, key, name, params, size, family, description, capabilities, installed }>}
 */
export function getCatalog(backend, installedIds = []) {
  if (!isBackend(backend)) return [];
  const installedNorm = new Set(installedIds.map((id) => normalizeFor(backend, id)));
  return LOCAL_LLM_CATALOG
    .filter((entry) => entry[backend])
    .map((entry) => ({
      id: entry[backend],
      key: entry.key,
      name: entry.name,
      params: entry.params,
      size: entry.size,
      family: entry.family,
      description: entry.description,
      capabilities: entry.capabilities,
      installed: installedNorm.has(normalizeFor(backend, entry[backend]))
    }));
}

/**
 * Filter the per-backend catalog by a free-text query against name, id,
 * family, and description. Empty query returns the full catalog.
 */
export function searchCatalog(backend, query, installedIds = []) {
  const all = getCatalog(backend, installedIds);
  const q = String(query || '').trim().toLowerCase();
  if (!q) return all;
  return all.filter((m) =>
    m.name.toLowerCase().includes(q) ||
    m.id.toLowerCase().includes(q) ||
    m.family.toLowerCase().includes(q) ||
    m.description.toLowerCase().includes(q));
}

/**
 * Map an installed model id on `fromBackend` to the equivalent install id on
 * `toBackend`, used by the migrate flow.
 *
 * Returns `{ targetId, exact }`:
 * - `exact: true`  — a curated catalog entry matched and the target build is known.
 * - `exact: false` — best-effort derived name (only when the target is Ollama,
 *   which can pull bare model names); `targetId` is null when no reasonable
 *   guess exists (e.g. mapping an unknown model TO LM Studio needs a HF repo).
 */
export function mapModelToBackend(fromBackend, modelId, toBackend) {
  if (!isBackend(fromBackend) || !isBackend(toBackend) || fromBackend === toBackend) {
    return { targetId: null, exact: false };
  }
  const fromNorm = normalizeFor(fromBackend, modelId);
  const entry = LOCAL_LLM_CATALOG.find(
    (e) => e[fromBackend] && normalizeFor(fromBackend, e[fromBackend]) === fromNorm
  );
  if (entry && entry[toBackend]) {
    return { targetId: entry[toBackend], exact: true };
  }

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
