"""Check and assemble the pinned HyperQwen fast checkpoint without replacing healthy files."""

import json
import os
from pathlib import Path
import shutil
import sys
from tempfile import TemporaryDirectory

BASE = "/app/models/Qwen3.8-27B-W4A16-AutoRound"
REPO = "syvai/qwen3.8-27b-3090-fast-variant"
REVISION = "124c14e7e8c7d2f5402933b9af368e772a9fcf0c"
INDEX = "model.safetensors.index.json"
METADATA = ("config.json", "tokenizer.json", "tokenizer_config.json", "mtp_draft_vocab_ids.pt")
HUB_FILES = (INDEX, "config.json", "mtp_draft_vocab_ids.pt",
             "model-00007-of-00007.safetensors", "model_extra_tensors.safetensors")
BASE_METADATA = ("tokenizer.json", "tokenizer_config.json", "chat_template.jinja",
                 "generation_config.json", "processor_config.json", "quantization_config.json")


def readable(path):
    return path.is_file() and path.stat().st_size > 0


def shard_names(dir):
    try:
        weight_map = json.loads((dir / INDEX).read_text(encoding="utf-8"))["weight_map"]
        if isinstance(weight_map, dict) and weight_map and all(
            isinstance(name, str) and name.endswith(".safetensors")
            and all(part not in ("", ".", "..") for part in name.split("/"))
            and ":" not in name and "\\" not in name
            for name in weight_map.values()
        ):
            return set(weight_map.values())
    except (FileNotFoundError, UnicodeError, ValueError, TypeError, KeyError):
        pass
    return set()


def healthy_file(path):
    if not readable(path):
        return False
    if path.suffix != ".safetensors":
        return True

    from safetensors import SafetensorError, safe_open
    try:
        # Opening validates the header and data bounds without loading tensors.
        with safe_open(str(path), framework="np"):
            return True
    except SafetensorError:
        return False


def ready(dir):
    shards = shard_names(dir)
    return bool(shards) and all(readable(dir / name) for name in METADATA) and all(
        healthy_file(dir / name) for name in shards
    )


def repair(base, dest):
    if ready(dest):
        return
    dest.mkdir(parents=True, exist_ok=True)

    # Shared shards must remain hardlinks to the prepared base. Stage each
    # replacement beside its destination so readers never see a partial copy.
    with TemporaryDirectory(dir=dest) as temp:
        staging = Path(temp)
        for source in base.glob("model-0000*.safetensors"):
            if source.name in HUB_FILES or healthy_file(dest / source.name):
                continue
            os.link(source, staging / source.name)
            os.replace(staging / source.name, dest / source.name)

        for name in BASE_METADATA:
            source = base / name
            if readable(source) and not readable(dest / name):
                shutil.copyfile(source, staging / name)
                os.replace(staging / name, dest / name)

        needed = [name for name in HUB_FILES if not (
            shard_names(dest) if name == INDEX else healthy_file(dest / name)
        )]
        if needed:
            from huggingface_hub import snapshot_download
            snapshot = Path(snapshot_download(REPO, revision=REVISION, allow_patterns=needed))
            for name in needed:
                shutil.copyfile(snapshot / name, staging / name)
                os.replace(staging / name, dest / name)

    if not ready(dest):
        raise SystemExit(f"prepare: fast checkpoint remains incomplete at {dest}; "
                         f"check its indexed shards and the prepared base at {base}")


if __name__ == "__main__":
    base = Path(sys.argv[1] if len(sys.argv) > 1 else BASE)
    repair(base, base.with_name(base.name + "-fast"))
