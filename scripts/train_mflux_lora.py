#!/usr/bin/env python3
"""mflux FLUX.2 LoRA training wrapper (PortOS).

Wraps mflux's own trainer (`mflux-train`, mflux ≥0.17 — FLUX.1 training
was removed upstream) in a subprocess and translates its native output
into the PortOS trainer line protocol (see train_flux2_lora.py header /
server/services/loraTraining/progress.js). We deliberately do NOT import
mflux's training internals in-process — their API churns across versions;
the CLI + config JSON is the stable surface (same wrap-don't-import
strategy as generate_wan22.py).

Verified against mflux 0.17.5:
  - CLI: `mflux-train --config <json>` (resume: `--resume <checkpoint.zip>`).
  - Progress: a tqdm bar over total iterations (epochs × images), written
    with carriage returns — the reader splits on \\r AND \\n.
  - Outputs under the config's checkpoint.output_path:
      checkpoints/NNNNNNN_checkpoint.zip   (adapter + optimizer + config)
      preview/NNNNNNN_preview_*.png        (when monitoring is enabled)
      loss/loss.html
  - The trained adapter inside each zip is `NNNNNNN_adapter.safetensors`
    with diffusers-style key naming (`transformer.<module>.lora_A.weight`),
    so the extracted file loads directly in diffusers flux2 pipelines.

SIGTERM → forwarded to the mflux child; exit 143 after it stops (mflux
checkpoints at save_frequency boundaries; mid-interval cancels keep the
last saved checkpoint).

Segmented training (watchdog-panic mitigation). When `--segment-steps N`
is passed (>0), the run is broken into N-step segments instead of one
sustained mflux process: train to a checkpoint boundary, **terminate the
mflux child so its Metal/GPU context is fully torn down**, sleep
`--cooldown-sec` to let the GPU clock down + the system settle, then
`--resume` the newest checkpoint for the next segment. mflux resume reads
`num_epochs` from the checkpoint (the config value is ignored on resume),
so each segment continues toward the *same* total — segmentation is
numerically equivalent to one continuous run, just with periodic
full-process teardown. This directly attacks the macOS GPU
watchdog-timeout kernel panics that hard-reboot the machine during long
sustained mflux runs (see docs/research/2026-06-13-mflux-training-watchdog-panic.md):
sustained GPU pressure never spans more than one segment, and any
accumulated driver/thermal state resets between segments. `--segment-steps 0`
(the default) restores the single-process behavior.
"""

import argparse
import atexit
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import zipfile
from collections import deque
from datetime import datetime
from pathlib import Path

# macOS GPU-watchdog mitigation (mlx #3267). The Metal/AGX driver kills sustained
# LoRA training under the GPU watchdog ("Impacting Interactivity" → process kill,
# and on M5-class silicon escalating to a `watchdogd` kernel panic + hard reboot;
# see docs/research/2026-06-13-mflux-training-watchdog-panic.md). The MLX
# maintainer's confirmed workaround is to relax the AGX CDM context-store timeout
# so a long command buffer isn't treated as a stuck/interactivity-impacting one.
# It is read by the driver at Metal context creation, so it MUST be set before
# mlx initializes — we set it here at module load, and since the mflux-train
# child Popen (below) inherits this process env, the child gets it too. setdefault
# lets an explicit override (or =0 to disable) still win. NOTE: per mlx #3267 the
# kill is at the IOGPU layer *above* the process boundary, so process-teardown
# segmentation alone does NOT prevent it — this env var attacks the actual cause.
os.environ.setdefault("AGX_RELAX_CDM_CTXSTORE_TIMEOUT", "1")

CHILD = None
STOP_REQUESTED = False

# How many of the trainer's recent non-progress output lines to retain and
# replay to stderr on a non-zero exit (so the Node failure classifier sees the
# real error, not just the exit code). See the loop in main().
OUTPUT_TAIL_LINES = 40

# Packages whose resolved versions form the LoRA-training stack fingerprint. The
# macOS GPU watchdog kernel panics (docs/research/2026-06-13-mflux-training-watchdog-panic.md)
# are version-specific to this trio + mlx-lm, so emitting them at startup makes
# every run log and any future paniclog self-document the exact stack it ran on
# (mirrors the video-gen runtime fingerprint — _runner_common.emit_runtime_fingerprint).
RUNTIME_FINGERPRINT_PACKAGES = ["mflux", "mlx", "mlx-metal", "mlx-lm"]


def log(msg: str) -> None:
    print(msg, flush=True)


