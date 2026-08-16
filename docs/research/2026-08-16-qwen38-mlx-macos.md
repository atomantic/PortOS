# Qwen3.8 27B MLX options on macOS

Date: 2026-08-16

## Recommendation

Recommend `lmstudio-community/Qwen3.8-27B-MLX-4bit` as PortOS's fast macOS
install option for Qwen3.8 27B. It is a complete MLX checkpoint, is published
by the LM Studio community for its Apple-Silicon MLX engine, and fits the
existing LM Studio `lms get` installation path. The catalog exposes it only on
Apple Silicon and marks it as **Fast on Apple Silicon**.

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
native MLX model is the correct integration boundary; MLX/LM Studio own the
operator implementation and can update it independently.

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

## PortOS behavior

- LM Studio on Apple Silicon: recommends and installs the complete 4-bit MLX
  target through the existing model-install endpoint.
- LM Studio on Intel macOS and non-macOS hosts: hides the MLX recommendation;
  the existing GGUF catalog remains available.
- Ollama: retains the existing Qwen3.8 GGUF entry. Ollama cannot install an
  arbitrary Hugging Face MLX safetensors repository through this catalog.
- Migration: a known LM Studio-only MLX entry is not guessed into an Ollama
  model name.

## Sources

- [`mlx.core.fast` documentation](https://ml-explore.github.io/mlx/build/html/python/fast.html)
- [MLX-LM](https://github.com/ml-explore/mlx-lm)
- [Complete Qwen3.8 27B MLX 4-bit checkpoint](https://huggingface.co/lmstudio-community/Qwen3.8-27B-MLX-4bit)
- [Qwen3.8 27B MTP 4-bit drafter](https://huggingface.co/mlx-community/Qwen3.8-27B-MTP-4bit)
- [Qwen3.8 27B MTP 8-bit drafter](https://huggingface.co/mlx-community/Qwen3.8-27B-MTP-8bit)
- [MLX-VLM speculative decoding](https://github.com/Blaizzy/mlx-vlm)
- [LM Studio speculative decoding](https://lmstudio.ai/docs/app/advanced/speculative-decoding)
- [LM Studio 0.4.14 MTP support](https://lmstudio.ai/changelog/lmstudio/lmstudio-v0.4.14)
