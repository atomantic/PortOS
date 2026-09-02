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

That default is for a mixed workstation. If this machine is intentionally the
always-on model appliance for several PortOS installs, configure Docker to
restart the container unless stopped and let the GPU stay allocated. The
[fleet LLM host guide](./fleet-llm-host.md) covers the Tailscale endpoint,
client-side OpenCode/API providers, and fallback policy for that topology.

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

### 1. Prepare the stack (on the 3090 host)

The host itself is yours: Docker, the NVIDIA Container Toolkit (driver ≥ 580 /
CUDA 13), and — on Windows — WSL2. PortOS will not install any of those; they are
operator decisions with driver requirements it cannot judge, and the readiness
checklist's **Install** button keeps saying so.

The *project* on top of them can go either way.

#### 1-click, from the checklist

On a host that already has Docker and the NVIDIA runtime, the provider
readiness checklist offers **"Clone, build & prepare vLLM (Qwen3.8-27B) (~30 GB),
then start"**. The label names the payload because the click IS the consent — this
is the one button in PortOS that spends tens of gigabytes. It clones this repo,
writes the `.env` below (including the settings in §1a, which is the point), builds
the image, runs `prepare`, and brings the container up, streaming every line.

It is idempotent: re-running skips whatever already landed, and `prepare`'s
download resumes, so a cancelled run costs minutes rather than the 20 GB. An
existing `.env` is never overwritten — only keys it does not already mention are
appended, so your `GPU_UTIL`, `DFLASH_TOKENS` or your own `VLLM_API_KEY` survive.
The API key it generates is written straight onto the two seeded providers, so
step 2 below is just "enable it".

**On Windows it places the project inside WSL2 for you.** The default
`~/qwen-serving` resolves to a *Windows* home, and 20 GB of weights reached from
the WSL2 VM across a 9p share is a mistake that costs 20 GB to discover — so
before it clones anything, PortOS asks WSL for the default distro's name and home
(`wsl.exe -e sh -c 'echo "$WSL_DISTRO_NAME"; echo "$HOME"'`), checks that
`\\wsl.localhost\<distro>\home\<user>` is readable from Windows, and records
the result as `VLLM_QWEN_PROJECT_DIR` in PortOS's own `.env` so the readiness
check, the Start button and the next server boot all resolve the same directory.
It refuses only where it genuinely cannot answer the question — no WSL on the
host, no distro but a container engine's own (`docker-desktop` is recreated on a
reset), or a `\\wsl.localhost` share Windows cannot read — and each refusal
names that host's fix. Setting `VLLM_QWEN_PROJECT_DIR` yourself still overrides
the whole decision (§1c).

The one thing it deliberately will not do is raise the WSL2 memory ceiling — see
§1a for why that one stays manual.

#### By hand

Still fully supported, and the explanation of what the button does. Run the
commands below *inside the WSL2 distro*, not in PowerShell — the compose project
and its 20 GB of weights belong on the Linux filesystem.

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

**Raise the VM's memory ceiling before running `prepare` — including before the
1-click action.** This is the one step PortOS detects and warns about but never
performs, because `wsl --shutdown` takes the whole VM down, including a
PostgreSQL container a PortOS install may be using. The
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

### 1c. Point PortOS at the project (Windows, optional)

A native-Win32 PortOS resolves the default `~/qwen-serving` to a *Windows* home
directory, where the project is not. **You do not normally have to fix this
yourself** — the provisioning button and the Start button both detect the distro
and record the UNC path (see above). Set `VLLM_QWEN_PROJECT_DIR` only to overrule
that, or when you cloned by hand somewhere other than the default distro's home:

```
VLLM_QWEN_PROJECT_DIR=\\wsl.localhost\<distro>\home\<user>\qwen-serving
```

Node reads that path, and `docker compose` accepts it as a working directory, so
both the checklist and the Start button work from it. An exported value wins over
anything PortOS detected on an earlier run. On Linux the default is already
correct.

**`DFLASH_TOKENS=15` is deliberately not a default.** It is the setting behind
the headline throughput number, but it costs KV cache: 56k context across 4
slots is too tight for CoS agent prompts, which carry a repo's worth of files.
Lookup drafting stays on either way. Set it in `.env` yourself if you have a
workload that fits.

### 2. Enable the provider (PortOS)