def format_runtime_fingerprint_line(fp: dict) -> str:
    """Render a build_runtime_fingerprint() dict to the one-line STATUS string
    the trainer logs at startup. Pure (no I/O) so it is unit-testable without a
    real mflux/mlx install. Absent packages are simply omitted from `versions`
    by the builder, so they never appear here."""
    versions = fp.get("versions") or {}
    parts = [f"{name} {ver}" for name, ver in versions.items()] or ["versions unavailable"]
    for field in ("chip", "os", "python"):
        val = fp.get(field)
        if val:
            parts.append(f"{field} {val}" if field == "python" else str(val))
    return "STATUS:runtime · " + " · ".join(parts)


def emit_runtime_fingerprint() -> dict:
    """Log a one-line runtime fingerprint (mflux/mlx/mlx-metal/mlx-lm versions +
    Apple chip + macOS + python) at trainer startup. Best-effort: a fingerprint
    failure must never abort a training run, so all of it is guarded. Reuses the
    shared _runner_common.build_runtime_fingerprint so the trainer log and the
    video-gen /status probe never drift. Returns the dict it emitted (or {})."""
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from _runner_common import build_runtime_fingerprint  # noqa: PLC0415

        fp = build_runtime_fingerprint("mflux-lora", RUNTIME_FINGERPRINT_PACKAGES)
        log(format_runtime_fingerprint_line(fp))
        return fp
    except Exception as err:  # pragma: no cover - defensive; never abort a run
        log(f"STATUS:runtime fingerprint unavailable ({err})")
        return {}


def _on_sigterm(_sig, _frame):
    global STOP_REQUESTED
    STOP_REQUESTED = True
    log("STATUS:cancel requested — stopping mflux trainer")
    if CHILD and CHILD.poll() is None:
        CHILD.terminate()


signal.signal(signal.SIGTERM, _on_sigterm)


def parse_args():
    p = argparse.ArgumentParser(description="mflux LoRA training wrapper")
    p.add_argument("--config", required=True, help="mflux-train config JSON")
    p.add_argument("--output-dir", required=True, help="PortOS run dir (samples/ lives here)")
    p.add_argument("--total-steps", type=int, default=1000,
                   help="expected total iterations — segment planning + logging sanity")
    p.add_argument("--resume-checkpoint", default=None, help="checkpoint zip to resume from")
    p.add_argument("--segment-steps", type=int, default=0,
                   help="0 = single sustained run; >0 = train in N-step segments, tearing "
                        "down the GPU child + cooling down between each (watchdog-panic mitigation)")
    p.add_argument("--cooldown-sec", type=int, default=90,
                   help="seconds to idle the GPU between segments (only with --segment-steps>0)")
    return p.parse_args()


# Checkpoint zips are named NNNNNNN_checkpoint.zip where NNNNNNN is the
# trainer's cumulative iteration count — the canonical "where did we get to".
CKPT_RE = re.compile(r"(\d+)_checkpoint\.zip$")


def _checkpoint_step(path) -> int:
    if not path:
        return 0
    m = CKPT_RE.search(Path(path).name)
    return int(m.group(1)) if m else 0


def newest_checkpoint(configured_output: Path):
    """Newest checkpoint zip under the (possibly timestamp-suffixed) mflux
    output dir. mflux `--resume` writes back to the SAME output_path
    (new_folder=False), so checkpoints accumulate in one dir across segments;
    ranking by embedded step keeps the pick monotonic even if mtimes tie."""
    cdir = resolve_mflux_output(configured_output) / "checkpoints"
    if not cdir.is_dir():
        return None
    zips = list(cdir.glob("*_checkpoint.zip"))
    if not zips:
        return None
    return max(zips, key=lambda z: (_checkpoint_step(z), z.stat().st_mtime))


def _terminate_child(timeout: float = 15.0) -> None:
    """SIGTERM the mflux child and reap it (escalate to SIGKILL if it lingers).
    Used at segment boundaries to fully release the Metal/GPU context."""
    global CHILD
    if CHILD and CHILD.poll() is None:
        CHILD.terminate()
        try:
            CHILD.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            CHILD.kill()


# Cooldown heartbeat cadence. The mediaJobQueue idle watchdog resets only on
# emitted runner output (progress.js emits 'activity' for every non-noise line),
# so a silent cooldown longer than the watchdog window would get a healthy run
# killed mid-pause. segmentCooldownSec is validated up to 3600s — above the 1800s
# default watchdog — so the cooldown MUST keep the watchdog fed itself rather than
# rely on the setting staying small.
HEARTBEAT_INTERVAL_SEC = 30


