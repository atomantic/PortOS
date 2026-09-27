# MiniMax H3 scene-continuity comparison

Issue #8867 remains an investigation. Native image-mode canvas selection landed
in commits `95b864cd1` and `1aba4b504`. It removes a confounding factor; it does
not establish that conditioning is correct or that scene continuity is fixed.

## Controlled H3 runs

`scripts/diagnose_minimax_h3.py` creates a synthetic colored room with a doorway,
cube and ball, then compares three fixed-seed, stock-encoder, no-LoRA requests:

| Case | Canvas | Prompt |
| --- | --- | --- |
| small-motion | 576×1024 | Camera moves forward; objects remain stationary |
| native-motion | 768×1344 | Same motion-only prompt |
| native-conflict | 768×1344 | Camera moves through a snowy forest |

All use 124 frames, 24 fps, seed 42 and 9 sigma entries. The script pins the
runtime and checkpoints used by the original report so registry updates do not
silently change the experiment. It calls the production adapter, including its
vision-weight, image-processor and vision-embedding corrections. It never pastes
the source over generated frames or changes conditioning tensors.

Use a **new directory outside the checkout** for each invocation. Planning needs
only Python's standard library and does not import MLX or load models:

```sh
python3 scripts/diagnose_minimax_h3.py --output-dir /tmp/h3-continuity-plan
```

Inspect `source.ppm` and `plan.json`. To render, ensure no other GPU work is
running, then use the already installed H3 interpreter and another new directory:

```sh
~/.portos/minimax-h3-mlx/.venv/bin/python3 scripts/diagnose_minimax_h3.py \
  --output-dir /tmp/h3-continuity-render --run
```

This command is expensive: the pinned runtime reports approximately 8.8 minutes
per native five-second diffusion step on its reference hardware. Three runs can
take several hours. Each render uses a separate process, runs sequentially and
stops the comparison on failure. The script does not coordinate with PortOS's
live GPU queue; run it only while that queue and other GPU applications are idle.
Weights must already be cached; child processes enforce Hugging Face offline
mode. No model download, substitute encoder or preview decoder is requested.

Each case contains the video, frames 0/1/12/60/123, a local runtime log and
`report.json`. The report separates setup, conditioning/inference, video decode,
audio decode and mux wall time. It observes the patched text encoder's embedding
shape/tags, VAE conditioning rows and first DiT call's packed shapes/tags/index
counts. These are **structural observations, not numerical parity assertions**.
Lazy work may be charged to the boundary that materializes it. Failed worker
runs retain a failed report and log; never interpret partial outputs as success.
Logs may contain local paths; redact them before publishing evidence.

## Reference parity finding: vision input geometry

A static comparison of the pinned MLX port against the vendored FL2VA reference
(`reference/diffusers/modular/` in the runtime checkout) found one divergence
on the image path. The reference setup step replaces its keyframes with
canvas-prepared copies (`prepare_keyframe_image`: stretch the first keyframe,
cover-crop a follower), and **both** the Qwen3-VL text encoder and the video VAE
read those prepared images. The port prepares keyframes only inside
`_encode_keyframes`; its text encoder received the raw upload.

With the checkpoint's processor (patch 16, merge 2, up to 16.7M pixels) each
vision token covers 32×32 pixels, the same footprint as a VAE latent patch. A
canvas-prepared 576×1024 keyframe therefore yields an 18×32 vision grid that
matches the 18×32 conditioning rows. A raw 3024×4032 photo yields about 11,800
vision tokens, and a 1920×1080 frame roughly 2,000 tokens at the wrong aspect.
Both are unlike anything the reference presents.

`generate_minimax_h3.py` now places keyframes on the canvas before calling the
pipeline, using the port's own `prepare_keyframe_image`. That function returns
a canvas-sized image unchanged, so VAE conditioning is byte-for-byte what it was
before. The vision features now follow the reference contract. Prompt-embedding
cache keys follow the prepared pixels, so older raw-image entries age out.

This fixes a real integration defect, but it is **not a confirmed root cause**
of the scene change: no render has compared the two inputs. The synthetic source
from the diagnostic is already 768×1344, so its native cases never took this
path. VAE normalization/posterior sampling, packed tags and rotary positions
matched the reference in structure and are covered by the runtime's own parity
tests. The only other difference found was the image-processor backend,
examined next.

