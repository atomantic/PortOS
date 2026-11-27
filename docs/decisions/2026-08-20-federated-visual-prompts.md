# ADR: Federated media prompts in job submissions

**Date:** 2026-08-20
**Status:** Accepted
**Related:** [User-controlled federation](2026-09-19-user-controlled-federation.md)


## Context

An opted-in peer needs the media prompt to perform a render. Discovery,
capabilities and status serve different callers and need only projected fields.

## Decision

Submit bounded image/video prompts and negative prompts verbatim to the
locally enabled and allowlisted peer/model. Instrumental audio uses the
canonical fixed-vocabulary prompt. The
[conditioning ADR](2026-08-22-federated-media-input-assets.md) defines when
lyrics and input assets may travel.

Status, capability and job progress expose only sanitized readiness, queue,
model and lifecycle fields. Keep prompts, record excerpts and filenames out
of these projections. The peer must be registered and enabled, pass provider
admission, and match local consent for the exact kind, engine and model.
Use the [provider authentication contract](../FEDERATED_MEDIA_PROVIDERS.md#authentication-and-identity).

Unattended routes require an explicitly configured tailnet peer and retain
the same allowlists. A discovered peer cannot grant itself a route. A failed
render remains bound to the selected recipient. Initial Music Video placement
has a project-scoped pool described in the
[provider guide](../FEDERATED_MEDIA_PROVIDERS.md#music-video-shot-pools-and-supplied-song-audio).

## Consequences

Media job submission is an explicit disclosure within the owner's private
network. Keep private records on their established sync channels.
