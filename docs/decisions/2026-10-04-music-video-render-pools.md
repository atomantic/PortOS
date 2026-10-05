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

## Rollout and recovery compatibility

The machine-local maintenance v1 journal gains an optional per-operation UUID
`uncertaintyStamp`. Every uncertainty mark rotates it, including repeated marks
on an already unsettled operation. Trusted recovery captures the operation's
UUID, kind, resource and stamp before reconciliation; completion atomically
removes only that unchanged operation after verified peer termination, executor
teardown, durable publication, owned input cleanup, archive persistence and flush.
An intervening mark or identity change refuses completion. Other blockers and
the maintenance hold remain intact. Ordinary `finish()` does not clear uncertainty.

New readers accept older records, but an older strict v1 reader rejects stamped
records and reports maintenance unavailable. An older writer that encounters
such a record can leave the transaction directory locked. Mixed versions and
rollback therefore require an explicit compatibility plan before deployment:

- Designate one rollout coordinator for every server, runner and surviving
  detached process that accesses this install's journal. Hold new admissions
  and account for existing work through its verified termination and cleanup.
- Update all journal readers and writers together before enabling stamped
  writes. Keep the hold through verification; matching versions alone do not
  prove that existing work has settled or authorize resuming admission.
- Do not roll back to a strict older binary against a stamped journal. Preserve
  the journal and any transaction lock if maintenance becomes unavailable;
  restore compatible code and obtain a separately reviewed recovery procedure.
  This feature supplies no automatic lock repair or rollback migration.
- Never manually delete uncertainty, operation records or a transaction lock,
  or infer completion from process age/PID. Legacy unsettled records without a
  stamp remain blockers; they cannot use the new recovery completion capability.

## Required targeted validation before rollout

After the local test window is released, run the focused maintenance, queue,
route and remote-executor regression suites and required pregate. Verify identity
and stamp CAS, repeated/new cleanup marks, unrelated and failed settlement
blockers, hold preservation, restart, executor teardown, same-key reconciliation,
and journal/archive write failures. The source patch is not deployment acceptance.

Use isolated journal fixtures to additionally exercise the old strict reader
against a stamped v1 record and the old writer's resulting transaction lock.
Verify that compatible readers then report unavailable, new admission and
recovery completion refuse, and no automatic resume or lock/uncertainty deletion
occurs. Check legacy unstamped uncertainty remains blocked and a clean upgrade
can reconcile stamped ownership only with fresh verification. Complete the
coordinator's version inventory and recovery plan before any eventual deployment.
