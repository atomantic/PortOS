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
