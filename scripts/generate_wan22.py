#!/usr/bin/env python3
"""
PortOS Wan 2.2 MLX helper.

Subprocesses upstream osama-ata/Wan2.2-mlx generate.py from the cloned repo
at --repo-dir. PortOS releases an arg shape it controls (--prompt, --width,
--output) and this helper translates to upstream's --task / --size / --ckpt_dir
form. Done this way (subprocess, not import) because upstream isn't packaged
as a pip module — it's a repo clone whose internal module layout can shift.

Spawned by server/services/videoGen/local.js when model.runtime === 'wan22'.
The STAGE: / STATUS: SSE protocol matches generate_ltx2.py so the JS side
needs no per-runtime parser. Progress hints from upstream tqdm bars are
forwarded as-is — local.js handleLine() already understands the percentage
regex.

EXPERIMENTAL: upstream Wan2.2-mlx CLI surface isn't pinned. If a future
upstream commit renames --task or --ckpt_dir, set the broken flag in
data/media-models.json (`wan22_t2v_a14b`, `wan22_i2v_a14b`) and grep for
this helper to update the translation.
"""

import argparse
import os
import subprocess
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="PortOS Wan 2.2 MLX helper")
    p.add_argument("--repo-dir", required=True, help="Cloned osama-ata/Wan2.2-mlx repo root")
    p.add_argument("--task", required=True, help="t2v-A14B | i2v-A14B")
    p.add_argument("--model-repo", required=True, help="HF repo of the Wan 2.2 weights (Wan-AI/Wan2.2-T2V-A14B etc.)")
    p.add_argument("--prompt", required=True)
    p.add_argument("--width", type=int, required=True)
    p.add_argument("--height", type=int, required=True)
    p.add_argument("--num-frames", type=int, default=81)
    p.add_argument("--steps", type=int, default=25)
    p.add_argument("--guidance", type=float, default=5.0)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--output", required=True)
    p.add_argument("--image", default=None, help="i2v source image path")
    return p.parse_args()


def main() -> int:
    args = parse_args()

    repo_dir = Path(args.repo_dir).expanduser().resolve()
    if not repo_dir.is_dir():
        print(f"❌ Wan 2.2 repo not found at {repo_dir}", file=sys.stderr)
        return 64
    generate_py = repo_dir / "generate.py"
    if not generate_py.exists():
        print(f"❌ {generate_py} missing — upstream layout changed?", file=sys.stderr)
        return 64

    # Upstream caches weights under ~/.cache/huggingface/ on the first run.
    # The --ckpt_dir convention in upstream's README points at a local
    # snapshot, but `huggingface_hub.snapshot_download(model_repo)` resolves
    # to the same canonical cache path either way.
    print(f"STAGE:download-weights:{args.model_repo}", file=sys.stderr, flush=True)
    try:
        from huggingface_hub import snapshot_download
    except Exception as err:
        print(f"❌ huggingface_hub import failed: {err}", file=sys.stderr)
        return 64
    ckpt_dir = snapshot_download(args.model_repo)
    print(f"🔧 wan22: weights ← {ckpt_dir}", file=sys.stderr)

    upstream_args = [
        sys.executable,
        str(generate_py),
        "--task", args.task,
        "--size", f"{args.width}*{args.height}",
        "--ckpt_dir", ckpt_dir,
        "--prompt", args.prompt,
        "--num_frames", str(args.num_frames),
        "--sample_steps", str(args.steps),
        "--sample_guide_scale", str(args.guidance),
        "--base_seed", str(args.seed),
        "--save_file", args.output,
    ]
    if args.image:
        upstream_args.extend(["--image", args.image])

    print(f"STAGE:inference", file=sys.stderr, flush=True)
    print(f"🎬 wan22 generate task={args.task} {args.width}x{args.height} steps={args.steps} seed={args.seed}", file=sys.stderr)

    # cwd = repo_dir so upstream's relative imports work. Forward stderr
    # unchanged — upstream emits tqdm progress bars which local.js's
    # handleLine() already parses for the percentage SSE event.
    proc = subprocess.run(
        upstream_args,
        cwd=str(repo_dir),
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )

    if proc.returncode != 0:
        print(f"❌ wan22 upstream exited {proc.returncode}", file=sys.stderr)
        return proc.returncode

    if not Path(args.output).exists():
        print(f"❌ wan22 finished but {args.output} missing", file=sys.stderr)
        return 1

    print(f"✅ wan22 saved {args.output}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
