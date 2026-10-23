# FableLoom runtime contract v1

Runtime version: **1.0.0** (`FABLELOOM_RUNTIME_VERSION` in
`server/lib/fableLoomPlayback.js`). Hosted session snapshots advertise
`runtimeVersion`. This version describes playback and turn semantics; an export
manifest's `schemaVersion` is a separate version. A consumer must reject an
unsupported runtime major version. Additive optional fields may be ignored;
changes to traversal, admission or event meaning require a new runtime version
and corresponding hosted regression tests.

This is the runtime foundation for [external package export #13104](https://github.com/atomantic/PortOS/issues/13104).
It does not yet implement an exporter, downloadable package or reference player.
PortOS remains a private authoring/rehearsal service. An external host runs its
own backend, credentials and transport; it never relays public calls into PortOS.

## Graph and playback

Episodes are ordered graphs with a `startNodeId`. A node has an `id`, authored
`prose`, a `playbackMode` (`cut` or `decision`), `audienceConnection`,
`protagonistPresence`, `isEnding`, `endingLabel` and ordered transitions.
Each transition has `id`, `intent`, `triggers: string[]`, optional spoiler-safe
`description` and `targetNodeId`. Resolve an edge only within the current
episode. Never invent a transition or follow a dangling target.

Playback phases are `entry | hold | exit | ended`. An entry plays once. A
decision hold loops while awaiting an allowed choice or turn. A cut plays once,
then takes its automatic continuation on media `ended`; it does not open a
conversation merely because a player reports `hold`. A selected transition may
play its exit clip before entering the target. An ending has no next turn.

Typed playback assets are entry, ordered hold loops and exits keyed by transition
id. Legacy `videoHistoryId` serves as the entry/hold fallback; a missing
`playbackMode` defaults to `decision`. See `resolvePlaybackPhaseAsset` for
selection and deterministic hold rotation. Hosted initial phase is `ended` for
an ending, otherwise `entry` for a typed entry, `hold` for typed holds, or
`entry`/`hold` for a legacy cut/decision. An absent video starts in `hold`.

An asset's audio occupancy carries `durationMs`, `characterDialogue`, `music`
and `effects` arrays. Intervals use inclusive start/exclusive end milliseconds
(`startMs`, `endMs`), with optional speaker/character labels and
`blocking: true` on effects. Live voice is unsafe if there is any character
dialogue, any blocking effect or detected clipping. The current gate excludes
the entire occupied hold; it does not carve silent gaps out of intervals.
An explicit `safeForLiveVoice: false` remains a refusal. Recompute safety from
occupancy rather than trusting a stale `true`.

## Two traversal lanes

The existing private authoring endpoint is
`POST /api/fableloom/:id/episodes/:episodeId/play`. These are data shapes,
not an instruction to call that endpoint from a public host.

| Lane | Input | Resolution |
|---|---|---|
| Deterministic | `{nodeId, transitionId}` | No LLM. An interactive node selects that exact current-node edge; an absent edge is `INVALID_TRANSITION`. Passive helper scenes take their first automatic edge. |
| Free text | `{nodeId, message, transcript?}` | A play-turn resolver chooses an existing edge or stays; the host owns its model and credentials. |

For authoring compatibility, `audienceCanParticipate` permits protagonist-mode
read-through choices, while helper-mode read-through input requires a connected
channel. That authoring convenience is distinct from live voice admission below.

The server result is:

```text
{
  action: "move" | "stay",
  transitionId?: string,     // only for a valid move
  narration: string,
  node: public scene,        // target on move; current on stay
  ended: boolean,
  resolvedBy: "choice" | "graph" | "llm",
  runId?: string             // authoring trace only; not portable package data
}
```

An ending or a node with no edges returns `stay`, empty narration,
`ended: true`, `resolvedBy: "graph"` without a provider call. A resolver
selection absent from the current node, or an edge whose target has disappeared,
stays on the current node. Do not trust a model-supplied target node.

A host can expose `resolveTurn(nodeId, message)` returning
`{move: transitionId}` or `{stay: text}`. Map a move through the local graph;
map stay text to narration. This adapter shape is not the private endpoint's
response shape. A choice-only/keyword adapter needs no network or LLM.

## Live-input admission and half duplex

`evaluateFableLoomLiveInput({node, phase, asset})` is the shared pure admission
policy. `revalidateLiveConversationGate` additionally requires an active session.
Only a connected, non-ending decision node in `hold`, with an offscreen (or
legacy unspecified) protagonist and safe active audio, accepts live conversation.
An enabled interaction window's explicit protagonist presence overrides the node
presence. An interaction window does not make a cut, entry or exit interactive.

The policy returns `{allowed: true}` or `{allowed: false, reason}`. Refusal
codes are `NODE_NOT_FOUND`, `STORY_ENDED`, `AUDIENCE_DISCONNECTED`,
`PLAYBACK_NOT_DECISION`, `PLAYBACK_NOT_IN_HOLD_PHASE`,
`PROTAGONIST_ONSCREEN` and `HOLD_ASSET_OCCUPIED_BY_DIALOGUE`; the session
wrapper adds `SESSION_INACTIVE`.

The half-duplex turn states are `idle -> listening -> thinking -> speaking`.
Accept audio/text only while listening. Reserve a turn before asynchronous
work; refuse concurrent starts and episode switches. Move to thinking before
transcription/resolution and to speaking before narration delivery. Stay returns
to listening; a committed move returns to idle until the new scene is admitted.
Abort, expiration and teardown cancel the active turn. Recheck turn/session
liveness after asynchronous work so stale results cannot change a new episode
or emit after session end.

### Speech ordering and the current hosted gap

Portable hosts must finish narration playback before committing the chosen
transition (and before admitting another turn). Bind a playback completion to
the current turn, scene revision and designated output device. Treat cancellation,
playback failure and missing completion as explicit outcomes, never an implicit
successful acknowledgement.

**Hosted v1 currently guarantees synthesis and audio dispatch before commit,
not completed playback.** `processHostedUtterance` emits `hosted:turn:tts`
then immediately changes the node and emits `hosted:story:transition`.
The legacy `hosted:speech:done` handler merely changes speaking to listening;
it neither binds the acknowledgement to a turn nor delays a transition. The
clients currently do not emit that acknowledgement. Repair is tracked in
[#13112](https://github.com/atomantic/PortOS/issues/13112).
Do not infer audible completion from a TTS frame or from a committed story frame.
The regression test pins dispatch-before-commit without claiming playback
completion.

## Transport-neutral event schema

The table defines semantic names and payloads for a host-owned WebSocket, SSE or
in-process event stream. It maps the existing private Socket.IO vocabulary;
semantic names are not new Socket.IO events. Fields marked `?` are optional.
All identifiers below are host-local graph/turn identifiers, not PortOS peer ids,
join tokens or instance ids.

| Semantic event | Payload | Private hosted mapping |
|---|---|---|
| `session:snapshot` | `{runtimeVersion, currentNodeId, playbackPhase, activeHoldIndex, turnPhase, status}` | `hosted:session:sync`; project the bounded fields, never export the full private snapshot/transcript. |
| `player:node-enter` | `{nodeId, phase, activeHoldIndex}` | Host sends `hosted:playback:update` with `nodeId`, `phase`, `activeHoldIndex`; server sends `hosted:playback:sync`. |
| `player:phase` | `{nodeId, phase, activeHoldIndex}` | Same update/sync pair for a phase-only change. |
| `turn:phase` | `{phase: "idle" \| "listening" \| "thinking" \| "speaking", turnId?, text?}` | `hosted:turn:phase`. Text is narration, not a new graph. |
| `turn:speech` | `{turnId, audio, mimeType, target: "host" \| "audience"}` | `hosted:turn:tts`; audio is base64 WAV in the private transport. |
| `story:transition-committed` | `{transitionId, node, playbackPhase}` | `hosted:story:transition`; node is the server-projected target. |
| `session:ended` | `{reason}` | `hosted:session:ended` (also carries a private session id). |
| `runtime:error` | `{code, message}` | `hosted:error`. |

An initial/reconnect snapshot is authoritative. Apply events in stream order.
A host-owned transport must provide ordering/reconnect reconciliation and reject
late results from a different session, episode or turn. The current Socket.IO
stream has no portable sequence/replay envelope; an external host supplies its
own. Private `hosted:turn:transcript`, join/host tokens, peer status and session
addresses are not exported runtime records.

The play-turn system inputs are authored story context, current scene prose,
current transition ids/intents/triggers/descriptions, the host's bounded
conversation history, reader message and narration-format instructions. A model
returns `{action: "move" | "stay", transitionId?, narration}`; validate its edge
against the current graph before building a public result. Package character
inputs and any voice reference are separate explicit opt-ins, never an export
of provider configuration, adapters, LoRAs or machine-local paths.

## Conformance checks

`server/services/fableLoom/hostedSession.test.js` exercises the shared admission
policy through real turn admission, including a connected cut with a stale hold
phase, occupied audio, explicit window presence and the legacy decision default.
Its deferred synthesis test checks the current hosted phase/event ordering.
Existing hosted socket and weave suites cover role-scoped transport, teardown,
stale turns and provider-free deterministic traversal. Speech playback
acknowledgement conformance remains the explicit gap in #13112.
