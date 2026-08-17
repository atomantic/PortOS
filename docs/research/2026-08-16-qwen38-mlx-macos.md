# Qwen3.8 27B MLX options on macOS

Date: 2026-08-16

## Recommendation

Recommend the native Qwen3.8 27B MLX build through both supported local
backends on Apple Silicon: `qwen3.8:27b-mlx` for Ollama and
`mlx-community/Qwen3.8-27B-4bit` for LM Studio. Both are complete MLX
checkpoints and fit the backends' existing installation paths. The catalog
exposes them only on Apple Silicon and marks them as **Fast on Apple Silicon**.

This is a format/runtime recommendation, not a promise of a fixed tokens-per-
second improvement. MLX versus GGUF speed depends on the Mac, memory pressure,
context length, LM Studio version, and sampling settings; users should benchmark
both builds for their workload.

## Why PortOS does not implement `mlx.fast`

MLX's fast API is the `mx.fast` namespace: fused operations such as rotary
embeddings, RMS normalization, and scaled dot-product attention. It is a
low-level primitive used by MLX model implementations, not an installer, model
format, or alternate server endpoint. PortOS currently orchestrates Ollama and
LM Studio from its JavaScript server and does not own an MLX Python inference
loop where replacing operators would have an effect.

There is therefore no useful PortOS feature to add for `mlx.fast` itself. The
native MLX model is the correct integration boundary; Ollama or LM Studio owns
the operator implementation and can update it independently.

## Why the linked MTP repos are not catalog installs

`mlx-community/Qwen3.8-27B-MTP-4bit` and `...MTP-8bit` are MTP drafter
checkpoints. Their model cards explicitly describe them as non-standalone
weights to pair with a compatible Qwen3.8 27B target through `mlx-vlm`
speculative decoding. Installing one by itself would not produce a usable
Qwen3.8 chat model, so PortOS does not present either repository as a normal
recommended model.

The linked MTP repositories also do not make the base model faster by simply
changing its quantization. They add a second draft-model path, which can reduce
decode latency only when the target runtime supports that exact MTP architecture
and the draft's proposed tokens are accepted often enough. A poorly matched
draft can add overhead instead.

The live MLX discovery path also excludes repositories explicitly named as MTP
or drafter checkpoints, so these auxiliary weights are not presented as normal
one-click chat-model installs.

LM Studio has added speculative-decoding support for models with built-in MTP
heads, but that is a different compatibility path from automatically pairing an
arbitrary `qwen3_5_mtp` sidecar with the curated MLX base model. PortOS does not
install or launch `mlx-vlm`, MTPLX, or an MTP sidecar runtime on the user's
behalf. The existing MTPLX integration remains an explicit, separately managed
operator choice.

## Uncensored evaluation variant

PortOS also catalogs `orcarouter/Qwen3.8-27B-Uncensored-MLX` for explicit
red-team and unrestricted local evaluation. The repository is gated on Hugging
Face and publishes several quantizations under one repository. The shared
catalog recommends it on both Apple-Silicon backends: PortOS downloads the
self-contained 15.0 GB `4-bit/` checkpoint and imports it with `ollama create`,
while LM Studio can select another available quantization. Users must accept
the repository terms and configure a Hugging Face token before installing.

## PortOS behavior

- Ollama on Apple Silicon: recommends and pulls the packaged
  `qwen3.8:27b-mlx` model through Ollama's native MLX engine. It also offers the
  curated OrcaRouter uncensored build, downloading its gated 4-bit Safetensors
  directory and importing it under
  `orcarouter/qwen3.8-27b-uncensored-mlx:4bit` with Ollama 0.19 or newer.
- LM Studio on Apple Silicon: recommends and installs the complete 4-bit MLX
  target through the existing model-install endpoint.
- LM Studio on Intel macOS and non-macOS hosts: hides the MLX recommendation;
  the existing GGUF catalog remains available.
- Ollama on non-Apple hosts: hides the MLX recommendation; the existing GGUF
  entry remains available.
- Migration: the known backend-specific MLX ids map exactly so switching
  backends installs the equivalent package instead of guessing a model name.

## Sources

- [`mlx.core.fast` documentation](https://ml-explore.github.io/mlx/build/html/python/fast.html)
- [MLX-LM](https://github.com/ml-explore/mlx-lm)
- [Ollama's MLX engine announcement](https://ollama.com/blog/mlx)
- [Ollama Safetensors import](https://docs.ollama.com/import)
- [Complete Qwen3.8 27B MLX 4-bit checkpoint](https://huggingface.co/mlx-community/Qwen3.8-27B-4bit)
- [OrcaRouter Qwen3.8 27B Uncensored MLX](https://huggingface.co/orcarouter/Qwen3.8-27B-Uncensored-MLX)
- [Qwen3.8 27B MTP 4-bit drafter](https://huggingface.co/mlx-community/Qwen3.8-27B-MTP-4bit)
- [Qwen3.8 27B MTP 8-bit drafter](https://huggingface.co/mlx-community/Qwen3.8-27B-MTP-8bit)
- [MLX-VLM speculative decoding](https://github.com/Blaizzy/mlx-vlm)
- [LM Studio speculative decoding](https://lmstudio.ai/docs/app/advanced/speculative-decoding)
- [LM Studio 0.4.14 MTP support](https://lmstudio.ai/changelog/lmstudio/lmstudio-v0.4.14)
