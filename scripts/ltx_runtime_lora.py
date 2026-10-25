#!/usr/bin/env python3
"""Apply LTX LoRA adapters at inference time without re-quantizing packed weights (#12262).

The pinned ltx-2-mlx / ltx-2.5-mlx runtimes fuse an adapter by dequantizing
each q4/q8 projection, adding ``strength * B @ A`` and quantizing again. A
rank-r delta is small next to the base weight, so the second quantization
rounds most of it away and an Ingredients / IC adapter on a low-bit pack can
render as the plain base model. This module keeps each quantized projection
exactly as loaded and adds the delta in activation space instead:

    quantized_linear(x) + (x @ A.T) @ (strength * B).T

Float (unquantized) projections keep fusion on the legacy path. An explicit
A2V stage schedule instead uses reversible activation-space deltas for every
user target, so changing stages never subtracts/re-fuses a float or packed base.

Why a class swap instead of a wrapper module (the MiniMax H3 precedent in
``minimax_h3_lora.py``): the LTX pipelines flatten ``dit.parameters()`` AFTER
loading — the two-stage pipelines fuse their distilled LoRA that way, and block
streaming rebinds weights with ``load_weights(strict=True)``. A wrapper moves
``to_q.weight`` to ``to_q.base.weight``, which those paths would then silently
miss. Swapping the instance to a cached subclass whose ``__call__`` adds the
delta, with the adapter arrays held outside the parameter tree, keeps every
parameter name and every packed array untouched.

Block streaming (#12327) rebinds ONE shared block per index from the mmap'd
pack and runs it through ``mx.compile(shared, inputs=shared)``, so a delta held
outside that block's parameter tree would be traced as a constant and applied
to every index. Under streaming the model's class is swapped too: its block
provider binds the packed weights exactly as the runtime does (runtime-owned
``_lora_sources`` such as a custom-strength distilled LoRA still merge there),
then points each quantized projection's adapter slots at block ``idx``'s
arrays and fuses float targets into the freshly bound float weight. The block
is recompiled with those slots as declared inputs, so every index sees only
its own delta and the compiled graph stays valid.

The math contract mirrors the runtime's ``apply_loras`` exactly — the same
renamed keys, ``delta = strength * B @ A`` and no alpha rescale — so a q4 render
and a bf16 render at one strength mean the same thing. Validation is stricter:
``apply_loras`` silently skips a key it cannot place, and that silent no-op is
the failure this module exists to remove, so an unplaceable tensor is refused.

MLX is imported lazily, so the module (and the runners that import it) stay
importable by a stdlib-only interpreter.
"""

from __future__ import annotations

import ast
import inspect
import json
import math
import sys
import textwrap
from pathlib import Path
from typing import Any, Callable, Iterable

STRATEGY_RUNTIME = "runtime-delta"
STRATEGY_FUSED = "fused-float"
STRATEGY_MIXED = "runtime-delta+fused-float"

_A_SUFFIX = ".lora_A.weight"
_B_SUFFIX = ".lora_B.weight"
# The runtime's apply_loras never reads alpha; ignoring it here keeps strength
# semantics identical across the quantized and float paths.
_IGNORED_SUFFIXES = (".alpha",)

_ADAPTERS_ATTR = "_portos_runtime_lora"
_STAGED_ATTR = "_portos_staged_lora"
_BASE_CLASS_ATTR = "_portos_runtime_lora_base"
_RUNTIME_CLASSES: dict[type, type] = {}

_STREAMING_ATTR = "_portos_streaming_lora"
_STREAMING_BASE_ATTR = "_portos_streaming_lora_base"
_STREAMING_CLASSES: dict[type, type] = {}
# The runtime's renamed adapter keys address blocks under this prefix
# (ltx_core_mlx.loader.sd_ops.LTXV_LORA_BLOCK_PREFIX).
_BLOCK_PREFIX = "transformer_blocks."
# A float projection outside the streamed blocks is fused once; its pre-fusion
# weight is kept so dropping one adapter can re-fuse the rest.
_FUSED_BASE_ATTR = "_portos_fused_base"


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


