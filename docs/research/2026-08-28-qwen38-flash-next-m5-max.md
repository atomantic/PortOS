# Qwen3.8-Flash-Next on Apple M5 Max

Date: 2026-08-28

## Decision

The best local path for this machine is the community MLX 4-bit conversion
through MLX-VLM, not the currently installed llama.cpp build. The machine has
128 GB of unified memory, while the conversion reports 111.58 GB (103.91 GiB)
of weights before runtime and context overhead. It loads, but only with a
small memory margin. Keep the runtime at one request and start with a 4K
context; a 16K context OOMed during this evaluation.

This is an experimental local install, not a new PortOS default. The model is
a 125B-parameter sparse MoE with 6B active parameters plus 51B n-gram
embeddings. Its advertised capabilities do not remove the memory cost of the
stored weights.

## Machine and runtime

The measurement was taken on an Apple M5 Max with 40 GPU cores and 128 GB
unified memory, running macOS 26.6.2. The installed runtime was:

| Component | Version or build |
| --- | --- |
| MLX-VLM | 0.6.17 |
| MLX / MLX Metal | 0.32.2 |
| Transformers | 5.16.1 |
| Python | 3.11.11 |
| llama.cpp | 0.1.1-dev, build 10470 |

The GGUF Q3 download is approximately 90 GB and the MLX 4-bit conversion is
approximately 104 GiB on disk. Both were placed in ignored, machine-local
model directories; no model weights belong in the repository.

## Installation

The following keeps the Python runtime separate from PortOS and downloads the
Apple-Silicon conversion into the machine-local PortOS model area:

```bash
uv venv --python 3.11 ~/.portos/qwen38-flash-mlx
uv pip install --python ~/.portos/qwen38-flash-mlx/bin/python \
  mlx-vlm==0.6.17 jinja2
~/.portos/qwen38-flash-mlx/bin/hf download Vontra/Qwen3.8-Flash-Next-MLX-4bit \
  --local-dir ~/.portos/models/Qwen3.8-Flash-Next-MLX-4bit \
  --max-workers 4
```

The first text smoke test is:

```bash
~/.portos/qwen38-flash-mlx/bin/python -m mlx_vlm.generate \
  --model ~/.portos/models/Qwen3.8-Flash-Next-MLX-4bit \
  --prompt "Explain sparse mixture-of-experts models in one sentence." \
  --max-tokens 64 --temperature 0 --thinking-mode disabled --verbose
```

For vision, resize large images before sending them. A full-resolution phone
photo expanded to about 11,870 visual tokens and exhausted Metal memory here;
the same public sample resized to 768 px wide fit:

```bash
sips -Z 768 -s format jpeg input.jpg --out /tmp/qwen38-input.jpg
~/.portos/qwen38-flash-mlx/bin/python -m mlx_vlm.generate \
  --model ~/.portos/models/Qwen3.8-Flash-Next-MLX-4bit \
  --image /tmp/qwen38-input.jpg --resize-shape 768 768 \
  --prompt "Describe this image in one sentence." \
  --max-tokens 64 --temperature 0 --thinking-mode disabled --verbose
```

Qwen's own model card documents Transformers, vLLM, SGLang, llama.cpp GGUF,
and MLX as supported integration families. On Apple Silicon, MLX-VLM is the
appropriate first experiment; vLLM and SGLang are primarily useful on a
supported NVIDIA host.

## Measurements

The model loaded successfully in about 16 seconds after the files were local.
Observed peak MLX memory was 111.8–113.3 GB depending on prompt and image
path. The warmed single-process text run produced these measurements:

| Requested context | Prompt tokens | Prompt tok/s | Generation tok/s | Peak memory | Result |
| ---: | ---: | ---: | ---: | ---: | --- |
| 512 | 448 | 10.57 | 14,440* | 112.48 GB | Stopped after 1 token |
| 4,096 | 3,470 | 686.55 | 40.54 | 113.28 GB | Stopped after 2 tokens |
| 16,384 | — | — | — | — | Metal OOM during prefill |

\* The 512-token generation rate is not meaningful because the model emitted
only one token; it is retained to show the observed boundary rather than
presenting a synthetic throughput number.

The resized 768 px vision run reached 12.66 prompt tok/s and 29.78 generation
tok/s at 112.90 GB peak. It fit, but the response did not cleanly satisfy the
one-word visual question. The full-resolution run failed with Metal
`Insufficient Memory` during visual prefill. The text smoke and benchmark also
showed premature or structural-token-heavy stops with thinking explicitly
disabled. These are runtime/quantization compatibility observations, not a
claim about the model's general quality.

## llama.cpp result

The downloaded Unsloth Q3 GGUF is a better memory-sized artifact for a future
llama.cpp comparison, but the installed llama.cpp build rejects it before
loading with:

```text
error loading model: unknown model architecture: 'qwen4exp'
```

Do not work around this by editing the GGUF or forcing an older loader. Upgrade
to a llama.cpp build that explicitly supports `qwen4exp`, then compare the
same prompt set against the MLX run. The model card confirms that Qwen3.8 uses
the new `qwen4_exp` architecture and that current compatible runtimes are
required.

After that upgrade, the already-downloaded GGUF can be served with the same
single-slot profile (the first shard is the model path):

```bash
llama-server \
  --model ~/.portos/models/Qwen3.8-Flash-Next-UD-Q3_K_XL/UD-Q3_K_XL/Qwen3.8-Flash-Next-UD-Q3_K_XL-00001-of-00003.gguf \
  --mmproj ~/.portos/models/Qwen3.8-Flash-Next-UD-Q3_K_XL/mmproj-F16.gguf \
  --host 127.0.0.1 --port 5569 --ctx-size 4096 --parallel 1 \
  --n-gpu-layers 999 --flash-attn on --jinja --alias qwen38-flash-q3
```

## Operating guidance

- Stop or unload other model/video workloads before loading the 4-bit MLX
  checkpoint; the model leaves little headroom on a 128 GB machine.
- Use a single slot and begin at 4K context. Treat 16K as unsupported on this
  box unless a later runtime materially reduces memory use.
- Resize images before vision requests and benchmark image resolution as a
  separate axis from text context.
- Evaluate task completion and response correctness, not only the short-lived
  decoder rate. This run fit physically but did not pass the minimal response
  correctness checks.
- Keep the existing 27B/Qwen coding paths as the production local defaults
  until this model has a compatible loader and a representative task pass.

## Sources

- [Qwen3.8-Flash-Next model card](https://huggingface.co/Qwen/Qwen3.8-Flash-Next)
- [Qwen3.8-Flash-Next official repository](https://github.com/QwenLM/Qwen3.8-Flash-Next)
- [Vontra MLX 4-bit conversion](https://huggingface.co/Vontra/Qwen3.8-Flash-Next-MLX-4bit)
- [Unsloth Q3 GGUF quantizations](https://huggingface.co/unsloth/Qwen3.8-Flash-Next-GGUF)
- [MLX-VLM](https://github.com/Blaizzy/mlx-vlm)