def interruptible_sleep(seconds: float, heartbeat_stage: str | None = None) -> None:
    """Sleep up to `seconds`, returning early if a SIGTERM cancel arrives — so
    the inter-segment cooldown never delays a user-requested stop. When
    `heartbeat_stage` is set, emit a `STAGE:<stage>:heartbeat:<elapsed>s`
    keep-alive every HEARTBEAT_INTERVAL_SEC so the idle watchdog sees activity
    during a long pause (the `:heartbeat:` form resets the watchdog without
    emitting a status message or changing the displayed stage)."""
    start = time.monotonic()
    end = start + seconds
    next_beat = start + HEARTBEAT_INTERVAL_SEC
    while not STOP_REQUESTED:
        now = time.monotonic()
        remaining = end - now
        if remaining <= 0:
            return
        if heartbeat_stage and now >= next_beat:
            log(f"STAGE:{heartbeat_stage}:heartbeat:{int(now - start)}s")
            next_beat = now + HEARTBEAT_INTERVAL_SEC
        time.sleep(min(1.0, remaining))


def build_command(config_path: str, resume: str | None) -> list:
    """`mflux-train` console script next to THIS interpreter (no PATH
    ambiguity); fallback to the module behind it."""
    console = Path(sys.executable).parent / "mflux-train"
    if console.exists():
        cmd = [str(console)]
    else:
        probe = subprocess.run(
            [sys.executable, "-c",
             "import importlib.util as u; raise SystemExit(0 if u.find_spec('mflux.models.common.cli.train') else 1)"],
            capture_output=True,
        )
        if probe.returncode != 0:
            print(
                "USER_ERROR:MODULE_NOT_FOUND:mflux trainer not found (no mflux-train script and no "
                "mflux.models.common.cli.train module) — update mflux to ≥0.17",
                file=sys.stderr, flush=True,
            )
            sys.exit(2)
        cmd = [sys.executable, "-m", "mflux.models.common.cli.train"]
    if resume:
        cmd += ["--resume", resume]
    else:
        cmd += ["--config", config_path]
    return cmd


# tqdm renders like `  3%|▎         | 12/400 [00:30<16:20,  2.53s/it]`.
TQDM_RE = re.compile(r"(\d+)\s*/\s*(\d+)\s*\[")
# Belt-and-suspenders for any explicit "step N/M ... loss X" prose a future
# mflux version might print.
STEP_LOSS_RE = re.compile(r"[Ss]teps?[\s:=]+(\d+)\s*/\s*(\d+).*?[Ll]oss[\s:=]+([\d.eE+-]+)")
NOISE_RE = re.compile(r"FutureWarning|UserWarning|DeprecationWarning", re.I)

# We merge the mflux child's stderr into its stdout (so tqdm + prints stay in
# order), which means the Node side tags every line `stream='stdout'` and the
# JS failure classifier's stderr-tail stays empty for mflux runs. To keep
# OOM / missing-module / gated-repo errors classifiable, sniff them out of the
# merged stream and re-emit a structured USER_ERROR line (which the Node line
# parser captures regardless of stream). Codes mirror failure.js.
FATAL_PATTERNS = [
    ("OOM", re.compile(r"out of memory|Insufficient Memory|Metal.*out of memory|std::bad_alloc", re.I)),
    ("MODULE_NOT_FOUND", re.compile(r"ModuleNotFoundError|No module named", re.I)),
    ("HF_AUTH", re.compile(r"GatedRepoError|401 Client Error|is restricted|Repo.*is gated", re.I)),
]
# NOTE: argparse rejections (a too-old mflux that wants `--train-config` / has
# no flux2 base models — the exact "exited with code 2" failure) are
# deliberately NOT sniffed here. A USER_ERROR line short-circuits
# classifyTrainingFailure on its *raw* text (failure.js), so sniffing the
# argparse line would surface "unrecognized arguments: --config …" instead of
# the actionable "upgrade mflux>=0.17" hint. Left unsniffed, the line rides the
# non-zero-exit tail replay to stderr and failure.js's CLI_MISMATCH_RE renders
# the actionable message — one source of truth for that text, on the JS side.


