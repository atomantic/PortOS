# Inkling 2 Mini as a local model (2026-11-21)

Thinking Machines released Inkling 2 Mini (`thinkingmachines/Inkling-2-Mini`) on 2026-11-20. This note records what PortOS needs to know to offer it, and why it is wired in the places it is.

## The model

- Apache-2.0. The vendor also publishes an acceptable-use policy; PortOS adds no gate of its own.
- 26.4B total, 3.4B active MoE (128 experts, 8 active). The middle 12 of 24 layers run three times with shared weights, about 5.4B effective active parameters per token.
- 1,048,576-token context, image input, tool calling, and a `reasoning_effort` chat-template kwarg (none to max). The vendor recommends capping output tokens and agent turns because long reasoning loops can occur; minimum effort does not fully disable thinking.
- The official checkpoint is NVFP4 (last four layers MXFP8) safetensors, about 20 GB, served by vLLM and SGLang. NVFP4 is a Blackwell format.
- Chat template is its own token format (`<|message_user|>`, `<|content_thinking|>`, `<|content_invoke_tool_json|>`), not ChatML, so it needs a runtime that applies the model's Jinja template.

## Runtime support

| Runtime | State on 2026-11-21 |
| --- | --- |
| llama.cpp | Added in b12406 (PR #32217). bartowski's GGUFs were made with b12600 and declare arch `inkling2_loop`. Older builds fail with `unknown model architecture: 'inkling2_loop'`. |
| Ollama | Use the library build (`inkling-2-mini:26b-a5b`, or `inkling-2-mini:26b-a5b-nvfp4` on Ollama's MLX engine). Third-party `hf.co/…` GGUFs go through Ollama's bundled llama.cpp, which still fails on an updated Ollama with `unknown projector type: inkling2v` and `unknown model architecture: 'inkling2_loop'`. |
| LM Studio | `lmstudio-community/Inkling-2-Mini-GGUF` (Q4_K_M, Q6_K, Q8_0) needs an updated llama.cpp engine. |
| MLX | Ollama's `inkling-2-mini:26b-a5b-nvfp4` is in the catalog for Apple Silicon. `mlx-community/Inkling-2-Mini-4bit` (17 GB) needs mlx-lm PR #2086, unmerged, so LM Studio's MLX engine has no entry yet (#17205). |
| vLLM / SGLang | Supported upstream with the NVFP4 checkpoint. No validated recipe for the RTX 3090 fleet host (Ampere has no native FP4). |

## What PortOS ships

- Catalog entries in `server/lib/localLlmCatalog.js`: `inkling-2-mini` (Ollama library GGUF and LM Studio) and `inkling-2-mini-mlx` (Ollama MLX, Apple Silicon only). Neither is featured, and both have a 32 GB memory floor.
- A llama-server preset (`inkling-2-mini` in `server/lib/specDecodePresets.js`) with bartowski Q4_K_M, a pinned f16 vision projector, and no drafter.
- `unknown model architecture` from any llama.cpp-based runtime is classified as a request-specific model fault with an "update the runtime" fix, rather than an unknown error that escalates.
- The fleet host advertises the model id its runtime actually serves instead of a hardcoded one, so a host pointed at another checkpoint is reported truthfully.
