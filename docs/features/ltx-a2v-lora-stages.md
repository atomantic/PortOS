# LTX audio-to-video user LoRA stages

Video Gen offers separate **Motion** and **Detail refinement** multipliers beside
the LoRA selection for local LTX MLX A2V runtimes that pass the capability probe.
Each finite multiplier is between 0 and 1. It multiplies every selected user
LoRA's existing strength; it never increases that strength or guesses which
adapter represents a character.

The default `[1, 1]` retains the legacy adapter path. **Motion-friendly `[0, 1]`**
suppresses user-adapter deltas during motion generation and restores their
selected strengths during detail refinement. This is an explicit creative
control, not a measured promise of improved lip sync or likeness. Distilled
and IC adapters keep their existing roles and strengths. Prompt text, supplied
audio and A2V duration rules are unchanged.

The API field is `a2vLoraStageStrengths: [motion, detail]` (JSON-encoded for
multipart submissions). Queue replay, retry and Load Params preserve it.
Non-default selections require a selected user LoRA and a pinned LTX MLX A2V
runtime with validated stage seams. CUDA, hosted and peer execution refuse them
before enqueue or retry replacement. Switching backend retains the explicit
selection and exposes Reset; it never silently drops the schedule.

History records the requested multipliers as well as the existing adapter
application report. Render details show both requested and applied strengths.
For a scheduled user adapter, `strength` is its effective strength at the named
stage, and `selectedStrength` and `multiplier` explain how it was computed.
Legacy reports continue to use `stages: ["all"]`.

## Validation

Tiny MLX fixtures run on the CPU, with no model weights or provider calls. They
exercise packed, float and block-streamed projections, multiple adapters,
reloads, repeated renders, failure/cancellation, restoration and transformer
release. Both inspected runtime pins pass the import-and-seam probe. The
request/worker tests cover the helper arguments and history; form tests cover
preservation and explicit reset.

The fixed-seed paired character comparison ([#13662](https://github.com/atomantic/PortOS/issues/13662)) remains unverified: the development
install has no existing compatible LTX character LoRA. No new weights were
downloaded. On Apple Silicon with existing A2V weights and a compatible
character adapter, render `[1, 1]` and `[0, 1]` with identical prompt, seed,
audio, still, dimensions, frame count, sampler and runtime. Inspect mouth
movement, audio timing and likeness, and record wall time plus peak memory.
Keep source assets and instance identifiers private; publish only consented
media or redacted observations. A completed comparison must distinguish measured
PortOS results from expectations or upstream claims.
