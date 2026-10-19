#!/usr/bin/env python3
"""Apply LTX LoRA adapters at inference time without re-quantizing packed weights (#12262).

The pinned ltx-2-mlx / ltx-2.5-mlx runtimes fuse an adapter by dequantizing
each q4/q8 projection, adding ``strength * B @ A`` and quantizing again. A
rank-r delta is small next to the base weight, so the second quantization
rounds most of it away and an Ingredients / IC adapter on a low-bit pack can
render as the plain base model. This module keeps each quantized projection
exactly as loaded and adds the delta in activation space instead:

    quantized_linear(x) + (x @ A.T) @ (strength * B).T

Float (unquantized) projections keep fusion: adding the delta to a float
weight retains it, and that is the runtime's own high-precision path.

Why a class swap instead of a wrapper module (the MiniMax H3 precedent in
``minimax_h3_lora.py``): the LTX pipelines flatten ``dit.parameters()`` AFTER
loading — the two-stage pipelines fuse their distilled LoRA that way, and block
streaming rebinds weights with ``load_weights(strict=True)``. A wrapper moves
``to_q.weight`` to ``to_q.base.weight``, which those paths would then silently
miss. Swapping the instance to a cached subclass whose ``__call__`` adds the
delta, with the adapter arrays held outside the parameter tree, keeps every
parameter name and every packed array untouched.

The math contract mirrors the runtime's ``apply_loras`` exactly — the same
renamed keys, ``delta = strength * B @ A`` and no alpha rescale — so a q4 render
and a bf16 render at one strength mean the same thing. Validation is stricter:
``apply_loras`` silently skips a key it cannot place, and that silent no-op is
the failure this module exists to remove, so an unplaceable tensor is refused.

MLX is imported lazily, so the module (and the runners that import it) stay
importable by a stdlib-only interpreter.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any, Callable, Iterable

STRATEGY_RUNTIME = "runtime-delta"
STRATEGY_FUSED = "fused-float"
STRATEGY_MIXED = "runtime-delta+fused-float"
# Block streaming rebinds one shared, compiled block per index, so an
# activation-space delta has nowhere stable to live; those renders keep the
# runtime's own per-block merge-and-requantize and say so.
STRATEGY_REQUANTIZED = "merged-requantized"

_A_SUFFIX = ".lora_A.weight"
_B_SUFFIX = ".lora_B.weight"
# The runtime's apply_loras never reads alpha; ignoring it here keeps strength
# semantics identical across the quantized and float paths.
_IGNORED_SUFFIXES = (".alpha",)

_ADAPTERS_ATTR = "_portos_runtime_lora"
_BASE_CLASS_ATTR = "_portos_runtime_lora_base"
_RUNTIME_CLASSES: dict[type, type] = {}


def _mlx():
    import mlx.core as mx
    import mlx.nn as nn

    return mx, nn


def _runtime_class(base_cls: type) -> type:
    cls = _RUNTIME_CLASSES.get(base_cls)
    if cls is not None:
        return cls

    def __call__(self, x):
        output = base_cls.__call__(self, x)
        for down, up in self.__dict__[_ADAPTERS_ATTR]:
            output = output + ((x.astype(down.dtype) @ down.T) @ up.T).astype(output.dtype)
        return output

    cls = type(f"RuntimeLora{base_cls.__name__}", (base_cls,), {
        "__call__": __call__,
        _BASE_CLASS_ATTR: base_cls,
    })
    _RUNTIME_CLASSES[base_cls] = cls
    return cls


def _module_at(model, target: str):
    node: Any = model
    for part in target.split("."):
        if not part:
            return None
        try:
            node = node[int(part)] if part.isdigit() else getattr(node, part)
        except (AttributeError, IndexError, KeyError, TypeError):
            return None
    return node


def _logical_shape(module, quantized: bool) -> tuple[int, int]:
    output_dims, stored_input_dims = (int(v) for v in module.weight.shape)
    if not quantized:
        return output_dims, stored_input_dims
    bits = int(getattr(module, "bits", 0) or 0)
    if bits <= 0 or 32 % bits:
        raise ValueError(f"{type(module).__name__} reports unusable quantization bits {bits!r}")
    return output_dims, stored_input_dims * 32 // bits


def _group_tensors(label: str, tensors: dict) -> dict[str, dict[str, Any]]:
    groups: dict[str, dict[str, Any]] = {}
    unsupported: list[str] = []
    for key, value in tensors.items():
        if key.endswith(_A_SUFFIX):
            groups.setdefault(key[: -len(_A_SUFFIX)], {})["A"] = value
        elif key.endswith(_B_SUFFIX):
            groups.setdefault(key[: -len(_B_SUFFIX)], {})["B"] = value
        elif not key.endswith(_IGNORED_SUFFIXES):
            unsupported.append(key)
    if unsupported:
        shown = ", ".join(sorted(unsupported)[:3])
        more = f" (+{len(unsupported) - 3} more)" if len(unsupported) > 3 else ""
        raise ValueError(
            f"LoRA {label} carries tensors the LTX adapter contract cannot apply: {shown}{more}"
        )
    if not groups:
        raise ValueError(f"LoRA {label} contains no lora_A/lora_B adapter tensors")
    return groups


def _plan(model, label: str, tensors: dict, strength: float) -> list[tuple]:
    """Validate one adapter against the loaded model; mutate nothing."""
    _mx_core, nn = _mlx()
    if not math.isfinite(float(strength)):
        raise ValueError(f"LoRA {label} strength must be finite, got {strength!r}")
    planned = []
    for target, pair in sorted(_group_tensors(label, tensors).items()):
        if "A" not in pair or "B" not in pair:
            missing = "lora_B" if "A" in pair else "lora_A"
            raise ValueError(f"LoRA {label} target {target} has no {missing} tensor")
        module = _module_at(model, target)
        if module is None:
            raise ValueError(
                f"LoRA {label} targets {target}, which this transformer does not have — "
                "the adapter was trained for a different model"
            )
        if isinstance(module, nn.QuantizedLinear):
            quantized = True
        elif isinstance(module, nn.Linear):
            quantized = False
        else:
            raise ValueError(
                f"LoRA {label} target {target} is a {type(module).__name__}, not a linear projection"
            )
        down, up = pair["A"], pair["B"]
        if down.ndim != 2 or up.ndim != 2:
            raise ValueError(f"LoRA {label} target {target} tensors must be rank 2")
        output_dims, input_dims = _logical_shape(module, quantized)
        rank = int(down.shape[0])
        if rank <= 0 or tuple(down.shape) != (rank, input_dims) or tuple(up.shape) != (output_dims, rank):
            raise ValueError(
                f"LoRA {label} target {target} has lora_A {tuple(down.shape)} / lora_B "
                f"{tuple(up.shape)}, which do not fit a ({output_dims}, {input_dims}) projection"
            )
        planned.append((target, module, quantized, down, up, float(strength)))
    return planned


def _apply(module, quantized: bool, down, up, strength: float) -> None:
    mx, _nn = _mlx()
    if quantized:
        # The quantized kernel's scales carry the activation dtype the base
        # projection computes in; hold the delta in it so nothing promotes.
        dtype = module.scales.dtype
        entry = (down.astype(dtype), (up.astype(mx.float32) * strength).astype(dtype))
        if _ADAPTERS_ATTR not in module.__dict__:
            module.__class__ = _runtime_class(type(module))
            object.__setattr__(module, _ADAPTERS_ATTR, [])
        module.__dict__[_ADAPTERS_ATTR].append(entry)
        return
    delta = (up.astype(mx.float32) * strength) @ down.astype(mx.float32)
    module.weight = (module.weight.astype(mx.float32) + delta).astype(module.weight.dtype)


def attach_adapters(model, adapters: Iterable[tuple[str, dict, float]]) -> list[dict]:
    """Attach ``(label, renamed_tensors, strength)`` adapters to ``model`` in place.

    Every adapter is validated before any module changes, so a malformed file
    later in the list cannot leave an earlier one half-applied. Returns one
    summary per adapter with the strategy its targets actually received.
    """
    plans = [(label, strength, _plan(model, label, tensors, strength)) for label, tensors, strength in adapters]
    summaries = []
    for label, strength, planned in plans:
        quantized_targets = 0
        for _target, module, quantized, down, up, scale in planned:
            _apply(module, quantized, down, up, scale)
            quantized_targets += int(quantized)
        fused_targets = len(planned) - quantized_targets
        strategy = (STRATEGY_MIXED if quantized_targets and fused_targets
                    else STRATEGY_RUNTIME if quantized_targets else STRATEGY_FUSED)
        summaries.append({
            "name": Path(label).name,
            "strength": float(strength),
            "strategy": strategy,
            "quantizedTargets": quantized_targets,
            "fusedTargets": fused_targets,
        })
    return summaries


def runtime_adapter_targets(model) -> list[str]:
    """Names of the projections currently carrying an activation-space delta."""
    return [name for name, module in model.named_modules() if _ADAPTERS_ATTR in module.__dict__]


def detach_runtime_adapters(model) -> int:
    """Restore every swapped projection to its original class. Returns the count."""
    count = 0
    for _name, module in model.named_modules():
        if _ADAPTERS_ATTR in module.__dict__:
            module.__class__ = getattr(type(module), _BASE_CLASS_ATTR)
            del module.__dict__[_ADAPTERS_ATTR]
            count += 1
    return count


def load_ltx_adapter(path: str) -> dict:
    """Read an adapter with the runtime's own key renaming, so targets match the DiT."""
    from ltx_core_mlx.loader import LTXV_LORA_COMFY_RENAMING_MAP, SafetensorsStateDictLoader

    return SafetensorsStateDictLoader().load(path, sd_ops=LTXV_LORA_COMFY_RENAMING_MAP).sd


