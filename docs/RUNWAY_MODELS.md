# Runway model options

PortOS uses Runway's public [OpenAPI document](https://docs.dev.runwayml.com/openapi.json)
(API version `2024-11-06`) and [model guide](https://docs.dev.runwayml.com/guides/models/).
The documented API has no model-list/discovery endpoint. In particular, `/v1/models`
is not used. The public schema describes advertised capabilities, not an account's
entitlements or remaining credits. Catalog refresh makes no generation request and
needs no API key.

The bundled capability snapshot was verified on 2026-10-22. It offers 19 image
models and 24 image-to-video models; 23 of the video models also accept text alone.
Video edit adds Aleph 2 and Character performance adds Act-Two, for 26 distinct
video models across these workflows.

Selectors filter by the active operation. Gen-4 Image Turbo requires a reference;
Gen-4 Turbo video requires a start frame. The builder validates each model's prompt,
reference and seed constraints and emits supported parameters only. Models accepting
native negative prompts use that field; other video models receive a visible Avoid
addition. Native provider audio is disabled where the API exposes that control.

Image settings retain existing Gen-4 720p/1080p choices. Other models offer automatic
canvas selection that preserves requested aspect ratio, plus their exact documented
canvas dimensions. Video sizes and lengths depend on both model and operation:
WAN keyframe requests use auto ratios, text requests use explicit canvases, and
models such as MiniMax accept a separate resolution field. Optional advanced API
controls keep provider defaults. Unknown prices are displayed as unknown, not zero;
consult [Runway pricing](https://docs.dev.runwayml.com/guides/pricing/) before rendering.

## Veo inclusion decision (2026-10-22)

The earlier Runway integration ([#12344](https://github.com/atomantic/PortOS/pull/12344))
deliberately excluded Veo as a project choice. This expansion reverses that choice
in response to the newer request to offer all models on Runway's API within the
supported workflows. `veo3.1` and `veo3.1_fast` are therefore intentionally included;
Gen-4.5 remains the default. The earlier catalog and PR record no safety or
contractual basis for the exclusion. Inclusion does not assert account entitlement,
waive provider terms, or enable generation without the normal submission flow.

## Cache and refresh

All form instances share a five-minute browser cache, including concurrent loads.
The server shares one 24-hour catalog cache across images and videos and persists
it atomically in `.cache/runway-model-catalog.json`. This is disposable public
metadata, not an application record; it contains no credentials or personal data,
is not federated, and needs no database migration. A hash of the shipped capability
snapshot invalidates older disk caches on upgrade. Changing credentials does not
invalidate public model metadata, and no key is sent to the documentation source.

The Refresh models button bypasses freshness on both layers and updates open
subscribers. Concurrent source refreshes coalesce. A source failure preserves the
last good catalog, or uses the bundled snapshot on a cold start, marks it stale,
and backs off automatic source retries for five minutes. A valid empty model list
stays empty. A malformed document or unsupported API version cannot overwrite the
last good catalog. Corrupt or incompatible disk caches are discarded.

Refresh can remove retired options. Known models with changed consumed request
constraints and newly advertised model IDs are listed as requiring a PortOS
capability update; refresh does not guess new payload semantics. Update
`server/lib/runwayCatalogSnapshot.js`, its shared image/video projections and tests
after checking the official schema. A refreshed removal also refuses submission
before a paid POST. Generation does not perform a separate discovery lookup.

## Workflow limits

Video Gen's Runway lane offers **Video edit** (`aleph2`) and **Character performance**
(`act_two`) alongside Text and Image. Aleph takes a 2–30 second source video at up
to 30 FPS, an optional prompt (1000 characters including the negative prompt), an
optional guidance image at the start, and optional expand aspect ratio. It uses
the default MP4 delivery and preserves source resolution up to 1080p. Act-Two takes
a 3–30 second performance clip plus one character image or video, body-control and
expression-intensity controls, and an optional supported canvas. It follows the
performance rather than a text prompt. Video durations and streams are probed
before upload; invalid or unreadable inputs fail before generation.

Uploads are staged durably using the normal queue ownership/cleanup rules. The
worker creates [ephemeral Runway uploads](https://docs.dev.runwayml.com/assets/uploads/)
at dispatch time, propagates cancellation through registration and storage POST,
and submits only after every upload succeeds. Video files must be 512 bytes–200 MB.
Only local input paths are queued; 24-hour upload URIs are never persisted as retry
inputs, and replay creates fresh uploads. Storage POSTs receive signed upload fields,
not the Runway API key. Local owned inputs are cleaned on success/failure/cancel;
Runway's remote uploads expire automatically. Reloaded forms require video files to
be selected again before a new submission.

Specialized models stay out of text/image-only Music Video and Creative Director
selectors. Other models' advanced video-reference controls, multiple timed Aleph
keyframes, non-MP4 delivery, upscaling, HDR and avatars remain outside these forms.
This integration does not claim to expose every Runway API operation.

Tests use public schema excerpts and mocked transport, including refresh, cache
restart/expiry, source failures and capability-specific request bodies. No paid
Runway generation is needed for validation.
