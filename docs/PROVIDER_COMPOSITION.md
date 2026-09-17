# Provider composition — composite ids

PortOS runs AI work on a **provider**. Until #7564 a provider was always a stored record in `data/providers.json` (a *preset*), one per (program × backend) combination. A **composite id** names a combination directly, from the parts that already exist, and every run path resolves it through the same lookup it resolves a preset today — so a `{ providerId, model, effort }` selection keeps its shape wherever it is stored.

```
<harness>.<method>@<service-slug>[+<bootstrap-slug>]

pi.tui@nvidia-nim-free            Pi, driven in a PTY, against the "nvidia-nim-free" service instance
direct.api@ollama                 PortOS's own HTTP client against the local Ollama instance
opencode.cli@openrouter           OpenCode headless, front-ending OpenRouter
claude.cli@anthropic+corp-auth    Claude Code headless, credentialed at spawn by the "corp-auth" bootstrap app
```

| Part | Where it comes from | Grammar |
|---|---|---|
| `harness` | `PROVIDER_HARNESSES` in `server/lib/providerHarnesses.js` (`claude`, `opencode`, `codex`, `antigravity`, `cursor`, `grok`, `kimi`, `pi`, `direct`, …) | `[a-z0-9-]+` |
| `method` | one of the harness's `modes` | `cli` / `tui` / `api` |
| `service-slug` | an `ai_connections` row's `slug` (Settings › AI Providers › Services, `GET /api/providers/services`) | `[a-z0-9][a-z0-9-]*` |
| `bootstrap-slug` | a key of `settings.credentialBootstraps` | `[a-z0-9][a-z0-9-]*`, only with `cli` / `tui` |

A preset id is `^[a-z0-9][a-z0-9-]*$`; `.` and `@` are outside that alphabet, so the two grammars never collide and a composite can never shadow a stored record. The grammar lives in `server/lib/providerRef.js` (`parseProviderRef`, `formatCompositeId`) and is mirrored into the vendored toolkit at `server/lib/aiToolkit/internal/providerRef.js`.

## Resolution

`getProviderById(id)` on the toolkit's provider service answers a stored record when one exists. For a composite-shaped id it does not hold, it calls the host-injected `resolveCompositeProvider` (`server/services/compositeProviders.js`), which:

1. parses the id and looks up the harness row;
2. checks **harness enablement** — the user's explicit `settings.harnesses[id].enabled`, else whether the binary was detected on PATH by the runtime probe's cache (un-probed reads as enabled; `direct` is always enabled);
3. loads the **service instance** by slug (must be enabled and carry a definition), resolves its endpoints and the key it runs under;
4. checks the harness reaches that service (`isCompatible`) in that method;
5. resolves the bootstrap app for a `+suffix` (unknown slug → refused; a `bootstrap`-credentialed service with no suffix → refused);
6. materializes the record through `materializeRoute` — the same writer `POST /api/providers/bindings` uses — with the instance's plan-filtered catalog as `models` and its first entry as `defaultModel`.

The record is cached per (composite, service revision, settings revision) and **never persisted**: it does not appear in `providers.json`, in `GET /api/providers`, or in the management graph. A `field` credential is attached non-enumerably (the `attachGatewaySiblingKey` discipline) so a spread or JSON round-trip drops it; an env-borne key sits under a `secretEnvVars` name every client-facing sanitizer redacts.

An ineligible composite resolves to `null`, and the caller's existing "provider not found" path names it — a saved selection is never silently substituted. `GET /api/providers/composites/:id` returns the verdict with a `code` / `reason` (`harness-disabled`, `service-disabled`, `service-unknown`, `incompatible`, `bootstrap-unknown`, `SERVICE_CREDENTIAL_REQUIRED`, …) for a picker to show beside it. Re-enabling the harness or the service restores it with nothing to migrate.

## Where a composite is accepted

`providerRefSchema` (`server/lib/zodCompat.js`) accepts either grammar and is the schema of every **selection** field: CoS task metadata, task templates, orchestration roles, feature provider pins (`autofixer`, `calendarSync`, …), scheduled prompts, `POST /api/runs`, the pipeline `llm` field.

Three surfaces stay **preset-only** (`presetProviderIdSchema`) and answer a composite with a 400 naming the rule, because they key on the stored map: `PUT /api/providers/active`, a record's `fallbackProvider`, and an app's `taskTypeOverrides[].providerId`.

Fallback selection admits a composite only where a stored candidate would be admitted: the task-level fallback id is materialized into the candidate map, and the toolkit's `getFallbackProvider` applies the caller's `allowedModes` to it like any other row.

## Settings and endpoints

| Surface | Purpose |
|---|---|
| `settings.harnesses` | `{ [harnessId]: { enabled } }` — the user's explicit word per harness; validated on `PUT /api/settings` |
| `settings.credentialBootstraps` | `{ [slug]: { label, command, args?, argsSeparator?, setupCommand?, harnessNames? } }` — the wrapper CLIs a `+suffix` names; saving never spawns |
| `GET /api/providers/catalog` | Every axis a picker composes over: harnesses (with `enabled` / `detected` / `version`), services, bootstraps, `compatibility` (harness → service slugs), `effortLevels` per harness, `effortLevelsByModel`, and the sanitized presets — derived from cache and settings only |
| `GET/PUT /api/providers/harnesses[/:id]` | Read / flip enablement |
| `GET/PUT /api/providers/bootstraps` | Read / replace the bootstrap table |
| `GET /api/providers/composites/:id` | One composite's verdict and sanitized record |
| `GET /api/providers/readiness?providerId=<composite>` | Readiness for one composition |

`GET /api/providers` stays presets-only, so existing consumers are unaffected until the UI slices of the epic (#7561) land.

## Peers

`metadata.provider` crosses to a peer verbatim, as before. A peer with no service under that slug resolves the pin as unresolved through the existing reason path; no sync schema version changes.
