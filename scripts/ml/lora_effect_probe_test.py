#!/usr/bin/env python3
"""Standalone tests for lora_effect_probe.py (no pytest; numpy required).

Run: ~/.portos/ltx-2-mlx/.venv/bin/python3 scripts/ml/lora_effect_probe_test.py
(or any interpreter with numpy — the probe needs it to measure anything).
Exits non-zero on first failure. Mirrors the runnable-test style of
scripts/ml/_runner_common_test.py.

Fixtures are synthesised in a temp dir rather than checked in: a real LoRA is
hundreds of MB, and the interesting cases (all-zero B, NaN weights, BF16
storage, a truncated payload) are precisely the ones no published adapter
provides.
"""

import json
import math
import struct
import sys
import tempfile
from pathlib import Path

# ✅/❌ are cp1252-unencodable on a Windows console, which would abort the run
# before the first result printed.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lora_effect_probe import (  # noqa: E402
    PROBE_VERSION,
    format_effect,
    measure_lora_effect,
    pair_lora_modules,
    read_header,
)

try:
    import numpy as np
except ImportError:  # pragma: no cover - environment-dependent
    print("SKIP: numpy is not installed in this interpreter")
    raise SystemExit(0)

FAILS = []


def check(name, cond):
    print(("✅" if cond else "❌") + " " + name)
    if not cond:
        FAILS.append(name)


_DTYPE_TAGS = {np.dtype("float32"): "F32", np.dtype("float16"): "F16", np.dtype("float64"): "F64"}


def write_safetensors(path, tensors, *, truncate_payload=0):
    """Minimal safetensors writer: {name: ndarray} (or ('BF16', ndarray))."""
    header = {}
    blobs = []
    offset = 0
    for name, value in tensors.items():
        if isinstance(value, tuple) and value[0] == "BF16":
            arr = np.asarray(value[1], dtype=np.float32)
            # bfloat16 IS the high half of a float32 — store the top 16 bits.
            raw = (arr.view(np.uint32) >> np.uint32(16)).astype("<u2").tobytes()
            tag = "BF16"
        else:
            arr = np.asarray(value)
            tag = _DTYPE_TAGS[arr.dtype]
            raw = arr.astype(arr.dtype.newbyteorder("<")).tobytes()
        header[name] = {"dtype": tag, "shape": list(arr.shape), "data_offsets": [offset, offset + len(raw)]}
        blobs.append(raw)
        offset += len(raw)
    blob = json.dumps(header).encode("utf-8")
    payload = b"".join(blobs)
    if truncate_payload:
        payload = payload[:-truncate_payload]
    Path(path).write_bytes(struct.pack("<Q", len(blob)) + blob + payload)


def bare_pair(prefix, down, up):
    return {f"{prefix}.lora_A.weight": down, f"{prefix}.lora_B.weight": up}


