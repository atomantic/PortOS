# Unreleased

## Fixed

- **Layered Intelligence loop now supports every provider type.** The per-app AI-provider picker previously listed only `cli` providers, while the reasoning call went through the api-only `callProviderAISimple` — so a selected CLI provider failed at runtime with "requires an API-based provider," and API/TUI providers (Ollama, LM Studio, Claude/Codex/OpenCode TUI, etc.) never appeared at all. The reasoning call now routes through the unified `runPromptThroughProvider`, which dispatches on `provider.type`, and the picker lists all enabled `cli`/`api`/`tui` providers. CLI/TUI spawns run in the app's repo (`cwd`).
