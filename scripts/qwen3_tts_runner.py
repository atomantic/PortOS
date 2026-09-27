#!/usr/bin/env python3
"""Qwen3-TTS Runner for PortOS.

Provides CLI entry points for:
- Environment & hardware probe (--probe)
- Voice design inference (--mode design)
- Consented instant cloning (--mode clone)
- Verified fine-tuned checkpoint synthesis (--mode fine-tuned)
- Official single-speaker fine-tuning on CUDA (--mode fine-tune)
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.util
import math
import os
import re
import json
import platform
import shutil
import sys
import tempfile
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

# Official single-speaker SFT recipe for the 12 Hz Base models, ported from
# QwenLM/Qwen3-TTS finetuning/ (sft_12hz.py + dataset.py, Apache-2.0) at commit
# 022e286b98fbec7e1e916cb940cdf532cd9f488e. The recipe trains in bf16 on CUDA.
TRAINING_ADAPTER = "qwen-tts-sft-12hz"
TRAINABLE_MODELS = tuple(model for model in SUPPORTED_MODELS if model.endswith("-Base"))
CHECKPOINT_MANIFEST = "portos-checkpoint.json"
CHECKPOINT_WEIGHTS = "model.safetensors"
# The recipe writes the target speaker embedding into this codec-embedding row
# and registers the speaker name against it in the checkpoint config.
SPEAKER_TOKEN_ID = 3000
SPEAKER_NAME_RE = re.compile(r"[a-z][a-z0-9_]{0,39}")
AUDITION_TEXT = "This is a short audition of the fine-tuned voice."
TRAINING_BATCH_SIZE = 2
TRAINING_GRADIENT_ACCUMULATION = 4
TRAINING_LEARNING_RATE = 2e-5
MAX_TRAINING_SAMPLES = 500
MAX_TRAINING_TEXT = 2000


def publish_json(path: Path, data: dict) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix=".verified-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as output:
            json.dump(data, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


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
        cache_path = snapshot / ".verification.json"
        try:
            cache = json.loads(cache_path.read_text())
            if not isinstance(cache, dict):
                cache = {}
        except (OSError, ValueError):
            cache = {}
        refreshed = {}
        changed = False
        for filename in REQUIRED_FILES:
            path = snapshot / filename
            metadata = dict(manifest["files"][filename])
            cached = cache.get(filename)
            if isinstance(cached, dict) and all(cached.get(key) == metadata[key] for key in ("size", "algorithm", "digest")):
                metadata = cached
            # The verified bytes stay valid while their filesystem identity and
            # change timestamps match. Rehash changed files, including equal-size
            # replacements, without rereading multi-GB weights on every status.
            # Windows Python reports creation time as ctime, not change time;
            # it cannot prove unchanged bytes when mtime has been restored.
            if sys.platform == "win32" or file_fingerprint(path) != metadata.get("fingerprint"):
                metadata["fingerprint"] = verify_file(path, metadata)
                changed = True
            refreshed[filename] = metadata
        if changed:
            # Per-revision cache cannot overwrite the readiness pointer when a
            # concurrent download publishes a newer revision.
            publish_json(cache_path, refreshed)
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

    publish_json(model_dir / "verified.json", {
        "model_id": model_id, "revision": revision, "files": verified_files,
    })
    return {"ok": True, "modelId": model_id, "revision": revision, "path": str(snapshot)}


def is_apple_silicon() -> bool:
    return platform.system() == "Darwin" and platform.machine() == "arm64"


def training_runtime_available() -> bool:
    """True only where the official recipe can run: bf16 CUDA plus its imports."""
    if is_apple_silicon():
        return False
    try:
        import librosa  # noqa: F401
        import soundfile  # noqa: F401
        import torch
        from qwen_tts import Qwen3TTSModel  # noqa: F401
        from qwen_tts.core.models.modeling_qwen3_tts import mel_spectrogram  # noqa: F401
        from safetensors.torch import save_file  # noqa: F401
    except ImportError:
        return False
    return bool(torch.cuda.is_available() and torch.cuda.is_bf16_supported())


def probe_runtime(models_dir: Path | None = None) -> dict:
    """Probe hardware, PyTorch, Transformers, and cached model weights."""
    result = {
        "ok": False,
        "error": "Qwen3-TTS inference requires qwen-tts, torch and soundfile on CPU/CUDA",
        "torch_installed": False,
        "transformers_installed": False,
        "device": "cpu",
        "cuda_available": False,
        "mps_available": False,
        "vram_gb": None,
        "models": {},
        # Inference readiness never implies training support; PortOS refuses
        # fine-tuning unless the probe names the adapter that will train.
        "training_adapter": None,
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

    # Probe the actual backend without loading a model or acquiring weights.
    if is_apple_silicon():
        result["error"] = "Qwen3-TTS inference requires mlx-audio and soundfile on Apple Silicon"
        try:
            import mlx.core as mx
            from mlx_audio.tts.models.qwen3_tts import Model
            from mlx_audio.tts.utils import load_model
            import soundfile
            if mx.metal.is_available():
                result["ok"] = True
                result["error"] = None
                result["device"] = "mlx"
        except ImportError:
            pass
    elif result["torch_installed"] and result["transformers_installed"]:
        try:
            from qwen_tts import Qwen3TTSModel
            import soundfile
            result["ok"] = True
            result["error"] = None
        except ImportError:
            pass
    if result["ok"] and training_runtime_available():
        result["training_adapter"] = TRAINING_ADAPTER

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
        "error": f"Qwen3-TTS {operation} is unavailable",
    }), file=sys.stderr)
    return 1


def use_offline_hub() -> None:
    # qwen-tts loads its processor/codec independently. Offline flags cover those
    # nested loads too; status, inference and training cannot acquire weights.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"


def load_torch_model(path: Path, seed: int):
    """Load a verified local snapshot or checkpoint with the official package."""
    import torch
    from qwen_tts import Qwen3TTSModel

    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    dtype = (torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16) if device != "cpu" else torch.float32
    torch.manual_seed(seed)
    model = Qwen3TTSModel.from_pretrained(
        str(path), device_map=device, dtype=dtype,
        attn_implementation="eager", local_files_only=True,
    )
    return torch, model


def write_model_audio(wavs, sample_rate, output_path) -> None:
    """Publish one finite, non-silent PCM WAV; never write rejected audio."""
    import numpy as np
    import soundfile as sf

    if len(wavs) != 1 or not isinstance(sample_rate, int) or sample_rate <= 0:
        raise ValueError("Invalid model audio result")
    audio = np.asarray(wavs[0])
    if audio.ndim != 1 or not audio.size or not np.isfinite(audio).all() or not np.any(audio):
        raise ValueError("Model returned empty, silent or invalid audio")
    # Publish only the completed PCM WAV; the JS transport buffers it.
    sf.write(output_path, audio, sample_rate, format="WAV", subtype="PCM_16")


def synthesis_failed(output_wav) -> int:
    # Provider exceptions may contain private reference paths/transcripts.
    # Return a bounded error instead of publishing their raw exception text.
    Path(output_wav).unlink(missing_ok=True)
    print(json.dumps({"ok": False, "code": "QWEN3_SYNTHESIS_FAILED",
                      "error": "Qwen3-TTS model inference failed; no audio was published"}), file=sys.stderr)
    return 1


def run_synthesis(args: argparse.Namespace) -> int:
    if args.mode == "fine-tuned":
        return run_checkpoint_synthesis(args)
    # Resolve the verified immutable snapshot ourselves. Never let a model ID,
    # arbitrary checkpoint, or missing local file trigger an implicit download.
    if args.checkpoint_path or args.model_path:
        return unavailable("custom checkpoints/model paths")
    if args.rate != 1.0:
        return unavailable("speech-rate control")
    use_mlx = is_apple_silicon()
    if args.model_id not in SUPPORTED_MODELS or not args.models_dir:
        return unavailable("inference without a supported verified local model")
    model_dir = Path(args.models_dir) / args.model_id.replace("/", "--")
    snapshot = installed_snapshot(model_dir, args.model_id)
    if snapshot is None:
        return unavailable("inference without downloaded and verified weights")
    if not args.text or not args.text.strip():
        return unavailable("inference without text")
    design = args.model_id.endswith("-VoiceDesign")
    if (args.mode == "clone" and design) or (args.mode == "design" and not design):
        return unavailable("the requested mode for this model variant")
    if not design and (not args.reference_audio or not Path(args.reference_audio).is_file()):
        return unavailable("cloning without a local reference recording")
    if not design and args.instructions:
        return unavailable("instruction-controlled reference cloning")
    # MLX Base uses in-context cloning. Without both a transcript and an
    # encoder it falls back to unconditioned speech, which is not cloning.
    if use_mlx and not design and not (args.reference_transcript or "").strip():
        return unavailable("MLX reference cloning without a transcript")

    use_offline_hub()
    try:
        with contextlib.redirect_stdout(sys.stderr):
            import numpy  # noqa: F401 - both backends need the audio writer deps
            import soundfile  # noqa: F401
            if use_mlx:
                import mlx.core as mx
                from mlx_audio.tts.utils import load_model

                mx.random.seed(args.seed)
                model = load_model(snapshot, strict=True)
                if model.tokenizer is None or model.speech_tokenizer is None:
                    raise ValueError("MLX model tokenizer is unavailable")
                if design:
                    results = list(model.generate_voice_design(
                        text=args.text, language="auto",
                        instruct=args.instructions or "A clear natural speaking voice.",
                        stream=False, verbose=False,
                    ))
                else:
                    if not model.speech_tokenizer.has_encoder:
                        raise ValueError("MLX reference encoder is unavailable")
                    results = list(model.generate(
                        text=args.text, lang_code="auto",
                        ref_audio=str(Path(args.reference_audio).resolve()),
                        ref_text=args.reference_transcript,
                        split_pattern=None, stream=False, verbose=False,
                    ))
                if len(results) != 1:
                    raise ValueError("Invalid MLX model audio result")
                # Materialize lazy MLX output before publishing any audio.
                mx.eval(results[0].audio)
                wavs, sample_rate = [results[0].audio], results[0].sample_rate
            else:
                torch, model = load_torch_model(snapshot, args.seed)
                with torch.inference_mode():
                    if design:
                        wavs, sample_rate = model.generate_voice_design(
                            text=args.text, language="Auto",
                            instruct=args.instructions or "A clear natural speaking voice.",
                        )
                    else:
                        wavs, sample_rate = model.generate_voice_clone(
                            text=args.text, language="Auto",
                            ref_audio=str(Path(args.reference_audio).resolve()),
                            ref_text=args.reference_transcript or None,
                            x_vector_only_mode=not bool(args.reference_transcript),
                        )
            write_model_audio(wavs, sample_rate, args.output_wav)
        print(json.dumps({
            "ok": True, "modelRevision": f"{args.model_id}@{snapshot.name}",
            "effectiveControls": {"rate": 1.0, "seed": args.seed,
                                  "instructions": (args.instructions or "A clear natural speaking voice.") if design else None,
                                  "mode": "design" if design else "clone"},
        }))
        return 0
    except ImportError:
        return unavailable("inference dependencies (install mlx-audio on Apple Silicon or qwen-tts on CPU/CUDA)")
    except Exception:
        return synthesis_failed(args.output_wav)


def run_checkpoint_synthesis(args: argparse.Namespace) -> int:
    """Speak with a checkpoint this adapter produced, verified before loading."""
    if is_apple_silicon():
        return unavailable("fine-tuned checkpoints on Apple Silicon")
    if args.rate != 1.0:
        return unavailable("speech-rate control")
    if args.instructions:
        return unavailable("instruction control for fine-tuned checkpoints")
    if not args.text or not args.text.strip():
        return unavailable("inference without text")
    checkpoint = Path(args.checkpoint_path) if args.checkpoint_path else None
    manifest = verified_checkpoint(checkpoint) if checkpoint else None
    if manifest is None:
        return unavailable("an unverified fine-tuned checkpoint")

    use_offline_hub()
    try:
        with contextlib.redirect_stdout(sys.stderr):
            torch, model = load_torch_model(checkpoint, args.seed)
            with torch.inference_mode():
                wavs, sample_rate = model.generate_custom_voice(
                    text=args.text, speaker=manifest["speaker"], language="Auto",
                )
            write_model_audio(wavs, sample_rate, args.output_wav)
        print(json.dumps({
            "ok": True, "modelRevision": checkpoint_revision(manifest),
            "effectiveControls": {"rate": 1.0, "seed": args.seed, "instructions": None, "mode": "fine-tuned"},
        }))
        return 0
    except ImportError:
        return unavailable("fine-tuned inference dependencies (install qwen-tts on CPU/CUDA)")
    except Exception:
        return synthesis_failed(args.output_wav)


# --- Fine-tuning -----------------------------------------------------------

def emit_event(stream, event: dict) -> None:
    print(json.dumps(event), file=stream, flush=True)


def training_failed(code: str, error: str) -> int:
    # Fixed messages only: dataset paths and transcripts are private.
    print(json.dumps({"ok": False, "code": code, "error": error}), file=sys.stderr)
    return 1


def load_training_dataset(path: Path) -> dict:
    """Validate the dataset manifest PortOS writes for one training job."""
    dataset = json.loads(path.read_text())
    speaker = dataset["speaker"]
    if not isinstance(speaker, str) or not SPEAKER_NAME_RE.fullmatch(speaker):
        raise ValueError("Invalid speaker name")
    reference = Path(dataset["reference_audio"])
    samples = dataset["samples"]
    if not reference.is_file() or not isinstance(samples, list) or not 0 < len(samples) <= MAX_TRAINING_SAMPLES:
        raise ValueError("Invalid training dataset")
    cleaned = []
    for sample in samples:
        audio, text = Path(sample["audio"]), sample["text"]
        if not audio.is_file() or not isinstance(text, str) or not text.strip() or len(text) > MAX_TRAINING_TEXT:
            raise ValueError("Invalid training sample")
        cleaned.append({"audio": str(audio), "text": text.strip()})
    return {"speaker": speaker, "reference_audio": str(reference), "samples": cleaned}


def checkpoint_revision(manifest: dict) -> str:
    """Bind a fine-tuned voice to its base revision and exact trained weights."""
    digest = manifest["files"][CHECKPOINT_WEIGHTS]["digest"]
    return f"{manifest['base_model_id']}@{manifest['base_revision']}+sha256.{digest}"


def write_checkpoint_files(snapshot: Path, target: Path, speaker: str) -> None:
    """Copy the verified base files a checkpoint loads, as the recipe does, and
    register the trained speaker. The recipe's trainer writes the weights."""
    for filename in REQUIRED_FILES:
        if filename == CHECKPOINT_WEIGHTS:
            continue
        destination = target / filename
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(snapshot / filename, destination)
    config = json.loads((snapshot / "config.json").read_text(encoding="utf-8"))
    config["tts_model_type"] = "custom_voice"
    talker = config.get("talker_config", {})
    talker["spk_id"] = {speaker: SPEAKER_TOKEN_ID}
    talker["spk_is_dialect"] = {speaker: False}
    config["talker_config"] = talker
    (target / "config.json").write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8")


