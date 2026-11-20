"""Sharded-checkpoint index guard shared by the diffusers-backed CUDA runners.

Mitigates GHSA-4j2p-28q2-5m79 (CVE-2026-69112): `accelerate` trusts the shard
names it reads out of a `*.index.json` `weight_map`, so a checkpoint can point a
shard at `../../etc/passwd` to read an arbitrary file, or at a FIFO to block the
loader forever. Upstream has declined to fix it (huggingface/accelerate#4067 —
"not a real security threat" under their SECURITY.md, which treats checkpoints
as trusted input), so there is no version to upgrade to: every runner that hands
accelerate a downloaded snapshot validates the indexes itself, first.

Stdlib-only at import time, like `_runner_common.py`, so each runner's venv
reaches it through the same-directory `sys.path.insert` idiom without growing a
dependency. Runners that load weights from explicit per-file paths rather than
from an index (`generate_ltx25_cuda.py`) do not need it.
"""

from __future__ import annotations

import json
import ntpath
import os
from pathlib import Path


def validate_checkpoint_indexes(snapshot: Path) -> None:
    """Reject shard entries that escape their component or are not regular files.

    Check lexical containment, preserving HF snapshot file symlinks into blobs,
    and refuse non-regular files before a loader can block opening a FIFO.
    Scan all component indexes, including ones already cached outside repoFiles.
    """
    def fail_walk(error):
        raise error

    snapshot_abs = os.path.abspath(snapshot)
    allowed_roots = {os.path.realpath(snapshot_abs)}
    # Hugging Face snapshots normally link files into the sibling `blobs/`
    # directory. Keep that supported link shape, but do not let an arbitrary
    # symlink turn a checkpoint shard into a read of another local file.
    for ancestor in Path(snapshot_abs).parents:
        if ancestor.name == "snapshots":
            allowed_roots.add(os.path.realpath(ancestor.parent / "blobs"))

    def is_under(path, root):
        try:
            return os.path.commonpath((path, root)) == root
        except ValueError:
            return False

    for folder, directories, files in os.walk(snapshot, onerror=fail_walk):
        # HF caches symlink FILES, not component directories. Do not silently
        # skip an index hidden behind a directory symlink during this walk.
        if any((Path(folder) / name).is_symlink() for name in directories):
            raise ValueError("Checkpoint component directories must not be symlinks.")
        for name in files:
            if not name.endswith(".index.json"):
                continue
            index_path = Path(folder) / name
            if not index_path.is_file():
                raise ValueError("Checkpoint index must be a regular file.")
            with index_path.open(encoding="utf-8") as handle:
                index = json.load(handle)
            if not isinstance(index, dict):
                raise ValueError("Checkpoint index must contain a weight map.")
            weight_map = index.get("weight_map", index)
            if not isinstance(weight_map, dict) or not weight_map:
                raise ValueError("Checkpoint weight map must be a non-empty object.")
            root = os.path.abspath(folder)
            for shard in weight_map.values():
                # Reject Windows drive/UNC/rooted paths on every host, as well
                # as backslashes: repository filenames use POSIX separators.
                if (not isinstance(shard, str) or not shard or "\x00" in shard
                        or "\\" in shard or ntpath.splitdrive(shard)[0]
                        or ntpath.isabs(shard)):
                    raise ValueError("Checkpoint shard must be a relative filename.")
                target = os.path.abspath(os.path.join(root, shard))
                if os.path.commonpath((root, target)) != root:
                    raise ValueError("Checkpoint shard escapes its component directory.")
                # An unused, partially cached component may lack shards. Leave
                # missing-file reporting to the loader, but never open a FIFO,
                # directory, device, or dangling symlink that DOES exist.
                if os.path.lexists(target):
                    resolved_target = os.path.realpath(target)
                    if not any(is_under(resolved_target, root) for root in allowed_roots):
                        raise ValueError("Checkpoint shard symlink escapes the model cache.")
                    if not os.path.isfile(target):
                        raise ValueError("Checkpoint shard must be a regular file.")
