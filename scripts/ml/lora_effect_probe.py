#!/usr/bin/env python3
"""Measure how much a LoRA adapter would actually change the weights it fuses into.

PortOS already refuses a LoRA whose *filename*, safetensors structure, key
layout or runtime is wrong (`server/lib/safetensors.js`,
`server/services/videoGen/local.js#resolveVideoLoras`). None of those checks
answers the question a user actually has before committing to a multi-minute
video render: **does this adapter do anything?** A structurally perfect file can
still carry all-zero `lora_B` weights (a training run that never stepped), NaN
deltas (a diverged run saved anyway), or deltas so small the render is
indistinguishable from the base model.

This probe answers that, per LoRA module, from the file alone — no pipeline, no
GPU, no model download:

    delta = scale * (B @ A)          # what fusing would add to the base weight
    effect = ||delta||_F / sqrt(n)   # RMS magnitude of that addition

The Frobenius norm is computed from the two rank-sized Gram matrices rather than
the full ``out x in`` product:

    ||B @ A||_F^2 = trace((B^T B) (A A^T))

Both Grams are ``rank x rank`` (rank is 8-256 in practice), so a 4096x4096
module costs two skinny products instead of materialising a 16M-element matrix.
The result is exact, not an estimate.

Finite-safety — the whole point of the module, and why it is a probe rather
than an inline calculation:

  * Warnings are suppressed **only** around the two matrix products. Apple's
    Accelerate BLAS emits ``RuntimeWarning`` for perfectly ordinary overflow
    during accumulation; letting that escape onto stderr would put a scary
    numerical warning next to a user-facing verdict that is in fact fine. The
    suppression is scoped to the products so a warning raised anywhere else
    (a genuinely bad read, a numpy deprecation) still surfaces.
  * A module whose total is NaN or +/-Inf is **skipped**, not folded into the
    aggregate. One diverged module would otherwise turn every summary statistic
    into NaN and destroy the report for the modules that are fine.
  * Median and max are computed over the surviving finite values only, so they
    are stable: adding a diverged module to a healthy adapter changes the
    ``skippedNonFinite`` count, never the reported magnitudes.

Verdict (`status`): one of `ok` / `zero` / `nonfinite` / `unreadable` /
`unmeasurable`. `server/lib/loraEffect.js` is the AUTHORITY on what each one
means and which one refuses a render — this script only reports what it measured,
and duplicating the policy here would give it two places to drift. The one detail
that belongs on this side: `unmeasurable` (no numpy) also exits with code 3, so
the caller can try another interpreter instead of blaming the adapter.

Deliberately NOT a verdict: "weak". A small median is reported as a number and
left to the human — there is no defensible threshold below which an adapter is
"too weak", and inventing one would refuse working stylistic LoRAs.

Import-time cost is stdlib only (numpy is imported inside `measure_lora_effect`)
so `scripts/ml/generate_ltx2.py` can import this from the ltx-2-mlx venv without
pulling numpy into a render that never asks for a measurement.

Run standalone:  python3 scripts/ml/lora_effect_probe.py <path-to.safetensors>
Emits a single ``RESULT:<json>`` line on stdout (the PortOS sidecar protocol).
"""

from __future__ import annotations

import json
import math
import statistics
import struct
import sys
import warnings
from pathlib import Path

# Bumped when the measurement or the status vocabulary changes, so a report
# cached in a LoRA sidecar by an older PortOS is re-probed instead of trusted.
# Mirrored by LORA_EFFECT_PROBE_VERSION in server/lib/loraEffect.js.
PROBE_VERSION = 1

# Same sanity bound as readSafetensorsHeader() in server/lib/safetensors.js: a
# real header is KB to low-MB, anything past this is a corrupt length we refuse
# to allocate for.
MAX_HEADER_BYTES = 100 * 1024 * 1024

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_NO_NUMPY = 3

