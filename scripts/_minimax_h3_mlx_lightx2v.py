"""PortOS-owned MLX LightX2V contract; no reference runner or weight fusion.

The pinned scheduler uses N sigma points for N-1 data-ward Euler updates.
Changing the two config shifts preserves that scheduler's timestep/sign contract.
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

CONTRACT = json.loads((Path(__file__).resolve().parents[1] / "server/lib/minimaxH3Lightx2vMlx.json").read_text())
SOURCE_DIGESTS = {
    "scheduler.py": "3966866aeba746fa79a64b9d598e312d8445b56a11380fdaf23bf908f1dce063",
    "pipeline.py": "99ec295258ece66d0076838bf29e7eb3b0a1a20f5e8d401739459fcd054e0bc1",
    "config.py": "9992a243a374ede1e072f6211652875d5985eacf82a76e4301162e4fcd9dee9f",
}


def file_digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify_runtime_source(runtime_dir, revision):
    """Refuse changed schedule seams before any multi-GB model load."""
    if revision != CONTRACT["runtimeRevision"]:
        raise ValueError("MLX LightX2V requires its pinned runtime revision.")
    for name, digest in SOURCE_DIGESTS.items():
        path = Path(runtime_dir) / "minimax_h3_mlx" / name
        if not path.is_file() or file_digest(path) != digest:
            raise ValueError(f"MLX LightX2V pinned {name} seam differs; use Repair in Video Gen.")


def validate_profile_args(args, contract=None):
    """Validate direct helper calls as well as the server admission boundary."""
    contract = contract or CONTRACT
    profile = getattr(args, "speed_profile", None)
    adapter = getattr(args, "speed_adapter", None)
    if not profile:
        if adapter:
            raise ValueError("A speed adapter requires its explicit MLX speed profile.")
        return
    if (profile != contract["id"] or args.model_repo != contract["model"]["repo"]
            or args.model_revision != contract["model"]["revision"]
            or args.steps != contract["steps"] or [args.width, args.height] not in contract["canvases"]
            or len(args.image) > 1 or (args.image and args.anchor != ["first"])
            or getattr(args, "source_video", None)):
        raise ValueError("MLX speed profile requires its pinned INT8 model, schedule, supported canvas and text/first-image input only.")
    checkpoint = contract["checkpoint"]
    if (args.checkpoint_repo != checkpoint["repo"]
            or args.checkpoint_revision != checkpoint["revision"]
            or len(args.checkpoint_file) != len(checkpoint["files"])
            or set(args.checkpoint_file) != set(checkpoint["files"])):
        raise ValueError("MLX LightX2V requires the complete pinned auxiliary checkpoint manifest.")
    verify_runtime_source(args.runtime_dir, args.runtime_revision)
    if not adapter or file_digest(adapter) != contract["adapter"]["sha256"]:
        raise ValueError("MLX LightX2V requires its original SHA-256-verified cached adapter.")
    for name, expected in contract["adapter"].get("supportFiles", {}).items():
        if file_digest(Path(adapter).parent.parent / name) != expected:
            raise ValueError("MLX speed profile manifest, license or notice differs.")
    digests = [contract["adapter"]["sha256"]]
    for path in args.lora:
        digest = file_digest(path)
        if digest in digests:
            raise ValueError("MLX LightX2V refuses duplicate adapters, including a speed adapter supplied as a user LoRA.")
        digests.append(digest)


def adapter_spec(path):
    return {"path": path, "scale": 1.0}


def configure_pipeline(pipe):
    """Set independent shifts before the existing pipeline builds its caches."""
    pipe.config.sigma_shift_video = CONTRACT["videoShift"]
    pipe.config.sigma_shift_audio = CONTRACT["audioShift"]
    video, audio = pipe._build_schedules(CONTRACT["steps"])
    if len(video.timesteps) != CONTRACT["denoisingSteps"] or len(audio.timesteps) != CONTRACT["denoisingSteps"]:
        raise ValueError("MLX LightX2V scheduler did not produce exactly four updates.")
    return {"videoSigmas": video.sigmas.tolist(), "audioSigmas": audio.sigmas.tolist()}


def emit_report(args, schedules, result, elapsed, peak_bytes, cold_load_seconds, contract=None):
    contract = contract or CONTRACT
    report = {
        "id": contract["id"], "type": contract["type"], "applied": True,
        "degraded": [], "fallback": False, "adapter": contract["adapter"],
        "sigmaPoints": contract["sigmaPoints"], "denoisingSteps": contract["denoisingSteps"],
        "videoShift": contract["videoShift"], "audioShift": contract["audioShift"],
        "runtimeRevision": args.runtime_revision,
        "inferenceSeconds": result.seconds_per_step * contract["denoisingSteps"],
        "pipelineSeconds": elapsed, "coldLoadSeconds": cold_load_seconds,
        "peakMemoryScope": "pipeline call including conditioning, denoising and decode",
        "peakAllocatedMb": peak_bytes / 1e6, **schedules,
    }
    print("SPEEDPROFILE:" + json.dumps(report), file=sys.stderr, flush=True)


if __name__ == "__main__":
    if len(sys.argv) != 4 or sys.argv[1] != "--probe":
        raise SystemExit("usage: _minimax_h3_mlx_lightx2v.py --probe RUNTIME_DIR REVISION")
    verify_runtime_source(sys.argv[2], sys.argv[3])
