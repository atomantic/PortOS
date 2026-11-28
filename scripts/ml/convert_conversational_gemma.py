"""Download the pinned Conversational Gemma 4 31B checkpoint and convert it to Q8_0 GGUF."""

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def emit(phase, detail, percent=None):
    payload = {"phase": phase, "detail": detail}
    if percent is not None:
        payload["percent"] = percent
    print(json.dumps(payload, separators=(",", ":")), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--converter", type=Path, required=True)
    parser.add_argument("--staging", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    token = os.environ.get("HF_TOKEN", "").strip()
    if not token:
        print("Missing Hugging Face token in environment", file=sys.stderr, flush=True)
        return 2
    if not args.converter.is_file():
        print("llama.cpp convert_hf_to_gguf.py not found", file=sys.stderr, flush=True)
        return 2

    from huggingface_hub import snapshot_download

    hf_dir = args.staging / "hf"
    hf_dir.mkdir(parents=True, exist_ok=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    tmp_output = args.output.with_name(args.output.name + ".converting.tmp")

    emit("downloading", "Downloading gated Conversational Gemma 4 31B weights from Hugging Face…", 10)
    snapshot_download(
        repo_id=args.repo,
        revision=args.revision,
        local_dir=str(hf_dir),
        token=token,
    )

    emit("converting", "Converting FP8 checkpoint to Q8_0 GGUF for Apple Silicon llama.cpp…", 65)
    cmd = [
        sys.executable,
        "-B",
        str(args.converter),
        str(hf_dir),
        "--outtype",
        "q8_0",
        "--outfile",
        str(tmp_output),
    ]
    # Keep token out of converter subprocess environment.
    clean_env = {k: v for k, v in os.environ.items() if k not in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN")}
    result = subprocess.run(cmd, env=clean_env, stdout=sys.stderr, stderr=sys.stderr, check=False)
    if result.returncode != 0 or not tmp_output.is_file() or tmp_output.stat().st_size == 0:
        tmp_output.unlink(missing_ok=True)
        print("GGUF conversion failed", file=sys.stderr, flush=True)
        return result.returncode or 1

    os.replace(tmp_output, args.output)
    shutil.rmtree(args.staging, ignore_errors=True)
    emit("converting", "Q8_0 GGUF conversion complete.", 90)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