# Longest first: "foo.lora_A.weight" ends with both ".weight" forms and the bare
# ".lora_A", and a shorter match would strip the wrong number of characters.
# Lowercase: _split_suffix matches against a lowercased name (see there).
_DOWN_SUFFIXES = ("lora_a.weight", "lora_down.weight", "lora_a", "lora_down")
_UP_SUFFIXES = ("lora_b.weight", "lora_up.weight", "lora_b", "lora_up")

# Adapter tensors that carry real effect but are NOT a low-rank pair this probe
# can multiply out: DoRA magnitude vectors, LyCORIS Hadamard/Kronecker factors,
# orthogonal fine-tuning blocks, and kohya's full-rank `.diff` deltas.
#
# They exist only so the `zero` verdict stays honest. `zero` refuses a render on
# the claim that the adapter is PROVABLY inert — but a hybrid file whose lora_A/
# lora_B pairs are zeroed while its effect rides on one of these would otherwise
# look entirely-zero, because tensors that never enter pair_lora_modules are
# neither measured NOR counted as skipped. Counting them makes the file report
# `ok` with a skip count, which is the truthful answer: we could not measure all
# of it.
_UNMEASURABLE_ADAPTER_MARKERS = (
    "lora_magnitude_vector",
    "hada_w",
    "lokr_",
    "oft_",
    "boft_",
    ".diff",
)

# dtype tag -> (numpy dtype string, bytes per element). BF16 has no numpy dtype;
# it is widened to float32 by shifting the 16 stored bits into the high half of
# a float32, which is exact (bfloat16 IS the top half of a float32).
_DTYPES = {
    "F64": ("<f8", 8),
    "F32": ("<f4", 4),
    "F16": ("<f2", 2),
    "BF16": (None, 2),
}


def read_header(path: Path) -> tuple[dict | None, int]:
    """Parse the safetensors JSON header. Returns ``(header, payload_offset)``.

    ``(None, 0)`` for anything unreadable — missing file, truncated write, a
    non-safetensors blob, a garbage header length. Never raises: an unreadable
    file is a verdict (``unreadable``), not a crash.
    """
    try:
        with open(path, "rb") as handle:
            raw_len = handle.read(8)
            if len(raw_len) < 8:
                return None, 0
            (header_len,) = struct.unpack("<Q", raw_len)
            if header_len <= 0 or header_len > MAX_HEADER_BYTES:
                return None, 0
            blob = handle.read(header_len)
            if len(blob) < header_len:
                return None, 0
        header = json.loads(blob.decode("utf-8"))
    except (OSError, ValueError, struct.error):
        return None, 0
    return (header, 8 + header_len) if isinstance(header, dict) else (None, 0)


def _split_suffix(name: str) -> tuple[str, str] | None:
    """Map a tensor name to ``(module_prefix, 'down'|'up')``, or None.

    Matched case-INSENSITIVELY, because server/lib/safetensors.js classifies with
    ``/i`` regexes: a file naming its pair ``lora_a``/``lora_b`` passes the key-layout
    gate as a fusable LoRA, so a case-sensitive probe would call the very same
    file unreadable. The prefix is sliced off the ORIGINAL name — it is the key
    the header is looked up by.
    """
    lowered = name.lower()
    for suffix in _DOWN_SUFFIXES:
        if lowered.endswith(suffix):
            return name[: -len(suffix)].rstrip("."), "down"
    for suffix in _UP_SUFFIXES:
        if lowered.endswith(suffix):
            return name[: -len(suffix)].rstrip("."), "up"
    return None


