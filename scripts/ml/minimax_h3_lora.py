#!/usr/bin/env python3
"""Apply LoRAs to the MiniMax H3 MLX DiT without rewriting quantized weights.

MiniMax H3's main DiT linears are stored as MLX packed ``uint32`` weights. A
normal LoRA merge cannot use those storage shapes, and replacing the packed
weights would also discard the quantization metadata that MLX needs to run
them. This adapter keeps each base module intact and adds the low-rank delta
to its activation output instead:

    quantized_linear(x) + (x @ lora_down.T) @ lora_up.T * scale

A fused ``qkv_proj`` adapter's row order is resolved from its tensor-key format
and its safetensors header metadata (``portos.qkv_layout`` / ``qkv_layout`` set
to ``contiguous`` or ``native``), never from its filename. An unannotated fused
export keeps the reference ``[q; k; v]`` default.

The adapter is deliberately local to PortOS rather than imported from the
runtime checkout. The source checkout is pinned for the H3 model itself; this
small integration layer owns the LoRA file-format and quantization contract.
"""

from __future__ import annotations

import math
import re
from pathlib import Path
from typing import Any

import mlx.core as mx
import mlx.nn as nn


_QKV_TARGET_SUFFIX = ".attn.qkv_proj"
_DIFFUSERS_H3_DEFAULT_ALPHA = 8.0

# A fused qkv_proj adapter's row order is a property of its bytes, never of its
# filename: renaming an adapter must not change the transformation applied to
# it. An adapter declares its fused row order in safetensors header metadata
# under one of these keys. Both are read so a contradiction between them is
# rejected rather than resolved by precedence.
_QKV_LAYOUT_METADATA_KEYS = ("portos.qkv_layout", "qkv_layout")
_QKV_LAYOUT_DECLARATION_MAX_CHARS = 64
_QKV_LAYOUT_DECLARATIONS = {
    # Reference-tree rows: [q_all; k_all; v_all].
    "contiguous": "contiguous_qkv",
    "contiguous_qkv": "contiguous_qkv",
    "fused": "contiguous_qkv",
    "reference": "contiguous_qkv",
    # The MLX port's raw qkv_proj rows: per head, [q_h; k_h; v_h].
    "native": "native_interleaved",
    "native_interleaved": "native_interleaved",
    "interleaved": "native_interleaved",
    "per_head": "native_interleaved",
}

# Common safetensors exports use one of these suffix pairs. Keeping the parser
# here format-focused means target names can be normalized independently.
_LORA_SUFFIXES = (
    (".lora_A.default.weight", "down"),
    (".lora_B.default.weight", "up"),
    (".lora_A.default", "down"),
    (".lora_B.default", "up"),
    (".lora_A.weight", "down"),
    (".lora_B.weight", "up"),
    (".lora_down.weight", "down"),
    (".lora_up.weight", "up"),
    (".lora_A", "down"),
    (".lora_B", "up"),
    (".lora_down", "down"),
    (".lora_up", "up"),
    (".lora_alpha", "alpha"),
    (".alpha", "alpha"),
)


class _LoRAProjection(nn.Module):
    """One low-rank activation-space projection."""

    def __init__(self, down: mx.array, up: mx.array, scale: float):
        super().__init__()
        self.down = down
        self.up = up
        self.scale = float(scale)

    def __call__(self, value: mx.array) -> mx.array:
        # Match the adapter's own precision for the matrix products. The base
        # quantized projection remains responsible for its own scales/biases;
        # this only prevents MLX from promoting a low-rank delta unexpectedly.
        delta = value.astype(self.down.dtype) @ self.down.T
        delta = delta @ self.up.T
        return delta.astype(self.up.dtype) * self.scale


class LoRALinear(nn.Module):
    """A base linear plus one or more runtime LoRA deltas.

    Attribute forwarding is intentional. H3's AdaLN cache builder and its
    memory-saving ``drop_adaln_weights`` helper inspect ``weight``, ``scales``
    and ``biases`` on the projection. Forwarding those attributes to the base
    lets a wrapped AdaLN projection participate in the cache and still release
    its large base arrays afterward.
    """

    def __init__(self, base: nn.Module, adapters: list[_LoRAProjection]):
        super().__init__()
        self.base = base
        self.adapters = adapters

    def __getattr__(self, name: str) -> Any:
        try:
            return super().__getattr__(name)
        except AttributeError:
            base = self.get("base")
            if base is not None:
                return getattr(base, name)
            raise

    def __delattr__(self, name: str) -> None:
        # Parameters stored on this wrapper are normal Module entries. Missing
        # projection attributes belong to the wrapped base and must be deleted
        # there so H3's post-cache memory release keeps working.
        if name in self:
            super().__delattr__(name)
            return
        base = self.get("base")
        if base is not None and hasattr(base, name):
            delattr(base, name)
            return
        super().__delattr__(name)

    def add_adapter(self, adapter: _LoRAProjection) -> None:
        self.adapters = [*self.adapters, adapter]

    def __call__(self, value: mx.array) -> mx.array:
        output = self.base(value)
        for adapter in self.adapters:
            output = output + adapter(value).astype(output.dtype)
        return output


