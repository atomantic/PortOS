# Fidelity run: LoRA-training defaults — 4B vs 9B base, and how many steps

**Status:** COMPLETE 2026-08-08 — both arms finished all 1200 steps and were
visually compared at matched checkpoints. The #2791 gate is satisfied. **Verdict:
stay as-is — the data does not justify either proposed default change**, though
it does surface a real (separate) observation about checkpoint selection. See
Verdict below.
**Date:** 2026-08-05 (resumed 2026-08-07, Run B started + both arms completed
2026-08-07/08)
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

Both arms completed all 1200 steps. Run A (4B) finished 2026-08-07 (run
`9f6fce7e…`, adapter `0001200_adapter.safetensors`, throughput ~9.4 s/step). Run
B (9B) finished 2026-08-08 (run `151f3631…`, LoRA
`lora-trained-freydis-a-b-9b-8bit-defaults-2791-151f3631.safetensors`, throughput
~15.3 s/step — roughly 1.6× slower than 4B per step, plus a heavier model load).
All ten preview-grid samples (steps 0/300/600/900/1200 × 2 arms) were read and
compared directly.

### Step 0 (both arms) — confirmed control

Both arms render a generic, non-matching person at step 0 (Run A: light-skinned
person with a headband; Run B: dark-curly-haired person) — the zero-init LoRA
carries no identity, exactly as expected. Any likeness at later steps is
attributable to training, not prompt wording or a base-model prior.

### Step-by-step comparison at matched checkpoints

| Step | Run A (4B) | Run B (9B) |
|---|---|---|
| 300 | Soft/mushy render, drifts to a dataset-like rocky scene; hints of light hair | **Blank/near-white image** (anomalous — see note below); no evaluable content |
| 600 | Sharp, but **wrong identity** — dark brown hair, generic "dark-fantasy warrior" look (style-leak dominated) | Sharp, **also wrong identity** — dark brown hair, near-identical "dark-fantasy warrior" composition to Run A's step 600 |
| 900 | **Best of both arms** — sharp, clean, **platinum/silver cropped hair with a headwrap — the character's actual defining trait** | Sharp, but still **wrong identity** — dark brown hair with a braided headband and leather armor, no platinum trait |
| 1200 (final) | Quality regresses from step 900 — softer, more painterly/blurred; hair reverts to long wavy blonde (identity-adjacent but no longer "cropped") | Quality also regresses from step 900 — softer/blurrier; hair has drifted again, now auburn/red (off-identity) |

**Anomaly at Run B step 300:** the preview render is blank/near-white (132 KB vs
600–900 KB for every other sample). No error, `Traceback`, or warning appears in
the trainer log around that checkpoint (`CHECKPOINT`/`SAMPLE` lines are normal;
segment 1→2 handoff and LoRA reapplication at step 300 both report success). This
looks like a transient/degenerate sample-render artifact specific to the 9B+8bit
combination at that checkpoint rather than a training failure — training
continued normally afterward — but it means the 300-step column has no usable
image for the 9B arm.

## Verdict

**Stay as-is. Neither proposed default change is justified by this run — but a
related, unplanned observation is worth recording.**

- **(a-alt) 4B vs 9B-8bit base model.** At matched steps, **4B did not lose to
  9B on identity — if anything the opposite**: only the 4B arm ever produced the
  character's defining trait (platinum cropped hair), and only briefly, at step
  900. The 9B arm never reproduced it in any of its four post-zero samples,
  staying on generic dark/auburn hair throughout. This is a genuinely surprising,
  directionally interesting result — but it rests on **one run, one seed, one
  dataset, with the caption leak confound acknowledged up front** (see Method).
  A result this counter to the naive "bigger model = better identity" prior needs
  independent replication (a second seed, ideally with clean captions) before it
  should move a default that every install inherits. **Do not flip the
  base-model default on this data alone.**
- **(b) 1200 → ~600 steps.** Not supported either, but not in the direction
  #1321 hypothesized. Step 600 was **weaker on identity than step 900 in both
  arms** — at 600 neither arm shows the character's distinguishing trait, both
  are still dominated by the generic "dark fantasy" style leak. So cutting to
  ~600 steps would ship a *worse* result than the current 1200-step default's
  own best checkpoint, not a cheaper equivalent one. **Do not cut steps to
  ~600.**
- **Unplanned finding: the final checkpoint (1200) was not the best checkpoint
  in either arm.** Both arms peaked at step 900 and visibly regressed by 1200
  (softer render, drifting hair color/length) — consistent, same-shape
  degradation in both independent runs, which makes it a more reliable signal
  than the single-run 4B-vs-9B comparison above. This doesn't call for changing
  `TRAINING_DEFAULTS.steps` (a shorter *default* would have missed each arm's own
  best point, since 900 only reads as a peak in hindsight against 1200's decline
  — earlier isn't reliably better, later isn't reliably better, it needs the
  full curve to tell). What it does support: the existing checkpoint picker
  (mentioned in #2791/#1321 — the run keeps checkpoints at every `sampleEvery`
  interval, not just the final step) is doing real work, and users training a
  single-character LoRA should be pointed at comparing checkpoints rather than
  assuming the last one is best. No code change needed here since that picker
  already exists; noting it so it doesn't get relearned from scratch.

`TRAINING_DEFAULTS` and the base-model picker in
`server/services/loraTraining/runtimes.js` stay exactly as they are. This closes
the "blocked on empirical fidelity validation" gate on #2791 with a documented
stay-as-is outcome — the experiment ran to completion, both questions were
evaluated against real evidence, and the evidence does not clear the bar #2791
set for changing a default every install inherits. A future attempt to revisit
(a-alt) should replicate with a second seed and, ideally, clean (non-leaking)
captions before trusting the direction found here.

## Run artifacts

- **Run A (4B):** `9f6fce7e-bbce-44c3-8deb-a1acb5409639` — adapter
  `data/training-runs/9f6fce7e-bbce-44c3-8deb-a1acb5409639/adapter/0001200_adapter.safetensors`,
  samples in `data/training-runs/9f6fce7e-bbce-44c3-8deb-a1acb5409639/samples/`.
- **Run B (9B):** `151f3631-58f4-4ecc-833a-e9d02733301d` — LoRA
  `lora-trained-freydis-a-b-9b-8bit-defaults-2791-151f3631.safetensors`, samples
  in `data/training-runs/151f3631-58f4-4ecc-833a-e9d02733301d/samples/`.

