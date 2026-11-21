"""What "the pinned MiniMax H3 MLX text encoder" means, stated once.

`generate_minimax_h3.py` patches four methods of
`minimax_h3_mlx.text_encoder.MiniMaxH3TextEncoder` at render time, and every one
of those patches is only correct against the exact implementation it was written
for. This module holds the facts that define "exact": which methods have to be
there, which of them has to still be a property, the merge line the encode
correction replaces, and the digest of the whole `encode` it copies.

Both readers import it, so there is one copy to re-record when the pin moves:

- the runner, whose corrections keep guarding their own seam — that is the last
  line of defence for a checkout overridden after install; and
- `minimax_h3_runtime_probe.py --verify-seams`, which Install / Repair passes,
  so whoever bumps `MINIMAX_H3_EXPECTED_REVISION` (server/services/videoGen/
  runtimes.js) hears about a moved pin at the action that moved it, rather than
  minutes into a failed keyframe render.

The probe's bare readiness path (`isByovRuntimeReady`) deliberately skips
`verify_pin_seams()`: a moved seam breaks only the keyframe and
substituted-conditioner paths, so failing readiness over it would set
`byovGateBlocked` and disable Generate for text-only renders that still work.
`verify_runtime_checkout()` already byte-verifies the checkout against the
expected revision, so a stock install can never reach these assertions: the
only way to fail one is to have moved the pin.

MLX only, deliberately: `generate_minimax_h3_cuda.py` runs diffusers'
`MiniMaxH3ModularPipeline` with no source checkout to pin and nothing to patch,
so none of this is true of it — checkpoint facts the two runners DO share live
in `_minimax_h3_common.py` instead.

Stdlib-only at import time like that sibling: `minimax_h3_mlx` and `mlx_vlm` are
imported inside the functions that need them, so importing this module never
assumes a registered source namespace or a loaded runtime.
"""

from __future__ import annotations

import hashlib
import importlib
import inspect

# The merge the pinned port performs instead of a scatter. Asserted before the
# runner's replacement is installed, so the day upstream fixes this the patch
# says so loudly rather than shadowing a working implementation forever.
PINNED_BROADCAST_MERGE = "mx.where(image_mask[..., None], hidden.astype(inputs_embeds.dtype)[None], inputs_embeds)"

# sha256 of the whole pinned `encode`, because the runner's replacement re-runs
# its body with one line changed rather than wrapping it. Matching only the merge
# line would let every OTHER edit a pin bump makes — a new `_hidden_states`
# argument, a different dtype, an added step — pass silently into a stale copy.
# Re-record this when bumping MINIMAX_H3_EXPECTED_REVISION, after re-reading
# `encode` and folding whatever changed into the replacement.
PINNED_ENCODE_DIGEST = "8047e407e797cd46cd7538024ca09d97402d369d97b1d825757a1590416bda7d"

def is_property(hook) -> bool:
    """Whether an attribute is the property the `processor` patch replaces."""
    return isinstance(hook, property)


# Every attribute of the pinned encoder PortOS patches, as
# `name: (shape, consequence, remedy)`. `shape` is what the patch needs the
# attribute to BE, not merely that it is there: `processor` is read as a property
# by the pinned caller, so one that stopped being a property is as much a pin
# change as an absent one, and the other three are wrapped and then CALLED, so a
# name that survived a bump as a plain value would pass a presence check and then
# fail at the call site. The consequence and remedy are stated here rather than at
# each patch so the install-time probe cannot report a seam differently from the
# render-time guard that shares it.
PINNED_ENCODER_SEAMS = {
    "_wanted": (
        callable,
        "a substituted text encoder cannot be key-mapped onto it",
        "Render with the stock text encoder",
    ),
    "processor": (
        is_property,
        "a keyframe cannot be encoded without PyTorch",
        "Render text-only",
    ),
    "_load_weights": (
        callable,
        "its vision tower cannot be laid out for MLX",
        "Render text-only",
    ),
    "encode": (
        callable,
        "a keyframe cannot be merged into the prompt",
        "Render text-only",
    ),
}

