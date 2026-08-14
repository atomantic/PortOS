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
MIN_FRAMES = 107  # first 17n+5 grid point at or above the upstream 4-second minimum
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
    parser.add_argument("--text-encoder-id",
                        help="id of the substituted prompt conditioner (shim directory name)")
    parser.add_argument("--text-encoder-file",
                        help="already-cached safetensors to condition with instead of the checkpoint's own")
    parser.add_argument("--text-encoder-shim-root",
                        help="directory the composed checkpoint root is built under")
    parser.add_argument("--text-encoder-key-prefix", action="append", default=[],
                        metavar="FROM=TO",
                        help="rewrite this checkpoint-key prefix before the loader matches it (repeatable)")
    parser.add_argument("--text-encoder-final-norm-key",
                        help="synthesize a ones-filled final norm under this key (for a conditioner published without one)")
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


def parse_key_prefixes(pairs: list[str]) -> list[tuple[str, str]]:
    """Parse `--text-encoder-key-prefix FROM=TO` into longest-prefix-first rules.

    Sorting by descending source length means a more specific rule can never be
    shadowed by a shorter one that also matches, so PortOS can declare the pairs
    in whatever order reads best on its side.
    """
    rules: list[tuple[str, str]] = []
    for pair in pairs:
        source, sep, target = pair.partition("=")
        if not sep or not source:
            raise SystemExit(f"--text-encoder-key-prefix must be FROM=TO; got {pair!r}.")
        rules.append((source, target))
    return sorted(rules, key=lambda rule: -len(rule[0]))


def install_key_prefix_map(rules: list[tuple[str, str]]) -> None:
    """Rewrite checkpoint-key prefixes before the pinned loader matches them.

    A conditioner repackaged for ComfyUI flattens the transformers namespace
    (`model.layers.N.…` / `visual.…`) while the port's `_wanted` matches the
    Hugging Face one (`model.language_model.layers.N.…` / `model.visual.…`).
    Wrapping that single method translates the namespace for the duration of the
    load and delegates every real decision — which layers are past the
    conditioning depth, what `lm_head` maps to — back to the pinned
    implementation, so this adapter cannot drift from the port's own contract.

    Deliberately NOT a source edit: the checkout is verified clean above, and it
    must stay that way.
    """
    from minimax_h3_mlx.text_encoder import MiniMaxH3TextEncoder

    original = getattr(MiniMaxH3TextEncoder, "_wanted", None)
    if original is None:
        raise RuntimeError(
            "The pinned MiniMax H3 runtime no longer exposes MiniMaxH3TextEncoder._wanted, "
            "so a substituted text encoder cannot be key-mapped onto it. Render with the "
            "stock text encoder, or update PortOS for the new pin."
        )

    def _wanted(self, key: str):
        for source, target in rules:
            if key.startswith(source):
                key = target + key[len(source):]
                break
        return original(self, key)

    MiniMaxH3TextEncoder._wanted = _wanted


def write_final_norm_shard(path: Path, key: str, hidden_size: int) -> None:
    """Write the one tensor a norm-less conditioner is missing.

    H3 conditions on the hidden state *before* the final norm, so a checkpoint
    published for H3 correctly omits it — but the port instantiates the whole
    module tree and refuses to load with any parameter absent. The value is
    therefore never read; ones is the identity, which keeps the file honest if a
    future revision ever does apply it.

    Written under the SUBSTITUTE's own key namespace so the prefix map above
    rewrites it exactly like every other key in the checkpoint.
    """
    import mlx.core as mx

    mx.save_safetensors(str(path), {key: mx.ones((hidden_size,), dtype=mx.bfloat16)})


