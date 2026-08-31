# Federated Media Providers

PortOS can opt in to serving local media-generation capacity to another registered PortOS peer. The wire contract, `/api/federation/media/v1`, carries queued **audio, image, and video** generation through the existing durable `mediaJobQueue` and this machine's local engines.

Provider-side queueing, consumer-side capacity discovery, durable remote execution, and unattended (Creative Director / Commission) routing are available for all three kinds. Interactive provider selection is exposed through the generation APIs and the Music Studio panel; Image Gen / Video Gen pickers, multi-provider scheduling, and input-asset transfer remain later slices of issue #4348.

## Enable a provider

1. In **Settings → Security**, configure an instance password. The provider API remains closed when authentication is off, even though ordinary PortOS APIs normally trust the private network in that posture.
2. Register the consumer under **Instances**. The consumer must store this provider's Basic credential on its peer record and send its own registered instance id on every request.
3. Install and verify the desired music runtime and model under **Music**. A model must be locally ready before it can be advertised or accept work.
4. In **Settings → Sharing → Federated media provider**, select the allowed models per kind, choose the shared active-job limit, and enable the provider.

Audio models come from the Music engine registry (`engine` is the music engine id). Image and video models come from this install's local generator, so their `engine` is always `local` — the cloud-CLI image/video backends (codex/grok/agy) spend a *provider's own* account quota rather than sharing this machine's GPU, and are deliberately not federatable.

The default is disabled:

```json
{
  "federation": {
    "mediaProvider": {
      "enabled": false,
      "maxQueuedJobs": 2,
      "audioModels": [],
      "imageModels": [],
      "videoModels": []
    }
  }
}
```

An older install without this settings slice behaves exactly like the default above. Known fields are validated while unknown future fields are preserved, so rolling an install back does not erase newer provider settings.

Image and video models are selected the same way as audio, from
**Settings → Sharing**. Their candidate list comes from
`GET /api/settings/media-share-candidates`, which enumerates this instance's local
image/video model catalogs with the same readiness projection the wire status
reports. That endpoint is **local-only and never exposed to peers** — it lists
unshared local model inventory, which is exactly what a peer has no business
reading.

## Configure a consumer

1. Register the provider under **Instances** and make the relationship mutual so the provider recognizes this consumer's instance id.
2. Store the provider's instance-password credential on its peer card. The normal peer health probe may work without it when provider auth is off, but the federated-media API intentionally does not.
3. Expand **Remote media provider** on the peer card and enable **Use this peer for remote media**. PortOS immediately probes the versioned status endpoint through `peerFetch`.
4. Select the exact advertised engine/model pairs this instance may use, per kind — the panel lists an **Allowed audio / image / video models** group. This local allowlist is independent from the provider's sharing allowlist; both sides must permit a model.

The consumer default is also disabled:

```json
{
  "mediaProvider": {
    "enabled": false,
    "audioModels": [],
    "imageModels": [],
    "videoModels": []
  }
}
```

A probe asks each peer for **every** kind this build knows
(`?kinds=audio,image,video`), not just the kinds already allowlisted here. Scoping
the question to the allowlist was a chicken-and-egg bug: a fresh consumer
allowlists nothing, so it asked for audio only, so the peer advertised no visual
capabilities, so there was never an image or video row to check. A provider too
old to know the query parameter ignores it and returns the audio-only projection
it always did.

This configuration and the last sanitized capacity snapshot live only on the local peer record. They are stripped from announce responses and do not become federation records. Older peers without the wire-v1 endpoint show as **older peer** rather than making the normal instance probe fail.

The Instances card reports the provider's ready/busy/unavailable state, shared active-job count, queue depth, and advertised model readiness. A consumer preflight accepts a model only when the peer is explicitly enabled, the exact model is locally allowlisted, the wire response validates, the capacity timestamp is fresh, the queue is accepting, and runtime/model/CUDA readiness is positive. Unknown, malformed, clock-skewed, or stale status blocks assignment. The provider remains authoritative and repeats admission checks when a later executor submits the job.

An API caller deliberately selects remote execution on Music generation by sending the local peer-record id together with an explicit advertised engine/model and a fixed-vocabulary instrumental profile:

```json
{
  "prompt": "A fictional slow synthetic pulse",
  "engine": "minimax-music3",
  "modelId": "minimax-music3",
  "mediaProviderPeerId": "00000000-0000-4000-8000-000000000001",
  "remoteMusicProfile": {
    "style": "cinematic",
    "mood": "dreamy",
    "tempo": "slow",
    "energy": "medium",
    "instruments": ["strings", "synthesizer"]
  }
}
```

