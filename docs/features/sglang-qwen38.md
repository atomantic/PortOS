# SGLang Qwen3.8-27B (Hopper / Blackwell)

The third CUDA path for CoS agents, alongside the Ampere-only
[vLLM container](./qwen38-rtx3090.md) and the Apple Silicon
[MTPLX](./mtplx.md) / [DSpark](./dflash2.md) runtimes. It serves Qwen3.8-27B from
SGLang's official `lmsysorg/sglang:qwen38-27b` image on `127.0.0.1:18021`, behind
disabled-by-default OpenCode and Claude Code wrappers — the container speaks both
the OpenAI and the Anthropic wire protocols, so either harness can drive it.

**PortOS never starts this container, never pulls the image, and never downloads
the weights.** It holds the whole GPU, so local image/video generation cannot run
while it is up — see [GPU exclusivity](#gpu-exclusivity) below.

Investigation record: [2026-08-21 SGLang Qwen3.8-27B](../research/2026-08-21-sglang-qwen38-27b.md). The latest local-model comparison is recorded in the [2026-08-22 performance audit](../research/2026-08-22-local-llm-performance-audit.md); it found this Apple Silicon install cannot run the recipe. The seed presets stay disabled by default; a live TUI card may be enabled for an explicit future test, but the readiness checklist keeps it blocked until a supported NVIDIA endpoint is reachable.

## Which card

| Detected card | Path |
| --- | --- |
| SM90 Hopper (H200 / H100) | **This recipe** — FP8, FlashInfer, 32k prefill chunks. The cookbook-verified cell. |
| Blackwell 96 GB (RTX PRO 6000) | This recipe's `rtx6000` cell — NVFP4, engine-default prefill sizing. |
| Blackwell 32 GB (RTX 5090) | This recipe's `rtx5090` cell — NVFP4, `--max-running-requests 1`. |
| Ampere 24 GB (RTX 3090) | **Not this.** The cookbook publishes no 3090 cell; that card stays on [vLLM](./qwen38-rtx3090.md). |
| Apple Silicon | **Not this.** Use [MTPLX](./mtplx.md) or [llama.cpp / DSpark](./dflash2.md). |
| `nvidia-smi` wouldn't answer | PortOS says the probe failed. It does **not** claim you have no GPU. |

The gate is `sglangCellForGpu` / `sglangUnsupportedReason` in
`server/lib/sglangQwenRecipe.js`, reading the compute-capability probe in
`server/lib/cudaCapability.js`. Only the H200 cell is transcribed flag-for-flag
from the cookbook; the two Blackwell cells carry what the research note records
about them and deliberately omit H200's prefill overrides rather than pinning an
unmeasured number. If you bring one up on real hardware, write a dated note in
`docs/research/` and tighten the cell.

## Set up the host

1. Docker with the NVIDIA Container Toolkit. PortOS does not install either —
   they are host decisions with driver requirements it cannot judge.
2. Create a project directory. PortOS looks in `~/sglang-qwen38` by default;
   `SGLANG_QWEN_PROJECT_DIR` overrides it.
3. Save the compose file below into it as `docker-compose.yml`.
4. Pull the image and the weights **once, yourself** — roughly 20 GB:

   ```bash
   docker pull lmsysorg/sglang:qwen38-27b
   HF_HOME=./hf-cache hf download Qwen/Qwen3.8-27B-FP8
   ```

   Gated repo? Put `HF_TOKEN=…` in a `.env` beside the compose file. Weights kept
   somewhere else entirely? Point `SGLANG_QWEN_WEIGHTS_DIR` at them, so the
   readiness check can see them.

## The compose file

Generated from `buildSglangQwenRecipe({ hw: 'h200' })` — that function is the
single source of truth, and a unit test fails if this block drifts from it. For a
Blackwell card, regenerate with `hw: 'rtx5090'` or `hw: 'rtx6000'`.

```yaml
services:
  sglang-qwen38:
    image: lmsysorg/sglang:qwen38-27b
    container_name: sglang-qwen38
    restart: "no"
    ipc: host
    shm_size: "32g"
    ports:
      - "127.0.0.1:18021:18021"
    volumes:
      - ${HF_HOME:-./hf-cache}:/root/.cache/huggingface
    environment:
      - HF_TOKEN=${HF_TOKEN:-}
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: ["gpu"]
    entrypoint: ["sglang"]
    command:
      - "serve"
      - "--trust-remote-code"
      - "--model-path"
      - "Qwen/Qwen3.8-27B-FP8"
      - "--kv-cache-dtype"
      - "fp8_e4m3"
      - "--mem-fraction-static"
      - "0.85"
      - "--attention-backend"
      - "flashinfer"
      - "--chunked-prefill-size"
      - "32768"
      - "--max-prefill-tokens"
      - "32768"
      - "--tool-call-parser"
      - "qwen3_coder"
      - "--reasoning-parser"
      - "qwen3"
      - "--mamba-radix-cache-strategy"
      - "extra_buffer"
      - "--mamba-ssm-dtype"
      - "float32"
      - "--mamba-full-memory-ratio"
      - "1.201"
      - "--host"
      - "127.0.0.1"
      - "--port"
      - "18021"
```

### Why these flags

- **`--tool-call-parser qwen3_coder`** — SGLang's spelling. vLLM's is
  `qwen3_xml`. Use the wrong one, or omit it, and the server starts, answers, and
  returns raw markup with no `tool_calls` block: the agent narrates edits it never
  makes. This is the exact failure the 3090 bring-up hit.
- **`--reasoning-parser qwen3`** — the same class of silent failure for the
  thinking block.

  Both come from `parserFlagsFor('sglang')` in
  [`server/lib/qwenAgentParsers.js`](../../server/lib/qwenAgentParsers.js), the one
  table holding the per-runtime parser spellings. Change them there, not here.
- **`--mamba-full-memory-ratio 1.201`** — derived, not defaulted. Qwen3.8-27B is a
  hybrid Gated DeltaNet model, so post-weight memory splits between a reserved GDN
  state pool (which sets the concurrency ceiling) and the paged KV pool. The
  cookbook formula is `(S + D) × state_bytes / (L × kv_bytes_per_token)`; at the
  CoS operating point (`extra_buffer` → S=5, speculation off → D=0, fp32 state →
  153.9 MB, fp8 KV → 32.8 KB/token, L ≈ 20,000 from the 3090 bring-up's measured
  17k-token agent prefix) that is **1.201**. The cookbook default `0.9` under-sizes
  the state pool here and silently clamps concurrency.

  **After boot, check the server log's `max_running_requests` line.** If it is
  capped below the concurrency you wanted, raise the ratio.
- **`restart: "no"`** — the container holds the whole GPU. A restart policy would
  bring it back on every host reboot, silently blocking local media jobs.
- **No DFLASH2.** That overlay needs an SGLang newer than this pinned image
  (PR sgl-project/sglang#35496) and is unmeasured on H200. In-checkpoint MTP
  (`--speculative-algorithm EAGLE` 3/1/4) needs no extra weights and is a
  reasonable later experiment — but it is not the first-ship default, and it
  raises the mamba ratio (D goes 0 → 4).

## Start it

Either `docker compose up -d` in the project directory, or the **Start SGLang**
button on the provider readiness checklist. That button only ever brings up an
already-prepared project: it refuses on an unsupported card before it reaches
docker, refuses when the compose file is missing, and refuses when it cannot
confirm the weights are on disk. It never pulls the image and never downloads
weights.

## Use it from an agent (OpenCode)

Migration `290-opencode-sglang-providers` seeds two disabled presets on
**AI Providers**:

| Preset | Type | Endpoint |
| --- | --- | --- |
| `opencode-sglang` | cli | `http://127.0.0.1:18021/v1` |
| `opencode-sglang-tui` | tui | `http://127.0.0.1:18021/v1` |

Enable the one you want once the container answers. Both carry
`sglangBacked: true`, which is what routes OpenCode to the `sglang/` namespace,
skips the provider in usage/quota accounting (a local runtime costs no money), and
drives the readiness probe against `:18021/v1/models`.

**API key.** SGLang serves unauthenticated unless you started it with
`--api-key`. The presets ship a blank key and PortOS attaches one only when it is
set — unlike the vLLM stack, whose key is mandatory.

**Generation controls.** Temperature, top-p, reasoning effort, and the thinking
toggle all render for these presets and reach `agent.build` through
`OPENCODE_CONFIG_CONTENT`. Thinking rides `chat_template_kwargs.enable_thinking`,
the same shape MTPLX and llama.cpp take.

Qwen3.8-27B has thinking **on** by default. CoS coding wants it **off** — that is
what keeps the tool-call format reliable — but PortOS does not seed the setting,
so turn it off on the provider yourself.

## Claude Code against the same container

SGLang serves an **Anthropic-compatible `/v1/messages` endpoint on every server**,
with no extra flag — the same trick Claude Ollama plays with the Ollama daemon. So
the Claude Code harness can drive this container directly, no LiteLLM in between.
The vLLM stack cannot: it is OpenAI-only, which is why the 3090 path stays
OpenCode-only.

Migration `291-claude-sglang-providers` seeds a second disabled pair:

| Preset | Type | Command | `ANTHROPIC_BASE_URL` |
| --- | --- | --- | --- |
| `claude-sglang` | cli | `claude --print` | `http://127.0.0.1:18021` |
| `claude-sglang-tui` | tui | `claude --dangerously-skip-permissions` | `http://127.0.0.1:18021` |

These are **additional**, not a replacement — two harnesses over one daemon, and
they carry `sglangBacked: true` too, so the readiness checklist, the usage/quota
skip, and the GPU-exclusivity probe treat all four presets as the same container.

### The env vars that are load-bearing

- **`CLAUDE_CODE_ATTRIBUTION_HEADER=0`** — without it, Claude Code prepends a
  per-request hash to the system prompt. That hash is the first token to differ
  between turns, so SGLang's radix prefix cache misses and **re-prefills the whole
  conversation on every CoS turn**. The 3090 bring-up measured a 24× TTFT
  difference between a prefix-cache hit and a miss; this flag is what makes that
  win reachable here. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is a *different*
  control and does not remove the attribution block — both are set.
- **`ANTHROPIC_BASE_URL` is the server root**, `http://127.0.0.1:18021`, with no
  `/v1`. The Anthropic SDK appends `/v1/messages` itself; append it yourself and
  the server 404s in a way that reads as "model not found". The `/v1` form lives
  on the preset's `endpoint` field, which is the OpenAI-compatible listing the
  readiness probe hits — the two URLs are deliberately different, and swapping
  them breaks the harness while leaving the checklist green.
- **`ANTHROPIC_AUTH_TOKEN` must be non-empty.** SGLang accepts any value unless
  you started it with `--api-key`, but the SDK refuses to send a request with a
  blank one. It ships as `sglang` and is marked secret. **If you did start the
  container behind `--api-key`, set this to that key** — the provider card's
  `API Key` field feeds only the model-refresh probe on these two presets, so
  filling that in alone leaves every agent run 401ing while the readiness
  checklist stays green.
- **`API_TIMEOUT_MS=3000000`** — reasoning plus a long CoS prompt runs well past
  the SDK default.

Tool calls also need **`--tool-call-parser qwen3_coder`** on the serve line (see
[Why these flags](#why-these-flags)). Without it the schemas are accepted, the
calls come back as raw text, and Claude Code executes nothing.

**No `[1m]` suffix on the model name.** Native context is 262,144. Claiming Claude
Code's 1M beta while the serve line does not raise `--context-length` caps the
window incorrectly in the other direction. Every tier
(`ANTHROPIC_DEFAULT_HAIKU_MODEL` through `_OPUS_MODEL`, plus
`ANTHROPIC_SMALL_FAST_MODEL`) points at the one served `qwen3.8-27b`, so a
haiku-tier sub-call cannot ask the container for a model it has never heard of.

### Thinking is not switchable on this path

Qwen3.8-27B thinks by default, and the only per-request off switch is
`chat_template_kwargs.enable_thinking` — which the Anthropic wire cannot carry.
Claude Code has no field that maps to it, so an omitted `thinking` block falls
through to the chat-template default and the model keeps thinking. The provider
card therefore offers **no Thinking toggle** on these two presets; showing one
would pin a value nothing reads.

CoS coding still wants thinking off — that is what keeps the tool-call format
reliable. On this path the levers are the serve line (bake a non-thinking
default into the chat template) or the OpenCode presets above, which reach
`enable_thinking` per request through `OPENCODE_CONFIG_CONTENT`. Pick the
harness accordingly: Claude Code buys you the better file-editing loop, OpenCode
buys you the thinking switch.

### These presets deliberately run non-lean

Claude Ollama runs in **lean mode** (`--bare --strict-mcp-config`) because a 7B
local model drowns in Claude Code's full personal environment — hooks, plugins,
MCP servers, global `CLAUDE.md`. The SGLang pair does not, and that is a choice
rather than an oversight: Qwen3.8-27B has a 262,144-token native window, the
same environment is what lets a CoS agent type `/do:pr` and drive a change
through to merge, and a large prompt prefix costs nothing per turn once
`CLAUDE_CODE_ATTRIBUTION_HEADER=0` keeps it byte-identical between turns. Revisit
this if you point the presets at a smaller served model.

## GPU exclusivity

An enabled `sglangBacked` provider whose endpoint answers is treated as a GPU
blocker: local image/video/3D jobs refuse up front with a message naming the stop
command, instead of spending minutes loading a model into VRAM they cannot have
and dying with an OOM that names nothing. PortOS **detects and refuses; it never
auto-stops** — nothing would restart the container, an attached CoS session dies
with it, and a cold start is minutes. See `detectGpuBlockers` in
`server/lib/localMemory.js`.

The probe is skipped entirely when no enabled `sglangBacked` provider exists, and
again when the host reports no NVIDIA GPU at all.

## Related

- [vLLM Qwen3.8-27B on an RTX 3090](./qwen38-rtx3090.md) — the Ampere path
- [MTPLX](./mtplx.md) and [DFlash 2 / DSpark](./dflash2.md) — the Apple Silicon paths
- [Ports](../PORTS.md) — why `18021`
- [Research: SGLang Qwen3.8-27B cookbook](../research/2026-08-21-sglang-qwen38-27b.md)