def is_preview_progress_bar(line, cur, total, *, has_step_loss, preview_steps, training_total):
    """True if a matched tqdm bar belongs to the preview/sample IMAGE generation
    rather than the training loop.

    mflux runs `adapter.generate_preview_image` (→ `flux2.generate_image`) once
    before training (step 0) and again at every sample interval. That diffusion
    sampler prints its own tqdm bar whose total is the DENOISE step count
    (`config["steps"]`, e.g. 40) — identical in shape to the training bar except
    the total differs (training total = epochs × images). If we don't exclude it
    the wrapper both mislabels denoise ticks as training STEPs and lets them
    perturb `state["step"]`, which gates the segment-boundary kill (a preview bar
    reading 38/40 could spuriously satisfy a 150-step boundary).

    Discriminators, all required:
      - `has_step_loss` False — the explicit "step N/M … loss X" prose is emitted
        only by the training loop, never the sampler, so it's never a preview.
      - `preview_steps` known (caller passes None when steps == training_total,
        the degenerate tiny-dataset case where totals can't disambiguate).
      - the bar's total equals `preview_steps` and differs from `training_total`.
    """
    if has_step_loss or preview_steps is None:
        return False
    return total == preview_steps and (training_total is None or total != training_total)


def resolve_mflux_output(configured: Path) -> Path:
    """mflux appends `_YYYYMMDD_HHMMSS` to checkpoint.output_path when the
    configured dir already exists (its new-run-folder behavior) — a killed
    previous attempt leaving the dir behind is enough to trigger it. Pick
    the newest candidate among the configured path and its timestamped
    siblings so the watcher + adapter discovery track where mflux actually
    wrote."""
    candidates = [p for p in [configured, *configured.parent.glob(f"{configured.name}_2*")] if p.is_dir()]
    if not candidates:
        return configured
    return max(candidates, key=lambda p: p.stat().st_mtime)


class ArtifactWatcher(threading.Thread):
    """Poll mflux's output dir: new checkpoint zips → CHECKPOINT lines; new
    preview PNGs → copied into the run's samples/ (where the server's
    sample route serves from) + SAMPLE lines. The output dir is re-resolved
    each scan — it may materialize (possibly timestamp-suffixed) only after
    mflux finishes loading the model."""

    def __init__(self, configured_output: Path, samples_dir: Path, get_step):
        super().__init__(daemon=True)
        self.configured_output = configured_output
        self.samples_dir = samples_dir
        self.get_step = get_step
        self.seen = set()
        self.stop_event = threading.Event()

    def scan(self):
        output = resolve_mflux_output(self.configured_output)
        checkpoints_dir = output / "checkpoints"
        preview_dir = output / "preview"
        for f in sorted(checkpoints_dir.glob("*.zip")) if checkpoints_dir.exists() else []:
            if f in self.seen:
                continue
            self.seen.add(f)
            log(f"CHECKPOINT:{f}:{self.get_step()}")
        for f in sorted(preview_dir.glob("*.png")) if preview_dir.exists() else []:
            if f in self.seen:
                continue
            self.seen.add(f)
            dest = self.samples_dir / f.name
            try:
                shutil.copyfile(f, dest)
                log(f"SAMPLE:{dest}:{self.get_step()}")
            except OSError as err:
                log(f"STATUS:sample copy failed: {err}")

    def run(self):
        while not self.stop_event.wait(5.0):
            self.scan()
        self.scan()  # final sweep after the child exits


