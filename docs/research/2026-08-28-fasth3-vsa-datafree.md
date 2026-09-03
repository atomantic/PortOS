# FastH3 VSA data-free preview: CUDA bring-up and Apple Silicon watch

Date: 2026-08-28

## Verdict

The [FastVideo/FastVideo-FastH3-4-step-Preview-v1-VSA-DataFree](https://huggingface.co/FastVideo/FastVideo-FastH3-4-step-Preview-v1-VSA-DataFree)
checkpoint is not currently an Apple Silicon target for PortOS. Its model card
requires FastVideo's VSA-H3 attention backend and documents the CUDA 13 install
path with the published `fastvideo-kernel` wheel. The tested configuration uses
four B200 GPUs; the card's alternate recipe is still multi-GPU CUDA with Triton
and a GPU count that divides H3's 56 attention heads.

FastVideo's general documentation does mention macOS/MPS, and its current MPS
guide documents a base FastH3 MLX path through `mlx_fasth3.py`; that guide also
states that VSA is not wired into that path yet. This is distinct from the
separate FastMetal-QAD MLX runtime and does not cover this VSA-DataFree
checkpoint. PortOS's existing `minimax_h3` MLX runtime targets the PipeNetwork
MLX port of the base MiniMax H3 checkpoint, while `minimax_h3_cuda` targets the
Diffusers H3 base pipeline. None is evidence that this distilled VSA checkpoint
can run on Apple Silicon, and its current model card provides no MPS/MLX
instructions.

## CUDA follow-up

The existing CUDA runtime is the right integration seam to investigate. The
bring-up should first prove the upstream FastVideo command in a clean CUDA
environment, then determine whether PortOS should add a distinct model entry or
extend `minimax_h3_cuda`. Keep the checkpoint's four-step schedule, VSA-H3
backend, audio/video muxing, model-license disclosure, and multi-GPU topology
constraints explicit. Do not make the Apple Silicon runtime silently fall back
to CPU or claim compatibility before a real render succeeds.

## Apple Silicon watch

Revisit when FastVideo publishes all of the following for this checkpoint or a
compatible successor: an MPS/MLX-capable attention backend, installation and
runtime instructions for Apple Silicon, and a verified synchronized audio/video
render. Until then, keep this as a watch item rather than attempting to route
the CUDA kernel through MPS.

## References

- [FastH3 VSA data-free model card](https://huggingface.co/FastVideo/FastVideo-FastH3-4-step-Preview-v1-VSA-DataFree)
- [FastVideo installation guide](https://hao-ai-lab.github.io/FastVideo/getting_started/installation/)
- [FastVideo Apple Silicon/MPS guide](https://hao-ai-lab.github.io/FastVideo/getting_started/installation/mps/)
- [FastVideo VSA backend documentation](https://github.com/hao-ai-lab/FastVideo/tree/main/docs/attention/vsa)

Issue: [#5351](https://github.com/atomantic/PortOS/issues/5351)

## Addendum, 2026-09-02: the weights are there; the runtime is still dense

The VSA-DataFree repo does publish full weights — the DiT is under
`transformer/`, in the diffusers shard layout, beside the `vae/`, `audio_vae/`,
`text_encoder/` and `tokenizer/` the pipeline loads. An earlier read that looked
for a top-level checkpoint file found none and concluded the repo was a stub.
That conclusion was wrong about the weights, and it does not change the verdict:
FastVideo's MLX H3 runtime is dense-only, and its converter *drops* the VSA
routing projections by name — `_IGNORED_DENSE_KEY_PARTS = ("attn.to_gate_compress",)`
in `fastvideo/mlx_runtime/minimax_h3.py`, on the stated grounds that "the MLX
path is dense, so retaining these weights wastes about 3.6 GiB without affecting
a single output value." Converting the VSA student would therefore load it with
the mechanism it was distilled around deleted. VSA-DataFree stays a CUDA target.

**Dense-DataFree is the Apple Silicon checkpoint.**
`FastVideo/FastVideo-FastH3-4-step-Preview-v1-Dense-DataFree` @ `f624f08c` is the
one FastVideo's own MPS guide converts, and PortOS now ships it at all three MLX
DiT formats. FastVideo's three pre-converted MLX repos (`…-MLX-INT4/INT6/INT8`)
are still weightless as of this date — `usedStorage: 0`, five small files each —
so the local conversion is not an optimization, it is the only path to them.

### Measured on an M5 Max, 128 GB

832x480, 124 frames, 4 steps, INT4 DiT, full H3 VAE, dense attention:

| phase | seconds | peak GiB |
| --- | --- | --- |
| conditioning (streamed bf16 Qwen3-VL) | 307.0 | 1.8 |
| denoise (4 steps) | 229.3 | 14.9 |
| video decode (tiled) | 83.0 | 11.2 |
| audio decode | 2.8 | 2.4 |
| mux | 1.5 | — |

Output: 5.17 s of 832x480 H.264 at 24 fps with synchronized 32 kHz stereo AAC,
subjectively coherent across the clip. Peak memory is ~15 GiB — the published
36 GB floor is conservative, and 128 GB is not the binding constraint. **Disk
is**: the bf16 snapshot is 144 GB and the converted DiT another 11–22 GB.

Conditioning was half the wall clock and recomputes identical embeddings every
run, so PortOS now passes `--prompt-cache-dir`; upstream digests each entry over
its cache version, the model root and the prompt, so one shared directory is
safe across models. Re-running the same prompt on a warm cache took conditioning
from **307.0s to 0.003s** (621s to 336s end to end) and produced a **byte-identical
MP4** — so the saving costs nothing in output.

The conversion path was verified against the upstream snapshot directly: its
bf16 `transformer/` converted to an MLX INT6 DiT in **21.9s**, peak 19.4 GiB,
1464 arrays — the tensor count the repack's own conversion manifest records —
and rendered from that checkpoint. Denoise peaks at 19.6 GiB on INT6 against
14.9 GiB on INT4.

Renders are deterministic at a fixed seed: two runs at seed 2026 produced
byte-identical files.
