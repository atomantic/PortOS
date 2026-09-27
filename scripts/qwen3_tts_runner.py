#!/usr/bin/env python3
"""Qwen3-TTS Runner for PortOS.

Provides CLI entry points for:
- Environment & hardware probe (--probe)
- Voice design inference (--mode design)
- Consented instant cloning (--mode clone)
- Standard / fine-tuned synthesis (--mode synthesize)
- Fine-tuning runner (--mode fine-tune)
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import json
import sys
from pathlib import Path


HUB_ENDPOINT = "https://huggingface.co"

SUPPORTED_MODELS = (
    "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
    "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
    "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
)
# Both the language model and speech codec are required. A directory, old
# metadata.json, or a lone language-model weight is not an installed snapshot.
REQUIRED_FILES = (
    "config.json", "generation_config.json", "merges.txt", "model.safetensors",
    "preprocessor_config.json", "tokenizer_config.json", "vocab.json",
    "speech_tokenizer/config.json", "speech_tokenizer/configuration.json",
    "speech_tokenizer/model.safetensors", "speech_tokenizer/preprocessor_config.json",
)


def file_fingerprint(path: Path) -> list[int]:
    stat = path.stat()
    return [stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_ino, stat.st_dev]


def verify_file(path: Path, metadata: dict) -> list[int]:
    """Verify bytes and reject files changed while hashing."""
    before = file_fingerprint(path)
    size, algorithm, digest = metadata["size"], metadata["algorithm"], metadata["digest"]
    if not isinstance(size, int) or size <= 0 or path.stat().st_size != size:
        raise ValueError(f"Incomplete model file: {path.name}")
    if algorithm not in ("sha1", "sha256") or not isinstance(digest, str):
        raise ValueError("Invalid model verification metadata")
    checksum = hashlib.new(algorithm)
    if algorithm == "sha1":
        checksum.update(f"blob {size}\0".encode())
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            checksum.update(chunk)
    if checksum.hexdigest() != digest:
        raise ValueError(f"Model file checksum mismatch: {path.name}")
    if before != file_fingerprint(path):
        raise ValueError(f"Model file changed during verification: {path.name}")
    return before


def installed_snapshot(model_dir: Path, model_id: str) -> Path | None:
    """Read only a completely verified revision; never perform network access."""
    try:
        manifest = json.loads((model_dir / "verified.json").read_text())
        revision = manifest["revision"]
        if manifest["model_id"] != model_id or not re.fullmatch(r"[0-9a-f]{40}", revision):
            return None
        snapshot = model_dir / revision
        for filename in REQUIRED_FILES:
            path = snapshot / filename
            metadata = manifest["files"][filename]
            # The verified bytes stay valid while their filesystem identity and
            # change timestamps match. Rehash changed files, including equal-size
            # replacements, without rereading multi-GB weights on every status.
            if file_fingerprint(path) != metadata.get("fingerprint"):
                verify_file(path, metadata)
        return snapshot
    except (OSError, ValueError, KeyError, TypeError):
        return None


def download_model(model_id: str, models_dir: Path) -> dict:
    """Fetch an immutable Hub revision and verify every required file's digest.

    Hub blob IDs are Git SHA-1 for ordinary files and SHA-256 for LFS weights.
    Only publish the readiness marker after verification, leaving a prior
    installed revision usable if an update fails or the process is interrupted.
    """
    if model_id not in SUPPORTED_MODELS:
        raise ValueError("Unsupported Qwen3-TTS model")
    from huggingface_hub import HfApi, hf_hub_download

    info = HfApi(endpoint=HUB_ENDPOINT).model_info(model_id, files_metadata=True)
    revision = info.sha
    if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("Model repository did not return an immutable revision")
    files = {entry.rfilename: entry for entry in info.siblings}
    if not all(filename in files for filename in REQUIRED_FILES):
        raise ValueError("Model repository is missing required Qwen3-TTS files")
    model_dir = models_dir / model_id.replace("/", "--")
    snapshot = model_dir / revision
    verified_files = {}
    for filename in REQUIRED_FILES:
        entry = files[filename]
        if not isinstance(entry.size, int) or entry.size <= 0:
            raise ValueError(f"Missing file size: {filename}")
        lfs = entry.lfs
        digest = lfs.sha256 if lfs else entry.blob_id
        algorithm = "sha256" if lfs else "sha1"
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}" if lfs else r"[0-9a-f]{40}", digest):
            raise ValueError(f"Missing file digest: {filename}")
        # The explicit download operation is the only path allowed to fetch.
        hf_hub_download(repo_id=model_id, filename=filename, revision=revision,
                        local_dir=snapshot, endpoint=HUB_ENDPOINT)
        metadata = {"size": entry.size, "algorithm": algorithm, "digest": digest}
        metadata["fingerprint"] = verify_file(snapshot / filename, metadata)
        verified_files[filename] = metadata

    marker = model_dir / "verified.json"
    # Unique temporary markers also make separate explicit CLI downloads safe.
    import tempfile
    descriptor, temporary = tempfile.mkstemp(prefix=".verified-", dir=model_dir)
    try:
        with os.fdopen(descriptor, "w") as output:
            json.dump({"model_id": model_id, "revision": revision, "files": verified_files}, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, marker)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return {"ok": True, "modelId": model_id, "revision": revision, "path": str(snapshot)}


def probe_runtime(models_dir: Path | None = None) -> dict:
    """Probe hardware, PyTorch, Transformers, and cached model weights."""
    result = {
        "ok": False,
        "error": "Qwen3-TTS model operations are unavailable until a real adapter is implemented",
        "torch_installed": False,
        "transformers_installed": False,
        "device": "cpu",
        "cuda_available": False,
        "mps_available": False,
        "vram_gb": None,
        "models": {},
    }

    try:
        import torch
        result["torch_installed"] = True
        result["torch_version"] = torch.__version__
        if torch.cuda.is_available():
            result["cuda_available"] = True
            result["device"] = "cuda"
            try:
                result["vram_gb"] = round(torch.cuda.get_device_properties(0).total_memory / (1024**3), 2)
            except Exception:
                pass
        elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            result["mps_available"] = True
            result["device"] = "mps"
    except ImportError:
        pass

    try:
        import transformers
        result["transformers_installed"] = True
        result["transformers_version"] = transformers.__version__
    except ImportError:
        pass

    for model_id in SUPPORTED_MODELS:
        model_path = models_dir / model_id.replace("/", "--") if models_dir else None
        snapshot = installed_snapshot(model_path, model_id) if model_path else None
        result["models"][model_id] = {
            "downloaded": snapshot is not None,
            "path": str(snapshot) if snapshot else None,
        }

    return result


def unavailable(operation: str) -> int:
    """Refuse unsupported operations without producing audio or checkpoints."""
    print(json.dumps({
        "ok": False,
        "code": "QWEN3_RUNTIME_UNAVAILABLE",
        "error": f"Qwen3-TTS {operation} is unavailable: no real model adapter is implemented",
    }), file=sys.stderr)
    return 1


def run_synthesis(args: argparse.Namespace) -> int:
    return unavailable(args.mode)


def run_fine_tuning(args: argparse.Namespace) -> int:
    return unavailable("fine-tuning")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download", action="store_true", help="Explicitly download and verify a model snapshot")
    parser.add_argument("--probe", action="store_true", help="Probe runtime and available models")
    parser.add_argument("--models-dir", type=str, help="Directory containing downloaded model weights")
    parser.add_argument("--mode", choices=["design", "clone", "synthesize", "fine-tune"], default="synthesize")
    parser.add_argument("--text", type=str, help="Input text for synthesis")
    parser.add_argument("--instructions", type=str, help="Delivery / voice design instructions")
    parser.add_argument("--seed", type=int, default=42, help="RNG seed")
    parser.add_argument("--rate", type=float, default=1.0, help="Speech rate (0.25 - 4.0)")
    parser.add_argument("--reference-audio", type=str, help="Path to reference audio file for cloning")
    parser.add_argument("--reference-transcript", type=str, help="Transcript of reference audio")
    parser.add_argument("--checkpoint-path", type=str, help="Path to fine-tuned model checkpoint")
    parser.add_argument("--model-id", type=str, help="HuggingFace model ID")
    parser.add_argument("--model-path", type=str, help="Local directory containing model snapshot")
    parser.add_argument("--output-wav", type=str, help="Target path for synthesized WAV")
    parser.add_argument("--dataset-dir", type=str, help="Directory containing audio and transcripts for fine-tuning")
    parser.add_argument("--output-dir", type=str, help="Output directory for training checkpoints")
    parser.add_argument("--epochs", type=int, default=5, help="Number of training epochs")
    parser.add_argument("--checkpoint-interval", type=int, default=50, help="Steps between checkpoints")
    
    args = parser.parse_args()

    if args.download:
        if not args.model_id or not args.models_dir:
            parser.error("--download requires --model-id and --models-dir")
        try:
            print(json.dumps(download_model(args.model_id, Path(args.models_dir))))
            return 0
        except Exception as error:
            code = "QWEN3_DOWNLOAD_UNAVAILABLE" if isinstance(error, ImportError) else "QWEN3_DOWNLOAD_FAILED"
            print(json.dumps({"ok": False, "code": code, "error": str(error)}), file=sys.stderr)
            return 1

    if args.probe:
        models_dir = Path(args.models_dir) if args.models_dir else None
        print(json.dumps(probe_runtime(models_dir)))
        return 0

    if args.mode == "fine-tune":
        if not args.dataset_dir or not args.output_dir:
            sys.stderr.write("Error: --dataset-dir and --output-dir are required for fine-tune mode\n")
            return 1
        return run_fine_tuning(args)

    if not args.output_wav:
        sys.stderr.write("Error: --output-wav is required for synthesis\n")
        return 1

    return run_synthesis(args)


if __name__ == "__main__":
    raise SystemExit(main())