def _normalize_target(target: str) -> tuple[str, str]:
    """Map common diffusers/ComfyUI H3 prefixes to PortOS's DiT tree."""
    if target.startswith("lora_unet_"):
        # Kohya flattens the module path with underscores. Keep the terminal
        # ``to_q``/``to_k``/``to_v`` token intact while restoring the separators
        # that identify a Diffusers H3 attention projection.
        target = target[len("lora_unet_"):]
        flattened = re.match(r"^(transformer_blocks|single_transformer_blocks)_(\d+)_(.+)$", target)
        if flattened:
            target = f"{flattened.group(1)}.{flattened.group(2)}.{flattened.group(3)}"
            target = target.replace("_to_out_", ".to_out.")
            target = target.replace("_to_", ".to_")
            target = target.replace(".ff_net_", ".ff.net.")
    prefixes = (
        "base_model.model.",
        "model.diffusion_model.",
        "diffusion_model.",
        "transformer.",
        "model.",
    )
    for prefix in prefixes:
        if target.startswith(prefix):
            target = target[len(prefix):]
            break
    if target.startswith("transformer_blocks."):
        target = "blocks." + target[len("transformer_blocks."):]
    if target.startswith("token_refiner.refiner_blocks."):
        target = "token_refiner.blocks." + target[len("token_refiner.refiner_blocks."):]
    target = target.replace(".attention.", ".attn.")
    target = target.replace(".attn1.", ".attn.")
    if target.endswith(".attn.to_q"):
        return target[:-len(".attn.to_q")] + ".attn.qkv_proj", "split_q"
    if target.endswith(".attn.to_k"):
        return target[:-len(".attn.to_k")] + ".attn.qkv_proj", "split_k"
    if target.endswith(".attn.to_v"):
        return target[:-len(".attn.to_v")] + ".attn.qkv_proj", "split_v"
    if target.endswith(".attn.to_out.0"):
        return target[:-len(".attn.to_out.0")] + ".attn.out_proj", "diffusers"
    if target.endswith(".ff.net.0.proj"):
        return target[:-len(".ff.net.0.proj")] + ".mlp.fc1", "diffusers_fc1"
    if target.endswith(".ff.net.2"):
        return target[:-len(".ff.net.2")] + ".mlp.fc2", "diffusers"
    if target == "norm_out.linear":
        return "final_layer.adaln_proj.linear", "diffusers"
    if target.endswith(".to_qkv"):
        return target[:-len(".to_qkv")] + ".qkv_proj", "contiguous_qkv"
    return target, "reference"


def _parse_tensor_key(key: str) -> tuple[str, str, str] | None:
    lowered = key.lower()
    for suffix, kind in _LORA_SUFFIXES:
        if lowered.endswith(suffix.lower()):
            target = key[:-len(suffix)]
            target, source_layout = _normalize_target(target)
            return target, kind, source_layout
    return None


def _logical_shape(module: nn.Module) -> tuple[int, int]:
    """Return ``(output_dims, input_dims)`` including packed quantized dims."""
    weight = getattr(module, "weight", None)
    if weight is None or len(weight.shape) != 2:
        raise ValueError(f"LoRA target {type(module).__name__} has no rank-2 weight.")
    output_dims, stored_input_dims = (int(value) for value in weight.shape)

    # Newer MLX versions expose the logical dimensions directly. The pinned
    # MLX 0.32 QuantizedLinear does not, so recover the input width from its
    # packed uint32 storage and quantization bit width.
    input_dims = getattr(module, "input_dims", None)
    output_dims_attr = getattr(module, "output_dims", None)
    if input_dims is not None and output_dims_attr is not None:
        return int(output_dims_attr), int(input_dims)
    if weight.dtype == mx.uint32:
        bits = int(getattr(module, "bits", 0) or 0)
        if bits <= 0 or 32 % bits:
            raise ValueError(f"LoRA target {type(module).__name__} has unknown quantization bits.")
        return output_dims, stored_input_dims * 32 // bits
    return output_dims, stored_input_dims


