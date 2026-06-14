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
"""

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import zipfile
from collections import deque
from pathlib import Path

CHILD = None
STOP_REQUESTED = False

# How many of the trainer's recent non-progress output lines to retain and
# replay to stderr on a non-zero exit (so the Node failure classifier sees the
# real error, not just the exit code). See the loop in main().
OUTPUT_TAIL_LINES = 40


def log(msg: str) -> None:
    print(msg, flush=True)


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
                   help="expected total iterations — used only for logging sanity")
    p.add_argument("--resume-checkpoint", default=None, help="checkpoint zip to resume from")
    return p.parse_args()


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

    powermetrics requires root. We gate on a *non-interactive* `sudo -n` probe:
    if passwordless sudo isn't configured the sidecar no-ops with a single
    STATUS note and training proceeds unaffected — it never prompts or blocks.
    """

    SAMPLE_INTERVAL_MS = 5000

    def __init__(self, output_dir: Path):
        self.log_path = output_dir / "powermetrics.log"
        self.proc = None

    def start(self):
        if sys.platform != "darwin" or not shutil.which("powermetrics"):
            return
        # `sudo -n true` returns non-zero (and prints nothing usable) when a
        # password would be required — cheaper than letting powermetrics fail.
        probe = subprocess.run(["sudo", "-n", "true"], capture_output=True)
        if probe.returncode != 0:
            log("STATUS:GPU telemetry disabled — passwordless sudo for powermetrics not configured; "
                "see docs/TROUBLESHOOTING.md to enable thermal/power capture. Continuing without it.")
            return
        cmd = [
            "sudo", "-n", "powermetrics",
            "--samplers", "gpu_power,thermal,smc",
            "-i", str(self.SAMPLE_INTERVAL_MS),
            "--output-file", str(self.log_path),
        ]
        try:
            self.proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError as err:
            log(f"STATUS:GPU telemetry unavailable ({err}); continuing without it")
            self.proc = None
            return
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


def main():
    global CHILD
    args = parse_args()
    output_dir = Path(args.output_dir)
    samples_dir = output_dir / "samples"
    samples_dir.mkdir(parents=True, exist_ok=True)
    config = json.loads(Path(args.config).read_text())
    configured_output = Path(config["checkpoint"]["output_path"])

    state = {"step": 0, "total": max(1, args.total_steps), "loss": None}
    last_reported = {"step": -1}

    watcher = ArtifactWatcher(configured_output, samples_dir, lambda: state["step"])
    watcher.start()

    cmd = build_command(args.config, args.resume_checkpoint)
    # Start telemetry only once we know the trainer command resolved (build_command
    # exits early on a missing mflux) so we never leave an orphaned root process.
    telemetry = TelemetrySidecar(output_dir)
    telemetry.start()
    log("STAGE:load-model")
    log(f"STATUS:launching {Path(cmd[0]).name}")
    CHILD = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    if STOP_REQUESTED:  # SIGTERM raced the spawn
        CHILD.terminate()

    in_training = False
    fatal_emitted = False
    # Ring buffer of the trainer's recent non-progress output. mflux's stderr
    # is merged into its stdout (so tqdm stays in order), which means the Node
    # side tags every line `stream='stdout'` and the JS classifier's stderr
    # tail — its only window into *why* a run died — stays empty. On a non-zero
    # exit we replay this buffer to stderr so argparse errors, tracebacks, and
    # version-mismatch complaints actually reach the classifier instead of the
    # run failing with a bare "exited with code N".
    output_tail = deque(maxlen=OUTPUT_TAIL_LINES)
    for raw in stream_lines(CHILD.stdout):
        line = raw.strip()
        if not line or NOISE_RE.search(line):
            continue

        # Surface the first fatal error in a structured form the Node
        # classifier can read (once — don't spam if it repeats in a traceback).
        if not fatal_emitted:
            for code, pat in FATAL_PATTERNS:
                if pat.search(line):
                    print(f"USER_ERROR:{code}:{line[:300]}", file=sys.stderr, flush=True)
                    fatal_emitted = True
                    break

        m = STEP_LOSS_RE.search(line) or TQDM_RE.search(line)
        if m:
            cur, total = int(m.group(1)), int(m.group(2))
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
                # tqdm redraws constantly at the same step — only emit on change.
                if cur != last_reported["step"]:
                    last_reported["step"] = cur
                    log(f"STEP:{cur}:{total}:{state['loss'] if state['loss'] is not None else 'nan'}")
            continue

        # Forward everything else (truncated) — keeps the JS idle watchdog
        # fed during model download/load phases and aids debugging.
        output_tail.append(line[:300])
        log(f"STATUS:{line[:300]}")

    code = CHILD.wait()
    watcher.stop_event.set()
    watcher.join(timeout=10)
    telemetry.stop()

    if STOP_REQUESTED:
        log("STATUS:canceled — last saved checkpoint retained")
        sys.exit(143)

    if code != 0:
        # Replay the trainer's tail to stderr so the Node classifier sees the
        # real error. Skip when a structured USER_ERROR already pinned the
        # cause (its message is more actionable than raw tail lines).
        if not fatal_emitted:
            for tail_line in output_tail:
                print(f"mflux: {tail_line}", file=sys.stderr, flush=True)
        print(f"❌ mflux trainer exited with code {code}", file=sys.stderr, flush=True)
        sys.exit(code or 1)

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
