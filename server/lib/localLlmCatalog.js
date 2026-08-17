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
  { id: 'general', label: 'General purpose' },
  { id: 'coding', label: 'Coding & agents' },
  { id: 'reasoning', label: 'Reasoning & analysis' },
  { id: 'vision', label: 'Image Analysis' },
  { id: 'chat', label: 'Chat & voice' },
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

// Each entry: { key, name, category, recommendedFor?, featured?, params, size,
//               family, description, note?, capabilities, context?, format?,
//               appleSiliconOnly?, ollama?, lmstudio?, ollamaImport?, ollamaAliases?,
//               lmstudioAliases? }
//
// `category` is the one primary lane that groups a model in the unfiltered
// picker. `recommendedFor` is its intentionally broader set of use-case lanes:
// a general model can surface in Coding or Vision without being mislabeled as a
// specialist, while `capabilities` remains the factual modality/tool badge set.
// It must include the primary category. `featured` is reserved for a deliberate
// first-choice recommendation, not a measure of raw benchmark scores.
// `ollama` / `lmstudio` are the exact pull/download ids for that backend.
// `ollamaImport` marks a curated Hugging Face Safetensors directory that PortOS
// imports with `ollama create` instead of trying to pull from Ollama's registry.
// A missing id means there is no well-known build of that model for that
// backend (the user can still free-text install one).
// `ollamaAliases` / `lmstudioAliases` preserve recognized ids retired by an
// upstream publisher without making them available as fresh install targets.
// `context` is the model's native context window in tokens — set it only when
// it's a documented spec for that build (the install-card badge shows it; live
// Hugging Face results read the true value from GGUF metadata instead).
// `format` identifies a backend-native format such as `mlx` when the install id
// is not a GGUF build. `appleSiliconOnly` keeps native MLX recommendations out
// of catalogs where the selected host cannot run them.
//
// Ollama ids must name a build that runs LOCALLY. Several headline 2026 models
// (mistral-large-3, glm-5.2, deepseek-v4-*, minimax-m3, kimi-k3) are published
// to the Ollama library as `:cloud`-only tags whose manifests carry no weights —
// pulling one gets you an API passthrough, not a local model. Verify a tag has a
// non-zero manifest size before adding it here.
export const LOCAL_LLM_CATALOG = [
  // ── Small & fast tier ──
  // Sub-4B models for classification, routing, and the voice agent's tool turns,
  // where round-trip latency matters more than prose quality.
  {
    key: 'functiongemma-270m',
    name: 'FunctionGemma 270M',
    category: 'lightweight',
    recommendedFor: ['lightweight'],
    params: '270M',
    size: '301 MB',
    family: 'gemma',
    description: "Google's Gemma 3 270M fine-tuned purely for function calling — the smallest model here that still drives tools reliably.",
    capabilities: ['chat', 'tools'],
    context: 32768,
    ollama: 'functiongemma:270m',
    lmstudio: 'lmstudio-community/functiongemma-270m-it-GGUF'
  },
  {
    key: 'gemma-3-270m-it',
    name: 'Gemma 3 270M IT',
    category: 'lightweight',
    recommendedFor: ['lightweight'],
    params: '270M',
    size: '253 MB',
    family: 'gemma',
    description: 'Tiny instruction model for cheap classification, routing, and quick local utilities.',
    capabilities: ['chat', 'classification'],
    ollama: 'hf.co/lmstudio-community/gemma-3-270m-it-GGUF:Q4_K_M',
    lmstudio: 'lmstudio-community/gemma-3-270m-it-GGUF'
  },
  {
    key: 'lfm2.5-thinking-1.2b',
    name: 'LFM2.5 Thinking 1.2B',
    category: 'lightweight',
    recommendedFor: ['lightweight', 'reasoning'],
    params: '1.2B',
    size: '731 MB',
    family: 'lfm2',
    description: "Liquid AI's on-device hybrid model — reasoning and tool calling in well under a gigabyte, with a ~125K context.",
    capabilities: ['chat', 'reasoning', 'tools'],
    ollama: 'lfm2.5-thinking:1.2b',
    lmstudio: 'lmstudio-community/LFM2.5-1.2B-Thinking-GGUF'
  },
  {
    key: 'qwen2.5-3b',
    name: 'Qwen2.5 3B',
    category: 'lightweight',
    recommendedFor: ['lightweight', 'chat', 'multilingual'],
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
    key: 'granite4.1-3b',
    name: 'Granite 4.1 3B',
    category: 'lightweight',
    recommendedFor: ['lightweight'],
    params: '3B',
    size: '2.1 GB',
    family: 'granite',
    description: "Apache-licensed IBM Granite — small, tool-capable, and tuned for tight instruction-following rather than chat flourish.",
    capabilities: ['chat', 'tools'],
    context: 131072,
    ollama: 'granite4.1:3b',
    lmstudio: 'lmstudio-community/granite-4.1-3b-GGUF'
  },
  {
    key: 'nemotron-3-nano-4b',
    name: 'Nemotron 3 Nano 4B',
    category: 'lightweight',
    recommendedFor: ['lightweight', 'reasoning'],
    params: '4B',
    size: '2.8 GB',
    family: 'nemotron',
    description: "NVIDIA's efficient agentic model — reasoning and tool calling at 4B with a 256K context.",
    capabilities: ['chat', 'reasoning', 'tools'],
    context: 262144,
    ollama: 'nemotron-3-nano:4b',
    lmstudio: 'lmstudio-community/NVIDIA-Nemotron-3-Nano-4B-GGUF'
  },
  {
    key: 'qwen3.5-4b',
    name: 'Qwen3.5 4B',
    category: 'lightweight',
    recommendedFor: ['lightweight', 'general', 'vision', 'multilingual'],
    params: '4B',
    size: '3.4 GB',
    family: 'qwen',
    description: 'Compact current-generation Qwen with vision, tools, and a 256K context — a lot of capability per gigabyte.',
    capabilities: ['chat', 'tools', 'vision', 'multilingual'],
    context: 262144,
    ollama: 'qwen3.5:4b',
    lmstudio: 'lmstudio-community/Qwen3.5-4B-GGUF'
  },
  // ── General-purpose laptop tier (16–32GB) ──
  {
    key: 'lfm2.5-8b-a1b',
    name: 'LFM2.5 8B-A1B',
    category: 'general',
    recommendedFor: ['general', 'chat', 'reasoning'],
    params: '8B / 1B active',
    size: '5.2 GB',
    family: 'lfm2',
    description: "Liquid AI's edge MoE (1B active) built for fast, reliable tool calling on consumer hardware — 8B quality at roughly 1B speed.",
    capabilities: ['chat', 'reasoning', 'tools'],
    ollama: 'lfm2.5:8b',
    lmstudio: 'LiquidAI/LFM2.5-8B-A1B-GGUF'
  },
  {
    key: 'hermes-3-llama-3.1-8b',
    name: 'Hermes 3 8B',
    category: 'chat',
    recommendedFor: ['chat'],
    params: '8B',
    size: '4.9 GB',
    family: 'hermes',
    description: 'NousResearch Hermes 3 (Llama 3.1 8B) — tuned for reliable function-calling and structured tool use, with no "thinking" delay. A robust pick for the voice agent\'s tool turns.',
    capabilities: ['chat', 'tools'],
    ollama: 'hermes3',
    lmstudio: 'NousResearch/Hermes-3-Llama-3.1-8B-GGUF'
  },
  {
    key: 'granite4.1-8b',
    name: 'Granite 4.1 8B',
    category: 'general',
    recommendedFor: ['general', 'multilingual'],
    params: '8B',
    size: '5.3 GB',
    family: 'granite',
    description: 'Apache-licensed IBM Granite instruct model with a 128K context — clean, constrained output for structured and editorial work.',
    capabilities: ['chat', 'tools', 'multilingual'],
    context: 131072,
    ollama: 'granite4.1:8b',
    lmstudio: 'lmstudio-community/granite-4.1-8b-GGUF'
  },
  {
    key: 'ministral-3-8b',
    name: 'Ministral 3 8B Instruct',
    category: 'general',
    recommendedFor: ['general', 'vision', 'multilingual'],
    params: '8B',
    size: '6.0 GB',
    family: 'ministral',
    description: "Mistral's edge instruct model — vision, tools, and a 256K context, with no thinking phase to wait through. (A separate Ministral 3 Reasoning build exists if you want one.)",
    capabilities: ['chat', 'tools', 'vision', 'multilingual'],
    context: 262144,
    ollama: 'ministral-3:8b',
    lmstudio: 'lmstudio-community/Ministral-3-8B-Instruct-2512-GGUF'
  },
  {
    key: 'qwen3.5-9b',
    name: 'Qwen3.5 9B',
    category: 'general',
    recommendedFor: ['general', 'vision', 'multilingual'],
    params: '9B',
    size: '6.6 GB',
    family: 'qwen',
    description: "Alibaba's current multimodal all-rounder — strong multilingual coverage, vision, tools, and a 256K context. A solid general default.",
    capabilities: ['chat', 'tools', 'vision', 'multilingual'],
    context: 262144,
    ollama: 'qwen3.5:9b',
    lmstudio: 'lmstudio-community/Qwen3.5-9B-GGUF'
  },
  {
    key: 'gemma4-12b',
    name: 'Gemma 4 12B',
    category: 'general',
    recommendedFor: ['general', 'vision'],
    params: '12B',
    size: '7.6 GB',
    family: 'gemma',
    description: "Google's mid-size Gemma 4 with vision, tools, and a 256K context — frontier-ish quality that still fits a 16GB machine.",
    capabilities: ['chat', 'tools', 'vision'],
    context: 262144,
    ollama: 'gemma4:12b',
    lmstudio: 'lmstudio-community/gemma-4-12B-it-GGUF'
  },
  {
    key: 'ministral-3-14b',
    name: 'Ministral 3 14B Instruct',
    category: 'general',
    recommendedFor: ['general', 'reasoning', 'vision'],
    params: '14B',
    size: '9.1 GB',
    family: 'ministral',
    description: 'The largest Ministral 3 — more headroom for reasoning and general work while staying laptop-friendly.',
    capabilities: ['chat', 'reasoning', 'tools', 'vision'],
    context: 262144,
    ollama: 'ministral-3:14b',
    lmstudio: 'lmstudio-community/Ministral-3-14B-Instruct-2512-GGUF'
  },
  {
    key: 'gpt-oss-20b',
    name: 'GPT-OSS 20B',
    category: 'reasoning',
    recommendedFor: ['reasoning'],
    params: '20B',
    size: '12 GB',
    family: 'gpt-oss',
    description: 'Open-weights 20B model — the default local thinking model.',
    capabilities: ['chat', 'reasoning'],
    ollama: 'gpt-oss:20b',
    lmstudio: 'lmstudio-community/gpt-oss-20b-GGUF'
  },
  // ── Large general-purpose / long-context tier (32–128GB unified memory) ──
  // Best suited for whole-manuscript editorial review, where prose quality and a
  // long context window matter most. To actually fit the manuscript, raise Ollama's
  // context window (OLLAMA_CONTEXT_LENGTH) — the default 4K window silently truncates.
  {
    key: 'qwen3.8-27b-mlx-4bit',
    name: 'Qwen3.8 27B MLX 4-bit',
    category: 'general',
    recommendedFor: ['general', 'coding', 'reasoning', 'vision', 'multilingual'],
    featured: {
      label: 'Fast on Apple Silicon',
      description: 'Recommended native-MLX Qwen3.8 install on Apple Silicon.'
    },
    params: '27B',
    size: '15.0 GB',
    family: 'qwen',
    description: 'MLX Community’s current 4-bit Qwen3.8 27B build — a native Apple-Silicon format with long context, coding, reasoning, tools, vision, thinking, and multilingual support.',
    capabilities: ['chat', 'code', 'reasoning', 'tools', 'vision', 'multilingual'],
    context: 262144,
    format: 'mlx',
    appleSiliconOnly: true,
    ollama: 'qwen3.8:27b-mlx',
    lmstudio: 'mlx-community/Qwen3.8-27B-4bit',
    lmstudioAliases: ['lmstudio-community/Qwen3.8-27B-MLX-4bit']
  },
  {
    key: 'qwen3.8-27b-uncensored-mlx',
    name: 'Qwen3.8 27B Uncensored MLX',
    category: 'general',
    recommendedFor: ['general', 'coding', 'reasoning', 'vision', 'multilingual'],
    params: '27B',
    size: '15.0 GB',
    family: 'qwen',
    description: 'OrcaRouter’s abliterated Qwen3.8 variant for red-team and unrestricted local evaluation, with 2-, 4-, 6-, and 8-bit MLX builds plus vision, tools, reasoning, and multilingual support.',
    note: 'Gated on Hugging Face — accept the repository terms and configure a Hugging Face token in Settings. Ollama imports the 4-bit build; LM Studio can select another quantization.',
    capabilities: ['chat', 'code', 'reasoning', 'tools', 'vision', 'multilingual'],
    context: 262144,
    format: 'mlx',
    appleSiliconOnly: true,
    ollama: 'orcarouter/qwen3.8-27b-uncensored-mlx:4bit',
    ollamaImport: {
      repo: 'orcarouter/Qwen3.8-27B-Uncensored-MLX',
      subdir: '4-bit',
      minVersion: '0.19.0'
    },
    lmstudio: 'https://huggingface.co/orcarouter/Qwen3.8-27B-Uncensored-MLX',
    lmstudioAliases: ['orcarouter/Qwen3.8-27B-Uncensored-MLX']
  },
  {
    key: 'qwen3.8-27b',
    name: 'Qwen3.8 27B',
    category: 'general',
    recommendedFor: ['general', 'coding', 'reasoning', 'vision', 'multilingual'],
    featured: {
      label: 'Best overall',
      description: 'Flagship local pick for general work, coding and agents, reasoning, and image analysis.'
    },
    params: '27B',
    size: '17 GB',
    family: 'qwen',
    description: 'Dense current-generation Qwen with a 256K context, strong coding and agent work, vision, tools, multilingual support, and a thinking mode — the strongest all-round local model that still fits 32GB.',
    capabilities: ['chat', 'code', 'reasoning', 'tools', 'vision', 'multilingual'],
    context: 262144,
    ollama: 'hf.co/unsloth/Qwen3.8-27B-GGUF:Q4_K_M',
    lmstudio: 'unsloth/Qwen3.8-27B-GGUF'
  },
  {
    key: 'gemma4-26b-a4b',
    name: 'Gemma 4 26B-A4B',
    category: 'general',
    recommendedFor: ['general', 'vision'],
    params: '26B / 4B active',
    size: '18 GB',
    family: 'gemma',
    description: "Google's MoE (4B active) with a 256K context window and vision — a fast long-context option for one-shot whole-manuscript review. MLX build on Apple Silicon: gemma4:26b-mlx.",
    capabilities: ['chat', 'tools', 'vision'],
    context: 262144,
    ollama: 'gemma4:26b',
    lmstudio: 'lmstudio-community/gemma-4-26B-A4B-it-GGUF'
  },
  {
    key: 'muse-glimmer-30b',
    name: 'Muse Glimmer 30B',
    category: 'general',
    recommendedFor: ['general', 'reasoning', 'vision'],
    params: '30B',
    size: '18 GB',
    family: 'muse-glimmer',
    description: "Meta's Apache-2.0 open model for always-on local agents — vision, tools, and thinking, tuned for long tasks and failure recovery. Runs on a single GPU.",
    capabilities: ['chat', 'reasoning', 'tools', 'vision'],
    context: 131072,
    ollama: 'muse-glimmer:30b',
    lmstudio: 'lmstudio-community/Muse-Glimmer-30B-GGUF'
  },
  {
    key: 'glm-4.7-flash',
    name: 'GLM-4.7 Flash',
    category: 'general',
    recommendedFor: ['general', 'reasoning'],
    params: '30B class',
    size: '19 GB',
    family: 'glm',
    description: 'Z.ai\'s strongest model in the 30B class — reasoning plus tools with a ~198K context, balanced for lightweight local deployment.',
    capabilities: ['chat', 'reasoning', 'tools'],
    ollama: 'glm-4.7-flash',
    lmstudio: 'lmstudio-community/GLM-4.7-Flash-GGUF'
  },
  {
    key: 'olmo-3.1-32b',
    name: 'Olmo 3.1 32B Instruct',
    category: 'reasoning',
    recommendedFor: ['reasoning'],
    params: '32B',
    size: '20 GB',
    family: 'olmo',
    description: "AI2's fully-open model — weights, data, and training recipe all published. Reasoning and tools with a 64K context; the sibling `olmo-3.1:32b-think` trades latency for depth.",
    capabilities: ['chat', 'reasoning', 'tools'],
    context: 65536,
    ollama: 'olmo-3.1:32b-instruct',
    lmstudio: 'lmstudio-community/Olmo-3.1-32B-Instruct-GGUF'
  },
  {
    key: 'gemma4-31b',
    name: 'Gemma 4 31B',
    category: 'general',
    recommendedFor: ['general', 'vision'],
    params: '31B',
    size: '20 GB',
    family: 'gemma',
    description: "Google's dense 31B with a 256K context window and vision — a strong long-context narrative editor that fits comfortably on 64GB+. MLX build on Apple Silicon: gemma4:31b-mlx.",
    capabilities: ['chat', 'tools', 'vision'],
    context: 262144,
    ollama: 'gemma4:31b',
    lmstudio: 'lmstudio-community/gemma-4-31B-it-GGUF'
  },
  {
    key: 'nemotron-3-nano-30b-a3b',
    name: 'Nemotron 3 Nano 30B-A3B',
    category: 'reasoning',
    recommendedFor: ['reasoning'],
    params: '30B / 3B active',
    size: '24 GB',
    family: 'nemotron',
    description: "NVIDIA's agentic MoE with a 1M-token context — by far the longest window here, for whole-corpus review rather than a single manuscript. Only 3B active, so it stays fast.",
    capabilities: ['chat', 'reasoning', 'tools'],
    context: 1048576,
    ollama: 'nemotron-3-nano:30b',
    lmstudio: 'lmstudio-community/NVIDIA-Nemotron-3-Nano-30B-A3B-GGUF'
  },
  {
    key: 'qwen3.5-122b-a10b',
    name: 'Qwen3.5 122B-A10B',
    category: 'general',
    recommendedFor: ['general', 'reasoning', 'vision', 'multilingual'],
    params: '122B / 10B active',
    size: '81 GB',
    family: 'qwen',
    description: 'The largest locally-runnable Qwen3.5 — frontier-class prose with a 256K context and only 10B active parameters. Needs ~96GB+ unified memory.',
    capabilities: ['chat', 'reasoning', 'tools', 'vision', 'multilingual'],
    context: 262144,
    ollama: 'qwen3.5:122b',
    lmstudio: 'lmstudio-community/Qwen3.5-122B-A10B-GGUF'
  },
  // ── Coding / agentic tier ──
  {
    key: 'ornith-9b',
    name: 'Ornith 1.0 9B',
    category: 'coding',
    recommendedFor: ['coding'],
    params: '9B',
    size: '5.6 GB',
    family: 'ornith',
    description: 'Self-improving open model family for agentic coding — the 9B fits a laptop while still driving tools over a 256K context.',
    capabilities: ['chat', 'code', 'tools'],
    context: 262144,
    ollama: 'ornith:9b',
    lmstudio: 'lmstudio-community/Ornith-1.0-9B-GGUF'
  },
  {
    key: 'devstral-small-2-24b',
    name: 'Devstral Small 2 24B',
    category: 'coding',
    recommendedFor: ['coding', 'vision'],
    params: '24B',
    size: '15 GB',
    family: 'devstral',
    description: 'Mistral\'s agentic coding model for repo navigation, multi-file edits, and software-engineering agents — vision and a ~384K context.',
    capabilities: ['chat', 'code', 'tools', 'vision'],
    ollama: 'devstral-small-2:24b',
    lmstudio: 'unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF'
  },
  {
    key: 'north-mini-code-1.0',
    name: 'North Mini Code 1.0 30B-A3B',
    category: 'coding',
    recommendedFor: ['coding', 'reasoning'],
    params: '30B / 3B active',
    size: '19 GB',
    family: 'north-mini-code',
    description: "Cohere's first developer model — a 30B MoE (3B active) for agentic software engineering, with a ~488K context for whole-repo work.",
    capabilities: ['chat', 'code', 'reasoning', 'tools'],
    ollama: 'north-mini-code-1.0',
    lmstudio: 'unsloth/North-Mini-Code-1.0-GGUF'
  },
  {
    key: 'ornith-35b',
    name: 'Ornith 1.0 35B',
    category: 'coding',
    recommendedFor: ['coding'],
    params: '35B',
    size: '21 GB',
    family: 'ornith',
    description: 'The larger Ornith for agentic coding — more headroom on long-horizon repo tasks, still a 256K context.',
    capabilities: ['chat', 'code', 'tools'],
    context: 262144,
    ollama: 'ornith:35b',
    lmstudio: 'lmstudio-community/Ornith-1.0-35B-GGUF'
  },
  {
    key: 'nex-n2-mini',
    name: 'Nex-N2-mini 35B-A3B',
    category: 'coding',
    recommendedFor: ['coding', 'reasoning', 'vision'],
    params: '35B / 3B active',
    size: '22 GB',
    family: 'nex-n2',
    description: "Nex AGI's agentic MoE (3B active) on a Qwen3.5 base — strong at coding, tool calling, long-horizon agent tasks, and vision (75.3 Terminal-Bench 2.1). Apache-2.0; the Q4 build fits comfortably on 32GB+ and is easy on a 128GB Mac. Vision needs the repo's mmproj file. The 397B Nex-N2-Pro is the big sibling — it won't fit a 128GB Mac even at Q4.",
    capabilities: ['chat', 'code', 'tools', 'reasoning', 'vision'],
    ollama: 'hf.co/sjakek/Nex-N2-mini-GGUF:UD-Q4_K_M',
    lmstudio: 'sjakek/Nex-N2-mini-GGUF'
  },
  {
    key: 'qwen3.6-35b-a3b',
    name: 'Qwen3.6 35B-A3B',
    category: 'coding',
    recommendedFor: ['coding', 'vision'],
    params: '35B / 3B active',
    size: '24 GB',
    family: 'qwen',
    description: 'Current Qwen coding MoE with agentic coding, repository reasoning, vision, and tool-use upgrades over Qwen3.5.',
    capabilities: ['chat', 'code', 'tools', 'vision'],
    context: 262144,
    ollama: 'qwen3.6:35b',
    lmstudio: 'unsloth/Qwen3.6-35B-A3B-GGUF'
  },
  // ── Vision / image analysis tier ──
  {
    key: 'minicpm-v4.6',
    name: 'MiniCPM-V 4.6 (vision)',
    category: 'vision',
    recommendedFor: ['vision'],
    params: '1B',
    size: '1.6 GB',
    family: 'minicpm',
    description: 'Pocket-sized multimodal model for image and video understanding — the cheapest way to caption a large dataset locally.',
    capabilities: ['chat', 'vision'],
    context: 262144,
    ollama: 'minicpm-v4.6:1b',
    lmstudio: 'openbmb/MiniCPM-V-4_6-gguf'
  },
  {
    key: 'qwen3-vl-2b',
    name: 'Qwen3-VL 2B (vision)',
    category: 'vision',
    recommendedFor: ['vision'],
    params: '2B',
    size: '1.9 GB',
    family: 'qwen',
    description: 'Tiny Qwen3-VL for quick captions on modest hardware, with the same 256K context as its larger siblings.',
    capabilities: ['chat', 'vision'],
    context: 262144,
    ollama: 'qwen3-vl:2b',
    lmstudio: 'lmstudio-community/Qwen3-VL-2B-Instruct-GGUF'
  },
  {
    key: 'qwen3-vl-8b',
    name: 'Qwen3-VL 8B (vision)',
    category: 'vision',
    recommendedFor: ['vision'],
    params: '8B',
    size: '6.1 GB',
    family: 'qwen',
    description: 'The most capable vision-language model in the Qwen family at a laptop-friendly size — the recommended default for LoRA dataset captioning.',
    capabilities: ['chat', 'tools', 'vision'],
    context: 262144,
    ollama: 'qwen3-vl:8b',
    lmstudio: 'lmstudio-community/Qwen3-VL-8B-Instruct-GGUF'
  },
  {
    key: 'glm-4.6v-flash',
    name: 'GLM-4.6V Flash',
    category: 'vision',
    recommendedFor: ['vision'],
    params: 'Vision',
    size: '7.1 GB',
    family: 'glm',
    description: 'MLX vision-language model for image analysis on Apple Silicon.',
    capabilities: ['chat', 'vision'],
    lmstudio: 'lmstudio-community/GLM-4.6V-Flash-MLX-4bit'
  },
  {
    key: 'qwen3-vl-30b-a3b',
    name: 'Qwen3-VL 30B-A3B (vision)',
    category: 'vision',
    recommendedFor: ['vision'],
    params: '30B / 3B active',
    size: '20 GB',
    family: 'qwen',
    description: 'Larger Qwen3-VL MoE for the most detailed image captions — best on high-memory machines, and only 3B active so it stays responsive.',
    capabilities: ['chat', 'tools', 'vision'],
    context: 262144,
    ollama: 'qwen3-vl:30b',
    lmstudio: 'lmstudio-community/Qwen3-VL-30B-A3B-Instruct-GGUF'
  },
  // ── Text embeddings ──
  // PortOS's memory/recall pipeline expects 768-dimension vectors
  // (EMBEDDING_DIM in server/services/embeddings.js) — every entry below
  // produces them. Larger embedders (e.g. qwen3-embedding at 1024 dims) are
  // deliberately absent: they fail the dimension check on ingest.
  {
    key: 'embeddinggemma-300m',
    name: 'EmbeddingGemma 300M',
    category: 'embedding',
    recommendedFor: ['embedding'],
    params: '300M',
    size: '622 MB',
    family: 'embedding',
    description: "Google's 300M embedding model — 768-dimension vectors for semantic search and memory recall.",
    capabilities: ['embeddings', 'multilingual'],
    ollama: 'embeddinggemma:300m',
    lmstudio: 'lmstudio-community/embeddinggemma-300m-qat-GGUF'
  },
  {
    key: 'nomic-embed-text',
    name: 'Nomic Embed Text',
    category: 'embedding',
    recommendedFor: ['embedding'],
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
    recommendedFor: ['embedding'],
    params: '0.5B',
    size: '344 MB',
    family: 'embedding',
    description: 'Newer multilingual text-embedding MoE for semantic search and recall.',
    capabilities: ['embeddings', 'multilingual'],
    ollama: 'hf.co/nomic-ai/nomic-embed-text-v2-moe-GGUF:Q4_K_M',
    lmstudio: 'nomic-ai/nomic-embed-text-v2-moe-GGUF'
  }
];

