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
import json
import sys
from pathlib import Path


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

    supported_models = [
        "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
        "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
        "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
    ]

    if models_dir and models_dir.exists():
        for model_id in supported_models:
            safe_name = model_id.replace("/", "--")
            model_path = models_dir / safe_name
            result["models"][model_id] = {
                "downloaded": False,
                "path": str(model_path) if model_path.exists() else None,
            }
    else:
        for model_id in supported_models:
            result["models"][model_id] = {
                "downloaded": False,
                "path": None,
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
