#!/usr/bin/env python3
"""Compare H3's two Qwen2-VL image-processor backends on synthetic keyframes (#8867).

The FL2VA reference encodes keyframes with the checkpoint's torchvision
processor; the torch-free MLX runner binds its PIL twin instead. This runs both
on the same deterministic synthetic images, on the CPU, and reports token-grid,
float32 and bfloat16 agreement. It never loads a model or downloads anything.

Run it with an interpreter that has transformers (at the H3 lock's version),
torch and torchvision; see docs/research/minimax-h3-continuity.md.
"""

import argparse
import json
import os
from pathlib import Path
import sys

# A production keyframe is already on a canvas the runner validated: both axes
# multiples of 32 and, at H3's released sizes, far above the processor's
# 65,536-pixel floor. The processor must not resample those. The other cases
# show what resampling would cost if a keyframe ever reached it off-canvas.
CASES = [
    dict(id="canvas-576x1024", width=576, height=1024, production=True),
    dict(id="canvas-768x1344", width=768, height=1344, production=True),
    dict(id="canvas-1344x768", width=1344, height=768, production=True),
    dict(id="canvas-512x288", width=512, height=288, production=True),
    dict(id="raw-1080x1920", width=1080, height=1920, production=False),
    dict(id="raw-720x1280", width=720, height=1280, production=False),
    dict(id="undersized-128x256", width=128, height=256, production=False),
]
# Float32 rounding of (x/255 - 0.5)/0.5 versus the fused (x - 127.5)/127.5.
FLOAT32_TOLERANCE = 1e-6


def synthetic_image(width, height, seed=8867):
    """Left half a smooth gradient, right half full-band noise: the resamplers' worst case."""
    import numpy as np
    from PIL import Image

    y, x = np.mgrid[0:height, 0:width]
    smooth = np.stack([x * 255 // max(width - 1, 1), y * 255 // max(height - 1, 1), (x + y) * 3 % 256], -1)
    noise = np.random.default_rng(seed).integers(0, 256, size=(height, width, 3))
    return Image.fromarray(np.where((x < width // 2)[..., None], smooth, noise).astype(np.uint8), "RGB")


def bfloat16_bits(values):
    """Round float32 to bfloat16 (nearest, ties to even), as `.astype(bfloat16)` does."""
    import numpy as np

    bits = np.ascontiguousarray(values, dtype=np.float32).view(np.uint32).astype(np.uint64)
    return ((bits + 0x7FFF + ((bits >> 16) & 1)) >> 16).astype(np.uint16)


def compare(case, reference, twin, patch_size):
    """One case's agreement; a production case fails on any grid or bfloat16 difference."""
    import numpy as np

    ref_values, twin_values = np.asarray(reference["pixel_values"]), np.asarray(twin["pixel_values"])
    ref_grid = np.asarray(reference["image_grid_thw"]).tolist()
    twin_grid = np.asarray(twin["image_grid_thw"]).tolist()
    _, grid_h, grid_w = ref_grid[0]
    result = {
        **case,
        "reference_grid": ref_grid,
        "twin_grid": twin_grid,
        "resampled": [grid_h * patch_size, grid_w * patch_size] != [case["height"], case["width"]],
        "shapes_match": ref_values.shape == twin_values.shape,
        "parity": False,
    }
    # A differing grid or shape already fails parity; there is nothing to diff.
    if result["shapes_match"] and ref_grid == twin_grid:
        difference = np.abs(ref_values.astype(np.float64) - twin_values.astype(np.float64))
        result.update(
            max_abs=float(difference.max()),
            mean_abs=float(difference.mean()),
            bfloat16_mismatch=float(np.mean(bfloat16_bits(ref_values) != bfloat16_bits(twin_values))),
        )
        result["parity"] = (
            not result["resampled"] and result["max_abs"] <= FLOAT32_TOLERANCE
            and result["bfloat16_mismatch"] == 0
        )
    return result


def run(processor_dir, cases=CASES):
    config = json.loads((processor_dir / "preprocessor_config.json").read_text(encoding="utf-8"))
    declared = config["image_processor_type"]
    import transformers

    # The same derivation generate_minimax_h3.load_pil_image_processor uses.
    reference_class = getattr(transformers, declared.removesuffix("Fast"))
    twin_class = getattr(transformers, declared.removesuffix("Fast") + "Pil")
    reference = reference_class.from_pretrained(str(processor_dir))
    twin = twin_class.from_pretrained(str(processor_dir))
    results = []
    for case in cases:
        image = synthetic_image(case["width"], case["height"])
        results.append(compare(
            case,
            reference(images=[image], return_tensors="np"),
            twin(images=[image], return_tensors="np"),
            config["patch_size"],
        ))
    return {
        "transformers": transformers.__version__,
        "reference_processor": reference_class.__name__,
        "twin_processor": twin_class.__name__,
        "production_parity": all(result["parity"] for result in results if result["production"]),
        "cases": results,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--processor-dir", required=True, type=Path,
                        help="the cached checkpoint's FL2VA/processor directory")
    args = parser.parse_args()
    if not (args.processor_dir / "preprocessor_config.json").is_file():
        raise SystemExit(f"No preprocessor_config.json under {args.processor_dir}; nothing is downloaded.")
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1")
    report = run(args.processor_dir)
    print(json.dumps(report, indent=2))
    return 0 if report["production_parity"] else 1


if __name__ == "__main__":
    sys.exit(main())
