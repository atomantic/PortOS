# Local LLM performance audit — Qwen3.8, coding, vision, writing, and TUI harnesses

Date: 2026-08-22

This is the point-in-time record of the local-model evaluation that drives the
recommendations in **Models → LLMs**, **Models → Performance**, and **AI
Providers**. It is intentionally scoped to model behavior and runtime choices;
it contains no machine identity, private network names, credentials, or user
content.

## Executive decision

| Use case | Model | Runtime and harness | Decision |
| --- | --- | --- | --- |
| CoS coding | `qwen3-coder:30b` | Ollama + OpenCode Ollama TUI | Primary local coding path |
| Qwen3.8-27B CoS tasks | Qwen3.8-27B MTPLX checkpoint | MTPLX + OpenCode MTPLX TUI | Primary Qwen3.8 path |
| Image analysis | `qwen3.8:27b-mlx` or the MTPLX Qwen3.8 checkpoint | Ollama/OpenCode TUI or MTPLX/OpenCode TUI | Both passed the full image rubric |
| Fiction writing | Qwen3.6 Fable Fusion Q8 | Ollama for drafting; use a separate coding TUI | Best fiction-specialist candidate |

The coding recommendation is **Qwen3-Coder 30B through Ollama + OpenCode
Ollama TUI**. The direct runtime measurement was 66.14 tokens/second, the
disk-verifiable coding repair passed in six tool calls, and the actual PTY task
completed in 16.6 seconds.

