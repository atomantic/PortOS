# Phosphene reference review — LoRA training & the macOS GPU watchdog panic

**Date:** 2026-06-14 · **PortOS:** v2.20.0 · **Reference:** `mrbizarro/phosphene` @ v3.2.1
(`data/cos/reference-repos/0ff2e4fb…/`)

Goal of the review: phosphene also trains LoRAs MLX-natively on Apple Silicon —
see whether it solved the macOS GPU watchdog kernel panic that PortOS is fighting
on `lora-training-gpu-cooldown-segments`, or has techniques worth porting.

This is a design record. It deliberately documents one **negative result** so the
eval-cadence dead end is not re-attempted. The authoritative living incident
record stays `docs/research/2026-06-13-mflux-training-watchdog-panic.md`.

## What the two apps actually do (they differ at the model layer)

| | Phosphene | PortOS |
|---|---|---|
| Trains | LTX-2.3 **video** character LoRAs (face + voice from one dataset) | FLUX.2 Klein **image** LoRAs |
| Trainer | `ltx_trainer_mlx.LtxvTrainer` (vendored `ltx-2-mlx`) | `mflux-train` CLI (preferred) / torch+diffusers (fallback) |
| Watchdog survival | `mx.eval` cadence (inference) · out-of-process watchdog · pinned deps | process-teardown GPU-cooldown **segments** + checkpoint resume |

The trainers are different packages for different models, so there is no
lift-and-shift. The useful comparison is narrowly the **macOS-survival** layer.

## Negative result: the `mx.eval` cadence trick does NOT transfer to training

Phosphene's central watchdog lever for **inference** is MLX eval cadence. MLX is
lazy; it batches a whole forward into one graph and only materializes on
`mx.eval`. Letting the Metal command buffer grow unbounded risks an allocation
stall past the GPU watchdog window, so phosphene flushes inside the denoise loop
every N blocks via `LTX2_DIT_EVAL_EVERY` (`mlx_warm_helper.py:32-71`). PortOS
**already ported this to its LTX-2 video *generation* path**
(`scripts/generate_ltx2.py:63` sets `LTX2_DIT_EVAL_EVERY=1`).

It was tempting to port the same flush into mflux *training*. Reading the code,
it does not work, for three independent reasons:

1. **`LTX2_DIT_EVAL_EVERY` is foreign to mflux.** It is read by `ltx_core_mlx`
   (the inference engine). mflux reads no eval/flush/watchdog env var at all
   (grep of the installed package). So there is no env knob to flip.
2. **A `value_and_grad` step can't be partially eval'd.** mflux fuses forward +
   backward under `nn.value_and_grad` and materializes the whole thing with a
   **single** `mx.eval(params, optimizer.state)` per step
   (`mflux/models/common/training/trainer.py:141-143`). Inserting a per-block
   `mx.eval` inside the forward does not bound the *backward* command buffer —
   the gradient graph is one fused submission and can't be split by eval cadence
   the way a no-autodiff inference forward can.
3. **`batch_size: 1`.** PortOS configures one example per step
   (`server/services/loraTraining/runtimes.js:204`), so there is not even a
   batch loop to micro-accumulate over — each step is one irreducible
   forward+backward at 768px.

Conclusion: **do not add an eval-cadence "fix" to the trainer.** It would be a
no-op against a kernel panic, which is worse than not shipping. The technique is
correct only on the inference paths, where PortOS already applies it.

## What the panic actually is (and why the shipped mitigations are right)

Per the incident doc: three `watchdog timeout: no checkins from watchdogd in
90 seconds` kernel panics on brand-new `Mac17,7` / `T6050` (M5-class) silicon,
macOS 26.5, same caller (mod ASLR slide). That is a **whole-system stall**, not a
long single GPU kernel — leading hypothesis a GPU/Metal **driver hang** under
sustained ML load on new silicon, with thermal/power-trip and swap-thrash as
secondaries. A 768px, batch-1, single forward+backward step is seconds of GPU
time; it does not, by itself, starve `watchdogd` for 90s. So the right levers are
the ones already shipped:

