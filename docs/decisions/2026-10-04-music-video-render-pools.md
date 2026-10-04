# ADR: Explicit Music Video Pools Choose Initial Placement; Retries Keep Their Node

- **Date:** 2026-10-04
- **Status:** Proposed (draft implementation)
- **Supersedes in part:** rule 5 of [federated input assets](2026-08-22-federated-media-input-assets.md), only for initial Music Video shot placement inside an explicitly saved pool. Its prohibition on automatic failover remains.

## Context

A Music Video project may use this machine and selected federated instances for
generated shots without making remote machines a prerequisite. The previous
contract deliberately declined load balancing because an implicit target change
could disclose conditioning to a different peer and change the result's model.
The user now selects the permitted target set in the project itself.

## Decision

The project stores an install-local placement policy: This Mac, Selected peers,
or Both, with exact peer/model pairs. It narrows existing bilateral opt-in and
model grants. It never creates credentials, grants, installations or standing
routes. Project sync strips this policy in both directions.

Before enqueue, select the least occupied eligible member, checking fresh
capability, known memory floor/free memory, queue capacity and maintenance state.
Unknown information excludes a node. Persist that selection once. Retries,
cancellation and reconciliation keep the same peer, model and idempotency key;
an uncertain response is not permission to dispatch elsewhere. Serialize this
consumer's GPU jobs per peer, while retaining the separate local GPU lane and
parallel work on different peers. Initial placement is advisory, not a distributed
capacity reservation; provider admission remains authoritative.

Source audio is conditioning under the same authentication and asset rules as
frames. Its separately negotiated feature avoids widening legacy image-role
enums in status. Bind a canonical PCM window to source/clip hashes and exact
sample/frame clocks, at most 60 seconds. Only runtimes whose input/output
controls implement this contract advertise it. Provider validation confirms
clip bytes, not the unavailable original master. Keep owned inputs through
uncertain submission or local finalization, then clean them during settlement.
Admission, staging and cleanup participate in the existing maintenance boundary.

Board shots and revisions use the existing action, capture/evidence and revision
checks. Production runs retain their immutable approved pool and budget contract
and refuse nonlocal project policy in this slice. Production runs also refuse
supplied-audio conditioning until their immutable grants bind exact audio windows.
Final composition export stays local. Supplied audio does not imply verified
performance lip-sync.

## Alternatives and limits

- Implicitly choose any discovered peer: rejected because discovery is not consent.
- Fail over after timeout: rejected because the first render may still exist.
- Transfer the full master or a URL: rejected in favor of a bounded, hashed,
  caller-scoped window with no filesystem or fetch authority on the wire.
- Claim remote final export: rejected until a real composition executor, assets,
  cancellation and evidence path are implemented and verified.

No hardware render or real peer dispatch is part of this draft's validation.
Unit and contract tests use synthetic local fixtures and mocked providers.
