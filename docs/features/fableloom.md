# FableLoom

FableLoom authors branching, playable series. A loom groups ordered episodes, each with a start scene and a graph of authored choices. It can link a universe for canonical cast and world context, and connect episodes to the series production pipeline. FableLoom owns traversal, interactive staging and delivery approval. The pipeline owns episode production and render automation.

## Author and rehearse

Use **Plan Series** to set the premise, episode beats and continuity, **Weave** to edit scenes and transitions, and **Play** to rehearse the authored graph. Validate the outline and reachable graph before production. A transition names an existing scene in the same episode by ID. Intent, trigger phrases and spoiler-safe descriptions help a resolver select that edge. An ending closes traversal. A missing or unrecognized edge leaves the player in place.

Scenes are passive cuts or interactive decisions. A cut plays its entry and advances on playback completion. A decision can loop holds and play a transition-specific exit before the target scene. Older scenes without a playback mode use the decision default. Legacy video references still supply entry or hold when typed assets are missing. Choose active video and hold audio deliberately. Dialogue and blocking effects make a hold unsafe for simultaneous live conversation.

Read-through supports deterministic choice and free text. Choice traversal and automatic cuts need no provider. Free-text resolution receives the authored scene and current edges and can move to one of those edges or stay. Drafting, planning, illustration, voice and render actions use the chosen provider and the explicit creative workflow. Review and approve the current assets before delivery. Later edits invalidate delivery approval.

Use timed shot plans before scene media production. A reactor preview is a separate preview run, with its own assets and provenance. A preview does not replace approved scene media until applied. Episode production tracks continuity and media evidence across scenes. See [product surfaces](product-surfaces.md) for navigation.

## Hosted runtime

The private hosted runtime uses version 1.0.0. See the [runtime contract](../../server/services/fableLoom/runtime-v1.md) for graph and playback semantics, event payloads and conformance cases. The runtime version is independent of the export package schema version.

Host and audience roles have separate transport authority. Live input opens only during an eligible connected decision hold with an offscreen protagonist and speech-safe audio. An enabled interaction window can override protagonist presence. Admission checks the current scene and asset, including actual audio occupancy, and refuses concurrent turns. The turn progresses through idle, listening, thinking and speaking. Stale async work cannot commit after an episode switch, abort or teardown.

When the designated output socket is playing narration, only its current-turn successful playback acknowledgement can commit a pending move. Failure, disconnect, timeout and scene changes discard the pending move. A text-only turn or a turn without a connected output can complete immediately. Socket snapshots and events describe private session state and stay out of the portable package.

## Portable export

An operator starts an export from an authored loom. The running instance's [API Explorer](../API.md) documents the export, status, download and cancellation operations. Jobs return a job ID, are scoped to their loom and report progress, findings, expiry and size. Operator sessions include valid delegated agent sessions. Cancellation waits for a queued or running export to settle.

Export snapshots the selected episodes in authored order and includes existing local media. Graph, outline and production checks still apply. Each reachable scene needs a still and entry clip, decision scenes need holds, and referenced exits must be available. By default assets require current approval and locked conditioning provenance. The explicit draft option flags missing provenance or approval without relaxing graph, path, audio safety, encoding or size requirements. Exports neither call providers nor make PortOS publicly reachable.

The default source profile packages sanitized PNG and remuxed H.264/AAC media. Web profiles fit within 720p or 1080p without upscaling, cap frame rate at 30 fps, normalize the authored audio mix and add posters. An optional VP9/Opus alternative accompanies web MP4. Hashes and measured sizes describe the actual outputs. Canonical source files stay intact.

Character and voice are separate opt-ins. Character files project the canonical reachable cast and approved speech canon. Voice requires character export and one matching approved, consented or appropriately licensed reference with verified bytes. Provider configuration, credentials, local paths and session transcripts stay private. Draft export cannot bypass voice approval, provenance or consent checks.

The package schema is 1.0.0. The ZIP contains `manifest.json`, `provenance.json`, `README.md`, `runtime-v1.md`, content-addressed `media/` and any opted-in character files. The optional dependency-free player runs against the package. External hosts operate their own resolver, TTS, credentials and transport without relaying public traffic to PortOS. The ZIP uses stable member order and timestamps. Jobs expire after 24 hours. The maximum size is 64 MiB per asset and 256 MiB for the package. An interrupted job fails visibly and can be exported afresh.

## Code and data

- `server/services/fableLoom/` owns authoring, hosted sessions, delivery and exports.
- `server/lib/fableLoomPlayback.js` owns shared playback choices and live-input admission.
- The export contract lives beside the exporter. Optional browser templates live in `server/services/fableLoom/static-player/`.
- Hosted state, generated assets and authoring records follow the [storage contract](../STORAGE.md). Export scratch and expired jobs are managed separately from authored records.