# The mlx-vlm names the corrections borrow that the pinned port never imports
# itself, so `minimax_h3_mlx.pipeline` would keep importing cleanly after a pin
# bump onto an mlx-vlm that moved any of them. Each is stated down to the
# ATTRIBUTE the correction actually calls, not just the class holding it: an
# mlx-vlm that kept `Model` and renamed its merge is exactly the drift that would
# otherwise pass Install / Repair and die on the first keyframe. Only the probe
# checks these — the runner reaches for them inside the correction that needs
# them, where a plain ImportError/AttributeError already names what is gone.
BORROWED_MLX_VLM_ATTRS = (
    ("mlx_vlm.models.qwen3_vl.qwen3_vl", "Model.merge_input_ids_with_image_features",
     "a keyframe cannot be merged into the prompt"),
    ("mlx_vlm.models.qwen3_vl.language", "LanguageModel.get_rope_index",
     "a keyframe cannot be positioned in the prompt"),
    ("mlx_vlm.utils", "sanitize_weights", "its vision tower cannot be laid out for MLX"),
)


def pinned_encoder_hook(name: str):
    """Return one seam of the pinned text encoder, or say the pin moved.

    Each correction in the runner wraps a different method of
    `MiniMaxH3TextEncoder`, and each is only correct against the implementation
    it was written for — so every one of them checks its hook is still there and
    still the shape it patches, and reports the same two ways out.
    """
    from minimax_h3_mlx.text_encoder import MiniMaxH3TextEncoder

    shape, consequence, remedy = PINNED_ENCODER_SEAMS[name]
    hook = getattr(MiniMaxH3TextEncoder, name, None)
    if hook is None or not shape(hook):
        raise RuntimeError(
            f"The pinned MiniMax H3 runtime no longer exposes MiniMaxH3TextEncoder.{name}, so "
            f"{consequence}. {remedy}, or update PortOS for the new pin."
        )
    return MiniMaxH3TextEncoder, hook


def verify_pinned_encode_source(encode) -> None:
    """Check `encode` is still the implementation the merge correction copied."""
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


def require_borrowed_attr(module_name: str, attr_path: str, consequence: str) -> None:
    """Check one borrowed mlx-vlm name resolves, without importing it to use.

    `attr_path` is walked a segment at a time, so `Model.merge_input_ids_with_image_features`
    reports the method the correction calls rather than only the class it hangs
    off — a renamed method on a still-present class is the drift most likely to
    survive a pin bump. Every borrowed name is CALLED by the correction that
    borrows it, so a name that survived as a plain value would pass a presence
    check here and then fail at the call site the check exists to protect.
    """
    try:
        found = importlib.import_module(module_name)
    except ImportError:
        found = None
    for part in attr_path.split("."):
        if found is None:
            break
        found = getattr(found, part, None)
    if not callable(found):
        raise RuntimeError(
            f"The pinned MiniMax H3 runtime's mlx-vlm no longer exposes {module_name}.{attr_path} "
            f"as a callable, so {consequence}. Update PortOS for the new pin."
        )


def verify_pin_seams() -> None:
    """Assert every seam the render-time corrections patch, before a render.

    Called from the runtime probe, which runs at Install / Repair — the action
    that can move the pin — so the whole set is reported there instead of one
    seam at a time, minutes into whichever render happens to touch it first.
    """
    for name in PINNED_ENCODER_SEAMS:
        _, hook = pinned_encoder_hook(name)
        # Presence is not enough for `encode` alone: the correction re-runs a COPY
        # of its body, so the body itself is part of the seam.
        if name == "encode":
            verify_pinned_encode_source(hook)
    for entry in BORROWED_MLX_VLM_ATTRS:
        require_borrowed_attr(*entry)


__all__ = [
    "BORROWED_MLX_VLM_ATTRS",
    "is_property",
    "PINNED_BROADCAST_MERGE",
    "PINNED_ENCODE_DIGEST",
    "PINNED_ENCODER_SEAMS",
    "pinned_encoder_hook",
    "require_borrowed_attr",
    "verify_pin_seams",
    "verify_pinned_encode_source",
]
