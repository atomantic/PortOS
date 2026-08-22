# vLLM Qwen3.8-27B (DFlash 2) on an RTX 3090

[syv-ai/qwen38-27b-rtx3090](https://github.com/syv-ai/qwen38-27b-rtx3090) is a
frozen, reproducible packaging of patched vLLM 0.27.1 + a requantized
Qwen3.8-27B + a Docker compose file, targeted at **one specific card**: a 24 GB
RTX 3090. It serves an OpenAI-compatible API with DFlash 2 speculative drafting
and prefix caching turned on.

PortOS fronts it the same way it fronts [MTPLX](./mtplx.md) and the
[llama-server DSpark/DFlash 2 setup](./dflash2.md): as a local OpenAI-compatible
daemon behind two OpenCode wrappers. Nothing about the engine is vendored here —
PortOS talks to `http://127.0.0.1:18020/v1` and nothing more.

## Two hard constraints, before anything else

**It holds the entire GPU.** The stack occupies roughly 23 GB of the 3090's
24 GB. Local image and video generation on the same card cannot run alongside
it. There is no arbitration in PortOS — but there is **detection**: every
GPU-heavy local job (image, video, image-to-3D, LoRA training) probes this
endpoint first and refuses up front, naming the container and the
`docker compose --profile single stop` that frees the card, instead of dying
with an out-of-memory error minutes into its model load (#4766). Stop the
container before a media job, or run media generation on a different machine.

PortOS will not stop it for you, in either direction: nothing would restart it, an
agent session attached to it dies with it, and a cold start is ~5–7 minutes. That
symmetry is also why PortOS never auto-starts it — a container that came up on
boot would silently take the card away from whatever else the box does.

The probe costs nothing on a machine this does not apply to: it is skipped
entirely when no `vllmBacked` provider is enabled, and on any host without an
NVIDIA GPU. A probe that fails or times out means the container is *not* serving,
so the job proceeds — "couldn't check" never becomes "blocked".

**Apple Silicon is not supported.** DFlash 2 has not been proven on Apple
Silicon in this project, and this is a CUDA / Marlin / FlashInfer container —
it will not run on a Mac at all. The readiness checklist says so on `darwin`
rather than offering a button that cannot work. Mac users wanting the same shape
(a local OpenAI-compatible daemon under an OpenCode TUI) already have
[MTPLX](./mtplx.md) and [DSpark](./dflash2.md).

## Why OpenCode and not Claude Code

vLLM speaks the OpenAI API. Claude Code speaks the Anthropic Messages API, so
pointing it here would mean running a LiteLLM translation layer in between —
another process to install, run, and debug for no capability gain. OpenCode
talks to an OpenAI-compatible endpoint natively, which is exactly what
`OPENCODE_CONFIG_CONTENT` already declares for Ollama, MTPLX, and llama.cpp.

## What PortOS adds

After this version is installed, the **AI Providers** page includes two disabled
presets:

- **OpenCode vLLM (Qwen3.8-27B)** — a headless `cli` coding-agent provider.
- **OpenCode vLLM TUI (Qwen3.8-27B)** — the attachable `tui` provider CoS agent
  tasks run in.

Both are disabled, hold a blank API key, and point at
`http://127.0.0.1:18020/v1`. No API-only preset ships: the container is
key-gated and the two coding harnesses cover everything a text-only record
would.

## Setup

### 1. Prepare the stack (operator, on the 3090 host)

This step is yours, in a terminal. PortOS does not clone the project, build the
~9.5 GB image, or download the ~20 GB of weights — those are decisions with a
bandwidth and disk cost, and a button that started them by surprise would be the
wrong default.

On Windows you need WSL2 with Docker and the NVIDIA Container Toolkit (driver
≥ 580 / CUDA 13); on Linux, the same toolkit natively. Run the commands below
*inside the WSL2 distro*, not in PowerShell — the compose project and its
20 GB of weights belong on the Linux filesystem.

```bash
git clone https://github.com/syv-ai/qwen38-27b-rtx3090 ~/qwen-serving
cd ~/qwen-serving
echo "VLLM_API_KEY=$(openssl rand -hex 24)" > .env
printf 'SPEC=dflash2\nPREFIX_CACHE=1\n' >> .env
echo 'EXTRA_ARGS=--enable-auto-tool-choice --tool-call-parser qwen3_xml' >> .env   # required for any agent use
if grep -qi microsoft /proc/version; then                                          # WSL2 only, both required
  printf 'VLLM_WSL2_ENABLE_PIN_MEMORY=1\nPYTORCH_CUDA_ALLOC_CONF=expandable_segments:False\n' >> .env
fi
docker compose build              # ~9.5 GB image, built here — there is no registry to pull from
docker compose run --rm prepare   # ~20 GB download + CPU requantization, idempotent, resumable
docker compose --profile single up -d
```

`docker compose --profile single up -d` on its own does all three — `prepare` is
a `depends_on` of the server. Running them separately is worth it anyway: it is
the long, unattended part, and PortOS's Start button deliberately refuses until
`prepare` has actually landed weights on disk (see below).

**Tool calling must be switched on, or the coding agent is useless.** Upstream's
`single-user/start_qwen.sh` serves without it, and vLLM then rejects every
request that offers tools with `"auto" tool choice requires
--enable-auto-tool-choice and --tool-call-parser to be set`. OpenCode sends tools
on its very first turn, so the session dies immediately — the model never gets to
read or write a file.

**Use `qwen3_xml`, not `hermes`.** The chat template's `<tool_call>` markers make
`hermes` look right, and the server starts happily with it — but Qwen3.8 emits
its calls in XML (`<function=name><parameter=path>…`), not the Hermes JSON body
that parser expects. The mismatch fails silently: vLLM cannot parse the call, so
it returns the raw markup as ordinary assistant text with `tool_calls: null`, and
the agent simply never uses a tool. There is no error anywhere to explain it.

```bash
echo 'EXTRA_ARGS=--enable-auto-tool-choice --tool-call-parser qwen3_xml' >> .env
```

`EXTRA_ARGS` is appended to the `vllm serve` command line by the start script.
With the right parser the same request comes back as `finish_reason:
"tool_calls"` and a structured `tool_calls` array. This is the one setting
without which the whole point of the preset — a CoS agent editing files — does
not work.

The value is produced by `vllmExtraArgs()` in
[`server/lib/qwenAgentParsers.js`](../../server/lib/qwenAgentParsers.js), the one
table holding the per-runtime parser spellings (SGLang needs different ones for
the same model). Edit it there, not here — `qwenAgentParsers.test.js` asserts
this doc still quotes the table, so the two cannot drift apart.

### 1a. Extra requirements on WSL2

Three settings native Linux does not need. Each one fails in a way that points
somewhere other than WSL, which is why they are spelled out separately.

**`VLLM_WSL2_ENABLE_PIN_MEMORY=1` is mandatory, not a tuning knob.**
vLLM turns pinned host memory off whenever it detects WSL, and its GPU model
runner allocates UVA buffers that require it — so without this the engine never
initializes. The container dies with `RuntimeError: UVA is not available` and,
because compose restarts it `unless-stopped`, quietly crash-loops instead of
failing once. A current WSL2 kernel does support pinned memory; vLLM just leaves
it opt-in. Put it in `.env` next to the other knobs:

```bash
echo 'VLLM_WSL2_ENABLE_PIN_MEMORY=1' >> .env
```

Upstream's WSL2 notes predate this code path and do not mention it. On native
Linux it is unnecessary.

**`PYTORCH_CUDA_ALLOC_CONF=expandable_segments:False` is also mandatory.**
Expandable segments rely on CUDA's virtual-memory-management APIs, which WSL2
supports only partially. With them on, weight loading dies seconds in,
inside `gptq_marlin_repack`, with a generic
`torch_call_dispatcher("aten::empty", …) API call failed` — which reads like an
out-of-memory error and is not one. It reproduces on a completely idle 24 GB card
at `GPU_UTIL=0.70`, with both the base and `-fast` checkpoints, while the repack
op itself works correctly when called directly. Upstream lists this as an
escape hatch for memory trouble; on WSL2 it is a precondition for starting at
all.

**Raise the VM's memory ceiling before running `prepare`.** The
requantization step is CPU-side and memory-hungry — `quant_lm_head.py` holds a
whole 2.5 GB shard plus several float32 copies of a 248k-row `lm_head` — and
WSL2 defaults to a ceiling of half the host's RAM. On a 32 GB machine that 16 GB
ceiling is not enough: the step is SIGKILLed and the only symptom is a bare
`Killed` with exit 137, which says nothing about WSL. Give the VM ~24 GB and some
swap in `%UserProfile%\.wslconfig`, then `wsl --shutdown` for it to take effect:

```ini
[wsl2]
memory=24GB
swap=16GB
```

Stop any containers cleanly first — `wsl --shutdown` takes the whole VM down,
including a PostgreSQL container a PortOS install is using. The download half of
`prepare` is unaffected and resumes where it left off, so a run killed here costs
minutes, not the 20 GB again.

### 1b. Start it and confirm

**The card must be otherwise empty.** vLLM's startup gate compares free VRAM
against `GPU_UTIL`, so another model server holding a few GB — LM Studio, Ollama,
a local image/video job — makes the container exit rather than start small. Stop
those first. If startup still dies on memory, upstream's escape hatch is
`GPU_UTIL=0.93` (the documented WSL2 fallback) in `.env`. Capping board
power with `nvidia-smi -pl 250` is worth doing on a 3090.

Confirm it serves before touching PortOS:

```bash
curl -H "Authorization: Bearer $VLLM_API_KEY" http://127.0.0.1:18020/v1/models
```

On Windows, confirm the same URL answers from the PortOS side too — Docker
Desktop / WSL2 localhost forwarding is what makes a container in the VM
reachable at `127.0.0.1` on the host.

### 1c. Point PortOS at the project (Windows only)

A native-Win32 PortOS resolves the default `~/qwen-serving` to a *Windows* home
directory, where the project is not. Set `VLLM_QWEN_PROJECT_DIR` to the distro's
UNC path so the readiness checklist can see the project and its `models/`:

```
VLLM_QWEN_PROJECT_DIR=\\wsl.localhost\<distro>\home\<user>\qwen-serving
```

Node reads that path, and `docker compose` accepts it as a working directory, so
both the checklist and the Start button work from it. On Linux the default is
already correct.

**`DFLASH_TOKENS=15` is deliberately not a default.** It is the setting behind
the headline throughput number, but it costs KV cache: 56k context across 4
slots is too tight for CoS agent prompts, which carry a repo's worth of files.
Lookup drafting stays on either way. Set it in `.env` yourself if you have a
workload that fits.

### 2. Enable the provider (PortOS)

1. On **AI Providers**, enable **OpenCode vLLM TUI (Qwen3.8-27B)**.
2. Paste the `VLLM_API_KEY` from your `.env` into the provider's API key field.
   PortOS injects it into the spawned OpenCode's `provider.vllm.options.apiKey`;
   without it the container answers 401 and the model list stays empty.
3. Click **Refresh Models**. The served model should appear; the seeded alias is
   `qwen3.8-27b`, so update the default model if your container publishes a
   different id.
4. Under **Generation Defaults** on the same card, set **thinking off** and
   **temperature 0.7** (see below).
5. Assign the provider to a CoS agent task.

**Turn thinking off for agent work.** Qwen3.8's tool-call format is markedly more
reliable with `enable_thinking: false`, and every measurement in the
[bring-up record](../research/2026-08-21-qwen38-rtx3090-vllm.md) was taken that
way. The provider card's **Generation Defaults** block is where you set it:
PortOS emits the toggle as `chat_template_kwargs.enable_thinking` on the spawned
OpenCode's `agent.build`, which is how vLLM takes it. Temperature ~0.7 is the
matching default for coding work.

Both controls ship **unset**, not pre-filled — an unset control means the
container keeps its own chat-template default, which is not the same as being
pinned to a value. So this is a step you take once per install, not something
the preset does for you.

The provider card's requirements checklist probes `:18020` directly. Its
**Start** button runs `docker compose --profile single up -d` — but only when it
can see a prepared project (a compose file in `~/qwen-serving`, or wherever
`VLLM_QWEN_PROJECT_DIR` points) **and** confirm the weights are already on disk.
It never builds and never downloads. `prepare` writes them into the project's own
`models/` directory (compose bind-mounts `${MODELS_DIR:-./models}`), which is
what PortOS looks at; the `qwen-cache` docker volume alongside it holds only the
torch.compile / Triton / FlashInfer JIT caches. If PortOS cannot read that
directory at all — the normal case on Windows before `VLLM_QWEN_PROJECT_DIR` is
set to the UNC path above — the button says so, and `VLLM_QWEN_WEIGHTS_DIR` is
the escape hatch for weights kept somewhere else entirely.

## What the numbers mean

The ~381 tok/s figure quoted upstream is *document reproduction*: 15 of 16
drafted tokens accepted straight from the context lookup. Ordinary chat is
around 133 tok/s. A coding agent — files in context, patches written back — sits
between the two, which is the workload the speculative path is actually for.
Prefix caching is the other half: on a 25k-token document, upstream measured
time-to-first-token dropping from 22.4 s on the first turn to 0.56 s on the
follow-up, which is what makes a multi-turn TUI session feel different from a
one-shot completion.

## Environment overrides

| Variable | Default | Purpose |
|---|---|---|
| `VLLM_QWEN_PROJECT_DIR` | `~/qwen-serving` | Where the compose project was cloned. Required on Windows, as the `\\wsl.localhost\…` UNC path. |
| `VLLM_QWEN_WEIGHTS_DIR` | *(unset)* | The directory holding the model weights, when it is not the project's own `models/` — e.g. a `MODELS_DIR` pointed elsewhere, or a HuggingFace hub cache shared with another stack. |

## Related

- [MTPLX](./mtplx.md) — the Apple Silicon native-MTP equivalent.
- [DFlash 2 / DSpark on llama.cpp](./dflash2.md) — the llama-server path, and the
  2026-08-19 evaluation that concluded PortOS should not vendor an unmerged
  engine patch. That conclusion still holds; what changed is that upstream froze
  a working container for this exact card, so PortOS points at it instead of
  building it.
- [The 3090 bring-up record](../research/2026-08-21-qwen38-rtx3090-vllm.md) — the
  measurements behind the numbers above, and how each required setting was found.
- [SGLang Qwen3.8-27B on Hopper / Blackwell](../research/2026-08-21-sglang-qwen38-27b.md) —
  why this 3090 container is **not** replaced by the official SGLang recipes
  (no 3090 cell; different tool-parser spelling; Claude Code is available there
  via native Anthropic `/v1/messages`). Follow-up issues: #4776, #4777, #4778.
- [docs/PORTS.md](../PORTS.md) — why `:18020` sits outside the 5553–5569 range.