1. On **AI Providers**, enable **OpenCode vLLM TUI (Qwen3.8-27B)**.
2. Check the API key field. The 1-click path already filled it in; after a
   by-hand setup, paste the `VLLM_API_KEY` from your `.env`. PortOS injects it
   into the spawned OpenCode's `provider.vllm.options.apiKey`; without it the
   container answers 401 and the model list stays empty.
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
It never builds and never downloads — that is the separate,
explicitly-named provisioning action above. `prepare` writes them into the project's own
`models/` directory (compose bind-mounts `${MODELS_DIR:-./models}`), which is
what PortOS looks at; the `qwen-cache` docker volume alongside it holds only the
torch.compile / Triton / FlashInfer JIT caches. If PortOS cannot read that
directory at all, the button says so, and `VLLM_QWEN_WEIGHTS_DIR` is the escape
hatch for weights kept somewhere else entirely. On Windows the Start button first
resolves the WSL2 placement described above, so a project prepared by hand inside
the distro is found without any configuration.

## What the numbers mean

The ~381 tok/s figure quoted upstream is *document reproduction*: 15 of 16
drafted tokens accepted straight from the context lookup. Ordinary chat is
around 133 tok/s. A coding agent — files in context, patches written back — sits
between the two, which is the workload the speculative path is actually for.
Prefix caching is the other half: on a 25k-token document, upstream measured
time-to-first-token dropping from 22.4 s on the first turn to 0.56 s on the
follow-up, which is what makes a multi-turn TUI session feel different from a
one-shot completion.

## Why not the EXL3 3.5-bpw kit by default?

The [MiaAI-Lab EXL3 deployment kit](https://github.com/MiaAI-Lab/Qwen3.8-27B-DFlash2-EXL3-5.0bpw)
is a credible long-context alternative: its 14.2 GB target plus the in-checkpoint
MTP head leaves enough room for a Hadamard-4 KV cache at the model's native 262k
window on a 3090. Its DFlash2 draft is about 1.4 GB and trades some of that
context for throughput.

It does not replace this recipe yet. The EXL3 kit's published throughput and
quality rows were measured on a DGX Spark/GB10, while the maintainers explicitly
describe RTX performance as an unmeasured expectation. Its included server also
generates one request at a time and queues concurrent calls. This vLLM stack has
reproducible 3090 measurements, structured tool calling, prefix caching, and
multi-request operation — better evidence for an always-available fleet service.
Re-evaluate after the EXL3 stack publishes 3090 agent/tool benchmarks and a
concurrent server result.

## Environment overrides

| Variable | Default | Purpose |
|---|---|---|
| `VLLM_QWEN_PROJECT_DIR` | `~/qwen-serving`, or the `\\wsl.localhost\…` path PortOS detected and recorded in its own `.env` on Windows | Where the compose project was cloned. Set it only to overrule the detected placement — an exported value wins over the record. |
| `VLLM_QWEN_WEIGHTS_DIR` | *(unset)* | The directory holding the model weights, when it is not the project's own `models/` — e.g. a `MODELS_DIR` pointed elsewhere, or a HuggingFace hub cache shared with another stack. |

## Related

- [MTPLX](./mtplx.md) — the Apple Silicon native-MTP equivalent.
- [Dedicated fleet LLM host](./fleet-llm-host.md) — expose this authenticated
  runtime over Tailscale and create OpenCode/API providers on peer installs.
- [DFlash 2 / DSpark on llama.cpp](./dflash2.md) — the llama-server path, and the
  2026-08-19 evaluation that concluded PortOS should not vendor an unmerged
  engine patch. That conclusion still holds; what changed is that upstream froze
  a working container for this exact card, so PortOS points at it instead of
  building it.
- [The 3090 bring-up record](../research/2026-08-21-qwen38-rtx3090-vllm.md) — the
  measurements behind the numbers above, and how each required setting was found.
- [SGLang Qwen3.8-27B](./sglang-qwen38.md) — the Hopper / Blackwell path that
  shipped from that evaluation. It does **not** replace this container: the
  SGLang cookbook publishes no 3090 cell, so Ampere 24 GB stays here. The two
  also spell the tool-call parser differently (`qwen3_xml` here,
  `qwen3_coder` there), which fails silently if crossed. Background:
  [the evaluation note](../research/2026-08-21-sglang-qwen38-27b.md).
- [docs/PORTS.md](../PORTS.md) — why `:18020` sits outside the 5553–5569 range.