def seal_checkpoint(target: Path, *, base_model_id: str, base_revision: str, speaker: str, step: int, loss) -> dict:
    """Record digests of every file the checkpoint loads. Synthesis refuses a
    checkpoint whose bytes no longer match."""
    files = {}
    for filename in REQUIRED_FILES:
        path = target / filename
        fingerprint = file_fingerprint(path)
        checksum = hashlib.sha256()
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                checksum.update(chunk)
        if file_fingerprint(path) != fingerprint:
            raise ValueError(f"Checkpoint file changed while sealing: {filename}")
        files[filename] = {"size": fingerprint[0], "algorithm": "sha256",
                           "digest": checksum.hexdigest(), "fingerprint": fingerprint}
    manifest = {
        "adapter": TRAINING_ADAPTER, "base_model_id": base_model_id, "base_revision": base_revision,
        "speaker": speaker, "step": step, "loss": loss, "files": files,
    }
    publish_json(target / CHECKPOINT_MANIFEST, manifest)
    return manifest


def verified_checkpoint(checkpoint: Path) -> dict | None:
    """Read a sealed checkpoint produced by this adapter; never fetch or trust
    unsealed, foreign or modified files."""
    try:
        manifest = json.loads((checkpoint / CHECKPOINT_MANIFEST).read_text())
        if (manifest["adapter"] != TRAINING_ADAPTER or manifest["base_model_id"] not in TRAINABLE_MODELS
                or not re.fullmatch(r"[0-9a-f]{40}", manifest["base_revision"])
                or not SPEAKER_NAME_RE.fullmatch(manifest["speaker"])):
            return None
        for filename in REQUIRED_FILES:
            metadata = manifest["files"][filename]
            if metadata["algorithm"] != "sha256":
                return None
            path = checkpoint / filename
            if sys.platform == "win32" or file_fingerprint(path) != metadata.get("fingerprint"):
                verify_file(path, metadata)
        return manifest
    except (OSError, ValueError, KeyError, TypeError):
        return None


