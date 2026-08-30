#!/usr/bin/env python3
"""Cache-only PortOS runner for the pinned MiniMax H3 MLX runtime.

The Video Gen UI owns every network operation. This helper resolves only the
exact revisions already present in Hugging Face's cache, loads PipeNetwork's
pinned source checkout, emits PortOS progress/runtime frames, and writes one
joint video-and-audio MP4.

Conditioning is H3's own `fl2va` keyframe path: zero images is text-to-video,
one `--image first` is image-to-video, and a `first` + `last` pair is FFLF.
Each `--image` needs its own `--anchor`, in the same order.

Memory: unified memory means this render and the rest of the machine draw on one
pool. PortOS passes the host floor its declared placement profile needs
(`--min-system-memory-gb`) and the reserve it holds back for the operating
system (`--memory-headroom-gb`); `enforce_system_memory` refuses a box below the
floor before any weight is read, and `apply_memory_limit` caps MLX's allocator
at the rest so a render that overruns fails as a job instead of wedging the
machine.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import shutil
import subprocess
import sys
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _runner_common import (  # noqa: E402
    emit_runtime_fingerprint, establish_process_group, heartbeat, register_source_namespace,
    write_stepwise_preview,
)
from _minimax_h3_common import (  # noqa: E402
    FPS, add_h3_common_args, emit_result, enforce_system_memory, load_keyframes,
    resolve_cached_snapshot, total_system_memory_gb, validate_h3_output_args,
)
from _minimax_h3_mlx_pins import (  # noqa: E402
    pinned_encoder_hook, verify_pinned_encode_source,
)


# The MLX port accepts H3's full documented 4-15s range. The diffusers CUDA
# runner is narrower (5-15s) — see generate_minimax_h3_cuda.py — which is why
# the window is per-runner while FPS and the 17n+5 grid are shared.
MIN_FRAMES = 107  # first 17n+5 grid point at or above the upstream 4-second minimum
MAX_FRAMES = 362  # first 17n+5 grid point at or above 15 seconds
STEP_RE = re.compile(r"\bstep\s+(\d+)/(\d+)\b", re.IGNORECASE)


def parse_args() -> argparse.Namespace:
    parser = add_h3_common_args(argparse.ArgumentParser(description=__doc__), steps_default=9)
    parser.add_argument("--runtime-dir", required=True)
    parser.add_argument("--runtime-revision", required=True)
    parser.add_argument("--checkpoint-repo", required=True)
    parser.add_argument("--checkpoint-revision", required=True)
    parser.add_argument("--checkpoint-file", action="append", default=[])
    parser.add_argument("--preview-dir", default=None,
                        help="Job-scoped directory where the latest decoded denoise frame is published")
    parser.add_argument("--lora", action="append", default=[],
                        help="user LoRA safetensors applied at runtime (repeatable)")
    parser.add_argument("--lora-scale", action="append", type=float, default=[],
                        help="strength for each --lora, in the same order")
    parser.add_argument("--text-encoder-id",
                        help="id of the substituted prompt conditioner (shim directory name)")
    parser.add_argument("--text-encoder-file", action="append", default=[],
                        help="already-cached safetensors to condition with instead of the checkpoint's own "
                             "(repeatable — one per shard of a multi-shard conditioner)")
    parser.add_argument("--text-encoder-shim-root",
                        help="directory the composed checkpoint root is built under")
    parser.add_argument("--text-encoder-key-prefix", action="append", default=[],
                        metavar="FROM=TO",
                        help="rewrite this checkpoint-key prefix before the loader matches it (repeatable)")
    parser.add_argument("--text-encoder-final-norm-key",
                        help="synthesize a ones-filled final norm under this key (for a conditioner published without one)")
    return parser.parse_args()


def apply_memory_limit(args: argparse.Namespace, vision_loaded: bool) -> None:
    """Cap MLX's allocator at the machine's RAM minus PortOS's reserve.

    Unified memory means an H3 render and the rest of the machine draw on the
    same pool, and MLX's default limit is the whole of it. A render that grows
    into the last gigabyte does not fail on its own — it takes PortOS, Postgres
    and the desktop down with it, and what the user sees is a hung machine
    rather than a failed job. An explicit limit converts that into an
    out-of-memory error the runner reports normally.

    Best-effort by design: the limit setters have moved between `mx` and
    `mx.metal` across MLX releases and the wired limit is Metal-only, so each is
    probed rather than assumed. A pin without them still renders — it just keeps
    the old unbounded behaviour, which is what it had before this existed.
    """
    total_gb = total_system_memory_gb()
    headroom_gb = max(0.0, args.memory_headroom_gb or 0.0)
    if total_gb is None:
        print(
            f"STATUS:MiniMax H3 placement: {args.memory_profile or 'unified'} "
            f"· host memory unknown, allocator left unbounded "
            f"· vision tower {'loaded' if vision_loaded else 'skipped'}",
            file=sys.stderr, flush=True,
        )
        return
    limit_gb = max(1.0, total_gb - headroom_gb)
    limit_bytes = int(limit_gb * 1e9)

    import mlx.core as mx

    applied = []
    for module, name in ((mx, "set_memory_limit"), (getattr(mx, "metal", None), "set_memory_limit")):
        setter = getattr(module, name, None)
        if setter is not None:
            setter(limit_bytes)
            applied.append("allocator")
            break
    for module, name in ((mx, "set_wired_limit"), (getattr(mx, "metal", None), "set_wired_limit")):
        setter = getattr(module, name, None)
        if setter is not None:
            setter(limit_bytes)
            applied.append("wired")
            break
    placement = ", ".join(applied) if applied else "no limit lever on this MLX build"
    print(
        f"STATUS:MiniMax H3 placement: {args.memory_profile or 'unified'} "
        f"· {limit_gb:.0f} GB of {total_gb:.0f} GB (reserve {headroom_gb:.0f} GB) [{placement}] "
        f"· vision tower {'loaded' if vision_loaded else 'skipped'}",
        file=sys.stderr, flush=True,
    )


def require_ffmpeg() -> str:
    """Fail before loading tens of GB of weights when muxing cannot succeed.

    Only this runner needs it: it shells out to the ffmpeg binary to mux the
    joint video+audio output, where the CUDA sibling muxes in-process through
    diffusers' PyAV-backed encode_video().
    """
    path = shutil.which("ffmpeg")
    if path is None:
        raise RuntimeError("ffmpeg is required to mux MiniMax H3 video and audio; install it before generating.")
    return path


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
    encoder, original = pinned_encoder_hook("_wanted")

    def _wanted(self, key: str):
        for source, target in rules:
            if key.startswith(source):
                key = target + key[len(source):]
                break
        return original(self, key)

    encoder._wanted = _wanted


def torch_image_stack_available() -> bool:
    """Whether the pinned runtime's own `AutoProcessor` path can load at all.

    False for every stock install: `requirements-minimax-h3-mlx.lock.txt` ships
    neither package, and `uv pip sync` removes anything added on top of it. See
    `install_pil_image_processor` for what that costs and how it is covered.
    """
    return all(importlib.util.find_spec(module) is not None for module in ("torch", "torchvision"))


def load_pil_image_processor(processor_dir: Path):
    """Load the PIL-backed sibling of the image processor the checkpoint declares.

    transformers keeps a `…Pil` twin of each torchvision image processor for
    exactly the environment this runner lives in. The checkpoint names its class
    in `preprocessor_config.json` — `Qwen2VLImageProcessorFast` for H3 — and the
    `Fast` suffix is transformers-5-deprecated on the base name, so the twin is
    derived off the stripped name rather than hardcoded to one checkpoint.
    """
    config_path = processor_dir / "preprocessor_config.json"
    if not config_path.is_file():
        raise RuntimeError(f"Checkpoint processor config is missing: {config_path}")
    declared = json.loads(config_path.read_text(encoding="utf-8")).get("image_processor_type")
    if not declared:
        raise RuntimeError(f"{config_path} names no image_processor_type, so a keyframe cannot be encoded.")

    import transformers

    name = declared.removesuffix("Fast") + "Pil"
    processor_class = getattr(transformers, name, None)
    if processor_class is None:
        raise RuntimeError(
            f"transformers {transformers.__version__} exposes no {name}, the PIL-backed twin of the "
            f"checkpoint's {declared}, so a keyframe cannot be encoded without PyTorch. Render "
            "text-only, or update PortOS for a transformers version that still ships one."
        )
    return processor_class.from_pretrained(str(processor_dir))


def install_pil_image_processor() -> None:
    """Let an image-conditioned render work in a runtime with no PyTorch.

    The pinned port reads its vision inputs from
    `AutoProcessor.from_pretrained(<checkpoint>/processor).image_processor`, and
    transformers 5's auto path builds the WHOLE Qwen3-VL processor — video
    processor included — before handing back the one sub-processor the encoder
    uses. That video processor is torchvision-backed, so with the MLX lock's
    torch-free venv every keyframed render died in `from_pretrained` with
    "Qwen3VLVideoProcessor requires the Torchvision library"; text-only renders
    never touch the property and kept working, which is why image-to-video was
    the only broken mode.

    Binding the PIL twin to the single attribute the encoder reads loads nothing
    it doesn't use and — deliberately, like the key-prefix map above — leaves the
    pinned checkout untouched, because it is verified clean before this runs.
    """
    encoder, _ = pinned_encoder_hook("processor")

    def processor(self):
        if self._processor is None:
            # Resolved from the encoder's own model dir rather than a captured
            # path, so a composed text-encoder shim root keeps pointing at the
            # processor it linked through.
            self._processor = SimpleNamespace(
                image_processor=load_pil_image_processor(self._model_dir.parent / "processor"),
            )
        return self._processor

    encoder.processor = property(processor)


def install_vision_weight_sanitizer() -> None:
    """Put the loaded vision tower into the layout MLX's conv3d reads.

    The pinned port loads Qwen3-VL's weights straight out of the safetensors into
    the mlx-vlm module tree, which skips the `sanitize()` mlx-vlm applies through
    its own loader. Only one tensor cares: `patch_embed.proj.weight` ships in
    torch's `(C_out, C_in, kD, kH, kW)` and MLX's conv3d wants `C_in` last, so an
    unsanitized load reaches the first keyframe as
    "[conv] Expect the input channels ... to match". Text-only renders never build
    the tower, which is why only image conditioning saw it.

    The correction is mlx-vlm's OWN `sanitize`, called on the module's loaded
    parameters rather than reimplemented here: its shape check already treats a
    correctly-laid-out tensor as a no-op, so this stays right if a later pin (or a
    later mlx-vlm) starts handing the tower a sanitized weight.
    """
    encoder, original = pinned_encoder_hook("_load_weights")

    def _load_weights(self, model_dir, dtype, verbose):
        original(self, model_dir, dtype, verbose)
        sanitize_vision_weights(self.vision)

    encoder._load_weights = _load_weights


def sanitize_vision_weights(vision) -> None:
    """Run mlx-vlm's `sanitize` over an already-loaded vision module, in place.

    Routed through mlx-vlm's `sanitize_weights`, which is what its own loader
    calls: a tower that stops publishing `sanitize` is then a no-op here rather
    than an AttributeError mid-load. `vision` is None on a text-only encoder.
    """
    if vision is None:
        return
    import mlx.core as mx
    from mlx.utils import tree_flatten, tree_unflatten
    from mlx_vlm.utils import sanitize_weights

    sanitized = sanitize_weights(vision, dict(tree_flatten(vision.parameters())))
    vision.update(tree_unflatten(list(sanitized.items())))
    mx.eval(vision.parameters())


def install_vision_embed_merge() -> None:
    """Scatter a keyframe's vision rows into the tokens that stand for them.

    `<|image_pad|>` rows are a minority of the request — the port's own
    `build_request` wraps them in vision-start/end markers, a `<Picture N>:` label
    and then the whole prompt — but the pinned encode merges them with
    `mx.where(image_mask, hidden, inputs_embeds)`, which broadcasts and therefore
    only lines up when the sequence is nothing BUT image tokens. Any real
    prompt + keyframe pair dies in `[broadcast_shapes]` before a single DiT step.

    The replacement re-runs the pinned encode's own steps and swaps that one line
    for mlx-vlm's `merge_input_ids_with_image_features`, the scatter this is
    modelled on (it also raises when the token and feature counts disagree, which
    the broadcast could never check). A text-only request never reaches the merge,
    so it is handed straight back to the pinned implementation untouched.
    """
    encoder, original = pinned_encoder_hook("encode")
    verify_pinned_encode_source(original)

    def encode(self, prompt: str, images: list | None = None):
        # A text-only request never reaches the merge, so it goes back to the
        # pinned implementation before this even imports what the fix needs.
        if not images:
            return original(self, prompt, images)

        import mlx.core as mx
        import numpy as np
        from mlx_vlm.models.qwen3_vl.language import LanguageModel
        from mlx_vlm.models.qwen3_vl.qwen3_vl import Model

        if self.vision is None:
            raise ValueError("This encoder was built with `load_vision=False`; it cannot take images.")

        input_ids, token_tags, vision_inputs = self.build_request(prompt, images)
        pixel_values, grid_np = vision_inputs
        grid_thw = mx.array(grid_np.astype(np.int32))
        hidden, deepstack_embeds = self.vision(
            mx.array(pixel_values).astype(self.dtype), grid_thw, output_hidden_states=True
        )
        inputs_embeds = self.language.embed_tokens(input_ids)
        # H3 emits no `<|video_pad|>`: its keyframes are image tokens that the DiT
        # layout later tags as video rows, so both token ids the merge ORs over are
        # the image one.
        inputs_embeds, image_mask = Model.merge_input_ids_with_image_features(
            hidden.astype(inputs_embeds.dtype),
            inputs_embeds,
            input_ids,
            self.image_token_id,
            self.image_token_id,
        )
        position_ids, _ = LanguageModel.get_rope_index(
            self, input_ids, image_grid_thw=grid_thw, video_grid_thw=None, attention_mask=None
        )
        hidden_states = self._hidden_states(
            input_ids,
            position_ids,
            inputs_embeds=inputs_embeds,
            visual_pos_masks=image_mask[..., 0],
            deepstack_visual_embeds=deepstack_embeds,
        )
        mx.eval(hidden_states)
        return hidden_states, token_tags

    encoder.encode = encode


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
    encoder_files: list[Path],
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

    A substitute may be one repackaged safetensors or several shards of an
    upstream checkpoint: every file is linked into the same `text_encoder/`,
    which the loader globs, so a multi-shard conditioner needs no index file.
    Only the shards carrying parameters the loader actually builds are pulled,
    so the glob deliberately sees fewer files than the upstream repo publishes.

    Rebuilt from scratch on every render: the links are free, and a stale shim
    pointing at a blob the user has since re-downloaded would otherwise load
    silently-wrong weights.
    """
    for encoder_file in encoder_files:
        if not encoder_file.is_file():
            raise RuntimeError(f"Substituted text encoder is missing: {encoder_file}")
    names = [f.name for f in encoder_files]
    if len(set(names)) != len(names):
        raise RuntimeError(f"Substituted text encoder has duplicate shard names: {sorted(names)}")

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
    for encoder_file in encoder_files:
        (root / "text_encoder" / encoder_file.name).symlink_to(encoder_file)

    if final_norm_key:
        hidden_size = json.loads(stock_config.read_text(encoding="utf-8"))["text_config"]["hidden_size"]
        # `_load_weights` globs *.safetensors in this directory, so a companion
        # shard is picked up alongside the substitute with no loader change.
        write_final_norm_shard(root / "text_encoder" / "_portos_final_norm.safetensors", final_norm_key, hidden_size)

    return root


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


