# Grok Bot box — free local Persistent Mind

**Audience:** PortOS installs running on a **Grok Bot box** (CPU-only, ~16 GB RAM, no GPU) and similar modest hosts.

## Recommended topology

| Role | Where it runs | Default |
| --- | --- | --- |
| **Persistent Mind** | Local **Ollama** API provider | **Qwen2.5 7B Instruct (Q4)** — `qwen2.5:7b-instruct` (alias: `qwen2.5:7b`) |
| **Coding tasks** | Cloud CLIs / harnesses | **Cursor Agent** / **OpenCode Zen** (and other subscription CLIs you enable) |

Keep the mind free and local. Do **not** point coding agents at a CPU-bound 27B/vLLM stack on this host — those presets need a GPU workstation (see [Recommended coding-agent setup](./qwen38-rtx3090.md), [SGLang](./sglang-qwen38.md), [Fleet LLM host](./fleet-llm-host.md)).

## Why this default

- Persistent Mind is an always-on conversational agent with optional tool grants. A tool-capable ~7B instruct model fits ~16 GB RAM at Q4 and stays responsive enough for wake turns.
- Cursor / OpenCode Zen already own the coding harness (worktrees, tools, PRs). Using them for coding avoids pretending a CPU box is a 27B coding workstation.
- The built-in `ollama` provider is a Direct API lane — the reliability path Persistent Mind prefers over TUI scraping.

## Setup UI

PortOS surfaces a **Free local Persistent Mind** card when the host fits this path (CPU-only / no usable NVIDIA GPU, or low RAM / modest Apple Silicon without a curated 48 GB+ coding preset):

- **AI Providers** (`/ai`)
- **Models → LLMs → Runtimes** (`/models/llms`)
- **Chief of Staff → Persistent Mind → Settings** (AI profile drawer)

The card:

1. Detects whether Ollama is installed and answering.
2. Offers **Install Ollama** / **Start Ollama** / **Pull Qwen2.5 7B Instruct** via the existing local-LLM APIs.
3. Enables the built-in `ollama` provider and pins the recommended model.
4. Optionally sets the Persistent Mind profile to that provider/model.

Copy on the card states that this is the default for **Grok-box / CPU-only / no-GPU** hosts, and warns against 27B / vLLM presets.

### API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/local-llm/persistent-mind-setup` | Checklist + recommendation (or `applicable: false`) |
| `POST` | `/api/local-llm/persistent-mind-setup/apply` | Enable `ollama` + pin model; optional `{ setMindProfile: true }` |

Apply never downloads weights. Install / start / pull stay on `/api/local-llm/install-backend`, `/ollama-service`, and `/install`.

## Guardrails

- **No GPU / low RAM:** the recommendation includes explicit warnings; expect slower CPU inference.
- **Heavy presets suppressed:** hosts on this path should not be steered to Qwen3.8-27B, vLLM, or SGLang as the default. Curated GPU coding hosts keep [Hardware LLM recommendation](../../client/src/components/settings/HardwareLlmRecommendation.jsx) instead and do not get this card.
- Hardware gates on catalog entries (e.g. 27B `minMemoryGb: 32`, vLLM `requiresNvidiaGpu`) still hide unavailable options in the library.

## Related

- [Claude Ollama](./claude-ollama.md) — local model behind the Claude Code harness (optional coding path once Ollama is up)
- [Persistent Mind / CoS enhancement](./cos-enhancement.md)
- [Product surfaces](./product-surfaces.md)
