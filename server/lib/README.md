# server/lib/ — shared server helpers

Pure / side-effect-free helpers, validators, parsers, prompt builders, and shared constants.

**Before adding a new helper here, search the catalog first** — if a similar module exists,
extend it. Service-layer orchestration (multi-step business logic) lives in `server/services/`, not here.

## Discovery rule

```
node scripts/lib-catalog.js <term> --dir server/lib
```

The catalog is derived on demand from module headers: each module opens with a comment whose
first paragraph is a one-sentence summary of at most 200 characters, followed by any longer
rationale. `server/lib/moduleSummaries.test.js` fails on a missing or over-length summary.
There is no barrel: import the module that declares what you need.

Modules are named camelCase with a domain prefix (`database*`, `fableLoom*`, `maintenance*`,
`musicVideo*`, …); search a prefix when a term finds a neighbour but not the exact helper.
The music-video helpers live in `musicVideo/` (#16561), its own catalog directory: the default
search covers it, and `--dir server/lib/musicVideo` narrows to it.

## Subdirectories and generated indexes

| Path | Purpose |
|---|---|
| `agent/` | Agent request schemas, execution profiles, run-event helpers, and completion contracts. Orchestration lives in `server/services/agent/`. |
| `catalog/` | Catalog ingredient types, validation, identity, and projections. Catalog services live in `server/services/catalog/`, `catalogDB/`, and `catalogIdentity/`. |
| `cos/` | Chief of Staff validation, persistence projections, federation policy, and tool contracts. Orchestration lives in `server/services/cos/`. |
| `musicVideo/` | Pure Music Video helpers and request schemas (`musicVideo*.js`): shot timing and prompts, cast and conditioning, effects, previz, validation. Orchestration stays in `server/services/musicVideo/`; Music Studio helpers (`musicDuration.js`, `musicDesignerValidation.js`) stay flat. `musicVideo/moduleSummaries.test.js` enforces its headers. |
| `persistent/` | Persistent Mind capabilities, validation, policy, and runtime data projections. Orchestration lives in `server/services/persistent/`. |
| `provider/` | Provider models, execution options, harness and gateway registries, and configuration projections. Orchestration lives in `server/services/provider/`. |
| `editorial/` | Extensible editorial-check registry (#1284) — `EDITORIAL_CHECKS` + fail-fast guards + lookup/state helpers. See `editorial/README.md`. The runner that executes checks lives at `server/services/pipeline/editorial/checkRunner.js`. |
| `aiToolkit/` | Vendored toolkit (providers + runner + prompts + status). See `aiToolkit/index.js`. `aiToolkit/endpointGuard.js` is the public SSRF / key-exfiltration guard for provider `endpoint` URLs (`evaluateSecretEndpoint` / `assertSecretEndpoint`) — import it from there, not from `internal/`. `aiToolkit/internal/ollamaBacked.js` also declares `clampToRuntimeContextWindow(provider, planned)` — what an Ollama `num_ctx` means to a context window: an upper bound over every planning rung (a typed override included), and the answer when nothing else declared one. The budgeter (`services/stageRunner.js`), the pre-dispatch gate (`aiToolkit/providerStatus.js#knownContextWindow`), the untrusted-content abuse guard (`services/untrustedContent.js`, via `knownContextWindow` — a deep import kept off `stageRunner.js`'s heavier closure since it sits on a request path) and the browser's provider-card meter all import it from there rather than restating it (#7466, #7473). |
| `promptStageCallSites.generated.json` | Generated `stageKey -> [server source paths]` index of every prompt stage `server/` names by literal key (plus interpolated-prefix stages like `pipeline-panel-${id}`). Regenerate with `node scripts/generate-prompt-stage-call-sites.js`; `scripts/generate-prompt-stage-call-sites.test.js` fails on drift. Never hand-edit. |
| `agentGuard/` | `agentGuardEnv(baseEnv?)` + `AGENT_GUARD_BIN` — env patch that prepends a guarded `pm2` shim (`bin/pm2`) to a spawned AI agent's PATH so a confused `--dangerously-skip-permissions` agent can't `pm2 kill` / `pm2 delete all` the shared daemon (which would down every app, incl. PortOS). Blocked-subcommand list mirrors `validatePm2Command` in `commandSecurity.js`. POSIX-only (no-op on Windows). |
| `db/` | Boot DDL for the PostgreSQL schema, split per domain (#2832). `db/schema/index.js` re-exports each module's statement array and composes the two ordered lists `ensureSchemaImpl()` runs on every boot (`buildUpgradeDdl()` then `buildCatalogDdl()`). **Statement order is load-bearing** — append inside the domain module and leave the composer order alone. See `db/schema/README.md` for the module catalog. |

## Notes

Reality starter updates: add a new frozen `realityStarterV<N>.js` text config and
point `universeStarters.js` at it. Do not change a version imported by an applied
migration. Universe Builder's **Restore latest starter** action uses that current
pointer; it replaces only starter idea, logline, premise, style notes and the
positive/negative influence lists. It preserves canon, media and local settings.
Automatic migration 440 fills only a blank, unlocked Reality; customized or
deleted records remain untouched. Future automatic upgrades need their own
migration with explicit recognition of the outgoing shipped defaults.

