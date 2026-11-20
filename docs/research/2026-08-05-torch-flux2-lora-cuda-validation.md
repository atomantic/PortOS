# Validation: torch FLUX.2 LoRA trainer on CUDA

**Status:** Closed — torch/diffusers fallback validated end-to-end on CUDA; two
memory bugs found and fixed
**Date:** 2026-08-05
**Hardware:** Windows 11, NVIDIA RTX 3090 (24 GB), 32 GB system RAM, driver 596.36
**Closes:** #2786 (split out of #1227)
**Companion:** the mflux runtime + Apple-Silicon MPS validation run (removed with the retired LoRA training feature; see git history)

The 2026-07-18 validation established that the mflux (MLX) runtime works
end-to-end on Apple Silicon and that the torch/diffusers fallback **cannot**
train there — PyTorch's MPS backend has no `linear_backward` for the FLUX.2
transformer's Linear layers, so the run dies at the first `loss.backward()`.
That left one open question, deferred for want of hardware: **does the torch
fallback actually work on its real target, a CUDA box?**

It does — but not as shipped. Getting there required fixing two memory bugs that
a 128 GB unified-memory Mac had silently absorbed.

## Environment

The existing shared image-gen venv (`~/.portos/venv-flux2`) already had the
whole stack; nothing needed rebuilding:

- torch **2.12.0+cu130** (`torch.cuda.is_available() == True`), diffusers
  **0.39.0.dev0** (`Flux2KleinPipeline` present), peft **0.19.1**,
  transformers **5.10.2**
- `pick_device("auto")` → `cuda`
- Base weights: `black-forest-labs/FLUX.2-klein-4B` bf16 (~16 GB of
  diffusers-format shards; the repo's redundant single-file
  `flux-2-klein-4b.safetensors` was skipped). Not a gated repo.

Dataset: 6 procedurally-generated placeholder images (a flat-color robot
mascot, trigger word `zqxbot`), captioned and fed through the real manifest
schema. Synthetic on purpose — the goal is pipeline mechanics, and no real
user data belongs in a validation artifact.

The trainer was invoked with exactly the argv `buildFlux2TrainArgs`
(`server/services/loraTraining/runtimes.js`) constructs: 20 steps, rank 16,
lr 1e-4, resolution 512, `--checkpoint-every 10`, `--sample-every 10`,
`--device auto`.

## Bug 1 — precompute leaked ~2.6 GB per caption (no `torch.no_grad()`)

**Symptom.** The first run sat in `STAGE:precompute-latents` for 18+ minutes
emitting nothing but heartbeats, with VRAM pinned at 24.3/24.6 GB and the GPU at
100%. A `py-spy` dump put it inside the **first** Qwen3 caption encode. A later
run got through precompute and then aborted at `transformer.to(device)`:

```
torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 162.00 MiB.
GPU 0 has a total capacity of 24.00 GiB of which 0 bytes is free.
Of the allocated memory 37.95 GiB is allocated by PyTorch
```

37.95 GiB "allocated" on a 24 GiB card is Windows' WDDM shared-memory fallback:
rather than failing, the driver spills into system RAM over PCIe, which is what
turned the encode into a crawl before it eventually hit a hard wall.

**Root cause.** Precompute is pure inference, but it ran **without**
`torch.no_grad()`. The freshly-loaded text encoder still has
`requires_grad=True` params, so every `encode_prompt` built and kept a full
autograd graph — and the `.to("cpu")` cache copy inherited that `grad_fn`,
pinning the whole graph on-device permanently. Measured directly:

| encode_prompt call | alloc | grad_fn |
|---|---|---|
| baseline (text encoder resident) | 8.10 GB | — |
| 0 | 10.72 GB | `ViewBackward0` |
| 1 | 13.31 GB | `ViewBackward0` |
| 2 | 15.92 GB | `ViewBackward0` |
| 3 | 18.52 GB | `ViewBackward0` |
| 4 | 21.12 GB | `ViewBackward0` |

~2.6 GB retained per unique caption. Six captions exhaust a 24 GB card. Under
`torch.no_grad()` the same seven calls hold **flat at 8.12 GB**, `grad_fn` is
`None`, and each call runs ~4× faster (0.09 s vs 0.38 s); freeing the text
encoder afterwards then drops to 0.02 GB and `transformer.to("cuda")` succeeds
at 7.77 GB.

