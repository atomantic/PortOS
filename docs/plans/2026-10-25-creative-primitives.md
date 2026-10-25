# Creative catalog primitives and universe context

Tracking: #13609.

## Existing contracts

- `server/lib/catalogTypes.js` owns character, place (Environments), object,
  idea, scene, concept and custom catalog types. Do not introduce parallel
  Cast/Environment stores.
- `server/services/catalogCanonProjection.js` treats catalog rows as canonical
  identity and embedded universe canon as a compatibility projection. Preserve
  embedded entry IDs: series, image jobs, voice profiles and FableLoom address
  those IDs rather than catalog IDs.
- `server/services/catalogDB/refs.js` stores consumption separately from content;
  `catalogRefResolver.js` enumerates universe, series, issue, work, Creative
  Director and music-video targets. Relations and source links supply lineage.
- `client/src/lib/creativeLibraries.js` already routes characters to Casting,
  places to Environments and objects to Objects. Universe cards should link to
  these same canonical editors; character details reuse CharacterDetailEditor.
- `server/services/universeCanon.js` has a delta image-removal operation that
  clears identity-pack references and preserves concurrent render appends.
- `server/services/fableloom/exports.js` and `server/lib/fableLoomExport.js`
  require separate character and approved-voice export opt-ins. Cloning grants
  neither and never copies local voice profiles or execution configuration.

## Ownership and legacy compatibility

An ingredient has one explicitly selected owning universe, recorded as a
`universe` ref with role `owner`. This reuses the existing tombstoned, federated
reference contract (roles are already extensible); no new store or bulk migration
is necessary. Ordinary universe refs describe usage and never implicitly grant
ownership. Ownership supplies story/style context, independently of whether the
primitive currently appears in a canon bucket.

Zero owner refs means ownership needs review. Existing universe refs are shown
as candidates, including missing targets, without choosing one by list order or
name. Multiple owner refs (including mixed-version/offline federation conflicts)
are also visibly unresolved. An explicit selection can resolve legacy conflicts
without rewriting usages or identities. An established unambiguous owner cannot
be moved by an ordinary add operation; use a fork for another universe.

The creative types are `character`, `place` (Environments), `object`, `idea`,
`scene`, `concept`, and the active custom types registered by the user. All use
this same ownership contract. Provider configuration, execution/session state and
globally shared infrastructure are not creative primitives and stay outside it.
Existing unowned records remain readable and editable. New cross-universe adds
must be explicit forks; existing cross-universe references remain intact and
visible. Removing from a canon bucket retires that usage, preserving ownership,
the catalog row, other usages, images and revisions. Delete remains a separate
catalog action. To retire an owning universe, fork any primitives you want to keep
into another universe, then remove the originals from their containers and delete
them from Catalog. Reassign or delete its FableLoom stories and voice profiles
before deleting the universe; established ownership is not moved in place.

## Fork contract

The user names a destination universe and explicitly creates a fork. A fresh
catalog ID, initial revision, ownership reference and `forked-from` relation
commit atomically. A request operation key makes retry identity stable. The
source remains unchanged. Lineage records the source ID and revision clock in
the initial revision context; no production usages are copied or rewritten.

Forks copy creative description and local structured values, reminting nested
identifiers. Universe/series character relationships, emotional object links,
story-specific appearance/evolution state, pending sheet requests and execution
bindings do not cross automatically. Character voice direction remains a
candidate, visual identity asset approvals reset, and no voice profile, export
consent or approval is inherited.

Image reuse is an explicit choice. Selected managed image bytes remain immutable
library assets; the fork owns new attachment rows. Detaching/replacing an
attachment never deletes the shared file. Generated prompt provenance remains
asset provenance; it is not destination-universe approval. Other media and live
render/session state are excluded. The fork can be added to destination canon
through the ordinary explicit add operation.

## UI and verification

Show ownership/style and linked usages prominently on every primitive detail
page, regardless of selected media tab. Keep missing targets visible without
dead links. Universe canon, container casting lists and primitive pickers link
to the canonical editor. Universe management exposes all catalog types, not only
the three bible arrays. Ownership and fork actions apply their responses to
local state; realtime invalidation handles other views without polling.

Test the HTTP/service workflow for ownership conflicts, fork replay and source
preservation; test rendered navigation/editor/usage contracts and image removal.
Use isolated dependencies and targeted lint/tests plus the focused pre-push gate.
Do not run a full local suite, production migration, live browser probe or DB
test without coordination. Required hosted checks and independent review bind
to the exact PR head before merge admission.
