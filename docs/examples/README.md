# Example config files

## `claude-code-ollama-settings.json`

A copy-ready `~/.claude/settings.json` that points the **stock `claude` CLI** at a
local Ollama daemon, so every Claude Code session (interactive *and* the agent
harness PortOS spawns for CoS tasks) generates tokens from a local model while
keeping the full Read/Write/Edit/Bash tool harness.

| Field | Why |
| --- | --- |
| `ANTHROPIC_BASE_URL` | Your Ollama host. **No `/v1` suffix** — Claude Code appends the Anthropic path itself. Use `http://<remote-host>:11434` for a remote box. Requires **Ollama ≥ 0.14**, which natively serves the Anthropic Messages API; for LM Studio / vLLM / older Ollama, put **LiteLLM** in front to translate (avoid LiteLLM `1.82.7`/`1.82.8` — shipped malware). |
| `ANTHROPIC_AUTH_TOKEN` | Any non-empty value (`ollama`) — local backends don't check it. |
| `ANTHROPIC_DEFAULT_*_MODEL` | Map each Claude tier to a local model id. |
| `ANTHROPIC_SMALL_FAST_MODEL` | **Must** map to a local model — Claude Code uses a small/fast model for background work and will otherwise try to reach an unreachable Haiku. |

### Two ways to use it

- **Global (`~/.claude/settings.json`)** — copy this file's `env` block in. The stock
  `claude-code` provider in PortOS then works as-is, with no custom provider. Downside:
  it routes *all* local `claude` usage (interactive too) through Ollama.
- **Scoped (recommended)** — use the **Claude Ollama** provider in PortOS (shipped on
  the AI Providers page; CLI and TUI variants). It carries the same env *per provider*,
  so you keep cloud Claude and a local-model option side by side and pick per task. See
  [docs/features/claude-ollama.md](../features/claude-ollama.md).

> ⚠️ **Tool-use caveat.** The agent harness depends on reliable tool-calling. Small
> generic models (Mistral 7B, base Llama, etc.) "run" but fail ~35–85% of tool calls
> and silently stop writing files. Use a tool-capable model — **Qwen 2.5/3, Llama
> 3.1+, Mistral Small 24B, GLM-4, Granite 3, gpt-oss**. Q4_K_M is the practical quant
> floor. The Claude Ollama provider's model refresh filters its list to tool-capable
> models for you.
