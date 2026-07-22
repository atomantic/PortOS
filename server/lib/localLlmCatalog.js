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

export const LOCAL_LLM_CATEGORIES = [
  { id: 'chat', label: 'Chat' },
  { id: 'reasoning', label: 'Reasoning' },
  { id: 'coding', label: 'Coding' },
  { id: 'vision', label: 'Image Analysis' },
  // Audio/music GENERATION models (ACE-Step, MusicGen, AudioLDM2, Stable Audio,
  // Magenta…). These are NOT GGUF chat models and don't run on Ollama/LM Studio
  // — the Hugging Face search relaxes its GGUF filter for this category and the
  // installer routes audio installs into the shared audio-model registry
  // (server/services/audioModels.js) so the Music studio picks them up. The
  // curated `LOCAL_LLM_CATALOG` below never tags entries 'audio'; this category
  // is populated live from the Hub.
  { id: 'audio', label: 'Audio & Music' },
  { id: 'embedding', label: 'Text Embeddings' },
  { id: 'lightweight', label: 'Small & Fast' },
  { id: 'multilingual', label: 'Multilingual' }
];

// Each entry: { key, name, category, params, size, family, description, capabilities,
//               context?, ollama?, lmstudio? }
// `ollama` / `lmstudio` are the exact pull/download ids for that backend.
// A missing id means there is no well-known build of that model for that
// backend (the user can still free-text install one).
// `context` is the model's native context window in tokens — set it only when
// it's a documented spec for that build (the install-card badge shows it; live
// Hugging Face results read the true value from GGUF metadata instead).
export const LOCAL_LLM_CATALOG = [
  {
    key: 'llama3.2',
    name: 'Llama 3.2 3B',
    category: 'chat',
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
    category: 'chat',
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
    category: 'multilingual',
    params: '7B',
    size: '4.7 GB',
    family: 'qwen',
    description: "Alibaba's strong multilingual instruct model with good tool use.",
    capabilities: ['chat', 'tools'],
    ollama: 'qwen2.5',
    lmstudio: 'lmstudio-community/Qwen2.5-7B-Instruct-GGUF'
  },
  {
    key: 'qwen2.5-3b',
    name: 'Qwen2.5 3B',
    category: 'lightweight',
    params: '3B',
    size: '2.0 GB',
    family: 'qwen',
    description: 'Compact Qwen2.5 instruct model with solid tool use and no "thinking" delay — a fast, low-memory tool-calling brain for the voice agent.',
    capabilities: ['chat', 'tools', 'multilingual'],
    // hf.co/…-Instruct id (like the other 2507/instruct cards) so the model id
    // reported by the backend carries the "instruct" token the voice
    // tool-capability detector keys on — a bare `qwen2.5:3b` tag would not.
    ollama: 'hf.co/lmstudio-community/Qwen2.5-3B-Instruct-GGUF:Q4_K_M',
    lmstudio: 'lmstudio-community/Qwen2.5-3B-Instruct-GGUF'
  },
  {
    key: 'hermes-3-llama-3.1-8b',
    name: 'Hermes 3 8B',
    category: 'chat',
    params: '8B',
    size: '4.9 GB',
    family: 'hermes',
    description: 'NousResearch Hermes 3 (Llama 3.1 8B) — tuned for reliable function-calling and structured tool use, with no "thinking" delay. A robust pick for the voice agent\'s tool turns.',
    capabilities: ['chat', 'tools'],
    ollama: 'hermes3',
    lmstudio: 'NousResearch/Hermes-3-Llama-3.1-8B-GGUF'
  },
  {
    key: 'qwen3.6-35b-a3b',
    name: 'Qwen3.6 35B-A3B',
    category: 'coding',
    params: '35B / 3B active',
    size: '24 GB',
    family: 'qwen',
    description: 'Current Qwen coding model with agentic coding, repository reasoning, vision, and tool-use upgrades.',
    capabilities: ['chat', 'code', 'tools', 'vision'],
    ollama: 'qwen3.6:35b',
    lmstudio: 'unsloth/Qwen3.6-35B-A3B-GGUF'
  },
  {
    key: 'nex-n2-mini',
    name: 'Nex-N2-mini 35B-A3B',
    category: 'coding',
    params: '35B / 3B active',
    size: '22 GB',
    family: 'nex-n2',
    description: "Nex AGI's agentic MoE (3B active) on a Qwen3.5 base — strong at coding, tool calling, long-horizon agent tasks, and vision (75.3 Terminal-Bench 2.1). Apache-2.0; the Q4 build fits comfortably on 32GB+ and is easy on a 128GB Mac. Vision needs the repo's mmproj file. The 397B Nex-N2-Pro is the big sibling — it won't fit a 128GB Mac even at Q4.",
    capabilities: ['chat', 'code', 'tools', 'reasoning', 'vision'],
    ollama: 'hf.co/sjakek/Nex-N2-mini-GGUF:UD-Q4_K_M',
    lmstudio: 'sjakek/Nex-N2-mini-GGUF'
  },
  {
    key: 'btl-3-compact',
    name: 'BTL-3 Compact 27B',
    category: 'coding',
    params: '27B',
    size: '8.4 GB',
    family: 'btl-3',
    description: 'BadTheoryLabs agentic coding model distilled from Qwen3.6-27B into a single custom-quant GGUF — built for local repo/terminal agents and structured tool use on modest hardware. The repo ships one non-standard quant (AVQ2, not a llama.cpp Q-scheme), so the install id is the bare repo and the backend resolves the single file itself; no per-quant tag is available.',
    capabilities: ['chat', 'code', 'tools'],
    context: 262144,
    ollama: 'hf.co/badtheorylabs/BTL-3-Compact',
    lmstudio: 'badtheorylabs/BTL-3-Compact'
  },
  // ── Large narrative / long-context tier (workstation-class: 64–128GB unified memory) ──
  // Best suited for whole-manuscript editorial review, where prose quality and a
  // long context window matter most. To actually fit the manuscript, raise Ollama's
  // context window (OLLAMA_CONTEXT_LENGTH) — the default 4K window silently truncates.
  {
    key: 'mistral-large',
    name: 'Mistral Large 2 123B',
    category: 'chat',
    params: '123B',
    size: '73 GB',
    family: 'mistral',
    description: 'Top-tier open-weight prose model with a 128K context window — best local pick for long-form narrative and editorial review. Needs ~96GB+ unified memory.',
    capabilities: ['chat', 'tools'],
    context: 131072,
    ollama: 'mistral-large:123b'
  },
  {
    key: 'command-r-plus',
    name: 'Command R+ 104B',
    category: 'chat',
    params: '104B',
    size: '59 GB',
    family: 'command-r',
    description: 'Cohere long-context model (128K) tuned for RAG and clean character-voice dialogue — strong for whole-manuscript continuity passes. Needs ~80GB+ unified memory.',
    capabilities: ['chat', 'tools', 'multilingual'],
    context: 131072,
    ollama: 'command-r-plus:104b'
  },
  {
    key: 'llama3.3',
    name: 'Llama 3.3 70B',
    category: 'chat',
    params: '70B',
    size: '43 GB',
    family: 'llama',
    description: "Meta's 70B instruct model with a 128K context — excellent narrative quality with memory headroom to spare for a large context window. Runs on 64GB+.",
    capabilities: ['chat', 'tools'],
    context: 131072,
    ollama: 'llama3.3:70b',
    lmstudio: 'lmstudio-community/Llama-3.3-70B-Instruct-GGUF'
  },
  {
    key: 'qwen3-30b-a3b',
    name: 'Qwen3 30B-A3B',
    category: 'chat',
    params: '30B / 3B active',
    size: '19 GB',
    family: 'qwen',
    description: 'Fast MoE with a native 256K context — the long-context workhorse for one-shot whole-manuscript review when you want maximum context with memory to spare.',
    capabilities: ['chat', 'tools', 'multilingual'],
    context: 262144,
    ollama: 'qwen3:30b',
    lmstudio: 'lmstudio-community/Qwen3-30B-A3B-GGUF'
  },
  {
    key: 'gemma4-31b',
    name: 'Gemma 4 31B',
    category: 'chat',
    params: '31B',
    size: '20 GB',
    family: 'gemma',
    description: "Google's dense 31B with a 256K context window and vision — a strong long-context narrative editor that fits comfortably on 64GB+. MLX build on Apple Silicon: gemma4:31b-mlx.",
    capabilities: ['chat', 'vision'],
    context: 262144,
    ollama: 'gemma4:31b',
    lmstudio: 'lmstudio-community/gemma-4-31B-it-GGUF'
  },
  {
    key: 'gemma4-26b-a4b',
    name: 'Gemma 4 26B-A4B',
    category: 'chat',
    params: '26B / 4B active',
    size: '18 GB',
    family: 'gemma',
    description: "Google's MoE (4B active) with a 256K context window and vision — a fast long-context option for one-shot whole-manuscript review. MLX build on Apple Silicon: gemma4:26b-mlx.",
    capabilities: ['chat', 'vision'],
    context: 262144,
    ollama: 'gemma4:26b',
    lmstudio: 'lmstudio-community/gemma-4-26B-A4B-it-GGUF'
  },
  {
    key: 'mistral',
    name: 'Mistral 7B',
    category: 'chat',
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
    category: 'chat',
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
    category: 'lightweight',
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
    category: 'reasoning',
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
    category: 'reasoning',
    params: '20B',
    size: '12 GB',
    family: 'gpt-oss',
    description: 'Open-weights 20B model — the default local thinking model.',
    capabilities: ['chat', 'reasoning'],
    ollama: 'gpt-oss:20b',
    lmstudio: 'lmstudio-community/gpt-oss-20b-GGUF'
  },
  {
    key: 'qwen2.5-vl-7b',
    name: 'Qwen2.5-VL 7B (vision)',
    category: 'vision',
    params: '7B',
    size: '6.0 GB',
    family: 'qwen',
    description: 'Strong vision-language model — the recommended default for LoRA dataset captioning.',
    capabilities: ['chat', 'vision'],
    ollama: 'qwen2.5vl',
    lmstudio: 'lmstudio-community/Qwen2.5-VL-7B-Instruct-GGUF'
  },
  {
    key: 'qwen2.5-vl-32b',
    name: 'Qwen2.5-VL 32B (vision)',
    category: 'vision',
    params: '32B',
    size: '21 GB',
    family: 'qwen',
    description: 'Larger Qwen2.5-VL for the most detailed image captions — best on high-memory machines.',
    capabilities: ['chat', 'vision'],
    ollama: 'qwen2.5vl:32b',
    lmstudio: 'lmstudio-community/Qwen2.5-VL-32B-Instruct-GGUF'
  },
  {
    key: 'llama3.2-vision',
    name: 'Llama 3.2 Vision 11B',
    category: 'vision',
    params: '11B',
    size: '7.9 GB',
    family: 'llama',
    description: "Meta's vision-language model for image description and captioning.",
    capabilities: ['chat', 'vision'],
    ollama: 'llama3.2-vision'
  },
  {
    key: 'minicpm-v',
    name: 'MiniCPM-V 2.6 8B (vision)',
    category: 'vision',
    params: '8B',
    size: '5.5 GB',
    family: 'minicpm',
    description: 'Efficient vision-language model with strong single-image captioning.',
    capabilities: ['chat', 'vision'],
    ollama: 'minicpm-v',
    lmstudio: 'openbmb/MiniCPM-V-2_6-gguf'
  },
  {
    key: 'moondream',
    name: 'Moondream 1.8B (vision)',
    category: 'vision',
    params: '1.8B',
    size: '1.7 GB',
    family: 'moondream',
    description: 'Tiny, fast vision model for quick captions on modest hardware.',
    capabilities: ['chat', 'vision'],
    ollama: 'moondream'
  },
  {
    key: 'llava',
    name: 'LLaVA 7B (vision)',
    category: 'vision',
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
    category: 'coding',
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
    category: 'lightweight',
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
    category: 'embedding',
    params: '137M',
    size: '274 MB',
    family: 'embedding',
    description: 'Text embedding model for semantic search / memory recall.',
    capabilities: ['embeddings'],
    ollama: 'nomic-embed-text',
    lmstudio: 'nomic-ai/nomic-embed-text-v1.5-GGUF'
  },
  {
    key: 'nomic-embed-text-v2-moe',
    name: 'Nomic Embed Text v2 MoE',
    category: 'embedding',
    params: '0.5B',
    size: '344 MB',
    family: 'embedding',
    description: 'Newer multilingual text-embedding MoE for semantic search and recall.',
    capabilities: ['embeddings', 'multilingual'],
    ollama: 'hf.co/nomic-ai/nomic-embed-text-v2-moe-GGUF:Q4_K_M',
    lmstudio: 'nomic-ai/nomic-embed-text-v2-moe-GGUF'
  },
  {
    key: 'qwen3-4b-instruct-2507',
    name: 'Qwen3 4B Instruct 2507',
    category: 'lightweight',
    params: '4B',
    size: '2.6 GB',
    family: 'qwen',
    description: 'Compact current Qwen3 instruct model for fast local chat and tool workflows.',
    capabilities: ['chat', 'tools', 'multilingual'],
    ollama: 'hf.co/lmstudio-community/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M',
    lmstudio: 'lmstudio-community/Qwen3-4B-Instruct-2507-GGUF'
  },
  {
    key: 'granite-3.2-8b-instruct',
    name: 'Granite 3.2 8B Instruct',
    category: 'reasoning',
    params: '8B',
    size: '4.9 GB',
    family: 'granite',
    description: 'Apache-licensed IBM Granite instruct model with long context and thinking controls.',
    capabilities: ['chat', 'reasoning', 'multilingual'],
    ollama: 'hf.co/lmstudio-community/granite-3.2-8b-instruct-GGUF:Q4_K_M',
    lmstudio: 'lmstudio-community/granite-3.2-8b-instruct-GGUF'
  },
  {
    key: 'gemma-3-270m-it',
    name: 'Gemma 3 270M IT',
    category: 'lightweight',
    params: '270M',
    size: '253 MB',
    family: 'gemma',
    description: 'Tiny instruction model for cheap classification, routing, and quick local utilities.',
    capabilities: ['chat', 'classification'],
    ollama: 'hf.co/lmstudio-community/gemma-3-270m-it-GGUF:Q4_K_M',
    lmstudio: 'lmstudio-community/gemma-3-270m-it-GGUF'
  },
  {
    key: 'ministral-3-14b-instruct-2512',
    name: 'Ministral 3 14B Instruct 2512',
    category: 'reasoning',
    params: '14B',
    size: '8.6 GB',
    family: 'mistral',
    description: 'Current Mistral-family instruct model for strong local reasoning and general work.',
    capabilities: ['chat', 'reasoning', 'tools'],
    ollama: 'hf.co/lmstudio-community/Ministral-3-14B-Instruct-2512-GGUF:Q4_K_M',
    lmstudio: 'lmstudio-community/Ministral-3-14B-Instruct-2512-GGUF'
  },
  {
    key: 'devstral-small-2-24b',
    name: 'Devstral Small 2 24B',
    category: 'coding',
    params: '24B',
    size: '14 GB',
    family: 'mistral',
    description: 'Agentic coding model for repo navigation, edits, and software-engineering tasks.',
    capabilities: ['chat', 'code', 'tools', 'vision'],
    ollama: 'hf.co/unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF:UD-Q4_K_XL',
    lmstudio: 'unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF'
  },
  {
    key: 'glm-4.6v-flash',
    name: 'GLM-4.6V Flash',
    category: 'vision',
    params: 'Vision',
    size: '7.1 GB',
    family: 'glm',
    description: 'MLX vision-language model for image analysis on Apple Silicon.',
    capabilities: ['chat', 'vision'],
    lmstudio: 'lmstudio-community/GLM-4.6V-Flash-MLX-4bit'
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
 * @returns {Array<{ id, key, name, params, size, family, description, capabilities, contextLength, installed }>}
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
      category: entry.category,
      params: entry.params,
      size: entry.size,
      family: entry.family,
      description: entry.description,
      capabilities: entry.capabilities,
      // Native context window (tokens), when it's a documented spec; null otherwise.
      contextLength: Number.isFinite(entry.context) ? entry.context : null,
      installed: installedNorm.has(normalizeFor(backend, entry[backend]))
    }));
}

/**
 * Filter the per-backend catalog by a free-text query against name, id,
 * family, category, and description. Empty query returns the full catalog.
 */
export function searchCatalog(backend, query, installedIds = []) {
  const all = getCatalog(backend, installedIds);
  const q = String(query || '').trim().toLowerCase();
  if (!q) return all;
  return all.filter((m) =>
    m.name.toLowerCase().includes(q) ||
    m.id.toLowerCase().includes(q) ||
    m.category.toLowerCase().includes(q) ||
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
