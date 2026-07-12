#!/usr/bin/env python3
"""
PortOS MuScriptor runner — local audio → MIDI transcription.
Spawned by `server/services/audioMidiTranscription.js` for the Rounds
reference-audio workbench and the Music Video parsing system.

MuScriptor (https://github.com/muscriptor/muscriptor) is a multi-instrument
music-transcription model (small/medium/large variants, weights auto-download
from HuggingFace on first use). It installs as the `muscriptor` pip package
into an opt-in venv: `INSTALL_MUSCRIPTOR=1 bash scripts/setup-image-video.sh`
(see server/lib/pythonSetup.js resolveMuscriptorPython).

CLI contract (mirrors the generate_* audio sidecars):
  --audio <path>     input audio (wav/mp3/flac/ogg/m4a — soundfile-supported)
  --output <path>    output .mid path
  --model <size>     small | medium | large (default medium)
  [--runtime-dir <dir>]  optional sys.path prepend for a vendored checkout

Progress protocol (mirrors the image/video/musicgen sidecars): STAGE:<name>
[:detail] lines on stderr drive the JS-side progress display; a final
`RESULT:<json>` line on stdout reports the written path + byte count.
"""

import argparse
import json
import os
import sys
from pathlib import Path

# Share the canonical HuggingFace error → USER_ERROR: translation with the
# image/video runners. MuScriptor's weights live in a *gated* HF repo, so a
# first download without an accepted license raises GatedRepoError; the
# decorator walks the cause chain and emits a structured
# `USER_ERROR:gated_repo:<repo>` line (which the server classifies deep-linkably)
# instead of a raw traceback the JS side has to prose-match. `_runner_common`
# imports only stdlib at module load (torch/huggingface_hub are lazy), so this
# is safe from the muscriptor venv.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _runner_common import install_hf_error_handler  # noqa: E402


def log_stage(name, detail=""):
    """Emit a STAGE: line the JS sidecar tails for phase/progress display."""
    line = f"STAGE:{name}" + (f":{detail}" if detail else "")
    print(line, file=sys.stderr, flush=True)


def _import_model_class(runtime_dir):
    """Resolve muscriptor's TranscriptionModel class.

    MuScriptor ships as a pip package, so we normally import it straight from
    the venv. `runtime_dir` is honored for parity with the other audio
    sidecars — a vendored checkout can be prepended to sys.path. Raising a
    clear ImportError lets the JS side surface "run the installer" rather than
    a bare traceback.
    """
    if runtime_dir and os.path.isdir(runtime_dir) and runtime_dir not in sys.path:
        sys.path.insert(0, runtime_dir)
    try:
        from muscriptor import TranscriptionModel  # type: ignore
        return TranscriptionModel
    except ImportError as exc:
        raise ImportError(
            "Could not import muscriptor. Run "
            "`INSTALL_MUSCRIPTOR=1 bash scripts/setup-image-video.sh` to build "
            f"the venv (looked in: {runtime_dir or 'venv site-packages'})."
        ) from exc


def _load_model(TranscriptionModel, size):
    """Load the requested model size, tolerating signature drift.

    The documented API is `TranscriptionModel.load_model()` accepting a size
    keyword ("small" | "medium" | "large", default "medium"). If a future
    release changes the positional signature, fall back to the library default
    rather than failing the whole transcription.
    """
    try:
        return TranscriptionModel.load_model(size)
    except TypeError:
        log_stage("load-model", "size arg rejected — falling back to default model")
        return TranscriptionModel.load_model()


def _weights_cached(size):
    """True when this size's weights are already in the HuggingFace hub cache.

    `TranscriptionModel.load_model()` auto-downloads the weights from the gated
    `MuScriptor/muscriptor-<size>` repo on first use, then loads a cached copy on
    every run after — but from the caller's side both look like the same opaque
    `load-model` stage that can sit for minutes on the first (download) call. We
    peek at the hub cache first so the JS side can show a distinct, honest
    "Downloading model weights…" phase (with a toast) only when a download is
    actually about to happen, instead of an unexplained multi-minute spinner.

    A repo counts as cached only when its `snapshots/` tree holds at least one
    non-empty file — HF materializes snapshot symlinks only after a blob finishes
    downloading, so a half-finished download (blob still `.incomplete`) correctly
    reads as not-cached. Heuristic and best-effort: the worst case of a wrong
    guess is a mislabeled stage, never a failed transcription. If the muscriptor
    repo id ever diverges from the assumed `MuScriptor/muscriptor-<size>`, this
    quietly returns False and we fall back to the generic load-model label.
    """
    hub_cache = (
        os.environ.get("HF_HUB_CACHE")
        or (os.path.join(os.environ["HF_HOME"], "hub") if os.environ.get("HF_HOME") else None)
        or os.path.expanduser("~/.cache/huggingface/hub")
    )
    snapshots = os.path.join(hub_cache, f"models--MuScriptor--muscriptor-{size}", "snapshots")
    if not os.path.isdir(snapshots):
        return False
    for root, _dirs, files in os.walk(snapshots):
        for name in files:
            try:
                # getsize follows the snapshot symlink to the real blob.
                if os.path.getsize(os.path.join(root, name)) > 0:
                    return True
            except OSError:
                continue
    return False


@install_hf_error_handler
def main():
    parser = argparse.ArgumentParser(description="PortOS MuScriptor runner (audio → MIDI)")
    parser.add_argument("--audio", required=True, help="Input audio path")
    parser.add_argument("--output", required=True, help="Output .mid path")
    parser.add_argument("--model", default="medium",
                        choices=["small", "medium", "large"],
                        help="MuScriptor model size (weights auto-download on first use)")
    parser.add_argument("--runtime-dir", default=os.environ.get("PORTOS_MUSCRIPTOR_RUNTIME_DIR", ""),
                        help="Optional dir prepended to sys.path before importing muscriptor")
    args = parser.parse_args()

    if not os.path.isfile(args.audio):
        print(f"ERROR: audio file not found: {args.audio}", file=sys.stderr, flush=True)
        return 2

    log_stage("import-runtime")
    TranscriptionModel = _import_model_class(args.runtime_dir)

    # First use downloads the weights (minutes); every run after loads the
    # cached copy (seconds). Emit a distinct `download-model` stage for the
    # former so the UI can say "Downloading…" + toast, rather than an opaque
    # multi-minute "Loading model…".
    log_stage("download-model" if not _weights_cached(args.model) else "load-model", args.model)
    model = _load_model(TranscriptionModel, args.model)

    log_stage("transcribe", os.path.basename(args.audio))
    midi_bytes = model.transcribe_to_midi(args.audio)
    if not midi_bytes:
        print("ERROR: muscriptor returned no MIDI data", file=sys.stderr, flush=True)
        return 1

    log_stage("write-midi")
    out_dir = os.path.dirname(os.path.abspath(args.output))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(args.output, "wb") as fh:
        fh.write(midi_bytes)

    result = {
        "output": args.output,
        "model": args.model,
        "bytes": len(midi_bytes),
    }
    print("RESULT:" + json.dumps(result), flush=True)
    log_stage("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
