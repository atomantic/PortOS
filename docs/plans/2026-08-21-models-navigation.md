# Models navigation + multi-runtime measured assessments

**Date:** 2026-08-21

## Context

Two problems, one shape.

**1. Measured assessments only knew two runtimes.** `services/localModelAssessments.js`
could measure a model on Ollama or LM Studio and nothing else, because the only
measurement path it had was `runLocalLlmTest`, which resolves a configured PortOS
*provider*. Meanwhile PortOS already knows how to reach three more local daemons
— llama.cpp (`llama-server`, which PortOS itself launches), MTPLX, and vLLM — all
speaking the same OpenAI-compatible wire protocol. Those were exactly the
runtimes whose performance is most sensitive to how they were *launched*, and the
feature had nothing to say about them.

**2. The assessment recorded no configuration.** A throughput number for a GGUF
is meaningless without the launch line that produced it: the same model on the
same machine streams at wildly different rates depending on the micro-batch size,
whether flash attention is on, and how much of the KV cache is quantized. Two
readings of one model looked like noise when they were actually two different
setups, and there was no way to ask "is `-ub 512` worth it here?".

**3. Model management was a scroll position.** Memory residency, measured
assessments, backend install/switch, the llama.cpp launcher, and the install
catalog were all cards stacked on `/settings/local-llm` — one long page, none of
it individually linkable, all of it filed under Settings even though "which model
should I run?" is not a settings question.

## Design

### Runtimes

`ASSESSABLE_RUNTIMES` (`server/lib/localProviderRuntime.js`) is the roster:
`ollama`, `lmstudio`, `llama`, `mtplx`, `vllm`. The split is about *how PortOS
reaches the model*, not about measurement quality:

| Kind | Runtimes | Model list | Measurement |
| --- | --- | --- | --- |
| Managed | ollama, lmstudio | `listModels()` — a durable catalog on disk | `runLocalLlmTest` (provider path, lands in `/runs`) |
| Endpoint | llama, mtplx, vllm | `GET /v1/models` on the live daemon | `runEndpointLlmTest` — direct, no `/runs` record |

The distinction matters for the sentinel contract. A managed backend's list
survives the daemon being down. An endpoint runtime has no catalog at all, so a
stopped daemon means *the list could not be read* — an error, never an empty
catalog. Reporting "0 models" for a daemon the user only needs to start would
hide every model behind it.

The SSE read loop moved to `server/lib/openAiChatStream.js` so both paths share
one implementation of the reasoning-channel handling, the skip-a-malformed-frame
rule, and partial-output-on-abort.

### Tuning

`server/lib/localModelTuning.js` holds the knob catalog. Every knob declares what
PortOS can actually **do** with it:

- `launch` — PortOS puts it on the daemon's command line (llama.cpp only:
  `-b`, `-ub`, `-t`, `--flash-attn`, `--cache-type-k|v`, `--spec-draft-n-max`).
- `request` — sent with each measurement request (Ollama's `num_ctx`).
- `record` — PortOS cannot set it; the user states how the daemon was launched so
  two readings stay comparable (LM Studio, MTPLX, vLLM).

A `record` knob is not a lie by omission — it changes nothing about the run and
the UI says so. What it must never do is claim to have been applied, which is why
the `applies` axis is on the spec rather than implied, and why a `request` knob
must also declare the wire field name it maps to.

`relaunchLlamaServerWithTuning` is the launch half: it reads the running config,
merges the requested knobs, and restarts llama-server under PM2. It **refuses
rather than guesses** when nothing is running (no model path to reuse) or when
the process was started outside PortOS (stopping it would kill something the user
owns) — returning `{ applied: false, reason }` so the run can still measure
whatever is actually serving and record that the tuning was NOT applied. A
reading taken under a tuning PortOS could not apply must never be filed as
evidence for that tuning.

### Store identity

`assessmentKey(backend, modelId, tuningKey)` returns `backend:modelId` when the
tuning signature is empty and `backend:modelId@<signature>` otherwise. That is
deliberate: an untuned run keys byte-identically to the pre-tuning key, so every
record already on disk keeps resolving with **no migration**, while a tuned run
of the same model lands beside it instead of overwriting it. Two tunings are two
answers to two different questions; re-running the *same* tuning still
supersedes, because a stale reading of one configuration is worse than none.

`compareTunings` groups by (backend, model) and reports each variant's throughput
as a percentage of the winner. Models measured under only one tuning are omitted
— one reading is not a comparison, and presenting it as "the best tuning" would
dress a single measurement up as a conclusion.

### Navigation

A top-level **Models** section, with `/models/:tab`:

- **LLMs** (`/models/llms`) — backends, install catalog, llama.cpp launcher.
- **Performance** (`/models/performance`) — measured assessments + tuning comparison.
- **Status** (`/models/status`) — what is resident in memory right now.
- **Playground** (`/local-llm/playground`) — unchanged path, now listed here.

`/settings/local-llm` redirects to `/models/llms` so bookmarks and stale ⌘K
history keep working, and `Local LLMs` is gone from the Settings sub-nav. Each
tab is a route param, so all four are deep-linkable and reachable from ⌘K and
voice (`NAV_COMMANDS` gained `nav.models.performance` and `nav.models.status`;
`nav.settings.local-llm` keeps its opaque id and moves to the `Models` section).

## Verification

- `server/lib/localModelTuning.test.js` — knob catalog invariants (every knob
  declares `applies`; every `request` knob declares its wire name; only llama.cpp
  carries launch knobs), normalize/clamp/coerce, signature stability, and the
  comparison rules.
- `server/services/localModelAssessments.test.js` — endpoint-runtime listing and
  measurement, endpoint resolution from the live llama-server, two tunings
  coexisting, same-tuning replacement, per-tuning delete, `tuningApplied: false`
  recording, and the runtime roster's `null`-vs-`0` model count.
- Full server (1540 files) and client (700 files) suites pass.

## Follow-up

The rest of the model management followed in
[#4728](https://github.com/atomantic/PortOS/issues/4728): media checkpoints
(`/models/media`), LoRAs (`/models/loras`), LoRA training
(`/models/training`), embeddings (`/models/embeddings`) and the image-to-3D
runtimes (`/models/3d`) all moved in from Create and Settings, and Dev Tools'
`/system-resources/models` folded into `/models/status`. Every old path
redirects, and every moved command keeps its opaque id.

Two things deliberately stayed out, because they are output or generation rather
than installed weights: Three.js Models is a gallery of generated meshes, and
`/3d` is the render flow that consumes the runtimes now listed under Models.
Audio models stayed with the Music studio as well — the model picker there drives
install-on-demand for the model being generated with, so it is not separable from
the generate form.
