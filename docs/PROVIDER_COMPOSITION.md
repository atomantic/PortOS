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

`GET /api/providers` stays presets-only, so existing consumers are unaffected; each record now also carries its preset structure (see **Presets**). The management surface over these axes is the AI Providers page — [AI_PROVIDERS.md](./AI_PROVIDERS.md) (#7567). `GET /api/providers/service-definitions` lists every definition an instance can be created from, with its plans, transports (and default base URLs) and where a key is obtained.

## Presets

A **preset** is a stored `data/providers.json` record — what the flat provider list has always been — read as a named (harness, method, service) tuple plus the user's own defaults. Since #7565 a record can carry three additive structural keys, and a record carrying all three is a **derived preset**:

| Key | Meaning |
|---|---|
| `harnessId` | The `PROVIDER_HARNESSES` row that drives it (`direct` for an `api` record) |
| `method` | `cli` / `tui` / `api`; always equal to `type` |
| `serviceId` | The `ai_connections` slug of the service instance it is materialized from |
| `catalogNarrowing` | Optional: the subset of the service catalog this preset offers (`null` = the whole catalog, in the narrowing's own order) |
| `credentialBootstrapId` | Optional (`cli` / `tui` only): the `settings.credentialBootstraps` slug it spawns through; materialization writes the inline `credentialBootstrap` object from it |

On every save of a derived preset (`POST /api/providers`, `PUT /api/providers/:id`) the server re-derives its **connection-owned** values from the service through `materializeRoute` — the program, `endpoint`, `apiKey`, the transport and credential environment variables, the backend markers (`ollamaBacked`, `gatewayBacked`, …), the inline bootstrap, and `models` (the instance's plan-filtered catalog ∩ narrowing) — and writes them into the record, so **`data/providers.json` stays the fully materialized execution contract** and an older release runs the preset with no graph at all. Everything else stays the preset's own: name, `args` / `headlessArgs` / `tuiPromptDelayMs` / `timeout`, `defaultModel` and the tier pins, `effort`, fallback, generation params, consent flags, unknown custom fields, and any environment variable the service does not write (`ANTHROPIC_SMALL_FAST_MODEL` beside a service-written `ANTHROPIC_BASE_URL`). A record's own OpenCode inline config is kept when it already declares the namespaces and base URLs the service would write, because it also holds permissions and agent settings the user typed. A direct edit that would MOVE a connection-owned value is refused with `400 PRESET_FIELD_DERIVED` naming the fields and the service to edit instead; a `models` edit is read as a narrowing.

A record without the three keys is a **legacy preset**: fully hand-editable and executed exactly as before. `GET /api/providers` decorates every record with `presetKind` (`derived` / `legacy`) and `presetDerivable` (a legacy record on a known harness, spawned by the recipe's own binary, with a clean connection profile).

| Surface | Purpose |
|---|---|
| `POST /api/providers/presets` `{ compositeId, id?, name?, model?, effort? }` | "Save as preset": the record a composite resolves to, stored enabled with the selection's model and effort as defaults and the `+<bootstrap>` suffix as `credentialBootstrapId`. The id is minted from the parts (`pi-tui-nvidia-nim-free`, `claude-cli-anthropic-corp-auth`), suffixed when taken. An ineligible composite is a 400 with the resolver's code. |
| `POST /api/providers/:id/derive` | "Convert to derived preset": stamp one legacy record with the harness, method and instance it already runs on — only when re-deriving it reproduces every connection-owned value it carries. `409 PRESET_NOT_DERIVABLE` with the reason otherwise; nothing about how it runs changes either way. |

**Backfill.** The boot reconcile pass (`reconcilePass` in `server/services/providerGraph.js`) stamps every legacy record the graph already routes onto a named service instance, under the same fixpoint rule (`planPresetBackfill`, `server/lib/providerPresets.js`): additive keys only, idempotent, row-derived and never a seed — so it rides every pass rather than a numbered migration, exactly as the service-column backfill does. A record whose re-derivation would change how it runs stays legacy, with the reason logged in aggregate: a path-configured binary, a wrapper that stores no gateway key, an inline bootstrap matching no configured app, a legacy per-gateway marker, a service that has not been given the credential its harness requires. Of the 55 shipped samples, 37 are stamped on first boot.

**One service per backend.** The graph import gives every harness its own connection, so an install running `nvidia-nim` (direct API) beside `opencode-nvidia-nim` (an OpenCode wrapper on the same endpoint) arrives with two NVIDIA NIM services, one named after the harness. The same reconcile pass then folds such rows into one instance (`planServiceInstanceMerges`, `server/lib/providerServiceMerge.js`): the rows must be the same definition — a generic `openai-compatible` row on a named definition's default endpoint counts as that definition — and share an endpoint, credential mode, plan and non-conflicting credentials, and every preset on them must re-derive onto the survivor with its model list unchanged. The survivor keeps its slug and takes the service's name; derived presets are re-pointed to it before the folded row is deleted. Two plans of one definition stay two instances, as does a row no harness is bound to yet. A saved composite id naming a folded slug resolves as an unresolved pin, never a substitute.

**Graph.** A derived preset is imported ONTO the connection it declares (`presetDeclaresConnection`), never as a fragment of its own, and stays there across passes even where profile containment would move it — a direct-API preset on a gateway instance reads back as kind `api`, not `gateway:<id>`. So a service edit re-projects it through the same pending/projected snapshot protocol as any route, and additionally re-runs the full materialization (`rematerializeDerivedPresets`) so the inline config, catalog and bootstrap follow the row too; a catalog refresh re-derives `models`; a link or unlink re-addresses `serviceId` to the instance the binding landed on.

## Peers

`metadata.provider` crosses to a peer verbatim, as before. A peer with no service under that slug resolves the pin as unresolved through the existing reason path; no sync schema version changes.
