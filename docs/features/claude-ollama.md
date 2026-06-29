# Claude Ollama — run CoS agent tasks on a local model

**Claude Ollama** lets a user whose only LLM is **Ollama / LM Studio** run
file-writing **CoS agent tasks** — create/edit files, run tests, ship a PR — by
running the **Claude Code harness on top of a local model**. It ships in two
variants:

- **Claude Ollama (local model)** — a `cli` provider (`claude --print`), headless.
- **Claude Ollama TUI (local model)** — a `tui` provider
  (`claude --dangerously-skip-permissions`), the interactive harness CoS agents
  drive in TUI mode.

## Why a special provider?

PortOS has two provider classes:

- **`cli` / `tui`** (claude, codex, agy) — spawned as a child process in the agent
  worktree. The CLI owns the Read/Write/Edit/Bash **tool harness**, so it can write
  files. CoS agent tasks run only on these.
- **`api`** (Ollama, LM Studio, nvidia-kimi) — an HTTP request that returns **plain
  text**. No harness, no file writes. Great for planning/vision/ask, but a task that
  needs to edit files produces a transcript and writes nothing.

Claude Code's harness is **independent of which model serves tokens**. Point the
`claude` CLI at a local model via `ANTHROPIC_BASE_URL` and you keep the *entire*
file-editing harness while Ollama does the generation. **Claude Ollama** is exactly
that: a `claude` CLI/TUI provider whose `envVars` route Claude Code to your Ollama
daemon, with its model list pulled live from Ollama.

## Setup

1. **Install the `claude` CLI on the PortOS host** — `npm i -g @anthropic-ai/claude-code`
   (the harness runs locally; only token generation is remote).
2. **Run Ollama ≥ 0.14** (locally or on a remote box) — it natively serves the
   Anthropic Messages API, so no proxy is needed. (LM Studio / vLLM / older Ollama:
   put **LiteLLM** in front to translate Anthropic ↔ OpenAI.)
3. **Pick a variant** — after `./update.sh` (or a server restart), both
   **Claude Ollama (local model)** (CLI) and **Claude Ollama TUI (local model)**
   appear on the **AI Providers** page, disabled by default. Enable the one you
   want. Edit `ANTHROPIC_BASE_URL` if your Ollama isn't on `localhost:11434`
   (e.g. `http://<remote-host>:11434`).
4. **Refresh models** — hit the provider's **Refresh Models** button. PortOS pulls the
   installed Ollama models and **keeps only the tool-use-capable ones** (the harness
   depends on reliable tool-calling), then pick a default. This works for both the CLI
   and TUI variant.
5. **Run a task** — set Claude Ollama as the active provider (or pin it per task) and
   create a CoS agent task. It now writes files and ships a PR backed by your local model.

Both providers are `enabled: false` by default — adopting them doesn't change your
active provider until you choose one.

## Coding-task restrictions

- The **task form only offers coding providers** (CLI/TUI). Raw Ollama / LM Studio /
  kimi (`api`) providers are not file-writing runners and are excluded. If your only
  enabled providers are `api`-type, the form shows an advisory pointing you here.
- A server-side guard in `agentProviderResolution` rejects an `api` provider that
  reaches the spawn path (via a task pin or the fallback chain) with a clear error,
  rather than spawning a child process that can't write files.
- Claude Ollama's model list is filtered to **tool-use-capable** models (Qwen 2.5/3,
  Llama 3.1+, Mistral/Mixtral, Cohere Command, GLM-4, Granite 3, gpt-oss, Hermes, …).

## ⚠️ Tool-use caveat

Small generic models (Mistral 7B, base Llama, Phi) **"run" but fail ~35–85% of tool
calls** and silently stop editing files mid-task. Use a tool-capable model and treat
**Q4_K_M** as the practical quant floor. The model-list filter steers you toward
reliable families, but a model that *reports* the `tools` capability can still be weak
in practice — prefer ≥7B instruction-tuned models from the families above.

See [docs/examples/claude-code-ollama-settings.json](../examples/claude-code-ollama-settings.json)
for the equivalent global `~/.claude/settings.json` approach.