// Models that have aged out of the suggested-install picker but that installs
// upgraded from an older PortOS may still have on disk. `mapModelToBackend`
// consults these AFTER `LOCAL_LLM_CATALOG` so a migrate of an older library
// still resolves exactly instead of falling back to a guessed stem — dropping an
// entry from the catalog above must not silently downgrade the migrate flow.
//
// Entries need BOTH ids: a one-sided pair maps to nothing and would only add a
// dead HuggingFace repo to the mapping table (both `lmstudio-community/llava-v1.5-7b-GGUF`
// and `lmstudio-community/CodeLlama-7b-Instruct-GGUF` 404 as of this refresh,
// so LLaVA 1.5 and Code Llama are omitted rather than mapped to a broken repo).
const RETIRED_MODEL_MAPPINGS = [
  { ollama: 'llama3.2', lmstudio: 'lmstudio-community/Llama-3.2-3B-Instruct-GGUF' },
  { ollama: 'llama3.1', lmstudio: 'lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF' },
  { ollama: 'llama3.3:70b', lmstudio: 'lmstudio-community/Llama-3.3-70B-Instruct-GGUF' },
  { ollama: 'qwen2.5', lmstudio: 'lmstudio-community/Qwen2.5-7B-Instruct-GGUF' },
  { ollama: 'qwen3:30b', lmstudio: 'lmstudio-community/Qwen3-30B-A3B-GGUF' },
  { ollama: 'qwen2.5vl', lmstudio: 'lmstudio-community/Qwen2.5-VL-7B-Instruct-GGUF' },
  { ollama: 'qwen2.5vl:32b', lmstudio: 'lmstudio-community/Qwen2.5-VL-32B-Instruct-GGUF' },
  {
    ollama: 'hf.co/lmstudio-community/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M',
    lmstudio: 'lmstudio-community/Qwen3-4B-Instruct-2507-GGUF'
  },
  { ollama: 'mistral', lmstudio: 'lmstudio-community/Mistral-7B-Instruct-v0.3-GGUF' },
  {
    ollama: 'hf.co/unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF:UD-Q4_K_XL',
    lmstudio: 'unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF'
  },
  {
    ollama: 'hf.co/lmstudio-community/Ministral-3-14B-Instruct-2512-GGUF:Q4_K_M',
    lmstudio: 'lmstudio-community/Ministral-3-14B-Instruct-2512-GGUF'
  },
  {
    ollama: 'hf.co/lmstudio-community/granite-3.2-8b-instruct-GGUF:Q4_K_M',
    lmstudio: 'lmstudio-community/granite-3.2-8b-instruct-GGUF'
  },
  { ollama: 'gemma2', lmstudio: 'lmstudio-community/gemma-2-9b-it-GGUF' },
  { ollama: 'phi3', lmstudio: 'lmstudio-community/Phi-3.1-mini-128k-instruct-GGUF' },
  { ollama: 'deepseek-r1', lmstudio: 'lmstudio-community/DeepSeek-R1-Distill-Qwen-7B-GGUF' },
  { ollama: 'minicpm-v', lmstudio: 'openbmb/MiniCPM-V-2_6-gguf' },
  { ollama: 'smollm2', lmstudio: 'lmstudio-community/SmolLM2-1.7B-Instruct-GGUF' }
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

const entryIdsForBackend = (entry, backend) => [
  entry[backend],
  ...(Array.isArray(entry[`${backend}Aliases`]) ? entry[`${backend}Aliases`] : [])
].filter(Boolean);

const entryMatchesBackendId = (entry, backend, normalizedId) =>
  entryIdsForBackend(entry, backend).some((id) => normalizeFor(backend, id) === normalizedId);

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
 * @returns {Array<{ id, key, name, category, recommendedFor, featured, params, size, family, description, note, capabilities, format, contextLength, installed }>}
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
        capabilities: entry.capabilities,
        format: entry.format || null,
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
