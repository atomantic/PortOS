# AI Toolkit (`server/lib/aiToolkit/`)

The AI provider/runner/prompt toolkit is vendored in-tree here. (It was previously the `portos-ai-toolkit` npm package.) Keep the directory self-contained — no imports out to other PortOS modules — so future upstream syncs don't fight local edits.

**Key points:**
- `index.js` exports `createAIToolkit`, `createProviderStatusService`, and the four Router factories (providers / runs / prompts / providerStatus)
- Provider configuration (models, tiers, fallbacks) lives in `providers.js`
- `loadProviders()` auto-migrates legacy codex configs to the `codex-configured-default` sentinel; `server/index.js` warms it at startup so the rewrite happens before any request
- PortOS extends toolkit routes in `server/routes/providers.js` for vision testing and provider status (status routes live in PortOS, not the toolkit, because they call PortOS-side socket helpers)
- When adding new provider fields (e.g., `fallbackProvider`, `lightModel`), update `createProvider()` in `providers.js`
- `updateProvider()` uses spread so existing providers preserve custom fields, but `createProvider()` has an explicit field list

**Runner extension points.** The runner exposes a small declared override surface (in `runner.js`) so the host (PortOS) supplies its own runners without reaching into private internals:

- `setCliRunner(fn)` / `setTuiRunner(fn)` — register host CLI/TUI runners (pass `null` to revert). PortOS calls both in `server/index.js`: its CLI variant is stdin-based and knows the per-CLI argv conventions (Codex `exec -`, Antigravity `agy --print`, Claude Code `-p -`); the TUI runner has no toolkit built-in, and `setTuiRunner` attaches/detaches `executeTuiRun` so the runs router's `typeof runnerService.executeTuiRun === 'function'` gate stays honest.
- `registerExternalRun(runId, killable)` / `unregisterExternalRun(runId)` / `hasExternalRun(runId)` — track host-spawned child processes / ptys. The toolkit's own `stopRun`, `isRunActive`, and `deleteRun` consult this registry *first*, so **a host runner that spawns its own process MUST register it here** (PortOS does this in `services/runner.js`) — otherwise the runs router reports live runs as inactive and refuses to stop them, and deleting a live run leaks a zombie process. No sibling-method monkey-patching is needed: adding a new lifecycle method (e.g. `pauseRun`) just means having it consult `externalRuns` too.
- Time-based state transitions need read-side mirrors. `providerStatus.init()` clears expired `estimatedRecovery` entries; every reader (`getStatus`, `getAllStatuses`, `isAvailable`) must re-apply the same recovery check on read — otherwise providers stay "unavailable" past their recovery deadline until the next process restart.

The worked example for "barrel + documented exports" (see root `CLAUDE.md` → Module Organization) is this directory's `index.js`.
