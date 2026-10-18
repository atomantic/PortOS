# MOSS Image on Apple Silicon

PortOS offers **MOSS Image SFT Preview**, using a pinned community Swift/MLX port. It is an optional local text-to-image runtime. It does not change the default model or install anything at boot.

## Supported profile

- Native arm64 macOS 26 or later; Swift 6.3 or later and Apple's Metal compiler for building.
- At least 48 GiB unified memory for eligibility. Actual validation used an M5 Max with 128 GiB; the lower eligibility floor is conservative headroom, not a measured guarantee on smaller machines.
- SFT weights, bf16, 256–1024 pixels per side in multiples of 16; 1–100 steps, CFG 0–10. The ordinary profile is 1024 square, 50 steps, CFG 3.
- Positive and negative text prompts. CFG 1 with a nonempty negative prompt is rejected because upstream would ignore that prompt.
- No image editing, reference images, LoRAs, regeneration or quantization options in this profile.
- Prompt token counts include the chat template. More than 4096 tokens are rejected before weights load; PortOS never silently truncates the text.

Choose the MOSS model under Settings → Image Gen → Local. Its runtime status offers **Install MOSS Swift runtime**, then a separate **Download / repair MOSS weights (27.2 GB)** action. The model download badge uses the same pinned download. Rendering requires both actions to have succeeded; it does not fetch missing assets implicitly.

Allow 10 GiB of free space for the source build, plus 27,219,783,878 bytes for the selected weight/configuration files. A first Xcode Metal compiler installation may require additional space; if `xcrun metal --version` fails, install the Metal Toolchain through Xcode or Apple's `xcodebuild -downloadComponent MetalToolchain`. PortOS reports this prerequisite and does not install system toolchains automatically.

The runtime lives under `data/repos/moss-swift-runtime/`, the existing regenerable source/runtime backup class. Failed/cancelled build directories remain there for diagnosis. Successful builds retain the executable, Metal/tokenizer resource bundles, dependency lock and license notices, then remove their scratch build tree. Weights use the standard Hugging Face cache and an immutable snapshot; `HF_HUB_CACHE`, `HF_HOME` and `XDG_CACHE_HOME` retain their usual precedence. No application record store, database migration or federation category is introduced.

## Evidence and pins

| Component | Pin / evidence |
|---|---|
| Official architecture and inference | [OpenMOSS/MOSS-Image at c1355e6](https://github.com/OpenMOSS/MOSS-Image/tree/c1355e6b1986dfe8fba3c0455783a05899212342) |
| Community Swift/MLX source, MIT | [xocialize/moss-image-swift at 6c26a02](https://github.com/xocialize/moss-image-swift/tree/6c26a0296ba2d2a09e061d89a9b9b758786cd186) |
| SFT weights, Apache-2.0 | [OpenMOSS-Team/MOSS-Image-SFT at fc5de0d](https://huggingface.co/OpenMOSS-Team/MOSS-Image-SFT/tree/fc5de0d56fc910cbca6f6625a70f5f582b26deb1) |
| Selected files and SHA-256 digests | [manifest.json](../scripts/moss-image/manifest.json) |
| Sixteen exact Swift package revisions | [Package.resolved](../scripts/moss-image/Package.resolved) |
| PortOS argument validation and token preflight | [moss_image.swift](../scripts/moss_image.swift) |

MOSS uses a roughly 5.1B single-stream diffusion transformer, a Qwen3.5-9B text encoder and a FLUX.2 VAE. The official Python entry point selects CUDA or CPU, not MPS; its float64 accelerator timestep construction fails on MPS. Changing only the device string is not a working Apple implementation. ComfyUI's [MOSS integration](https://github.com/Comfy-Org/ComfyUI/pull/17095) is separate and was not validated here.

Local validation on 2026-10-18, macOS 27.0.1 / Swift 6.4:

| SFT bf16 render | Wall time | MLX peak | Process peak footprint |
|---|---:|---:|---:|
| 512×512, 4 steps, red teapot smoke test | 63.66 s | 26.17 GB | 26.45 GB |
| 1024×1024, 50 steps, red teapot and “MOSS IMAGE” card | 378.72 s | 26.18 GB | 28.70 GB |
| Freshly installed PortOS adapter, 512×512, 4 steps | 33.61 s | 26.17 GB | 26.48 GB |

A fresh install built successfully with the shipped lock, packaged the resource bundles and dependency notices, passed its Metal probe from an unrelated working directory, and rendered through the relocated PortOS adapter. Real CLI checks rejected a non-multiple-of-16 dimension, a negative prompt with CFG 1, and a 5011-token prompt before model loading.

The full render produced a coherent photograph and readable requested text. Other development/database work was active, so these timings are contended-machine observations, not isolated benchmarks. RSS and MLX allocator peaks do not represent the whole process footprint; the table uses the separately reported process footprint for that comparison.

This is a new community port, not established official Apple support. Base, int8/int4, larger resolutions, older Apple chips and smaller-memory Macs remain unvalidated. Upstream reports int8 memory reductions, but PortOS does not expose them without its own evidence. Upstream numerical oracle files are not shipped, and some tests skip without private weight paths; ordinary package-test success is not a numerical-parity claim.

The source review covered the port and pinned package manifests/licenses, not every transitive dependency source file. Builds use the reviewed dependency lock with `--force-resolved-versions`; updates require new review and rendering evidence. The adapter clears upstream experimental environment overrides, validates the relocated Metal executable, preserves source and dependency notices, verifies all downloaded file hashes, and retains normal PortOS heavy-job admission, cancellation, image checks and metadata publication.
