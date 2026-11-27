# Local LLM runtimes

Manage servers in **Models → Runtimes** and enable presets in **AI Providers**. Keep these endpoints on loopback. For private fleet inference, see [dedicated host setup](./fleet-llm-host.md).

| Host | Runtime | Default API |
| --- | --- | --- |
| Apple Silicon, macOS 14+ | [MTPLX](#mtplx-on-apple-silicon) native MTP | `http://127.0.0.1:8000/v1` |
| NVIDIA RTX 3090 (24 GB), Linux or WSL2 | [vLLM](#vllm-on-rtx-3090) with DFlash 2 | `http://127.0.0.1:18020/v1` |
| NVIDIA H200 or Blackwell, Linux or WSL2 | [SGLang](#sglang-on-hopper-or-blackwell) | `http://127.0.0.1:18021/v1` |
| Hardware supported by llama.cpp | [llama-server](#speculative-decoding-in-llama-server) with compatible base and draft GGUFs | Use the configured runtime port |

## MTPLX on Apple Silicon

1. On **Models → Runtimes → Local Runtime Servers**, install MTPLX. PortOS uses its private environment under `data/tools/mtplx`.
2. Use **Download default checkpoint** or search **Find a checkpoint** for an MTPLX-compatible MTP model. Checkpoints are separate downloads. A community MLX checkpoint needs explicit MTPLX support.
3. Choose the cached checkpoint, **Save configuration**, and start. Alternatively, use the MTPLX checklist under **AI Providers** to install and start with the verified default. An empty cache requires **Download the default model & start MTPLX**.
4. Use **MTPLX (local MTP)** for ordinary API generation or **OpenCode MTPLX** CLI/TUI for CoS coding. PortOS refreshes managed model lists when the server or cache changes. Use **Refresh Models** for an externally started server.

**Idle release** stops PortOS's process after the configured idle window. The next PortOS request loads the saved checkpoint again. Direct clients neither reset that timer nor start the process, so set the window to `0` if they need continuous access. MTPLX starts on demand and **Save PM2 list for reboot** excludes it. An external server appears as **Running (external)** and remains under its operator's control.

## vLLM on RTX 3090

1. Use Compose 2.24.4+ and the NVIDIA Container Toolkit (driver 580+). On Windows, enable Docker Desktop integration and keep the project and weights in a Linux WSL2 distro.
2. Open the vLLM provider readiness checklist and use **Clone, build & prepare**. The guided install prepares the pinned Compose checkout, image, checkpoint and key. For an operator-prepared checkout, use `~/qwen-serving` or set `VLLM_QWEN_PROJECT_DIR`. PortOS can discover the WSL location. For an override from Windows use a readable UNC path under `\\wsl.localhost\<distro>`.
3. In a manual checkout, set the following in the project's `.env` so Qwen tool calls return as structured events.

   ```ini
   EXTRA_ARGS=--enable-auto-tool-choice --tool-call-parser qwen3_xml
   ```

4. Use the checklist **Start** after preparing a complete checkpoint. Start uses the serving service without building, pulling or starting Compose dependencies. Stop other GPU workloads first. If WSL2 startup fails on the GPU memory gate, try `GPU_UTIL=0.93` in the project `.env`.
5. Verify model discovery with `curl -H "Authorization: Bearer $VLLM_API_KEY" http://127.0.0.1:18020/v1/models`. Enable **OpenCode vLLM TUI (Qwen3.8-27B)**. Supply the key from the project if setup did not fill it, refresh models, and use the served ID (seeded as `qwen3.8-27b`). In **Generation Defaults**, set thinking off and temperature near 0.7 for coding.

PortOS checks the project's `models/` or configured `MODELS_DIR`. `VLLM_QWEN_WEIGHTS_DIR` points readiness checks at an alternate host-visible path. The Compose bind mount must also match. If `MODEL` names a Hub repo, mount its cache, set `HF_HUB_OFFLINE=1` and `VERIFY=0`, and keep the selected snapshot under `refs/main`. Leave `DFLASH_TOKENS` at the default for long agent contexts.

## SGLang on Hopper or Blackwell

Install Docker with the NVIDIA Container Toolkit. Create `~/sglang-qwen38` (or set `SGLANG_QWEN_PROJECT_DIR`). On Windows, prepare the project and weights inside the WSL2 distro. PortOS discovers that location when starting. Use `SGLANG_QWEN_WEIGHTS_DIR` for a checkpoint outside the default cache and configure the matching mount.

Save the H200 example below as `docker-compose.yml`. For a Blackwell card, generate the matching recipe from the PortOS checkout. Use `rtx5090` for an RTX 5090 or `rtx6000` for an RTX PRO 6000, then save the output in the project's Compose file.

```sh
node --input-type=module -e "import { buildSglangQwenRecipe, sglangComposeYaml } from './server/lib/sglangQwenRecipe.js'; process.stdout.write(sglangComposeYaml(buildSglangQwenRecipe({ hw: 'rtx5090' })))"
```

The H200 configuration uses FP8 weights. For Blackwell, download the NVFP4 model named by the generated recipe. Keep the SGLang tool and reasoning parsers.

```yaml
services:
  sglang-qwen38:
    image: lmsysorg/sglang:qwen38-27b
    container_name: sglang-qwen38
    restart: "no"
    ipc: host
    shm_size: "32g"
    ports:
      - "127.0.0.1:18021:18021"
    volumes:
      - ${HF_HOME:-./hf-cache}:/root/.cache/huggingface
    environment:
      - HF_TOKEN=${HF_TOKEN:-}
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: ["gpu"]
    entrypoint: ["sglang"]
    command:
      - "serve"
      - "--trust-remote-code"
      - "--model-path"
      - "Qwen/Qwen3.8-27B-FP8"
      - "--kv-cache-dtype"
      - "fp8_e4m3"
      - "--mem-fraction-static"
      - "0.85"
      - "--attention-backend"
      - "flashinfer"
      - "--chunked-prefill-size"
      - "32768"
      - "--max-prefill-tokens"
      - "32768"
      - "--tool-call-parser"
      - "qwen3_coder"
      - "--reasoning-parser"
      - "qwen3"
      - "--mamba-radix-cache-strategy"
      - "extra_buffer"
      - "--mamba-ssm-dtype"
      - "float32"
      - "--mamba-full-memory-ratio"
      - "1.201"
      - "--host"
      - "127.0.0.1"
      - "--port"
      - "18021"
```

Pull and download once in the project directory. If a key is needed, set `HF_TOKEN` in the project `.env` and in the download shell.

```bash
docker pull lmsysorg/sglang:qwen38-27b
HF_HOME=./hf-cache hf download Qwen/Qwen3.8-27B-FP8
docker compose up -d
```

The readiness checklist can also start an already prepared project. It checks hardware, Compose and cached weights before starting. Verify `http://127.0.0.1:18021/v1/models`, enable the OpenCode CLI or TUI preset and set thinking off in **Generation Defaults** for coding. Supply a key on the card if the server was configured with `--api-key`. For Claude Code, use the shipped SGLang preset. Keep `ANTHROPIC_BASE_URL` at the server root without `/v1`, and keep `ANTHROPIC_AUTH_TOKEN` non-empty. For a key-protected server, set that environment variable to the key as well as filling the provider card key used by the readiness check. Keep `CLAUDE_CODE_ATTRIBUTION_HEADER=0` for prefix-cache reuse.

## Speculative decoding in llama-server

1. In **Models → Runtimes → llama-server**, select a speculative preset and download its matching base and draft GGUFs. DSpark and DFlash 2 require a build advertising the selected spec type in `llama-server --help` and a compatible draft. Use a supported regular preset if the runtime lacks the required flags.
2. If you start the server manually, match `--spec-type`, `--model` and `--model-draft` to the selected pair. Use a matching `--mmproj` only for vision. The [llama.cpp speculative decoding reference](https://github.com/ggml-org/llama.cpp/blob/master/docs/speculative.md) covers the flags and drafter-free n-gram modes.
3. Enable the corresponding **OpenCode llama TUI** preset or a direct API provider. The checklist compares the model ID returned by `/v1/models`. Refresh Models after changing the served alias. Choose a context size that leaves enough memory for the drafter and KV cache.
