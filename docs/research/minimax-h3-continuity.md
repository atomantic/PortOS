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

## What remains to establish

No real render results accompany this harness. `continuity: not_assessed` stays
explicit even after rendering: inspect the sampled frames and full clip, looking
for the colored room and objects beyond frame 12. Record whether a scene change
occurs and when; first-frame resemblance alone cannot pass the comparison.

Compare VAE normalization/posterior sampling, vision features, token tags and
rotary positions against the pinned FL2VA reference before changing the adapter.
Matching shapes cannot prove those numerical contracts. Repeat the synthetic
source and motion prompt on an installed image-capable LTX model, with its native
canvas, frame grid and stock encoder; record that model's pins and separate phase
timings. The H3 script intentionally does not imply that an LTX run occurred.
Only the resulting evidence can distinguish model/prompt limitations from an
integration defect and justify either a runtime correction or a user-facing
limitation.
