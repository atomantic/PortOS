#!/usr/bin/env python3
"""Reproduce #8867 without private inputs. Planning never loads a model.

Run with the installed H3 Python. --run performs three expensive sequential
renders; see docs/research/minimax-h3-continuity.md for limits and interpretation.
"""

import argparse
from collections import Counter
import json
import os
from pathlib import Path
import subprocess
import sys
import time


# These pins define this experiment, independently of later registry updates.
RUNTIME_REVISION = "fcd9e9b79a1d6018d91ac477c0968de1fa067e49"
MODEL_REVISION = "3ac52081470b0488921c3ec3ba84a39097bf2361"
CHECKPOINT_REVISION = "6818f6c32d12b210915e44ad56a4228c2608f160"
MOTION_PROMPT = "The camera slowly moves forward. Objects remain stationary."
CONFLICT_PROMPT = "The camera slowly moves forward through a snowy pine forest at night."
SAMPLES = [0, 1, 12, 60, 123]


def write_source(path):
    """Stdlib-only PPM: colored room, red doorway, yellow cube, green ball."""
    width, height = 768, 1344
    pixels = bytearray()
    for y in range(height):
        for x in range(width):
            color = (60, 180, 220) if y < 900 else (120, 60, 160)
            if 70 < x < 300 and 200 < y < 900:
                color = (210, 40, 50)
            if 390 < x < 610 and 730 < y < 950:
                color = (240, 200, 30)
            if (x - 250) ** 2 + (y - 1080) ** 2 < 100 ** 2:
                color = (40, 210, 70)
            pixels.extend(color)
    path.write_bytes(f"P6\n{width} {height}\n255\n".encode() + pixels)


def experiment_cases():
    return [
        dict(id="small-motion", width=576, height=1024, prompt=MOTION_PROMPT),
        dict(id="native-motion", width=768, height=1344, prompt=MOTION_PROMPT),
        dict(id="native-conflict", width=768, height=1344, prompt=CONFLICT_PROMPT),
    ]


def runner_arguments(case, directory, runtime):
    return [
        "--runtime-dir", str(runtime), "--runtime-revision", RUNTIME_REVISION,
        "--model-repo", "pipenetwork/MiniMax-H3-MLX-8bit", "--model-revision", MODEL_REVISION,
        "--checkpoint-repo", "MiniMaxAI/MiniMax-H3", "--checkpoint-revision", CHECKPOINT_REVISION,
        "--checkpoint-file", "FL2VA/model_index.json",
        "--prompt", case["prompt"], "--width", str(case["width"]), "--height", str(case["height"]),
        "--num-frames", "124", "--fps", "24", "--steps", "9", "--seed", "42",
        "--image", str(directory / "source.ppm"), "--anchor", "first",
        "--min-system-memory-gb", "128", "--memory-headroom-gb", "16",
        "--output", str(directory / case["id"] / "video.mp4"),
    ]


def instrument(pipe, report, clock=time.perf_counter):
    """Observe the actual patched encoder and pinned pipeline, without changing tensors."""
    encode = pipe.text_encoder.encode
    keyframes = pipe._encode_keyframes
    dit = pipe.dit

    def encode_observed(prompt, images=None, *args, **kwargs):
        result = encode(prompt, images, *args, **kwargs)
        features, tags = result
        report["vision_conditioning"] = {
            "embedding_shape": list(features.shape),
            "token_tag_counts": dict(Counter(str(tag) for tag in tags.tolist())),
        }
        if images:
            # Which backend read the keyframes (the torch-free runner binds the
            # PIL twin), and at what size: a canvas-sized input is the one both
            # backends process identically.
            report["vision_processor"] = {
                "class": type(pipe.text_encoder.processor.image_processor).__name__,
                "input_sizes": [list(image.size) for image in images],
            }
        return result

    def keyframes_observed(*args, **kwargs):
        rows = keyframes(*args, **kwargs)
        report["vae_conditioning_shape"] = list(rows.shape)
        return rows

    # The pinned pipeline invokes DiT positionally. Keep its module attributes
    # visible for preview/packing access while observing only the first call.
    class ObservedDiT:
        def __getattr__(self, name):
            return getattr(dit, name)

        def __call__(self, *args, **kwargs):
            if "packed_conditioning" not in report:
                report["packed_conditioning"] = {
                    "video_shape": list(args[0].shape),
                    "audio_shape": list(args[1].shape),
                    "position_shape": list(args[6].shape),
                    "token_tag_counts": dict(Counter(str(tag) for tag in args[5].tolist())),
                    "video_indices": int(args[7].size),
                    "audio_indices": int(args[8].size),
                    "text_indices": int(args[9].size),
                }
            return dit(*args, **kwargs)

    pipe.text_encoder.encode = encode_observed
    pipe._encode_keyframes = keyframes_observed
    pipe.dit = ObservedDiT()
    originals = {}
    for name in ("_decode_video", "_decode_audio"):
        original = getattr(pipe, name)
        originals[name] = original

        def timed_decode(*args, _original=original, _name=name, **kwargs):
            started = clock()
            try:
                return _original(*args, **kwargs)
            finally:
                report["timings"][_name.removeprefix("_") + "_seconds"] = clock() - started

        setattr(pipe, name, timed_decode)

    def restore():
        pipe.text_encoder.encode = encode
        pipe._encode_keyframes = keyframes
        pipe.dit = dit
        for name, original in originals.items():
            setattr(pipe, name, original)

    return restore


