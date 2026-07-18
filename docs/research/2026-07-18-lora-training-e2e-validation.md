# Validation: Character LoRA training — end-to-end, both runtimes

**Status:** Closed — mflux runtime validated end-to-end incl. inference round-trip; torch fallback confirmed non-viable on Apple Silicon (guarded)
**Date:** 2026-07-18
**Hardware:** Apple M-series, 128 GB unified memory, macOS `Darwin 25.5.0`
**Closes:** the "needs a real training run" blocker on issue #1227 (character LoRA training follow-ups)

This records the real end-to-end training run #1227 had been waiting on (previously
blocked on a GPU bench session + disk headroom). It validates the **mflux (MLX)**
runtime — the preferred Apple-Silicon path — from config through a trained adapter
and back through inference, and it establishes that the **torch/diffusers fallback**
cannot train on Apple Silicon (a PyTorch MPS backend limitation), which is now
guarded at request time.

## Environment rebuilt

The prior `/opt/miniconda3` mflux install from the 2026-06 verification was gone.
Rebuilt the pinned stack (`setup-image-video.sh`'s pins) into a dedicated venv,
since this machine's system `python3` is a broken/too-old pyenv:

- `mflux==0.17.5 · mlx==0.31.2 · mlx-metal==0.31.2` in a `uv`-provisioned Python
  3.11 venv (`~/.portos/venv-mflux`), with `settings.imageGen.local.pythonPath`
  pointed at it so `isMfluxTrainAvailable` finds `mflux-train` beside it.
- FLUX.2-klein base weights were already in the HF cache (no ~16 GB download —
  the old disk-space blocker is gone).

> Follow-up filed: `setup-image-video.sh` installs mflux via `pip install --user`
> against the system `python3`; on a machine whose system python is unsuitable
> (too old / broken) that path fails, and a dedicated venv (as the ltx/wan/hunyuan
> runtimes already use) is needed. Tracked separately.

## mflux (MLX) runtime — VALIDATED end-to-end

Dataset: an original character (25 ready images, all captioned with the trigger
word). Smoke config built by the real `buildMfluxTrainConfig`/`buildMfluxTrainArgs`
service code, staged exactly as `runTraining` does (`NNNN.png`+`NNNN.txt`), 4B base,
segmentation ON.

| Step | Result |
|---|---|
| Config schema vs installed mflux 0.17.5 | `mflux-train --dry-run` → `✅ Training config validated` |
| Entrypoint probe | `mflux-train` console script found + launched |
| Output regexes | `STEP:` / `STAGE:` / `CHECKPOINT:` / `RESULT:` all parsed |
| Segmentation + GPU teardown/cooldown/resume | 5 segments, each resume re-applied the LoRA cleanly (`200/200 keys matched`) |
| Checkpoint-zip layout | `checkpoints/NNNNNNN_checkpoint.zip` at 12/24/36/48/50 |
| Adapter discovery | `*_adapter.safetensors` cracked from the newest zip (200 diffusers-style keys) |
| RESULT JSON | emitted with `adapter_path`, `steps` |
| Watchdog mitigation | `AGX_RELAX_CDM_CTXSTORE_TIMEOUT=1` set; run stayed well under the 150–300-step panic window; no reboot |

Exit 0 in ~7.4 min (50 steps).

### Inference round-trip — VALIDATED

The trained adapter loaded through `scripts/flux2_macos.py --lora-paths` on the SDNQ
4-bit inference pipeline (`~/.portos/venv-flux2`, torch 2.12 / diffusers):

```
🎚️  loading LoRA: 0000050_adapter.safetensors (adapter=lora_0)
🔁 mflux adapter: remapped 10 double-block to_out key(s) → diffusers .0 form
✅ active LoRA adapters: [('lora_0', 1.0)]
✅ flux2 saved roundtrip.png (seed=42)
```

The mflux→diffusers `to_out` key remap (`scripts/lora_utils.py` `_remap_mflux_flux2_keys`)
fired for exactly the 10 double-block `attn.to_out` keys the adapter carries — the
load-bearing compat step — and produced a coherent 512-px character render (no
collapse-to-black). 50 steps is far too few to bind identity; the goal was pipeline
mechanics + a clean LoRA load, both confirmed.

### Note: `nan` loss

The wrapper reported `STEP:N:50:nan` and `final_loss: null`. mflux's base-model
training does not surface a parseable per-step loss to stdout (`TQDM_RE` only
captures step/total), so the wrapper honestly reports `nan`/`null`. Training and
the adapter are valid — the round-trip render proves it. Benign; not a defect.

## torch/diffusers fallback runtime — NOT viable on Apple Silicon

The vendored `scripts/train_flux2_lora.py` (torch/diffusers+peft, the fallback for
non-mflux machines) was smoke-tested directly. Pipeline load and
`STAGE:precompute-latents` succeed, but training dies at the **first**
`loss.backward()` — three successive PyTorch **MPS** backend limitations:

1. `Input type (MPSBFloat16Type) and weight type (CPUBFloat16Type) should be the
   same` — reentrant gradient-checkpointing recompute mis-tracks device on MPS.
2. With checkpointing off: `mps_linear_backward: unsupported weights data type:
   BFloat16` — MPS has no bf16 Linear backward.
3. With an fp32 base: `mps_linear_backward: unsupported weights data type: Float`
   — MPS rejects fp32 Linear backward for these layers too.

These are PyTorch MPS backend gaps, not PortOS logic bugs, and they land at the
optimizer step regardless of dtype — so the torch trainer cannot complete a LoRA
step on Apple Silicon. This is exactly why mflux (MLX-native) is *the*
Apple-Silicon runtime and the torch path is scoped to "a non-mflux machine"
(CUDA/CPU). CUDA has bf16 `linear_backward`; that path is unchanged and remains to
be validated on a CUDA box (follow-up).

### Fix: fail fast instead of crash-after-load

Rather than queue a torch run on Apple Silicon that loads a ~16 GB base and
precomputes latents for minutes only to crash, the fallback now refuses up front:

- **Request time (`server/services/loraTraining/index.js`):** on darwin, a
  flux2-runtime `startTrainingRun` throws `412 TRAINING_MPS_UNSUPPORTED` pointing
  the user at mflux (`scripts/setup-image-video.sh`), before any run record or job
  is created. Covered by `mpsGuard.test.js`.
- **Trainer (`scripts/train_flux2_lora.py`):** defense-in-depth `USER_ERROR:
  TRAINING_UNSUPPORTED_DEVICE` when `--device` resolves to `mps`, before loading
  the base. `--device cpu` is still allowed (fp32 CPU backward works, just slow).

## Outcome

- mflux runtime: training + adapter extraction + inference round-trip validated on
  the current pinned stack. The user's real character LoRAs train on this hardware.
- torch fallback: confirmed non-viable on MPS and now guarded with actionable
  guidance; CUDA/CPU e2e validation deferred to appropriate hardware.
