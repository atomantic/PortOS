# DFlash 2 Speculative Decoding — llama.cpp & OpenCode llama TUI

[DFlash 2](https://huggingface.co/z-lab) provides deep, ultra-fast block-level speculative drafting for large language models (such as Qwen 2.5, Qwen 3.8, and Muse-Glimmer). By pairing a small speculative drafter model (typically 1.5–3 GB) with a target foundation model (e.g. 27B–30B), DFlash 2 achieves 2.5–3× end-to-end token generation speedups without sacrificing output quality.

PortOS provides direct integration with DFlash 2 through the **OpenCode llama TUI** provider preset and local OpenAI-compatible inference servers like `llama-server`.

---

## What PortOS Adds

1. **OpenCode llama TUI Provider**:
   - An attachable `tui` coding-agent provider preset (`opencode-llama-tui`) configured to connect to `http://127.0.0.1:8080/v1`.
   - Seeded with default model aliases `["dflash", "qwen3.8-27b-dflash2", "Muse-Glimmer-30B-DFlash2"]` with default `dflash`.
   - Fully enabled by default and equipped with OpenCode's agentic file-writing harness, tool calling, and session persistence.
2. **Model Refresh**:
   - Support for dynamic model discovery via the **Refresh Models** button on AI Providers, querying the local `llama-server` `/v1/models` endpoint.
3. **Local LLMs & AI Providers Guidance**:
   - UI instructions, command templates, and copyable run lines surfaced in **Settings → Local LLMs** and **AI Providers**.

---

## Setup & Running with llama-server

### 1. Download Base & Draft Models
Download your base GGUF and corresponding DFlash 2 drafter GGUF from Hugging Face:

- **Qwen 3.8 27B Draft Pair**:
  - Base: `Qwen/Qwen3.8-27B-Instruct-GGUF` (e.g. `Qwen3.8-27B-Instruct-Q4_K_M.gguf`)
  - Drafter: `incoai/Qwen3.8-27B-DFlash2-GGUF` (e.g. `Qwen3.8-27B-DFlash2-Q4_K_M.gguf`)
- **Muse-Glimmer 30B Draft Pair**:
  - Base: `meta-models/Muse-Glimmer-30B-GGUF`
  - Drafter: `z-lab/Muse-Glimmer-30B-DFlash2-GGUF`

### 2. Launch llama-server
Start `llama-server` on loopback port `8080` with speculative decoding enabled:

```bash
llama-server \
  -m models/Qwen3.8-27B-Instruct-Q4_K_M.gguf \
  --draft-model models/Qwen3.8-27B-DFlash2-Q4_K_M.gguf \
  --spec-type draft-dflash \
  --port 8080 \
  --host 127.0.0.1 \
  --alias dflash \
  --ctx-size 32768 \
  --n-gpu-layers 99
```

### 3. Use in PortOS
1. Navigate to **AI Providers** (`/ai`) or **Settings → Local LLMs**.
2. Verify **OpenCode llama TUI** is enabled.
3. Click **Refresh Models** to pull the live aliases from `llama-server`, or use the default `dflash` model.
4. Select **OpenCode llama TUI** in the CoS task creator or terminal runner to execute coding and agent tasks with speculative acceleration.
