#!/usr/bin/env python3
"""Standalone tests for _runner_common.py pure helpers (no pytest, no torch).

Run: ./data/python/venv/bin/python scripts/_runner_common_test.py
(or any python3 — the helpers under test defer the torch/PIL imports).
Exits non-zero on first failure. Mirrors the runnable-test style of
scripts/train_mflux_lora_test.py.
"""
import os
import sys
from pathlib import Path

# ✅/❌ are cp1252-unencodable on a Windows console, which would abort the run
# before the first result printed — these runners are used on CUDA/Windows too.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _runner_common as runner_common  # noqa: E402
from _runner_common import (  # noqa: E402
    apply_memory_optimizations,
    choose_cuda_pipeline_placement,
    empty_device_cache,
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


# --- shared live-VRAM placement decision ------------------------------------
class _FakeCudaMemory:
    def __init__(self, free_gb, total_gb):
        self.free_gb = free_gb
        self.total_gb = total_gb

    def mem_get_info(self):
        gb = 1024 ** 3
        return self.free_gb * gb, self.total_gb * gb


class _PlacementTorch:
    def __init__(self, free_gb, total_gb):
        self.cuda = _FakeCudaMemory(free_gb, total_gb)


_original_weight_bytes = runner_common._pipeline_weight_bytes
runner_common._pipeline_weight_bytes = lambda _pipe: 20 * 1024 ** 3
try:
    os.environ.pop("PORTOS_TEST_OFFLOAD", None)
    _fits = choose_cuda_pipeline_placement(
        object(), _PlacementTorch(24, 24), override_env="PORTOS_TEST_OFFLOAD",
        offload_vram_fraction=None, log_label="test",
    )
    check("placement keeps full CUDA when weights plus reserve fit", not _fits["use_offload"])

    _low_free = choose_cuda_pipeline_placement(
        object(), _PlacementTorch(22, 24), override_env="PORTOS_TEST_OFFLOAD",
        offload_vram_fraction=None, log_label="test",
    )
    check("placement offloads when live free VRAM lacks the reserve", _low_free["use_offload"])

    os.environ["PORTOS_TEST_OFFLOAD"] = "0"
    _forced_full = choose_cuda_pipeline_placement(
        object(), _PlacementTorch(8, 24), override_env="PORTOS_TEST_OFFLOAD",
        offload_vram_fraction=None, log_label="test",
    )
    check("pipeline-specific override can force full CUDA", not _forced_full["use_offload"])
finally:
    os.environ.pop("PORTOS_TEST_OFFLOAD", None)
    runner_common._pipeline_weight_bytes = _original_weight_bytes


# --- empty_device_cache: dispatches on the RESOLVED device, not on capability -
# `empty_device_cache` defers its `import torch`, so a stub in sys.modules is
# enough to observe the dispatch without needing real torch (or a GPU).


class _FakeBackend:
    def __init__(self):
        self.emptied = self.synced = 0

    def empty_cache(self):
        self.emptied += 1

    def synchronize(self):
        self.synced += 1


class _FakeTorch:
    def __init__(self):
        self.cuda = _FakeBackend()
        self.mps = _FakeBackend()


def _clear(device, **kw):
    """Run empty_device_cache against a stub torch; return it for assertions."""
    fake = _FakeTorch()
    saved = sys.modules.get("torch")
    sys.modules["torch"] = fake
    try:
        empty_device_cache(device, **kw)
    finally:
        if saved is None:
            del sys.modules["torch"]
        else:
            sys.modules["torch"] = saved
    return fake


_cuda = _clear("cuda")
check("empty_device_cache('cuda') clears the CUDA cache", _cuda.cuda.emptied == 1)
check("empty_device_cache('cuda') leaves MPS alone", _cuda.mps.emptied == 0)

_mps = _clear("mps")
check("empty_device_cache('mps') clears the MPS cache", _mps.mps.emptied == 1)
check("empty_device_cache('mps') leaves CUDA alone", _mps.cuda.emptied == 0)

# The resolved-device predicate is the point: a `--device cpu` run on a machine
# that HAS a CUDA card must not clear a cache this process never filled.
_cpu = _clear("cpu")
check("empty_device_cache('cpu') clears nothing",
      _cpu.cuda.emptied == 0 and _cpu.mps.emptied == 0)

check("empty_device_cache does not synchronize by default", _clear("cuda").cuda.synced == 0)
check("empty_device_cache(synchronize=True) drains the queue",
      _clear("cuda", synchronize=True).cuda.synced == 1)

if FAILS:
    print(f"\n❌ {len(FAILS)} test(s) failed:")
    for f in FAILS:
        print(f"   - {f}")
    sys.exit(1)
print("\n✅ all _runner_common tests passed")
