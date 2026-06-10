# AI Toolkit (`server/lib/aiToolkit/`)

The AI provider/runner/prompt toolkit is vendored in-tree here. (It was previously the `portos-ai-toolkit` npm package.) Keep the directory self-contained — no imports out to other PortOS modules — so future upstream syncs don't fight local edits.

**Key points:**
- `index.js` exports `createAIToolkit`, `createProviderStatusService`, and the four Router factories (providers / runs / prompts / providerStatus)
- Provider configuration (models, tiers, fallbacks) lives in `providers.js`
- `loadProviders()` auto-migrates legacy codex configs to the `codex-configured-default` sentinel; `server/index.js` warms it at startup so the rewrite happens before any request
- PortOS extends toolkit routes in `server/routes/providers.js` for vision testing and provider status (status routes live in PortOS, not the toolkit, because they call PortOS-side socket helpers)
- When adding new provider fields (e.g., `fallbackProvider`, `lightModel`), update `createProvider()` in `providers.js`
- `updateProvider()` uses spread so existing providers preserve custom fields, but `createProvider()` has an explicit field list

**Override consistency.** PortOS replaces `aiToolkit.services.runner.executeCliRun` in `server/index.js` with a stdin-based variant that knows the per-CLI argv conventions (Codex `exec -`, Antigravity `agy --print`, Claude Code `-p -`). Two patches follow from this:

- The PortOS variant tracks live child processes in `_portosActiveRuns`, not the toolkit's internal `activeRuns`. **Every sibling method that reads or writes the runner's process map must be patched together** — `stopRun` and `isRunActive` are already overridden alongside `executeCliRun`; if you add a new method (e.g. `pauseRun`, `getActiveRunCount`), add a matching override or the runs router will report inconsistent state.
- Time-based state transitions need read-side mirrors. `providerStatus.init()` clears expired `estimatedRecovery` entries; every reader (`getStatus`, `getAllStatuses`, `isAvailable`) must re-apply the same recovery check on read — otherwise providers stay "unavailable" past their recovery deadline until the next process restart.

The worked example for "barrel + documented exports" (see root `CLAUDE.md` → Module Organization) is this directory's `index.js`.
