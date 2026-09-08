#!/usr/bin/env python3
"""Generative 2x video upscale on the LTX-2.5 MLX runtime (#6512).

The pass fuses the gated LTX-2.5 Pixel Spatial Upscaler IC-LoRA into the
distilled transformer and conditions on the clip being upscaled, so it is an
IC-LoRA render whose single reference IS the source. That is why the argv is
the IC flag alphabet `renderArgs.buildLtxUpscaleArgs()` already emits rather
than a second vocabulary, and why the reference-count bounds arrive as flags:
`server/lib/icLoraWeights.js` is the single source of truth across both
languages, and a Python-side default would be a second table free to drift.

Everything this runner needs was READ off the pinned runtime
(`~/.portos/ltx-2.5-mlx`, `LTX25_EXPECTED_REVISION`), not inferred from the
gated model card:

  - The 2.5 fork ships its OWN `ltx_pipelines_mlx.ic_lora.ICLoraPipeline`, so
    there is nothing to compose with `generate_ltx2.py`'s 2.3 encoder-shim /
    unified-weight-filter machinery. This runner talks to the 2.5 pipeline
    directly and imports none of it.
  - The correct text encoder is the gemma4 conditioner the 2.5 pack ships under
    `<model_dir>/text_encoder/`. `PromptEncoder._text_encoder_source()` prefers
    it and otherwise falls back to the remote 2.3 Gemma 3 id — a wrong encoder
    AND an unannounced multi-GB download — so `validate_model_dir` refuses a
    pack that lacks it instead of letting that fallback happen.
  - The recipe is the standard single-stage IC-LoRA video-to-video pass at the
    output size with the source as the reference at half of it — see
    `PIPELINE_REQUEST_MULTIPLIER` in `_upscale_contract.py` for why that means
    requesting twice the output and skipping stage 2.
  - The schedule is the fixed distilled one: `DISTILLED_SIGMAS` is 8 steps.
    Passing no step count selects exactly that, which is why this runner
    exposes no steps flag.
  - Quantization-safe fusion is the runtime's own contract: `apply_loras()`
    dequantizes an int4/int8 weight, adds the delta, and re-quantizes. What it
    does NOT do is complain when an adapter addresses keys the transformer does
    not have — every delta is simply missing, the fusion is a silent no-op, and
    the render is the plain base model. `assert_adapter_fuses` is the guard for
    that: it is the "loads but produces garbage" case #6512 names.
  - `reference_downscale_factor` is read from the adapter's safetensors
    `__metadata__` (`iclora_utils.read_lora_reference_downscale_factor`) and
    enforced against the STAGE-1 dims, which are half the output. It is
    reported on stderr so the value is recorded rather than guessed.

Phosphene's fast source-latent refinement is deliberately NOT ported — #6502
rules it fork-specific, and the current pins take no such arguments.
"""

from __future__ import annotations

import argparse
import platform
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _runner_common import (  # noqa: E402
    LTX25_DEV_TRANSFORMER_FILENAME,
    LTX25_DISTILLED_LORA_FILENAME,
    emit_runtime_fingerprint,
    heartbeat,
)
# The argv, grid and adapter contract this runner shares with the CUDA one
# (#6513). Re-exported names stay module attributes, so a caller — or a test —
# still reaches them as `upscale_ltx25.validate_args` / `.lora_target_keys`.
from _upscale_contract import (  # noqa: E402
    REFERENCE_STRENGTH,
    add_upscale_arguments,
    assert_reference_scale_fits,
    conditioned_stage_request,
    lora_target_keys,
    read_safetensors_header,
    reference_downscale_factor,
    validate_args,
)

# The 2.5 pack's own prompt conditioner. Its absence is a hard refusal rather
# than a fallback — see the module docstring.
TEXT_ENCODER_DIRNAME = "text_encoder"

