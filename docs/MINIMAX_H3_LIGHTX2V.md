# MiniMax H3 LightX2V on CUDA

Video Gen offers an experimental, explicit **LightX2V v1.3** speed profile on
the shipped MiniMax H3 CUDA model. Quality remains the default and keeps its
existing eight-point sampler. This profile has no measured PortOS speed claim.

Install or repair the H3 CUDA runtime, accept the existing H3 model terms,
download the base model, then select LightX2V under Speed and use its separate
Download button for the 1.38 GB adapter. Selecting a profile, restoring history,
starting PortOS, and rendering never download this adapter. A missing or corrupt
adapter is refused before queue admission. The runtime installation downloads
code dependencies, not model weights.

The supported profile is a single text or first-image clip at **1344×768**.
FFLF, continuation, chains, audio/reference conditioning, other canvases, MLX,
custom checkpoints, and conflicting sampler overrides are refused. No fallback
to Quality occurs. The resulting clip still includes H3's generated soundtrack;
audio conditioning is a separate, unsupported mode.

The adapter is the author's original split Diffusers safetensors from
[`lightx2v/Minimax-h3-Turbo`](https://huggingface.co/lightx2v/Minimax-h3-Turbo/tree/30f485ed874aa44c8183348ad361c5eabad318da).
Its immutable revision, filename, SHA-256 and schedule live in
`server/lib/minimaxH3Lightx2v.json`, shared by JavaScript and Python. The original
file records alpha 8 with rank 128: each residual uses strength × 8/128. There
is no repacking, fused QKV conversion, SwiGLU row permutation, or base-weight
fusion. Speed and character/style residuals are each attached once, before
offload captures the buffers. Duplicate adapter contents are refused.
The known LightX2V adapter is also refused as a user LoRA on the stock sampler;
its identity always requires the named profile and its matching schedule.

User LoRAs on this CUDA path must also be split Diffusers A/B safetensors with
numeric `alpha` metadata and matching H3 projection dimensions. Native, fused,
ComfyUI, incomplete, and unannotated files are refused rather than partially
applied. This restriction does not change the MLX adapter's format support.

The [author's v1.3 guidance](https://huggingface.co/lightx2v/Minimax-h3-Turbo/discussions/57)
specifies four updates and video/audio shifts 6/3 for FL2V. In the pinned
[Diffusers scheduler](https://github.com/huggingface/diffusers/blob/v0.42.0/src/diffusers/schedulers/scheduling_minimax_h3.py),
the terminal zero counts as a sigma point. PortOS therefore requests **five
points for four updates**, starting with `[1, .75, .5, .25, 0]`, shifted separately
for video and audio. The capability probe checks the real scheduler's grid and
an activation residual on a torchao int8 linear. A stale package pin or failed
probe makes the profile unavailable. CUDA adapters do not depend on a pipeline
LoRA mixin or merge into quantized parameters.

History records the requested profile and the helper's applied report: adapter
identity and digest, schedule, shifts, effective sigma grids, inference time,
peak allocated GPU memory during inference, and no-fallback status. These
measurements describe one render, not a speed guarantee.

## Validation and paired renders

Deterministic tests cover request admission through the real helper parser,
stock arguments, mode/canvas and override refusal, terms, stale runtime, cache
and digest failure, migration preservation, and numerical speed/style stacking
without changing a quantized base. The optional numerical test accepts
`PORTOS_H3_TEST_PYTHON` pointing to a torch+safetensors interpreter.

A full H3 render comparison remains required before claiming a measured gain.
On the same supported CUDA machine, render Quality and LightX2V with identical
prompt, seed, 1344×768 canvas, frame count, offload profile and user LoRAs. Record
both cold-load and warm inference timing, peak memory, runtime fingerprint and
the two outputs. Inspect motion, prompt adherence, detail, soundtrack, and
character/style fidelity; retain the actual inspection evidence. Repeat for a
first-image request. Stock uses its prior sampler; do not change its step count
to manufacture a comparison. A Mac benchmark cannot establish CUDA performance.

MLX integration and paired full-model hardware/quality results are separate
remaining work; this CUDA slice does not imply support or performance there.
