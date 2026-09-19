# Persistent Mind: continuous play + adjustable local context

## Continuous play playbook

PortOS minds can opt into a first-class **operating playbook** stored on CoS config as `persistentMindPlaybook`:

| Field | Meaning |
|-------|---------|
| `mode` | `default` (operator prompt only) or `continuous-play` |
| `customInstructions` | Optional extra notes appended after the mode template |

Saving a playbook never starts inference. The Mind Context panel exposes the mode selector; `PUT /api/cos/config` accepts `persistentMindPlaybook`. `GET /api/cos/mind/context` returns `playbook` + `playbookCatalog` + `playbookPhase` and previews composed instructions.

### Maturity-aware phases (#7458)

`continuous-play` no longer runs one fixed loop forever. Every wake, `resolvePersistentMindPlaybookPhase()` (`server/services/persistentMindPlaybookSignals.js`) reads the bounded Eidoverse world-signal projection the World Design recipe renders into districts (`buildEidoverseWorldSignals()`, `server/lib/eidoverseWorldSignals.js`) plus a non-committing observation report (`observeEidoverseWorld({ commit: false })`, `server/services/eidoverseObservationLedger.js`), reduces them to four numbers, and the pure picker in `server/lib/persistentMindPlaybookPhase.js` (`selectPersistentMindPlaybookPhase`) chooses one of four phases:

| Phase | When | Loop emphasis |
|-------|------|----------------|
| **Explore** | Commons is sparse (fewer than 3 built signals, or signals unavailable) | Map affordances, reconnect presence, many small interactions |
| **Construct** | Commons has some shape (3–11 built signals) and nothing is broken or waiting | Densify districts — places, labels, structures, affordances |
| **Maintain** | Recent failure rate ≥ 25%, or the Commons is mature (12+ built signals) with no unread peer contributions | Repair broken projections, retire dead affordances, re-test foundations |
| **Coordinate** | The observation marker reports foundations inherited from a peer (or a new peer) since this mind last looked, that peer is reachable, and failures are below threshold | Visit peers, read/respond to their contributions, steward the shared baseline |

**Density counts what a mind BUILT, not what PortOS ships** (#7630). The count sums apps, active agents, active tasks, peers, goals, memory categories, Jira groups, locally-authored foundations, and installed controllers. It deliberately excludes the install-constant scaffolding the same projection carries for the districts themselves — every registry feature (~15 rows whether enabled or not), the two fixed storage areas, and the single `operations`/`productivity`/`activity` summary rows. Those five put a floor of ~19 under the original count while the mature threshold was 16, so `explore` and `construct` were unreachable on every install and a brand-new one was told to steward a mature Commons. The districts still *show* features and storage; only this maturity signal stops counting them.

**`coordinate` measures unread contributions, not reachability.** It fires on `changes.newFoundations` entries that are *inherited* (a foundation this mind authored itself since the last look is not a peer waiting) plus `changes.newPeers`, with reachability kept as a necessary-but-insufficient precondition — you cannot visit a peer you cannot reach. A first observation has no marker to diff against, so it yields `null` ("not measured"), never a measured zero. The picker's observation read passes `commit: false`: advancing the visit marker here would consume the very trail the mind's own `eidoverse.observe` depends on.

Priority order when signals conflict: a still-sparse Commons always explores first; a high failure rate outranks a peer visit (fix what is broken before going visiting); construction outranks coordination below the maturity threshold, so a mind with a thin Commons keeps building rather than going visiting. The picker never reads a wall clock — it degrades to `explore` (the safe default) whenever a signal is unavailable rather than guessing.

A failure rate only exists when work actually ran. `getTodayActivity()` reports `successRate: 0` for a day with zero completed agents, so the derivation requires a non-empty sample before trusting it: an idle day yields *no* failure signal (falling back to coarse health, then to `null`), never a fabricated 100%. Without that guard every wake before the day's first completed task would claim a 100% failure rate and force `maintain`, starving `construct` and `coordinate` entirely.

The same absent-vs-empty rule governs density. A failed source read reaches the picker as `null`, not `[]`, so a projection whose district reads all failed derives `districtCount: null` ("world signals unavailable") rather than a confidently empty `0` — an outage and a genuinely empty Commons both explore, but only the latter claims to have measured anything.

Each phase template ends by naming itself (e.g. `Phase: Construct`) so the mind states its current phase in the wake's user-visible working note — how Helm and other minds can see which phase produced a given wake. `GET /api/cos/mind/context` also resolves the phase for preview (best-effort; a signal-read failure there falls back to the general loop rather than failing the request).

## Mind-adjustable `numCtx`

Granted via capability `adjustLocalContext` (capabilities schema v8). Semantic tools:

| Tool | Effect |
|------|--------|
| `mind.local-context` | Read current provider `numCtx` + safe clamp |
| `mind.adjust-local-context` | Set `numCtx` on **this mind's own local API provider** |

### Safety clamps

`server/lib/mindLocalContextClamp.js` refuses oversized windows so CPU-only / low-RAM hosts (including Grok boxes) cannot OOM PortOS:

- Absolute floor **512**, absolute ceiling **131072**
- CPU-only ceilings tiered by installed RAM (e.g. ≤16 GB → 20480)
- Free-memory ceiling reserves **2.5 GB** for PortOS + estimated model weights
- Usable NVIDIA VRAM / Apple Silicon allows higher ceilings
- Rate limit: **6** adjustments / rolling 24 h, **10** minutes apart
- Cloud / keyed / gateway providers are ineligible

Accepted adjustments persist via `updateProvider({ numCtx })` and call `ollamaManager.ensureContextWindow` for local Ollama.

### UI / API surfaces

- CoS → Mind → Tools / access: **Allow mind to adjust local model context (numCtx)**
- CoS → Mind → Context: **Operating playbook** mode selector
- Config: `PUT /api/cos/config` with `persistentMindCapabilities.adjustLocalContext` and/or `persistentMindPlaybook`