# Full strength turns the dev weights INTO the distilled model — the pack's
# README states the pre-fused file is this LoRA at the default strength of 1.0.
DISTILLED_LORA_STRENGTH = 1.0

FINGERPRINT_PACKAGES = ["ltx_pipelines_mlx", "ltx_core_mlx", "mlx", "mlx_metal"]


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def parse_args(argv: "list[str] | None" = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="LTX-2.5 MLX generative video upscale")
    add_upscale_arguments(parser, model_help=(
        "local snapshot directory of the pinned LTX-2.5 MLX pack "
        "(resolved cache-only by PortOS; never a repo id)"
    ))
    return parser.parse_args(argv)

def validate_host(system: str, machine: str) -> None:
    """Capability gate: this runner is Apple-Silicon-only.

    MLX has no non-Metal backend, so an Intel Mac or a Linux box reaching here
    is a routing bug in `ltxUpscaleRuntimeId()`. Named explicitly so the queue
    shows the actionable reason rather than an import traceback.
    """
    if system != "Darwin" or machine != "arm64":
        raise SystemExit(
            f"The LTX-2.5 MLX upscale runner needs Apple Silicon; this host reports {system}/{machine}. "
            "Use the CUDA backend on an NVIDIA machine instead."
        )


def validate_model_dir(model_dir: str) -> Path:
    """Resolve the pinned LTX-2.5 pack, refusing a pack without its conditioner.

    PortOS resolves the snapshot cache-only and hands over a directory, so a
    missing one means the pack was never downloaded (or was deleted underneath a
    queued job). The `text_encoder/` check is the load-bearing half: without it
    `PromptEncoder` silently falls back to the remote LTX-2.3 Gemma 3 id, which
    is both the wrong conditioner for these weights and an unannounced download.
    """
    root = Path(model_dir)
    if not root.is_dir():
        raise SystemExit(
            f"The LTX-2.5 MLX model pack is not cached at {model_dir} — "
            "download or repair it in Video Gen before upscaling."
        )
    if not (root / TEXT_ENCODER_DIRNAME / "config.json").is_file():
        raise SystemExit(
            f"The LTX-2.5 pack at {model_dir} is missing {TEXT_ENCODER_DIRNAME}/config.json, so the "
            "pipeline would fall back to the LTX-2.3 Gemma 3 conditioner and fetch it at render time. "
            "Repair the model in Video Gen."
        )
    return root


def resolve_transformer_path(model_dir: Path) -> "Path | None":
    """The DiT weight file `ICLoraPipeline.load()` would pick, or None.

    Mirrors that method exactly: the plain `transformer.safetensors` wins, else
    `BasePipeline._resolve_safetensors(model_dir, "transformer-distilled")`
    takes the lexicographically last versioned file and falls back to the
    unversioned name.
    """
    plain = model_dir / "transformer.safetensors"
    if plain.is_file():
        return plain
    versioned = sorted(model_dir.glob("transformer-distilled-*.safetensors"))
    if versioned:
        return versioned[-1]
    fallback = model_dir / "transformer-distilled.safetensors"
    return fallback if fallback.is_file() else None


