"""Render a local checkpoint reconstruction before enabling AvatarForcing motion."""

import argparse
import time
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageOps
from safetensors.torch import load_file

from appearance import decode, encode, project_motion


def tensor_image(source, device):
    with Image.open(source) as image:
        image = ImageOps.fit(image.convert("RGB"), (512, 512), Image.Resampling.LANCZOS)
        result = torch.from_numpy(np.array(image)).permute(2, 0, 1)[None].float() / 127.5 - 1
    return result.to(device)


@torch.inference_mode()
def render(weights_dir, image, output, device):
    if device == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("MPS is not available")
    weights = {k: v.to(device) for k, v in load_file(
        weights_dir / "tensor" / "motion_autoencoder.safetensors", device="cpu").items()}
    start = time.perf_counter()
    identity, pyramid = encode(tensor_image(image, device), weights)
    style = identity + project_motion(identity, weights)
    pixels = decode(style, pyramid, weights)
    if tuple(pixels.shape) != (1, 3, 512, 512) or not pixels.isfinite().all().item():
        raise RuntimeError("Invalid reconstructed frame")
    frame = ((pixels[0].clamp(-1, 1).permute(1, 2, 0).float().cpu() + 1) * 127.5).byte().numpy()
    Image.fromarray(frame).save(output)
    print(f"One 512px reconstructed frame: {1000 * (time.perf_counter() - start):.0f} ms ({device}).")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("weights", "portrait", "output"):
        parser.add_argument(name, type=Path)
    parser.add_argument("--device", choices=["mps", "cpu"], default="mps")
    args = parser.parse_args()
    render(args.weights, args.portrait, args.output, args.device)
