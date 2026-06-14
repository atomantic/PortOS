#!/usr/bin/env python3
"""Standalone tests for train_mflux_lora.py pure helpers (no pytest, no mflux).

Run: ./data/python/venv/bin/python scripts/train_mflux_lora_test.py
Exits non-zero on first failure. Mirrors the runnable-test style of
scripts/generate_ltx2_teacache_test.py.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from train_mflux_lora import (  # noqa: E402
    is_preview_progress_bar,
    compute_effective_total,
    TQDM_RE,
    STEP_LOSS_RE,
)

FAILS = []


def check(name, cond):
    print(("✅" if cond else "❌") + " " + name)
    if not cond:
        FAILS.append(name)


# --- is_preview_progress_bar: the preview/sample bar vs the training bar -------
# Scenario mirrors the live Freydis run: steps=40 (preview denoise), total=600.
PREVIEW, TRAIN = 40, 600

# A preview bar (total == preview_steps, != training_total, no step/loss prose).
check(
    "preview bar (38/40) is detected as preview",
    is_preview_progress_bar("38/40 [00:19<00:01]", 38, 40,
                            has_step_loss=False, preview_steps=PREVIEW, training_total=TRAIN),
)
check(
    "preview bar at completion (40/40) is detected as preview",
    is_preview_progress_bar("40/40 [00:20<00:00]", 40, 40,
                            has_step_loss=False, preview_steps=PREVIEW, training_total=TRAIN),
)

# A training bar (total == training_total) is NOT a preview.
check(
    "training bar (151/600) is NOT preview",
    not is_preview_progress_bar("151/600 [10:00<30:00]", 151, 600,
                                has_step_loss=False, preview_steps=PREVIEW, training_total=TRAIN),
)
check(
    "training bar at a 40-ish step (40/600) is NOT preview (total differs)",
    not is_preview_progress_bar("40/600 [02:00<28:00]", 40, 600,
                                has_step_loss=False, preview_steps=PREVIEW, training_total=TRAIN),
)

# Explicit "step N/M ... loss X" prose is training-only, never a preview, even
# if its total coincidentally equals preview_steps.
check(
    "explicit step/loss prose is never preview",
    not is_preview_progress_bar("step 40/40 loss 0.12", 40, 40,
                                has_step_loss=True, preview_steps=PREVIEW, training_total=TRAIN),
)

# Degenerate case: caller passes preview_steps=None (steps == training_total on a
# tiny dataset) → never filter, so no real training step is ever dropped.
check(
    "preview_steps=None disables filtering",
    not is_preview_progress_bar("40/40 [..]", 40, 40,
                                has_step_loss=False, preview_steps=None, training_total=40),
)

# preview_steps known but training_total unknown (None): filter on total match
# alone — better to risk a missed preview tick than to mislabel, but we still
# catch the common case.
check(
    "training_total=None still filters an exact preview-total match",
    is_preview_progress_bar("12/40 [..]", 12, 40,
                            has_step_loss=False, preview_steps=40, training_total=None),
)

# --- the regexes that feed it --------------------------------------------------
m = TQDM_RE.search("  3%|▎         | 12/400 [00:30<16:20,  2.53s/it]")
check("TQDM_RE parses cur/total", bool(m) and m.group(1) == "12" and m.group(2) == "400")
check("STEP_LOSS_RE matches explicit prose",
      bool(STEP_LOSS_RE.search("steps 40/40 loss 0.12")))
check("STEP_LOSS_RE does NOT match a bare tqdm bar",
      STEP_LOSS_RE.search("38/40 [00:19<00:01]") is None)

# --- compute_effective_total sanity (unchanged behavior) -----------------------
# 25 images, batch 1, 24 epochs → 600 (the Freydis config).
import tempfile, os  # noqa: E402
with tempfile.TemporaryDirectory() as d:
    for i in range(25):
        Path(d, f"{i:04d}.png").write_bytes(b"x")
    cfg = {"training_loop": {"num_epochs": 24, "batch_size": 1}, "data": d}
    check("compute_effective_total(25 img,24 ep,batch 1) == 600",
          compute_effective_total(cfg, 999) == 600)

# Unexpected shape → falls back to the requested count.
check("compute_effective_total falls back on bad config",
      compute_effective_total({}, 777) == 777)

print()
if FAILS:
    print(f"❌ {len(FAILS)} failure(s): {FAILS}")
    sys.exit(1)
print("✅ all train_mflux_lora helper tests passed")