def train_checkpoints(snapshot: Path, dataset: dict, args: argparse.Namespace, staging: Path, emit) -> list[dict]:
    """Run the official single-speaker SFT recipe and stage weight snapshots.

    This mirrors sft_12hz.py/dataset.py: codec-0 language-model loss plus 0.3x
    sub-talker loss, AdamW (lr 2e-5, weight decay 0.01), batch 2 with 4-step
    gradient accumulation and norm-1.0 clipping, bf16 weights, and the reference
    speaker embedding written into codec row 3000. Staged directories are not
    promotable until `run_fine_tuning` reloads and auditions them.
    """
    import librosa
    import torch
    from qwen_tts import Qwen3TTSModel
    from qwen_tts.core.models.modeling_qwen3_tts import mel_spectrogram
    from safetensors.torch import save_file

    torch.manual_seed(args.seed)
    attention = "flash_attention_2" if importlib.util.find_spec("flash_attn") else "eager"
    qwen = Qwen3TTSModel.from_pretrained(
        str(snapshot), device_map="cuda:0", dtype=torch.bfloat16,
        attn_implementation=attention, local_files_only=True,
    )
    model, processor, config = qwen.model, qwen.processor, qwen.model.config
    talker_config = config.talker_config

    def load_24k(path):
        audio, _ = librosa.load(path, sr=24000, mono=True)
        return audio.astype("float32")

    with torch.no_grad():
        reference = torch.from_numpy(load_24k(dataset["reference_audio"])).unsqueeze(0)
        reference_mel = mel_spectrogram(
            reference, n_fft=1024, num_mels=128, sampling_rate=24000,
            hop_size=256, win_size=1024, fmin=0, fmax=12000,
        ).transpose(1, 2)
        speaker_embedding = model.speaker_encoder(reference_mel.to(model.device).to(model.dtype)).detach()
        items = []
        for sample in dataset["samples"]:
            codes = model.speech_tokenizer.encode(load_24k(sample["audio"]), sr=24000).audio_codes[0]
            prompt = f"<|im_start|>assistant\n{sample['text']}<|im_end|>\n<|im_start|>assistant\n"
            text_ids = processor(text=prompt, return_tensors="pt", padding=True)["input_ids"]
            text_ids = text_ids.unsqueeze(0) if text_ids.dim() == 1 else text_ids
            # Codec encode runs in inference mode; rebuild plain tensors so the
            # embedding lookups can be saved for backward.
            items.append({"text_ids": text_ids[:, :-5], "codes": torch.tensor(codes.cpu().tolist(), dtype=torch.long)})

    def collate(batch):
        length = max(item["text_ids"].shape[1] + item["codes"].shape[0] for item in batch) + 8
        size = len(batch)
        input_ids = torch.zeros((size, length, 2), dtype=torch.long)
        codec_ids = torch.zeros((size, length, 16), dtype=torch.long)
        text_mask = torch.zeros((size, length), dtype=torch.bool)
        codec_embedding_mask = torch.zeros((size, length), dtype=torch.bool)
        codec_mask = torch.zeros((size, length), dtype=torch.bool)
        attention_mask = torch.zeros((size, length), dtype=torch.long)
        labels = torch.full((size, length), -100, dtype=torch.long)
        for i, item in enumerate(batch):
            text_ids, codes = item["text_ids"], item["codes"]
            text_len, codec_len = text_ids.shape[1], codes.shape[0]
            end = 8 + text_len + codec_len
            input_ids[i, :3, 0] = text_ids[0, :3]
            input_ids[i, 3:7, 0] = config.tts_pad_token_id
            input_ids[i, 7, 0] = config.tts_bos_token_id
            input_ids[i, 8:8 + text_len - 3, 0] = text_ids[0, 3:]
            input_ids[i, 8 + text_len - 3, 0] = config.tts_eos_token_id
            input_ids[i, 8 + text_len - 2:end, 0] = config.tts_pad_token_id
            text_mask[i, :end] = True
            input_ids[i, 3:8, 1] = torch.tensor([
                talker_config.codec_nothink_id, talker_config.codec_think_bos_id,
                talker_config.codec_think_eos_id, 0, talker_config.codec_pad_id,
            ])
            input_ids[i, 8:8 + text_len - 2, 1] = talker_config.codec_pad_id
            input_ids[i, 8 + text_len - 2, 1] = talker_config.codec_bos_id
            audio_start, audio_end = 8 + text_len - 1, 8 + text_len - 1 + codec_len
            input_ids[i, audio_start:audio_end, 1] = codes[:, 0]
            input_ids[i, audio_end, 1] = talker_config.codec_eos_token_id
            labels[i, audio_start:audio_end] = codes[:, 0]
            labels[i, audio_end] = talker_config.codec_eos_token_id
            codec_ids[i, audio_start:audio_end, :] = codes
            codec_embedding_mask[i, 3:end] = True
            codec_embedding_mask[i, 6] = False  # speaker embedding slot
            codec_mask[i, audio_start:audio_end] = True
            attention_mask[i, :end] = 1
        device = model.device
        return {
            "input_ids": input_ids.to(device), "codec_ids": codec_ids.to(device),
            "text_mask": text_mask.unsqueeze(-1).to(device),
            "codec_embedding_mask": codec_embedding_mask.unsqueeze(-1).to(device),
            "codec_mask": codec_mask.to(device), "attention_mask": attention_mask.to(device),
            "labels": labels.to(device),
        }

    def batch_loss(batch):
        input_ids, codec_ids, codec_mask = batch["input_ids"], batch["codec_ids"], batch["codec_mask"]
        text_embedding = model.talker.model.text_embedding(input_ids[:, :, 0]) * batch["text_mask"]
        codec_embedding = model.talker.model.codec_embedding(input_ids[:, :, 1]) * batch["codec_embedding_mask"]
        codec_embedding[:, 6, :] = speaker_embedding
        embeddings = text_embedding + codec_embedding
        for i in range(1, 16):
            layer = model.talker.code_predictor.get_input_embeddings()[i - 1]
            embeddings = embeddings + layer(codec_ids[:, :, i]) * codec_mask.unsqueeze(-1)
        outputs = model.talker(
            inputs_embeds=embeddings[:, :-1, :], attention_mask=batch["attention_mask"][:, :-1],
            labels=batch["labels"][:, 1:], output_hidden_states=True,
        )
        # The talker returns hidden_states as (per-layer states, codec ids);
        # [0][-1] is the final layer, batch dimension intact.
        hidden = outputs.hidden_states[0][-1][codec_mask[:, :-1]]
        _, sub_talker_loss = model.talker.forward_sub_talker_finetune(codec_ids[codec_mask], hidden)
        return outputs.loss + 0.3 * sub_talker_loss

    def stage(step, loss):
        target = staging / f"step-{step}"
        shutil.rmtree(target, ignore_errors=True)
        write_checkpoint_files(snapshot, target, dataset["speaker"])
        state = {key: value.detach().to("cpu") for key, value in model.state_dict().items()
                 if not key.startswith("speaker_encoder")}
        row = "talker.model.codec_embedding.weight"
        state[row] = state[row].clone()
        state[row][SPEAKER_TOKEN_ID] = speaker_embedding[0].detach().to("cpu", state[row].dtype)
        save_file(state, str(target / CHECKPOINT_WEIGHTS))
        return {"path": target, "step": step, "loss": loss}

    optimizer = torch.optim.AdamW(model.parameters(), lr=TRAINING_LEARNING_RATE, weight_decay=0.01)
    batches_per_epoch = math.ceil(len(items) / TRAINING_BATCH_SIZE)
    steps_per_epoch = math.ceil(batches_per_epoch / TRAINING_GRADIENT_ACCUMULATION)
    total_steps = steps_per_epoch * args.epochs
    generator = torch.Generator().manual_seed(args.seed)
    staged, step = [], 0
    model.train()
    for _epoch in range(args.epochs):
        order = torch.randperm(len(items), generator=generator).tolist()
        batches = [order[i:i + TRAINING_BATCH_SIZE] for i in range(0, len(order), TRAINING_BATCH_SIZE)]
        for start in range(0, len(batches), TRAINING_GRADIENT_ACCUMULATION):
            group = batches[start:start + TRAINING_GRADIENT_ACCUMULATION]
            total = 0.0
            for indices in group:
                loss = batch_loss(collate([items[i] for i in indices]))
                (loss / len(group)).backward()
                total += loss.item() / len(group)
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            optimizer.zero_grad(set_to_none=True)
            step += 1
            if not math.isfinite(total):
                raise ValueError("Training loss diverged")
            loss_value = round(total, 6)
            emit({"stage": "training", "step": step, "total_steps": total_steps, "loss": loss_value,
                  "progress": round(100 * step / total_steps, 2)})
            if step % args.checkpoint_interval == 0 or step == total_steps:
                staged.append(stage(step, loss_value))
    # Release the trainer before auditions load each checkpoint on the device.
    del optimizer, model, qwen
    torch.cuda.empty_cache()
    return staged