def _target_module(root: nn.Module, target: str) -> tuple[nn.Module, str, nn.Module]:
    parts = target.split(".")
    if not parts or any(not part for part in parts):
        raise ValueError(f"Invalid MiniMax H3 LoRA target {target!r}.")
    parent: Any = root
    for part in parts[:-1]:
        try:
            parent = parent[int(part)] if part.isdigit() else getattr(parent, part)
        except (AttributeError, IndexError, KeyError, TypeError) as error:
            raise ValueError(f"MiniMax H3 LoRA target {target!r} is not present in the DiT.") from error
    leaf = parts[-1]
    try:
        module = parent[int(leaf)] if leaf.isdigit() else getattr(parent, leaf)
    except (AttributeError, IndexError, KeyError, TypeError) as error:
        raise ValueError(f"MiniMax H3 LoRA target {target!r} is not present in the DiT.") from error
    if not callable(module):
        raise ValueError(f"MiniMax H3 LoRA target {target!r} is not callable.")
    return parent, leaf, module


def _transpose_if_needed(value: mx.array, expected: tuple[int, int], label: str) -> mx.array:
    if len(value.shape) != 2:
        raise ValueError(f"MiniMax H3 LoRA {label} must be rank 2, got {value.shape}.")
    if tuple(int(item) for item in value.shape) == expected:
        return value
    transposed = tuple(reversed(int(item) for item in value.shape))
    if transposed == expected:
        return value.T
    raise ValueError(f"MiniMax H3 LoRA {label} shape {value.shape} does not match {expected}.")


def _prepare_down(value: mx.array, input_dims: int) -> mx.array:
    if len(value.shape) != 2:
        raise ValueError(f"MiniMax H3 LoRA lora_down must be rank 2, got {value.shape}.")
    shape = tuple(int(item) for item in value.shape)
    if shape[1] == input_dims:
        return value
    if shape[0] == input_dims:
        return value.T
    raise ValueError(
        f"MiniMax H3 LoRA lora_down shape {value.shape} does not match input width {input_dims}."
    )


def _declared_qkv_layout(metadata: dict[str, Any], adapter_name: str) -> str | None:
    """Return the fused-QKV row order an adapter's header metadata declares.

    Only the known layout keys are read, each bounded in size, so an arbitrary
    training-metadata blob neither participates in nor slows the decision.
    ``None`` means the adapter makes no declaration.
    """
    supported = "'contiguous' ([q; k; v] rows) or 'native' (per-head interleaved rows)"
    resolved: dict[str, str] = {}
    for key in _QKV_LAYOUT_METADATA_KEYS:
        if key not in metadata:
            continue
        raw = metadata[key]
        if not isinstance(raw, str) or len(raw) > _QKV_LAYOUT_DECLARATION_MAX_CHARS:
            raise ValueError(
                f"MiniMax H3 LoRA {adapter_name} has a malformed {key!r} metadata value; "
                f"set it to {supported}."
            )
        normalized = raw.strip().lower().replace("-", "_")
        layout = _QKV_LAYOUT_DECLARATIONS.get(normalized)
        if layout is None:
            raise ValueError(
                f"MiniMax H3 LoRA {adapter_name} declares unsupported {key}={raw!r}; "
                f"set it to {supported}."
            )
        resolved[key] = layout
    if len(set(resolved.values())) > 1:
        declared = ", ".join(f"{key}={metadata[key]!r}" for key in resolved)
        raise ValueError(
            f"MiniMax H3 LoRA {adapter_name} has contradictory QKV layout metadata ({declared}); "
            f"keep one declaration set to {supported}."
        )
    return next(iter(resolved.values()), None)


def _qkv_layout(source_layout: str, declared: str | None, target: str, adapter_name: str) -> str:
    """Resolve one fused-QKV target's row order from its key format and metadata."""
    if source_layout in ("split_q", "split_k", "split_v"):
        # A separate to_q/to_k/to_v projection has no fused row order, so a
        # fused-layout declaration neither applies to nor conflicts with it.
        return source_layout
    if source_layout == "contiguous_qkv":
        # The Diffusers ``to_qkv`` key format itself declares reference rows.
        if declared is not None and declared != "contiguous_qkv":
            raise ValueError(
                f"MiniMax H3 LoRA {adapter_name} declares {declared} QKV rows, but its "
                f"{target!r} tensors use the Diffusers to_qkv format, which is contiguous. "
                "Remove the qkv_layout metadata or re-export the adapter with MLX qkv_proj keys."
            )
        return source_layout
    if source_layout == "reference":
        # Public H3 reference-tree exports use [q_all; k_all; v_all] rows. The
        # MLX port's raw qkv_proj is per-head interleaved, so an unannotated
        # fused export keeps the reference default; native MLX exports opt out
        # through qkv_layout metadata.
        return declared or "contiguous_qkv"
    raise ValueError(f"MiniMax H3 LoRA target {target!r} has unknown QKV layout {source_layout!r}.")


