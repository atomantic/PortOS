# Incident: GPU watchdog-timeout kernel panic during mflux LoRA training

**Status:** Open — monitoring for recurrence
**First observed:** 2026-06-13 (two panics same day; a third on 2026-06-14)
**Affected:** `Mac17,7` (Apple Silicon, `T6050` SoC), macOS 26.5 (`Darwin 25.5.0`, `xnu-12377.121.6~2`)
**Trigger:** Sustained GPU compute during mflux FLUX.2 LoRA training (`scripts/train_mflux_lora.py` → `mflux-train`)

## Upstream root cause + fix (2026-06-27, #1329)

Searched the mflux and MLX trackers. **mflux has no relevant issue**; **MLX has two
open ones that together explain this incident**, so we did NOT file a duplicate:

- **[mlx #3267](https://github.com/ml-explore/mlx/issues/3267)** (open, `wontfix`) —
  *"Metal GPU watchdog kills LoRA training when display is active."* The watchdog
  fires when MLX command buffers compete with **active-display WindowServer
  compositing** (`kIOGPUCommandBufferCallbackErrorImpactingInteractivity`). The
  MLX maintainer (@zcbenz) gave a confirmed workaround — set
  **`AGX_RELAX_CDM_CTXSTORE_TIMEOUT=1`** (relax the AGX CDM context-store timeout
  so a long command buffer isn't judged interactivity-impacting); the reporter:
  "Completely resolved." `wontfix` only because the policy is OS-controlled, not
  because the workaround fails. **Crucial caveat: the kill is at the IOGPU layer
  *above the process boundary*, so subprocess isolation / process-teardown
  segmentation does NOT prevent it** — re-spawning the worker just gets killed
  again. Other confirmed user-side mitigations: `caffeinate -s` + lid closed,
  display-sleep, or SSH headless (no WindowServer GPU contention).
- **[mlx #3186](https://github.com/ml-explore/mlx/issues/3186)** (open; Apple
  `FB22091885`) — a separate IOGPU **kernel panic** (`completeMemory() prepare
  count underflow` @IOGPUMemory.cpp:550), an Apple `IOGPU.kext` memory-management
  bug. Corroborated on M4 Max, M3 Ultra, M1 Ultra, Mac mini M4, **and M5** ("system
  reboots to a black screen"). No fix yet; zcbenz is "checking internally."

**Our signature differs from both** (`watchdog timeout: no checkins from watchdogd`
vs #3267's process-kill exception and #3186's `completeMemory` panic), but it is
the same family: a system-level GPU/Metal driver stall under sustained ML load on
new Apple Silicon, escalating to a `watchdogd` reboot on M5. So our exact panic
string may be a third manifestation — worth adding as a data-point comment on
#3186 (the panic tracker) when convenient, rather than a fresh issue.

**Action taken (#1329):** PortOS now sets `AGX_RELAX_CDM_CTXSTORE_TIMEOUT=1`
automatically in `scripts/train_mflux_lora.py` (mirrors the `generate_ltx2.py`
env-knob pattern; propagates to the `mflux-train` child Popen). The trainer logs
`STATUS:watchdog mitigation · AGX_RELAX_CDM_CTXSTORE_TIMEOUT=…` so a paniclog
records whether it was active. The pinned 0.31.2 trio (this same PR's predecessor
#1746) stands. The destructive seg-OFF version-bisect is now **lower priority** —
the env-var fix attacks the actual cause and is far cheaper to validate than a
version sweep; validate by running a sustained (seg-OFF) job with the display
asleep and the env var set, before concluding anything about versions.

## Summary

The machine hard-rebooted twice in one day, both times while a LoRA training run
was active. Both crashes are **kernel watchdog-timeout panics** — the entire
system stopped making forward progress long enough (90s) that the watchdog
daemon could not check in, so the hardware watchdog force-rebooted the box. This
is a *system-level hang*, not a fault in PortOS or the training script. The
PortOS server errors seen afterward (training `SIGINT`/`KeyboardInterrupt`,
`Tombstone sweep failed: timeout … connect`, `CoS Runner … xhr poll error`) are
all downstream effects of the abrupt reboot.

## Evidence

Two panic reports under `/Library/Logs/DiagnosticReports/`, identical signature:

| Time (local) | panicString | product | caller |
|---|---|---|---|
| 06-13 06:28:45 | `watchdog timeout: no checkins from watchdogd in 90 seconds` | `Mac17,7` | `0x…40a65d8c` |
| 06-13 20:49:36 | `watchdog timeout: no checkins from watchdogd in 90 seconds` | `Mac17,7` | `0x…477fdd8c` |
| 06-14 07:26:47 | `watchdog timeout: no checkins from watchdogd in 93 seconds` | `Mac17,7` | `0x…49c65d8c` |

The caller addresses differ **only by the ASLR kernel slide** (all three share
the `…65d8c` low bytes) — i.e. it is the same code path firing every time. The
06-14 recurrence happened with the 2026-06-13 mitigations (checkpoint floor,
memory-pressure reclaim) already shipped, and **no `powermetrics.log` was
captured on any of the three** — the telemetry sidecar no-ops because
passwordless `sudo` for `powermetrics` was never configured, so all three
crashes are still blind on the thermal-vs-driver question. Enabling the sidecar
(below) is the top priority before the next run.

Key fields from the 20:49 paniclog:

- Panic backtrace top frames are in `com.apple.driver.AppleARMWatchdogTimer` and
  `com.apple.driver.AppleInterruptControllerV3` — i.e. the watchdog itself, not
  the originating fault. CPU 0 is just the core that serviced the timer.
- `CORE 6–11 [MACC1] is offline` in **both** logs. This is almost certainly
  normal idle power-gating of one cluster at panic time, not a hardware fault —
  noted here only so a future investigator doesn't misread it.
- `Compressor Info: 13% of compressed pages limit (OK) … 21 swapfiles and OK
  swap space` — memory pressure was elevated but not critical at panic time, so
  an OOM/swap-thrash root cause is possible but not strongly indicated.
- `last started kext … com.apple.driver.AppleUVDMDriver` — unremarkable.

## Analysis

A `watchdogd` timeout means *nothing* could be scheduled for 90s — the strongest
signal is a low-level stall rather than an ordinary userspace bug. Given the tight
correlation with sustained Metal/GPU compute on **brand-new M5-class silicon
(`T6050` / `Mac17,7`) running a ~6-week-old kernel (built 2026-04-27)**, the
leading hypothesis is a **GPU/Metal driver hang under heavy ML load** — new-silicon
GPU driver bugs commonly present exactly this way (whole system wedges → watchdog
reboot). Secondary hypotheses: thermal/power-delivery trip, or severe
swap thrash if a run oversubscribes unified memory.

## Mitigations shipped (2026-06-14, session 2) — `LORA_TRAIN_MAX_QUANT_BITS`

The real unlock for training on this M5: **cap the training-base quantization so it
never picks bf16.** `deriveMfluxMemoryConfig` mapped ≥96 GB → `quantize:null`
(bf16), which on this box both crawled (couldn't finish one step in 14 min) and
was the 3×-panic config. New env override `LORA_TRAIN_MAX_QUANT_BITS=8|4`
(`server/services/loraTraining/runtimes.js`, committed) caps the top tier at
8- or 4-bit QLoRA (frozen base quantized, LoRA weights full precision) even when
RAM allows bf16. Unset = original behavior (no change for other installs).

**Validated 2026-06-14:** with `=4`, a **9B 4-bit** run (`f7bb4518`, rank 32,
1200 steps, seed 7) trains at **~11 s/step with only ~2.5 GB swap, box stable,
no panic** — vs the bf16 9B attempt that stalled at step 0 with ~18 GB swap. So
9B LoRA training is now viable on this M5 Max via 4-bit QLoRA. The resulting 9B
LoRA applies to the "Flux 2 Klein 9B SDNQ 4-bit" inference model. 4B-4bit for
comparison: ~3.5 s/step.

This makes `LORA_TRAIN_MAX_QUANT_BITS=4` (or 8) the recommended setting for this
machine until a macOS/mlx update fixes the bf16 driver hang. Feeds PLAN item
`lora-training-default-base-tier-too-heavy` (which proposes making this the
default for the ≥96 GB tier rather than an opt-in env var).

## Character-LoRA fidelity findings (2026-06-14, training Freydis)

Independent of the panic, two things blocked a usable Freydis LoRA — neither was
step count alone (initial assumption was wrong):
1. **Captions over-described invariant identity.** All 25 Codex-authored captions
   listed her white hair / circlet / necklace / armor, so those features bound to
   the *words*, not the trigger token `freydis_of_quaervarr`. Bare-trigger renders
   gave a generic woman; full-descriptive renders gave correct Freydis. Fix:
   rewrote captions to keep only the trigger + what *varies* (pose/weapon/setting).
   PLAN: `lora-training-caption-strips-invariant-identity`.
2. **Preview seed 42 fights the prior.** The sample prompt is the bare trigger at a
   *fixed* seed (`runtimes.js`, `--seed`, default 42). Seed 42's base "person" is a
   dark-skinned woman — the opposite of pale-white-haired Freydis — so previews
   *understate* the LoRA (it must overcome that prior every sample). Seed 7's base
   prior is a pale woman, giving honest progress samples. Lesson: the preview seed
   should be configurable / multi-seed (request `params.seed` already overrides it).

## Mitigations shipped (2026-06-13)

1. **Checkpoint crash-resilience floor** — `MFLUX_MIN_CHECKPOINTS = 4` in
   `server/services/loraTraining/runtimes.js`. `save_frequency` is now capped at
   `ceil(totalSteps / 4)` even when the user picks "only final save"
   (`checkpointEvery: 0`) or a very large interval, so a mid-run hard reboot
   loses at most ~¼ of the run. Resume via the existing
   `--resume-checkpoint <newest .zip>` path picks up from the last checkpoint.
2. **GPU/thermal telemetry sidecar** — `TelemetrySidecar` in
   `scripts/train_mflux_lora.py` streams `powermetrics --samplers
   cpu_power,gpu_power,thermal` into `<run>/powermetrics.log` for the life of each
   training run. Gated on a non-interactive `sudo -n` probe: if passwordless
   sudo for `powermetrics` is not configured it no-ops with a STATUS note and
   training proceeds. This gives the next crash a forensic record of GPU temp /
   power leading up to the hang.

3. **Unified-memory pressure mitigations** (`server/services/loraTraining/memoryPrep.js`)
   — directly attacks the swap-thrash secondary hypothesis. A 128 GB box was
   observed at ~122 GB used + ~21 GB swap during a single run, so before a run
   spawns PortOS now:
   - **Unloads resident models** — `prepareMemoryForTraining()` unloads every
     model resident in Ollama and LM Studio (best-effort) so their unified
     memory returns to the pool instead of stacking under the trainer. On a
     shared box this is the largest single reclaim. Only **loopback-local**
     backends are evicted — a remote `OLLAMA_URL`/`LM_STUDIO_URL` (LAN peer)
     is skipped, since unloading it frees no memory on the training machine.
   - **Spills the latent cache to disk at every tier** — `deriveMfluxMemoryConfig`
     now returns `low_ram: true` for all memory sizes (was `false` ≥64 GB). The
     in-RAM encoded-dataset cache bought nothing but swap pressure; disk-backing
     it costs only I/O, not training quality.
   - **Sizes the config to *available* memory + a hard floor** — the
     quantize/`low_ram` tier is derived from post-unload available memory
     (`vm_stat`: free + inactive + speculative + purgeable on macOS), not raw
     RAM, so a busy box auto-tightens to a smaller/quantized base. A run refuses
     to start (`failBeforeSpawn`) below `TRAINING_MIN_HEADROOM_GB` (24 GB)
     rather than swap-thrashing the machine into another reboot.

## Mitigations shipped (2026-06-14, after crash #3)

4. **Segmented training + GPU cooldown** (default ON) — the strongest lever
   short of an OS fix, and a direct response to crashes #1–3 all happening
   *during sustained GPU compute* a fairly consistent depth into the run (a
   signature of a cumulative thermal/driver trigger). Instead of one mflux
   process held open for the whole run, `scripts/train_mflux_lora.py` now trains
   in **checkpoint-sized segments**: train one save interval → **terminate the
   mflux child so its Metal/GPU context is fully torn down** → idle the GPU for a
   cooldown (default 90 s) → `--resume` the newest checkpoint → repeat. mflux
   resume reads `num_epochs` from the checkpoint (the config value is ignored on
   resume), so each segment continues toward the *same* total — segmentation is
   numerically equivalent to one continuous run, just with periodic full-process
   teardown. Sustained GPU pressure therefore never spans more than one segment,
   and any accumulated driver/thermal state resets between segments while the GPU
   clocks down.
   - The child is killed only *after* the trainer steps **past** the boundary,
     guaranteeing the boundary checkpoint zip is fully flushed (no truncation
     from a mid-write kill); resume loses at most the one in-flight step.
   - Wiring: `buildMfluxTrainArgs` emits `--segment-steps <save_frequency>
     --cooldown-sec <n>`; segment size is exactly the config's effective
     `save_frequency` so each segment ends on a checkpoint (no extra checkpoints,
     no lost steps). `server/services/loraTraining/index.js` derives both from
     `settings.loraTraining`.
   - **Globally disable-able** once a macOS/mflux update fixes the underlying
     GPU-driver hang: set `settings.loraTraining.segmentation = false` (or tune
     `segmentCooldownSec`). With segmentation off the wrapper runs as a single
     sustained process again (`--segment-steps 0`).
   - Cost: each segment reloads the (quantized) base model and re-encodes the
     dataset (low_ram wipes+re-encodes on every launch), so a 4-segment run pays
     ~3 extra model loads + cooldowns. Acceptable vs. never completing a run. To
     trade fewer reloads for a longer sustained window, raise `checkpointEvery`
     (which raises `save_frequency` = segment size) — but keep it below the
     ~150–300-step crash window.
   - The cooldown emits a `STAGE:cooldown:heartbeat:<n>s` keep-alive every 30 s,
     which resets the mediaJobQueue idle watchdog (it only resets on emitted
     runner output). Without it a cooldown tuned above the 30-min
     `WATCHDOG_TRAINING_MS` window — `segmentCooldownSec` validates up to 3600 s —
     would get a healthy run killed mid-pause; with it, any cooldown length is
     safe.

### Enabling the telemetry sidecar (passwordless powermetrics)

`powermetrics` needs root. To let training capture telemetry without a prompt,
add a sudoers rule (use `sudo visudo -f /etc/sudoers.d/portos-powermetrics`):

```
<your-username> ALL=(root) NOPASSWD: /usr/bin/powermetrics
```

Without this the sidecar simply skips capture — training is unaffected.

## Phosphene cross-reference (2026-06-14)

Reviewed the `mrbizarro/phosphene` reference repo (it also trains LoRAs
MLX-natively on Apple Silicon) for a watchdog fix. Full write-up:
`docs/plans/2026-06-14-lora-watchdog-phosphene-review.md`. Key takeaways:

- **Negative result — do NOT add an `mx.eval`-cadence "fix" to the trainer.**
  Phosphene's `LTX2_DIT_EVAL_EVERY` flush bounds the Metal command buffer on the
  *inference* denoise loop (no autodiff), and PortOS already uses it on the LTX-2
  generation path (`scripts/generate_ltx2.py:63`). It does **not** transfer to
  mflux training: mflux reads no such env var, its step fuses forward+backward
  under `nn.value_and_grad` materialized by a single `mx.eval`
  (`mflux/.../training/trainer.py:141-143`) which a per-block flush can't split,
  and `batch_size` is 1 (`runtimes.js:204`) so there's no batch loop to chunk.
  A per-step panic on a 768px batch-1 step is consistent with a system stall,
  not a too-long single GPU kernel — reinforcing the driver-hang hypothesis.
- **Out-of-process watchdog is the only kind that works.** Phosphene confirmed an
  in-Python daemon-thread watchdog is starved by Metal's GIL-holding dealloc
  chain; PortOS's Node orchestrator + segmentation already sit on the right side
  of that. A phase-aware *soft*-hang stall detector would help wedged-not-rebooted
  runs but cannot catch the hard reboots seen here (PLAN:
  `lora-training-phase-aware-soft-hang-stall-watchdog`).
- **Version-bisect, then pin a validated trio** (phosphene's "every pin is a paid
  lesson"). This is the most promising untried lever for a new-silicon driver
  hang; tracked as PLAN `lora-training-version-bisect-and-pin-validated-trio`
  (current stack: mflux 0.17.5 · mlx 0.30.6 · mlx-metal 0.30.6 · mlx-lm 0.29.1).

### Confirmed on the hardware (2026-06-14)

This dev box **is** the panicking machine: Apple **M5 Max** `Mac17,7`/`T6050`,
macOS **26.5.1** (`25F80`) — and `softwareupdate -l` shows **no OS update
available**, so Apple hasn't shipped a driver fix; the paniclogs confirm the OS
was already 26.5.1 at all three crashes (this doc's earlier "26.5" was imprecise).
**Passwordless `powermetrics` is now configured**, so the next run captures the
thermal/power forensics that were blind on all three prior panics. In-constraint
upgrade room: mlx/mlx-metal → **0.31.2** (mflux caps `<0.32`; its `dev` extra
pins `mlx==0.31.0`), mflux → **0.18.0**.

A **ready-to-run bisect harness** (reuses run `15cfeed1…` — 25 img × 24 ep, bf16,
the most panic-prone config; runs with `--segment-steps 0` to reproduce the
sustained condition) is written up in
`docs/plans/2026-06-14-lora-watchdog-phosphene-review.md` → "Ready-to-run bisect
procedure". **Not yet run** — it can hard-reboot the box, so it waits for an
explicit go. Upstream issue drafted at
`docs/research/2026-06-14-upstream-issue-draft-m5-watchdog.md`.

## Bisect log (live — survives session-killing reboots)

Repro: run `15cfeed1…` (FLUX.2 Klein **9B bf16**, 768px, batch 1, 25 img × 24 ep
= 600 steps), `--segment-steps 0` (segmentation OFF → sustained GPU), telemetry
armed. Output redirected to a scratch dir so the original run's artifacts are
untouched. Update this table BEFORE launching each candidate so a hard reboot
doesn't lose which version was under test.

| When | mflux | mlx | mlx-metal | Result | powermetrics verdict |
|---|---|---|---|---|---|
| (baseline, not run) | 0.17.5 | 0.30.6 | 0.30.6 | known-bad (3 panics 06-13/14) | none captured (sudo was off) |
| 2026-06-14 candidate #1 | 0.17.5 | **0.31.2** | **0.31.2** | ✅ **VALIDATED (seg-ON)** — full LoRA run `d36562a0` completed to adapter extraction (4B bf16, 768px, 4×150-step segs); box up, no panic. Pinned 2026-06-27 (#1329). | telemetry captured; GPU/power normal through the run |

**Verdict & pin (2026-06-27, #1329).** The candidate #1 "IN FLIGHT" row above was
the *seg-OFF scratch* run, which was **manually stopped clean at step ~11** (never
reached the 150–300-step panic window) and superseded — it did NOT panic. The
real validation is run **`d36562a0`** (`flux2-klein-4b`, bf16, 768px, segmentation
ON: 4 × 150-step segments), which **COMPLETED to adapter extraction** on
mflux 0.17.5 · mlx 0.31.2 · mlx-metal 0.31.2 with no panic and no reboot
(`STATUS.txt`: "VERDICT: COMPLETED — adapter extracted"). That trio is now pinned
in `scripts/setup-image-video.sh` (replacing the `mflux>=0.17` floor that let mlx
drift), per phosphene's "every pin is a paid lesson."

This validates the **production config** (segmentation ON — the shipped
mitigation). The **pure seg-OFF sustained 9B-bf16 verdict on 0.31.2 remains
untested** — a seg-OFF run reproduces the original panic condition and risks a
session-killing hard reboot (~3.5–7 h to clear the panic window at ~1.3–1.6
min/step). Run it on the throwaway dataset if a definitive "the driver hang
itself is fixed" answer is wanted; until then the pin rests on a completed
real-world run plus segmentation as the standing mitigation. The upstream
mflux/MLX issue draft (`docs/research/2026-06-14-upstream-issue-draft-m5-watchdog.md`)
stays unfiled pending a telemetry-captured seg-OFF repro that disambiguates
thermal vs driver.

**Speed finding (2026-06-14 ~14:10) — 9B bf16 is pathologically slow on this box; 4B is ~25× faster.**
The first Freydis run (`flux2-klein-9b`, bf16, 768px, 600 steps) ran **14 minutes
without completing a single real `/600` training step** — only the step-0
checkpoint. On a 128 GB box `deriveMfluxMemoryConfig(≥96)` forces `quantize:null`
(full bf16); the 32 GB base-9B transformer materialized for the fused
forward+backward (`nn.value_and_grad`) appears to hit memory/swap pressure (swap
was ~18 GB) and crawl. Restarted with **`flux2-klein-4b`** (15 GB base), 400
steps, 768px → steady **~3.5 s/step**, full run **~35 min** incl. 3 segment
cooldowns. The dominant lever was the **base-model size, not the step count**:
600→400 steps is minor; 9B-bf16 → 4B is the ~25× win for a single-character LoRA
(run `d36562a0…`). Open question for `TRAINING_DEFAULTS` / `deriveMfluxMemoryConfig`:
the ≥96 GB tier picking unquantized 9B may be the wrong default — 4B or 9B-8bit
is far faster with little fidelity loss for character LoRAs. Tracked as a PLAN
item rather than changed mid-incident.

**Pivot (2026-06-14 ~13:51):** the seg-OFF scratch bisect was stopped at
step ~10 (clean, no panic — manually terminated) and replaced with a **real
Freydis training run** through the live server (run `7de50766…`, dataset
`90043893…` = Freydis of Quaervarr, `flux2-klein-9b`, **segmentation ON**:
`--segment-steps 150 --cooldown-sec 90` = 4 segments). Rationale: her training
had failed/canceled 3× (the panics; no LoRA existed), and the scratch run was
already grinding her exact dataset into a throwaway dir. Dual-purposing it on
the mlx **0.31.2** stack finishes her LoRA *and* gives 0.31.2 a real-world test.
Trade-off: with segmentation ON a survived run proves "0.31.2 + segmentation
completes" (the production config), NOT "0.31.2 alone survives sustained GPU" —
the pure seg-OFF verdict on 0.31.2 remains untested (rerun on the throwaway
dataset later if wanted). Telemetry still capturing per-run.

**Candidate #1 live notes (2026-06-14 ~13:45, seg-OFF scratch — superseded):** scratch run
`data/training-runs/_bisect-mlx0312/` (9B bf16, 768px, low_ram, segmentation
OFF). The wrapper's `STEP:n:40` lines at the start are the **step-0 preview
image** (40 denoise steps), NOT training — real training is the `STEP:n:600`
series (minor wrapper-cosmetics bug: `TQDM_RE` catches the preview bar; worth a
PLAN note, not blocking). Real-step rate is **~1.3–1.6 min/step** (9B bf16 +
low_ram disk cache + ~21 GB swap on a shared box), so the **150–300-step panic
window is ~3.5–7 h out** and a full 600-step run ~15 h. No panic through step
~11. If this row still says IN FLIGHT after a reboot, candidate #1 panicked —
read the scratch powermetrics.log.

Candidate #1 rationale: bump only the MLX/Metal backend (highest-probability
driver-hang fix); mflux held at 0.17.5 to isolate the variable. mflux caps
`mlx<0.32` and its `dev` extra pins `mlx==0.31.0`, so 0.31.2 is in-range and
closer to what mflux develops against than the installed 0.30.6.
**Resolved 2026-06-27 (#1329):** candidate #1 did NOT panic — the seg-OFF scratch
was manually stopped clean and superseded by the completed seg-ON run `d36562a0`.
The 0.31.2 trio is now pinned (see "Verdict & pin" under the bisect table above).

## If it recurs — investigation checklist

1. **Read the telemetry.** Open the newest `<run>/powermetrics*.log` from the
   crashed run (a resume rolls the prior log to a timestamped name, so the
   pre-crash capture is the one with the highest timestamp / matching the run).
   - GPU die temp climbing toward ~100°C / SMC throttle flags set right before
     the gap → **thermal/power**. Improve cooling, ensure high-watt AC adapter,
     reduce load.
   - Temps/power normal, log just stops → **driver hang**. Pursue an OS/mflux
     update and file upstream.
2. **Diff the new paniclog** against this record (`/Library/Logs/DiagnosticReports/
   panic-full-*.panic`): same `watchdogd` signature + same caller (mod slide)
   confirms the same fault.
3. **Reduce sustained GPU pressure** as a controlled test — lower batch
   size/resolution/rank (`TRAINING_DEFAULTS`) and see if the crash stops. If a
   lighter run survives, intensity is the trigger.
4. **Update the stack** — macOS point release, `pip install -U mflux mlx`. Search
   the mflux / MLX issue trackers for `M5` / `watchdog` / `hang`.
5. **Rule out hardware** only if the above don't resolve it — Apple Diagnostics
   (boot holding **D**).

## References

- `docs/TROUBLESHOOTING.md` → "GPU watchdog kernel panic during LoRA training"
- `scripts/train_mflux_lora.py` (`TelemetrySidecar`)
- `server/services/loraTraining/runtimes.js` (`MFLUX_MIN_CHECKPOINTS`)