class TelemetrySidecar:
    """Optional GPU/thermal/power capture for crash forensics.

    macOS GPU watchdog-timeout kernel panics during sustained mflux training
    (see docs/TROUBLESHOOTING.md "GPU watchdog kernel panic" + the incident
    record under docs/research) hard-reboot the machine mid-run and leave NO
    application-level record of GPU temperature / power draw leading up to the
    hang. This streams `powermetrics` into <output_dir>/powermetrics.log so a
    post-crash investigation can tell a thermal/power fault from a driver hang.

    powermetrics requires root. We gate on a *non-interactive* `sudo -n -l`
    probe of powermetrics specifically: if passwordless sudo for that command
    isn't configured the sidecar no-ops with a single STATUS note and training
    proceeds unaffected — it never prompts or blocks.
    """

    SAMPLE_INTERVAL_MS = 5000

    def __init__(self, output_dir: Path):
        # Don't clobber a prior run's telemetry on resume — the post-crash
        # investigation reads it from this dir, and `powermetrics --output-file`
        # truncates. Roll to a timestamped name when the default already exists
        # so each launch keeps its own forensic log.
        base = output_dir / "powermetrics.log"
        if base.exists():
            base = output_dir / f"powermetrics.{datetime.now():%Y%m%d_%H%M%S}.log"
        self.log_path = base
        self.proc = None

    def start(self):
        if sys.platform != "darwin":
            return
        pm = shutil.which("powermetrics")
        if not pm:
            return
        # Probe whether *powermetrics specifically* is permitted under
        # passwordless sudo. The documented sudoers rule grants NOPASSWD for
        # powermetrics only, so a generic `sudo -n true` probe (which runs
        # /usr/bin/true) would fail for exactly the users who configured it
        # correctly. `sudo -n -l <cmd>` lists the permission without running
        # powermetrics and without prompting; non-zero means not allowed.
        # Telemetry is best-effort — a missing `sudo` must never crash training.
        try:
            probe = subprocess.run(["sudo", "-n", "-l", pm], capture_output=True)
        except OSError as err:
            log(f"STATUS:GPU telemetry unavailable ({err}); continuing without it")
            return
        if probe.returncode != 0:
            log("STATUS:GPU telemetry disabled — passwordless sudo for powermetrics not configured; "
                "see docs/TROUBLESHOOTING.md to enable thermal/power capture. Continuing without it.")
            return
        cmd = [
            "sudo", "-n", pm,
            "--samplers", "cpu_power,gpu_power,thermal",
            "-i", str(self.SAMPLE_INTERVAL_MS),
            "--output-file", str(self.log_path),
        ]
        try:
            self.proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError as err:
            log(f"STATUS:GPU telemetry unavailable ({err}); continuing without it")
            self.proc = None
            return
        # Confirm powermetrics actually stayed up — a bad sampler, an OS that
        # dropped a sampler, or a perms issue makes it exit immediately, and we
        # must not report telemetry as enabled while the log stays empty.
        try:
            rc = self.proc.wait(timeout=0.5)
            log(f"STATUS:GPU telemetry failed to start (powermetrics exited {rc}); "
                "continuing without it")
            self.proc = None
            return
        except subprocess.TimeoutExpired:
            pass  # still running after the grace window → healthy
        # Guarantee the root powermetrics child is reaped even if main() throws
        # between start() and the explicit stop() — unlike the daemon watcher
        # thread, this is a separate OS process that outlives the interpreter.
        # stop() is idempotent (poll() guard), so the later explicit call is safe.
        atexit.register(self.stop)
        log(f"STATUS:GPU telemetry → {self.log_path} (powermetrics @ {self.SAMPLE_INTERVAL_MS}ms)")

    def stop(self):
        if not self.proc or self.proc.poll() is not None:
            return
        # sudo forwards SIGTERM to powermetrics; escalate if it lingers.
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def find_adapter(checkpoints_dir: Path, output_dir: Path) -> Path | None:
    """Extract the lora adapter (`*_adapter.safetensors`, NOT the optimizer
    state) from the newest checkpoint zip."""
    zips = sorted(checkpoints_dir.glob("*.zip"), key=lambda f: f.stat().st_mtime)
    for z in reversed(zips):
        with zipfile.ZipFile(z) as zf:
            members = [m for m in zf.namelist()
                       if m.endswith("_adapter.safetensors") and "optimizer" not in m]
            if not members:
                continue
            extract_dir = output_dir / "adapter"
            extract_dir.mkdir(parents=True, exist_ok=True)
            zf.extract(members[-1], extract_dir)
            return extract_dir / members[-1]
    return None


def stream_lines(pipe):
    """Yield logical lines split on BOTH \\n and \\r — tqdm redraws its bar
    with carriage returns, so newline-only iteration would buffer the whole
    bar until completion."""
    buf = ""
    while True:
        chunk = pipe.read(256)
        if not chunk:
            if buf:
                yield buf
            return
        buf += chunk
        while True:
            cut = min((i for i in (buf.find("\n"), buf.find("\r")) if i >= 0), default=-1)
            if cut < 0:
                break
            yield buf[:cut]
            buf = buf[cut + 1:]