class _H3StepwisePreview:
    """Decode one selected H3 video frame when ProgressWriter sees a step."""

    def __init__(self, pipe, stepwise_dir: str, num_frames: int, height: int, width: int) -> None:
        from minimax_h3_mlx.packing import align_num_frames, video_latent_num_frames

        self.pipe = pipe
        self.stepwise_dir = stepwise_dir
        self.num_frames = align_num_frames(num_frames)
        self.num_latent_frames = video_latent_num_frames(self.num_frames)
        ratio = pipe.video_vae.config.spatial_compression_ratio
        self.latent_height = height // ratio
        self.latent_width = width // ratio
        patch_t, patch_h, patch_w = tuple(pipe.dit.config.patch_size)
        self.target_rows = (
            (self.num_latent_frames // patch_t)
            * (self.latent_height // patch_h)
            * (self.latent_width // patch_w)
        )
        self._latest_rows = None
        self.saved = 0

    def capture(self, rows) -> None:
        # The pinned pipeline passes generated video rows as the first DiT
        # argument. They are the state immediately before the current forward;
        # ProgressWriter publishes them after that forward's step line, which
        # keeps the hook independent of private scheduler locals.
        self._latest_rows = rows[0] if len(rows.shape) == 3 else rows

    def publish(self, step: int, total: int) -> None:
        if self._latest_rows is None:
            return
        try:
            rows = self._latest_rows[-self.target_rows:]
            frames = self.pipe._decode_video(
                rows,
                self.num_latent_frames,
                self.latent_height,
                self.latent_width,
            )
            frame = frames[len(frames) // 2]
            if write_stepwise_preview(self.stepwise_dir, frame):
                self.saved += 1
        except Exception as exc:  # best-effort instrumentation around a live runner
            print(
                f"⚠️ MiniMax H3 stepwise preview failed at {step}/{total}: "
                f"{type(exc).__name__}: {exc}",
                file=sys.stderr,
                flush=True,
            )


class _PreviewingDiT:
    """Delegate the pinned DiT while exposing its latest video input rows."""

    def __init__(self, inner, preview: _H3StepwisePreview) -> None:
        self._inner = inner
        self._preview = preview

    def __getattr__(self, name):
        return getattr(self._inner, name)

    def __call__(self, *args, **kwargs):
        rows = args[0] if args else kwargs.get("video_latents")
        if rows is not None:
            self._preview.capture(rows)
        return self._inner(*args, **kwargs)


def _install_h3_stepwise_preview(pipe, args: argparse.Namespace):
    if not args.preview_dir:
        return None
    preview = _H3StepwisePreview(pipe, args.preview_dir, args.num_frames, args.height, args.width)
    pipe.dit = _PreviewingDiT(pipe.dit, preview)
    return preview


class ProgressWriter:
    """Translate the port's human step lines into PortOS STAGE progress."""

    def __init__(self, preview: _H3StepwisePreview | None = None) -> None:
        self._carry = ""
        self._preview = preview

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

    def _emit(self, line: str) -> None:
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
            if self._preview is not None:
                self._preview.publish(int(step), int(total))
            return
        print(clean, file=sys.stderr, flush=True)


def validate_args(args: argparse.Namespace) -> None:
    # Everything the H3 checkpoint imposes regardless of runtime — fps, the 32px
    # canvas grid, the 17n+5 frame grid, the sigma floor, keyframe anchoring —
    # lives in the shared module so this runner and the CUDA one cannot drift.
    # Only the duration window and the LoRA pairing below are ours.
    validate_h3_output_args(
        args,
        min_frames=MIN_FRAMES,
        max_frames=MAX_FRAMES,
        frame_window_message=(
            f"MiniMax H3 supports approximately 4-15 seconds ({MIN_FRAMES}-{MAX_FRAMES} aligned frames)."
        ),
    )
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


def main() -> int:
    args = parse_args()
    validate_args(args)
    # Read the keyframes first: everything below is a git probe, ~35 HF cache
    # lookups and an mlx/transformers import, so an unreadable conditioning
    # image should not cost seconds before it reports.
    images = load_keyframes(args.image)

    # Before the git pin probe, which is the first child process — and before
    # the ffmpeg this runner shells out to mux with.
    establish_process_group()

    require_ffmpeg()

    # Capacity before anything is loaded. PortOS gates this at submit time too;
    # this is the runner-side half, which also catches a render that reached the
    # helper by another route (a persisted-queue replay, a retry, a direct call).
    enforce_system_memory(args)
    # `images` decides whether the Qwen3-VL vision tower loads at all, so the
    # placement report can state what is actually resident rather than what the
    # entry could hold in the worst case.
    apply_memory_limit(args, vision_loaded=bool(images))

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

    # The three keyframe-path corrections, installed before the pipeline is built
    # so the encoder is already patched when it loads and first reads a keyframe.
    # Only an image-conditioned render needs them, and only it ever hit the bugs.
    if images:
        install_vision_weight_sanitizer()
        install_vision_embed_merge()
        if not torch_image_stack_available():
            install_pil_image_processor()

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
            [Path(f) for f in args.text_encoder_file],
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
    # probe has already exercised this local applicator, so an import or shape
    # error here is a real contract violation and should surface, not be swallowed.
    if args.lora:
        print("STAGE:apply-loras", file=sys.stderr, flush=True)
        from minimax_h3_lora import apply_loras

        apply_loras(
            pipe.dit,
            [{"path": p, "scale": s} for p, s in zip(args.lora, args.lora_scale)],
        )

    print("STAGE:inference", file=sys.stderr, flush=True)
    preview = _install_h3_stepwise_preview(pipe, args)
    progress = ProgressWriter(preview)
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