def build_encoder_shim(
    checkpoint_dir: Path,
    shim_root: Path,
    encoder_id: str,
    encoder_file: Path,
    final_norm_key: str | None,
) -> Path:
    """Compose a checkpoint root whose `text_encoder/` is the substitute.

    Everything else — `model_index.json`, both VAEs, the tokenizer and the
    processor — is symlinked straight through from the upstream snapshot, so the
    pinned `from_pretrained` loads this directory with no argument it doesn't
    already take and no knowledge that anything was swapped. The substitute
    ships weights only; its tokenizer/processor/config come from upstream, which
    is correct because abliteration changes weights, not the vocabulary or the
    vision geometry.

    Rebuilt from scratch on every render: the links are free, and a stale shim
    pointing at a blob the user has since re-downloaded would otherwise load
    silently-wrong weights.
    """
    if not encoder_file.is_file():
        raise RuntimeError(f"Substituted text encoder is missing: {encoder_file}")

    root = shim_root / encoder_id
    shutil.rmtree(root, ignore_errors=True)
    (root / "text_encoder").mkdir(parents=True, exist_ok=True)

    for entry in checkpoint_dir.iterdir():
        if entry.name == "text_encoder":
            continue
        # `target_is_directory` is a no-op on POSIX but load-bearing on Windows,
        # where a directory linked as a file symlink cannot be traversed — the
        # VAEs, the tokenizer and the processor are all directories.
        (root / entry.name).symlink_to(entry, target_is_directory=entry.is_dir())

    stock_config = checkpoint_dir / "text_encoder" / "config.json"
    if not stock_config.is_file():
        raise RuntimeError(f"Upstream text-encoder config is missing: {stock_config}")
    (root / "text_encoder" / "config.json").symlink_to(stock_config)
    (root / "text_encoder" / encoder_file.name).symlink_to(encoder_file)

    if final_norm_key:
        hidden_size = json.loads(stock_config.read_text(encoding="utf-8"))["text_config"]["hidden_size"]
        # `_load_weights` globs *.safetensors in this directory, so a companion
        # shard is picked up alongside the substitute with no loader change.
        write_final_norm_shard(root / "text_encoder" / "_portos_final_norm.safetensors", final_norm_key, hidden_size)

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
        raise SystemExit(f"MiniMax H3 supports approximately 4-15 seconds ({MIN_FRAMES}-{MAX_FRAMES} aligned frames).")
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
    # The substitution is all-or-nothing: without the id there is nowhere to
    # build the shim, and without the shim root there is nowhere to put it.
    # Accepting a partial set would silently fall back to the stock conditioner
    # and hand the user a render they'd have no way to tell apart.
    encoder_flags = (args.text_encoder_id, args.text_encoder_file, args.text_encoder_shim_root)
    if any(encoder_flags) and not all(encoder_flags):
        raise SystemExit(
            "--text-encoder-id, --text-encoder-file and --text-encoder-shim-root must be given together."
        )
    if args.text_encoder_id and not re.fullmatch(r"[A-Za-z0-9._-]+", args.text_encoder_id):
        raise SystemExit(f"--text-encoder-id must be a bare directory-safe name; got {args.text_encoder_id!r}.")
    if not args.text_encoder_file and (args.text_encoder_key_prefix or args.text_encoder_final_norm_key):
        raise SystemExit("--text-encoder-key-prefix / --text-encoder-final-norm-key need --text-encoder-file.")


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

    # Substituted prompt conditioner. H3 reads the unnormalized hidden state
    # after Qwen3-VL language layer 49, so any checkpoint carrying the same
    # embedding + layers 0-49 + vision tower conditions the DiT identically in
    # shape while reading the prompt differently. The swap is expressed as a
    # composed checkpoint root plus a key-prefix rewrite, both of which leave the
    # pinned runtime source untouched.
    if args.text_encoder_file:
        # Bare phase marker plus a separate STATUS line: the SSE parser reads
        # field 2 of a STAGE frame as `step`/`heartbeat`, so the encoder id
        # cannot ride along in the marker itself.
        print("STAGE:swap-text-encoder", file=sys.stderr, flush=True)
        print(f"STATUS:Conditioning with the {args.text_encoder_id} text encoder", file=sys.stderr, flush=True)
        install_key_prefix_map(parse_key_prefixes(args.text_encoder_key_prefix))
        checkpoint_dir = build_encoder_shim(
            checkpoint_dir,
            Path(args.text_encoder_shim_root),
            args.text_encoder_id,
            Path(args.text_encoder_file),
            args.text_encoder_final_norm_key,
        )

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
