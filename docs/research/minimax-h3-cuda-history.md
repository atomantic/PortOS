# MiniMax H3 CUDA history adapter

The PortOS-owned adapter in `scripts/minimax_h3_cuda_history.py` uses the
Diffusers 0.42.0 modular FL2VA checkpoint. It shares only the source interval
CLI with MLX; it imports no reference runner. Runtime packages, model revision
and inspected encoder/layout/scheduler/decoder source hashes are recorded in
`scripts/minimax_h3_cuda_history.json` and checked before model loading.

Pass `--source-video <local-clip> --history-end-frame <exclusive-24-fps-index>`
with `--history-frames 17` to `generate_minimax_h3_cuda.py`. The selected frames
are `[end-17,end)`, after normalizing the source to 24 fps. Stereo audio uses
32 kHz samples between independently rounded absolute frame boundaries, relative
to the source video's first timestamp. Missing/short audio is refused. Source
frames are scaled onto the requested canvas without changing the prompt.

The adapter encodes a full 17-frame history chunk as five latent frames,
temporarily disabling the video encoder's three-latent output tail drop through
its normal hooked `encode()` method, then restoring it. Audio uses the posterior
mode. Both histories precede the target rows, remain at clean timestep 1 and
are excluded from scheduler updates. Target audio/video rotary time advances
by `17 * 40 / 24` units. Native unpacking drops all history before decoding.
Output remains 17n+5 frames, 124–345 frames at 24 fps (5–15 seconds), with the
existing memory placement and CPU generator. Baseline sampler shifts are 12/3;
history rejects keyframes, LoRAs and LightX2V. Baseline verification does not
verify acceleration.

Muxing uses a unique owned scratch directory beside the destination, then
atomically publishes without overwriting a completed clip. Failure and handled
cancellation remove only that scratch directory. Forced process termination can
leave its private scratch directory; it never deletes the source or an existing
output.

## Verified evidence

The weight-free fixture `scripts/minimax_h3_cuda_history_fixture.py`
ran on Windows with Python 3.13, CPU PyTorch 2.12.0, and the exact CUDA runtime
dependency pins. It uses real PyAV decoding, native modular layout, packing,
schedulers, denoising and unpacking, with small synthetic model components:

- A timestamped lossless source starting at two seconds selects frames 17–33
  and stereo samples `[22667,45333)` exactly.
- Every one of seven native denoising updates preserves five video history
  rows and 58 audio history rows, at timestep 1.
- History temporal coordinates and the target audio/video start at
  `text_token_count + 85/3` are checked explicitly.
- The native decoders receive only the 37 target video latent frames and
  207 target audio latents per channel for 124 output frames.
- Encoding failure restores the VAE tail-drop configuration. Separate runner
  tests verify pin/hook refusal, independent CUDA constraints, and publication
  failure, cancellation and race preservation.

Reproduce after installing the pinned dependencies into a separate test venv:
set `PORTOS_TEST_PYTHON` to its interpreter and `TORCHINDUCTOR_CACHE_DIR` to an
owned temporary cache, then run
`npm test --prefix server -- ../scripts/minimax_h3_cuda_history.test.js`.

## Fidelity remains unavailable

A full-model Windows/NVIDIA render of a fixed inspected moving-subject clip
against the still baseline has **not** run: the dedicated H3 CUDA runtime and
checkpoint were absent on the validation host. The CPU fixture does not prove
CUDA offload behavior, motion continuity or audio fidelity. Automatic temporal
capability remains disabled with this explicit reason. An NVIDIA H3 host must
render both cases with the same source, prompt, seed, canvas and baseline
sampler, inspect the motion seam and listen to the audio before enabling that
capability. No MLX result substitutes for this comparison.
