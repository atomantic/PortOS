"""The pinned-MiniMax-H3 seams PortOS patches, stated once for both callers.

`generate_minimax_h3.py` corrects four things PipeNetwork's pinned MLX port
gets wrong on the keyframe path, and each correction wraps a specific method of
`MiniMaxH3TextEncoder` — so each is only valid against the exact implementation
it was written against. Which methods those are, and what "unchanged" means for
the one whose body is copied rather than wrapped, are facts about the PIN, not
about the runner, and two callers need them:

  - the runner, which refuses to install a correction onto a hook that moved
  - `minimax_h3_runtime_probe.py --verify-seams`, which Install / Repair runs and
    which therefore fails at the action that moved the pin, rather than minutes
    into the first keyframe render that happens to reach the seam

`PINNED_ENCODE_DIGEST` in particular must have exactly ONE home. A second copy
is a copy that goes stale, and a stale digest asserts a pin bump is fine when
it is not — which is the failure this module exists to make impossible.

Stdlib-only at import, like `_runner_common.py` and `_minimax_h3_common.py`:
the pinned package and mlx-vlm are imported inside the functions that need
them, so nothing here forces a venv to grow a dependency, and the probe can
import this module before deciding the checkout is usable at all.
"""

from __future__ import annotations

import hashlib
import importlib
import inspect

# The merge the pinned port performs instead of a scatter. Asserted before the
# replacement is installed, so the day upstream fixes this the patch says so
# loudly rather than shadowing a working implementation forever.
PINNED_BROADCAST_MERGE = "mx.where(image_mask[..., None], hidden.astype(inputs_embeds.dtype)[None], inputs_embeds)"

# sha256 of the whole pinned `encode`, because the replacement re-runs its body
# with one line changed rather than wrapping it. Matching only the merge line
# would let every OTHER edit a pin bump makes — a new `_hidden_states` argument,
# a different dtype, an added step — pass silently into a stale copy.
# Re-record this when bumping MINIMAX_H3_EXPECTED_REVISION, after re-reading
# `encode` and folding whatever changed into the replacement.
PINNED_ENCODE_DIGEST = "8047e407e797cd46cd7538024ca09d97402d369d97b1d825757a1590416bda7d"

# Every method of the pinned encoder a PortOS correction wraps: what breaks when
# the pin no longer has it, the shape the correction requires it to still be, and
# the way out that rescues the render. A TABLE rather than arguments at the four
# call sites, because the runner patches these and the probe asserts them —
# stating the pair apart is exactly how the install-time check drifts from the
# render-time one, which is the failure this module exists to prevent.
#
# `remedy` defaults to dropping the keyframe, which is what rescues three of
# them. The key-prefix map is the exception: it is reached by a substituted
# conditioner, which a keyframe has nothing to do with.
DEFAULT_REMEDY = "Render text-only"
PINNED_ENCODER_SEAMS = {
    "_wanted": {
        "consequence": "a substituted text encoder cannot be key-mapped onto it",
        "remedy": "Render with the stock text encoder",
    },
    "processor": {
        "consequence": "a keyframe cannot be encoded without PyTorch",
        # The correction binds a property, and the pinned caller reads rather
        # than calls it — a `processor` that is no longer one is as much a pin
        # change as an absent one.
        "kind": property,
    },
    "_load_weights": {
        "consequence": "its vision tower cannot be laid out for MLX",
    },
    "encode": {
        "consequence": "a keyframe cannot be merged into the prompt",
    },
}

# Every mlx-vlm entry point the corrections reach for, as
# (module, dotted attribute, what breaks without it). The two methods are named
# rather than just their classes: a `Model` that still imports but no longer
# carries `merge_input_ids_with_image_features` breaks the correction exactly as
# hard as one that vanished. Kept in step with the runner's own `from mlx_vlm …
# import` lines by a drift guard in minimax_h3_runtime_probe.test.js.
PINNED_MLX_VLM_SYMBOLS = (
    ("mlx_vlm.utils", "sanitize_weights",
     "a keyframe's vision tower cannot be laid out for MLX"),
    ("mlx_vlm.models.qwen3_vl.qwen3_vl", "Model.merge_input_ids_with_image_features",
     "a keyframe cannot be scattered into the prompt"),
    ("mlx_vlm.models.qwen3_vl.language", "LanguageModel.get_rope_index",
     "a keyframe's position ids cannot be built"),
)