- **Segmentation + GPU cooldown** (tear the process down → driver state resets) ✓
- **Memory-pressure reclaim + headroom gate** (attacks the swap secondary) ✓
- **Checkpoint floor + resume** (survives the hard reboot) ✓
- **powermetrics telemetry** (thermal-vs-driver forensics) ✓ — but blind on all
  three crashes because passwordless sudo wasn't configured.

Phosphene's experience **confirms the architecture** rather than replacing it.

## What phosphene genuinely adds

1. **Out-of-process watchdog principle (confirmation).** Phosphene proved an
   in-Python daemon-thread watchdog *cannot fire* — "Metal's command-buffer
   completion handlers block every thread's GIL during the deallocator chain"
   (`docs/STATE.md:436`, `ROADMAP.md:266`); the rescue must come from a separate
   process. PortOS's Node orchestrator + segmentation already sit on the right
   side of this line. The only gap is **soft** hangs (a wedged-but-not-rebooted
   mflux child): the Node idle watchdog is 30 min. A *phase-aware* stall detector
   (tight budget during `STAGE:training` where `STEP:` lines should arrive every
   few seconds; generous/disabled during `load-model`, dataset-encode, preview,
   and `cooldown`) would SIGKILL + auto-resume from the newest checkpoint faster.
   **Caveat:** this does **not** address the observed *hard-reboot* panics — the
   machine is gone before any userspace watchdog runs. It is defensive hygiene
   for the soft-hang case only. → PLAN item, gated on careful phase budgets to
   avoid false-killing a legitimately slow load/encode.

2. **Version-pinning discipline (+ bisect).** Phosphene pins a *validated trio*
   (`mlx==0.31.1`, etc.) precisely because "every pin is a paid lesson" and a
   `>=` floor lets the stack drift silently. PortOS installs `mflux>=0.17`
   (a floor) and lets pip resolve mlx under mflux's `mlx<0.32` constraint
   (`scripts/setup-image-video.sh`). Currently installed:
   **mflux 0.17.5 · mlx 0.30.6 · mlx-metal 0.30.6 · mlx-lm 0.29.1** — and this is
   the stack that panics. The actionable lever the incident doc already flags
   ("update the stack; search mflux/MLX trackers for M5/watchdog/hang") is a
   **bisect**, not a blind pin: pinning to the *current* versions would lock in
   the known-bad set. → PLAN item: bisect mlx/mlx-metal (e.g. 0.30.6 ↔ 0.31.x)
   and mflux on the M5, find a trio that survives a full run, *then* pin it with
   the test that proved it (phosphene's rule), and file an upstream mflux/MLX
   issue with the three paniclogs.

3. **Runtime-fingerprint logging** (already a PLAN item for video-gen,
   `ref-watch-phosphene-runtime-fingerprint-in-status`) should extend to the
   trainer: emit `mflux`/`mlx`/`mlx-metal` version + chip + macOS on each run so a
   future paniclog correlates to an exact stack. Small add to
   `train_mflux_lora.py`. → folded into the bisect item.

## Capability ideas (separate, larger, not watchdog-related)

- mflux in PortOS's venv already ships **`z_image` and `flux2_edit` training
  adapters** beyond plain FLUX.2 — on-device MLX LoRA paths PortOS could expose.
- Phosphene's **face + voice LoRA from one dataset** is a category PortOS lacks;
  it's a much larger lift (different model `ltx_trainer_mlx`, audio pipeline) and
  belongs in its own proposal, not this watchdog thread.

## Revised plan (honest scope)

| # | Action | Where | Status |
|---|---|---|---|
| 1 | Record the eval-cadence negative result | this doc + incident doc | done |
| 2 | ~~Inject per-block `mx.eval` into training~~ | — | **dropped** (not viable; see above) |
| 3 | Phase-aware soft-hang stall watchdog (SIGKILL + auto-resume) | Node `loraTraining` + `mediaJobQueue` | PLAN item (defensive-only; needs careful phase budgets) |
| 4 | Version bisect on the M5 → pin validated trio + runtime fingerprint + upstream issue | `setup-image-video.sh`, `train_mflux_lora.py` | PLAN item (blocked on M5 + a full run) |
| 5 | Z-Image / FLUX.2-edit LoRA training; face+voice LoRA | future | separate proposals |

Items 3–5 are captured as slug-tagged entries in `PLAN.md` → "Next Up".

## Ready-to-run bisect procedure (DO NOT RUN UNTIL READY — it can hard-reboot the box)

Confirmed 2026-06-14: the dev box **is** the panicking hardware — Apple **M5 Max**,
`Mac17,7`/`T6050`, macOS **26.5.1** (`25F80`, fully current — no OS update available),
128 GB. Passwordless `powermetrics` is now configured, so the next run finally
captures thermal/power forensics (all three prior panics were blind). Available
in-constraint versions: mlx/mlx-metal up to **0.31.2** (current 0.30.6; mflux
caps `<0.32` and its `dev` extra pins `mlx==0.31.0`); mflux up to **0.18.0**
(current 0.17.5).

**Why a test run is destructive:** to reproduce the *sustained-GPU* condition a
candidate must run with **segmentation OFF** (`--segment-steps 0`). If the
candidate version doesn't fix the driver hang, the box hard-reboots (and this
session dies). Each failing candidate ≈ one reboot. Telemetry-on means even a
failed run yields first forensics (thermal vs driver).