def pair_lora_modules(header: dict) -> tuple[dict[str, dict[str, str]], int]:
    """Group tensor names into ``{module: {'down': name, 'up': name, 'alpha': name}}``.

    Covers every layout PortOS classifies: bare and ComfyUI files name the pair
    ``lora_A``/``lora_B``, kohya/LyCORIS names it ``lora_down``/``lora_up`` and
    ships a companion ``alpha`` scalar. The diagnostic deliberately measures
    layouts the LTX-2 loader cannot fuse too — "this adapter is dead" is worth
    knowing about a kohya file the user is about to re-export.

    Also returns a count of adapter tensors it could NOT pair: an incomplete pair,
    or one of the _UNMEASURABLE_ADAPTER_MARKERS families. See that constant for
    why the count matters to the `zero` verdict.
    """
    modules: dict[str, dict[str, str]] = {}
    for name in header:
        if name == "__metadata__":
            continue
        if name.lower().endswith(".alpha") or name.lower() == "alpha":
            # setdefault, so an alpha listed BEFORE its pair still lands on the
            # right module; the completeness filter below drops an alpha whose
            # pair never showed up.
            modules.setdefault(name[: -len("alpha")].rstrip("."), {})["alpha"] = name
            continue
        split = _split_suffix(name)
        if split is None:
            continue
        prefix, role = split
        modules.setdefault(prefix, {})[role] = name
    # Only complete pairs are measurable; a lone lora_A carries no delta.
    complete = {k: v for k, v in modules.items() if "down" in v and "up" in v}
    unpairable = len(modules) - len(complete)
    for name in header:
        lowered = name.lower()
        if any(marker in lowered for marker in _UNMEASURABLE_ADAPTER_MARKERS):
            unpairable += 1
    return complete, unpairable