def run_fine_tuning(args: argparse.Namespace) -> int:
    """Train, then publish only checkpoints that reload and speak."""
    if args.model_id not in TRAINABLE_MODELS or not args.models_dir:
        return unavailable("fine-tuning without a supported verified Base model")
    if args.epochs < 1 or args.checkpoint_interval < 1:
        return training_failed("QWEN3_TRAINING_INVALID_REQUEST", "Invalid fine-tuning schedule")
    if not training_runtime_available():
        return unavailable("fine-tuning on this hardware/runtime (requires CUDA with bf16, qwen-tts and librosa)")
    snapshot = installed_snapshot(Path(args.models_dir) / args.model_id.replace("/", "--"), args.model_id)
    if snapshot is None:
        return unavailable("fine-tuning without downloaded and verified weights")
    try:
        dataset = load_training_dataset(Path(args.dataset_manifest))
    except (OSError, ValueError, KeyError, TypeError):
        return training_failed("QWEN3_TRAINING_INVALID_DATASET", "Fine-tuning dataset is missing or invalid")

    output_dir = Path(args.output_dir)
    staging = output_dir / ".staging"
    events = sys.stdout
    emit = lambda event: emit_event(events, event)  # noqa: E731
    use_offline_hub()
    try:
        with contextlib.redirect_stdout(sys.stderr):
            staged = train_checkpoints(snapshot, dataset, args, staging, emit)
            published = 0
            for item in staged:
                sample = item["path"] / "audition.wav"
                try:
                    # Seal first, then pass the same gate and loader synthesis
                    # uses: only sealed bytes that reload and speak are promotable.
                    manifest = seal_checkpoint(
                        item["path"], base_model_id=args.model_id, base_revision=snapshot.name,
                        speaker=dataset["speaker"], step=item["step"], loss=item["loss"],
                    )
                    if verified_checkpoint(item["path"]) != manifest:
                        raise ValueError("Checkpoint seal did not verify")
                    torch, model = load_torch_model(item["path"], args.seed)
                    with torch.inference_mode():
                        wavs, sample_rate = model.generate_custom_voice(
                            text=AUDITION_TEXT, speaker=manifest["speaker"], language="Auto",
                        )
                    write_model_audio(wavs, sample_rate, sample)
                    del model
                    torch.cuda.empty_cache()
                except Exception:
                    print(f"❌ Checkpoint at step {item['step']} failed its reload audition", file=sys.stderr)
                    shutil.rmtree(item["path"], ignore_errors=True)
                    continue
                target = output_dir / f"checkpoint-step-{item['step']}"
                os.replace(item["path"], target)
                published += 1
                emit({"stage": "checkpoint", "checkpoint": target.name, "step": item["step"],
                      "checkpoint_path": str(target), "sample_wav": str(target / "audition.wav"),
                      "loss": item["loss"], "model_revision": checkpoint_revision(manifest)})
        if not published:
            return training_failed("QWEN3_TRAINING_FAILED", "No fine-tuned checkpoint passed its reload audition")
        emit({"stage": "completed", "checkpoints": published})
        return 0
    except ImportError:
        return unavailable("fine-tuning dependencies")
    except Exception:
        return training_failed("QWEN3_TRAINING_FAILED", "Qwen3-TTS fine-tuning failed; unverified checkpoints were not published")
    finally:
        # Unpublished snapshots are full model copies; never leave them behind.
        shutil.rmtree(staging, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download", action="store_true", help="Explicitly download and verify a model snapshot")
    parser.add_argument("--probe", action="store_true", help="Probe runtime and available models")
    parser.add_argument("--models-dir", type=str, help="Directory containing downloaded model weights")
    parser.add_argument("--mode", choices=["design", "clone", "synthesize", "fine-tuned", "fine-tune"], default="synthesize")
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
    parser.add_argument("--dataset-manifest", type=str, help="JSON manifest of training audio, transcripts and reference")
    parser.add_argument("--output-dir", type=str, help="Output directory for training checkpoints")
    parser.add_argument("--epochs", type=int, default=5, help="Number of training epochs")
    parser.add_argument("--checkpoint-interval", type=int, default=50, help="Optimizer steps between checkpoints")

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
        with contextlib.redirect_stdout(sys.stderr):
            status = probe_runtime(models_dir)
        print(json.dumps(status))
        return 0

    if args.mode == "fine-tune":
        if not args.dataset_manifest or not args.output_dir:
            sys.stderr.write("Error: --dataset-manifest and --output-dir are required for fine-tune mode\n")
            return 1
        return run_fine_tuning(args)

    if not args.output_wav:
        sys.stderr.write("Error: --output-wav is required for synthesis\n")
        return 1

    return run_synthesis(args)


if __name__ == "__main__":
    raise SystemExit(main())