def run_worker(case, directory, runtime):
    import generate_minimax_h3 as runner

    started = time.perf_counter()
    report = {"case": case, "status": "failed", "continuity": "not_assessed", "timings": {}}
    original = runner.render_outputs

    def observed(pipe, args, images, save_mp4, batch_seeds=None):
        report["timings"]["setup_seconds"] = time.perf_counter() - started
        restore = instrument(pipe, report)
        render_started = time.perf_counter()
        mux_seconds = 0

        def timed_save(*save_args):
            nonlocal mux_seconds
            mux_started = time.perf_counter()
            try:
                return save_mp4(*save_args)
            finally:
                mux_seconds += time.perf_counter() - mux_started

        try:
            return original(pipe, args, images, timed_save, batch_seeds)
        finally:
            timings = report["timings"]
            timings["mux_seconds"] = mux_seconds
            timings["inference_and_conditioning_seconds"] = (
                time.perf_counter() - render_started - mux_seconds
                - timings.get("decode_video_seconds", 0) - timings.get("decode_audio_seconds", 0)
            )
            restore()

    runner.render_outputs = observed
    sys.argv = [str(Path(runner.__file__))] + runner_arguments(case, directory, runtime)
    try:
        runner.main()
        report["status"] = "rendered"
    finally:
        runner.render_outputs = original
        report["timings"]["total_seconds"] = time.perf_counter() - started
        (directory / case["id"] / "report.json").write_text(json.dumps(report, indent=2) + "\n")


def run_cases(directory, runtime, cases, run=subprocess.run):
    """Fresh processes release all weights between cases; stop at the first failure."""
    for case in cases:
        target = directory / case["id"]
        target.mkdir()
        with (target / "runtime.log").open("w") as log:
            run([sys.executable, str(Path(__file__).resolve()), "--output-dir", str(directory),
                 "--runtime-dir", str(runtime), "--worker", case["id"]],
                stdout=log, stderr=subprocess.STDOUT, check=True,
                env={**os.environ, "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"})
        for frame in SAMPLES:
            run(["ffmpeg", "-v", "error", "-i", str(target / "video.mp4"),
                 "-vf", f"select=eq(n\\,{frame})", "-frames:v", "1",
                 str(target / f"frame-{frame:03d}.png")], check=True)
            if not (target / f"frame-{frame:03d}.png").is_file():
                raise RuntimeError(f"Missing sampled frame {frame} for {case['id']}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True, type=Path, help="new scratch directory outside the repository")
    parser.add_argument("--runtime-dir", type=Path, default=Path.home() / ".portos/minimax-h3-mlx")
    parser.add_argument("--run", action="store_true", help="perform all three multi-hour comparisons sequentially")
    parser.add_argument("--worker", choices=[case["id"] for case in experiment_cases()], help=argparse.SUPPRESS)
    args = parser.parse_args()
    directory = args.output_dir.resolve()
    cases = experiment_cases()
    if args.worker:
        return run_worker(next(case for case in cases if case["id"] == args.worker), directory, args.runtime_dir)
    directory.mkdir(parents=True, exist_ok=False)
    write_source(directory / "source.ppm")
    (directory / "plan.json").write_text(json.dumps({
        "cases": cases, "seed": 42, "frames": 124, "fps": 24, "steps": 9,
        "sample_frames": SAMPLES, "runtime_revision": RUNTIME_REVISION,
        "model_revision": MODEL_REVISION, "checkpoint_revision": CHECKPOINT_REVISION,
        "continuity": "not_assessed", "ltx_comparison": "pending",
    }, indent=2) + "\n")
    if args.run:
        run_cases(directory, args.runtime_dir, cases)
    print("Comparison rendered; inspect sampled frames." if args.run else "Plan and synthetic source written; no models loaded.")


if __name__ == "__main__":
    main()
