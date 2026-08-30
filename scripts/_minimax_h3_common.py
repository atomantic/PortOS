"""Shared helpers for the two PortOS MiniMax H3 runners.

`generate_minimax_h3.py` drives PipeNetwork's Apple-Silicon MLX port and
`generate_minimax_h3_cuda.py` drives diffusers' `MiniMaxH3ModularPipeline` on
NVIDIA. They run in *different venvs* and load different pipelines, but they
present the same CLI to PortOS and enforce the same model facts — so everything
that is a property of the H3 checkpoint rather than of the runtime in front of
it belongs here, stated once.

Cross-venv sharing works the same way `_runner_common.py` already does: this
module is stdlib-only at import time (`huggingface_hub` and `PIL` are imported
inside the function that needs them), and both runners reach it through the
same-directory `sys.path.insert` idiom. Neither venv is forced to grow a
dependency it didn't already pin.

What must NOT move here: anything true of only one runner. The MLX port's
`resolve_transformer_snapshot` (its quantized DiT ships a separate
`quant_config.json`), its LoRA argument pairing, its `require_ffmpeg` preflight
(it shells out to the binary to mux, where the CUDA runner muxes in-process via
PyAV), and the CUDA path's `--repo-file` requirement and offload profiles all
stay in their own runner.
The frame WINDOW is the subtle one — it differs between the two (diffusers
requires the snapped duration in 5-15s where the MLX port accepts 4-15s), so
`validate_h3_output_args` takes it as a parameter rather than asserting one.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# H3 renders at a fixed 24 fps, and its video VAE can only decode a frame count
# on the 17n+5 grid. Both are checkpoint facts, identical on every runtime.
FPS = 24
FRAME_MODULUS = 17
FRAME_REMAINDER = 5


def add_h3_common_args(
    parser: argparse.ArgumentParser,
    *,
    steps_default: int = 8,
) -> argparse.ArgumentParser:
    """Declare the CLI surface both runners present to PortOS.

    `validate_h3_output_args` below reads exactly these fields off the parsed
    Namespace, so the schema and its validator have to agree — declaring them
    apart is how one runner's `--steps` surface drifts from the other's with
    nothing failing until a render. Each runner adds its own flags on top
    (`--checkpoint-*` and the LoRA / text-encoder pairs for MLX, `--repo-file`
    and `--offload-profile` for CUDA). The runners pass their own sampler
    default because the MLX port's sigma-grid argument is one larger than its
    desired transformer-forward count, while diffusers counts forwards.
    """
    parser.add_argument("--model-repo", required=True)
    parser.add_argument("--model-revision", required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--width", type=int, required=True)
    parser.add_argument("--height", type=int, required=True)
    parser.add_argument("--num-frames", type=int, required=True)
    parser.add_argument("--fps", type=int, default=FPS)
    parser.add_argument("--steps", type=int, default=steps_default)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--image", action="append", default=[],
                        help="keyframe conditioning image (repeatable, max 2)")
    parser.add_argument("--anchor", action="append", default=[], choices=["first", "last"],
                        help="latent anchor for each --image, in the same order")
    parser.add_argument("--output", required=True)
    parser.add_argument("--memory-profile", default=None,
                        help="id of the weight-placement profile PortOS selected (reported back, not re-derived)")
    parser.add_argument("--min-system-memory-gb", type=float, default=None,
                        help="TOTAL host RAM below which NO declared placement profile can run")
    parser.add_argument("--memory-headroom-gb", type=float, default=0.0,
                        help="host RAM held back from the model's ALLOCATOR for the OS and PortOS itself; "
                             "never netted off before the --min-system-memory-gb comparison")
    return parser


def total_system_memory_gb() -> float | None:
    """Total physical RAM in GB, or None when it could not be measured.

    None is the "not measured" sentinel and is deliberately distinct from a
    small measured number: a probe that fails on an unusual host must not read
    as a box with no memory and refuse a render that would have worked.
    """
    page_size = None
    page_count = None
    if hasattr(os, "sysconf"):
        names = getattr(os, "sysconf_names", {})
        if "SC_PAGE_SIZE" in names and "SC_PHYS_PAGES" in names:
            try:
                page_size = os.sysconf("SC_PAGE_SIZE")
                page_count = os.sysconf("SC_PHYS_PAGES")
            except (OSError, ValueError):
                page_size = page_count = None
    if page_size and page_count and page_size > 0 and page_count > 0:
        return page_size * page_count / 1e9
    if sys.platform == "win32":
        # GlobalMemoryStatusEx is the only stdlib-reachable total on Windows —
        # os.sysconf does not exist there, and the CUDA runner is the lane that
        # actually runs on it.
        import ctypes

        class _MemoryStatusEx(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        status = _MemoryStatusEx()
        status.dwLength = ctypes.sizeof(_MemoryStatusEx)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return status.ullTotalPhys / 1e9
    return None


def enforce_system_memory(args) -> float | None:
    """Refuse a render this machine cannot hold, and return the measured RAM.

    H3's components fit nowhere unassisted, so loading them takes minutes to
    hours before an out-of-memory kill would land — long after the job has taken
    the queue. PortOS gates this at submit time too; this is the runner-side
    half, which catches a render that reached the helper by any other route
    (a persisted-queue replay, a retry, a peer submission, a direct call).

    Compared against TOTAL memory, deliberately: the floor PortOS passes was
    hoisted from the registry entry's `memoryGb`, which has always been a claim
    about the whole machine. `--memory-headroom-gb` caps the ALLOCATOR further
    down; netting it off here as well would move the 128 GB model onto a 144 GB
    box and refuse every machine the entry was written for.

    Fails closed only on a MEASURED shortfall: an unmeasurable host returns None
    and the render proceeds, because "the probe returned nothing" is not the
    same fact as "this box has no memory". Returning the measured total means a
    caller that also needs it does not probe the machine twice.
    """
    total_gb = total_system_memory_gb()
    if total_gb is None:
        return None
    minimum = args.min_system_memory_gb
    if minimum is not None and total_gb < minimum:
        raise SystemExit(
            f"MiniMax H3 needs at least {minimum:.0f} GB of memory for its smallest weight-placement "
            f"profile; this machine has {total_gb:.0f} GB."
        )
    return total_gb


def snapshot_root(resolved_file: str | Path, repo_filename: str) -> Path:
    """Return the HF snapshot directory containing one resolved repo file."""
    levels = len(Path(repo_filename).parts)
    # Hugging Face snapshot entries are normally symlinks into `blobs/`.
    # Resolving the symlink would therefore walk OUT of the snapshot and hand
    # the pipeline a blob directory. `hf_hub_download` already returns an
    # absolute snapshot path, so preserve that lexical path deliberately.
    return Path(resolved_file).absolute().parents[levels - 1]


def resolve_cached_snapshot(repo: str, revision: str, required_files: list[str]) -> Path:
    """Resolve exact cached files without ever permitting a network fallback."""
    if not required_files:
        raise RuntimeError(f"No required files declared for {repo}.")

    from huggingface_hub import hf_hub_download

    resolved: list[tuple[str, Path]] = []
    for filename in required_files:
        try:
            path = hf_hub_download(
                repo_id=repo,
                filename=filename,
                revision=revision,
                local_files_only=True,
            )
        except Exception as exc:
            raise RuntimeError(
                f"Required cached weight is missing: {repo}@{revision[:12]}/{filename}. "
                "Use Download in Video Gen before generating."
            ) from exc
        resolved.append((filename, Path(path)))

    roots = {snapshot_root(path, filename) for filename, path in resolved}
    if len(roots) != 1:
        raise RuntimeError(f"Cached files for {repo}@{revision[:12]} span multiple snapshots; repair the model in Video Gen.")
    return roots.pop()


def emit_result(output: Path) -> None:
    """Emit the completion contract that arms PortOS's teardown watchdog."""
    print(json.dumps({"video_path": str(output)}), flush=True)