**Why Apple Silicon never caught it.** 128 GB of unified memory absorbs a
2.6 GB × N leak without complaint, and the MPS run died at the first backward —
well after precompute — so the leak never had consequences there.

**Fix.** Two layers, because the region-level fix alone leaves the class of bug
alive:

- **Root cause — freeze at load.** `pipe.text_encoder.requires_grad_(False)` and
  `pipe.vae.requires_grad_(False)` right after `from_pretrained`, joining the
  `transformer.requires_grad_(False)` the trainer already did (hoisted up beside
  them, so one place states the real invariant: nothing is trainable until
  `add_adapter` runs). `requires_grad` is a property of the *module*, so
  clearing it makes "an inference forward silently built a graph" unreachable
  from every call site — where a `no_grad` block only protects the one region
  someone remembered to wrap. Both encoders take grad-free inputs (token ids; a
  tensor built from numpy), so this alone is sufficient.
- **Belt — `torch.no_grad()` on precompute.** Kept, because it additionally
  suppresses graph-building when an *input* carries a `grad_fn`, which clearing
  the params cannot.

Separately, the allocator cache is now cleared on CUDA as well as MPS. That
became `empty_device_cache(device, *, synchronize=False)` in
`scripts/ml/_runner_common.py` — the shared runner module — rather than a local
helper, since `flux2_macos.py` and `z_image_turbo.py` already carry their own
copies of the same dispatch. It keys on the **resolved device string** rather
than `torch.cuda.is_available()`, so a `--device cpu` run on a CUDA box no
longer clears a cache it never filled.

## Bug 2 — sample render decoded the VAE on CPU in bf16 (reads as a hang)

**Symptom.** With bug 1 fixed, training ran clean through step 10, wrote its
checkpoint, and then hung. `py-spy` put it in `pipe.vae.decode` →
`torch.nn.modules.conv._conv_forward`. One 512-px decode had been running
**>18 minutes**.

**Root cause.** Phase 1 deliberately parks the VAE on CPU to keep it out of the
training footprint, and `render_sample` decoded wherever it found it
(`vae_device = next(pipe.vae.parameters()).device`). But the pipeline is bf16 on
an accelerator, and x86 has no fast bf16 convolution path — so the decode falls
back to a reference implementation and effectively never finishes.

This was never reachable on Apple Silicon: the MPS run died at the first
backward, long before the first sample. It is latent on **any** accelerator
backend, not just CUDA.

**Fix.** `render_sample` moves the VAE onto the training device for the decode
and returns it to where precompute parked it. The VAE is ~0.17 GB against a
~8 GB resident transformer, so borrowing the device costs nothing and the
training loop's footprint is unchanged. Decode time: >18 min → **~2 s**.

Both the move and the decode sit inside the `try` whose `finally` restores the
VAE. `.to()` walks parameters one at a time, so a throw partway through the move
would otherwise leave the VAE straddling two devices with the `finally` never
entered — and since the caller treats samples as best-effort and swallows the
exception, the next sample would read the now-`cuda` resting place as its
"home" and latch the VAE on-device for the rest of the run.

## Result — full end-to-end run

```
STAGE:load-pipeline
STAGE:precompute-latents
STATUS:encoded 1/6 … 6/6 dataset images          (11 s total)
STAGE:training
STATUS:LoRA targets: add_k_proj, add_q_proj, add_v_proj, to_add_out,
                     to_k, to_out.0, to_q, to_v (rank 16)
STEP:1:20:0.0231 … STEP:10:20:0.0370
CHECKPOINT:…/checkpoints/step-000010:10
SAMPLE:…/samples/step-000010.png:10
STEP:11:20:0.0278 … STEP:20:20:0.0199
SAMPLE:…/samples/step-000020.png:20
RESULT:{"adapter_path": "…/adapter/pytorch_lora_weights.safetensors",
        "steps": 20, "final_loss": 0.0199, "last_checkpoint": "…/step-000010"}
```