def is_streaming_model(model) -> bool:
    """True for the runtime's StreamingLTXModel: one shared block rebound per index."""
    attrs = getattr(model, "__dict__", {})
    return "_streamer" in attrs and "_shared_block" in attrs


def _locate(model, target: str):
    """``(module, block)`` for a renamed target; ``block`` is ``(index, path)`` when streamed."""
    if not is_streaming_model(model):
        return _module_at(model, target), None
    attrs = model.__dict__
    if target.startswith(_BLOCK_PREFIX):
        index, _, path = target[len(_BLOCK_PREFIX):].partition(".")
        if index.isdigit() and path:
            if int(index) >= attrs["_streamer"].block_count:
                return None, None
            return _module_at(attrs["_shared_block"], path), (int(index), path)
    return _module_at(model.inner, target), None


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
        module, block = _locate(model, target)
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
        planned.append((target, module, quantized, down, up, float(strength), block))
    return planned


def _runtime_pair(down, up, strength: float, dtype, multiplier: float = 1.0) -> tuple:
    """``(A, strength * B)`` in the quantized kernel's activation dtype."""
    mx, _nn = _mlx()
    return down.astype(dtype), (up.astype(mx.float32) * (strength * multiplier)).astype(dtype)


def _fused_weight(weight, pairs) -> Any:
    """``weight + sum(strength * B @ A)``, accumulated in float32."""
    mx, _nn = _mlx()
    fused = weight.astype(mx.float32)
    for down, up, strength in pairs:
        fused = fused + (up.astype(mx.float32) * strength) @ down.astype(mx.float32)
    return fused.astype(weight.dtype)


def _apply(module, quantized: bool, down, up, strength: float, stage_policy=None) -> None:
    if quantized or stage_policy is not None:
        # The quantized kernel's scales carry the activation dtype the base
        # projection computes in; hold the delta in it so nothing promotes.
        dtype = module.scales.dtype if quantized else module.weight.dtype
        entry = list(_runtime_pair(down, up, strength, dtype,
                                  stage_policy["multiplier"] if stage_policy else 1.0))
        if _ADAPTERS_ATTR not in module.__dict__:
            module.__class__ = _runtime_class(type(module))
            object.__setattr__(module, _ADAPTERS_ATTR, [])
        module.__dict__[_ADAPTERS_ATTR].append(entry)
        if stage_policy is not None:
            module.__dict__.setdefault(_STAGED_ATTR, []).append((entry, down, up, strength, dtype))
        return
    module.weight = _fused_weight(module.weight, [(down, up, strength)])


def attach_adapters(model, adapters: Iterable[tuple[str, dict, float]], *, tag: str | None = None, stage_policy=None) -> list[dict]:
    """Attach ``(label, renamed_tensors, strength)`` adapters to ``model`` in place.

    Every adapter is validated before any module changes, so a malformed file
    later in the list cannot leave an earlier one half-applied. Returns one
    summary per adapter with the strategy its targets actually received.
    ``tag`` lets ``drop_streaming_adapters`` remove these later from a streamed
    model, which the runtime never reloads between stages.
    """
    plans = [(label, strength, _plan(model, label, tensors, strength)) for label, tensors, strength in adapters]
    streaming = is_streaming_model(model)
    summaries = []
    for label, strength, planned in plans:
        if streaming:
            _attach_streaming(model, planned, tag, stage_policy)
        else:
            for _target, module, quantized, down, up, scale, _block in planned:
                _apply(module, quantized, down, up, scale, stage_policy)
        quantized_targets = sum(int(quantized) for _t, _m, quantized, *_rest in planned)
        fused_targets = 0 if stage_policy is not None else len(planned) - quantized_targets
        strategy = (STRATEGY_MIXED if quantized_targets and fused_targets
                    else STRATEGY_RUNTIME if quantized_targets or stage_policy is not None else STRATEGY_FUSED)
        summaries.append({
            "name": Path(label).name,
            "strength": float(strength) * (stage_policy["multiplier"] if stage_policy else 1.0),
            "strategy": strategy,
            "quantizedTargets": quantized_targets,
            "fusedTargets": fused_targets,
            **({"runtimeTargets": len(planned)} if stage_policy is not None else {}),
        })
    return summaries


