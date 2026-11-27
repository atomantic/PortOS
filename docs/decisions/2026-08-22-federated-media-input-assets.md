# ADR: Federated media conditioning assets

**Date:** 2026-08-22
**Status:** Accepted
**Related:** [Federated Media Providers](../FEDERATED_MEDIA_PROVIDERS.md)


## Context

Conditioning images and lyrics can be essential to the requested render.
This extends the submission rules in the
[visual prompt ADR](2026-08-20-federated-visual-prompts.md).

## Decision

Send input assets only for an advertised role on the selected allowlisted
model. Upload bytes through the authenticated asset endpoint and reference the
returned caller-scoped content ID in the job. The provider verifies SHA-256,
media type and bounds, stages with expiry, and keeps accepted jobs' inputs
while they are in use. Unknown capabilities fail closed. Paths, URLs and inline
asset blobs are outside the job contract.

Send bounded lyrics verbatim only when both the model and wire advertise
support. Instrumental style still uses a canonical style/mood/instrument
profile. Model weights, LoRAs and chain state stay on their owning install.
Keep status projections free of job content.

Automatic failover is rejected because a timeout can leave work active and
rerouting would disclose inputs to a new recipient. A project can explicitly
configure a pool for initial Music Video shot placement under the
[provider guide](../FEDERATED_MEDIA_PROVIDERS.md#music-video-shot-pools-and-supplied-song-audio).
Retries stay on the selected node. Supplied song audio uses the separately
negotiated, bounded source-audio window.

## Consequences

Conditioning inherits private peer authentication and bilateral model grants.
Staging and job settlement retain ownership and enforce admission independently.
A fixed visual vocabulary would discard authored intent, so bounded visual
prompts remain verbatim under the prior ADR.
