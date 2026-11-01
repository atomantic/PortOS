"""Pika FL2VA's pinned six-forward re-noise method on PortOS's upstream MLX runner.

Manifest: Pika-Labs/Pika-H3-Flex@0ddf55ad, fl2va/manifest.json.
No Phosphene runner, converted weights, or upstream source modifications are used.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import MethodType

import _minimax_h3_mlx_lightx2v as shared

CONTRACT = json.loads((Path(__file__).resolve().parents[1] / "server/lib/minimaxH3FlexMlx.json").read_text())


def validate_profile_args(args):
    shared.validate_profile_args(args, CONTRACT)


def adapter_spec(path):
    import mlx.core as mx

    # The original Pika adapter is F32 and has no alpha metadata. Its manifest
    # specifies alpha=rank=128 and its own loader uses BF16, unlike LightX2V's
    # alpha=8 default. Apply those properties to this verified adapter alone.
    return {"path": path, "scale": 1.0, "alpha": CONTRACT["adapter"]["alpha"], "dtype": mx.bfloat16}


def build_schedule(scheduler_type, shift):
    import mlx.core as mx
    import numpy as np

    scheduler = scheduler_type(shift=shift)
    base = np.array(CONTRACT["sigmaKnots"], dtype=np.float32) / np.float32(1000)
    shifted = np.float32(shift) * base / (np.float32(1) + np.float32(shift - 1) * base)
    scheduler.set_timesteps(sigmas=shifted.tolist())

    def renoise_step(self, model_output, timestep, sample):
        if self._step_index is None:
            self._step_index = self.index_for_timestep(timestep)
        # H3 predicts data-ward velocity in t=1-sigma convention. Fresh noise
        # replaces Euler's blend with the old sample at each nonterminal knot.
        sigma = float(np.float32(1) - np.float32(timestep))
        denoised = sample.astype(mx.float32) + sigma * model_output.astype(mx.float32)
        following = float(self.sigmas[self._step_index + 1].item())
        self._step_index += 1
        if following == 0:
            return denoised.astype(sample.dtype)
        noise = mx.random.normal(sample.shape).astype(mx.float32)
        return ((1 - following) * denoised + following * noise).astype(sample.dtype)

    scheduler.step = MethodType(renoise_step, scheduler)
    return scheduler


def configure_pipeline(pipe):
    from minimax_h3_mlx.scheduler import MiniMaxH3Scheduler

    def schedules(_pipe, points):
        if points != CONTRACT["steps"]:
            raise ValueError("Pika H3 Flex requires exactly six denoising updates.")
        return tuple(build_schedule(MiniMaxH3Scheduler, shift)
                     for shift in (CONTRACT["videoShift"], CONTRACT["audioShift"]))

    pipe._build_schedules = MethodType(schedules, pipe)
    video, audio = pipe._build_schedules(CONTRACT["steps"])
    return {"videoSigmas": video.sigmas.tolist(), "audioSigmas": audio.sigmas.tolist(),
            "sampler": CONTRACT["sampler"], "sigmaKnots": CONTRACT["sigmaKnots"]}


def emit_report(args, schedules, result, elapsed, peak_bytes, cold_load_seconds):
    shared.emit_report(args, schedules, result, elapsed, peak_bytes, cold_load_seconds, CONTRACT)


def probe(runtime_dir, revision):
    shared.verify_runtime_source(runtime_dir, revision)
    spec = importlib.util.spec_from_file_location("pinned_h3_scheduler", Path(runtime_dir) / "minimax_h3_mlx/scheduler.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    import mlx.core as mx

    for shift in (CONTRACT["videoShift"], CONTRACT["audioShift"]):
        scheduler = build_schedule(module.MiniMaxH3Scheduler, shift)
        sample = mx.zeros((1,))
        for timestep in scheduler.timesteps.tolist():
            sample = scheduler.step(mx.ones((1,)), timestep, sample)
        mx.eval(sample)
        if scheduler.step_index != CONTRACT["denoisingSteps"]:
            raise ValueError("Pika H3 Flex scheduler capability probe failed.")


if __name__ == "__main__":
    if len(sys.argv) != 4 or sys.argv[1] != "--probe":
        raise SystemExit("usage: _minimax_h3_mlx_flex.py --probe RUNTIME_DIR REVISION")
    probe(sys.argv[2], sys.argv[3])
