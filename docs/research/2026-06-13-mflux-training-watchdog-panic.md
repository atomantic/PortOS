# Incident: GPU watchdog-timeout kernel panic during mflux LoRA training

**Status:** Open — monitoring for recurrence
**First observed:** 2026-06-13 (two panics same day; a third on 2026-06-14)
**Affected:** `Mac17,7` (Apple Silicon, `T6050` SoC), macOS 26.5 (`Darwin 25.5.0`, `xnu-12377.121.6~2`)
**Trigger:** Sustained GPU compute during mflux FLUX.2 LoRA training (`scripts/train_mflux_lora.py` → `mflux-train`)

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