def _streaming_class(base_cls: type) -> type:
    cls = _STREAMING_CLASSES.get(base_cls)
    if cls is not None:
        return cls

    def __call__(self, *args, **kwargs):
        if kwargs.get("block_provider") is None:
            kwargs["block_provider"] = _block_provider(self, use_compiled=kwargs.get("perturbations") is None)
        return base_cls.__call__(self, *args, **kwargs)

    cls = type(f"RuntimeLora{base_cls.__name__}", (base_cls,), {
        "__call__": __call__,
        _STREAMING_BASE_ATTR: base_cls,
    })
    _STREAMING_CLASSES[base_cls] = cls
    return cls


def _block_provider(model, *, use_compiled: bool):
    """The runtime's per-forward block provider, plus the per-index adapter bind.

    Mirrors ``StreamingLTXModel.__call__`` at the pinned runtimes. ``_streamer``
    and ``_lora_sources`` are read per forward because the two-stage pipelines
    swap the streamer and append a distilled-LoRA source between stages; those
    runtime-owned sources still merge inside ``bind``. Guidance perturbations
    cannot be traced by mx.compile, so they run the eager block, as upstream.
    """
    attrs = model.__dict__
    streamer, shared, state = attrs["_streamer"], attrs["_shared_block"], attrs[_STREAMING_ATTR]
    runtime_sources = attrs.get("_lora_sources") or None
    block = state["compiled"] if use_compiled else shared
    previous: list[int | None] = [None]

    def provider(index: int):
        streamer.bind(shared, index, evict_previous=previous[0], lora_sources=runtime_sources)
        previous[0] = index
        _bind_streamed_block(state, shared, index)
        return block

    return provider


def _bind_streamed_block(state: dict, shared, index: int) -> None:
    """Point the shared block's adapters at block ``index`` right after its weights bind.

    The casts are built here, per bind, so only the bound block's copies are
    ever alive; a source tensor is whatever the adapter loader returned.
    """
    for path, slots in state["slots"].items():
        for slot, source in zip(slots, state["slot_sources"][path]):
            pair = source["blocks"].get(index)
            slot[0], slot[1] = (source["zero"] if pair is None
                                else _runtime_pair(*pair, source["strength"], source["dtype"],
                                                   source["policy"]["multiplier"] if source.get("policy") else 1.0))
    for path, sources in state["fused"].items():
        pairs = [(*source["blocks"][index], source["strength"]) for source in sources if index in source["blocks"]]
        if pairs:
            module = _module_at(shared, path)
            module.weight = _fused_weight(module.weight, pairs)


def _streaming_state(model) -> dict:
    state = model.__dict__.get(_STREAMING_ATTR)
    if state is None:
        # slots: path -> [[down, up], ...], the SAME lists the quantized
        # projection iterates, declared as compile inputs. fused: float block
        # projections, fused into each freshly bound weight. outside: targets
        # beyond the streamed blocks, which stay resident.
        state = {"slots": {}, "slot_sources": {}, "fused": {}, "outside": [], "compiled": None}
        model.__class__ = _streaming_class(type(model))
        object.__setattr__(model, _STREAMING_ATTR, state)
    return state


def _recompile(model) -> None:
    """Compile the shared block with its adapter slots as declared inputs.

    A fresh compiled function per slot layout: mx.compile retraces when input
    shapes change, but a layout change with equal shapes would reuse a trace
    that reads the wrong slots.
    """
    mx, _nn = _mlx()
    state = model.__dict__[_STREAMING_ATTR]
    shared = model.__dict__["_shared_block"]
    state["compiled"] = mx.compile(shared, inputs=[shared, state["slots"]])


