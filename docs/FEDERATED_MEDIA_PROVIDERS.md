# Federated Media Providers

PortOS can share local audio, image and video generation with another registered PortOS install on the owner's private network. Provider and consumer opt in separately. Keep PortOS and its peer API private. See the [user-controlled federation ADR](decisions/2026-09-19-user-controlled-federation.md).

## Enable a provider

1. Configure an instance password in **Settings → Security**. It is required when enabling the provider and bootstrapping automatic pairing.
2. Register the consumer under **Instances**, pair both sides and remove the saved peer password after the pair token is confirmed. See [peer authentication](PEER_PUSH_AUTH.md#using-a-peers-image-video-and-llm-services).
3. Install and verify the local runtime and models. Under **Settings → Sharing → Federated media provider**, select the exact allowed models per kind, set the shared active-job limit and enable sharing.

The provider defaults to disabled, a limit of two active jobs, and empty per-kind allowlists. Audio advertises its music engine. Image and video use the local engine. The provider advertises only its allowed projections and keeps the unshared local model catalogue private. Cloud and CLI account capacity is outside this provider contract.

## Configure a consumer

Pair the registered provider, then enable **Use this peer for remote media** under its **Instances** card. Select the exact advertised engine/model pairs for each allowed kind. Both the provider's share allowlist and the consumer's local allowlist apply. The consumer probes all supported kinds, so a fresh empty allowlist can discover candidates. Older peers may advertise only audio or lack the versioned surface entirely.

Placement needs fresh, schema-valid capacity, positive model/runtime/host readiness, and an accepting queue. Distinguish stale, unavailable and busy snapshots. The provider repeats admission at submit time. The local allowlist and cached capacity do not travel with peer announcements. System Health and Instances surface current capacity and queue signals. See [peer administration](features/peer-administration.md).

## Remote renders

Select the exact peer/model in Image Gen, Video Gen or Music Studio. Defaults can retain local execution. For unattended Creative Director and Creative Commission work, explicitly configure **Instances → Unattended render routing**. A selected peer failure remains visible. Selecting a different peer requires a separate placement decision because it changes the recipient and model provenance. The system does not silently fail over or install remote weights.

Audio submits a canonical instrumental prompt derived from fixed profile fields. The free-form style prompt stays local. Lyrics can be sent only if the model's `lyrics` capability and the provider's wire feature both attest support. Requests without either signal refuse, preserving the user's intent. Conditioning can cross only for a supported role on an allowlisted model. Image and video capabilities advertise the accepted conditioning roles and shape constraints. Respect advertised video frame counts and canvas limits rather than assuming local settings fit the remote runtime.

LoRA files, chain state, private project history, provider credentials, filesystem paths and shell commands do not travel. See the [conditioning asset ADR](decisions/2026-08-22-federated-media-input-assets.md).

### Music Video shot pools and supplied song audio

A Music Video project can choose **This Mac**, **Selected peers**, or **Both**, with exact models on already opted-in peers. This is local project routing state and is stripped from sync. Placement checks fresh capacity, supported conditioning and the shot's requirements. Local and peer results retain their actual renderer provenance. Supplied song audio uses the explicitly supported, project-bound conditioning path. Only the exact, negotiated sample window is staged. Native A2V capability, the provider's `sourceAudio` wire feature and a source frame are required. The provider verifies the staged stereo 48 kHz PCM, its hash and the sample/frame span (up to 60 seconds). The consumer binds the original recording hash and refuses stale takes. Retain the staged input through uncertain remote settlement.

The pool applies to board-generated shots and selective revisions. Placement chooses among eligible nodes once and preserves that exact peer/model in queued work. Immutable production runs and final composition export stay local. See the [shot routing and audio ADR](decisions/2026-10-04-music-video-render-pools.md).

## Authentication and identity

Wire requests identify the registered, enabled consumer with `X-PortOS-Instance-Id` and authenticate through `peerFetch`. Prefer the pair-bound `X-PortOS-Peer-Auth` token. An older unpaired consumer can use the configured instance-password Basic credential. Basic proves access to the install and does not cryptographically bind the declared peer ID. Pair tokens remain scoped to the pair; browser and agent operator sessions do not substitute for peer admission on this surface.

## Wire v1

Response JSON identifies `wireVersion: 1`. Incompatible changes need a new versioned route. The [live OpenAPI and Explorer](API.md) enumerate operations. `server/lib/federatedMediaWire.js` owns the exact payload schemas. The stable workflow under `/api/federation/media/v1` is:

| Operation | Contract |
| --- | --- |
| `GET /status` | Report current allowlisted capability and readiness projections. Pass `kinds=audio,image,video` to request all supported kinds. |
| `GET /assets/:id`, `POST /assets` | Check for or stage owner-scoped conditioning bytes. Upload has a supported Content-Type and an `X-Content-SHA256` header. |
| `POST /jobs` | Submit the allowed engine/model and kind-specific parameters with a stable `Idempotency-Key`. New work returns 202; same caller/key/body replay returns 200. Changed body with the same key conflicts. |
| `GET /jobs/:id`, `POST /jobs/:id/cancel` | Observe or cancel the caller's job. Unknown IDs and other peers' IDs receive the same not-found result. |
| `GET /jobs/:id/result` | Download the completed result with MIME, byte count and SHA-256 metadata. |

Status distinguishes shared running occupancy from per-kind queued/active counts where supported. Consumers validate timestamps and the staleness window. Optional wire features default to the v1 baseline when absent. Legacy conditioning support can be determined from the per-model `inputAssets` capability. Readiness and an accepted job are separate observations.

Staging verifies the actual digest, media format and allowed bounds. Image asset IDs are derived from authenticated caller scope and content hash. Reuse a valid staged asset by ID. The result records digest, size, MIME and expiry. Use the advertised roles and maximum count, and restage missing or expired inputs before retrying. Staged conditioning is time-bounded and pinned while an accepted active job references it. Files are outside the normal media library.

The remote consumer uses a durable non-GPU lane. Its local job UUID provides the stable provider idempotency key. On restart it recovers the same accepted job or repeats the same keyed submission. A persisted cancellation intent is delivered to that job after restart rather than resurrecting it. A transient outage does not prove completion or create a new submission.

The consumer derives the fixed result path from the validated job ID, streams to a temporary file, and checks content type, declared length, byte count and both advertised SHA-256 digests before atomic promotion. Normal gallery/music/video completion hooks record only verified local results and bounded peer/job provenance. Provider paths and filenames are never exposed. Local conditioning persists inside the versioned remote marker so older builds cannot accidentally treat the job as an ordinary local render.