def compute_effective_total(config: dict, fallback: int) -> int:
    """mflux's REAL iteration total = ceil(imageCount / batch_size) * num_epochs
    — identical to Iterator.total_number_of_steps(). The wrapper's --total-steps
    is the user's *requested* count, which mflux rounds up to whole epochs and
    can exceed (e.g. 600 requested with 240 images → round(600/240)=3 epochs →
    720). Segment planning MUST use this real total, or the final segment spans
    from the last requested-total boundary all the way to the real end in one
    sustained process — exactly the unbounded GPU window this patch removes.

    Deterministic and known before launch (the config carries num_epochs +
    batch_size and the staged dataset dir). Falls back to the requested count if
    the config shape is unexpected; tqdm then corrects state["total"] live after
    the first segment anyway."""
    try:
        loop = config.get("training_loop", {}) or {}
        epochs = int(loop.get("num_epochs", 0))
        batch = int(loop.get("batch_size", 1)) or 1
        data_dir = config.get("data")
        # mflux auto-discovers NNNN.png + NNNN.txt training pairs; preview prompts
        # are .txt only, so *.png count is the image count it will encode.
        n_images = len(list(Path(data_dir).glob("*.png"))) if data_dir else 0
        if epochs > 0 and n_images > 0:
            batches_per_epoch = (n_images + batch - 1) // batch
            return batches_per_epoch * epochs
    except (ValueError, TypeError, OSError):
        pass
    return fallback


def run_segment(cmd, *, segment_target, state, last_reported, output_tail,
                fatal_holder, configured_output, cooldown,
                preview_steps=None, training_total=None):
    """Run ONE mflux invocation and stream its output.

    Returns a dict with `reason`:
      - 'segment'   — reached `segment_target`; the child was terminated after
                      the boundary checkpoint was confirmed on disk. `checkpoint`
                      holds the zip to resume the next segment from.
      - 'completed' — the child exited 0 on its own (training finished).
      - 'stopped'   — a SIGTERM cancel arrived; caller should exit 143.
      - 'error'     — the child exited non-zero; `code` carries the exit code.

    `segment_target=None` means "let mflux run to completion" (final/only
    segment) — no boundary kill is armed.
    """
    global CHILD
    CHILD = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        shell=False,
    )
    if STOP_REQUESTED:  # SIGTERM raced the spawn
        CHILD.terminate()

    in_training = False
    preview_logged = {"v": False}  # one STAGE:sampling per contiguous preview run
    for raw in stream_lines(CHILD.stdout):
        line = raw.strip()
        if not line or NOISE_RE.search(line):
            continue

        # Surface the first fatal error in a structured form the Node
        # classifier can read (once — don't spam if it repeats in a traceback).
        if not fatal_holder["v"]:
            for code, pat in FATAL_PATTERNS:
                if pat.search(line):
                    print(f"USER_ERROR:{code}:{line[:300]}", file=sys.stderr, flush=True)
                    fatal_holder["v"] = True
                    break

        step_loss_match = STEP_LOSS_RE.search(line)
        m = step_loss_match or TQDM_RE.search(line)
        if m:
            cur, total = int(m.group(1)), int(m.group(2))
            # Skip the preview/sample image generation's own tqdm bar so it isn't
            # mislabeled as a training step or allowed to trip the segment kill.
            if is_preview_progress_bar(
                line, cur, total,
                has_step_loss=step_loss_match is not None,
                preview_steps=preview_steps, training_total=training_total,
            ):
                if not in_training and not preview_logged["v"]:
                    # Pre-training step-0 preview: surface a distinct stage so the
                    # UI shows "sampling" instead of a frozen "load-model". Emit
                    # once — the bar redraws every denoise tick.
                    preview_logged["v"] = True
                    log("STAGE:sampling")
                continue
            if total > 0 and cur >= 0:
                state["step"], state["total"] = cur, total
                if m.lastindex and m.lastindex >= 3:
                    try:
                        state["loss"] = float(m.group(3))
                    except ValueError:
                        pass
                if not in_training:
                    in_training = True
                    log("STAGE:training")
                # A real training step ends a preview run; re-arm so the NEXT
                # mid-training sampling phase (step 150, 300…) logs STAGE:sampling
                # again. Re-announce STAGE:training when we come back from one.
                elif preview_logged["v"]:
                    log("STAGE:training")
                preview_logged["v"] = False
                # tqdm redraws constantly at the same step — only emit on change.
                if cur != last_reported["step"]:
                    last_reported["step"] = cur
                    log(f"STEP:{cur}:{total}:{state['loss'] if state['loss'] is not None else 'nan'}")
                # Segment boundary. Two reasons this gates on state["step"]:
                #   1. state["step"] is mflux's CUMULATIVE iteration count, not a
                #      per-process counter — tqdm renders with
                #      initial=num_iterations (restored from the checkpoint on
                #      resume) over total_number_of_steps() (the cumulative
                #      total), so the bar reads 150/600, 151/600… after a resume.
                #      Comparing it to the cumulative `segment_target` is valid on
                #      every segment, not just the first.
                #   2. Waiting until the trainer has stepped PAST the target is
                #      the flush-safety signal: mflux's save() writes the zip
                #      IN-PLACE and non-atomically (zipfile.ZipFile(zip_path,"w")
                #      straight to the final path), and the next tqdm line only
                #      appears after that synchronous save() returns. Do NOT
                #      "simplify" this to terminate the moment
                #      newest_checkpoint() >= segment_target — that would race a
                #      half-written zip and resume from a truncated checkpoint.
                if segment_target is not None and state["step"] > segment_target:
                    ck = newest_checkpoint(configured_output)
                    if ck and _checkpoint_step(ck) >= segment_target:
                        log(f"STATUS:segment checkpoint @ step {_checkpoint_step(ck)} saved — "
                            f"tearing down GPU + cooling {cooldown}s (watchdog-panic mitigation)")
                        _terminate_child()
                        return {"reason": "segment", "checkpoint": ck, "code": 0}
            continue

        # Forward everything else (truncated) — keeps the JS idle watchdog
        # fed during model download/load phases and aids debugging.
        output_tail.append(line[:300])
        log(f"STATUS:{line[:300]}")

    code = CHILD.wait()
    if STOP_REQUESTED:
        return {"reason": "stopped", "code": 143}
    if code != 0:
        return {"reason": "error", "code": code}
    return {"reason": "completed", "checkpoint": newest_checkpoint(configured_output), "code": 0}


