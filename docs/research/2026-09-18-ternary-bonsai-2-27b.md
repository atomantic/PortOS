# Ternary Bonsai 2 27B — harness and runtime on Apple M5 Max

Date: 2026-09-18

## Decision

Run it on **llama.cpp built from the PrismML fork's source**, served by
**`llama-server`** — which is PortOS's existing `llama` local runtime, so the
model needed a launcher preset (`ternary-bonsai-2-27b` in
`server/lib/specDecodePresets.js`) and no new runtime, provider kind, or
process manager.

Take the **`PQ2_0`** pack (6.7 GiB on disk), not the smaller `PTQ1_0` (5.9 GB)
and not the `F16` reference (53.8 GB).

Three runtimes that look plausible are not options here:

- **Ollama and LM Studio** both embed a stock llama.cpp and cannot load the
  file. This is why the model is absent from `server/lib/localLlmCatalog.js`,
  which is the Ollama↔LM Studio catalog; that module now carries a note saying
  so, because the failure mode on the neighbouring Bonsai 1 pack is silent.
- **Stock llama.cpp** — including the Homebrew build this machine already had
  on PATH — refuses `PQ2_0` and `PTQ1_0` as unknown types. Measured below.
- **MLX** has a pack (`prism-ml/Ternary-Bonsai-2-27B-mlx-2bit`, 8.60 GB) and it
  is the faster-on-paper option, but it declares `model_type:
  prism_hadamard_qwen35` and ships its own loader in `runtime/`. An ordinary
  MLX loader skips the activation transform and the inverse embedding lookup
  and returns *wrong output rather than an error*. It also exposes no
  OpenAI-compatible server, so PortOS would have to grow one — where
  `llama-server` already speaks the protocol every PortOS provider path uses.

## What the model is

PrismML's ternary pack of Qwen3.8-27B, published 2026-09-17 under Apache 2.0.
Weights are `{−1, 0, +1}` with one FP16 scale per group of 128, covering
embeddings, attention projections, MLP projections and the LM head — 2.13
effective bits per weight for `PQ2_0`. The publisher reports an aggregate 84.78
across 14 thinking-mode benchmarks, 98.2% of the FP16 baseline, at roughly 11%
of its size. 262K context, and a vision tower via a separate `mmproj` sidecar.

`PQ2_0` over `PTQ1_0` is the publisher's own guidance and it matches the
hardware: `PQ2_0` is the pack measured on Apple Silicon and the faster
prompt-processing pack on every backend, while `PTQ1_0`'s decode advantage is
specific to Ada-generation and L4 cards. The 1.3 GB saved is irrelevant on a
128 GB machine.

## Measurements

Apple M5 Max, 128 GB unified memory, macOS 26.6.2. `llama-bench -p 512 -n 128
-r 2` against `Ternary-Bonsai-2-27B-PQ2_0.gguf` (6.70 GiB, 26.90 B params,
reported by the loader as `qwen35 27B PQ2_0 - 2.13 bpw (group 128)`).

| Binary | Prompt (pp512) | Decode (tg128) |
| --- | ---: | ---: |
| Fork built from source (`5d80cff`, AppleClang 21) | 701.76 ± 5.64 t/s | 40.57 ± 1.36 t/s |
| Fork prebuilt `macos-arm64` asset (`prism-b10685`) | 243.57 ± 2.64 t/s | 38.45 ± 1.52 t/s |
| Homebrew llama.cpp 0.4.0 (build 10809) | failed to load model | — |

**Build the fork; do not use its published macOS binary.** The prebuilt
`llama-prism-*-bin-macos-arm64.tar.gz` was compiled on an older macOS runner,
so on this OS it logs `ggml_metal_library_init_from_source: error compiling
source` and then `the tensor API is not supported in this environment -
disabling`. It still runs, which is the trap — it just does prompt processing
**2.9× slower**. Decode barely moves, because decode is memory-bandwidth bound
and the Metal 4 tensor path is a compute win. The fork's own HEAD commit is
`release: build macOS arm64 on macos-26 so the Metal 4 tensor path compiles
(#177)`, dated two days before this evaluation, so the published macOS asset
should catch up; verify `has tensor = true` in the startup log before trusting
one.

Decode landed ~14% under the publisher's ~47 t/s figure for this chip. The most
likely explanation is contention rather than a configuration fault: the machine
was running other work throughout, and the `has tensor = true` line confirms the
fast path was active.

The preset's own launch line was then run end to end
(`--spec-type none --ctx-size 8192 -ngl 99 --parallel 1 --alias …`):
`/v1/models` reported the alias and `/v1/chat/completions` returned the
requested string with a coherent token count, so the OpenAI-compatible surface
every PortOS provider path depends on works against this pack unmodified.

## Recipe

Weights and binaries are machine-local; none of this belongs in the repository.

```bash
# 1. Build the fork (Metal is the default on macOS; the CUDA flag is Linux/Windows)
git clone --depth 1 https://github.com/PrismML-Eng/llama.cpp.git \
  ~/.portos/runtimes/llama.cpp-prism-src
cd ~/.portos/runtimes/llama.cpp-prism-src
cmake -B build -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF
cmake --build build -j "$(sysctl -n hw.ncpu)"

# 2. Put it ahead of any stock llama.cpp on the PATH the PortOS server inherits
mkdir -p ~/.portos/bin
ln -sf ~/.portos/runtimes/llama.cpp-prism-src/build/bin/llama-server ~/.portos/bin/llama-server
```

PortOS resolves the binary with `findCommandOnPath('llama-server')` against the
server process's own PATH (`resolveLlamaServerBinary` in
`server/services/llamaServerManager.js`), so `~/.portos/bin` has to precede
`/opt/homebrew/bin` for the PortOS process — not merely in an interactive
shell. Its Homebrew update path already handles a foreign binary correctly: it
detects that the active `llama-server` is not the linked keg and declines to
touch it rather than overwriting the fork.

Then fetch the weights from **Models → Runtimes** by selecting the
**Ternary Bonsai 2 27B** preset and using its Download button, or by hand:

```bash
curl -L -o ~/.portos/models/Ternary-Bonsai-2-27B-PQ2_0.gguf \
  https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/main/Ternary-Bonsai-2-27B-PQ2_0.gguf
```

The preset launches with no drafter (`--spec-type none`). Sampling the
publisher recommends: thinking mode `temperature=1.0, top_p=0.95, top_k=20`;
instruct mode `temperature=0.7, top_p=0.80, top_k=20`.

### Turning on vision

The model's image input is a separate 629 MB projector sidecar. The preset
carries it as a third weight, so **Models → Runtimes** shows a *Vision
projector* row beside the base model with its own Download button; fetching it
fills the **Vision Projector / --mmproj** field under Advanced options, and the
next Start puts `--mmproj` on the launch line. Clearing that field launches the
model text-only, which is what a preset with no projector on disk does. By hand:

```bash
curl -L -o ~/.portos/models/Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf \
  https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/main/Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf
```

The repo also publishes a `BF16` projector (931 MB). PortOS pins the `Q8_0` one:
the projector is a fraction of the 6.7 GiB target either way, and a pin rather
than a quant hint because both projectors carry tags that also match language
packs in the same repo.

## Known gaps
- **Speculative decoding is untested here.** The preset drafts with nothing.
  PrismML's demo repository documents a speculative setup; nothing in this
  evaluation measured whether a drafter helps this pack.
- **The MLX pack was not measured.** Rejected on runtime-integration grounds
  (custom loader, no OpenAI-compatible server), not on performance — the two
  are within noise of each other on published numbers.