def pinned_encoder_hook(name: str):
    """Return one seam of the pinned text encoder, or say the pin moved.

    Each keyframe correction wraps a different method of
    `MiniMaxH3TextEncoder`, and each is only correct against the implementation
    it was written for — so every one of them checks its hook is still there and
    still the shape it patches, and reports the same two ways out.
    """
    from minimax_h3_mlx.text_encoder import MiniMaxH3TextEncoder

    seam = PINNED_ENCODER_SEAMS[name]
    hook = getattr(MiniMaxH3TextEncoder, name, None)
    kind = seam.get("kind")
    if hook is None or (kind is not None and not isinstance(hook, kind)):
        raise RuntimeError(
            f"The pinned MiniMax H3 runtime no longer exposes MiniMaxH3TextEncoder.{name}, so "
            f"{seam['consequence']}. {seam.get('remedy', DEFAULT_REMEDY)}, or update PortOS "
            "for the new pin."
        )
    return MiniMaxH3TextEncoder, hook


def verify_pinned_encode(encode) -> None:
    """Assert the copied `encode` body is still the one PortOS copied.

    Two checks, because they fail for opposite reasons and want opposite fixes:
    the merge line going missing means upstream fixed the bug and the correction
    must RETIRE, while the merge line surviving under a different digest means
    something else in the body moved and the copy must be REFRESHED.
    """
    source = inspect.getsource(encode)
    if PINNED_BROADCAST_MERGE not in source:
        raise RuntimeError(
            "The pinned MiniMax H3 runtime no longer merges keyframe embeddings the way PortOS "
            "corrects for; re-check the pin before rendering with a keyframe."
        )
    if hashlib.sha256(source.encode("utf-8")).hexdigest() != PINNED_ENCODE_DIGEST:
        raise RuntimeError(
            "The pinned MiniMax H3 runtime changed MiniMaxH3TextEncoder.encode outside the merge "
            "PortOS corrects; fold the change into the replacement and re-record "
            "PINNED_ENCODE_DIGEST before rendering with a keyframe."
        )


def verify_mlx_vlm_symbol(module_path: str, dotted: str, consequence: str) -> None:
    """Require one mlx-vlm attribute the corrections call, by its dotted path."""
    full = f"{module_path}.{dotted}"
    try:
        target = importlib.import_module(module_path)
    except ImportError as exc:
        raise RuntimeError(
            f"The MiniMax H3 runtime's mlx-vlm no longer provides {module_path}, so {consequence}. "
            "Update PortOS for the new mlx-vlm."
        ) from exc
    for part in dotted.split("."):
        target = getattr(target, part, None)
        if target is None:
            raise RuntimeError(
                f"The MiniMax H3 runtime's mlx-vlm no longer exposes {full}, so {consequence}. "
                "Update PortOS for the new mlx-vlm."
            )


def verify_pinned_seams() -> None:
    """Check every seam the keyframe corrections depend on, loading no weights.

    The runner guards each seam again at the moment it patches it — that stays
    the last line for anyone who overrides the pin — but by then a cache resolve
    and a pipeline load have already happened, and only an image-conditioned
    render reaches three of the four. Running the same assertions from the
    Install / Repair probe puts the failure at the action that caused it.

    Requires `minimax_h3_mlx` to already be importable, which for the probe means
    after `register_source_namespace`.
    """
    hooks = {name: pinned_encoder_hook(name)[1] for name in PINNED_ENCODER_SEAMS}
    verify_pinned_encode(hooks["encode"])
    for module_path, dotted, consequence in PINNED_MLX_VLM_SYMBOLS:
        verify_mlx_vlm_symbol(module_path, dotted, consequence)
