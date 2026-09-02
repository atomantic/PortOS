# Speculative Decoding (DSpark / DFlash 2) — llama.cpp & OpenCode llama TUI

[DFlash 2](https://huggingface.co/z-lab) provides deep, ultra-fast block-level speculative drafting for large language models (such as Qwen 2.5, Qwen 3.8, and Muse-Glimmer). By pairing a small speculative drafter model (typically 1.5–3 GB) with a target foundation model (e.g. 27B–30B), DFlash 2 achieves 2.5–3× end-to-end token generation speedups without sacrificing output quality.

[DSpark](https://arxiv.org/html/2607.05147v1) (DeepSeek) is the sibling drafter family — same lossless block-drafting idea, a rank-256 Markov head instead of DFlash 2's candidate selector, and a much wider set of published drafters.

PortOS integrates both through the **OpenCode llama TUI** provider preset and the managed local `llama-server`.

> **Which one to run:** `--spec-type draft-dspark` **merged into llama.cpp on 2026-07-28** ([#25173](https://github.com/ggml-org/llama.cpp/pull/25173)) and works on a stock llama.cpp (`brew install llama.cpp` on macOS/Linux, `winget install ggml.llamacpp` on Windows — the LLMs page Install button runs whichever applies). DFlash 2's engine modules are **still an open PR** ([#27342](https://github.com/ggml-org/llama.cpp/pull/27342)) and need a from-source build of that branch. llama.cpp falls back **silently** on a spec-type/drafter mismatch rather than erroring, so a DFlash 2 drafter on a stock build degrades quietly. Start with DSpark unless you have built the DFlash 2 branch. Full comparison: [DSpark vs DFlash 2](../research/2026-08-19-dspark-vs-dflash2.md).

> **On an NVIDIA RTX 3090?** There is a shorter path than building llama.cpp from a branch. Upstream froze a working DFlash 2 setup for that exact card — patched vLLM 0.27.1 plus a requantized Qwen3.8-27B, shipped as a Docker compose project — and PortOS fronts it with its own OpenCode presets. You get DFlash 2 drafting and prefix caching without vendoring an unmerged engine patch, at the cost of the container holding the whole 24 GB card. See [vLLM Qwen3.8-27B on an RTX 3090](./qwen38-rtx3090.md). It is CUDA-only: Apple Silicon stays on DSpark or [MTPLX](./mtplx.md). On a **Hopper or Blackwell** card there is a third path — [SGLang Qwen3.8-27B](./sglang-qwen38.md), an official image with no speculative overlay by default (DFlash 2 there needs an SGLang newer than the pinned tag).

---

## What PortOS Adds

1. **OpenCode llama TUI Provider**:
   - An attachable `tui` coding-agent provider preset (`opencode-llama-tui`) configured to connect to `http://127.0.0.1:5568/v1`.
   - Seeded with default model aliases `["dflash", "qwen3.8-27b-dflash2", "Muse-Glimmer-30B-DFlash2"]` with default `dflash`. The launcher keeps `--alias dflash` for every drafter family so this alias resolves regardless of which one you run.
   - Fully enabled by default and equipped with OpenCode's agentic file-writing harness, tool calling, and session persistence.
2. **Model Refresh**:
   - Support for dynamic model discovery via the **Refresh Models** button on AI Providers, querying the local `llama-server` `/v1/models` endpoint.
3. **Local LLMs & AI Providers Guidance**:
   - UI instructions, command templates, and copyable run lines surfaced in **Models → LLMs** and **AI Providers**.

---

## Setup & Running with llama-server

### 1. Download Base & Draft Models

**From the UI (recommended).** **Models → LLMs → Speculative Decoding**
lists each preset's two GGUFs with their on-disk state and a **Download** button
per file — PortOS fetches the weights from Hugging Face straight into the path
the launcher passes `llama.cpp`, so a missing file is visible (and fixable)
before you press Start rather than surfacing as a failed launch. Start stays
disabled, naming the file to download, while either half of the selected pair is
missing. A drafter with no published single-file GGUF (the DSpark 8B block ships
as a tokenizer-less checkpoint) links out to a Hugging Face search instead.
Gated repos use the Hugging Face token from Image Gen settings. Downloads land
in `models/` under the install root (gitignored, not included in backups —
they're re-downloadable).

**By hand.** Download your base GGUF and a matching drafter GGUF from Hugging
Face. Drafter checkpoints are **not standalone models** — they only produce text
once an engine pairs them with their specific target, which is why PortOS's model
search filters them out of the install picker.

DSpark pairs (stock llama.cpp):

- **Qwen 3.8 27B**: base `ggml-org/Qwen3.8-27B-GGUF` + drafter `erlidev/Qwen3.8-27B-DSpark-GGUF` (a GGUF conversion of `DimInfer/Qwen3.8-27B-Dspark-v1`)
- **Qwen 3 8B**: base `Qwen/Qwen3-8B-GGUF` + drafter converted from `deepseek-ai/dspark_qwen3_8b_block7`

Qwen publishes no GGUF of the 27B itself — `ggml-org` (llama.cpp's own org) and
`unsloth`/`bartowski` are the maintained conversions. `ggml-org` is what the
preset points at because it is the only one publishing a plain, unsharded
`Qwen3.8-27B-Q4_K_M.gguf`.

DSpark drafters ship without tokenizers — converting one to GGUF requires passing
`--target-model-dir` so it reuses the target's tokenizer. Keep the drafter at bf16;
the target can be any quant.

DFlash 2 pairs (require a source build of llama.cpp [#27342](https://github.com/ggml-org/llama.cpp/pull/27342)):

- **Qwen 3.8 27B Draft Pair (Q2_K — preferred for TUI agents)**:
  - Base: `ggml-org/Qwen3.8-27B-GGUF` (e.g. `Qwen3.8-27B-Q4_K_M.gguf`)
  - Drafter: `analogalok/Qwen3.8-27B-DFlash2-Q2_K-GGUF` (`Qwen3.8-27B-DFlash2-Q2_K.gguf`, ~700 MB). Measured identical ~93.7% draft acceptance vs the official Q4_K_M drafter at ~1.1 GB — the ~450 MB saved goes to KV cache. Works with any Qwen3.8-27B target quant, including Unsloth UD-Q4_K_XL.
- **Qwen 3.8 27B Draft Pair (official Q4_K_M)**:
  - Base: `ggml-org/Qwen3.8-27B-GGUF` (e.g. `Qwen3.8-27B-Q4_K_M.gguf`)
  - Drafter: `incoai/Qwen3.8-27B-DFlash2-GGUF` (e.g. `Qwen3.8-27B-DFlash2-Q4_K_M.gguf`)
- **Muse-Glimmer 30B Draft Pair**:
  - Base: `meta-models/Muse-Glimmer-30B-GGUF` (`Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf` — this
    repo also ships an `mmproj-…-Q4_K_M.gguf` projector and its own `dflash-…-Q4_K_M.gguf`
    drafter, so take the target by name rather than by quant tag)
  - Drafter: `z-lab/Muse-Glimmer-30B-DFlash2-GGUF` (e.g. `Muse-Glimmer-30B-DFlash2-Q4_K_M.gguf`)

### 2. Launch llama-server
Start `llama-server` on loopback port `5568` with speculative decoding enabled
(`--spec-type draft-dflash` for a DFlash drafter, `draft-dspark` for a DSpark one):

```bash
llama-server \
  -m models/Qwen3.8-27B-Q4_K_M.gguf \
  --model-draft models/Qwen3.8-27B-DSpark-BF16.gguf \
  --spec-type draft-dspark \
  --port 5568 \
  --host 127.0.0.1 \
  --alias dflash \
  --ctx-size 32768 \
  --n-gpu-layers 99 \
  --parallel 1
```

`--parallel 1` is a PortOS pin, not llama.cpp's default. `llama-server` often
starts with 4 request slots and **divides `--ctx-size` across them**, so a 32k
window becomes 8k per in-flight request and the unused slots sit on VRAM a
single TUI agent never uses. PortOS's launcher always passes `--parallel 1`
unless you raise it under Advanced options. Raise it only if you actually run
several concurrent requests against the same server — each extra slot shrinks
the context the OpenCode llama TUI agent sees.

### 2b. 24 GB card, max TUI-agent context (DFlash 2)

On a single 24 GB GPU (RTX 4090 / 3090) the Q2_K DFlash 2 drafter plus
`--parallel 1` is what unlocks a quarter-million-token window. Measured on
Qwen3.8-27B UD-Q4_K_XL with llama.cpp PR #27342 at `--spec-draft-n-max 3`
(the engine default):

| KV cache | Context | Decode | Notes |
| --- | --- | --- | --- |
| Q4_0 (`--cache-type-k/v q4_0`) | 250,000 | ~74 t/s | deepest "repo swallower" |
| Q8_0 | 150,000 | ~75 t/s | higher-precision SWE |
| FP16 (engine default) | 90,000 | ~81 t/s | unquantized attention |

```bash
llama-server \
  -m models/Qwen3.8-27B-Q4_K_M.gguf \
  --model-draft models/Qwen3.8-27B-DFlash2-Q2_K.gguf \
  --spec-type draft-dflash \
  --port 5568 --host 127.0.0.1 --alias dflash \
  --ctx-size 250000 -ngl 99 --parallel 1 \
  --cache-type-k q4_0 --cache-type-v q4_0
```

Do **not** ship 250k as PortOS's default `--ctx-size` — that OOMs every
machine that is not a 24 GB NVIDIA card. Set Context Size and KV cache type
under Advanced options on the machine that has the VRAM. The Q2_K preset and
`--parallel 1` are the parts that apply everywhere.

### 2c. Drafter-free speculation (n-gram spec types)

`--spec-type` is a **comma-separated list**, and only its `draft-*` entries need a
drafter GGUF. The `ngram-*` implementations draft by pattern-matching the tokens
already in the context window — no second model, no extra VRAM — which makes them
worth having even when you have no drafter for your target:

| Spec type | Needs a drafter? | What it drafts from |
| --- | --- | --- |
| `draft-dspark` / `draft-dflash` / `draft-simple` / `draft-mtp` | yes | a second model |
| `ngram-map-k` / `ngram-map-k4v` | no | repeated n-grams in the live context |
| `ngram-simple` / `ngram-mod` / `ngram-cache` | no | n-gram lookup over token history |

Mixing the two families in one server is supported and is the usual reason to
comma-separate — the drafter handles novel text while the n-gram map catches the
long verbatim repeats an agent produces (re-emitted file contents, diffs, JSON):

```bash
llama-server \
  -m models/Qwen3.8-27B-Q4_K_M.gguf \
  --model-draft models/Qwen3.8-27B-DSpark-BF16.gguf \
  --spec-type draft-dspark,ngram-map-k \
  --port 5568 --host 127.0.0.1 --alias dflash --parallel 1
```

In PortOS, set this in **Settings → Local LLMs → Speculative Decoding →
Advanced options → Spec Type** (the picker suggests the types above). The two
fields are resolved against each other at launch, so a preset's prefilled paths
can't fight your choice:

- **Drafter Model empty + `draft-*` types** — those entries are dropped (logged),
  and the launch starts with whatever `ngram-*` half remains.
- **Drafter Model set + only `ngram-*` types** — the drafter is ignored rather
  than loaded, and Start is no longer blocked on a drafter GGUF that was never
  downloaded.
- **Spec Type empty + Drafter Model set** — left alone: llama.cpp speculates off
  a bare `--model-draft`, so PortOS does not second-guess it.

Vocabulary reference: llama.cpp `docs/speculative.md`.

### 3. Use in PortOS
1. Navigate to **AI Providers** (`/ai`) or **Models → LLMs**.
2. Verify **OpenCode llama TUI** is enabled.
3. Click **Refresh Models** to pull the live aliases from `llama-server`, or use the default `dflash` model.
4. Select **OpenCode llama TUI** in the CoS task creator or terminal runner to execute coding and agent tasks with speculative acceleration.

### Generation defaults

**AI Providers → edit the provider → Generation** carries the defaults every run
of that provider starts with — **Temperature**, **Top-P**, **Thinking mode**, and
**Default Effort**. They apply to HTTP, CLI, and TUI launches alike, so the same
local model keeps one posture however it is reached; OpenCode receives them as
its `agent.build` options, and a CoS task can still override temperature and
thinking for a single run.

Each control appears only where PortOS actually forwards it. Sampling
(temperature, top-p) reaches Ollama, llama.cpp, and MTPLX, plus the OrcaRouter
gateway — but not a Claude Code harness pointed at Ollama, which owns its own
sampling and takes only the thinking signal. Thinking itself is not a portable
flag: Ollama gets its native `think` boolean, llama.cpp and MTPLX get
`enable_thinking` through the chat template, a Claude/Ollama harness gets
`MAX_THINKING_TOKENS`, and OrcaRouter gets nothing (its upstream models own the
switch). A model with no reasoning mode ignores it either way.

**Every field left blank is simply not sent**, so the backend keeps its own
default — blank Top-P is not the same as pinning `1`, and blank Temperature is
not the same as pinning `0.6` (though Ollama agent runs still fall back to `0.6`
server-side). This is why the editor never seeds a value a provider does not
already have: an unrelated Save must not silently pin one.

### Checking the requirements from the Providers page

Every provider backed by a local daemon carries a **requirements checklist** on
its card in **AI Providers** — fed by `GET /api/providers/readiness`, re-polled
every 20s:

1. **llama.cpp installed** — `llama-server` is on PortOS's PATH (or something is
   already answering at the endpoint, which proves it another way).
2. **llama.cpp server responding** — the endpoint THIS provider points at (its
   own `OPENCODE_CONFIG_CONTENT` `baseURL`, not a hardcoded default) answers
   `GET /v1/models`.
3. **Model available** — the provider's default model is one that endpoint
   actually serves. This is the alias check: `--alias dflash` with a provider
   asking for `dspark` fails here rather than inside a dead agent run.

Until all three pass, the card says what is missing and links to
**Models → LLMs**. The same failure previously surfaced only as
`Cannot connect to API: Unable to connect` inside the agent transcript.

### "llama.cpp is serving `dflash`" — the model check is a NAME check

`llama-server` serves **one model per process**, and the id it answers
`GET /v1/models` with is whatever `--alias` was on its launch line — not the
GGUF's filename. So the three aliases the provider ships with
(`dflash`, `qwen3.8-27b-dflash2`, `Muse-Glimmer-30B-DFlash2`) are *names you may
start the server under*, not three models sitting there ready to switch between.
Pinning the provider to one the running server was not started under fails the
model check even when the weights loaded are exactly the ones you wanted.

Nothing is missing and nothing needs downloading. The checklist offers both
fixes, and either is one click:

- **Use `dflash` as default** — point the provider at the id the server answers
  with.
- **Serve as `qwen3.8-27b-dflash2`** — relaunch `llama-server` on the weights it
  already has, under the id the provider sends
  (`POST /api/providers/readiness/serve-model`). The whole launch line is
  carried forward, tuning flags included; if the relaunch is rejected or never
  answers, the previous line is put back so the provider is never left pointing
  at a dead port.

The second button only appears for `llama.cpp` — Ollama, LM Studio, and MTPLX
name a model after the weights they loaded, so there is no label to change.
It also refuses (naming the flag to add yourself) when `llama-server` was
started outside PortOS: that process belongs to whoever ran it.

The GGUF weights are a separate download from the binary: `llama-server` will
not start without them, and PortOS refuses the start with the missing path named
rather than reporting a PID for a process that already exited. The Speculative
Decoding card downloads them for you — see step 1.

---

## Ollama

Ollama's vendored llama.cpp engine has carried DSpark since **0.32.6**
([#17545](https://github.com/ollama/ollama/pull/17545)), but Ollama surfaces no
control for it — its server hardcodes `--spec-type draft-mtp` whenever
speculative decoding is on. Selecting DSpark requires overriding
`LLAMA_ARG_SPEC_TYPE` / `LLAMA_ARG_SPEC_DRAFT_MODEL` on the Ollama process and
pointing at a raw blob-store path; the one reported measurement through that
path was ~13%, far below what the drafter delivers natively. Tracked upstream in
[ollama#17016](https://github.com/ollama/ollama/issues/17016). **Use
`llama-server` for speculative decoding in PortOS, not the Ollama backend.**
