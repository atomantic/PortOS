#!/usr/bin/env python3
"""Probe only the inspected A2V stage contract; never load or download weights."""
from __future__ import annotations

import inspect
import os
import subprocess
from pathlib import Path

from ltx_runtime_lora import validate_a2v_stage_seams

INSPECTED_REVISIONS = (
    "1192051fd380e0501adb5f3c0e9a216e679cb123",
    "57952288076766abe27dda3a774b2c24f7346977",
)


def require_a2v_stage_capability(pipeline_class=None):
    if pipeline_class is None:
        from ltx_pipelines_mlx.a2vid_two_stage import A2VidPipelineTwoStage
        pipeline_class = A2VidPipelineTwoStage
    source = Path(inspect.getfile(pipeline_class)).resolve().parent
    git_env = {**os.environ, "GIT_OPTIONAL_LOCKS": "0"}
    try:
        root = subprocess.check_output(["git", "-C", str(source), "rev-parse", "--show-toplevel"],
                                       text=True, stderr=subprocess.DEVNULL, env=git_env).strip()
        revision = subprocess.check_output(["git", "-C", root, "rev-parse", "HEAD"],
                                           text=True, stderr=subprocess.DEVNULL, env=git_env).strip()
        dirty = subprocess.check_output(["git", "-C", root, "status", "--porcelain", "--untracked-files=all",
                                         "--", "packages/ltx-pipelines-mlx", "packages/ltx-core-mlx"],
                                        text=True, stderr=subprocess.DEVNULL, env=git_env).strip()
    except (OSError, subprocess.SubprocessError) as exc:
        raise ValueError("A2V stage LoRAs require a verifiable pinned runtime checkout") from exc
    if revision not in INSPECTED_REVISIONS or dirty:
        raise ValueError("A2V stage LoRAs require an inspected, unchanged LTX MLX runtime pin")
    validate_a2v_stage_seams(pipeline_class)
    return revision


if __name__ == "__main__":
    import sys
    try:
        require_a2v_stage_capability()
    except (ImportError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(2)
    print("A2V LoRA motion/refine stages supported")
