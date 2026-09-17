# AI Providers — harnesses, services, presets

**Models → Providers** (`/ai`) is where PortOS decides how an AI run is composed. A run is five independent choices, and the page is three views over them (epic #7561, page reshape #7567):

```
Harness  ×  Method  ×  Service  ×  Model  ×  Effort
```

| Axis | What it is | Where it lives |
|---|---|---|
| **Harness** | The program that drives a model: Claude Code, OpenCode, Codex, Antigravity, Cursor, Grok, Kimi, Pi, … and `direct` — PortOS's own HTTP runner. | `PROVIDER_HARNESSES` (`server/lib/providerHarnesses.js`); per-install enablement in `settings.harnesses` |
| **Method** | How the harness is driven: `cli` (headless), `tui` (a PTY the agent runner attaches to), or `api` (the `direct` harness's only method). | Declared per harness (`modes`) |
| **Service** | The backend a harness is pointed at — a hosted API you hold a key for, a local runtime daemon, a subscription the harness signs into, or a fleet peer's gateway. An **instance** is a definition plus the **plan** you declared (`free` / `paid` / `subscription` / `local`), a credential, and the model catalog it last listed. | Definitions in `server/lib/serviceDefinitions.js`; instances are `ai_connections` rows (`docs/STORAGE.md`) |
| **Model** | One entry of the service's catalog, narrowed by its plan. | The instance's `catalog` |
| **Effort** | The reasoning budget, on the harness's ladder (and per model where a model narrows it). | `effortLevels` / `effortLevelsByModel` in the catalog |

Any **compatible** combination of enabled parts is runnable without a stored record: `pi.tui@nvidia-nim-free`, `direct.api@ollama`, `claude.cli@anthropic+corp-auth`. The grammar, the resolver, and which surfaces accept a composite id are in [PROVIDER_COMPOSITION.md](./PROVIDER_COMPOSITION.md). A **preset** is a *named* combination — the stored `data/providers.json` record every `{ providerId, model, effort }` picker has always selected — and every picker stays one dropdown of presets with a "Custom…" step that opens the compose flow.

## The three views

### Presets (`/ai/presets`)

The stored records, **grouped by harness** and ordered within a group by readiness (what can run first, what you switched on but cannot run yet second, what is switched off last). Readiness is still on every card as its color and badge; it no longer decides which section a card lands in. A record this machine's hardware cannot run is parked in a collapsed *Unavailable on this machine* section — kept, because the file is shared with your other machines.

- **Compatibility matrix** — harness rows × service columns, each cell the server's verdict on that pair (`GET /api/providers/catalog`, nothing recomputed in the browser): **offered** (click for a prefilled "New preset"), **blocked** with its reason (a side switched off, a missing key or endpoint), or **unreachable**.
- **Compose custom preset…** (overflow menu) — the same compose flow every picker offers, with "Save as preset" as its only exit.
- **Add Preset** — a hand-written legacy record, for a backend no definition describes.
- The preset editor (`/ai/presets/:presetId`; `/ai/edit/:providerId` is a kept alias) shows a **derived** preset's connection-owned fields — type, command, endpoint, key, inline bootstrap — as *Derived from service …* with a link to the service, because the server re-materializes them from that service on every save and refuses an edit that would move one. Name, arguments, timeouts, model pins, effort and generation settings stay the preset's own. A **legacy** preset is fully hand-editable, as before, and offers *Convert to derived preset* when re-deriving it would change nothing about how it runs.
- **Tiers** (Light / Medium / Heavy / Ultra, [MODEL_TIERS.md](./MODEL_TIERS.md)) are pins on a preset, so a `model: "heavy"` selection resolves on whichever preset the task names.

### Harnesses (`/ai/harnesses`)

One card per registry harness: the **enable switch** (the user's word; a harness with no word follows whether its binary is detected on PATH; `direct` is always on), the detected version, the methods it runs, how many switched-on services it can reach, and the install a missing binary needs. Updates, removal and the harness's own model listing stay on Models → Harnesses. A toggle here is one write plus a catalog invalidation, so an open picker's compose flow reflects it without a reload.

**Credential bootstraps** sits under the cards, collapsed until one exists: the launch wrappers a composite's `+<slug>` suffix names (`<command> <args…> <harness-name> [<separator>] <harness args>`), with the per-harness name map a wrapper may use (`claude` → `claude-code`). Saving never spawns anything; the wrapper runs only when a composite naming it executes.

### Services (`/ai/services`)

One card per instance: definition, plan badge, readiness (*Ready*, *Needs a credential*, *Needs an endpoint*, *Switched off*), where its credential comes from (stored here, the environment, the install `.env`, the harness's own sign-in, or a bootstrap wrapper) with a *Get a key* link for a keyed vendor still waiting on one, its endpoints, and its catalog state. **Refresh catalog** is the one action on this page that contacts a provider, and it is never run on mount, on toggle, or on display (root `AGENTS.md`, AI Provider Usage Policy) — it lists the instance's models through its definition's strategy (probe the endpoint, ask the daemon, ask the program that signs in, or the declared list) and filters them to the plan, then re-derives every preset on the instance.

**Add Service** walks definition → plan → credential / endpoint. A subscription needs neither (the harness signs in); a hosted API takes a key you store, a conventional environment variable, or a bootstrap wrapper; a local runtime needs the endpoint this install reaches it at. A service still named by a preset cannot be deleted.

This view is what the Backend Connections drawer (#6369) used to be — a connection *is* a service instance, addressed by the same UUID or slug, so `/ai/connections/:id` redirects here. What it no longer offers is binding link/unlink and per-route rows: a preset names its service outright (`serviceId`), and a preset's own settings live on its editor.

## Reaching the views

Every view and every open card is a URL — `/ai/harnesses/:harnessId`, `/ai/services/:serviceSlug`, `/ai/presets/:presetId` — reachable from ⌘K and voice ("AI presets", "AI harnesses", "AI services"; `server/lib/navManifest.js`). `/ai`, `/ai/new`, `/ai/connections[/:id]` and `/ai/harnesses/:id/connections[/:id]` redirect to their current homes.

## What federates

Nothing on this page. Harness enablement, bootstrap apps, service instances (endpoints, credentials, catalogs) and presets are machine-local: an `ai_connections` row carries this host's execution environment and credential material (ADR [privacy records machine-local](./decisions/2026-08-08-privacy-records-machine-local.md)), and `settings.harnesses` / `settings.credentialBootstraps` describe binaries on this host. A CoS task's `metadata.provider` crosses to a peer verbatim; a peer with no preset or service under that id reports it unresolved rather than substituting another.
