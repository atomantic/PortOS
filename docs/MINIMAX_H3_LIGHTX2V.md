# MiniMax H3 LightX2V

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

## MLX INT8 profile

The separate `lightx2v-mlx-v1.3-4step` profile targets the shipped
`minimax_h3_8bit` row, its exact transformer revision, and the pinned
`PipeNetwork/minimax-h3-mlx` runtime revision
`fcd9e9b79a1d6018d91ac477c0968de1fa067e49`. Its complete contract lives in
`server/lib/minimaxH3Lightx2vMlx.json`. The CUDA profile does not admit MLX;
the two profiles retain separate runtime and model identities. The MLX contract
also pins the upstream checkpoint and complete component manifest, refusing
custom conditioner/VAE manifests before queue admission.

MLX keeps its stock sampler and existing settings when Quality is selected.
The optional profile uses the same original, digest-pinned adapter and the
existing explicit, terms-gated adapter download. Rendering uses cached weights.
Only single text or first-image clips at 1344×768 are supported. Other
quantizations, runtime pins, canvases, continuation, chains and conflicting
sampler overrides are refused.

The pinned MLX scheduler accepts five sigma points for four updates. Its
model timestep is `t = 1 - sigma`, and its predicted velocity points toward
the data. PortOS sets the pipeline's independent video/audio shifts to 6/3
before the existing scheduler builds its grids; it does not substitute CUDA's
velocity sign or step implementation. The runtime source seams are verified
before loading weights. The original split adapter is applied through PortOS's
activation residual adapter, preserving packed base weights and the adapter's
alpha/rank scaling. Speed and user adapters each enter the stack once.

Applied reports distinguish denoiser time from whole-pipeline time and cold
model loading. Peak memory covers the pipeline call, including conditioning
and decode; it is not a denoiser-only allocation measurement.

MLX evidence must be collected independently using the paired-render protocol
above, with the stock MLX sampler unchanged. Retain actual private outputs and
inspection notes for both text and first-image pairs, exact fingerprints,
cold-load and inference timings, peak memory, and any fidelity regressions.
Deterministic fixtures alone establish neither a performance gain nor visual
or soundtrack quality. No measured MLX speed or quality claim is made here.


## Pika H3 Flex on MLX

The same pinned INT8 row also offers `pika-h3-flex-mlx-6step`, an experimental,
explicit Pika Labs profile for **640×384, 1024×576 and 1344×768**, in text or
first-image mode. Powered by MiniMax H3. Quality remains the default. PortOS has
not benchmarked this profile or inspected paired full renders, so no measured
speed or quality claim is made. The paired-render protocol above applies
independently to each supported canvas and mode.

The contract in `server/lib/minimaxH3FlexMlx.json` follows the
[Pika FL2VA manifest](https://huggingface.co/Pika-Labs/Pika-H3-Flex/blob/0ddf55ad7067ca1e76812253bd7b4600df87f759/fl2va/manifest.json):
knots `[1000, 750, 500, 250, 100, 40, 0]`, independent video/audio shifts 12/3,
and six re-noise updates. The terminal zero is the seventh sigma point, so the
runner receives seven points. Each update predicts `x0 = x_t + sigma * v`, then
mixes `x0` with fresh noise at the next sigma; the terminal update uses `x0`
directly. It does not use the old sample's Euler blend.

PortOS owns this small scheduler adapter; it keeps the existing upstream runtime
pin and verifies the scheduler, pipeline and configuration source seams before
loading weights. Its capability probe executes six updates for both modality
grids without loading a model. It does not install Phosphene's runner fork.
Pika's base revision `42ed227ee7df40d41602854ae760620d6eb651fe` and the existing
auxiliary checkpoint revision `6818f6c32d12b210915e44ad56a4228c2608f160` have
identical LFS SHA-256s for all 13 FL2VA transformer shards.

Download explicitly to cache Pika's original 2.77 GB F32 adapter, pinned release
manifest, LICENSE and NOTICE from its original repository. Admission and the
Python helper verify their digests; rendering never downloads them. The adapter
is a MiniMax H3 Model Derivative by Mellis, Inc., under the MiniMax H3 Community
License and its existing territory restrictions. The original file is not
repacked or redistributed by PortOS. Runtime residuals use the manifest's
alpha=rank=128 and BF16 precision, leaving quantized base weights intact.
The existing LoRA applicator handles split Q/K/V and SwiGLU row layout, and
character/style adapters retain their own precision and scaling.

FFLF, continuation, reference/audio conditioning, chains, custom model pins and
conflicting sampler overrides are refused. A renamed Flex adapter cannot be
used as a user LoRA under Quality or another speed profile. History records the
applied profile, original adapter identity, effective sigma grids, knots, sampler,
timing and pipeline peak memory without implying a performance guarantee.