def run(tmp):
    # --- header reading -----------------------------------------------------
    good = tmp / "good.safetensors"
    write_safetensors(good, bare_pair("blocks.0.attn", np.ones((2, 4), np.float32), np.ones((4, 2), np.float32)))
    header, offset = read_header(good)
    check("read_header parses a well-formed file", isinstance(header, dict) and offset > 8)

    junk = tmp / "junk.safetensors"
    junk.write_bytes(b"not-safetensors-at-all")
    check("read_header returns None for a non-safetensors blob", read_header(junk) == (None, 0))

    absurd = tmp / "absurd.safetensors"
    absurd.write_bytes(struct.pack("<Q", 2**40) + b"{}")
    check("read_header refuses an absurd header length", read_header(absurd) == (None, 0))

    # --- pairing ------------------------------------------------------------
    paired, unpairable = pair_lora_modules({
        "m.lora_A.weight": {}, "m.lora_B.weight": {},
        "k.lora_down.weight": {}, "k.lora_up.weight": {}, "k.alpha": {},
        "lonely.lora_A.weight": {},
        "__metadata__": {},
    })
    check("pairs bare and kohya modules, drops the unpaired one", sorted(paired) == ["k", "m"])
    check("the unpaired module is COUNTED, not silently dropped", unpairable == 1)
    check("kohya alpha is attached to its module", paired["k"].get("alpha") == "k.alpha")

    # --- a healthy adapter --------------------------------------------------
    rng = np.random.default_rng(7)
    healthy = tmp / "healthy.safetensors"
    write_safetensors(healthy, {
        **bare_pair("blocks.0.attn.to_q", rng.normal(size=(8, 64)).astype(np.float32),
                    rng.normal(size=(64, 8)).astype(np.float32)),
        **bare_pair("blocks.1.attn.to_q", (rng.normal(size=(8, 64)) * 0.01).astype(np.float32),
                    (rng.normal(size=(64, 8)) * 0.01).astype(np.float32)),
    })
    report = measure_lora_effect(healthy)
    check("healthy adapter reports ok", report["status"] == "ok")
    check("healthy adapter measured both modules", report["measured"] == 2 and report["modules"] == 2)
    check("healthy adapter stamps the probe version", report["probeVersion"] == PROBE_VERSION)
    check("max >= median > 0", report["maxRms"] >= report["medianRms"] > 0)
    check("no non-finite skips on clean weights", report["skippedNonFinite"] == 0)

    # The Gram-trick result must equal the direct product's RMS.
    down = rng.normal(size=(4, 32)).astype(np.float32)
    up = rng.normal(size=(48, 4)).astype(np.float32)
    exact = tmp / "exact.safetensors"
    write_safetensors(exact, bare_pair("only", down, up))
    direct = float(np.sqrt(np.mean((up @ down).astype(np.float64) ** 2)))
    measured = measure_lora_effect(exact)["maxRms"]
    check("Gram-trick RMS matches the direct product", math.isclose(measured, direct, rel_tol=1e-4))

    # --- the one refusable case: entirely zero ------------------------------
    dead = tmp / "dead.safetensors"
    write_safetensors(dead, {
        **bare_pair("a", rng.normal(size=(8, 64)).astype(np.float32), np.zeros((64, 8), np.float32)),
        **bare_pair("b", rng.normal(size=(8, 64)).astype(np.float32), np.zeros((64, 8), np.float32)),
    })
    report = measure_lora_effect(dead)
    check("all-zero adapter reports zero", report["status"] == "zero")
    check("zero adapter counts every module as zero", report["zeroModules"] == report["measured"] == 2)
    check("zero adapter explains itself", "zero effect" in (report["reason"] or ""))

    # One live module is enough to keep the adapter usable — a partially-zero
    # adapter must NOT be refused.
    partial = tmp / "partial.safetensors"
    write_safetensors(partial, {
        **bare_pair("a", rng.normal(size=(8, 64)).astype(np.float32), np.zeros((64, 8), np.float32)),
        **bare_pair("b", rng.normal(size=(8, 64)).astype(np.float32), rng.normal(size=(64, 8)).astype(np.float32)),
    })
    report = measure_lora_effect(partial)
    check("one live module keeps the adapter ok", report["status"] == "ok")
    check("partial adapter still reports its zero count", report["zeroModules"] == 1)

    # --- non-finite handling ------------------------------------------------
    nan_up = np.full((64, 8), np.nan, np.float32)
    diverged = tmp / "diverged.safetensors"
    write_safetensors(diverged, bare_pair("a", rng.normal(size=(8, 64)).astype(np.float32), nan_up))
    report = measure_lora_effect(diverged)
    check("all-NaN adapter reports nonfinite (not zero)", report["status"] == "nonfinite")
    check("nonfinite adapter has no invented statistics", report["medianRms"] is None and report["maxRms"] is None)

    # A NaN module must be excluded, leaving the healthy module's numbers intact.
    healthy_down = rng.normal(size=(8, 64)).astype(np.float32)
    healthy_up = rng.normal(size=(64, 8)).astype(np.float32)
    clean = tmp / "clean.safetensors"
    write_safetensors(clean, bare_pair("good", healthy_down, healthy_up))
    mixed = tmp / "mixed.safetensors"
    write_safetensors(mixed, {
        **bare_pair("good", healthy_down, healthy_up),
        **bare_pair("bad", rng.normal(size=(8, 64)).astype(np.float32), np.full((64, 8), np.inf, np.float32)),
    })
    clean_report = measure_lora_effect(clean)
    mixed_report = measure_lora_effect(mixed)
    check("a diverged module is skipped, not aggregated", mixed_report["skippedNonFinite"] == 1)
    check("statistics stay stable when a module is skipped",
          mixed_report["medianRms"] == clean_report["medianRms"] and mixed_report["status"] == "ok")

    # --- dtype coverage -----------------------------------------------------
    bf16 = tmp / "bf16.safetensors"
    bf16_down = np.round(rng.normal(size=(4, 32)) * 4).astype(np.float32) / 256
    bf16_up = np.round(rng.normal(size=(32, 4)) * 4).astype(np.float32) / 256
    write_safetensors(bf16, {
        "m.lora_A.weight": ("BF16", bf16_down),
        "m.lora_B.weight": ("BF16", bf16_up),
    })
    report = measure_lora_effect(bf16)
    check("BF16 weights are measured", report["status"] == "ok" and report["measured"] == 1)

    fp16 = tmp / "fp16.safetensors"
    write_safetensors(fp16, bare_pair("m", bf16_down.astype(np.float16), bf16_up.astype(np.float16)))
    check("F16 weights are measured", measure_lora_effect(fp16)["status"] == "ok")

    # --- kohya alpha scaling ------------------------------------------------
    k_down = rng.normal(size=(8, 64)).astype(np.float32)
    k_up = rng.normal(size=(64, 8)).astype(np.float32)
    no_alpha = tmp / "kohya_plain.safetensors"
    write_safetensors(no_alpha, {"m.lora_down.weight": k_down, "m.lora_up.weight": k_up})
    with_alpha = tmp / "kohya_alpha.safetensors"
    write_safetensors(with_alpha, {
        "m.lora_down.weight": k_down,
        "m.lora_up.weight": k_up,
        "m.alpha": np.asarray(4.0, np.float32),
    })
    plain_rms = measure_lora_effect(no_alpha)["maxRms"]
    alpha_rms = measure_lora_effect(with_alpha)["maxRms"]
    check("kohya layout is measured too", isinstance(plain_rms, float) and plain_rms > 0)
    check("alpha/rank scales the measurement", math.isclose(alpha_rms, plain_rms * 0.5, rel_tol=1e-6))

    # --- unmeasurable / unreadable inputs -----------------------------------
    check("a missing file is unreadable", measure_lora_effect(tmp / "nope.safetensors")["status"] == "unreadable")

    checkpoint = tmp / "checkpoint.safetensors"
    write_safetensors(checkpoint, {"model.diffusion.weight": np.ones((4, 4), np.float32)})
    report = measure_lora_effect(checkpoint)
    check("a checkpoint with no LoRA pairs is unreadable", report["status"] == "unreadable" and report["modules"] == 0)

    conv = tmp / "conv.safetensors"
    write_safetensors(conv, bare_pair("m", np.ones((2, 4, 1, 1), np.float32), np.ones((4, 2, 1, 1), np.float32)))
    report = measure_lora_effect(conv)
    check("4-D (conv) modules are skipped as unsupported", report["skippedUnsupported"] == 1 and report["measured"] == 0)

    mismatched = tmp / "mismatch.safetensors"
    write_safetensors(mismatched, bare_pair("m", np.ones((2, 4), np.float32), np.ones((4, 3), np.float32)))
    check("a rank mismatch is skipped, never transposed into a guess",
          measure_lora_effect(mismatched)["skippedUnsupported"] == 1)

    truncated = tmp / "truncated.safetensors"
    write_safetensors(truncated, bare_pair("m", np.ones((2, 4), np.float32), np.ones((4, 2), np.float32)),
                      truncate_payload=8)
    report = measure_lora_effect(truncated)
    check("a truncated payload is skipped, not measured as garbage", report["measured"] == 0)

    # --- the zero verdict must mean the WHOLE adapter is inert ---------------
    # `zero` is the only status that refuses a render, so it may not be reached
    # from a subset: a module we skipped could carry all the effect.
    zero_plus_skipped = tmp / "zero_plus_conv.safetensors"
    write_safetensors(zero_plus_skipped, {
        **bare_pair("flat", rng.normal(size=(8, 64)).astype(np.float32), np.zeros((64, 8), np.float32)),
        **bare_pair("conv", np.ones((2, 4, 1, 1), np.float32), np.ones((4, 2, 1, 1), np.float32)),
    })
    report = measure_lora_effect(zero_plus_skipped)
    check("a zero module alongside an UNSUPPORTED one does not refuse",
          report["status"] == "ok" and report["skippedUnsupported"] == 1 and report["zeroModules"] == 1)

    zero_plus_nan = tmp / "zero_plus_nan.safetensors"
    write_safetensors(zero_plus_nan, {
        **bare_pair("flat", rng.normal(size=(8, 64)).astype(np.float32), np.zeros((64, 8), np.float32)),
        **bare_pair("bad", rng.normal(size=(8, 64)).astype(np.float32), np.full((64, 8), np.nan, np.float32)),
    })
    report = measure_lora_effect(zero_plus_nan)
    check("a zero module alongside a NON-FINITE one does not refuse",
          report["status"] == "ok" and report["skippedNonFinite"] == 1)

    # A legitimately tiny adapter must not be refused. The Gram form squares the
    # weights twice over, so 1e-20 inputs reach 1e-80 — below float32's floor.
    # Accumulated in float32 this underflows to exactly 0.0 and the adapter is
    # reported `zero`, which BLOCKS the render.
    tiny = tmp / "tiny.safetensors"
    write_safetensors(tiny, bare_pair(
        "m",
        np.full((1, 16), 1e-20, np.float32),
        np.full((16, 1), 1e-20, np.float32),
    ))
    report = measure_lora_effect(tiny)
    check("a tiny-but-real adapter is ok, never underflowed into a zero refusal",
          report["status"] == "ok" and report["maxRms"] > 0)

    # A hybrid adapter whose lora pairs are zeroed but whose effect rides on a
    # DoRA/LyCORIS tensor we cannot multiply out must NOT be refused: `zero`
    # claims the adapter is provably inert, and we did not measure all of it.
    hybrid = tmp / "hybrid_dora.safetensors"
    write_safetensors(hybrid, {
        **bare_pair("m", rng.normal(size=(8, 64)).astype(np.float32), np.zeros((64, 8), np.float32)),
        "m.lora_magnitude_vector": np.full((64,), 1.5, np.float32),
    })
    report = measure_lora_effect(hybrid)
    check("a zeroed pair beside an unmeasurable DoRA tensor does not refuse",
          report["status"] == "ok" and report["skippedUnsupported"] == 1)

    lycoris = tmp / "hybrid_lycoris.safetensors"
    write_safetensors(lycoris, {
        **bare_pair("m", rng.normal(size=(8, 64)).astype(np.float32), np.zeros((64, 8), np.float32)),
        "m.hada_w1_a": np.ones((4, 4), np.float32),
    })
    check("a LyCORIS Hadamard factor also blocks the zero refusal",
          measure_lora_effect(lycoris)["status"] == "ok")

    # --- kohya alpha edge cases ---------------------------------------------
    neg_alpha = tmp / "kohya_negative_alpha.safetensors"
    write_safetensors(neg_alpha, {
        "m.lora_down.weight": k_down,
        "m.lora_up.weight": k_up,
        "m.alpha": np.asarray(-4.0, np.float32),
    })
    neg_rms = measure_lora_effect(neg_alpha)["maxRms"]
    check("a negative alpha yields a magnitude, never a negative RMS",
          neg_rms > 0 and math.isclose(neg_rms, alpha_rms, rel_tol=1e-6))

    nan_alpha = tmp / "kohya_nan_alpha.safetensors"
    write_safetensors(nan_alpha, {
        "m.lora_down.weight": k_down,
        "m.lora_up.weight": k_up,
        "m.alpha": np.asarray(np.nan, np.float32),
    })
    report = measure_lora_effect(nan_alpha)
    check("a non-finite alpha makes the module non-finite, not a scale-1.0 guess",
          report["status"] == "nonfinite" and report["skippedNonFinite"] == 1)

    # --- case-insensitive pairing (server/lib/safetensors.js uses /i) --------
    lower = tmp / "lowercase.safetensors"
    write_safetensors(lower, {
        "blocks.0.lora_a.weight": rng.normal(size=(8, 64)).astype(np.float32),
        "blocks.0.lora_b.weight": rng.normal(size=(64, 8)).astype(np.float32),
    })
    report = measure_lora_effect(lower)
    check("lowercase lora_a/lora_b pairs are measured, not called unreadable",
          report["status"] == "ok" and report["measured"] == 1)

    # --- hostile byte ranges -------------------------------------------------
    # A negative start would seek BACK into the header and measure it as weights.
    negative = tmp / "negative_offset.safetensors"
    header = {
        "m.lora_A.weight": {"dtype": "F32", "shape": [2, 4], "data_offsets": [-32, 0]},
        "m.lora_B.weight": {"dtype": "F32", "shape": [4, 2], "data_offsets": [0, 32]},
    }
    blob = json.dumps(header).encode("utf-8")
    negative.write_bytes(struct.pack("<Q", len(blob)) + blob + b"\0" * 32)
    check("a negative data_offset is refused, never read from the header",
          measure_lora_effect(negative)["measured"] == 0)

    # A range past EOF must not be handed to read() as a giant allocation.
    oversized = tmp / "oversized_offset.safetensors"
    header = {
        "m.lora_A.weight": {"dtype": "F32", "shape": [1, 2_000_000_000], "data_offsets": [0, 8_000_000_000]},
        "m.lora_B.weight": {"dtype": "F32", "shape": [4, 2], "data_offsets": [0, 32]},
    }
    blob = json.dumps(header).encode("utf-8")
    oversized.write_bytes(struct.pack("<Q", len(blob)) + blob + b"\0" * 32)
    check("a byte range past EOF is refused before any read",
          measure_lora_effect(oversized)["measured"] == 0)

    # --- formatting ---------------------------------------------------------
    summary = format_effect(measure_lora_effect(healthy))
    check("format_effect names the statistics", "median RMS" in summary and "module(s)" in summary)
    check("format_effect surfaces a non-ok reason",
          "unreadable" in format_effect(measure_lora_effect(checkpoint)))


with tempfile.TemporaryDirectory() as td:
    run(Path(td))

print()
if FAILS:
    print(f"❌ {len(FAILS)} failed: {', '.join(FAILS)}")
    raise SystemExit(1)
print("✅ all lora_effect_probe tests passed")
