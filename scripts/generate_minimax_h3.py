#!/usr/bin/env python3
"""Cache-only PortOS runner for the pinned MiniMax H3 MLX runtime.

The Video Gen UI owns every network operation. This helper resolves only the
exact revisions already present in Hugging Face's cache, loads PipeNetwork's
pinned source checkout, emits PortOS progress/runtime frames, and writes one
joint video-and-audio MP4.

Conditioning is H3's own `fl2va` keyframe path: zero images is text-to-video,
one `--image first` is image-to-video, and a `first` + `last` pair is FFLF.
Each `--image` needs its own `--anchor`, in the same order.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _runner_common import emit_runtime_fingerprint, heartbeat, register_source_namespace  # noqa: E402


FPS = 24
MIN_FRAMES = 124  # first 17n+5 grid point at or above 5 seconds
MAX_FRAMES = 362  # first 17n+5 grid point at or above 15 seconds
FRAME_MODULUS = 17
FRAME_REMAINDER = 5
STEP_RE = re.compile(r"\bstep\s+(\d+)/(\d+)\b", re.IGNORECASE)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-dir", required=True)
    parser.add_argument("--runtime-revision", required=True)
    parser.add_argument("--model-repo", required=True)
    parser.add_argument("--model-revision", required=True)
    parser.add_argument("--checkpoint-repo", required=True)
    parser.add_argument("--checkpoint-revision", required=True)
    parser.add_argument("--checkpoint-file", action="append", default=[])
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--width", type=int, required=True)
    parser.add_argument("--height", type=int, required=True)
    parser.add_argument("--num-frames", type=int, required=True)
    parser.add_argument("--fps", type=int, default=FPS)
    parser.add_argument("--steps", type=int, default=8)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--image", action="append", default=[],
                        help="keyframe conditioning image (repeatable, max 2)")
    parser.add_argument("--anchor", action="append", default=[], choices=["first", "last"],
                        help="latent anchor for each --image, in the same order")
    parser.add_argument("--lora", action="append", default=[],
                        help="user LoRA safetensors applied at runtime (repeatable)")
    parser.add_argument("--lora-scale", action="append", type=float, default=[],
                        help="strength for each --lora, in the same order")
    parser.add_argument("--output", required=True)
    return parser.parse_args()


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


def resolve_transformer_snapshot(repo: str, revision: str) -> Path:
    """Resolve the quantized transformer and every shard named by its index."""
    root = resolve_cached_snapshot(
        repo,
        revision,
        ["config.json", "quant_config.json", "model.safetensors.index.json"],
    )
    index_path = root / "model.safetensors.index.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    shards = sorted(set(index.get("weight_map", {}).values()))
    if not shards:
        raise RuntimeError(f"Transformer index has no weight shards: {repo}@{revision[:12]}.")
    shard_root = resolve_cached_snapshot(repo, revision, shards)
    if shard_root != root:
        raise RuntimeError(f"Transformer files for {repo}@{revision[:12]} span multiple snapshots; repair the model in Video Gen.")
    return root


def require_ffmpeg() -> str:
    """Fail before loading ~83 GB of weights when muxing cannot succeed."""
    path = shutil.which("ffmpeg")
    if path is None:
        raise RuntimeError("ffmpeg is required to mux MiniMax H3 video and audio; install it before generating.")
    return path


def verify_runtime_checkout(runtime_dir: Path, expected_revision: str) -> None:
    """Require the exact commit and a clean executable source package."""
    try:
        result = subprocess.run(
            [
                "git", "-C", str(runtime_dir), "status", "--porcelain=v2",
                "--branch", "--untracked-files=all", "--", "minimax_h3_mlx",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError("Could not verify the pinned MiniMax H3 runtime checkout; use Repair in Video Gen.") from exc
    lines = [line for line in result.stdout.splitlines() if line]
    oid = next((line.removeprefix("# branch.oid ") for line in lines if line.startswith("# branch.oid ")), None)
    dirty = [line for line in lines if not line.startswith("# ")]
    if oid != expected_revision or dirty:
        raise RuntimeError("MiniMax H3 runtime source differs from the pinned checkout; use Repair in Video Gen.")


def emit_result(output: Path) -> None:
    """Emit the completion contract that arms PortOS's teardown watchdog."""
    print(json.dumps({"video_path": str(output)}), flush=True)


class ProgressWriter:
    """Translate the port's human step lines into PortOS STAGE progress."""

    def __init__(self) -> None:
        self._carry = ""

    def write(self, text: str) -> int:
        self._carry += text
        while "\n" in self._carry:
            line, self._carry = self._carry.split("\n", 1)
            self._emit(line)
        return len(text)

    def flush(self) -> None:
        if self._carry:
            self._emit(self._carry)
            self._carry = ""

    @staticmethod
    def _emit(line: str) -> None:
        clean = line.strip()
        if not clean:
            return
        match = STEP_RE.search(clean)
        if match:
            step, total = match.groups()
            print(
                f"STAGE:minimax-h3:step:{step}:{total}:MiniMax H3 step {step}/{total}",
                file=sys.stderr,
                flush=True,
            )
            return
        print(clean, file=sys.stderr, flush=True)


