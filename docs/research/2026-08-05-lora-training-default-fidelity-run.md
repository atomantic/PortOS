# Fidelity run: LoRA-training defaults — 4B vs 9B base, and how many steps

**Status:** RESUMED 2026-08-07 — Run A (4B) restarted from checkpoint 299 (job
`d7aece3a…`), continuing toward step 1200; Run B (9B) still not started. The
#2791 gate is **not** satisfied yet; defaults must not change until both arms
finish and are visually compared.
**Date:** 2026-08-05 (resumed 2026-08-07)
**Hardware:** Apple M5 Max, 128 GB unified memory, macOS 26.5.2
**Runtime:** mflux 0.17.5 · mlx 0.31.2 · mlx-metal 0.31.2 · python 3.14.6
**Closes:** the "blocked on empirical fidelity validation" gate on issue #2791
(itself split out of #1321)

Issue #2791 parked two default changes behind a real training run, because neither
could be decided from code inspection:

- **(a-alt)** Should a single-character LoRA default to the **4B** base rather than
  the **9B-8bit** base? Lighter and much faster, but a real quality tradeoff.
- **(b)** Is `TRAINING_DEFAULTS.steps = 1200` more than a ~25-image face dataset
  needs? #1321's data suggested ~600 might suffice.

The issue is explicit that the defaults must not change without this run. This
document is that run.

## Why the existing artifacts couldn't answer it

Two trained Freydis LoRAs were already on disk, but neither is usable as evidence
for these questions — both are **4B at 400 steps, rank 16, lr 5e-5**, far from the
defaults under test, and there is no 9B counterpart at matched settings (every
prior Freydis 9B attempt is recorded `failed` or `canceled`). The current defaults
themselves were validated on a *different* subject — a 44-image real-face dataset
on 9B 4-bit (see the `TRAINING_DEFAULTS` comment in
`server/services/loraTraining/runtimes.js`) — so nothing on hand compares 4B to
9B at the current 8-bit default on the same data.

## Method

Two runs, identical in every parameter except the base-model size variant, so the
size is the only free variable:

| | Run A | Run B |
|---|---|---|
| `baseModelId` | `flux2-klein-4b` | `flux2-klein-9b` |
| mflux model | `flux2-klein-base-4b` | `flux2-klein-base-9b` |
| steps | 1200 | 1200 |
| rank | 32 | 32 |
| learning rate | 1e-4 | 1e-4 |
| resolution | 768 | 768 |
| seed | 42 | 42 |
| `baseQuant` | 8 | 8 |
| checkpoint / sample every | 300 | 300 |

Everything but `baseModelId` is the shipped `TRAINING_DEFAULTS`. `baseQuant: 8` is
passed **explicitly** on both arms rather than left to `deriveMfluxMemoryConfig`,
so the comparison can't silently drift with the memory tier of whatever box it is
re-run on.

**Dataset:** Freydis of Quaervarr (`90043893…`), 25 ready captioned images — the
proven no-PII original character used for the #1227 e2e validation, and the
"25-image face" case #2791 part (b) is about.

**Caption-leak gate overridden.** `validateDatasetReady` rejects this dataset:
the phrase *"painterly realistic dark fantasy style"* appears in 24/25 captions
(96%), which risks the trigger word binding to a generic style rather than the
subject. The run was started with `acknowledgeCaptionLeak: true` (the UI's "Train
anyway"). This is sound for *this* experiment because the leak is **identical in
both arms**, so it cannot bias a 4B-vs-9B comparison — but it does mean absolute
identity strength here is a floor, not a ceiling, and the same dataset recaptioned
would likely bind harder. Noted so a future reader doesn't mistake this for a
clean-caption benchmark.

## Measurement artifact: the built-in preview grid

Both runs render a preview image every 300 steps from a fixed prompt
(`freydis_of_quaervarr portrait, neutral background`) at a fixed seed. That yields
a directly comparable 2 × 5 grid — steps 0/300/600/900/1200 per arm — from the
runs themselves, with no extra inference pass and no promotion step:

- **Across steps within one arm** → answers **(b)**: where does identity stop
  improving?
- **Across arms at matched steps** → answers **(a-alt)**: does 4B reach 9B's
  likeness?

### Step 0 is a true control

The step-0 sample is rendered with the LoRA still at its zero-init state, i.e.
effectively the bare base model. On Run A it produced a generic person bearing no
resemblance to the character — confirming the trigger token
`freydis_of_quaervarr` carries no meaning in the base model, and therefore that
**any** likeness at later steps is attributable to the adapter rather than to the
prompt wording or a base-model prior. This makes the later samples interpretable
as a training-progress curve rather than as raw prompt adherence.

## Environment notes

- Segmented training ON: 300-step segments with a 90s GPU cooldown between each.
- `AGX_RELAX_CDM_CTXSTORE_TIMEOUT=1` set by the trainer, and the display
  auto-slept for the duration — the validated mitigation for the M5 GPU-watchdog
  kernel panic (mlx #3267). See
  `docs/research/2026-06-13-mflux-training-watchdog-panic.md`.
- Observed Run A throughput: **~9.4 s/step** at 4B / rank 32 / 8-bit / 768px
  (measured over a 10-minute steady-state window; a shorter 5-minute sample read
  8.0 s/step but was skewed by the step-0 preview render). That is ~3.1 h of step
  time for 1200 steps, before cooldowns and sample renders.
- `STEP:` lines report loss as `nan` throughout. This is expected, not divergence:
  `progress.js` documents that mflux may emit `nan` here and normalizes it to
  `null`. **Loss is not available as a quality signal for these runs** — the
  judgment is necessarily visual, which is why #2791 specifies human judgment.

## Results

**Incomplete.** Run A reached step 563 of 1200 before being paused; samples exist
for steps 0 and 300 only. Run B (9B) was never started. What follows is an interim
observation, explicitly **not** a verdict.

### Interim observation: the current defaults bind identity far harder than the shipped 400-step LoRA

Comparing the step-300 sample against the previously promoted Freydis adapter
(`3847825e…`, 4B / 400 steps / rank 16 / lr 5e-5) is instructive, because that
older adapter is what the install has been treating as an acceptable result:

| | Old promoted LoRA (400 / r16 / 5e-5) | This run @ step 300 (r32 / 1e-4) |
|---|---|---|
| Render quality | sharp, clean | soft, mushy |
| Prompt adherence | keeps "neutral background" | drifts to dataset-like rocky scenes |
| **Identity** | **wrong** — dark curly hair, generic young woman in a headband | platinum cropped hair, i.e. the actual character trait |

The older adapter looks better as an *image* while largely failing to encode the
subject; the current defaults are visibly encoding the subject by step 300 while
still mid-convergence. This suggests the shipped rank-32 / lr-1e-4 defaults are
doing real work that the earlier lighter settings were not — and it is a caution
against reading "the old 400-step run looked fine" as evidence that fewer steps
suffice. The two failure modes are different: one is under-quality, the other is
under-identity.

**Do not act on this.** A single mid-training sample cannot distinguish
"converging" from "starting to over-cook" — and this codebase has prior history of
a run degrading late (the divergence noted in the `TRAINING_DEFAULTS` comment).
The step-600/900/1200 samples are exactly the evidence that would separate those,
and they were not collected.

## Verdict

_None. The run was paused before either question could be answered._

Neither #2791 change is justified by the data collected here:

- **(a-alt) 4B vs 9B-8bit** — unanswerable; the 9B arm never ran, so there is no
  baseline to compare 4B against.
- **(b) 1200 → ~600 steps** — unanswerable; the run stopped at 563 with samples
  only at 0 and 300, so the shape of the curve past 300 is unknown.

`TRAINING_DEFAULTS` and the base-model picker should stay exactly as they are
until this run is completed.

## Resuming

Run A was resumed 2026-08-07 via `POST /api/lora-training/runs/9f6fce7e-bbce-44c3-8deb-a1acb5409639/resume`,
which re-enqueued from checkpoint 299 (job `d7aece3a-b457-4a86-97f0-24c498d5b6ee`,
`fromStep: 300`) and is training toward step 1200. Confirmed picked up cleanly:
checkpoint restored, LoRA reapplied (200/200 keys matched), step counter
continuing from 300.

Run B (9B) still must be started fresh with the Run B column of the method table
above once Run A finishes. Budget ~2.4 h for the remainder of the 4B arm from
this resume point and appreciably longer for the 9B arm; both want the display
asleep for the duration (see Environment notes).