def resolve_transformer_layout(model_dir: Path) -> "tuple[Path, list[tuple[str, float]]]":
    """The DiT file to fuse into, plus any LoRA the pack needs to make it the distilled model.

    The pinned q8 pack documents two layouts for the distilled model. The
    pre-fused `transformer-distilled.safetensors` is what `ICLoraPipeline.load()`
    resolves on its own and wins whenever present (no extra LoRA). A pack that
    carries only the dev transformer holds the SAME model as dev weights plus
    the 450-step distilled LoRA — the layout the pack README names as the
    equivalent non-streaming arrangement and the runtime's own pipelines fuse
    for their distilled stage — so that LoRA is returned beside it. The
    distilled schedule this runner drives is only valid on the distilled model,
    so dev WITHOUT that LoRA is a refusal, never a fallback.
    """
    distilled = resolve_transformer_path(model_dir)
    if distilled is not None:
        return distilled, []
    dev = model_dir / LTX25_DEV_TRANSFORMER_FILENAME
    if not dev.is_file():
        raise SystemExit(
            f"The LTX-2.5 pack at {model_dir} has no transformer weight file. Repair the model in Video Gen."
        )
    lora = model_dir / LTX25_DISTILLED_LORA_FILENAME
    if not lora.is_file():
        raise SystemExit(
            f"The LTX-2.5 pack at {model_dir} carries only {LTX25_DEV_TRANSFORMER_FILENAME} and not the "
            f"{LTX25_DISTILLED_LORA_FILENAME} that makes it the distilled model the upscale schedule needs. "
            "Repair the model in Video Gen."
        )
    return dev, [(str(lora), DISTILLED_LORA_STRENGTH)]


def make_pipeline(pipeline_cls, model_dir: Path, transformer_path: Path, lora_paths):
    """An `ICLoraPipeline` whose DiT is the resolved transformer, whichever layout.

    `ICLoraPipeline.load()` resolves the transformer itself and knows only the
    distilled-file layout, so a dev-layout pack has to be steered: the subclass
    loads the resolved file first and lets `load()` skip its own resolution
    (it only resolves when `dit` is still None). The load still happens inside
    `generate()`, AFTER the text encoder has been freed, so nothing here holds
    the DiT resident through prompt encoding. `lora_paths` is every adapter
    `_fuse_loras` will add to the DiT in ONE pass — the IC adapter, and on a dev
    layout the distilled LoRA beside it.

    `load()` also builds the latent upsampler for a stage 2 this runner never
    runs (`skip_stage_2`), reading a ~1 GB weight into memory that then sits
    beside the DiT for the whole render. Pre-seeding the slot makes `load()`
    skip it; nothing under `skip_stage_2` dereferences the upsampler.
    """
    class PackLayoutPipeline(pipeline_cls):
        def load(self):
            if self.dit is None and not self._loaded:
                self.dit = self._load_transformer_with_optional_streaming(transformer_path)
            if self.upsampler is None:
                self.upsampler = _UNUSED_UPSAMPLER
            super().load()

    return PackLayoutPipeline(model_dir=str(model_dir), lora_paths=list(lora_paths))


_UNUSED_UPSAMPLER = object()


def transformer_weight_keys(transformer_path: Path) -> "set[str]":
    """The transformer's fusable parameter names, read from its header alone.

    `load_transformer` loads the file through
    `load_split_safetensors(path, prefix="transformer.")`, which keeps only the
    prefixed keys and strips the prefix — so the model's parameter names are a
    deterministic function of the file's header, with no tensor I/O and no
    model in memory. Only `.weight` keys matter: `_prepare_deltas` addresses a
    weight by `<prefix>.weight`, and a quantized pack's sibling
    `.scales`/`.biases` are carried along with it rather than fused into.
    """
    header = read_safetensors_header(str(transformer_path))
    if not header:
        return set()
    prefix = "transformer."
    return {
        name[len(prefix):]
        for name in header
        if name != "__metadata__" and name.startswith(prefix) and name.endswith(".weight")
    }


