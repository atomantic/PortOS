"""Reference-sheet conditioning for the pinned LTX 2.5 MLX guided pipeline.

The runtime's IC pipeline uses its distilled transformer and schedule; the 2.5
Ingredients adapter is trained on the dev model. Reuse the guided two-stage
pipeline instead, appending the sheet's VAE latents to stage 1 and applying the
adapter only there. The opening image remains a separate frame-zero anchor.
"""

from __future__ import annotations

import ast
import inspect
import textwrap
from contextlib import contextmanager


def _check_pipeline_seams(pipeline_class, module) -> None:
    """Fail before loading weights when the pinned runtime's stage order changes."""
    generate = getattr(pipeline_class, "generate_two_stage", None)
    if not callable(generate) or not callable(getattr(module, "create_noised_state", None)):
        raise ValueError("LTX 2.5 reference conditioning needs the inspected two-stage runtime")
    try:
        tree = ast.parse(textwrap.dedent(inspect.getsource(generate)))
    except (OSError, TypeError, SyntaxError) as error:
        raise ValueError("Cannot verify the LTX 2.5 reference pipeline stage order") from error
    calls = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if isinstance(node.func, ast.Name) and node.func.id == "create_noised_state":
            calls.append((node.lineno, "state"))
        elif (isinstance(node.func, ast.Attribute) and node.func.attr == "_fuse_distilled_lora"
              and isinstance(node.func.value, ast.Name) and node.func.value.id == "self"):
            calls.append((node.lineno, "refine"))
    if [name for _, name in sorted(calls)] != ["state", "state", "refine", "state", "state"]:
        raise ValueError("LTX 2.5 reference conditioning is incompatible with this runtime's stage order")


@contextmanager
def reference_sheet_conditioning(pipe, *, adapter_path, reference_path, strength,
                                 attention_strength, num_frames, report, status):
    """Install stage-one reference and adapter hooks; restore them on every exit."""
    from ltx_pipelines_mlx.iclora_utils import append_ic_lora_reference_video_conditionings
    from ltx_runtime_lora import attach_adapters, load_ltx_adapter, set_staged_adapter_multiplier

    module = inspect.getmodule(type(pipe))
    _check_pipeline_seams(type(pipe), module)
    if num_frames < 121 or (num_frames - 1) % 8:
        raise ValueError("LTX 2.5 reference sheets require at least 121 frames on the 8n+1 grid")
    adapter = load_ltx_adapter(adapter_path)
    policy = {"stage": "stage-1", "multiplier": 1.0}
    original_load = pipe._load_dev_transformer
    original_fuse = pipe._fuse_distilled_lora
    original_state = module.create_noised_state
    missing = object()
    previous_load = pipe.__dict__.get("_load_dev_transformer", missing)
    previous_fuse = pipe.__dict__.get("_fuse_distilled_lora", missing)
    did_inject = False

    def load_with_reference_adapter():
        dit = original_load()
        summary = attach_adapters(dit, [(adapter_path, adapter, 1.0)], tag="ic", stage_policy=policy)[0]
        report.record("ic", "stage-1", adapter_path, summary)
        status("Applied the LTX 2.5 reference adapter for stage 1")
        return dit

    def create_state_with_reference(*args, **kwargs):
        nonlocal did_inject
        if not did_inject:
            conditionings = list(kwargs.get("conditionings") or [])
            _, latent_height, latent_width = kwargs["spatial_dims"]
            append_ic_lora_reference_video_conditionings(
                conditionings, [(reference_path, strength)],
                height=latent_height * 32, width=latent_width * 32,
                num_frames=num_frames, video_encoder=pipe.vae_encoder,
                reference_downscale_factor=1,
                conditioning_attention_strength=attention_strength,
            )
            kwargs["conditionings"] = conditionings
            # Reference tokens must be appended before mask-aware noising, as
            # in the runtime's IC pipeline. The guided image-only path normally
            # noises first, which would ignore partial reference strength.
            kwargs["legacy_scalar_blend"] = False
            did_inject = True
        return original_state(*args, **kwargs)

    def fuse_without_reference_adapter(dit):
        if not did_inject:
            raise RuntimeError("The LTX 2.5 reference sheet was not applied")
        policy["stage"] = "stage-2"
        set_staged_adapter_multiplier(dit, policy, 0.0)
        return original_fuse(dit)

    pipe._load_dev_transformer = load_with_reference_adapter
    pipe._fuse_distilled_lora = fuse_without_reference_adapter
    module.create_noised_state = create_state_with_reference
    try:
        yield
        if not did_inject:
            raise RuntimeError("The LTX 2.5 reference sheet was not applied")
    finally:
        module.create_noised_state = original_state
        for name, previous in (("_load_dev_transformer", previous_load),
                               ("_fuse_distilled_lora", previous_fuse)):
            if previous is missing:
                pipe.__dict__.pop(name, None)
            else:
                pipe.__dict__[name] = previous