def main():
    args = parse_args()
    # Self-document the exact numerical stack BEFORE anything can fail — the run
    # log + any watchdog paniclog then carry the mflux/mlx/mlx-metal trio inline.
    emit_runtime_fingerprint()
    # Self-document the GPU-watchdog mitigation too (mlx #3267) so a paniclog
    # shows whether the AGX timeout relaxation was active for the crashed run.
    log(f"STATUS:watchdog mitigation · AGX_RELAX_CDM_CTXSTORE_TIMEOUT={os.environ.get('AGX_RELAX_CDM_CTXSTORE_TIMEOUT', 'unset')}")
    output_dir = Path(args.output_dir)
    samples_dir = output_dir / "samples"
    samples_dir.mkdir(parents=True, exist_ok=True)
    config = json.loads(Path(args.config).read_text())
    configured_output = Path(config["checkpoint"]["output_path"])

    # mflux's real (epoch-rounded) total, not the requested --total-steps — see
    # compute_effective_total. Segment planning keys off this so the final
    # segment stays one save-interval wide even when epochs round the count up.
    total = max(1, compute_effective_total(config, args.total_steps))
    seg = max(0, args.segment_steps)
    cooldown = max(0, args.cooldown_sec)
    segmented = seg > 0

    # The preview/sample image generation prints its own tqdm bar whose total is
    # the denoise step count (`steps`), distinct from the training total. Pass
    # both to run_segment so it can tell a preview bar from a training bar. Guard
    # the rare degenerate case where steps == training total (tiny datasets):
    # then we can't disambiguate by total, so don't filter (preview_steps=None).
    preview_steps = config.get("steps")
    if not isinstance(preview_steps, int) or preview_steps <= 0 or preview_steps == total:
        preview_steps = None

    state = {"step": 0, "total": total, "loss": None}
    last_reported = {"step": -1}

    watcher = ArtifactWatcher(configured_output, samples_dir, lambda: state["step"])
    watcher.start()

    # Resolve the trainer command up front so a missing mflux exits before we
    # start telemetry (build_command exits early) — never leave an orphaned
    # root powermetrics process. One telemetry sidecar + one watcher span ALL
    # segments so the forensic log and artifact stream stay continuous.
    _ = build_command(args.config, args.resume_checkpoint)
    telemetry = TelemetrySidecar(output_dir)
    telemetry.start()

    fatal_holder = {"v": False}
    # Ring buffer of the trainer's recent non-progress output. mflux's stderr
    # is merged into its stdout (so tqdm stays in order), which means the Node
    # side tags every line `stream='stdout'` and the JS classifier's stderr
    # tail — its only window into *why* a run died — stays empty. On a non-zero
    # exit we replay this buffer to stderr so argparse errors, tracebacks, and
    # version-mismatch complaints actually reach the classifier instead of the
    # run failing with a bare "exited with code N".
    output_tail = deque(maxlen=OUTPUT_TAIL_LINES)

    resume = args.resume_checkpoint  # None on a fresh run; a zip on resume
    final_code = 0
    segment_index = 0
    if segmented:
        log(f"STATUS:segmented training enabled — {seg}-step segments, {cooldown}s GPU cooldown between each")
    while True:
        start_step = _checkpoint_step(resume) if resume else 0
        # Plan against mflux's real epoch-rounded total. `total` is the
        # config-derived estimate (compute_effective_total); state["total"] is
        # the authoritative value tqdm reports once the first segment runs — take
        # the larger so the cutoff is right BOTH before the first tqdm line (fresh
        # run / resume-near-end use the config estimate) and after (tqdm corrects
        # any discrepancy). Only when the NEXT boundary would reach/exceed this
        # real total do we drop the boundary kill and run a final, run-to-
        # completion segment; otherwise every segment — including the last —
        # stays one save-interval wide, preserving the bounded GPU window. A
        # resume past the end just reloads, hits StopIteration, returns
        # 'completed' — correct, at the cost of one model load.
        effective_total = max(total, state["total"])
        segment_target = start_step + seg if segmented else None
        if segment_target is not None and segment_target >= effective_total:
            segment_target = None

        cmd = build_command(args.config, resume)
        log("STAGE:load-model")
        log(f"STATUS:launching {Path(cmd[0]).name}"
            + (f" (segment {segment_index + 1} from step {start_step})" if segmented else ""))

        # Each segment is a fresh mflux process — fatal-error detection (and the
        # decision to replay the stderr tail) must be per-invocation, so a
        # FATAL_PATTERN line matched in an earlier segment that still exited 0
        # can't suppress the tail replay for a later segment's real failure.
        fatal_holder["v"] = False
        result = run_segment(
            cmd, segment_target=segment_target, state=state, last_reported=last_reported,
            output_tail=output_tail, fatal_holder=fatal_holder,
            configured_output=configured_output, cooldown=cooldown,
            preview_steps=preview_steps, training_total=total,
        )
        segment_index += 1

        if result["reason"] == "stopped":
            break
        if result["reason"] == "error":
            final_code = result["code"] or 1
            break
        if result["reason"] == "completed":
            break

        # reason == 'segment' — cool down, then resume from the boundary checkpoint.
        resume = str(result["checkpoint"]) if result.get("checkpoint") else resume
        new_step = _checkpoint_step(resume)
        # No `new_step >= total` early-stop: a 'segment' result means we killed
        # at a non-final boundary (segment_target < total), so the next
        # iteration's segment_target crosses `total`, becomes the final
        # run-to-completion segment, and lets mflux finish its epoch-rounded
        # steps — rather than stopping at the approximate requested total.
        # Forward-progress guard: the boundary only fires on a checkpoint whose
        # step >= segment_target > start_step, so new_step should always advance.
        # If it somehow didn't (a stalled save, checkpoint renumbering), resuming
        # would re-run the identical segment forever — fail loudly instead.
        if new_step <= start_step:
            print(f"USER_ERROR:TRAINING_FAILED:segment made no checkpoint progress "
                  f"(still at step {new_step}/{total}) — stopping to avoid a resume loop",
                  file=sys.stderr, flush=True)
            final_code = 1
            break
        log(f"STATUS:segment {segment_index} complete at step {new_step}/{total} — cooling down {cooldown}s")
        interruptible_sleep(cooldown, heartbeat_stage="cooldown")
        if STOP_REQUESTED:
            break

    watcher.stop_event.set()
    watcher.join(timeout=10)
    telemetry.stop()

    if STOP_REQUESTED:
        log("STATUS:canceled — last saved checkpoint retained")
        sys.exit(143)

    if final_code != 0:
        # Replay the trainer's tail to stderr so the Node classifier sees the
        # real error. Skip when a structured USER_ERROR already pinned the
        # cause (its message is more actionable than raw tail lines).
        if not fatal_holder["v"]:
            for tail_line in output_tail:
                print(f"mflux: {tail_line}", file=sys.stderr, flush=True)
        print(f"❌ mflux trainer exited with code {final_code}", file=sys.stderr, flush=True)
        sys.exit(final_code or 1)

    checkpoints_dir = resolve_mflux_output(configured_output) / "checkpoints"
    adapter = find_adapter(checkpoints_dir, output_dir)
    if not adapter:
        print(
            "USER_ERROR:TRAINING_FAILED:mflux finished but no *_adapter.safetensors found in "
            f"{checkpoints_dir}", file=sys.stderr, flush=True,
        )
        sys.exit(1)
    log("RESULT:" + json.dumps({
        "adapter_path": str(adapter),
        "steps": state["step"] or args.total_steps,
        "final_loss": state["loss"],
    }))


if __name__ == "__main__":
    main()
