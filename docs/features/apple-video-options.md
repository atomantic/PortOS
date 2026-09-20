# Apple Silicon video choices

Video Gen offers these complementary paths:

| Choice | Purpose | Important distinction |
| --- | --- | --- |
| FastMetal 1.3B | Small previews | Wan 2.1 sampler |
| FastMetal 5B | Balanced drafts | Dedicated Wan 2.2 sampler, trained three-step schedule |
| FastMetal 14B | Larger FastMetal model | Wan 2.1 sampler |
| FastH3 Preview INT4/INT6/INT8 | Four-step joint video and audio | Dense attention; official source is converted locally |
| FastH3 V2 INT6/INT8 | Eight-step joint video and audio | 80% VSA with reference attention; requires updated FastVideo |
| MiniMax H3 MLX 4/6/8-bit | Original H3 reference | Dense attention, very slow; smaller quantization is not a speed guarantee |

The V2 choices share the official source snapshot at
`3da2ddfe1954d9cda4c05b643dc0f26007a655c5`, approximately 147.9 GB total.
INT6/INT8 describe the locally converted transformer, not the total download.
Conversion retains routing weights with `--include-vsa` and uses a separate
cache from dense conversions. An older runtime fails with an update instruction
before conversion. FastVideo is pinned to commit
`430e52154e76b902c3cc17a16b3edc1fad790012`; older checkouts appear as needing
upgrade in Media Gen Settings. Repair / Upgrade checks out that revision and
prepares the small FastMetal preview decoders, without downloading the large
model snapshots or calling an AI provider. Update FastVideo there before using V2.
A process-local adapter reads video and audio scheduler shifts from the
checkpoint before inference, including V2’s video shift of 10; the denoising
ladder and converted AdaLN cache use the same shifts and eight-step schedule.
The adapter corrects the upstream converter’s four-step cache default before
it strips the original projections. Conversion caches include the schedule
version, step count and scheduler-config digest.
SIMD attention remains opt-in upstream; these choices use the reference path.

The Preview INT4 community repack is a preconverted package from MrMofer;
the official Preview INT4 choice converts the source checkpoint on first use.
Their repository links identify the provenance. Existing model IDs and custom
registry choices are preserved. New choices use the registry's existing
`_shippedDefaults` append mechanism; migration 398 also handles older registries
that predate that marker. Deliberately removed choices stay removed.

The original H3 quantizations share the same conditioner and VAE downloads.
They retain the conservative 128 GB memory requirement until end-to-end
measurements justify a lower floor. Transformer file size is not peak RAM.

Animation presets now include **Rotoscope cinematic** and **Unreal stylized
cinema**. These describe a visual treatment in the generation prompt; they do
not run an Unreal renderer or perform literal tracing of source footage.

## Sources

- [FastVideo upstream](https://github.com/hao-ai-lab/FastVideo)
- [Official FastH3 V2 checkpoint](https://huggingface.co/FastVideo/FastVideo-FastH3-8-Step-V2)
- [Community V2 MLX INT8 example](https://huggingface.co/vanch007/FastVideo-FastH3-8-Step-V2-MLX-INT8)
- [FastMetal 5B](https://huggingface.co/FastVideo/FastMetal-5B-QAD)
- [PipeNetwork H3 MLX runtime and quantizations](https://github.com/PipeNetwork/minimax-h3-mlx)

Upstream timings vary with resolution, frame count, decoder and hardware.
PortOS does not treat a published benchmark as a local ETA or promise real-time
generation.
