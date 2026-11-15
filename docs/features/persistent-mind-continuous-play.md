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
| **Maintain** | Recent failure rate ≥ 25%, or the Commons is mature (12+ built signals) with no unread peer contributions | Repair what observe reports broken; when nothing is, build or visit a peer instead of re-projecting and re-testing healthy structures |
| **Coordinate** | The observation marker reports foundations inherited from a peer (or a new peer) since this mind last looked, that peer is reachable, and failures are below threshold | Visit peers, read/respond to their contributions, steward the shared baseline |

**Density counts what a mind BUILT, not what PortOS ships** (#7630). The count sums apps, active agents, active tasks, peers, goals, memory categories, Jira groups, locally-authored foundations, and installed controllers. It deliberately excludes the install-constant scaffolding the same projection carries for the districts themselves — every registry feature (~15 rows whether enabled or not), the two fixed storage areas, and the single `operations`/`productivity`/`activity` summary rows. Those five put a floor of ~19 under the original count while the mature threshold was 16, so `explore` and `construct` were unreachable on every install and a brand-new one was told to steward a mature Commons. The districts still *show* features and storage; only this maturity signal stops counting them.

**`coordinate` measures unread contributions, not reachability.** It fires on `changes.newFoundations` entries that are *inherited* (a foundation this mind authored itself since the last look is not a peer waiting) plus `changes.newPeers`, with reachability kept as a necessary-but-insufficient precondition — you cannot visit a peer you cannot reach. A first observation has no marker to diff against, so it yields `null` ("not measured"), never a measured zero. The picker's observation read passes `commit: false`: advancing the visit marker here would consume the very trail the mind's own `eidoverse.observe` depends on.

Priority order when signals conflict: a still-sparse Commons always explores first; a high failure rate outranks a peer visit (fix what is broken before going visiting); construction outranks coordination below the maturity threshold, so a mind with a thin Commons keeps building rather than going visiting. The picker never reads a wall clock — it degrades to `explore` (the safe default) whenever a signal is unavailable rather than guessing.

A failure rate only exists when work actually ran. `getTodayActivity()` reports `successRate: 0` for a day with zero completed agents, so the derivation requires a non-empty sample before trusting it: an idle day yields *no* failure signal (falling back to coarse health, then to `null`), never a fabricated 100%. Without that guard every wake before the day's first completed task would claim a 100% failure rate and force `maintain`, starving `construct` and `coordinate` entirely.

The same absent-vs-empty rule governs density. A failed source read reaches the picker as `null`, not `[]`, so a projection whose district reads all failed derives `districtCount: null` ("world signals unavailable") rather than a confidently empty `0` — an outage and a genuinely empty Commons both explore, but only the latter claims to have measured anything.

**One orientation call per wake.** A wake has `COS_TOOL_CALL_LIMITS.maxCallsPerTurn` (5) semantic calls, shared by every tool. Every template, and the self-wake prompt, opens with a single `eidoverse.observe`: the wake prompt's environment snapshot already reports the runtime and connection, and observe's `peers` carry the same `peerId` that `eidoverse.visit` takes. `eidoverse.status` is for library asset paths before a spawn; `eidoverse.destinations` only when observe could not list peers. The templates used to open with status then observe, and a mind added destinations before visiting — three calls gone before any action, so `visit → visit-chat → leave` never fit and every wake ended by announcing the visit as its next curiosity. An ACTIVE visit listed under "Open Eidoverse guest visits" is finished first. Maintain is also the steady state of every mature, healthy Commons, so its template no longer claims something is broken — the same unmeasured-claim defect #7630 removed from Coordinate. Keeping PortOS-managed districts current is the deterministic `Eidoverse PortOS World Projection` job (Chief of Staff → Jobs), not a mind's per-wake chore.

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
- CoS → Mind → Environment details (`GET /api/cos/mind/visibility`, also the wake prompt's environment snapshot): workspace diagnostics cover only the apps in the mind's managed-app access list (`persistentMindCapabilities.allowedAppIds`), or every active app when no allowlist is stored. The snapshot fits a fixed character budget in app order, so listing every app hid a granted app further down the registry and let an ungranted app's checkout mark the whole snapshot `blocked`.

## Persistent Mind task filing

The Persistent Mind has one explicit, default-off typed action, `cos.create-task`.
When the grant is enabled, each wake receives a bounded server-built catalog of
runnable apps and enabled CLI/TUI coding providers. The catalog includes each
provider's selectable models and effort levels, and marks apps whose effective
work tracker supports the issue-only **Plan & File Issue** workflow.

The mind may select the provider, model, effort, priority, delivery mode, and PR
completion policy per request. Implementation mode requires one of
`review-then-merge`, `merge-on-green`, or `leave-open`; plan-only mode is only
valid for GitHub/GitLab apps and is normalized to the existing unattended
`plan-task --yes` no-code/no-PR contract. The queue path revalidates every choice
after inference, so stale prompts, disabled providers, invented model ids, and
unsupported trackers fail closed.

Task model selection can be restricted in Persistent Mind Tools with an exact
provider/model allowlist. An empty list preserves the unrestricted catalog; a
non-empty list is applied to both the model choices sent to the mind and the
server-side queue admission check, which supports subscription-specific or
local-only task lanes. A removed or malformed allowlist fails closed.

`GET /api/cos/mind/tools` returns the authority inventory and the managed-app
roster. It does not list coding providers, models, or effort levels — the mind
still receives that redacted catalog in its wake-time task prompt, and Mind
Tools restricts models only through the task-model allowlist. Broader PortOS
APIs remain governed by their own authenticated route contracts and are not
silently made callable by enabling task filing.

## Persistent Mind phone calls

`voice.call-user` is the mind's only outward-reaching authority, and like every
other grant it is **off by default** — an install upgrading with the mind
already running gains nothing until the user turns it on in **Mind → Tools**.
It lets the mind place a FaceTime Audio call to the single handle configured in
**Settings → Voice → FaceTime Audio**. The request the model returns
(`callRequest: { reason, openingLine }`) carries no recipient, so a confused or
compromised turn cannot dial anyone else.

The gate lives in `server/services/persistentMindCallCapability.js` and runs
*after* inference. A call is placed only when all of these hold:

| Check | Suppression reason |
|---|---|
| The grant is on (re-read from stored config) | `not-granted` |
| The optional **FaceTime** feature is enabled | `feature-disabled` |
| Voice is enabled and an identity is saved | `voice-disabled`, `identity-unconfigured` |
| No browser tab can speak the message instead | `tab-available` |
| The user's local time is outside voice quiet hours | `quiet-hours` |
| No call is already up | `call-in-progress` |
| ≥30 minutes since the last call, ≤3 calls in the last 24 h | `too-soon`, `rate-capped` |
| A call-host tab is attached and the helper dials | `no-call-host`, `dial-failed` |

The caps are counted in durable Persistent Mind state (`callHistory`), so a
restart, a crash, or a supervisor rewire cannot hand back a fresh allowance. The
budget is spent only on a call that actually went out. Every decision — placed
or suppressed, and why — is appended to the trajectory as `mind.call.requested`
plus `mind.call.placed` / `mind.call.suppressed`; the dialed handle is never
written there. When a request is refused, the turn's reply is appended with the
reason, so the mind cannot leave the user waiting for a phone that never rings.

A placed call runs with the mind's persona and a bounded briefing of its
trajectory, speaks the `openingLine` the moment the far end picks up, and hands
the transcript back as a Persistent Mind message on hangup, so the next wake
knows what was said.

**Critical-notification escalation** (Settings → Voice) uses the same gate and
the same budget, but is authorized by its own `facetime.escalateCritical`
setting rather than by the mind's grant. When a `critical` notification is
still unread after `facetime.escalateAfterMinutes` (default 10) and no voice
tab is available, PortOS asks to ring the user with the notification as the
opening line. Off by default.

## Self-directed local thinking presets

In the Mind settings drawer, **Models → Self-directed local thinking** lets the
user enable `chooseThinkingPreset` and approve exact local presets. It defaults
to off on new and upgraded installs and is independent of task-agent model
permissions. Saving preferences and loading the catalog perform no inference.

Only configured direct local API runtimes qualify. Account-backed routes,
CLI/TUI wrappers, and unknown routes are excluded. Approval binds the preset,
provider name, endpoint and runtime; editing these requires renewed approval.
Removing a model, preset, or supported effort refuses the pending selection.

The semantic actions `mind.thinking-presets` and
`mind.request-thinking-preset` expose the approved catalog and a bounded
`{ presetId, reason }` request. One request borrows a preset for the next
self-directed wake; queued human messages and the current turn keep their own
routes. The default profile, memories, and identity are unchanged.

Only one request may be pending or active. At most three are accepted per
rolling 24 hours, with a 30-minute gap. Admission also advances the recorded
attempt time so a delayed wake cannot evade these limits. Cancellation, failed
admission, interruption and restart do not refund allowance. Failed attempts
retire the alternate and schedule an ordinary wake on the default profile.
Existing endpoint slots, CoS capacity, autonomy and per-call budgets still gate
every execution. No tool can extend its own session or edit these permissions.

The same Models panel cancels pending requests and shows recent concise reasons
and outcomes. Disabling the grant cancels the pending request; revoking it during
execution refuses further provider calls. Execution receipts in Sessions show
the actual route and outcome without exposing hidden reasoning. Durable request
records live alongside the existing machine-local mind state; migration 348
preserves prior profiles, grants, and counters.