The required Qwen3.8 recommendation is **MTPLX + OpenCode MTPLX TUI**. It
completed the same PTY task in 51.0 seconds and passed the coding, image, and
fiction structural checks. Native MLX Qwen3.8 produced the higher isolated
decoder rate (44.76 versus MTPLX's 38.92 tokens/second) but took 89.0 seconds
for the end-to-end agent task, so it is the direct-throughput and vision
fallback rather than the primary CoS TUI path.

The measurements are not interchangeable: decoder rates measure generation;
PTY times include process startup, prompt handling, tool calls, file I/O, and
verification. The UI labels the timing basis instead of presenting a blended
or synthetic rate.

## Measured harness comparison

| Harness target | PTY task | Direct decoder result | Result |
| --- | ---: | ---: | --- |
| OpenCode Ollama TUI + `qwen3-coder:30b` | 16.6s | 66.14 tok/s | Completed; best coding path |
| OpenCode MTPLX TUI + Qwen3.8-27B | 51.0s | 38.92 tok/s | Completed; best Qwen3.8 TUI path |
| OpenCode Ollama TUI + `qwen3.8:27b-mlx` | 89.0s | 44.76 tok/s | Completed; best direct Qwen3.8 fallback |
| OpenCode llama TUI + served `dflash` | 230.3s | 20.92 tok/s | Completed, but too slow for the primary path |
| Claude Ollama TUI + `qwen3.8:27b-mlx` | 314.2s | — | Completed, but not competitive locally |

The fastest raw decoder in the broader sweep was `gpt-oss:20b` at 97.88
tokens/second, followed by `qwen3.6:35b` at 86.71. Neither displaced
Qwen3-Coder for coding because the recommendation is based on task completion
and coding specialization, not tokens/second alone.

## Capability findings

The capability suite covers four distinct claims:

- **Sandbox repair:** a structured OpenCode agent loop must modify only the
  target module, preserve fixtures, and pass the verification command.
- **Image analysis:** a fixed fixture prompt is scored on required and bonus
  visual facts. Ollama image messages are converted to Ollama's native image
  payload before dispatch.
- **Story outline:** twelve structural beats are checked in order.
- **Fiction scene:** premise anchors, scene signals, minimum length,
  paragraphing, and dialogue are checked separately. This is a structural
  screen, not an aesthetic literary score; the saved prose still needs human
  review.

The strongest image results were Qwen3.8 MLX and MTPLX: 4/4 required facts and
3/3 bonus facts. Qwen3.8 Q4 and the Fable checkpoint were useful but partial;
Qwen3.8 Q8, Gemma 4, and llama/DFlash did not provide a reliable vision path
in this install. The DFlash failure was an explicit missing multimodal
projection file, not a silent quality judgment.

The Fable checkpoint passed all fiction anchors and craft checks. Several
general models also produced structurally complete scenes. The catalog labels
Fable as the fiction candidate but deliberately does not claim that a lexical
rubric proves voice, originality, or sentence quality.

## SGLang status and bring-up requirement

SGLang was **not a failed model result**. The configured local endpoint on port
18021 was unreachable because this install has no Docker runtime and no NVIDIA
GPU probe, while the shipped SGLang Qwen3.8 recipe requires an NVIDIA Hopper or
Blackwell host. The feature guide explicitly routes Apple Silicon to MTPLX or
llama.cpp instead. See [SGLang Qwen3.8-27B](../features/sglang-qwen38.md).

There is also an upstream image-pin decision still waiting for that hardware:
the repository recipe is pinned to `lmsysorg/sglang:qwen38-27b`, while the
current [SGLang Qwen3.8-27B cookbook](https://docs.sglang.io/cookbook/autoregressive/Qwen/Qwen3.8-27B)
documents `lmsysorg/sglang:dev-qwen38-27b-dflash2`. The pin was not changed
without a supported host on which to validate the parser flags and end-to-end
TUI behavior.

To produce a fair SGLang comparison, provide a supported NVIDIA host with:

1. Docker and the NVIDIA Container Toolkit.
2. The generated compose project from the SGLang feature guide.
3. The matching Qwen3.8-27B checkpoint, such as the documented FP8 H200 cell.
4. A reachable OpenAI-compatible `/v1/models` endpoint and a PortOS provider
   endpoint that is not incorrectly pointing at loopback on another machine.

Only then should the SGLang OpenCode TUI and Claude SGLang TUI be treated as
ready and measured. The source presets are disabled by default; this live
instance keeps its TUI cards visible for an explicit future test, while the
readiness checklist correctly marks them blocked until the endpoint answers.
SGLang supports speculative decoding, but there is no basis for calling it
faster than MTPLX until it runs on compatible hardware. Upstream references:
[SGLang speculative decoding](https://github.com/sgl-project/sglang/blob/main/docs_new/docs/advanced_features/speculative_decoding.mdx),
[MTPLX](https://github.com/youssofal/MTPLX).

## Catalog and provider consequences

- `qwen3-coder:30b` is a curated coding/agent entry and is marked **Best
  coding agent**.
- Qwen3.8 remains a curated general, coding, reasoning, and vision model, with
  the card explaining that MTPLX + OpenCode MTPLX TUI is the preferred Qwen3.8
  agent route and native MLX is the direct-decoder fallback.
- Qwen3.6 Fable Fusion is a curated **Fiction & writing** entry with an
  explicit structural-evidence caveat.
- The live instance defaults Ollama and OpenCode Ollama TUI to
  `qwen3-coder:30b`, and OpenCode MTPLX TUI to
  `mtplx-qwen38-27b-optimized-speed`.
- SGLang provider presets are disabled by default in the catalog. The live
  TUI cards are visible for future testing, but readiness blocks them until a
  supported endpoint exists; they are not presented as locally validated
  recommendations.

## Verification record

- Full server suite: 33,222 passing tests, 19 skipped.
- Full client suite: 9,468 passing tests.
- Focused capability, stream-transport, TUI benchmark, catalog, and UI tests
  passed after the audit changes.
- Production client build passed; the existing large-chunk warning remains a
  performance-budget warning, not a build failure.
- Live browser smoke checks confirmed the performance filters, evidence-based
  recommendation cards, actual TUI target cards, and AI Providers link.

Re-run this record after a hardware change, a runtime upgrade, or a supported
SGLang endpoint becomes reachable. Stored measurements are evidence for this
machine state, not universal model benchmarks.