def assert_adapter_fuses(adapter_path: str, model_keys, rename) -> int:
    """Refuse an adapter whose tensors address none of the transformer's weights.

    This is the failure #6512 calls out: `apply_loras` reports nothing when a
    key does not match — every delta is simply absent, the fusion is a silent
    no-op, and the render is the un-adapted base model dressed as an upscale.
    Only headers are read, so the check costs no tensor I/O and runs BEFORE the
    pipeline loads anything.

    Returns the number of weights the adapter will actually fuse into, so the
    render records real coverage instead of "it loaded".
    """
    header = read_safetensors_header(adapter_path)
    if not header:
        raise SystemExit(
            f"Could not read the adapter's safetensors header at {adapter_path} — "
            "the file is truncated or is not a safetensors weight. Repair it in Video Gen."
        )
    if not model_keys:
        raise SystemExit(
            "Could not read the LTX-2.5 transformer's weight names, so there is no way to tell whether "
            "the upscale adapter would fuse into anything. Repair the model in Video Gen."
        )
    renamed = [rename(name) for name in header if name != "__metadata__"]
    matched = lora_target_keys(name for name in renamed if name) & set(model_keys)
    if not matched:
        raise SystemExit(
            "The upscale adapter's tensors do not address any weight in this transformer, so fusing it "
            "would be a no-op and the 'upscale' would be an un-adapted render. The adapter and the "
            "LTX-2.5 pack are mismatched — repair both in Video Gen."
        )
    return len(matched)


def main() -> None:
    args = parse_args()
    validate_host(platform.system(), platform.machine())
    validate_args(args)
    model_dir = validate_model_dir(args.model)

    header = read_safetensors_header(args.ic_lora_path)
    scale = reference_downscale_factor(header)
    assert_reference_scale_fits(scale, args.width, args.height)
    # The per-install measurement the queue records beside the registry's
    # declared value — a re-pinned weight is measured, not trusted.
    log(f"UPSCALE_REFERENCE_DOWNSCALE:{scale}")

    log("STAGE:verify-adapter")
    from ltx_core_mlx.loader import LTXV_LORA_COMFY_RENAMING_MAP
    from ltx_pipelines_mlx.ic_lora import ICLoraPipeline

    emit_runtime_fingerprint("ltx25", FINGERPRINT_PACKAGES)

    # Both sides of the coverage check are header reads, so a mismatched pair
    # fails in milliseconds — before Gemma, before the DiT, before a GPU. Do NOT
    # move this behind a `pipe.load()`: `generate()` deliberately loads the text
    # encoder, encodes, frees it, and only THEN loads the transformer, so
    # pre-loading would hold a multi-GB DiT resident through prompt encoding.
    transformer_path, pack_loras = resolve_transformer_layout(model_dir)
    layout = " + ".join([transformer_path.name, *(Path(path).name for path, _ in pack_loras)])
    log(f"STATUS:Transformer layout: {layout}")
    fused = assert_adapter_fuses(
        args.ic_lora_path,
        transformer_weight_keys(transformer_path),
        LTXV_LORA_COMFY_RENAMING_MAP.apply_to_key,
    )
    log(f"STATUS:Adapter fuses into {fused} transformer weights")

    log("STAGE:load-pipeline")
    log(f"STATUS:Loading LTX-2.5 MLX upscale pipeline ({args.width}x{args.height}, {args.num_frames} frames)")
    pipe = make_pipeline(ICLoraPipeline, model_dir, transformer_path, [(args.ic_lora_path, 1.0), *pack_loras])

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    request_width, request_height = conditioned_stage_request(args.width, args.height)
    log("STAGE:inference")
    with heartbeat("ltx25-upscale-inference"):
        # Twice the output + `skip_stage_2` = one conditioned stage AT the
        # output (see `conditioned_stage_request`). No stage-1 step count:
        # `DISTILLED_SIGMAS` IS the distilled schedule (8 steps), and passing a
        # count would truncate it.
        pipe.generate_and_save(
            prompt=args.prompt,
            output_path=str(output),
            video_conditioning=[(reference, REFERENCE_STRENGTH) for reference in args.ic_reference],
            height=request_height,
            width=request_width,
            num_frames=args.num_frames,
            frame_rate=args.fps,
            seed=args.seed,
            skip_stage_2=True,
        )
    if not output.is_file():
        raise SystemExit(f"The LTX-2.5 upscale completed but did not write {output}.")
    log(f"STATUS:Upscaled {output.name} ({args.width}x{args.height}, {args.num_frames} frames)")


if __name__ == "__main__":
    main()