`POST /api/music/generate` performs the fresh capacity preflight before returning the normal queued media-job response. Omitting `mediaProviderPeerId` keeps the existing local-engine behavior. The peer id and free-form `prompt` stay local — the worker renders the provider prompt only from the profile's enum values.

**Lyrics do cross**, and the asymmetry between the two text fields is deliberate. A style/mood/instrument profile renders the prompt at no expressive cost, so the privacy-safe canonical form is required there; lyrics *are* the words, so no alphabet encodes them without discarding them (ADR [conditioning crosses to an allowlisted peer](decisions/2026-08-22-federated-media-input-assets.md) rule 2). Add a `lyrics` field alongside the profile to condition a remote render.

Sending them needs **two** signals to agree, and they live at different levels of the payload because they answer different questions:

| Signal | Where | Means | Absent |
|---|---|---|---|
| `lyrics` | on the capability | the **model** sings | — (always present) |
| the `lyrics` feature | `features` at the status root | **this provider's build** carries lyrics on the wire | reads as `false` |

A provider predating lyrical federation advertises `lyrics: true` for MiniMax Music 3 and then rejects the field at submission, so absence must fail closed or every remote lyrical render becomes a 400 the user cannot act on. When either half is missing, `POST /api/music/generate` refuses with `400 MEDIA_PROVIDER_LYRICS_UNSUPPORTED` naming which one, and Music Studio pins Instrumental only with the reason — it never silently renders a wordless take of a song the user wrote words for.

Consumers ask through `federatedMediaSupports(status, feature, capability)` (`server/lib/federatedMediaWire.js`, mirrored in `client/src/lib/federatedMediaReadiness.js`) rather than reading either field directly, so the fail-closed reasoning lives in one place. The `inputAssets` capability block remains the only legacy overlap tell because it is genuinely per-model.


### Remote image and video renders

`POST /api/image-gen/generate` and `POST /api/video-gen` take the same
`mediaProviderPeerId` selection. `mediaProviderEngine` names the provider-side
engine and defaults to `local`:

```json
{
  "prompt": "a lighthouse at dusk",
  "modelId": "dev",
  "width": 1024,
  "height": 1024,
  "mediaProviderPeerId": "00000000-0000-4000-8000-000000000001"
}
```

Both routes run the same fresh capacity preflight and then return the normal
queued media-job response, with `mode: null` (no local backend is rendering
it) and the peer id echoed back as `mediaProviderPeerId`. Omitting
`mediaProviderPeerId` keeps the existing local/cloud behavior byte for byte.

