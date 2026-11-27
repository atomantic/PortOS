# Catalog creative primitives

HTTP contract details for catalog creative primitives (character, place, object, idea, scene, concept and active custom types) and universe canon. Moved from the API reference; the complete operation list is the API Explorer (`/api-reference/catalog`). Scrap graph commits are in [catalog-ingest.md](./catalog-ingest.md#scrap-graph-commits); shared identity agreements are in [Shared catalog identity](#shared-catalog-identity).

## Ownership, locks and forks

Catalog `character`, `place` (Environments), `object`, `idea`, `scene`, `concept`
and active custom creative types share one identity model. `GET
/api/catalog/ingredients/:id/details` and `GET
/api/catalog/ingredients/:id/universe-context` return `universeContext`: explicit
`owner`, `status`, legacy `candidates` and labeled `refs`. Ownership uses the
existing universe-reference role `owner`; it is separate from container uses.
Missing/conflicting owners stay unresolved, and ordinary legacy references never
select a style universe by list order. Derived FableLoom/Voice Studio uses are
exact canon-pointer links; series/issue `prose-mention` uses are labeled inferred
mentions. Derived uses are read-only and never confer export consent.

The details endpoint defaults to `?view=full` for existing callers. Library
editors use `?view=profile`: editable identity/payload, sources, relations and
direct ownership/reference labels and small `coverMedia` keys, with `universeContext.usageComplete=false`.
Media, missing-media checks and revision snapshots are omitted, rather than
reported as empty. Fetch the universe-context endpoint for derived story/voice
usage; it returns the context object with `usageComplete=true`. A failed or
pending usage fetch does not mean the primitive is unused.

`?view=media` returns only `{ media, missingMedia }`, deriving integrity from
the same attachment read. History remains available through the existing
paginated revisions endpoint. Library editors fetch media on its first visible
tab and history on explicit request; full details retain their prior fields.

`GET /api/catalog/ingredient-cards?ids=…` accepts 1–50 IDs up to 80 characters.
It returns `{ items }` with the requested `id`, resolved `canonicalId`, bounded
card payload fields, selected `thumbnailKey`, direct usage counts, explicit
ownership and shared identity write status. Missing/deleted IDs are omitted;
requested retained IDs remain visible and read-only. This projection omits
longform canon, media metadata, history and local voice configuration.

`PATCH /api/catalog/ingredients/:id/lock` accepts only `{ locked: boolean }`.
For character/place/object it changes the persisted flag under a row lock,
preserves other payload fields, records revision history, projects linked canon
and emits `catalog:primitive-changed`. It does not embed or save an editor draft.
Existing shared identity fences apply. The client shares this control across
cards and detail; locks protect AI/render workflows while manual authoring
retains its existing permissions.

`PUT /api/catalog/ingredients/:id/owner` accepts `{ universeId }`. It resolves
unowned/ambiguous records explicitly and refuses to move an established owner.
`POST /api/catalog/ingredients` accepts optional `universeId` and `operationKey`
for atomic owned creation and retry-safe identity. Legacy callers can still
create records staged for ownership review.

`POST /api/catalog/ingredients/:id/fork` accepts `{ universeId, operationKey,
name?, seedImages?, fields?, copyImages? }`. The UUID operation key is required. Replays return the
original new primitive; changed input with the same key returns 409. A fork has
fresh identity, initial revision and `forked-from` lineage. Image reuse defaults
off. `seedImages` lists the source portrait/reference media keys to reuse (a key
no longer on the source refuses the fork with `CATALOG_FORK_SEED_MISSING`);
`copyImages: true` reuses all of them. Reused attachment rows are independent,
point at the same immutable managed image files, and keep their age/look tags
re-keyed to the fork's new forms and wardrobes (review ratings stay with the
source). `fields` saves a redesign-assistant proposal onto the fork; only that
type's redesign fields are accepted. Voice media, execution/session bindings,
approvals and export consent are excluded. Production uses and inter-character
links are not copied.

Casting > Design rounds (characters only; refused on a locked record):
`POST /api/catalog/ingredients/:id/design/spread` accepts `{ idea, count,
formId?, providerId, model?, effort? }` and returns `{ lines }`, one face
design per take written by the chosen provider. `POST
/api/catalog/ingredients/:id/design/render` queues one round and returns
`{ roundId, jobs: [{ jobId, line }] }`. `mode` is `open` (`lines`, `note?`,
`framing`, `seedImageFiles?`; text only), `refine` (`baseImageFile`, `note`,
`count`), `feature` (`baseImageFile`, `feature`: 8 takes of one feature),
`blend` (`baseImageFile`, `blendImageFiles`: 1–3 reference faces, `note?`,
`features?`; 4 steps toward them, or `strength` (5–100%) with `count` 1–4
takes at that strength; the older single `blendImageFile` is still accepted) or `age` (`baseImageFile`, `formId`, `count`). Rounds never send
the record's other references as guides. Each take lands as a reference with
role `design:<roundId>:<n>`, left out of likeness until it is made an anchor.
Both routes have a `/compose` preview that queues nothing.

The existing `/ingredients/:id/link` API manages membership. Universe canon
roles populate/remove compatibility projections through serialized mutations;
new cross-universe placement requires a fork. Removing membership preserves the
primitive, owning-universe association, other usages, revisions and files.
Primitive deletion returns `CATALOG_PRIMITIVE_IN_USE` while linked containers
remain. Canon removal returns `UNIVERSE_CANON_IN_USE` while FableLoom or local
voice profiles still hold its exact entry ID. Reassign/remove those bindings
first. `catalog:primitive-changed` refreshes ownership and membership views.

## Canon description repair

Migration 422 fills blank descriptions from existing image prompts. It
preserves authored descriptions and locked entries and makes no AI calls.

## Shared catalog identity

A shared identity agreement consolidates same-type ingredients on two
paired, compatible owners with catalog sharing enabled. The survivor
keeps its ID and owner. The source ID, original records, histories,
attachments, references and provenance remain available. Use
[local consolidation](../CATALOG_LOCAL_MERGE.md) for two records on one owner.

1. Unlock both records. On the survivor owner, preview the pair and
   resolve differing populated fields before creating the operation.
2. Import on the source owner. An authorized operator on each side accepts
   the same plan. Acceptance reserves both records and associations.
3. Advance on the survivor owner to verify source preparation and commit,
   then advance on the source to adopt the result. Check each phase
   separately. On timeout, inspect or retry the same operation.

The coordinator can abort before commitment. A prepared source needs the
coordinator's durable decision before releasing its reservation. An offline
owner can leave records reserved through restart and delay catalog sync.
Do not bypass that reservation in the database. After commitment, use the
survivor ID and owner for edits and advance the same agreement to refresh a
stale source projection. Embedded project snapshots retain their context.

To recover, start on the coordinator, prepare on the source and advance on
both. Recovery refuses if applied records or attachments have since changed.

## Environment greyboxes

Open an Environment's **Greybox** tab and choose a starter or attach a
Blender layout. Use coarse geometry, figure anchors and saved camera
shots to preserve placement, scale and framing across shots. Dimensions
are in metres with the floor at zero. Capture a view as a shot reference,
or use the Photoreal tab to render through Blender. See the
[offline sequence command](../SCRIPTS.md#offline-greybox-sequences).