def _prepare_up(
    target: str,
    parent: nn.Module,
    module: nn.Module,
    up: mx.array,
    output_dims: int,
    rank: int,
    source_layout: str,
    declared_qkv_layout: str | None,
    adapter_name: str,
) -> mx.array:
    qkv_target = target.endswith(_QKV_TARGET_SUFFIX)
    expected_output_dims = output_dims
    if qkv_target and source_layout in ("split_q", "split_k", "split_v"):
        expected_output_dims //= 3
    up = _transpose_if_needed(up, (expected_output_dims, rank), "lora_up")
    if not qkv_target:
        if source_layout == "diffusers_fc1":
            half = output_dims // 2
            if output_dims % 2:
                raise ValueError(f"MiniMax H3 LoRA target {target!r} has an odd fc1 width.")
            return mx.concatenate([up[half:], up[:half]], axis=0)
        return up
    layout = _qkv_layout(source_layout, declared_qkv_layout, target, adapter_name)
    heads = int(getattr(parent, "heads", 0) or 0)
    head_dim = int(getattr(parent, "head_dim", 0) or 0)
    if heads <= 0 or head_dim <= 0 or heads * head_dim * 3 != output_dims:
        raise ValueError(
            f"MiniMax H3 LoRA target {target!r} cannot infer its interleaved QKV layout "
            f"from {type(module).__name__}."
        )
    if layout == "native_interleaved":
        return up
    if layout == "contiguous_qkv":
        return up.reshape(3, heads, head_dim, rank).transpose(1, 0, 2, 3).reshape(output_dims, rank)
    if layout in ("split_q", "split_k", "split_v"):
        selected = up.reshape(heads, head_dim, rank)
        zeros = mx.zeros_like(selected)
        parts = {
            "split_q": (selected, zeros, zeros),
            "split_k": (zeros, selected, zeros),
            "split_v": (zeros, zeros, selected),
        }[layout]
        return mx.stack(parts, axis=2).transpose(0, 2, 1, 3).reshape(output_dims, rank)
    raise ValueError(f"MiniMax H3 LoRA target {target!r} has unknown QKV layout {layout!r}.")


def _scalar(value: mx.array, target: str) -> float:
    if value.size != 1:
        raise ValueError(f"MiniMax H3 LoRA alpha for {target!r} must be scalar, got {value.shape}.")
    return float(value.item())


def _adapter_for(
    adapter_name: str,
    target: str,
    tensors: dict[str, Any],
    parent: nn.Module,
    module: nn.Module,
    external_scale: float,
    source_layout: str,
    declared_qkv_layout: str | None,
    metadata_alpha: float | None = None,
) -> _LoRAProjection:
    if "down" not in tensors or "up" not in tensors:
        raise ValueError(f"MiniMax H3 LoRA target {target!r} needs both down and up tensors.")
    output_dims, input_dims = _logical_shape(module)
    down = _prepare_down(tensors["down"], input_dims)
    rank = int(down.shape[0])
    if rank <= 0:
        raise ValueError(f"MiniMax H3 LoRA rank for {target!r} must be positive.")
    up = _prepare_up(
        target,
        parent,
        module,
        tensors["up"],
        output_dims,
        rank,
        source_layout,
        declared_qkv_layout,
        adapter_name,
    )
    if int(up.shape[1]) != rank:
        raise ValueError(f"MiniMax H3 LoRA up rank for {target!r} does not match down rank {rank}.")
    if "alpha" in tensors:
        alpha = _scalar(tensors["alpha"], target)
    elif metadata_alpha is not None:
        alpha = metadata_alpha
    elif source_layout.startswith("diffusers") or source_layout.startswith("split_"):
        # LightX2V's published H3 PEFT files use alpha=8 but omit an alpha
        # tensor; their `.default` suffix identifies that Diffusers format.
        alpha = _DIFFUSERS_H3_DEFAULT_ALPHA
    else:
        alpha = float(rank)
    scale = external_scale * alpha / rank
    if not math.isfinite(scale):
        raise ValueError(f"MiniMax H3 LoRA scale for {target!r} must be finite.")
    return _LoRAProjection(down, up, scale)