**Conditioning images cross; models and chain state do not.** An init image,
reference images, and a video start/end frame are what the render is *of*, so
they travel with it (ADR [conditioning crosses to an allowlisted
peer](./decisions/2026-08-22-federated-media-input-assets.md) rule 1) — see
[Upload a conditioning image](#upload-a-conditioning-image) for the mechanism.
Everything else is still rejected with `400 MEDIA_PROVIDER_INPUT_UNSUPPORTED`
naming what has to go, and each refusal is a recorded decision rather than a
missing feature:

| Input | Crosses? | Why |
|---|---|---|
| init image, reference images, start/end frame | **yes**, when the model advertises the role | conditioning — the render is defined by it |
| LoRA weights | no | a LoRA is a **model**; remote model installation is out of scope (rule 3) |
| keyframes, clip to extend, IC-LoRA refs, chained chunks | no | multi-step **chain state** this machine sequences (rule 4) |
| an uploaded (not gallery-saved) video frame | no | still in the multipart temp dir when the federated branch runs — save it to the gallery first |

Refusing beats dropping throughout: silently discarding the source image a user
pinned returns a plausible render of the wrong thing.

Unlike audio, image and video prompts cross as submitted rather than being
re-rendered from a fixed vocabulary. Why that is not a hole in the "no PII on
federation" rule, what stays absolutely prompt-free, and what a standing
(unattended) route may not do are all decided in ADR
[federated visual prompts](./decisions/2026-08-20-federated-visual-prompts.md).

### Picking a target in the UI

Image Gen, Video Gen and the Music Studio panel all carry the same
**Generation target** dropdown — `This instance` plus every peer switched on
as a media provider. Picking a peer swaps the local model dropdown for the
peer's advertised models and replaces the local runtime gates with the peer's
own readiness.

One resolver answers "is this peer usable right now?" for all three surfaces
(`client/src/hooks/useFederatedMediaTarget.js` over
`client/src/lib/federatedMediaReadiness.js`), applying the same gates, in the
same order, that `assertFederatedMediaProviderSelection` applies server-side.
Two consequences worth knowing:

- **Only the intersection is offered.** A model has to be on this machine’s
  per-kind allowlist *and* advertised by the peer. An allowlisted model the
  peer stops advertising, and a model the peer offers that was never
  allowlisted here, are both un-pickable — with different remedies said out
  loud, since the fixes are on different machines.
- **The verdict is re-derived at submit time.** A capacity window expires on
  the clock, not on a state change, so the reading behind an enabled Generate
  can already be stale by the time it is clicked. The click re-runs the gates
  and refuses locally rather than letting the peer reject work the user
  already committed to.

A form holding an input the **selected peer model** cannot take blocks Generate
and names what has to be cleared — per role, against that model's advertised
`inputAssets`, with an absent block reading as "accepts nothing" so a peer on an
older build is never offered a render it would reject. The mirror case is
handled too: a model that can only render FROM an image (an edit-only image
model, a video model with no text mode) blocks until one is supplied. Nothing is
cleared for you: the inputs stay filled, so switching the target back to
`This instance` renders exactly what was set up.

### Video frame and canvas constraint negotiation

Providers advertise their model geometry and frame constraints in their capability status:
- `frameStride`: Stride multiplier for continuous frame models (e.g. Wan 2.2 uses stride 4, legal counts `4n + 1`).
- `maxNumFrames`: Maximum allowed frame count for the model.
- `frameOptions`: Discrete allowed frame counts for fixed-cadence models (e.g. MiniMax H3 `17n + 5` grid).
- `fpsOptions`: Supported frame rates for models with fixed/preset fps requirements.
- `resolutionOptions`: Allowed canvas presets (`w`, `h`, `label`).

When preparing a remote video job, the consumer negotiates requested parameters against the provider's advertised constraints:
- Frame count snaps down to the nearest legal discrete option or `n * stride + 1` (or up to the model's minimum option if below the floor), bounded by `maxNumFrames`.
- Frame rate snaps to the nearest supported `fpsOptions` entry.
- Canvas dimensions snap to the closest aspect ratio and area preset in `resolutionOptions`.
- Adjustments are logged (`🌐 Federated render: adjusted ...`), and the negotiated parameters are persisted inside `remoteMedia.request` so reconciles replay the exact negotiated job. Requests that cannot be made legal fail closed with `400 MEDIA_PROVIDER_INPUT_UNSUPPORTED`.

### Unattended renders (Creative Director / Creative Commission)

Everything above is a *per-request* choice: a human picks a peer in the UI and
the server validates it. Creative Director and Creative Commission have no human
in the loop at enqueue time, and their planners are LLMs — so "let the caller
name a peer" would be exactly the arbitrary-peer routing this contract exists to
prevent. Their routing lives in this instance's own settings instead:

```json
{
  "federation": {
    "mediaRouting": {
      "image": {
        "peerId": "00000000-0000-4000-8000-000000000001",
        "engine": "comfy",
        "modelId": "sdxl-base"
      },
      "video": null
    }
  }
}
```

Set it under **Instances → Unattended render routing**, which offers only
(peer, model) pairs that are both locally allowlisted and currently advertised
by that peer. A kind set to `null` (the default) renders locally. The card also
reports what the routed peer is saying right now — readiness plus the shared
queue occupancy — through the same `resolvePeerMediaReadiness` /
`summarizePeerMediaQueue` helpers the Instances peer card, System Health and the
interactive pickers read, so no surface can disagree with another.

**The route is validated where it is SAVED, not only where it is used.**
`PUT /api/settings` refuses a `federation.mediaRouting.<kind>` naming a peer that
is unknown (`404 MEDIA_PROVIDER_PEER_NOT_FOUND`), switched off
(`409 MEDIA_PROVIDER_PEER_DISABLED`), not enabled as a media provider
(`409 MEDIA_PROVIDER_NOT_CONFIGURED`), not allowlisted for that exact
engine/model pair (`403 MEDIA_PROVIDER_MODEL_NOT_ALLOWED`), or reachable outside
the tailnet (`403 MEDIA_ROUTING_PEER_NOT_TAILNET`). None of those is a transient
capacity problem — a route in any of those states can never run — and unattended
work has no human at the moment it fails, so the refusal belongs at the save,
where there is one (`server/services/federatedMedia/routingPolicy.js`).

Only *durable configuration* is checked at save time. Live capacity is not: a
provider is routinely asleep, busy, or mid-probe when its route is configured,
and gating the save on a fresh snapshot would make the card unusable at exactly
the moment someone sits down to set it up. Freshness, queue admission, and
per-model readiness stay on the enqueue path, which re-checks all of them — and
re-checks the tailnet gate per request, since a peer's host can be edited after
the route is saved. **Clearing a route is always allowed**, whatever became of
its peer, so a bad configuration can never become permanent.

An unattended route inherits the same text-to-image/text-to-video boundary the
interactive routes enforce. A job carrying an init image, reference images,
keyframes, a clip to extend, IC-LoRA references, LoRA weights, or chained chunks
is rejected with `400 MEDIA_PROVIDER_INPUT_UNSUPPORTED` naming what has to go,
rather than being silently rendered without its conditioning — a shot that
quietly ignores its reference frame is worse unattended than interactively,
because nobody is watching to notice.

Output semantics the wire cannot express are rejected the same way: a scene
asking for a silent (audio-disabled) render would come back **with** audio, so it
is refused rather than rendered wrong. Post-processing passes (`cleanC2PA`,
`denoise`) are the one thing dropped rather than refused, with a log — they
polish the produced file rather than change what is rendered, and `cleanC2PA`
defaults on for cloud modes nobody explicitly chose. Re-applying them after
download is a follow-up.

A local-readiness gate never suppresses a routed render. "No local Python
runtime" is exactly the state a machine that routes its renders is in, so the
Creative Director first-pass and scene paths consult `hasConfiguredMediaRoute`
before skipping work the peer was going to do. A routed enqueue can also *throw*
where a local one could not (busy/stale/unauthorized provider); the scene runner
settles the scene through its normal failure path instead of leaving it stuck in
`rendering`.

**A standing route requires a Tailscale peer.** A non-tailnet peer is refused
with `403 MEDIA_ROUTING_PEER_NOT_TAILNET` — on save and again on every enqueue —
and the Instances picker does not offer one. Interactive routing is unchanged
— the difference is review cadence:
a standing route exports every future prompt of its kind with nobody looking, so
a misconfigured counterparty is a permanent leak rather than a one-time mistake,
and `peerFetch`'s `rejectUnauthorized: false` leaves a plain-LAN or non-`.ts.net`
hop with no server authentication at all. Authentication would not save it
either: the prompt rides the request body, so an impostor holding the connection
reads it before failing to answer. Required by ADR
[federated visual prompts](./decisions/2026-08-20-federated-visual-prompts.md)
(rule 5); the gate is its own fail-closed predicate (`server/lib/tailnetPeer.js`)
rather than a re-export of the probe-deferral heuristic, so tuning that heuristic
can never widen this boundary. The browser ports it as `client/src/lib/tailnetPeer.js`
only so the picker can explain an absent option; the server never trusts that copy.

Three properties are worth stating explicitly:

- **Every unattended path routes, or none does.** The Creative Director planner
  tool, the scene runner, and first-pass portraits/scene frames all enqueue
  through one helper (`enqueueUnattendedMediaJob`). A route that applied to a
  project's planner renders but not its scene renders would be worse than no
  routing: half the shots would come off the peer's model and half off the local
  one, with nothing to explain why they don't match.
- **The agent names nothing.** The planner's own `modelId` is discarded in favour
  of the route's — a peer advertises its own model ids, and a local model name
  would fail the peer's allowlist check with a confusing "not allowlisted".
- **A routed kind fails closed, it does not fall back.** When the provider is
  stale, busy, unauthorized, or unavailable, the enqueue fails with that typed
  reason. It does not quietly render locally: that would burn hours of local GPU
  on work deliberately routed to another machine, invisibly.
- **Audio is deliberately unroutable.** A federated audio submission may carry
  only a canonical prompt rendered from a fixed enum profile, and a Creative
  Director music bed is free-form by construction — so it stays local rather
  than being silently rewritten into a profile the user never chose.

Destination tags on the job (`creativeDirectorSceneImage`, `musicVideo`,
`catalogAttach`, …) survive routing untouched, so the same completion hooks file
a federated render exactly where a local one would land.

An **unreadable** settings file fails the enqueue with `MEDIA_ROUTING_UNREADABLE`
rather than falling back to a local render. It is not the same as a settings file
that parses and simply configures no route (that renders locally, as it should):
a failed read cannot tell us whether a route exists, and guessing "no route"
would silently spend local GPU on work the operator deliberately sent to another
machine. A provider rejection inside a batch is contained rather than fatal —
one refused portrait or scene frame is recorded in that run's `skipped` list and
the rest of the batch still queues.

## Capacity at a glance (System Health)

**System Health → Overview → Media capacity** answers "can this install render
right now, here or on a peer, and if not, why not?" in one card.

The **local** half comes from `GET /api/system/health/details` under a `media`
key: this machine's CUDA state and, per lane, how many renders are running
against that lane's configured concurrency plus how deep its queue is.

| Lane | Concurrency | What runs there |
|------|-------------|-----------------|
| Local GPU | 1 (serialized) | local image/video/audio/training renders |
| Cloud CLI | `imageGen.codex.parallelLimit` | codex/grok/agy renders — external quota, no local GPU |
| Federated | 20 | outgoing proxy jobs rendering on a peer |

CUDA is reported with the same three states the wire uses — `available`,
`absent`, and `unknown` — and the card labels them distinctly. A probe that
could not run is not the claim "this machine has no GPU", and collapsing the two
is what would make an operator go hunting for a card that is sitting there fine.
An unreadable capacity report renders as unknown rather than as an idle machine.

The **peer** half lists every peer enabled as a media provider with its
readiness state, allowlisted kinds, the peer's own shared queue depth against its
`maxQueuedJobs`, how many of those jobs it runs in parallel, which kinds are
occupying its lanes, and how long ago it was probed — the same state vocabulary and
remedy text the Instances peer card uses, from one shared resolver
(`client/src/lib/federatedMediaReadiness.js`), so the two screens cannot
disagree.

Both surfaces re-derive **stale** at render time from the stored snapshot's
`freshUntil`. A snapshot probed as `ready` sits on the peer record until the
next poll, so without that check it would keep reading `ready` well after the
server would refuse to submit against it — the inverse of the fail-closed rule
the capacity contract is built on. Nothing here gates work either way: the
server re-probes and fail-closes before any job leaves.

The peer half is assembled in the browser from `GET /api/instances`, a local
read. It is deliberately **not** folded into `/api/system/health/details`
alongside the local half: registered peers fetch that endpoint on every probe,
so our peer list and routing policy would ride federation with it — exactly what
`redactPeerForWire` keeps machine-local.

## Authentication and identity

Every request requires both:

- `Authorization: Basic …`, verified against the provider instance password by the global auth gate; browser session and Bearer authentication are deliberately rejected for this peer-only surface.
- `X-PortOS-Instance-Id: <consumer-instance-id>`, resolving to an enabled peer registered on the provider.

Use `peerFetch` for PortOS-to-PortOS calls; it already attaches the configured Basic credential and local instance id. The instance-id header identifies the registered peer, while the Basic credential authenticates access to this PortOS install.

As with existing peer sync, the instance-id header is self-asserted. Basic authentication proves access to the provider install; it does not cryptographically bind that credential to one peer row. Owner-scoped job lookup is therefore a least-disclosure boundary for cooperating peers on the trusted network, not protection from another holder of the same instance password spoofing a registered id.

## Wire v1

All successful JSON responses include `wireVersion: 1`. The version is also fixed in the route path so an incompatible future contract can coexist rather than silently changing v1.

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/federation/media/v1/status` | Fresh allowlisted capabilities, CUDA/runtime/model readiness, queue depth, and staleness window |
| `POST` | `/api/federation/media/v1/jobs` | Submit an idempotent audio/image/video job; returns `202` for new work and `200` for a replay |
| `GET` | `/api/federation/media/v1/jobs/:id` | Read an owner-scoped sanitized job projection |
| `POST` | `/api/federation/media/v1/jobs/:id/cancel` | Cancel the caller's queued or running job |
| `GET` | `/api/federation/media/v1/jobs/:id/result` | Download the completed WAV / PNG / MP4 bytes with integrity metadata |

### Capacity status

`GET /status` reports **audio only** unless the caller opts in with `?kinds=audio,image,video`. That default is what keeps an already-deployed audio-only consumer working: its own copy of the wire schema validates `kinds`/`capabilities` against a literal `audio`, can never be patched retroactively, and would reject a capability naming a kind it has not heard of. A consumer asks for a kind only when it has models allowlisted for it.

`GET /status` is computed live and carries `generatedAt` plus `staleAfterMs`. Consumers must stop assigning new work after that window instead of treating stale capacity as available. A provider timestamp more than 30 seconds in the future is also rejected as unknown clock state rather than extending capacity indefinitely.

#### `features` — what the provider's BUILD speaks

```jsonc
{
  "wireVersion": 1,
  "features": ["lyrics", "inputAssets"],   // optional; absent = the wire-v1 baseline
  "capabilities": [ /* … */ ]
}
```

Some wire capabilities are properties of the **sender**, not of any one model:
whether the payload can carry lyrics, or conditioning images, is a fact about
the code the provider is running. Those live in one `features` list at the
status root rather than as a boolean stamped onto every capability. Per-model
facts stay on the capability (`lyrics` — does this engine sing; `inputAssets.roles`
— which conditioning slots this model takes), and a consumer must satisfy
**both** before it sends the field.

The list is emitted verbatim from what the build implements — a feature is
listed because the code shipped, never because a configured model happens to use
it. That is what lets a consumer tell "this peer predates conditioning" apart
from "this peer speaks conditioning but has only text-only models allowlisted",
which a per-capability boolean could not: both looked like an absent field.

`features` is optional and additive in both directions, so it needs no
`SCHEMA_VERSIONS` bump. **Absent reads as the wire-v1 baseline** — no lyrics, no
conditioning — for the same fail-closed reason `concurrency` and `byKind` read
absent as unknown: a provider that never shipped the handling rejects the field
at submission, so inferring consent from silence turns every such render into a
400 the user cannot act on.

A consumer **filters** this list rather than validating it, per member:

- a feature name it does not recognize is carried through and simply never matched;
- a member that is not a short identifier token — prose, a number, `null` — is dropped, and costs its neighbours nothing;
- only a `features` value that is not a bounded array at all degrades to absent.

None of those invalidate the status, and that matters more than it looks. A
strict element schema fails before any filtering runs, so ONE bad string would
take a peer's entire status offline — turning "ignores a feature we have not
heard of" into "cannot read this peer", the failure this list was introduced to
prevent. Degrading to absent rather than `[]` matters for the same reason: an
empty list is a peer positively denying every feature, which is a stronger claim
than a malformed field has earned.

Consumers ask `federatedMediaSupports(status, feature, capability)` rather than
testing the list inline, which keeps the fail-closed feature check in one place.
The `inputAssets` capability block remains the only legacy overlap tell because
it is genuinely per-model.

CUDA has three states: `available`, `absent`, and `unknown`. A CUDA model is ready only when the state is positively `available`; a failed or ambiguous probe blocks admission. Runtime, host-platform, exact fixed-checkpoint readiness, and queue capacity are similarly fail-closed.

The configured `maxQueuedJobs` is conservative: all queued/running work that consumes this machine's media resources counts against it. Outgoing proxy jobs are excluded because they consume another peer's capacity; counting them could make two idle peers report busy while waiting on each other.

### Drain rate and per-kind occupancy

The queue block also reports how fast that backlog drains, because a depth alone
cannot say:

| Field | Meaning |
|-------|---------|
| `totalActive` | every queued/running local media job, including kinds this contract does not federate |
| `providerActive` / `queued` / `running` | the subset owned by federated callers — a *share* of the above, never the whole picture |
| `maxQueuedJobs` | the admission bound `accepting` is computed against |
| `concurrency` | how many jobs run at once on the lane a federated submission lands on |
| `byKind` | `{running, queued}` for each negotiated kind currently holding a lane |

Two jobs ahead of a submission mean two renders' wait on a serialized lane and
roughly none on a parallel one; `concurrency` is what tells those apart. It is
the width of the one lane a federated job runs in, **not** a sum across lanes —
the lanes are alternatives, so a machine with a wide parallel cloud-CLI lane
must not claim that width for GPU work that serializes. Every job this contract
carries is a local-engine render, so today that is the serialized GPU lane.

`byKind` lists only the negotiated kinds currently holding a lane; with the
block present, an absent kind is idle. It need not sum to `totalActive`, which
also counts local work of kinds this contract does not federate (LoRA training)
occupying the same lanes.

`byKind` and `totalActive` describe the whole machine, while `running`/`queued`
describe only the federated share of it — so the UI labels the federated
numbers rather than rendering them bare. An unlabelled `0 running` beside
`audio 1 running` would say the peer is simultaneously busy and idle.

Both fields were added after wire v1 shipped, so both are optional: a provider
on an older build omits them and a consumer must read that absence as
**unknown**, never as zero. The UI drops the segment rather than rendering a
lane as idle that the peer never reported on.

Status never includes prompts, lyrics, credentials, local paths, commission records, or private creative metadata.

### Upload a conditioning image

Conditioning bytes go up **before** the job that references them, through their
own endpoint — never inline in a job body, and never as a filesystem path (ADR
[conditioning crosses to an allowlisted peer](./decisions/2026-08-22-federated-media-input-assets.md)
rule 1):

```
POST /api/federation/media/v1/assets
Content-Type: image/png            # png | jpeg | webp
X-Content-SHA256: <hex digest of the body>
<raw bytes>
```

The provider hashes the body itself and refuses a mismatch
(`MEDIA_PROVIDER_ASSET_INTEGRITY`) — a truncated transfer must fail rather than
render something subtly different. It also sniffs the magic bytes and refuses a
body that contradicts its declared type, because the header is the caller's word
for what this is while the bytes are what the generator will open. The reply is
a receipt:

```json
{
  "wireVersion": 1,
  "assetId": "1f0c8a3b9d2e4a67-<sha256>",
  "sha256": "<sha256>",
  "sizeBytes": 284119,
  "mimeType": "image/png",
  "expiresAt": "2026-08-22T18:00:00.000Z"
}
```

A job body then names `{ "assetId": "…" }` in `initImage`, `referenceImages`,
`sourceImage`, or `lastImage` — only roles the capability's `inputAssets.roles`
advertises, and at most `inputAssets.maxCount` of them. An id that is not staged
(expired, swept, or never uploaded) fails the submission with
`410 MEDIA_PROVIDER_ASSET_NOT_FOUND` **before** the job is queued, so the
consumer can re-upload and retry rather than watching a job die minutes later.

Four properties are worth knowing:

- **Content-addressed, and the consumer asks first.** The id is
  `<callerHash>-<sha256>`, derivable by BOTH sides — so before sending anything a
  consumer computes the id from its own instance id plus a streamed file digest
  and `GET`s it. A hit costs one small request instead of up to 32 MiB, which is
  what makes a reconcile after a restart, or a second render from the same init
  image, nearly free. On a miss it uploads; an identical re-upload refreshes the
  expiry rather than rewriting the file.
- **Caller-scoped.** The id's first half is derived from the *authenticated*
  caller — re-derived on every reference, never parsed from the request — so one
  peer cannot reach another's staged asset even given its exact id. Absent,
  expired, and someone else's all answer the same 404.
- **TTL-bounded, but never out from under a live job.** Staged bytes live 6
  hours under `data/federated-media-inbox/`, swept opportunistically as work
  arrives — except that the sweep first pins the conditioning of every queued or
  running job. The age gate is a backstop; a job waiting behind a long render or
  a first-run model download outlives it easily, and deleting its source image
  would leave the runner unable to open a file the consumer is still waiting on.
  The Data Manager purge for this category refuses on the same predicate, so it
  can never be more permissive than the sweep. The directory sits outside every
  media root the gallery and the sync layer read, and is excluded from backups —
  it holds another machine's data, not this install's.
- **Consumers persist paths, not ids.** A queued job's marker records the LOCAL
  source paths; ids are obtained immediately before each submission. An id names
  a slot in a TTL-swept area, so a marker holding one would reconcile into a
  confident reference to bytes that are gone.

A provider that predates this ADR omits `inputAssets` from its capabilities
entirely, and **absence reads as unsupported** — a consumer refuses to send
conditioning rather than discovering at submit time that the peer rejects it.

### Submit a job

Send a unique, stable `Idempotency-Key` header with the canonical instrumental request rendered by the consumer:

```json
{
  "engine": "minimax-music3",
  "modelId": "minimax-music3",
  "prompt": "Instrumental cinematic music with a dreamy mood, slow tempo, medium energy, featuring strings and synthesizer. No vocals or spoken words.",
  "durationSec": 60,
  "durationMode": "manual"
}
```

Unknown fields and free-form style prompts are rejected. Lyrics are accepted for a model whose capability reports `lyrics: true`, and refused with `400 MEDIA_PROVIDER_LYRICS_UNSUPPORTED` otherwise — dropping them would render a plausible take of the wrong thing. The contract accepts no source URL, filesystem path, shell argument, provider credential, or arbitrary proxy target. Keeping the wire shape as prompt text lets an older wire-v1 provider accept a newer consumer, while the canonical grammar lets a newer provider fail closed on arbitrary text from an older consumer.

Within the queue's retained job window, repeating the same caller/key/body returns the original job without enqueuing again. Reusing that key with a different body returns `409 MEDIA_PROVIDER_IDEMPOTENCY_CONFLICT`. Job lookup and cancellation return the same not-found response for an unknown id and another peer's id.

The provider persists accepted work in the existing machine-local `data/media-jobs.json` queue. No commission, CoS, schedule, taste, Digital Twin record, or free-form style prompt is copied to the provider — its queue holds the canonical prompt derived from fixed musical descriptors, plus the submitted lyrics when the caller sent them.

### Download and verify a result

A completed job projection includes `result.sha256`, `result.sizeBytes`, `result.mimeType`, and an owner-scoped `result.downloadUrl`. The download repeats the digest in `X-Content-SHA256`. Consumers should stream to a temporary file, verify both byte count and SHA-256, then atomically promote it into their local library. A missing or changed provider-side file returns a typed unavailable result instead of a dangling path.

Provider filesystem paths and original filenames never cross the API boundary.

### Consumer reconciliation

Remote jobs of every kind use a dedicated non-GPU lane in the consumer's durable media queue — work running on a peer must never occupy this machine's single GPU slot. The local job UUID is also the stable provider `Idempotency-Key`. If the consumer restarts while the job is running, it requeues that same local record, replays the submission to recover the provider job id, and resumes status/progress polling. Temporary peer and provider outages remain queued rather than creating duplicate work.

Cancellation intent is persisted before the consumer contacts the provider. After a restart it is replayed against the recovered provider job instead of resurrecting the render. A provider restart is handled by its own durable media queue; the consumer continues polling the owner-scoped wire job.

On completion, the consumer ignores the advisory download URL and derives the fixed owner-scoped v1 result endpoint from the validated provider job id. It streams into a local partial file, verifies `Content-Length`, MIME type, both advertised digests, actual byte count, and SHA-256, then atomically promotes the file into the local library. Only that verified local filename reaches the normal completion hooks.

Each kind then registers the render exactly as a local one would, which is what makes it visible at all:

| Kind | Lands at | Also registers |
|------|----------|----------------|
| audio | `data/music/music-gen-<jobId>.wav` | the Music Studio completion hook |
| image | `data/images/<jobId>.png` | a `<jobId>.metadata.json` gallery sidecar the media index re-reads |
| video | `data/videos/<jobId>.mp4` | a video-history row plus a thumbnail |

The sidecar and history row record the render's provenance as `federatedPeerId` / `federatedJobId` — instance-level identifiers already shared across the federation, never a hostname, address, or credential.

A remote job's conditioning — the prompt, and an audio job's lyrics — is persisted **only inside its versioned `remoteMedia` marker**, never in top-level job params. That is what makes a rolled-back install fail closed: an older build cannot route the marker, so it falls through to the local generator with an empty prompt and no configured runtime instead of quietly re-rendering the job on local hardware. The queue's public job projection rebuilds the prompt for display without exposing peer routing state.

## Current boundary

Wire v1 carries lyrical and instrumental audio, and image/video renders both text-only and conditioned on an init, reference, or start/end frame. Interactive remote selection is exposed on the Image Gen, Video Gen and Music Studio surfaces; unattended work routes through **Instances → Unattended render routing**.

The boundary's remaining edges are **decisions, not gaps** — see ADR [conditioning crosses to an allowlisted peer](decisions/2026-08-22-federated-media-input-assets.md):

- **LoRA weights never cross** (rule 3). A LoRA is a model, not conditioning, and remote model installation is out of scope for federation. Install it on the provider and allowlist a model that uses it.
- **Multi-step chain state never crosses** (rule 4) — a source video to extend, chained chunks, IC-LoRA references. The consumer sequences the chain; a provider holding one step of it cannot see the rest.
- **No automatic fairness or failover** (rule 5). A job that silently re-targets another peer has changed both where the data went and which model produced the result.

- **No fixed-vocabulary "visual profile"** (rule 6). Any enum small enough to be privacy-safe cannot express what the user asked for; it would not protect the prompt so much as discard it.

The first two are refused with `400 MEDIA_PROVIDER_INPUT_UNSUPPORTED` naming what has to go. Changing any of them needs a new ADR saying what changed about the reason — not a reading of the existing one.
