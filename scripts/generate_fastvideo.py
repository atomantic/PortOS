#!/usr/bin/env python3
"""PortOS FastVideo MLX helper for Apple Silicon.

Spawns the pinned FastVideo inference script from the ~/.portos/fastvideo
checkout. Generation is cache-only: PortOS downloads model weights through
the Video Gen UI before launching this helper.
"""

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

# Same-dir sibling import. _runner_common is stdlib-only at import time.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _runner_common import emit_runtime_fingerprint, establish_process_group  # noqa: E402


_DENOISE_STEP_PATTERN = re.compile(
    r'\bdenois(?:e|ing)\s+step\s*(\d+)\s*/\s*(\d+)\b', re.IGNORECASE,
)
_PERCENT_PATTERN = re.compile(r'\d+%')


def translate_line(line: str) -> str:
    """Translate one upstream output line into PortOS's progress protocol."""
    step_match = _DENOISE_STEP_PATTERN.search(line)
    if step_match:
        cur, total = int(step_match.group(1)), int(step_match.group(2))
        return f"STAGE:fastvideo:step:{cur}:{total}:denoising step {cur}/{total}"
    if _PERCENT_PATTERN.search(line):
        return f"STATUS:FastVideo: {line}"
    if "loading" in line.lower() or "encoding" in line.lower():
        return f"STATUS:{line}"
    return line


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="PortOS FastVideo MLX helper")
    p.add_argument("--repo-dir", default=None, help="Path to cloned FastVideo repo")
    p.add_argument("--model-root", required=True, help="HF model snapshot path")
    p.add_argument("--mlx-checkpoint", default=None, help="MLX checkpoint path (defaults to model-root)")
    p.add_argument("--prompt", required=True)
    p.add_argument("--negative-prompt", default="")
    p.add_argument("--width", type=int, required=True)
    p.add_argument("--height", type=int, required=True)
    p.add_argument("--num-frames", type=int, default=81)
    p.add_argument("--fps", type=int, default=16)
    p.add_argument("--steps", type=int, default=3)
    p.add_argument("--guidance", type=float, default=1.0)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--output", required=True)
    p.add_argument("--image", default=None)
    p.add_argument("--fast", action="store_true", help="Enable fast mode (fewer steps + frame interpolation)")
    p.add_argument("--enhance-prompt", action="store_true", help="Enable prompt enhancer")
    p.add_argument("--refine", action="store_true", help="Enable second-pass refinement")
    return p.parse_args()


def find_entry_script(repo_dir: Path) -> Path:
    candidates = [
        repo_dir / "examples" / "inference" / "basic" / "mlx_wan_prompt_to_video.py",
        repo_dir / "examples" / "inference" / "basic" / "mlx_wan22_generate.py",
        repo_dir / "examples" / "mlx_wan_prompt_to_video.py",
    ]
    for cand in candidates:
        if cand.is_file():
            return cand
    # Fallback to glob search in repo
    found = list(repo_dir.glob("**/mlx_wan_prompt_to_video.py"))
    if found:
        return found[0]
    raise FileNotFoundError(f"Could not find mlx_wan_prompt_to_video.py under {repo_dir}")


def main() -> int:
    args = parse_args()

    # Runtime fingerprint at startup — recorded by PortOS so output is tied to
    # the specific FastVideo/mlx/torch stack on this machine.
    emit_runtime_fingerprint("fastvideo", ["fastvideo", "mlx", "mlx_metal", "torch", "transformers", "huggingface-hub"])

    establish_process_group()

    repo_dir = Path(args.repo_dir).resolve() if args.repo_dir else (Path.home() / ".portos" / "fastvideo")
    if not repo_dir.is_dir():
        print(f"❌ FastVideo repo directory not found: {repo_dir}", file=sys.stderr)
        return 1

    try:
        entry_script = find_entry_script(repo_dir)
    except FileNotFoundError as err:
        print(f"❌ {err}", file=sys.stderr)
        return 1

    model_root = Path(args.model_root).resolve()
    mlx_checkpoint = Path(args.mlx_checkpoint).resolve() if args.mlx_checkpoint else model_root

    cmd = [
        sys.executable,
        str(entry_script),
        "--model-root", str(model_root),
        "--mlx-checkpoint", str(mlx_checkpoint),
        "--prompt", args.prompt,
        "--width", str(args.width),
        "--height", str(args.height),
        "--num-frames", str(args.num_frames),
        "--num-inference-steps", str(args.steps),
        "--fps", str(args.fps),
        "--seed", str(args.seed),
        "--output-path", str(args.output),
    ]
    if args.fast:
        cmd.append("--fast")
    if args.enhance_prompt:
        cmd.append("--enhance-prompt")
    if args.refine:
        cmd.append("--refine")
    if args.image:
        cmd.extend(["--image-path", str(args.image)])

    print("STAGE:inference", file=sys.stderr, flush=True)
    print(f"🎬 fastvideo generate {args.width}x{args.height} frames={args.num_frames} steps={args.steps} seed={args.seed}", file=sys.stderr, flush=True)

    env = os.environ.copy()
    env["PYTHONPATH"] = f"{str(repo_dir)}:{env.get('PYTHONPATH', '')}".rstrip(":")
    # Mirrors train_mflux_lora.py's M5 Metal-watchdog mitigation. Preserve an
    # explicit caller override, but make the validated safe value the default
    # for the sustained FastMetal denoise child.
    env.setdefault("AGX_RELAX_CDM_CTXSTORE_TIMEOUT", "1")
    print(
        f"STATUS:watchdog mitigation · AGX_RELAX_CDM_CTXSTORE_TIMEOUT={env['AGX_RELAX_CDM_CTXSTORE_TIMEOUT']}",
        file=sys.stderr,
        flush=True,
    )

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
        cwd=str(repo_dir),
    )

    assert proc.stdout is not None
    # Parse output lines and map to STAGE: / STATUS: protocols. Only the
    # upstream denoising-step message represents render progress. Startup
    # model-loading bars also contain percentages (often ending at 100%) and
    # must remain status output or the generic server parser will report them
    # as completed rendering.
    for raw in proc.stdout:
        line = raw.rstrip()
        if not line:
            continue
        print(translate_line(line), file=sys.stderr, flush=True)

    return_code = proc.wait()
    if return_code != 0:
        print(f"❌ FastVideo runner exited with code {return_code}", file=sys.stderr)
        return return_code

    if not Path(args.output).exists():
        print(f"❌ FastVideo finished but output missing: {args.output}", file=sys.stderr)
        return 1

    print(f"✅ FastVideo saved {args.output}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
