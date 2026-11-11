#!/usr/bin/env python3
"""Stable PortOS wrapper for the pinned MLX-Gen Wan 2.2 CLI.

The runner is intentionally cache-only. PortOS downloads the base model and
exact Lightning files through the Video Gen UI before this helper is launched;
MLX-Gen returns a typed download-required failure if anything is absent.
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

# Same-dir sibling import (mirrors generate_ltx2.py). _runner_common is
# stdlib-only at import time, so this is safe from the wan2.2-mlx venv.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _runner_common import emit_runtime_fingerprint, establish_process_group  # noqa: E402


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="PortOS Wan 2.2 MLX helper")
    p.add_argument("--model-repo", required=True)
    p.add_argument("--prompt", required=True)
    p.add_argument("--width", type=int, required=True)
    p.add_argument("--height", type=int, required=True)
    p.add_argument("--num-frames", type=int, default=81)
    p.add_argument("--fps", type=int, default=16)
    p.add_argument("--steps", type=int, default=25)
    p.add_argument("--guidance", type=float, default=5.0)
    p.add_argument("--guidance-2", type=float, default=None)
    p.add_argument("--flow-shift", type=float, default=None)
    p.add_argument("--solver", choices=("unipc", "euler"), default=None)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--output", required=True)
    p.add_argument("--image", default=None)
    p.add_argument("--negative-prompt", default="")
    p.add_argument("--lora-path", action="append", default=[])
    p.add_argument("--lora-target-role", action="append", default=[])
    return p.parse_args()


def main() -> int:
    args = parse_args()

    # Runtime fingerprint at startup — recorded by PortOS so output can be tied
    # to a specific wan/mlx/torch stack on this chip.
    emit_runtime_fingerprint("wan22", ["mlx-gen", "mlx", "mlx_metal", "huggingface-hub"])

    upstream_args = [
        sys.executable,
        "-m", "mflux.models.wan.cli.wan_generate",
        "--json-events",
        "--low-ram",
        "--model", args.model_repo,
        "--prompt", args.prompt,
        "--width", str(args.width),
        "--height", str(args.height),
        "--frames", str(args.num_frames),
        "--fps", str(args.fps),
        "--steps", str(args.steps),
        "--guidance", str(args.guidance),
        "--seed", str(args.seed),
        "--output", args.output,
    ]
    if args.negative_prompt:
        upstream_args.extend(["--negative-prompt", args.negative_prompt])
    if args.guidance_2 is not None:
        upstream_args.extend(["--guidance-2", str(args.guidance_2)])
    if args.flow_shift is not None:
        upstream_args.extend(["--flow-shift", str(args.flow_shift)])
    if args.solver:
        upstream_args.extend(["--solver", args.solver])
    if args.image:
        upstream_args.extend(["--image-path", args.image])
    if args.lora_path:
        upstream_args.extend(["--lora-paths", *args.lora_path])
    if args.lora_target_role:
        upstream_args.extend(["--lora-target-roles", *args.lora_target_role])

    print(f"STAGE:inference", file=sys.stderr, flush=True)
    print(f"🎬 wan22 generate {args.width}x{args.height} steps={args.steps} seed={args.seed}", file=sys.stderr)

    # PortOS cancels this wrapper by process group so the MLX-Gen subprocess
    # cannot survive as an orphan while holding unified memory. Establish the
    # group before spawning it; the detached launcher records this wrapper PID.
    establish_process_group()

    # Human diagnostics remain on inherited stderr. JSONL progress on stdout
    # is translated into PortOS's existing STAGE:/STATUS: protocol below.
    proc = subprocess.Popen(
        upstream_args,
        stdout=subprocess.PIPE,
        text=True,
    )
    assert proc.stdout is not None
    for raw in proc.stdout:
        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            print(raw.rstrip(), file=sys.stderr, flush=True)
            continue
        phase = str(event.get("phase", "working"))
        step = event.get("step")
        total = event.get("total_steps")
        if isinstance(step, int) and isinstance(total, int) and total > 0:
            print(f"STAGE:wan-{phase}:step:{step}:{total}:{phase}", file=sys.stderr, flush=True)
        else:
            print(f"STATUS:Wan {phase}", file=sys.stderr, flush=True)
        remediation = event.get("remediation")
        if isinstance(remediation, dict) and remediation.get("kind") == "download-required":
            repo = remediation.get("repo_id") or args.model_repo
            print(f"❌ Required Wan weight is not cached: {repo}. Use Download in Video Gen.", file=sys.stderr, flush=True)
    return_code = proc.wait()

    if return_code != 0:
        print(f"❌ wan22 upstream exited {return_code}", file=sys.stderr)
        return return_code

    if not Path(args.output).exists():
        print(f"❌ wan22 finished but {args.output} missing", file=sys.stderr)
        return 1

    print(f"✅ wan22 saved {args.output}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