def _attach_streaming(model, planned: list[tuple], tag: str | None, stage_policy=None) -> None:
    mx, _nn = _mlx()
    state = _streaming_state(model)
    sources: dict[str, dict] = {}
    for _target, module, quantized, down, up, strength, block in planned:
        if block is None:
            state["outside"].append(_attach_outside_blocks(module, quantized, down, up, strength, tag, stage_policy))
            continue
        index, path = block
        source = sources.get(path)
        if source is None:
            source = sources[path] = {"tag": tag, "strength": strength, "blocks": {}, "policy": stage_policy}
            if quantized or stage_policy is not None:
                dtype = module.scales.dtype if quantized else module.weight.dtype
                source["dtype"] = dtype
                # A block this adapter does not address keeps the slot layout
                # (and so the compiled trace) and adds nothing.
                source["zero"] = (mx.zeros(down.shape, dtype=dtype), mx.zeros(up.shape, dtype=dtype))
                slots = state["slots"].get(path)
                if slots is None:
                    slots = state["slots"][path] = []
                    state["slot_sources"][path] = []
                    module.__class__ = _runtime_class(type(module))
                    object.__setattr__(module, _ADAPTERS_ATTR, slots)
                slots.append(list(source["zero"]))
                state["slot_sources"][path].append(source)
            else:
                state["fused"].setdefault(path, []).append(source)
        source["blocks"][index] = (down, up)
    _recompile(model)


def _attach_outside_blocks(module, quantized: bool, down, up, strength: float, tag: str | None, stage_policy=None) -> dict:
    """Apply a non-block target as ``_apply`` does, recording what a drop must undo."""
    runtime_delta = quantized or stage_policy is not None
    if not runtime_delta:
        module.__dict__.setdefault(_FUSED_BASE_ATTR, module.weight)
    _apply(module, quantized, down, up, strength, stage_policy)
    record = {"module": module, "quantized": runtime_delta, "tag": tag, "delta": (down, up, strength)}
    if runtime_delta:
        record["entry"] = module.__dict__[_ADAPTERS_ATTR][-1]
    return record


def drop_streaming_adapters(model, tag: str | None = None) -> int:
    """Remove adapters attached with ``tag`` (every one when None) from a streamed model.

    Under streaming the runtime's clean stage-2 refine keeps the same model and
    only clears its own ``_lora_sources``, so an IC adapter is dropped here or
    it would condition the refine. Returns the number of projections restored.
    """
    state = model.__dict__.get(_STREAMING_ATTR)
    if state is None:
        return 0
    shared = model.__dict__["_shared_block"]

    def dropped(item: dict) -> bool:
        return tag is None or item["tag"] == tag

    restored = 0
    for path in list(state["slots"]):
        keep = [i for i, source in enumerate(state["slot_sources"][path]) if not dropped(source)]
        slots = state["slots"][path]
        slots[:] = [slots[i] for i in keep]
        state["slot_sources"][path] = [state["slot_sources"][path][i] for i in keep]
        if not slots:
            _restore_class(_module_at(shared, path))
            del state["slots"][path], state["slot_sources"][path]
            restored += 1
    for path in list(state["fused"]):
        state["fused"][path] = [source for source in state["fused"][path] if not dropped(source)]
        if not state["fused"][path]:
            del state["fused"][path]

    removed = [record for record in state["outside"] if dropped(record)]
    state["outside"] = [record for record in state["outside"] if not dropped(record)]
    refuse: dict[int, Any] = {}
    for record in removed:
        module = record["module"]
        if not record["quantized"]:
            refuse[id(module)] = module
            continue
        entries = module.__dict__[_ADAPTERS_ATTR]
        entries[:] = [entry for entry in entries if entry is not record["entry"]]
        if not entries:
            _restore_class(module)
            restored += 1
    for module in refuse.values():
        remaining = [record["delta"] for record in state["outside"] if record["module"] is module]
        module.weight = _fused_weight(module.__dict__[_FUSED_BASE_ATTR], remaining)
        if not remaining:
            del module.__dict__[_FUSED_BASE_ATTR]
            restored += 1

    if tag is None:
        model.__class__ = getattr(type(model), _STREAMING_BASE_ATTR)
        del model.__dict__[_STREAMING_ATTR]
    else:
        _recompile(model)
    return restored