| Contract | Result |
|---|---|
| `loss.backward()` on CUDA | ✅ works in bf16 — the MPS blocker does not apply |
| `STAGE:` / `STEP:` / `CHECKPOINT:` / `SAMPLE:` / `RESULT:` protocol | ✅ all emitted as `progress.js` expects |
| `checkpoints/step-NNNNNN/` layout | ✅ `pytorch_lora_weights.safetensors` + `optimizer.pt` + `state.json` |
| Adapter export | ✅ 80 tensors, rank 16, diffusers key naming (`transformer.transformer_blocks.N.attn.*.lora_{A,B}.weight`) |
| Sample renders | ✅ 512×512, mean 130 / std 69 — real images, no collapse-to-black |
| Peak VRAM | 8.8 GB of 24 GB — comfortable headroom |
| Wall clock | ~20 s for 20 steps (~0.7 s/step) after an 11 s precompute |

### Resume — VALIDATED

Resuming from `checkpoints/step-000010` with the same `--steps 20`:

```
STATUS:resumed adapter + optimizer state — continuing from step 10
STEP:11:20:0.0228 … STEP:20:20:0.0373
RESULT:{… "steps": 20 …}
```

It continued **11→20** rather than restarting a fresh 1→20, confirming the
`optimizer.pt` bundle restores the adapter, the AdamW state, and the step offset.

### Inference round-trip — VALIDATED

The trained adapter loaded through `scripts/ml/flux2_macos.py --lora-paths` on the
bf16 pipeline (same base it trained on):

```
🎚️  loading LoRA: pytorch_lora_weights.safetensors (adapter=lora_0)
✅ active LoRA adapters: [('lora_0', 1.0)]
🎨 flux2 generate seed=42 512x512 steps=8 guidance=3.5 device=cuda
✅ flux2 saved roundtrip.png (seed=42)
```

Produced a coherent 512-px portrait. Note the mflux→diffusers `to_out` key remap
(`scripts/ml/lora_utils.py`) does **not** fire here and should not: a torch/peft
adapter is already in diffusers key form, unlike the mflux adapter in the
2026-07-18 run. 20 steps is far too few to bind identity — same caveat as that
run's 50 — so the render is a generic portrait, not the mascot. Pipeline
mechanics and a clean LoRA load were the goal; both confirmed.

## Regression guard

`scripts/train_flux2_lora_test.py` (standalone, no pytest, no torch — it parses
the trainer's AST) pins the invariants: the three modules are frozen at load,
precompute's `encode_prompt`/`_encode_vae_image` run under `torch.no_grad()`,
`render_sample` moves the VAE on-device inside the `try` and restores it in the
`finally`, and no bare `torch.{mps,cuda}.empty_cache` survives anywhere in the
module. Behavioral tests aren't possible here — exercising these paths needs
torch, a ~16 GB download, and a CUDA card.

Each check was **mutation-tested**, since a guard that cannot fail is worthless:
all seven regressions (stripping the `try/finally`, a bare
`torch.cuda.empty_cache()`, re-declaring the helper locally as MPS-only,
dropping `no_grad`, dropping either `requires_grad_(False)`, decoding off-device)
are caught, while two legitimate refactors that change no behavior — nesting the
`with` guards, and the `pipe.vae.to(device=device)` keyword form — stay green.
That last pair matters: an earlier draft of this test keyed on one `with`
statement's shape and went red on the nesting refactor while *passing* three of
the regressions above.

`scripts/ml/_runner_common_test.py` covers the relocated helper directly, stubbing
`sys.modules["torch"]` (the helper defers its import) to assert it dispatches on
the resolved device and clears nothing on `cpu`.

## Outcome

- **The torch/diffusers fallback is validated on CUDA.** bf16 `linear_backward`
  exists there, as predicted; training, checkpointing, resume, adapter export,
  and the inference round-trip all work.
- **Two real bugs fixed** — both invisible on the 128 GB Mac that originally
  validated this code, and both fatal (one immediately, one as an apparent hang)
  on a 24 GB consumer card.
- The Apple-Silicon guard (`TRAINING_MPS_UNSUPPORTED` at request time,
  `USER_ERROR:TRAINING_UNSUPPORTED_DEVICE` in the trainer) is unchanged and
  still correct.
- **Not covered:** the 9B base (this box has the VRAM for 4B training with room
  to spare, but 9B was out of scope), long runs where LoRA quality is the
  question rather than mechanics, and the `--device cpu` path.