def _read_tensor(np, handle, payload_offset: int, desc, file_size: int, *, allow_scalar: bool = False):
    """Read one tensor as float32, or None when it is not something we can measure.

    Rejects (rather than guesses at) unsupported dtypes, non-2-D shapes (conv
    LoRAs), and descriptors whose byte range does not match their declared
    shape — a truncated download would otherwise be measured as garbage.
    """
    if not isinstance(desc, dict):
        return None
    spec = _DTYPES.get(desc.get("dtype"))
    if spec is None:
        return None
    shape = desc.get("shape")
    if not isinstance(shape, list) or not all(isinstance(d, int) and d >= 0 for d in shape):
        return None
    rank = len(shape)
    if rank != 2 and not (allow_scalar and rank <= 1):
        return None
    offsets = desc.get("data_offsets")
    if not isinstance(offsets, list) or len(offsets) != 2:
        return None
    start, end = offsets
    if not isinstance(start, int) or not isinstance(end, int) or end < start:
        return None
    # The range must lie inside the payload. Without the lower bound a crafted
    # ``data_offsets: [-4, 0]`` seeks BACK into the header and measures it as
    # tensor data; without the upper bound an absurd declared length asks
    # ``read()`` for gigabytes the file does not contain.
    if start < 0 or payload_offset + end > file_size:
        return None
    count = math.prod(shape) if shape else 1
    if (end - start) != count * spec[1]:
        return None
    try:
        handle.seek(payload_offset + start)
        buf = handle.read(end - start)
    except OSError:
        return None
    if len(buf) != end - start:
        return None
    if spec[0] is None:
        # BF16 -> float32: bfloat16 IS the high half of a float32, so widen by
        # dropping the stored halves into the high lanes of a zeroed pair array
        # and viewing it. Shifting a `.astype(np.uint32)` copy would build two
        # full-size temporaries per module instead of one.
        widened = np.zeros((len(buf) // 2, 2), dtype="<u2")
        widened[:, 1] = np.frombuffer(buf, dtype="<u2")
        # '<f4', not np.float32: the pair array is little-endian by
        # construction, and viewing it through the NATIVE float32 would read the
        # bytes backwards on a big-endian host.
        arr = widened.view("<f4").astype(np.float32, copy=False).reshape(-1)
    else:
        # copy=False: an F32 adapter is already the target dtype on a
        # little-endian host, and the read-only frombuffer view is all the two
        # GEMMs below need. The default copy=True would memcpy the entire
        # adapter for nothing, inline, right before a render claims memory.
        arr = np.frombuffer(buf, dtype=spec[0]).astype(np.float32, copy=False)
    return arr.reshape(shape) if shape else arr.reshape(())


def _module_rms(np, down, up, scale: float) -> float:
    """RMS magnitude of ``scale * (up @ down)`` — may be NaN/Inf; caller filters.

    Warning suppression is scoped to exactly the two Gram products and the
    reduction over them. Accelerate/OpenBLAS raise RuntimeWarning on overflow
    while accumulating a diverged adapter, which is information we already
    capture as a non-finite total — it must not reach the user as a warning
    line next to an otherwise clean verdict.
    """
    out_features, rank = up.shape
    _, in_features = down.shape
    # float64 for the products, whatever the storage dtype. The Gram form squares
    # the weights TWICE over (||BA||_F^2 is a product of two Gram matrices), so a
    # legitimately tiny adapter — 1e-20 weights are unusual but real — reaches
    # 1e-80, far below float32's ~1e-38 floor. In float32 that underflows to
    # exactly 0.0 and the adapter is reported `zero`, which REFUSES the render.
    # A false refusal is the worst outcome this probe can produce, and the cast
    # costs one transient copy of two rank-sized matrices.
    up64 = up.astype(np.float64)
    down64 = down.astype(np.float64)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        with np.errstate(over="ignore", invalid="ignore", divide="ignore", under="ignore"):
            gram_up = up64.T @ up64          # (rank, rank), symmetric
            gram_down = down64 @ down64.T    # (rank, rank), symmetric
            # trace(X @ Y) for symmetric X, Y is the elementwise sum of X * Y.
            total = float(np.sum(gram_up * gram_down))
    if not math.isfinite(total):
        return total
    # Cancellation in the reduction can push a genuinely-zero adapter a hair
    # below 0; a negative squared norm is not a measurement, it is float noise.
    if total < 0.0:
        total = 0.0
    elements = out_features * in_features
    if elements <= 0:
        return math.nan
    # abs(scale): a kohya file may carry a NEGATIVE alpha, and a magnitude is
    # never negative. Without this a negative alpha yields a negative "RMS",
    # which sorts below zero and would make max/median meaningless.
    return abs(scale) * math.sqrt(total) / math.sqrt(elements)


def measure_lora_effect(path) -> dict:
    """Measure every LoRA module in ``path`` and summarise the result.

    Returns the report dict the JS side normalises (see
    server/lib/loraEffect.js#normalizeLoraEffectReport). Never raises for a bad
    file — an unreadable adapter is a status, not an exception.
    """
    report = {
        "probeVersion": PROBE_VERSION,
        "status": "unreadable",
        "modules": 0,
        "measured": 0,
        "skippedNonFinite": 0,
        "skippedUnsupported": 0,
        "zeroModules": 0,
        "medianRms": None,
        "maxRms": None,
        "reason": None,
    }
    try:
        import numpy as np
    except ImportError as err:  # pragma: no cover - environment-dependent
        report["status"] = "unmeasurable"
        report["reason"] = f"numpy is not installed in this interpreter ({err})"
        return report

    path = Path(path)
    header, payload_offset = read_header(path)
    if header is None:
        report["reason"] = f"{path.name} is not a readable safetensors file"
        return report

    modules, unpairable = pair_lora_modules(header)
    report["modules"] = len(modules)
    report["skippedUnsupported"] = unpairable
    if not modules:
        report["reason"] = f"{path.name} contains no lora_A/lora_B (or lora_down/lora_up) pairs"
        return report

    values: list[float] = []
    try:
        file_size = path.stat().st_size
        handle = open(path, "rb")
    except OSError as err:
        report["reason"] = f"{path.name} could not be opened: {err}"
        return report
    with handle:
        for names in modules.values():
            down = _read_tensor(np, handle, payload_offset, header.get(names["down"]), file_size)
            up = _read_tensor(np, handle, payload_offset, header.get(names["up"]), file_size)
            # Shapes must chain as (out, rank) @ (rank, in). Anything else is a
            # layout this probe does not understand — skipping is honest, and
            # transposing on a hunch would invent a measurement.
            if down is None or up is None or up.shape[1] != down.shape[0]:
                report["skippedUnsupported"] += 1
                continue
            scale = 1.0
            alpha_name = names.get("alpha")
            if alpha_name is not None:
                alpha = _read_tensor(
                    np, handle, payload_offset, header.get(alpha_name), file_size, allow_scalar=True
                )
                rank = up.shape[1]
                if alpha is not None and alpha.size == 1 and rank > 0:
                    alpha_value = float(alpha.reshape(-1)[0])
                    if not math.isfinite(alpha_value):
                        # A NaN/Inf alpha makes this module's delta non-finite —
                        # count it as such. Falling back to scale 1.0 would
                        # report a plausible magnitude for a module that has
                        # none, which is the opposite of finite-safe.
                        report["skippedNonFinite"] += 1
                        continue
                    scale = alpha_value / rank
            rms = _module_rms(np, down, up, scale)
            if not math.isfinite(rms):
                report["skippedNonFinite"] += 1
                continue
            values.append(rms)

    report["measured"] = len(values)
    if not values:
        if report["skippedNonFinite"]:
            report["status"] = "nonfinite"
            report["reason"] = (
                f"every one of {report['skippedNonFinite']} LoRA module(s) measured NaN or Infinity "
                "— the adapter's weights are diverged"
            )
        else:
            report["reason"] = (
                f"none of {report['modules']} LoRA module pair(s) could be measured "
                "(unsupported dtype, non-2-D shape, or truncated file)"
            )
        return report

    report["zeroModules"] = sum(1 for v in values if v == 0.0)
    report["medianRms"] = float(statistics.median(values))
    report["maxRms"] = float(max(values))
    skipped = report["skippedNonFinite"] + report["skippedUnsupported"]
    # ``zero`` is the ONE verdict that refuses a render, so it has to mean the
    # whole adapter is provably inert — not merely that the subset we could
    # measure was. A file with one zero pair plus a conv-shaped or diverged pair
    # we skipped may still carry real effect through the module we never read,
    # and refusing it would block a working LoRA. Report the zero count and let
    # it render.
    if report["zeroModules"] == len(values) and skipped == 0:
        report["status"] = "zero"
        report["reason"] = (
            f"all {len(values)} measurable LoRA module(s) have exactly zero effect "
            "— fusing it would change nothing"
        )
    else:
        report["status"] = "ok"
    return report


def format_effect(report: dict) -> str:
    """One-line human summary, for a render log or a status line."""
    status = report.get("status")
    if status not in ("ok", "zero"):
        return f"{status}: {report.get('reason') or 'no measurement'}"
    median = report.get("medianRms")
    peak = report.get("maxRms")
    parts = [
        f"median RMS {median:.3e}" if isinstance(median, float) else "median RMS n/a",
        f"max {peak:.3e}" if isinstance(peak, float) else "max n/a",
        f"across {report.get('measured', 0)} module(s)",
    ]
    skipped = report.get("skippedNonFinite") or 0
    if skipped:
        parts.append(f"{skipped} non-finite skipped")
    return ", ".join(parts)


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: lora_effect_probe.py <path-to.safetensors>", file=sys.stderr)
        return EXIT_USAGE
    report = measure_lora_effect(argv[1])
    print("RESULT:" + json.dumps(report), flush=True)
    # A distinct code lets the Node caller advance to the next candidate
    # interpreter instead of reporting a missing numpy as a verdict about the
    # adapter. Every other status is a real answer and exits 0.
    return EXIT_NO_NUMPY if report["status"] == "unmeasurable" else EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
