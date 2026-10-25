"""PortOS-owned split Diffusers LoRA residuals for H3's quantized CUDA linears.

No fusion, QKV packing, or SwiGLU row permutation: this accepts the original
split Diffusers export only. Register before offload discovers module buffers.
Heavy imports are deferred so header validation needs only the standard library.
"""
from __future__ import annotations

import hashlib
import importlib.metadata
import json
import math
import re
import struct
from pathlib import Path

CONTRACT = json.loads((Path(__file__).resolve().parents[1] / "server/lib/minimaxH3Lightx2v.json").read_text())
TARGET = re.compile(
    r"^(?:transformer_blocks\.\d+|token_refiner\.refiner_blocks\.\d+)\."
    r"(?:attn\.(?:to_q|to_k|to_v|to_out\.0)|ff\.net\.(?:0\.proj|2))$"
)
KEY = re.compile(r"^(.*)\.lora_([AB])(?:\.default)?\.weight$")


def read_header(path):
    with Path(path).open("rb") as stream:
        size_bytes = stream.read(8)
        if len(size_bytes) != 8:
            raise ValueError("Truncated LoRA header.")
        size = struct.unpack("<Q", size_bytes)[0]
        if not 0 < size < 10 * 1024 * 1024:
            raise ValueError("Invalid LoRA header length.")
        header = json.loads(stream.read(size))
    if not isinstance(header, dict):
        raise ValueError("Invalid LoRA header.")
    return header


