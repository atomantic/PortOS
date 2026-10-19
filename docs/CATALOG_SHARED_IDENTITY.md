# Shared canonical catalog identity

A shared identity agreement consolidates two same-type ingredients on their two
owning instances. The selected survivor keeps its existing ID and owner. The
source ID remains resolvable, and original histories, source links, references,
attachments and provenance remain available through the operation receipt.

This differs from [local consolidation](CATALOG_LOCAL_MERGE.md), which requires
both records to belong to one instance. A shared agreement never transfers
ownership or creates an owner acceptance on behalf of a peer.

## Requirements

Both owners need compatible code, an existing authenticated pairing and enabled
catalog sharing in the required directions. An authorized operator on each owner
must review and accept the same plan. A delegated local agent retains its normal
operator authority. A paired peer credential is not operator acceptance.

Both authoritative ingredient records must already be unlocked. Preparation,
commit and recovery do not unlock records or enqueue generation. Deploying the
code and applying an agreement are separate operator actions.

Initial support covers exactly the two owners. Other and older peers keep their
original-ID records and ordinary sync behavior. A forwarded receipt cannot prove
a third owner's consent.

## Operator workflow

The survivor owner is the coordinator. Select the pair and survivor, preview the
proposed content, resolve every differing populated scalar and create the
reviewed operation. The plan binds both authoritative snapshots, owners,
identities and field choices. Changed evidence requires a new preview.

Import the operation on the source owner through its existing coordinator peer.
Each owner explicitly accepts the same plan hash. Acceptance reserves the
affected records and associations against concurrent changes. On the coordinator,
advance verifies the source's prepared receipt and atomically records the commit
decision with the canonical content. Advance on the source adopts the verified
decision and activates its canonical read resolution.

A coordinator commit is not proof that the other owner has adopted it. The UI
shows the local phase and last verified peer phase separately. If a request times
out, inspect or advance the same operation; do not create a replacement operation
to work around an uncertain result. Creation retries reuse the same attempt ID.
A new attempt after a confirmed abort has its own ID, even if the content is unchanged.

## Offline peers and interruption

A prepared source cannot unilaterally cancel. It needs the coordinator's durable
abort or commit decision. This preserves correctness if the coordinator committed
but its response was lost. An offline owner can therefore leave the operation
pending and protected until communication resumes. Restarting does not release
the reservation.

The coordinator may abort an operation before commitment, even if its peer is
offline or the pairing is disabled. An unaccepted source may decline its proposal.
The source adopts a coordinator abort through advance once communication is
available. No timeout or expiry silently releases prepared records.
Do not edit database receipts, disable triggers or rewrite ownership to bypass a
pending operation.

## Editing and refreshing canon

After commitment, canonical edits use the survivor's explicit ID on its owner.
Writes through the retained source ID are refused with a canonical-owner pointer.
This includes delayed media attachments; generation checks the destination before
enqueueing work. The original source and its evidence remain preserved.

The source instance's canonical projection is refreshed by advancing the same
operation, which reads directly authenticated owner state. Generic catalog
last-write-wins updates cannot overwrite the protected pair. A stale or offline
projection remains identified as such rather than being presented as current
owner evidence. Media references do not guarantee that the image bytes exist on
the receiving instance; ordinary missing-asset indicators remain meaningful.

During preparation or recovery, a protected incoming row holds that catalog
stream's sync cursor. Normal enabled sync retries it after the reservation ends,
including after a restart. This can delay that stream while the agreement is
pending; it prevents updates in the cancellation/recovery window from being lost.

Embedded canon keeps its stable ingredient IDs. A retained source canon snapshot
cannot overwrite the survivor. User exports include retained evidence with its
original identities and provenance; ordinary federation feeds keep their raw rows.
Source links and spans remain exportable even when the linked raw scrap is not
available locally; an agreement does not fetch or invent that remote source text.
Existing project and universe payloads remain contextual snapshots: consolidation
does not rewrite them or refresh a foreign-owned universe. Catalog-aware reads,
casting lookups and sheets resolve the current identity. A renderer that consumes
an embedded project snapshot directly continues to use that preserved creative
context; it is not evidence that the canonical catalog record was changed back.

## Recovery

Start recovery on the coordinator, then prepare it on the source and advance the
same operation on the coordinator and source. Recovery requires the exact applied
state to remain unchanged. Later edits, attachments, revisions or lock changes
make recovery refuse instead of overwriting work. There is no force option.

Recovery has its own durable decision and monotonic phase. A delayed old commit
cannot reactivate a recovered identity. Originals and receipts remain available;
recovery does not erase audit history or delete media files.

## Deployment and validation

The feature adds boot schema, owner-scoped reservations and read projections,
server protocol endpoints and client controls. It needs an authorized server/client
deployment and restart. Boot does not accept, commit or recover an agreement.

The design record is
[owner-coordinated catalog identity](plans/2026-10-18-catalog-shared-canonical-identity.md).
Persisted tests exercise stale plans, concurrent writes, authenticated owners,
retry and restart behavior, unavailable peers, canonical reads, preserved exports
and guarded recovery.
