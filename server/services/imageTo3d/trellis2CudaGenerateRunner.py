"""Single image -> textured GLB via upstream Microsoft TRELLIS.2 (CUDA).

Upstream ships no CLI: `example.py` is a demo with hard-coded input/output paths and
H100-tuned export settings. This is PortOS's entrypoint over the same documented
public API -- pipeline load, `run(image)`, then `o_voxel.postprocess.to_glb` -- with
the paths and the export budget passed in as arguments.

Progress contract: the banners printed here are the SAME vocabulary the Apple-Silicon
port's `generate.py` emits, because `server/services/imageTo3d/trellis2.js`'s
`parseGenerateProgress` parses both lanes. Keep them in sync with
GENERATE_STAGE_SIGNATURES there -- changing a banner silently flatlines the progress
bar for this lane. Output is unbuffered/flushed so the frames stream while a
multi-minute render is still running instead of arriving all at once at exit.
"""

import argparse
import os
import sys
import time
from pathlib import Path

# Must precede the torch/trellis2 imports: the EXR reader is opt-in in OpenCV, and
# the allocator setting materially reduces fragmentation OOMs on a 24GB card, which
# is the floor this lane supports.
os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")


def log(message):
    """Emit one progress banner, flushed so the parent sees it live."""
    print(message, flush=True)


def parse_args():
    parser = argparse.ArgumentParser(description="TRELLIS.2 CUDA image-to-3D runner")
    parser.add_argument("image", help="Source image path")
    parser.add_argument(
        "--repo-root",
        required=True,
        help="Clone of microsoft/TRELLIS.2 (its package dir goes on sys.path)",
    )
    parser.add_argument(
        "--output",
        help="Output path STEM -- '.glb' is appended, matching the Apple-Silicon port",
    )
    parser.add_argument("--texture-size", type=int, default=2048)
    parser.add_argument("--decimation-target", type=int, default=200_000)
    parser.add_argument(
        "--model",
        default="microsoft/TRELLIS.2-4B",
        help="Hugging Face repo id for the pipeline weights",
    )
    # Both mirror the Apple-Silicon port's generate.py so the two lanes accept the
    # same knobs: --seed matches its fixed default, --steps overrides the sampler
    # step count for all three flow phases (None -> the pipeline JSON default, 12).
    parser.add_argument("--seed", type=int, default=42, help="Random seed (default: 42)")
    parser.add_argument(
        "--steps", type=int, default=None,
        help="Override sampler steps for all three flow phases (default: pipeline JSON)",
    )
    return parser.parse_args()


def main():
    args = parse_args()

    image_path = Path(args.image)
    if not image_path.is_file():
        raise SystemExit(f"Source image not found: {image_path}")

    # Upstream's package is imported from the clone, not installed into site-packages
    # by setup.sh -- put the repo root first on sys.path, mirroring what running
    # example.py from inside the checkout would give us.
    repo_root = str(Path(args.repo_root).resolve())
    if repo_root not in sys.path:
        sys.path.insert(0, repo_root)

    log("Loading pipeline...")
    import torch  # noqa: E402  (deferred: importing torch costs seconds)
    from PIL import Image  # noqa: E402
    from trellis2.pipelines import Trellis2ImageTo3DPipeline  # noqa: E402
    import o_voxel  # noqa: E402

    if not torch.cuda.is_available():
        raise SystemExit(
            "CUDA is not available inside the TRELLIS.2 environment -- "
            "check the NVIDIA driver and the torch build installed by setup.sh."
        )
    log(f"Device: cuda ({torch.cuda.get_device_name(0)})")

    pipeline = Trellis2ImageTo3DPipeline.from_pretrained(args.model)
    pipeline.cuda()

    image = Image.open(image_path)
    log(f"Generating 3D model (seed={args.seed})...")
    started = time.time()
    # The pipeline's own sampling loops print tqdm bars; the parent scales those into
    # its sampling band, so nothing extra is emitted here. The sampler override shape
    # mirrors the Apple-Silicon port's generate.py exactly.
    sampler_overrides = {"steps": args.steps} if args.steps else {}
    mesh = pipeline.run(
        image,
        seed=args.seed,
        sparse_structure_sampler_params=sampler_overrides,
        shape_slat_sampler_params=sampler_overrides,
        tex_slat_sampler_params=sampler_overrides,
    )[0]

    # nvdiffrast cannot rasterize past 2^24 triangles; upstream simplifies to that
    # ceiling before any export work. This is the hard renderer limit, distinct from
    # --decimation-target below (the quality/VRAM budget PortOS picks per card).
    mesh.simplify(16_777_216)
    log(f"Mesh: {len(mesh.vertices)} vertices, {len(mesh.faces)} faces")
    log(f"Generation time: {time.time() - started:.1f}s")

    log(f"Baking textures at {args.texture_size}px...")
    glb = o_voxel.postprocess.to_glb(
        vertices=mesh.vertices,
        faces=mesh.faces,
        attr_volume=mesh.attrs,
        coords=mesh.coords,
        attr_layout=mesh.layout,
        voxel_size=mesh.voxel_size,
        aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
        decimation_target=args.decimation_target,
        texture_size=args.texture_size,
        remesh=True,
        remesh_band=1,
        remesh_project=0,
        verbose=True,
    )

    # The parent hands us a stem and appends nothing itself, so own the extension here
    # -- the same contract the Apple-Silicon port's generate.py uses.
    stem = args.output or str(image_path.with_suffix(""))
    out_path = Path(f"{stem}.glb")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    # extension_webp keeps the baked atlas small enough to serve and download without
    # a separate compression pass.
    glb.export(str(out_path), extension_webp=True)

    # Terminal signal: the parent treats a printed .glb path as the export frame and
    # takes the produced asset path from it.
    log(f"Saved: {out_path}")


if __name__ == "__main__":
    main()