def _load_adapter(adapter_path: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    """Load an adapter's tensors plus its safetensors header metadata."""
    if adapter_path.suffix.lower() == ".safetensors":
        tensors, metadata = mx.load(str(adapter_path), return_metadata=True)
        return tensors, metadata or {}
    # Only safetensors carries a metadata header; other MLX-loadable formats
    # are unannotated and keep the documented defaults.
    return mx.load(str(adapter_path)), {}


def _plan_lora(
    transformer: nn.Module, path: str | Path, scale: float, *, alpha=None, dtype=None
) -> list[tuple[nn.Module, str, _LoRAProjection]]:
    """Load and fully validate one adapter without touching the transformer."""
    adapter_path = Path(path)
    if not adapter_path.is_file():
        raise ValueError(f"MiniMax H3 LoRA file does not exist: {adapter_path.name}")
    external_scale = float(scale)
    if not math.isfinite(external_scale):
        raise ValueError(f"MiniMax H3 LoRA scale must be finite: {scale!r}")

    tensors, metadata = _load_adapter(adapter_path)
    if alpha is not None:
        metadata = {**metadata, "alpha": str(alpha)}
    if dtype is not None:
        tensors = {key: value.astype(dtype) for key, value in tensors.items()}
    # Resolved per adapter file, so each adapter in a stack keeps its own row
    # order rather than sharing one global permutation.
    declared_qkv_layout = _declared_qkv_layout(metadata, adapter_path.name)
    metadata_alpha = None
    if "alpha" in metadata:
        try:
            metadata_alpha = float(metadata["alpha"])
        except (TypeError, ValueError) as error:
            raise ValueError("MiniMax H3 LoRA alpha metadata must be numeric.") from error
        if not math.isfinite(metadata_alpha) or metadata_alpha <= 0:
            raise ValueError("MiniMax H3 LoRA alpha metadata must be finite and positive.")
    groups: dict[tuple[str, str], dict[str, Any]] = {}
    unrecognized: list[str] = []
    for key, value in tensors.items():
        parsed = _parse_tensor_key(key)
        if parsed is None:
            unrecognized.append(key)
            continue
        target, kind, source_layout = parsed
        group = groups.setdefault((target, source_layout), {})
        if kind in group:
            raise ValueError(f"MiniMax H3 LoRA target {target!r} has duplicate {kind} tensors.")
        group[kind] = value
    if unrecognized:
        names = ", ".join(unrecognized[:3])
        suffix = "..." if len(unrecognized) > 3 else ""
        raise ValueError(f"MiniMax H3 LoRA has unsupported tensor keys: {names}{suffix}")
    if not groups:
        raise ValueError(f"MiniMax H3 LoRA contains no recognized adapter tensors: {adapter_path.name}")

    # Resolve and validate every target before replacing any module. A malformed
    # multi-target file therefore cannot leave a half-attached adapter behind.
    planned: list[tuple[nn.Module, str, _LoRAProjection]] = []
    for target, source_layout in sorted(groups):
        parent, leaf, module = _target_module(transformer, target)
        adapter = _adapter_for(
            adapter_path.name,
            target,
            groups[(target, source_layout)],
            parent,
            module,
            external_scale,
            source_layout,
            declared_qkv_layout,
            metadata_alpha,
        )
        planned.append((parent, leaf, adapter))
    return planned


def _attach(planned: list[tuple[nn.Module, str, _LoRAProjection]]) -> None:
    for parent, leaf, adapter in planned:
        current = parent[int(leaf)] if leaf.isdigit() else getattr(parent, leaf)
        if isinstance(current, LoRALinear):
            current.add_adapter(adapter)
        else:
            setattr(parent, leaf, LoRALinear(current, [adapter]))


def apply_lora(transformer: nn.Module, path: str | Path, scale: float = 1.0) -> None:
    """Load and attach one MiniMax H3 LoRA to a DiT in place."""
    _attach(_plan_lora(transformer, path, scale))


def apply_loras(transformer: nn.Module, loras: list[dict[str, Any]]) -> None:
    """Attach the ordered ``[{path, scale}]`` adapters used by the H3 runner.

    Every adapter in the stack is validated before any module is replaced, so a
    malformed later adapter cannot leave earlier ones half-applied.
    """
    planned: list[tuple[nn.Module, str, _LoRAProjection]] = []
    for spec in loras:
        if not isinstance(spec, dict) or not spec.get("path"):
            raise ValueError("Each MiniMax H3 LoRA must provide a path.")
        planned.extend(_plan_lora(transformer, spec["path"], spec.get("scale", 1.0), alpha=spec.get("alpha"), dtype=spec.get("dtype")))
    _attach(planned)