def validate_args(args: argparse.Namespace) -> None:
    if args.fps != FPS:
        raise SystemExit(f"MiniMax H3 runs at a fixed {FPS} fps; got {args.fps}.")
    if args.width <= 0 or args.height <= 0 or args.width % 32 or args.height % 32:
        raise SystemExit(f"MiniMax H3 dimensions must be positive multiples of 32; got {args.width}x{args.height}.")
    if not MIN_FRAMES <= args.num_frames <= MAX_FRAMES:
        raise SystemExit(f"MiniMax H3 supports approximately 5-15 seconds ({MIN_FRAMES}-{MAX_FRAMES} aligned frames).")
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
    if len(args.lora_scale) != len(args.lora):
        raise SystemExit(
            f"MiniMax H3 needs one --lora-scale per --lora; got {len(args.lora)} LoRAs "
            f"and {len(args.lora_scale)} scales."
        )
    for path in args.lora:
        if not Path(path).is_file():
            raise SystemExit(f"LoRA file is missing: {path}")


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
        # nothing — then hold it across the 83 GB load below.
        ImageOps.exif_transpose(image, in_place=True)
        images.append(image)
    return images


def main() -> int:
    args = parse_args()
    validate_args(args)
    # Read the keyframes first: everything below is a git probe, ~35 HF cache
    # lookups and an mlx/transformers import, so an unreadable conditioning
    # image should not cost seconds before it reports.
    images = load_keyframes(args.image)

    # PortOS cancels this helper by process group; ffmpeg inherits the group and
    # cannot remain behind muxing after the user presses Cancel. Establish the
    # group before the git pin probe, which is the first child process.
    if hasattr(os, "setpgid"):
        try:
            os.setpgid(0, 0)
        except OSError:
            pass

    require_ffmpeg()

    runtime_dir = Path(args.runtime_dir).resolve()
    verify_runtime_checkout(runtime_dir, args.runtime_revision)

    emit_runtime_fingerprint(
        "minimax_h3",
        ["mlx", "mlx-metal", "mlx-vlm", "transformers", "huggingface-hub"],
    )

    print("STAGE:resolve-cache", file=sys.stderr, flush=True)
    checkpoint_snapshot = resolve_cached_snapshot(
        args.checkpoint_repo,
        args.checkpoint_revision,
        args.checkpoint_file,
    )
    checkpoint_dir = checkpoint_snapshot / "FL2VA"
    transformer_dir = resolve_transformer_snapshot(args.model_repo, args.model_revision)

    package_dir = runtime_dir / "minimax_h3_mlx"
    if not (package_dir / "pipeline.py").is_file():
        raise RuntimeError(f"MiniMax H3 runtime source is missing under {runtime_dir}.")
    register_source_namespace("minimax_h3_mlx", package_dir)

    from minimax_h3_mlx.media import save_mp4
    from minimax_h3_mlx.pipeline import MiniMaxH3Pipeline

    print("STAGE:load-pipeline", file=sys.stderr, flush=True)
    with heartbeat("minimax-h3-load"):
        pipe = MiniMaxH3Pipeline.from_pretrained(
            checkpoint_dir,
            transformer_dir=transformer_dir,
            # The Qwen3-VL vision tower is only loaded when a keyframe needs
            # encoding — a text-only run keeps skipping it.
            load_vision=bool(images),
        )

    # Runtime LoRA application — never a fuse. The DiT is quantized, so the
    # applicator has to take each layer's logical dims from the quantization
    # metadata (packed-uint32 storage shapes match no LoRA) and add the deltas
    # during the forward pass. PortOS only ever passes --lora when its capability
    # probe has already confirmed this module exists, so an ImportError here is a
    # real contract violation and should surface, not be swallowed.
    if args.lora:
        print("STAGE:apply-loras", file=sys.stderr, flush=True)
        from minimax_h3_mlx.lora import apply_loras

        apply_loras(
            pipe.transformer,
            [{"path": p, "scale": s} for p, s in zip(args.lora, args.lora_scale)],
        )

    print("STAGE:inference", file=sys.stderr, flush=True)
    progress = ProgressWriter()
    with heartbeat("minimax-h3-inference"), redirect_stdout(progress):
        result = pipe(
            args.prompt,
            duration_seconds=args.num_frames / FPS,
            num_inference_steps=args.steps,
            seed=args.seed,
            images=images or None,
            keyframe_anchors=tuple(args.anchor),
            height=args.height,
            width=args.width,
            drop_adaln=True,
        )
    progress.flush()

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    wav_path = output.with_suffix(".wav")
    print("STAGE:mux", file=sys.stderr, flush=True)
    try:
        save_mp4(output, result.video, result.fps, result.audio, result.sample_rate)
    finally:
        wav_path.unlink(missing_ok=True)

    if not output.is_file() or output.stat().st_size == 0:
        raise RuntimeError(f"MiniMax H3 completed but did not write {output}.")
    print(
        f"STATUS:MiniMax H3 saved {output.name} ({result.video.shape[0]} frames with stereo audio)",
        file=sys.stderr,
        flush=True,
    )
    emit_result(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