def _restore_class(module) -> None:
    module.__class__ = getattr(type(module), _BASE_CLASS_ATTR)
    del module.__dict__[_ADAPTERS_ATTR]
    module.__dict__.pop(_STAGED_ATTR, None)


def runtime_adapter_targets(model) -> list[str]:
    """Names of the projections currently carrying an activation-space delta."""
    return [name for name, module in model.named_modules() if _ADAPTERS_ATTR in module.__dict__]


def detach_runtime_adapters(model) -> int:
    """Restore every swapped projection to its original class. Returns the count."""
    count = drop_streaming_adapters(model)
    for _name, module in model.named_modules():
        if _ADAPTERS_ATTR in module.__dict__:
            _restore_class(module)
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
        key = (role, str(source), summary["strength"], summary.get("selectedStrength"), summary.get("multiplier"))
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


def validate_stage_strengths(value) -> tuple[float, float]:
    if value is None:
        return (1.0, 1.0)
    if (not isinstance(value, (list, tuple)) or len(value) != 2
            or any(isinstance(v, bool) or not isinstance(v, (int, float))
                   or not math.isfinite(v) or not 0 <= v <= 1 for v in value)):
        raise ValueError("A2V LoRA stage strengths must be two finite multipliers in [0, 1]")
    return tuple(float(v) for v in value)


def validate_a2v_stage_seams(pipeline_class) -> None:
    """Validate the inspected motion → distilled-refine seam without loading weights."""
    for name in ("_denoise_stage1", "_fuse_distilled_lora", "_load_transformer_with_optional_streaming"):
        if not callable(getattr(pipeline_class, name, None)):
            raise ValueError(f"A2V stage LoRAs unsupported: missing {name}")
    if list(inspect.signature(pipeline_class._fuse_distilled_lora).parameters) != ["self", "dit"]:
        raise ValueError("A2V stage LoRAs unsupported: distilled-refine signature changed")
    generate = getattr(pipeline_class, "generate_and_save", None)
    if generate is None:
        raise ValueError("A2V stage LoRAs unsupported: no inspected generate boundary")
    tree = ast.parse(textwrap.dedent(inspect.getsource(generate)))
    calls = sorted((node.lineno, node.func.attr) for node in ast.walk(tree)
                   if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                   and isinstance(node.func.value, ast.Name) and node.func.value.id == "self"
                   and node.func.attr in ("_denoise_stage1", "_fuse_distilled_lora"))
    if [name for _line, name in calls] != ["_denoise_stage1", "_fuse_distilled_lora"]:
        raise ValueError("A2V stage LoRAs unsupported: motion/refine order changed")


