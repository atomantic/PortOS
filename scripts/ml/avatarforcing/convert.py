"""Convert verified AvatarForcing checkpoint tensors into a non-pickle format."""

from __future__ import annotations

import argparse
import os
import tempfile
from collections.abc import Mapping
from pathlib import Path

from weights import ARTIFACTS, verify


def unpack_tensors(checkpoint, tensor_type):
    if not isinstance(checkpoint, Mapping):
        raise ValueError("Expected a checkpoint mapping")
    if "state_dict" in checkpoint:
        checkpoint = checkpoint["state_dict"]
    if not isinstance(checkpoint, Mapping) or not checkpoint:
        raise ValueError("Expected a nonempty state dictionary")
    if any(not isinstance(name, str) or not name or type(tensor) is not tensor_type
           for name, tensor in checkpoint.items()):
        raise ValueError("Checkpoint state dictionary contains non-tensor values")
    return checkpoint


def convert(root: Path) -> None:
    import torch
    from safetensors import safe_open
    from safetensors.torch import save_file

    target_dir = root / "tensor"
    target_dir.mkdir(mode=0o700, exist_ok=True)
    if root.is_symlink() or target_dir.is_symlink() or (root / "source").is_symlink():
        raise ValueError("Symbolic links are not accepted in the conversion directories")

    for artifact in ARTIFACTS:
        if not artifact.path.endswith(".pth"):
            continue
        source = root / artifact.destination
        verify(source, artifact)
        # Never relax weights_only or register custom classes. The runner
        # consumes safetensors only and does not import the upstream package.
        with source.open("rb") as stream:
            original = unpack_tensors(torch.load(stream, map_location="cpu", weights_only=True), torch.Tensor)
        output = target_dir / Path(artifact.path).with_suffix(".safetensors")
        with tempfile.TemporaryDirectory(prefix=".convert-", dir=target_dir) as staging:
            temporary = Path(staging) / output.name
            save_file({key: value.detach().contiguous().clone() for key, value in original.items()}, temporary,
                      metadata={"source_sha256": artifact.sha256, "source_revision": artifact.revision})
            with safe_open(temporary, framework="pt", device="cpu") as converted:
                if set(original) != set(converted.keys()) or any(
                    tuple(value.shape) != tuple(converted.get_slice(key).get_shape()) for key, value in original.items()
                ):
                    raise ValueError("Converted tensor inventory changed")
            temporary.chmod(0o600)
            os.replace(temporary, output)
            print(f"Converted {output.name}: {len(original)} tensors", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    convert(parser.parse_args().root)