def adapter_plan(header, scale=1.0):
    if not math.isfinite(float(scale)):
        raise ValueError("LoRA strength must be finite.")
    metadata = header.get("__metadata__", {})
    pairs = {}
    for key, desc in header.items():
        if key == "__metadata__":
            continue
        match = KEY.fullmatch(key)
        if not match:
            raise ValueError(f"Unsupported H3 CUDA LoRA tensor {key!r}; use a split Diffusers A/B export with alpha metadata.")
        target, side = match.groups()
        target = target.removeprefix("transformer.")
        if not TARGET.fullmatch(target):
            raise ValueError(f"Unsupported H3 CUDA projection {target!r}; fused/native/ComfyUI layouts are not supported.")
        pair = pairs.setdefault(target, {})
        if side in pair:
            raise ValueError(f"Duplicate H3 CUDA projection {target!r}.")
        shape = desc.get("shape", [])
        if desc.get("dtype") not in ("BF16", "F16", "F32") or len(shape) != 2 or any(not isinstance(n, int) or n <= 0 for n in shape):
            raise ValueError(f"Invalid H3 CUDA LoRA shape for {key!r}.")
        pair[side] = (key, shape)
    if not pairs:
        raise ValueError("The H3 CUDA LoRA contains no projection pairs.")
    result = []
    for target, pair in sorted(pairs.items()):
        if set(pair) != {"A", "B"} or pair["A"][1][0] != pair["B"][1][1]:
            raise ValueError(f"Incomplete or mismatched H3 CUDA LoRA pair at {target!r}.")
        rank = pair["A"][1][0]
        # An absent alpha is not evidence of alpha=rank. Require the author's
        # explicit metadata instead of guessing a training convention.
        try:
            if not isinstance(metadata["alpha"], str):
                raise ValueError("safetensors metadata must contain strings")
            alpha = float(metadata["alpha"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("H3 CUDA LoRAs require numeric alpha metadata; re-export as split Diffusers safetensors.") from exc
        if not math.isfinite(alpha) or alpha <= 0:
            raise ValueError("H3 CUDA LoRA alpha must be finite and positive.")
        result.append((target, pair["A"][0], pair["B"][0], float(scale) * alpha / rank))
    return result


def file_digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def attach_residual(module, down, up, scale):
    import torch.nn.functional as functional

    index = getattr(module, "_portos_lora_count", 0)
    down_name, up_name = f"_portos_lora_down_{index}", f"_portos_lora_up_{index}"
    module.register_buffer(down_name, down, persistent=False)
    module.register_buffer(up_name, up, persistent=False)
    module._portos_lora_count = index + 1

    def residual(layer, inputs, output):
        value = inputs[0]
        a = getattr(layer, down_name).to(device=value.device, dtype=value.dtype)
        b = getattr(layer, up_name).to(device=value.device, dtype=value.dtype)
        delta = functional.linear(functional.linear(value, a), b)
        return output + delta.to(output.dtype) * scale

    module.register_forward_hook(residual)


def apply_adapters(transformer, adapters, *, speed_profile=False):
    """Validate the complete stack before attaching one residual per pair."""
    from safetensors.torch import load_file

    pending, seen, reports = [], set(), []
    for path, strength in adapters:
        digest = file_digest(path)
        if digest == CONTRACT["adapter"]["sha256"] and not speed_profile:
            raise ValueError("LightX2V v1.3 requires its named speed profile; it cannot run as a user LoRA on the stock sampler.")
        if digest in seen:
            raise ValueError("The same H3 CUDA adapter was selected more than once (including the speed adapter).")
        seen.add(digest)
        header = read_header(path)
        plan = adapter_plan(header, strength)
        tensors = load_file(str(path), device="cpu")
        for target, down_key, up_key, scale in plan:
            module = transformer.get_submodule(target)
            down, up = tensors[down_key], tensors[up_key]
            if tuple(down.shape)[1] != getattr(module, "in_features", None) or tuple(up.shape)[0] != getattr(module, "out_features", None):
                raise ValueError(f"H3 CUDA LoRA dimensions do not match {target!r}.")
            pending.append((module, down, up, scale))
        reports.append({"file": Path(path).name, "sha256": digest, "strength": strength,
                        "alpha": float(header["__metadata__"]["alpha"]), "projections": len(plan)})
    for module, down, up, scale in pending:
        attach_residual(module, down, up, scale)
    return reports


def assert_runtime_contract():
    for package, expected in CONTRACT["runtimePackages"].items():
        if importlib.metadata.version(package) != expected:
            raise RuntimeError(f"LightX2V requires {package}=={expected}. Repair the H3 CUDA runtime in Video Gen.")
    from diffusers import MiniMaxH3Scheduler
    from diffusers.modular_pipelines.minimax_h3 import MiniMaxH3Blocks

    # Check the real scheduler's convention, not a version string alone. H3's
    # terminal zero counts as a point, so five points must mean four updates.
    inputs = {p.name for p in MiniMaxH3Blocks().inputs}
    if "num_inference_steps" not in inputs:
        raise RuntimeError("H3 CUDA runtime lacks the required sampler input.")
    for shift in (CONTRACT["videoShift"], CONTRACT["audioShift"]):
        scheduler = MiniMaxH3Scheduler(shift=shift)
        scheduler.set_timesteps(CONTRACT["steps"])
        expected = [shift * q / (1 + (shift - 1) * q) for q in CONTRACT["sigmaPoints"]]
        if len(scheduler.timesteps) != CONTRACT["denoisingSteps"] or len(scheduler.sigmas) != len(expected):
            raise RuntimeError("H3 CUDA scheduler point/update convention changed.")
        if any(abs(float(a) - b) > 1e-6 for a, b in zip(scheduler.sigmas, expected)):
            raise RuntimeError("H3 CUDA scheduler no longer implements the pinned shifted sigma grid.")


def probe():
    assert_runtime_contract()
    import torch
    from torchao.quantization import Int8WeightOnlyConfig, quantize_

    if not torch.cuda.is_available():
        raise RuntimeError("H3 CUDA adapters require an available CUDA device.")
    linear = torch.nn.Linear(128, 128, bias=False, dtype=torch.bfloat16, device="cuda")
    quantize_(linear, Int8WeightOnlyConfig(version=2))
    if not type(linear.weight).__module__.startswith("torchao."):
        raise RuntimeError("H3 CUDA probe did not obtain a torchao quantized linear.")
    value = torch.ones(1, 128, dtype=torch.bfloat16, device="cuda")
    base = linear(value)
    attach_residual(linear, torch.ones(8, 128, dtype=value.dtype, device="cuda"),
                    torch.ones(128, 8, dtype=value.dtype, device="cuda"), 0.5)
    torch.testing.assert_close(linear(value), base + 512)


if __name__ == "__main__":
    import sys
    if sys.argv[1:] == ["--probe"]:
        probe()
    else:
        raise SystemExit("Expected --probe.")