**Repro harness (reuse an existing dataset/config):** run
`data/training-runs/15cfeed1-f4ee-4fc2-a767-67b2336dd277/` — 25 images × 24
epochs = 600 steps, batch 1, **quantize null (bf16)**, low_ram, save_freq 150.
bf16 is the heaviest sustained-GPU config = most panic-prone = best repro.

Direct sustained run (bypasses the server; telemetry auto-starts; segmentation
OFF so the panic condition is reproduced):

```bash
cd ~/github.com/atomantic/PortOS
RUN=data/training-runs/15cfeed1-f4ee-4fc2-a767-67b2336dd277
./data/python/venv/bin/python scripts/train_mflux_lora.py \
  --config "$RUN/mflux-train.json" --output-dir "$RUN" \
  --total-steps 600 --segment-steps 0
# watch: tail -f "$RUN/powermetrics.log"   (GPU temp/power up to the gap)
```

**Bisect order (isolate one variable at a time; pip changes survive a reboot):**

1. Baseline confirm (optional, costs a reboot): current stack, command above →
   expect panic, but now WITH telemetry. Read `powermetrics.log`: GPU die temp
   climbing to ~100 °C / SMC throttle before the gap ⇒ **thermal** (no version
   bump helps; improve cooling / cap power). Temps normal, log just stops ⇒
   **driver hang** ⇒ proceed to bump.
2. Bump the Metal backend only (highest-probability driver fix):
   `./data/python/venv/bin/python -m pip install --user 'mlx==0.31.2' 'mlx-metal==0.31.2'`
   then re-run the harness. Completes ⇒ run once more to confirm, then pin
   (step 4). Panics ⇒ reboot, continue.
3. Add mflux 0.18.0 (`pip install --user 'mflux==0.18.0'`, keeps mlx 0.31.2) and
   re-run. (Try mlx 0.31.0/0.31.1 if 0.31.2 regressed something image-side.)
4. **Pin the surviving trio** in `scripts/setup-image-video.sh` (replace the
   `mflux>=0.17` floor) with a comment recording the run that proved it —
   phosphene's "every pin is a paid lesson." Add a startup runtime-fingerprint
   line to `scripts/train_mflux_lora.py` (mflux/mlx/mlx-metal + chip + macOS).
5. Revert to current if no candidate survives: `pip install --user 'mlx==0.30.6'
   'mlx-metal==0.30.6'` — segmentation (default ON) remains the mitigation, and
   file the upstream issue (`docs/research/2026-06-14-upstream-issue-draft-m5-watchdog.md`).

**Before running:** commit/stash any in-flight work (a reboot is abrupt — the
incident doc notes downstream tombstone/sync fallout), and `git commit` this
branch so the docs survive. Bisect progress should be logged back into the
incident doc after each candidate so a session-killing reboot doesn't lose it.
