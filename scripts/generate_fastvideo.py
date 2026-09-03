#!/usr/bin/env python3
"""PortOS FastVideo MLX helper for Apple Silicon.

Spawns the pinned FastVideo inference script from the ~/.portos/fastvideo
checkout. Generation is cache-only: PortOS downloads model weights through
the Video Gen UI before launching this helper.

Two model families share this helper because they share one venv, one repo
checkout and one progress protocol -- but NOT one entry script or one argv
shape:

  fastmetal - the DMD2-distilled Wan exports, via mlx_wan_prompt_to_video.py.
  fasth3    - FastH3 Preview v1 Dense/Data-Free, via mlx_fasth3.py, which
              takes a pre-quantized MLX DiT and emits muxed video+audio.

`--family` is what selects between them. It is explicit rather than sniffed
from the checkpoint, so a mis-tagged registry row fails on an argument the
entry script rejects instead of silently rendering through the wrong pipeline.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import subprocess
import sys
from pathlib import Path

# Same-dir sibling import. _runner_common is stdlib-only at import time.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _runner_common import emit_runtime_fingerprint, establish_process_group, heartbeat  # noqa: E402


_DENOISE_STEP_PATTERN = re.compile(
    r'\bdenois(?:e|ing)\s+step\s*(\d+)\s*/\s*(\d+)\b', re.IGNORECASE,
)
_PERCENT_PATTERN = re.compile(r'\d+%')

# ---------------------------------------------------------------------------
# Phase reporting (#5872)
#
# FastH3 is silent for MINUTES at a time. Its MLX pipeline
# (fastvideo/mlx_runtime/minimax_h3_pipeline.py) logs one milestone line per
# phase and emits no per-step denoise progress at all, so a render that is
# streaming an ~89 GB INT4 DiT off disk looks identical to a hung one: 0%, no
# text. PortOS therefore derives the phase itself, by scraping the milestone
# lines upstream DOES log into a small monotonic state machine.
#
# Liveness is the shared `_runner_common.heartbeat`, handed a callable so each
# beat reports whichever phase the scraper is currently in. The server stamps
# that phase onto the status frame it broadcasts, so the UI can name the step
# even while nothing else is being said.
# ---------------------------------------------------------------------------

# The phase progression, earliest first. Ordering is load-bearing — it is what
# keeps `advance_phase` monotonic — so it is declared here rather than inferred
# from the key order of the label table below.
# NOT "encode-prompt": that exact marker is generate_ltx2.py's Gemma
# prompt-encode BEGIN sentinel (PROMPT_ENCODE_BEGIN_MARKER in
# generateVideoHelpers.js), and the server arms an ltx2-specific relaunch on it.
# Emitting it here would open a phase this runner never closes, so a FastVideo
# render killed by the Metal watchdog would be "retried" with ltx2's
# --gemma-max-length flag, which this script's argparse rejects — replacing the
# real watchdog error with an exit-2 after a wasted full model re-spawn.
_PHASE_ORDER = ("load-pipeline", "conditioning", "sampling", "mux")

# Phase id -> the sentence the user reads, emitted once per transition. Ids are
# drawn from the STAGE: vocabulary the server already parses
# (generateVideoHelpers.js), so the client's phase→step mapping needs no
# FastVideo-specific entries.
PHASE_LABELS = {
    "load-pipeline": "Loading the FastVideo pipeline",
    "conditioning": "Encoding the prompt and streaming model weights",
    "sampling": "Rendering (denoising)",
    "mux": "Decoding and muxing video + audio",
}

# The phase a render is in from spawn until upstream says otherwise.
INITIAL_PHASE = _PHASE_ORDER[0]

# (lowercase substring, phase it moves us to). First match wins. Each marker is
# a line upstream logs at the END of the work it names, so it opens the NEXT
# phase rather than the one it describes.
_PHASE_MARKERS = (
    # `Geometry: output=...` is the first line generate() logs, i.e. the
    # pipeline object is constructed and the long conditioning leg starts here.
    ("geometry:", "conditioning"),
    # Text conditioning is done — either freshly encoded or read from cache.
    ("loaded prompt embeddings", "sampling"),
    # The DiT finished streaming in; denoising is the only thing left before
    # decode. Both orderings are covered because a prompt-cache hit skips the
    # encode entirely.
    ("loaded mlx h3 dit", "sampling"),
    ("recomputing adaln cache", "sampling"),
    # Denoising is over; everything after it is VAE decode + ffmpeg mux.
    ("generation complete", "mux"),
)


def advance_phase(line: str, current: str) -> str:
    """The phase `line` moves us into, or `current` when it names none.

    Never moves backwards: upstream repeats some milestone lines (a chained or
    retried leg re-logs `Geometry:`), and a phase that regressed to
    "Encoding the prompt" halfway through denoising would read as a stall.
    """
    # A denoising-step line is proof of the sampler running whatever the
    # milestone wording said. It is the only marker the fastmetal family emits,
    # so without this its heartbeat would keep claiming "Loading the FastVideo
    # pipeline" while the step counter climbed.
    phase = "sampling" if _DENOISE_STEP_PATTERN.search(line) else None
    if phase is None:
        lowered = line.lower()
        phase = next((p for marker, p in _PHASE_MARKERS if marker in lowered), None)
    if phase is None or _PHASE_ORDER.index(phase) <= _PHASE_ORDER.index(current):
        return current
    return phase


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
    p.add_argument("--family", choices=("fastmetal", "fasth3"), default="fastmetal",
                   help="Which FastVideo entry script and argv shape to use")
    p.add_argument("--model-root", required=True, help="HF model snapshot path")
    p.add_argument("--mlx-checkpoint", default=None, help="MLX checkpoint path (defaults to model-root)")
    p.add_argument("--mlx-format", choices=MLX_DIT_FORMATS, default=None,
                   help="convert this snapshot's transformer/ to an MLX DiT of this format on first use")
    p.add_argument("--mlx-checkpoint-cache-dir", default=None,
                   help="root for converted MLX DiTs (default: a shared dir under ~/.portos/fastvideo)")
    p.add_argument("--prompt-cache-dir", default=None,
                   help="reusable FastH3 prompt-embedding cache (default: a shared dir under ~/.portos/fastvideo)")
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


# Per-family entry-script candidates, most-preferred first. The trailing glob
# name is the fallback when a checkout moves the examples tree.
_ENTRY_SCRIPTS = {
    "fastmetal": (
        [
            ("examples", "inference", "basic", "mlx_wan_prompt_to_video.py"),
            ("examples", "inference", "basic", "mlx_wan22_generate.py"),
            ("examples", "mlx_wan_prompt_to_video.py"),
        ],
        "mlx_wan_prompt_to_video.py",
    ),
    "fasth3": (
        [
            ("examples", "inference", "basic", "mlx_fasth3.py"),
            ("examples", "mlx_fasth3.py"),
        ],
        "mlx_fasth3.py",
    ),
}


def find_entry_script(repo_dir: Path, family: str = "fastmetal") -> Path:
    candidates, glob_name = _ENTRY_SCRIPTS[family]
    for parts in candidates:
        cand = repo_dir.joinpath(*parts)
        if cand.is_file():
            return cand
    found = list(repo_dir.glob(f"**/{glob_name}"))
    if found:
        return found[0]
    raise FileNotFoundError(f"Could not find {glob_name} under {repo_dir}")


# FastVideo publishes FastH3 as a bf16 diffusers snapshot: the DiT lives under
# `transformer/` beside the vae / audio_vae / text_encoder / tokenizer the
# pipeline loads. mlx_fasth3.py does not read that DiT -- it wants a
# pre-quantized `mlx_h3_dit` directory. `--mlx-format` bridges the two by
# running FastVideo's own converter once, so a row can point at the upstream
# checkpoint instead of depending on a third party having published a repack.
MLX_DIT_FORMATS = ("int8", "int6", "int4")
# PortOS declares both of these roots in server/services/videoGen/runtimes.js and
# passes them as flags. These defaults exist only so the script runs standalone,
# the same role --repo-dir's fallback plays.
MLX_CHECKPOINT_CACHE = Path.home() / ".portos" / "fastvideo" / "mlx-checkpoints"
PROMPT_CACHE = Path.home() / ".portos" / "fastvideo" / "prompt-cache"
_CONVERTER_SCRIPT = ("scripts", "checkpoint_conversion", "convert_minimax_h3_mlx.py")
_MLX_CHECKPOINT_FILES = ("mlx_h3_dit.safetensors", "mlx_h3_dit.json")


def mlx_checkpoint_root(model_root: Path, base: Path | None = None) -> Path:
    """Where DiTs converted from `model_root` are cached.

    Keyed by the SNAPSHOT, not by the repo id -- an HF cache path ends in the
    commit sha, so two revisions of one repo cannot collide on a converted
    checkpoint. Kept outside the HF cache because `hf` prunes by blob and has no
    idea these files belong to that snapshot.
    """
    parts = [part for part in (model_root.parent.parent.name, model_root.name) if part]
    label = re.sub(r"[^A-Za-z0-9._-]+", "-", "-".join(parts)).strip("-") or "snapshot"
    # The readable half is for whoever reads the directory listing; the digest is
    # what carries identity. A --model-root outside the HF cache can share both
    # its own name and its grandparent's with an unrelated snapshot, and two
    # snapshots resolving to ONE converted DiT would render the wrong weights
    # without any error to notice.
    digest = hashlib.sha256(str(model_root).encode("utf-8")).hexdigest()[:12]
    return (base or MLX_CHECKPOINT_CACHE) / f"{label}-{digest}"


def is_converted(checkpoint_dir: Path) -> bool:
    return all((checkpoint_dir / name).is_file() for name in _MLX_CHECKPOINT_FILES)


def ensure_mlx_checkpoint(repo_dir: Path, model_root: Path, fmt: str, env: dict,
                          base: Path | None = None) -> Path:
    """Return the converted MLX DiT for `fmt`, converting it if it is missing."""
    out_base = mlx_checkpoint_root(model_root, base)
    out_dir = out_base / fmt
    if is_converted(out_dir):
        return out_dir
    transformer = model_root / "transformer"
    if not transformer.is_dir():
        raise FileNotFoundError(
            f"{model_root} has no transformer/ to convert to MLX {fmt}. Download the "
            f"full FastH3 snapshot, or point --mlx-checkpoint at a converted DiT.")
    converter = repo_dir.joinpath(*_CONVERTER_SCRIPT)
    if not converter.is_file():
        raise FileNotFoundError(f"Could not find {converter}")
    print(f"STATUS:converting the FastH3 DiT to MLX {fmt} — one time, into {out_dir}",
          file=sys.stderr, flush=True)
    out_base.mkdir(parents=True, exist_ok=True)
    code = run_child(
        [sys.executable, str(converter),
         "--model-root", str(transformer),
         "--out", str(out_base),
         "--formats", fmt],
        env, repo_dir, lambda line: f"STATUS:{line}",
    )
    if code != 0:
        raise RuntimeError(f"FastH3 MLX conversion exited with code {code}")
    if not is_converted(out_dir):
        raise RuntimeError(f"FastH3 MLX conversion finished but {out_dir} is incomplete")
    # The bf16 transformer is dead weight for rendering once this exists, but it
    # is the user's download: name it, do not delete it.
    print(f"STATUS:MLX {fmt} DiT ready — {transformer} is no longer needed to render and can be deleted",
          file=sys.stderr, flush=True)
    return out_dir


def resolve_prompt_cache_dir(args) -> Path:
    """Where FastH3 caches its conditioning embeddings.

    Streaming the bf16 Qwen3-VL conditioner is HALF the wall clock of a 124-frame
    render (307s of 621s measured on an M5 Max), and it produces the same
    embeddings every time. Upstream digests the cache entry over its own cache
    version, the model root AND the prompt, so one shared directory cannot serve
    a stale entry across models or across a conditioner change.
    """
    return Path(args.prompt_cache_dir) if args.prompt_cache_dir else PROMPT_CACHE


def run_child(cmd: list, env: dict, cwd: Path, transform) -> int:
    """Spawn a child, stream its merged output through `transform`, return its code.

    For the CONVERSION child only. The inference child in main() runs its own
    loop because it also drives a heartbeat thread and a phase state machine,
    and shares stderr with that thread — it needs one write per line, which
    print() does not give. Conversion finishes before the heartbeat starts, so
    there is no concurrent writer here.
    """
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        env=env, cwd=str(cwd),
    )
    assert proc.stdout is not None
    for raw in proc.stdout:
        line = raw.rstrip()
        if line:
            print(transform(line), file=sys.stderr, flush=True)
    return proc.wait()


def build_child_env(repo_dir: Path) -> dict:
    """Environment shared by the conversion child and the inference child."""
    env = os.environ.copy()
    env["PYTHONPATH"] = f"{str(repo_dir)}:{env.get('PYTHONPATH', '')}".rstrip(":")
    # Mirrors train_mflux_lora.py's M5 Metal-watchdog mitigation. Preserve an
    # explicit caller override, but make the validated safe value the default
    # for the sustained denoise child of either family.
    env.setdefault("AGX_RELAX_CDM_CTXSTORE_TIMEOUT", "1")
    return env


# mlx_fasth3.py always muxes H.264 at 24 fps with 32 kHz stereo AAC and exposes
# no --fps flag, so a differing request is reported rather than silently ignored.
FASTH3_NATIVE_FPS = 24


def build_command(args, entry_script: Path, model_root: Path, mlx_checkpoint: Path) -> list:
    """Build the child argv for the selected family.

    Split by family rather than by conditional flag because the two entry
    scripts disagree on the NAME of shared concepts (`--steps` vs
    `--num-inference-steps`) as well as on which concepts exist at all. A
    single list with `if family == ...` guards around half its elements reads
    as one contract when it is two.
    """
    # Shared prefix only. The step/rate flags and the trailing seed/output pair
    # are appended per family so FastMetal keeps the EXACT argv it emitted
    # before the split — argparse is order-insensitive, but an identical
    # ordering is what makes "FastMetal is untouched" checkable by eye.
    common = [
        sys.executable,
        str(entry_script),
        "--model-root", str(model_root),
        "--mlx-checkpoint", str(mlx_checkpoint),
        "--prompt", args.prompt,
        "--width", str(args.width),
        "--height", str(args.height),
        "--num-frames", str(args.num_frames),
    ]
    tail = ["--seed", str(args.seed), "--output-path", str(args.output)]
    if args.family != "fasth3":
        cmd = common + [
            "--num-inference-steps", str(args.steps),
            "--fps", str(args.fps),
        ] + tail
        if args.fast:
            cmd.append("--fast")
        if args.enhance_prompt:
            cmd.append("--enhance-prompt")
        if args.refine:
            cmd.append("--refine")
        if args.image:
            cmd.extend(["--image-path", str(args.image)])
        return cmd

    # FastH3: text-to-video-with-audio only. The entry script has no --fps,
    # --guidance, --negative-prompt or --image-path, so anything the caller
    # passed for those is surfaced as a STATUS line instead of being dropped
    # into a flag the child would reject.
    for label, unsupported in (
        ("negative prompt", args.negative_prompt),
        ("conditioning image", args.image),
        ("prompt enhancer", args.enhance_prompt),
        ("refinement pass", args.refine),
    ):
        if unsupported:
            print(f"STATUS:FastH3 ignores the requested {label} — this entry point is text-to-video-with-audio only",
                  file=sys.stderr, flush=True)
    if args.fps and args.fps != FASTH3_NATIVE_FPS:
        print(f"STATUS:FastH3 always writes {FASTH3_NATIVE_FPS} fps — ignoring the requested {args.fps} fps",
              file=sys.stderr, flush=True)
    cmd = common + ["--steps", str(args.steps),
                    "--prompt-cache-dir", str(resolve_prompt_cache_dir(args))] + tail
    if args.fast:
        cmd.append("--fast")
    return cmd


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
        entry_script = find_entry_script(repo_dir, args.family)
    except FileNotFoundError as err:
        print(f"❌ {err}", file=sys.stderr)
        return 1

    model_root = Path(args.model_root).resolve()
    env = build_child_env(repo_dir)
    # Precedence: an explicit path always wins, so a row that ships a
    # pre-quantized DiT never triggers a conversion it does not need.
    if args.mlx_checkpoint:
        mlx_checkpoint = Path(args.mlx_checkpoint).resolve()
    elif args.mlx_format:
        try:
            mlx_checkpoint = ensure_mlx_checkpoint(
                repo_dir, model_root, args.mlx_format, env,
                Path(args.mlx_checkpoint_cache_dir) if args.mlx_checkpoint_cache_dir else None)
        except (FileNotFoundError, RuntimeError) as err:
            print(f"❌ {err}", file=sys.stderr)
            return 1
    else:
        mlx_checkpoint = model_root

    cmd = build_command(args, entry_script, model_root, mlx_checkpoint)
    # The child writes into this directory but will not create it. Keyed off the
    # argv rather than a second family test, so it cannot disagree with the one
    # branch in build_command that decides the flag is passed at all.
    if "--prompt-cache-dir" in cmd:
        Path(cmd[cmd.index("--prompt-cache-dir") + 1]).mkdir(parents=True, exist_ok=True)

    print(f"🎬 fastvideo {args.family} generate {args.width}x{args.height} frames={args.num_frames} steps={args.steps} seed={args.seed}", file=sys.stderr, flush=True)

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

    # One write per line, not print()'s two (text, then newline): the heartbeat
    # thread writes to this same stream, and an interleave between the two halves
    # would glue two protocol lines together and lose a marker.
    def emit(text: str) -> None:
        sys.stderr.write(f"{text}\n")
        sys.stderr.flush()

    phase = INITIAL_PHASE
    emit(f"STAGE:{phase}")

    assert proc.stdout is not None
    # Parse output lines and map to STAGE: / STATUS: protocols. Only the
    # upstream denoising-step message represents render progress. Startup
    # model-loading bars also contain percentages (often ending at 100%) and
    # must remain status output or the generic server parser will report them
    # as completed rendering.
    with heartbeat(lambda: phase):
        for raw in proc.stdout:
            line = raw.rstrip()
            if not line:
                continue
            next_phase = advance_phase(line, phase)
            if next_phase != phase:
                phase = next_phase
                emit(f"STAGE:{phase}")
                emit(f"STATUS:{PHASE_LABELS[phase]}")
            emit(translate_line(line))

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