class AdapterReport:
    """What each adapter actually received, for the render record (LORASTRATEGY:)."""

    def __init__(self):
        self.entries: list[dict] = []
        # Identity is the full source path + strength, never the basename: two
        # files sharing a name, or one file at two strengths, are distinct
        # applications. The path stays out of the emitted record (history is
        # user-facing and machine paths are private).
        self._index: dict[tuple, dict] = {}

    def record(self, role: str, stage: str, source: str, summary: dict) -> bool:
        """Returns True the first time this application is recorded."""
        key = (role, str(source), summary["strength"])
        entry = self._index.get(key)
        if entry is not None:
            if stage not in entry["stages"]:
                entry["stages"].append(stage)
            return False
        entry = {"role": role, "stages": [stage], **summary}
        self._index[key] = entry
        self.entries.append(entry)
        return True

    def emit(self, stream=None) -> None:
        if not self.entries:
            return
        print(f"LORASTRATEGY:{json.dumps({'adapters': self.entries})}", file=stream or sys.stderr, flush=True)


def install_pipeline_adapters(
    pipe,
    user_specs: list[tuple[str, float]],
    *,
    report: AdapterReport,
    status: Callable[[str], None],
    ic: bool = False,
    load_adapter: Callable[[str], dict] = load_ltx_adapter,
) -> None:
    """Route a pipeline's adapters through inference-time application.

    User adapters attach on EVERY transformer load (the runtime's
    ``_pending_loras`` contract), so a stage that reloads keeps them. With
    ``ic=True`` the pipeline's ``_fuse_loras`` — called once, right before
    stage 1 — attaches the IC adapter(s) to the loaded DiT instead; the clean
    stage-2 reload goes back through the load hook and so carries the user
    adapters but never the IC one.

    Paths must already be local files: `parse_user_loras` requires that, and
    the IC constructor resolves its repo ids before this runs.
    """
    if getattr(pipe, "low_ram_streaming", False):
        if user_specs:
            pipe._pending_loras = list(user_specs)
        merged = [("user", "all", spec) for spec in user_specs]
        if ic:
            merged += [("ic", "stage-1", spec) for spec in getattr(pipe, "_lora_paths", [])]
        for role, stage, (path, strength) in merged:
            report.record(role, stage, path, _requantized_summary(path, strength))
        if merged:
            names = ", ".join(Path(path).name for _role, _stage, (path, _s) in merged)
            status(
                "Block streaming merges LoRA deltas into the quantized weights per block; a low-bit "
                f"pack can lose part of their effect ({names})"
            )
        return

    pipe._pending_loras = None
    load_transformer = pipe._load_transformer_with_optional_streaming

    def attach(dit, role: str, stage: str, specs) -> None:
        loaded = [(path, load_adapter(path), strength) for path, strength in specs]
        for (path, _tensors, _strength), summary in zip(loaded, attach_adapters(dit, loaded)):
            if report.record(role, stage, path, summary):
                status(
                    f"{role} LoRA {summary['name']}: {summary['strategy']} "
                    f"({summary['quantizedTargets']} quantized, {summary['fusedTargets']} float projection(s))"
                )

    def load_with_user_adapters(transformer_path):
        dit = load_transformer(transformer_path)
        if user_specs:
            attach(dit, "user", "all", user_specs)
        return dit

    pipe._load_transformer_with_optional_streaming = load_with_user_adapters

    if ic:
        def attach_ic_adapters() -> None:
            effective = getattr(pipe, "_effective_lora_paths", None)
            specs = effective() if callable(effective) else list(pipe._lora_paths)
            if specs:
                attach(pipe.dit, "ic", "stage-1", specs)

        pipe._fuse_loras = attach_ic_adapters


def release_pipeline_adapters(pipe) -> None:
    """Drop the transformer and every adapter this module attached to it.

    Called when a render ends either way: the DiT is the one large object the
    adapters hang off, and a failed or cancelled render must not keep it (or a
    swapped class pointing at it) alive.
    """
    dit = getattr(pipe, "dit", None)
    if dit is not None:
        detach_runtime_adapters(dit)
        pipe.dit = None
    if hasattr(pipe, "_loaded"):
        pipe._loaded = False


def _requantized_summary(path: str, strength: float) -> dict:
    return {
        "name": Path(path).name,
        "strength": float(strength),
        "strategy": STRATEGY_REQUANTIZED,
        "quantizedTargets": None,
        "fusedTargets": None,
    }
