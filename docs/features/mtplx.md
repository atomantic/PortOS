# MTPLX — native-MTP Qwen on Apple Silicon

[MTPLX](https://github.com/youssofal/MTPLX) is a separately managed local
runtime for Apple Silicon that can run Qwen checkpoints with native
multi-token-prediction (MTP) decoding. It exposes OpenAI-compatible and
Anthropic-compatible local APIs; PortOS uses its OpenAI-compatible endpoint.

This is an additional runtime, not an Ollama replacement. PortOS offers
**Qwen3.8 27B** through Ollama's GGUF path on supported hosts and, on Apple
Silicon, recommends native MLX builds for both Ollama and LM Studio. MTPLX's
native-MTP checkpoints remain a distinct runtime: PortOS maps only the known
packaged Ollama and LM Studio MLX equivalents and does not treat an MTP sidecar
as a standalone chat model.

## What PortOS adds

After this version is installed, the **AI Providers** page includes three
disabled presets:

- **MTPLX (local MTP)** — an `api` provider for ordinary text-generation tasks.
- **OpenCode MTPLX (local MTP)** — a headless `cli` coding-agent provider.
- **OpenCode MTPLX TUI (local MTP)** — an attachable `tui` coding-agent provider.

The two OpenCode variants give CoS agents a file-writing tool harness. The API
variant returns text only, like the existing Ollama API provider, so it is not a
valid CoS coding-agent runner.

## Setup

1. Install and validate MTPLX independently using its upstream documentation.
   PortOS does not download model weights, launch its installer, enable optional
   thermal-management helpers, or start a daemon.
2. Start an MTPLX server for your verified Qwen MTP model on its documented
   loopback OpenAI-compatible endpoint, `http://127.0.0.1:8000/v1`.
3. On **AI Providers**, enable the matching preset. Use **Refresh Models** only
   after the server is running; PortOS then reads `/v1/models` on demand.
4. Choose **MTPLX (local MTP)** for supported non-coding tasks, or choose an
   **OpenCode MTPLX** CLI/TUI preset for a CoS coding task. The seed model alias
   is `mtplx`; refresh it if your running server publishes a different alias.

All presets are disabled by default. Merely updating PortOS does not make a
network request, invoke a model, tune speculative decoding, or alter the active
provider. MTPLX tuning remains an explicit operator action outside PortOS.

## Operational notes

- MTPLX can offer a faster path for an MTP-capable Qwen checkpoint; benchmark it
  on the target machine rather than assuming it improves the existing Ollama
  model.
- Keep the MTPLX endpoint local. The provided presets use a loopback address;
  if you intentionally change it, treat the server and model weights as a
  separate trusted runtime.
- The source audit that motivated this integration found privileged optional
  thermal-helper and installer paths upstream. The PortOS integration is
  protocol-only so those paths never run as part of PortOS setup or boot.
