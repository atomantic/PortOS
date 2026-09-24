# Model access — scoping a provider to what you are entitled to run

A provider's model list is what its upstream **advertises**, which for a hosted
gateway is the vendor's whole product line regardless of what your account can
reach. NVIDIA NIM's `/v1/models` answers with 80+ models; only a subset is free
on [build.nvidia.com](https://build.nvidia.com/models). An OpenRouter account may
be limited to the `:free` variants. A vendor key may be scoped to two models out
of thirty.

Entitlement is **not in the catalog response** — NVIDIA's entries carry `id`,
`object`, `created` and `owned_by` and no pricing, tier or entitlement field — so
PortOS cannot detect it. It is declared instead, per provider, in
**Settings → AI Providers → Edit → Models → Model Access**.

## What a policy does

| Mode | Effect |
|------|--------|
| `all` | Everything the provider advertises. The shipped default. |
| `allow` | Only models matching the pattern list. |
| `deny` | Everything except models matching the pattern list. |

Once set, the scope applies to **every model picker in PortOS** — provider cards,
the Settings > AI assignment page, the AI Providers → Services catalog summaries, CoS agent
and task pickers, pipeline stage pickers, reviewer model selection — and to the
**model comparison chart**, whose default pills and coverage list are built from
the models your providers can dispatch.

One provider is deliberately out of scope: the Codex ChatGPT-subscription
catalog (`GET /api/providers/codex/models`) asks the Codex app-server what the
signed-in account may actually run, so it already answers with the account's real
entitlement. A policy on a codex record does not narrow it further.

## Patterns

Case-insensitive globs over the whole model id:

- `*` matches any run of characters, `?` matches exactly one.
- Everything else is literal, so `moonshotai/kimi-k2.5` is an exact pin and
  `gpt-4.1` does not match `gpt-4x1`.
- There is no substring matching: `gemma` does not match `google/gemma-3-4b-it`.
  Write `*gemma*` if that is what you mean — a policy that silently widened
  itself would be one you cannot audit by reading it.

Ticking a model in the editor's catalog list adds its exact id to the same list,
so you can start from globs (`meta/*`) and refine by hand. A check mark on the
right of a row means one of your globs already covers it.

Useful shapes:

```
meta/*                                     # a vendor namespace
*:free                                     # an OpenRouter free variant
nvidia/llama-3.1-nemotron-70b-instruct     # an exact pin
```

## What it never does

- **The stored catalog is never narrowed.** Scoping happens on the way out to a
  reader; `providers.json` keeps the real list. Switching back to "All models"
  restores it with no re-probe, and a refresh always re-learns the full catalog.
- **A configured model is never hidden.** A model pinned as the provider's
  default, a Light/Medium/Heavy/Ultra tier, or a fallback stays selectable even
  when the policy would exclude it — a picker whose stored value is missing from
  its options renders blank and re-points the provider on the next save. The
  policy governs what can be chosen *next*, not what the record already says.
- **Execution, accounting and refresh are never scoped.** Quota burn, usage
  reconciliation, the runner and every harness catalog refresh read the
  unscoped list. The policy is about what a human may pick next, not about what
  already ran or what the upstream advertises.
- **A half-finished policy hides nothing.** Selecting `allow` before typing any
  pattern means "not configured yet", not "hide everything", so model pickers
  stay populated while you work. The editor says so explicitly rather than
  showing a reassuring count.

## Gateway inheritance

A hosted gateway is usually three PortOS records: the `api` provider, its
OpenCode CLI wrapper, and its TUI wrapper. They front the same upstream on one
account, so **a wrapper with no policy of its own inherits the gateway's** —
exactly as it already inherits the gateway's API key. Set the policy once on
`nvidia-nim` and the API, CLI and TUI options all narrow together.

A wrapper that declares its own policy keeps it. A CLI/TUI pair (`<stem>` /
`<stem>-tui`) shares one policy the way it already shares `models`: it is one
program on one backend.

## Where it lives

| Concern | File |
|---------|------|
| Policy rules (normalize, match, scope) | `server/lib/aiToolkit/internal/modelAccess.js` |
| Storage + gateway inheritance | `server/lib/aiToolkit/providers.js` (`withGatewayModelAccess`) |
| Schema | `server/lib/aiToolkit/validation.js` (`providerSchema.modelAccess`) |
| The selecting-vs-executing seam | `server/services/providers.js` (`getSelectableProviders` / `listSelectableProviders`) |
| Applied to provider payloads | `server/routes/providers.js` (`presentProvider`) and `server/lib/aiToolkit/routes/providers.js` |
| Applied to provider discovery and PortOS benchmark runs | `server/routes/modelPerformanceBenchmarks.js` |
| Editor | `client/src/components/providers/ProviderModelAccess.jsx` |
| Browser-side rules | `client/src/utils/providerModelAccess.js` |

The payload a client receives carries `models` (scoped), `modelCatalog` (the full
advertised list, present only when something was hidden), `modelAccess` (the
record's own policy), `modelAccessEffective` / `modelAccessSource` (the resolved
one and where it came from) and `modelAccessHiddenCount`. **An editor that saves a
model list must seed it from `modelCatalog`**, or an ordinary save persists the
narrowed list over the real one.
