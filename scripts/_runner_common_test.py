#!/usr/bin/env python3
"""Standalone tests for _runner_common.py pure helpers (no pytest, no torch).

Run: ./data/python/venv/bin/python scripts/_runner_common_test.py
(or any python3 — the helpers under test defer the torch/PIL imports).
Exits non-zero on first failure. Mirrors the runnable-test style of
scripts/train_mflux_lora_test.py.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _runner_common import (  # noqa: E402
    apply_memory_optimizations,
    set_vae_tiling,
    _VAE_TILING_MIN_PIXELS,
)

FAILS = []


def check(name, cond):
    print(("✅" if cond else "❌") + " " + name)
    if not cond:
        FAILS.append(name)


class _PipeRecorder:
    """Modern pipeline: exposes the pipe-level tiling toggles and the slicing
    knobs, records every call. `vae=None` so the pipe-level path wins."""

    vae = None

    def __init__(self):
        self.calls = []

    def enable_attention_slicing(self):
        self.calls.append("attention_slicing")

    def enable_vae_slicing(self):
        self.calls.append("vae_slicing")

    def enable_vae_tiling(self):
        self.calls.append("enable_vae_tiling")

    def disable_vae_tiling(self):
        self.calls.append("disable_vae_tiling")


class _Vae:
    def __init__(self, calls):
        self._calls = calls

    def enable_tiling(self):
        self._calls.append("vae.enable_tiling")

    def disable_tiling(self):
        self._calls.append("vae.disable_tiling")


class _VaeSurfaceRecorder:
    """Older pipeline: no pipe-level tiling toggles, only the VAE's own — so
    apply_memory_optimizations must fall back to vae.enable/disable_tiling."""

    def __init__(self):
        self.calls = []
        self.vae = _Vae(self.calls)

    def enable_attention_slicing(self):
        self.calls.append("attention_slicing")

    def enable_vae_slicing(self):
        self.calls.append("vae_slicing")


class _BareRecorder:
    """Pipeline with no tiling surface at all (and no vae) — must not crash."""

    vae = None

    def __init__(self):
        self.calls = []

    def enable_attention_slicing(self):
        self.calls.append("attention_slicing")

    def enable_vae_slicing(self):
        self.calls.append("vae_slicing")


# --- slicing is always applied regardless of size ---------------------------
p = _PipeRecorder()
apply_memory_optimizations(p, width=576, height=1024)
check("attention slicing always applied", "attention_slicing" in p.calls)
check("vae slicing always applied", "vae_slicing" in p.calls)

# --- small render (the z-image 576×1024 bug case) → tiling OFF ---------------
p = _PipeRecorder()
apply_memory_optimizations(p, width=576, height=1024)
check("576×1024 does NOT enable tiling", "enable_vae_tiling" not in p.calls)
check("576×1024 explicitly disables tiling", "disable_vae_tiling" in p.calls)

# largest native-runner preset (Qwen experimental) stays untiled
p = _PipeRecorder()
apply_memory_optimizations(p, width=1328, height=2048)
check("1328×2048 (largest preset) does NOT enable tiling", "enable_vae_tiling" not in p.calls)

# --- large render → tiling ON ------------------------------------------------
p = _PipeRecorder()
apply_memory_optimizations(p, width=3840, height=3840)
check("3840×3840 enables tiling", "enable_vae_tiling" in p.calls)
check("3840×3840 does NOT disable tiling", "disable_vae_tiling" not in p.calls)
check("  ...and 3840×3840 is over the area floor", 3840 * 3840 > _VAE_TILING_MIN_PIXELS)

# just under vs just over the area floor
p = _PipeRecorder()
apply_memory_optimizations(p, width=2560, height=2560)  # == floor, not over
check("area == floor does NOT enable tiling", "enable_vae_tiling" not in p.calls)

# --- back-compat: no dims → tiling stays ON (old behavior) -------------------
p = _PipeRecorder()
apply_memory_optimizations(p)
check("no width/height → tiling stays ON (back-compat)", "enable_vae_tiling" in p.calls)

# --- older vae-level toggle path (no pipe-level enable_vae_tiling) -----------
p = _VaeSurfaceRecorder()
apply_memory_optimizations(p, width=576, height=1024)
check("vae-surface small render disables via vae.disable_tiling", "vae.disable_tiling" in p.calls)
check("vae-surface small render does NOT enable via vae.enable_tiling", "vae.enable_tiling" not in p.calls)

p = _VaeSurfaceRecorder()
apply_memory_optimizations(p, width=3840, height=3840)
check("vae-surface large render enables via vae.enable_tiling", "vae.enable_tiling" in p.calls)

# --- pipeline with no tiling surface at all → no crash -----------------------
p = _BareRecorder()
apply_memory_optimizations(p, width=576, height=1024)
check("no tiling surface → slicing still applied, no crash", p.calls == ["attention_slicing", "vae_slicing"])

# --- set_vae_tiling directly (shared by the i2i paths) -----------------------
p = _PipeRecorder()
set_vae_tiling(p, False)
check("set_vae_tiling(False) prefers pipe-level disable", p.calls == ["disable_vae_tiling"])
p = _PipeRecorder()
set_vae_tiling(p, True)
check("set_vae_tiling(True) prefers pipe-level enable", p.calls == ["enable_vae_tiling"])
p = _VaeSurfaceRecorder()
set_vae_tiling(p, False)
check("set_vae_tiling(False) falls back to vae.disable_tiling", p.calls == ["vae.disable_tiling"])
p = _BareRecorder()
set_vae_tiling(p, False)
check("set_vae_tiling on bare pipe is a no-op (no crash)", p.calls == [])


if FAILS:
    print(f"\n❌ {len(FAILS)} test(s) failed:")
    for f in FAILS:
        print(f"   - {f}")
    sys.exit(1)
print("\n✅ all _runner_common tests passed")
