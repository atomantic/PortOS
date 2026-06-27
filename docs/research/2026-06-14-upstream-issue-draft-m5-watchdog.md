# Draft upstream issue — M5 Max GPU watchdog kernel panic under sustained MLX LoRA training

> **DO NOT FILE AS A NEW ISSUE (updated 2026-06-27, #1329).** A tracker search found
> existing open MLX issues that cover this — **[mlx #3267](https://github.com/ml-explore/mlx/issues/3267)**
> (watchdog kills LoRA training when the display is active; confirmed workaround
> `AGX_RELAX_CDM_CTXSTORE_TIMEOUT=1`) and **[mlx #3186](https://github.com/ml-explore/mlx/issues/3186)**
> (IOGPU `completeMemory()` kernel panic, filed with Apple as FB22091885). mflux
> itself has no relevant issue. Our `watchdogd`-timeout signature differs slightly
> from both, so the right contribution is a **data-point comment on #3186** (the
> kernel-panic tracker), not a fresh issue. Keep the environment/symptom material
> below as the body of that comment if/when posting. See the "Upstream root cause
> + fix" section of the incident doc.

---

**Title:** Sustained FLUX.2 LoRA training hard-reboots Apple M5 Max (Mac17,7 / T6050) — `watchdog timeout: no checkins from watchdogd`

**Environment**
- Hardware: Apple **M5 Max**, `Mac17,7`, SoC `T6050` (socRevision 11), 128 GB unified memory
- OS: macOS **26.5.1** (`25F80`), kernel `Darwin 25.5.0 … xnu-12377.121.6~2/RELEASE_ARM64_T6050` (built 2026-04-27) — fully up to date (`softwareupdate -l` → no new software)
- mflux **0.17.5**, mlx **0.30.6**, mlx-metal **0.30.6**, mlx-lm 0.29.1, Python 3.14
- Workload: `mflux-train` FLUX.2 Klein LoRA, 25-image dataset, 768px, batch_size 1, `quantize: null` (bf16 base), `low_ram: true`, 600 steps

**Symptom**
The machine **hard-reboots** mid-training. Three reproductions, all kernel watchdog-timeout panics with an identical signature (the caller addresses differ only by the ASLR kernel slide — same low bytes `…65d8c` each time):

| Time (local) | panicString |
|---|---|
| 2026-06-13 06:28:45 | `watchdog timeout: no checkins from watchdogd in 90 seconds` |
| 2026-06-13 20:49:36 | `watchdog timeout: no checkins from watchdogd in 90 seconds` |
| 2026-06-14 07:26:47 | `watchdog timeout: no checkins from watchdogd in 93 seconds` |

Panic backtrace top frames are in `com.apple.driver.AppleARMWatchdogTimer` /
`AppleInterruptControllerV3` — i.e. the watchdog firing, not the originating
fault. A `watchdogd` timeout means nothing could be scheduled for ~90s, so this
is a system-level stall, not an ordinary userspace error. The crashes occur a
fairly consistent depth into the run (sustained GPU compute), suggesting a
cumulative driver/thermal trigger rather than a specific op.

**What we've ruled in/out**
- Memory pressure was *elevated but not critical* at panic time (compressor ~13% of limit, swap OK), so OOM/swap-thrash is possible but not strongly indicated.
- Per-step work is tiny (768px, batch 1, single forward+backward) — not a single long-running kernel.
- Leading hypothesis: a **GPU/Metal driver hang on new M5-class silicon** under sustained ML load.

**Questions for maintainers**
1. Any known M5/`T6050` Metal-backend hangs under sustained training in mlx-metal 0.30.x? Is 0.31.x expected to help? (mflux's `dev` extra pins `mlx==0.31.0`.)
2. Recommended `mx.set_wired_limit` / memory-limit settings for a 128 GB box to avoid starving the scheduler?
3. Any backend flag to bound Metal command-buffer submission size during training?

**Attachments to include when filing:** the three `panic-full-*.panic` files and the per-run `powermetrics.log` once a telemetry-captured repro exists.