def install_pipeline_adapters(
    pipe,
    user_specs: list[tuple[str, float]],
    *,
    report: AdapterReport,
    status: Callable[[str], None],
    ic: bool = False,
    load_adapter: Callable[[str], dict] = load_ltx_adapter,
    user_stage_strengths=None,
) -> Callable[[], None]:
    """Route a pipeline's adapters through inference-time application.

    User adapters attach on EVERY transformer load (the runtime's
    ``_pending_loras`` contract), so a stage that reloads keeps them. With
    ``ic=True`` the pipeline's ``_fuse_loras`` — called once, right before
    stage 1 — attaches the IC adapter(s) to the loaded DiT instead; the clean
    stage-2 reload goes back through the load hook and so carries the user
    adapters but never the IC one. Block streaming takes the same route: the
    load hook returns a StreamingLTXModel and ``attach_adapters`` binds each
    block's delta per index (#12327); its clean refine keeps the model, so the
    reload wrapper drops the IC adapters from it instead.

    Paths must already be local files: `parse_user_loras` requires that, and
    the IC constructor resolves its repo ids before this runs.
    """
    strengths = validate_stage_strengths(user_stage_strengths)
    policy = None if strengths == (1.0, 1.0) else {
        "stage": "stage-1", "multiplier": strengths[0],
    }
    if policy is not None:
        validate_a2v_stage_seams(type(pipe))
    names = ("_pending_loras", "_load_transformer_with_optional_streaming", "_denoise_stage1", "_fuse_distilled_lora",
             "_fuse_loras", "_reload_clean_transformer")
    original = {name: pipe.__dict__[name] for name in names if name in pipe.__dict__}
    pipe._pending_loras = None
    load_transformer = pipe._load_transformer_with_optional_streaming

    applications = {}

    def attach(dit, role: str, stage: str, specs) -> None:
        loaded = [(path, load_adapter(path), strength) for path, strength in specs]
        for (path, _tensors, _strength), summary in zip(loaded, attach_adapters(dit, loaded, tag=role, stage_policy=policy if role == "user" else None)):
            if role == "user" and policy is not None:
                summary["selectedStrength"] = _strength
                summary["multiplier"] = policy["multiplier"]
                applications[(path, _strength)] = dict(summary)
            if report.record(role, stage, path, summary):
                counts = (f"{summary['runtimeTargets']} runtime projections" if "runtimeTargets" in summary
                          else f"{summary['quantizedTargets']} quantized, {summary['fusedTargets']} float projection(s)")
                status(
                    f"{role} LoRA {summary['name']}: {summary['strategy']} "
                    f"({counts})"
                )

    def load_with_user_adapters(transformer_path):
        dit = load_transformer(transformer_path)
        if user_specs:
            attach(dit, "user", policy["stage"] if policy else "all", user_specs)
        return dit

    pipe._load_transformer_with_optional_streaming = load_with_user_adapters

    def set_stage(index):
        policy["stage"] = f"stage-{index + 1}"
        policy["multiplier"] = strengths[index]
        dit = getattr(pipe, "dit", None)
        if dit is not None:
            for _name, module in dit.named_modules():
                for entry, down, up, strength, dtype in module.__dict__.get(_STAGED_ATTR, []):
                    entry[:] = _runtime_pair(down, up, strength, dtype, policy["multiplier"])
        # Reuse the application summaries; reporting never retains tensors/models.
        for (path, _strength), application in applications.items():
            summary = {**application, "strength": application["selectedStrength"] * policy["multiplier"],
                       "multiplier": policy["multiplier"]}
            report.record("user", policy["stage"], path, summary)

    if policy is not None:
        denoise_stage1, fuse_distilled = pipe._denoise_stage1, pipe._fuse_distilled_lora

        def stage1(*args, **kwargs):
            set_stage(0)
            return denoise_stage1(*args, **kwargs)

        def stage2(*args, **kwargs):
            result = fuse_distilled(*args, **kwargs)
            set_stage(1)
            return result

        pipe._denoise_stage1, pipe._fuse_distilled_lora = stage1, stage2

    def restore():
        for name in names:
            if name in original:
                setattr(pipe, name, original[name])
            else:
                pipe.__dict__.pop(name, None)

    if ic:
        def attach_ic_adapters() -> None:
            effective = getattr(pipe, "_effective_lora_paths", None)
            specs = effective() if callable(effective) else list(pipe._lora_paths)
            if specs:
                attach(pipe.dit, "ic", "stage-1", specs)

        pipe._fuse_loras = attach_ic_adapters

        reload_clean = getattr(pipe, "_reload_clean_transformer", None)
        if callable(reload_clean):
            def reload_clean_without_ic() -> None:
                reload_clean()
                if pipe.dit is not None and is_streaming_model(pipe.dit):
                    drop_streaming_adapters(pipe.dit, "ic")

            pipe._reload_clean_transformer = reload_clean_without_ic

    return restore


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