## Reference parity finding: image-processor backends

The reference encodes keyframes with the checkpoint-declared torchvision
`Qwen2VLImageProcessor`. The MLX runner has no PyTorch, so it binds that
processor's PIL twin, `Qwen2VLImageProcessorPil`. At the pinned transformers
5.14.1, the two share `smart_resize`, BICUBIC resampling, RGB conversion, the
checkpoint's configuration (patch 16, merge 2, temporal patch 2, 65,536 to
16,777,216 pixels, mean and std 0.5) and the patch flattening order. They differ
in two ways. The twin resamples through Pillow on `uint8` and normalizes as
`(x / 255 - 0.5) / 0.5`. The reference resamples with antialiased torchvision
bicubic and normalizes as a fused `(x - 127.5) / 127.5`. Both return float32
arrays with an identical `[1, h/16, w/16]` grid.

`scripts/diagnose_minimax_h3_processor.py` runs both backends on the CPU over
deterministic synthetic images. The images are half gradient and half full-band
noise, the worst case for a resampler. The script reads only the cached
checkpoint's `FL2VA/processor` directory and never loads a model. Run it with
an existing interpreter that has transformers at the H3 lock's version, torch
and torchvision. The H3 venv has no torch, so it cannot run this check.

```sh
<python-with-torch> scripts/diagnose_minimax_h3_processor.py \
  --processor-dir <hf-cache>/models--MiniMaxAI--MiniMax-H3/snapshots/<revision>/FL2VA/processor
```

A run at transformers 5.14.1, torch 2.13 and torchvision 0.28, against checkpoint
revision `6818f6c3`, produced:

| Input (w×h) | Processor resamples | Max abs diff | bfloat16 mismatch |
| --- | --- | --- | --- |
| 576×1024, 768×1344, 1344×768, 512×288 (canvases) | no | 5.9e-8 | 0 |
| 1080×1920, 720×1280 (raw frames) | yes | 1/127.5 (one 8-bit level) | 0.1–0.2% |
| 128×256 (below the pixel floor) | yes | 2/127.5 | 10.7% |

Every H3 canvas is a multiple of 32, which is the processor's resize factor.
Canvases at H3's released sizes are also well inside its pixel bounds. After
the runner places keyframes on the canvas, the processor therefore never
resamples them. The twin's output then matches the reference to float32
rounding. After the port casts it to the vision tower's bfloat16, it is
bit-identical. The backend difference is real only for inputs the processor
resamples: raw uploads before the vision-geometry correction, or a custom canvas
smaller than 65,536 pixels. In this run that gap was at most two 8-bit levels,
and the reference resamples those inputs too. The PIL twin is **excluded as a cause** of the scene
change on the production path. No correction is warranted. The script exits
nonzero if a future transformers pin breaks this parity on a canvas.

The continuity harness now records the backend class and keyframe input sizes as
`vision_processor` in each `report.json`. A render can then show which processor
read its keyframes and whether they arrived canvas-sized.

## What remains to establish

No real render results accompany this harness. `continuity: not_assessed` stays
explicit even after rendering: inspect the sampled frames and full clip, looking
for the colored room and objects beyond frame 12. Record whether a scene change
occurs and when; first-frame resemblance alone cannot pass the comparison.

Image-processor features are now established as matching on the production
path; see above. VAE normalization/posterior sampling, vision-tower features,
token tags and rotary positions still need a numerical comparison against the
pinned FL2VA reference. That needs the reference's PyTorch weights on a
CUDA or large-memory host. Matching shapes cannot prove those contracts. The
`small-motion` case stretches the 768×1344 source onto 576×1024, so it
exercises the vision-geometry correction. For a before/after comparison, render
it once from this tree and once with `place_keyframes_on_canvas` reverted. Repeat the synthetic
source and motion prompt on an installed image-capable LTX model, with its native
canvas, frame grid and stock encoder; record that model's pins and separate phase
timings. The H3 script intentionally does not imply that an LTX run occurred.
Only the resulting evidence can distinguish model/prompt limitations from an
integration defect and justify either a runtime correction or a user-facing
limitation.
