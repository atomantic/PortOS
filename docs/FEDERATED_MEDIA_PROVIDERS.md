# Federated Media Providers

PortOS can opt in to serving local media-generation capacity to another registered PortOS peer. The wire contract, `/api/federation/media/v1`, carries queued **audio, image, and video** generation through the existing durable `mediaJobQueue` and this machine's local engines.

Provider-side queueing, consumer-side capacity discovery, and durable remote execution are available for all three kinds. Provider selection is exposed through the generation APIs; the picker UI, multi-provider scheduling, input-asset transfer, and higher-level commission routing remain later slices of issue #4348.

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

`POST /api/music/generate` performs the fresh capacity preflight before returning the normal queued media-job response. Omitting `mediaProviderPeerId` keeps the existing local-engine behavior. The peer id and free-form `prompt` stay local. The worker renders the provider prompt only from the profile's enum values; non-empty remote lyrics are rejected so arbitrary personal text cannot cross the federation boundary.


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

Wire v1 is **text-to-image and text-to-video only**. A federated request that
carries an init image, reference images, keyframes, a clip to extend, IC-LoRA
references, LoRA weights, a chained (multi-chunk) render, or a non-`text` render
mode is rejected with `400 MEDIA_PROVIDER_INPUT_UNSUPPORTED` naming what has to
go. That is deliberate: silently dropping the source image a user pinned would
return a plausible render of the wrong thing. Input-asset transfer is a later
slice.

Unlike audio, image and video prompts cross as submitted rather than being
re-rendered from a fixed vocabulary. Why that is not a hole in the "no PII on
federation" rule, what stays absolutely prompt-free, and what a future standing
(unattended) route may not do are all decided in ADR
[federated visual prompts](./decisions/2026-08-20-federated-visual-prompts.md).

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
by that peer. A kind set to `null` (the default) renders locally.

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
a federated render exactly where a local one would land. An unreadable settings
file is treated as "no route configured" — logged, then rendered locally —
because a transient read error must not hard-fail every autonomous render.

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

CUDA has three states: `available`, `absent`, and `unknown`. A CUDA model is ready only when the state is positively `available`; a failed or ambiguous probe blocks admission. Runtime, host-platform, exact fixed-checkpoint readiness, and queue capacity are similarly fail-closed.

The configured `maxQueuedJobs` is conservative: all queued/running work that consumes this machine's media resources counts against it. Outgoing proxy jobs are excluded because they consume another peer's capacity; counting them could make two idle peers report busy while waiting on each other.

Status never includes prompts, lyrics, credentials, local paths, commission records, or private creative metadata.

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

Unknown fields, free-form prompts, and non-empty lyrics are rejected. The contract accepts no source URL, filesystem path, shell argument, provider credential, or arbitrary proxy target. Keeping the wire shape as prompt text lets an older wire-v1 provider accept a newer consumer, while the canonical grammar lets a newer provider fail closed on arbitrary text from an older consumer.

Within the queue's retained job window, repeating the same caller/key/body returns the original job without enqueuing again. Reusing that key with a different body returns `409 MEDIA_PROVIDER_IDEMPOTENCY_CONFLICT`. Job lookup and cancellation return the same not-found response for an unknown id and another peer's id.

The provider persists accepted work in the existing machine-local `data/media-jobs.json` queue. No commission, CoS, schedule, taste, Digital Twin record, free-form prompt, or lyrics are copied to the provider. Its queue contains only the canonical instrumental prompt derived from fixed musical descriptors.

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

A remote job's conditioning prompt is persisted **only inside its versioned `remoteMedia` marker**, never in top-level job params. That is what makes a rolled-back install fail closed: an older build cannot route the marker, so it falls through to the local generator with an empty prompt and no configured runtime instead of quietly re-rendering the job on local hardware. The queue's public job projection rebuilds the prompt for display without exposing peer routing state.

## Current boundary

Wire v1 carries instrumental audio, text-to-image, and text-to-video. Interactive remote selection is exposed through the Music Studio panel and the generation APIs rather than a peer picker on the Image Gen / Video Gen pages; unattended work routes through **Instances → Unattended render routing**. Still remaining from #4348: those Image Gen / Video Gen pickers, a privacy-preserving design for remote lyrical conditioning (which is also what keeps unattended audio local), input-asset transfer (init/reference images, LoRAs, chained renders), multi-provider fairness/failover, and aggregate provider health on System Health.