def validate_h3_output_args(
    args,
    *,
    min_frames: int,
    max_frames: int,
    frame_window_message: str,
) -> None:
    """Check every output constraint the H3 checkpoint imposes on both runners.

    `frame_window_message` is the one genuinely runtime-specific part: the two
    pipelines accept different duration windows on the same 17n+5 grid, so each
    runner supplies its own bounds and the sentence that explains them.

    Raises SystemExit so a bad request reports as a clean one-line runner error
    rather than a traceback (both runners' main() are invoked via SystemExit).
    """
    if args.fps != FPS:
        raise SystemExit(f"MiniMax H3 runs at a fixed {FPS} fps; got {args.fps}.")
    if args.width <= 0 or args.height <= 0 or args.width % 32 or args.height % 32:
        raise SystemExit(f"MiniMax H3 dimensions must be positive multiples of 32; got {args.width}x{args.height}.")
    if not min_frames <= args.num_frames <= max_frames:
        raise SystemExit(frame_window_message)
    if args.num_frames % FRAME_MODULUS != FRAME_REMAINDER:
        raise SystemExit(f"MiniMax H3 frame count must be 17n+5; got {args.num_frames}.")
    if args.steps < 2:
        raise SystemExit("MiniMax H3 needs at least 2 sigma grid points.")
    if len(args.anchor) != len(args.image):
        raise SystemExit(
            f"MiniMax H3 needs one --anchor per --image; got {len(args.image)} images and {len(args.anchor)} anchors."
        )
    # H3's fl2va conditioning defines exactly two latent anchors, so a repeated
    # anchor would silently overwrite one keyframe's position with another's.
    if len(set(args.anchor)) != len(args.anchor):
        raise SystemExit(f"MiniMax H3 anchors must be distinct; got {args.anchor}.")


def load_keyframes(paths: list[str]) -> list:
    """Open each conditioning image upright, in RGB, in the order given."""
    # Every path is checked before anything is opened, so a bad second keyframe
    # doesn't cost a decode of the first — and the message names the PortOS-side
    # cause rather than surfacing Pillow's bare FileNotFoundError.
    for path in paths:
        if not Path(path).is_file():
            raise RuntimeError(f"Conditioning image is missing: {path}")
    # Imported only once there is something to decode: a text-only run never
    # pulls Pillow in, and the missing-file path above stays dependency-free.
    if not paths:
        return []
    from PIL import Image, ImageOps

    images = []
    for path in paths:
        with Image.open(path) as handle:
            image = handle.convert("RGB")
        # In place: PortOS hands us ffmpeg-normalized PNGs with no orientation
        # tag, and the copying form would duplicate every pixel buffer for
        # nothing — then hold it across the multi-GB load that follows.
        ImageOps.exif_transpose(image, in_place=True)
        images.append(image)
    return images


__all__ = [
    "FPS",
    "add_h3_common_args",
    "emit_result",
    "enforce_system_memory",
    "total_system_memory_gb",
    "load_keyframes",
    "resolve_cached_snapshot",
    "validate_h3_output_args",
]
