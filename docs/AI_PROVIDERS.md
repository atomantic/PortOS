# AI Providers — harnesses, services, presets

**Models → Providers** (`/ai`) is where PortOS decides how an AI run is composed. A run is five independent choices, and the page is three views over them (epic #7561, page reshape #7567):

```
Harness  ×  Method  ×  Service  ×  Model  ×  Effort
```

| Axis | What it is | Where it lives |
|---|---|---|
| **Harness** | The program that drives a model: Claude Code, OpenCode, Codex, Antigravity, Cursor, Grok, Kimi, Pi, … and `direct` — PortOS's own HTTP runner. | `PROVIDER_HARNESSES` (`server/lib/provider/providerHarnesses.js`); per-install enablement in `settings.harnesses` |
| **Method** | How the harness is driven: `cli` (headless), `tui` (a PTY the agent runner attaches to), or `api` (the `direct` harness's only method). | Declared per harness (`modes`) |
| **Service** | The backend a harness is pointed at — a hosted API you hold a key for, a local runtime daemon, a subscription the harness signs into, or a fleet peer's gateway. An **instance** is a definition plus the **plan** you declared (`free` / `paid` / `subscription` / `local`), a credential, and the model catalog it last listed. | Definitions in `server/lib/serviceDefinitions.js`; instances are `ai_connections` rows (`docs/STORAGE.md`) |
| **Model** | One entry of the service's catalog, narrowed by its plan. | The instance's `catalog` |
| **Effort** | The reasoning budget, on the harness's ladder (and per model where a model narrows it). | `effortLevels` / `effortLevelsByModel` in the catalog |

Any **compatible** combination of enabled parts is runnable without a stored record: `pi.tui@nvidia-nim-free`, `direct.api@ollama`, `claude.cli@anthropic+corp-auth`. The grammar, the resolver, and which surfaces accept a composite id are in [Provider composition](#provider-composition). A **preset** is a *named* combination — the stored `data/providers.json` record every `{ providerId, model, effort }` picker has always selected — and every picker stays one dropdown of presets with a "Custom…" step that opens the compose flow.

## The three views

### Presets (`/ai/presets`)

The stored records, **grouped by harness** and ordered within a group by readiness (what can run first, what you switched on but cannot run yet second, what is switched off last). Readiness is still on every card as its color and badge; it no longer decides which section a card lands in. A record this machine's hardware cannot run is parked in a collapsed *Unavailable on this machine* section — kept, because the file is shared with your other machines.

- **Compatibility matrix** — harness rows × service columns, each cell the server's verdict on that pair (`GET /api/providers/catalog`, nothing recomputed in the browser): **offered** (click for a prefilled "New preset"), **blocked** with its reason (a side switched off, a missing key or endpoint), or **unreachable**.
- **Add Preset** — the shared compose flow (harness → method → service → optional model, effort, and credential bootstrap), saved through `POST /api/providers/presets`. Choosing it does not contact a provider; the catalog already knows which enabled pairs are compatible. On success the preset editor opens so the preset-owned fields can be set without retyping the service connection.
- **Add standalone preset** (overflow menu, and a second control when the list is empty) — the hand-written legacy record, for a backend no definition describes. `/ai/presets/new` is still that form.
- The preset editor (`/ai/presets/:presetId`; `/ai/edit/:providerId` is a kept alias) shows a **derived** preset's connection-owned fields — type, command, endpoint, key, inline bootstrap — as *Derived from service …* with a link to the service, because the server re-materializes them from that service on every save and refuses an edit that would move one. Name, arguments, timeouts, model pins, effort and generation settings stay the preset's own. A **legacy** preset is fully hand-editable, as before, and offers *Convert to derived preset* when re-deriving it would change nothing about how it runs.
- A harness with both CLI and TUI modes has one shared provider configuration: catalog, access policy, model and tier pins, effort, fallback, hardware requirements, and generation settings. The mode records remain addressable by their existing ids so saved tasks and peers keep working. When legacy records conflict on a shared setting, the CLI value takes precedence; if CLI is unset, a configured TUI value is retained. Their model catalogs and known context windows are merged. Arguments, headless-only arguments, timeouts, TUI timing, and CLI transport consent remain mode-specific because they control how each mode launches.
- **Tiers** (Light / Medium / Heavy / Ultra, [MODEL_TIERS.md](./MODEL_TIERS.md)) are pins on a preset, so a `model: "heavy"` selection resolves on whichever preset the task names.

### Harnesses (`/ai/harnesses`)

One card per registry harness: the **enable switch** (the user's word; a harness with no word follows whether its binary is detected on PATH; `direct` is always on), the detected and latest versions, the methods it runs, how many switched-on services it can reach, the install/update/removal lifecycle for its binary, model catalog refresh, and — for a program that signs into its own vendor — the subscription service only it can reach, with that service's readiness and a link to it. Sign-in itself (the ChatGPT device flow, for instance) stays on the preset card. A toggle here is one write plus a catalog invalidation, so an open picker's compose flow reflects it without a reload.

**Credential bootstraps** sits under the cards, collapsed until one exists: the launch wrappers a composite's `+<slug>` suffix names (`<command> <args…> <harness-name> [<separator>] <harness args>`), with the per-harness name map a wrapper may use (`claude` → `claude-code`). Saving never spawns anything; the wrapper runs only when a composite naming it executes.

### Services (`/ai/services`)

One card per instance, grouped by what the **definition** offers rather than by the plan this instance declared:

| Category | Rule |
|---|---|
| **Local** | `definition.family` is `local` (a daemon), whatever plan the instance selected. |
| **Subscriptions** | `definition.family` is `subscription` (the harness signs in). A definition that offers neither free nor paid, but lists `subscription`, lands here too. An account-backed service is not filed under free. |
| **Free + paid** | The definition lists both `free` and `paid`. An OpenRouter, NVIDIA NIM, or OpenCode Zen instance stays here whether this row's plan is free or paid. |
| **Free only** | Not local or subscription, and the definition offers `free` but not `paid` (including a fleet peer, whose plan is free). |
| **Paid only** | The definition offers `paid` but not `free`. |
| **Other/legacy** | No definition, or a shape the rules above cannot name. The row stays visible. |

The instance plan pill (`free`, `paid`, `subscription`, `local`) stays on the card next to that category. Filter chips show a count for each category (and All) after the current search. Search matches the service label, slug, and definition label/id/family. Sort is by name (A→Z), readiness (what can run first), or preset count (busiest first); equal rows break ties by name, then slug. Categories with nothing to show are omitted. The card grid is `auto-fit` with a `min(100%, 18rem)` track, so a narrow viewport stays one column and does not scroll sideways.

**Create preset** on a card opens the same compose flow as Add Preset, with that service selected once a compatible harness and method are chosen. The button stays visible but disabled — and says why — when the service is switched off, not ready, or has no definition. Opening the composer does not refresh a catalog or contact a provider. A ready derived preset still owns only its name, arguments, timeouts, model pins, effort, and generation settings; the service keeps the command, endpoint, credential, backend environment, and catalog.

Each card also shows readiness (*Ready*, *Needs a credential*, *Needs an endpoint*, *Switched off*), where its credential comes from (stored here, the environment, the install `.env`, the harness's own sign-in, or a bootstrap wrapper) with a *Get a key* link for a keyed vendor still waiting on one, its endpoints, and its catalog state. **Refresh catalog** is the one action on this page that contacts a provider, and it is never run on mount, on toggle, on display, or on opening compose (root `AGENTS.md`, AI Provider Usage Policy) — it lists the instance's models through its definition's strategy (probe the endpoint, ask the daemon, ask the program that signs in, or the declared list) and filters them to the plan, then re-derives every preset on the instance.

**Add Service** walks definition → plan → credential / endpoint. A subscription needs neither (the harness signs in); a hosted API takes a key you store, a conventional environment variable, or a bootstrap wrapper; a local runtime needs the endpoint this install reaches it at. A service still named by a preset cannot be deleted.

#### Credential pools

A hosted-API service that runs on a key (stored or env) can hold more than one (#17384). The card's **Credential pool** section lists the primary key, keys added to the pool, and numbered env siblings of the definition's variable (`OPENROUTER_API_KEY_2`, `_3`, … up to the first gap), each with a masked fingerprint and its status. Before a request fails over to another provider, it rotates within the pool:

| Failure | What cools | Default window |
|---|---|---|
| 429 on a per-model provider (Anthropic, OpenRouter) | That model on that key, after one same-key retry. Other models keep using the key. | `Retry-After` / reset hint, else 5m |
| 429 elsewhere | The whole key | `Retry-After` / reset hint, else 5m |
| 402, or a quota/billing body | The whole key | Reset hint, else 1h |
| 401 | The whole key; a key rejected twice in a row stays out until **Reset cooldown** | 15m |

Once every key is cooling, the last failure reaches the existing provider bench and fallback chain unchanged. Strategy is **Fill first** (default: the top healthy key, so a provider prompt cache stays warm, and the next request returns to it once its cooldown ends), **Round robin**, or **Least used**. Rotation runs only for a preset or composite that names the service (`serviceId`) and still runs under its primary key, with at least two keys usable for that endpoint.

Pool keys are stored in `credentials.credentialPool` on the `ai_connections` row. An env entry stores only the variable's name, which must be the definition's own variable or a numbered sibling of it, and is read from the process at request time. A stored pool key is bound to the endpoint origin it was added under: once the service's endpoint moves to another origin, the key is withheld until you **Re-bind** it. Env siblings are used only on the definition's shipped host. Cooldowns are kept in memory and clear on restart. The status read never rotates or benches a key, and no response carries a key value. API: `GET|PATCH /api/providers/services/:slug/credential-pool`, `POST …/keys`, `PATCH|DELETE …/keys/:credentialId`, `POST …/reset`.

This view is what the Backend Connections drawer (#6369) used to be — a connection *is* a service instance, addressed by the same UUID or slug, so `/ai/connections/:id` redirects here. What it no longer offers is binding link/unlink and per-route rows: a preset names its service outright (`serviceId`), and a preset's own settings live on its editor.

## Reaching the views

Every view and every open card is a URL — `/ai/harnesses/:harnessId`, `/ai/services/:serviceSlug`, `/ai/presets/:presetId` — reachable from ⌘K and voice ("AI presets", "AI harnesses", "AI services"; `server/lib/navManifest.js`). `/ai`, `/ai/new`, `/ai/connections[/:id]` and `/ai/harnesses/:id/connections[/:id]` redirect to their current homes.

## What federates

Nothing on this page. Harness enablement, bootstrap apps, service instances (endpoints, credentials, catalogs) and presets are machine-local: an `ai_connections` row carries this host's execution environment and credential material (ADR [privacy records machine-local](./decisions/2026-08-08-privacy-records-machine-local.md)), and `settings.harnesses` / `settings.credentialBootstraps` describe binaries on this host. A CoS task's `metadata.provider` crosses to a peer verbatim; a peer with no preset or service under that id reports it unresolved rather than substituting another.

## Provider composition

A composite selection has the form `<harness>.<method>@<service-slug>[+<bootstrap-slug>]`.
The method is `cli`, `tui` or `api`. A credential bootstrap is allowed for
CLI or TUI. Create combinations with **Custom…** and check them through the
provider catalog and readiness view. A disabled or missing part, an
incompatible route or a required credential that cannot be resolved makes
the saved selection unavailable. PortOS preserves the selection so repairing
the parts can restore it.

Use **Save as preset** when a surface needs a stored provider. The global
active provider, a preset's fallback field and managed-app task type
overrides accept preset IDs. Derived presets source connection fields from
the service and retain their own model defaults, settings and catalog
narrowing. Edit connection-owned fields on the service. Peer installs resolve
the same saved reference against their own services and credentials.

Execution speed is a separate selection where the runtime supports it.
**Inherit/default** follows the existing route, **Standard** overrides an
inherited fast tier, and **Fast** can use more subscription credits. An
unsupported saved option is shown with a reason and can be cleared. Check
the run's effective tier evidence before treating a request as confirmed.
