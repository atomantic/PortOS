/**
 * PortOS schema-version contract for cross-instance sync.
 *
 * Two PortOS instances that exchange data (federated peer push, snapshot
 * sync, share-bucket manifests) need a way to detect a version mismatch
 * BEFORE applying records the receiver can't parse. Without this, an
 * upgraded sender silently corrupts a downstream peer whose code doesn't
 * yet understand a new storage layout.
 *
 * `PORTOS_SCHEMA_VERSIONS` is the per-sync-category WIRE contract — distinct
 * from the storage-layout version stamped on `data/{type}/index.json` (see
 * each service's local `TYPE_SCHEMA_VERSION` const). Bump the wire contract
 * for either:
 *   (a) a storage layout change (e.g. universes 4→5 splitting out of the
 *       monolithic JSON), OR
 *   (b) an additive record-shape change that a not-yet-upgraded peer would
 *       silently strip on round-trip (e.g. pipelineSeries 1→2 for the
 *       `series.arc.readerMap` field).
 * For (a) ship the corresponding `scripts/migrations/NNN-…js` to update the
 * stamped storage version too; for (b) the local storage layout stays put.
 * The number flows through every outbound payload's `portosMeta.schemaVersions`;
 * receivers compare incoming vs local and reject ahead-mismatches (sender too
 * new) or behind-mismatches (sender too old to satisfy a forward-only field).
 *
 * Absent categories default to 0 — the comparator treats 0 as "no check"
 * so historical / un-versioned data categories pass through unchanged.
 * Future PRs that introduce a layout change for `series`, `issues`, etc.
 * add an entry here.
 */

import { join } from 'path';
import { PATHS, tryReadFile, safeJSONParse } from './fileUtils.js';

export const PORTOS_SCHEMA_VERSIONS = Object.freeze({
  // Type-level (storage layout) version for `data/universes/{id}/index.json`.
  // v5 = post-split. Migration 034 introduced it. The per-record-shape version
  // stays at 4 (stamped inside each record by `sanitizeTemplate`).
  // v6 = canon characters gained `relationshipLinks[]` (structured
  // character-to-character links + opposing-force tags, #1287). Additive +
  // gracefully degrading, but version-gated for the same reason as
  // `pipelineIssues`/`pipelineSeries` v2: a not-yet-upgraded peer that receives
  // and re-sanitizes a universe through its relationshipLinks-unaware
  // `sanitizeCharacter` would silently strip the field and last-writer-wins the
  // loss back onto the newer peer. Bumping makes the older peer reject the
  // ahead-version universe transfer instead. Per-category gate → only universe
  // sync pauses with old peers; pipeline/catalog/etc keep flowing.
  // v7 = canon objects gained `attachments[]` (structured object↔character
  // emotional-attachment links — emotion/significance/origin/role, #1288).
  // Same rationale as v6: additive + gracefully degrading, but version-gated so
  // a not-yet-upgraded peer that re-sanitizes a universe through its
  // attachments-unaware `sanitizeObject` can't silently strip the field and
  // LWW the loss back onto the newer peer.
  //
  // NOTE — `catalog` is intentionally NOT bumped for this field (matches the
  // #1287 relationshipLinks precedent). A bible object promoted to the catalog
  // carries `attachments` in `catalog_ingredients.payload`; an older peer's
  // `updateIngredient` → `sanitizeObject` would drop it on a local edit and a
  // catalog sync back could clobber the newer copy. We accept that graceful
  // degradation rather than gate `catalog` — bumping it would pause ALL catalog
  // sync with version-mismatched peers for one additive field, the heavier
  // tradeoff this project has chosen against for additive bible fields. The
  // `universes` gate above already protects the canonical (embedded) copy.
  universes: 7,
  // v1 = post-split. Migrations 035/036 introduced the pipeline collection
  // layout for issues and series.
  // v2 = `stages.audio.audioMode` + `stages.audio.cues[]` added (whole-episode
  // audio, issue #863). Additive, but version-gated for the same reason
  // `pipelineSeries 1→2` (readerMap) is: an older, audioMode/cues-unaware peer
  // that receives and re-sanitizes the record would silently strip the new
  // fields and last-writer-wins the loss back onto the newer peer. Bumping
  // makes the older peer reject the ahead-version issue transfer instead.
  // Per-category gate → only issue sync pauses with old peers; series/universes
  // keep flowing.
  pipelineIssues: 2,
  // v2 = `series.arc.readerMap` added (Unified Story Builder). Additive +
  // gracefully-degrading, but version-gated so a not-yet-upgraded peer can't
  // round-trip a series through its readerMap-unaware sanitizer and LWW-strip
  // the field back onto a newer peer. Per-category gate → only series sync
  // pauses with old peers; issues/universes keep flowing.
  // v3 = `series.arc.tickingClock` added (#1289). Same situation as readerMap:
  // an additive field INSIDE the series.arc payload, so a ≤v2 peer that receives
  // and re-sanitizes a series through its tickingClock-unaware `sanitizeArc`
  // would silently strip the countdown and last-writer-wins the loss back onto
  // the newer peer. Bump makes the older peer reject the ahead-version series
  // transfer instead. Per-category gate → only series sync pauses with old peers.
  // v4 = `series.styleGuide` added (#1303) — a top-level series house-style
  // field (tense/POV/audience/rating/reading-level/tone/conventions). Same
  // silent-strip-then-LWW corruption as readerMap/tickingClock, just one level
  // up: a ≤v3 peer re-sanitizes a series through its styleGuide-unaware
  // `sanitizeSeries`, drops the guide, and last-writer-wins the loss back onto
  // the newer peer. Bump makes the older peer reject the ahead-version series
  // transfer instead. Per-category gate → only series sync pauses with old peers.
  // v5 = `series.coverImage` added — a top-level derived field holding the
  // filename of a rendered volume/issue cover, shown as a thumbnail on the
  // pipeline series list. Derived (any peer can recompute it from its own
  // seasons/issues), but it's only recomputed on cover-render or the one-time
  // boot backfill — never on every read — so a ≤v4 peer that re-sanitizes a
  // series through its coverImage-unaware `sanitizeSeries` would drop the
  // pointer and LWW the loss back onto the newer peer, where it may never
  // recompute (a finished series renders no new cover). Gate so the older peer
  // rejects the ahead-version transfer instead. Per-category gate → only series
  // sync pauses with old peers.
  // v6 = `series.characterArcs[]` added (#1293) — per-character story arcs
  // (want/need, start → end state, transition beats). Same silent-strip-then-LWW
  // corruption as readerMap/tickingClock/styleGuide: a ≤v5 peer that re-sanitizes
  // a series through its characterArcs-unaware `sanitizeSeries` would drop the
  // arcs and last-writer-wins the loss back onto the newer peer. Bump makes the
  // older peer reject the ahead-version series transfer instead. Per-category
  // gate → only series sync pauses with old peers.
  // v7 = `series.factCritical` + `series.factReference` added (#1588) — the
  // opt-in flag + author-supplied real-world fact reference the gated
  // `research.fact-accuracy` editorial check reconciles the prose against. Same
  // silent-strip-then-LWW corruption as styleGuide/characterArcs: a ≤v6 peer
  // that re-sanitizes a series through its factReference-unaware `sanitizeSeries`
  // would drop the reference (and reset the flag) and last-writer-wins the loss
  // back onto the newer peer. Bump makes the older peer reject the ahead-version
  // series transfer instead. Per-category gate → only series sync pauses with old peers.
  // v8 = `series.editorialCheckConfig` added (#1591) — a per-series map of
  // editorial-check config overrides ({ [checkId]: { [key]: value } }) that tune a
  // check's thresholds (e.g. comic lettering density) for one series without
  // touching the global catalog. Same silent-strip-then-LWW corruption as
  // styleGuide/characterArcs: a ≤v7 peer that re-sanitizes a series through its
  // editorialCheckConfig-unaware `sanitizeSeries` would drop the overrides and
  // last-writer-wins the loss back onto the newer peer. Bump makes the older peer
  // reject the ahead-version series transfer instead. Per-category gate → only
  // series sync pauses with old peers.
  // v9 = `series.severityWeights` + `series.blockingSeverities` added (#1616) —
  // per-series overrides of the editorial health-score severity weights (default
  // high:12/medium:5/low:1) and of which severities count as blocking for each
  // autopilot gate (arc/beatContinuity/editorial). Both default to `{}` (no
  // override → frozen defaults apply). Same silent-strip-then-LWW corruption as
  // editorialCheckConfig: a ≤v8 peer that re-sanitizes a series through its
  // severityWeights/blockingSeverities-unaware `sanitizeSeries` would drop the
  // overrides and last-writer-wins the loss back onto the newer peer. Bump makes
  // the older peer reject the ahead-version series transfer instead. Per-category
  // gate → only series sync pauses with old peers.
  // v10 = `series.arc.foreshadowing` added (#2172) — the arc-overview-emitted
  // plant → reinforce → payoff ledger the Chekhov check consumes. Same additive
  // field INSIDE the series.arc payload as readerMap (v2) / tickingClock (v3): a
  // ≤v9 peer that re-sanitizes a series through its foreshadowing-unaware
  // `sanitizeArc` would silently strip the ledger and last-writer-wins the loss
  // back onto the newer peer. Bump makes the older peer reject the ahead-version
  // series transfer instead. Per-category gate → only series sync pauses with old peers.
  // v11 = `series.styleGuide.voiceExemplars` + `series.styleGuide.voiceAntiExemplars`
  // added (#2179) — the voice exemplar / anti-exemplar "tuning fork" passages. Same
  // additive field INSIDE the federated `styleGuide` sub-object as styleGuide itself
  // (v4): a ≤v10 peer that re-sanitizes a series through its voiceExemplars-unaware
  // `sanitizeStyleGuide` would silently strip the passages and last-writer-wins the
  // loss back onto the newer peer (`preserveAbsentAdditiveFields` only restores a
  // wholly-absent `styleGuide`, not a present-but-sub-field-stripped one). Bump makes
  // the older peer reject the ahead-version series transfer instead. Per-category gate
  // → only series sync pauses with old peers.
  pipelineSeries: 11,
  // NOT bumped for the manuscript-review sibling doc now bundled on series
  // pushes/exports (`data/pipeline-series/{id}/manuscript-review.json`).
  // Unlike `readerMap` (v2), the review is NOT a field inside the series
  // record — it's a separate doc that rides a dedicated `manuscriptReview`
  // payload key, so an older peer never round-trips it through the series
  // sanitizer (no silent-strip-then-LWW-back corruption — the readerMap gate's
  // whole reason to exist). It is additive + gracefully degrading: a pre-feature
  // receiver ignores the unknown key (review just doesn't reach it) and ships
  // no review back, so the newer peer's `if (manuscriptReview)` receive guard
  // is a no-op and the local review is preserved. Bumping `pipelineSeries` here
  // would be actively harmful — it would 412-reject the ENTIRE series push
  // (record + issues) to every not-yet-upgraded peer over an OPTIONAL doc that
  // degrades fine. Registering a brand-new gated category would hit the same
  // whole-payload footgun documented for `videoHistory` below. So manuscript-
  // review is intentionally UNGATED today (all peers ship review-doc shape v1).
  // The FIRST incompatible review-doc shape change (manuscriptReview.js
  // SCHEMA_VERSION 1→2, where an older peer's sanitizer would strip a field and
  // LWW it back) MUST introduce a gate then — mirroring the catalog
  // payloadSchemaVersion lockstep note below.
  // ALSO not bumped for the reverse-outline sibling doc (#1348), bundled on
  // series pushes/exports as `data/pipeline-series/{id}/reverse-outline.json`
  // via a dedicated `reverseOutline` payload key. Identical reasoning to the
  // manuscript-review note above: it's a separate doc (not a series field), so
  // an older peer never round-trips it through `sanitizeSeries`; it's additive +
  // gracefully degrading (a pre-#1348 receiver ignores the unknown key and ships
  // none back, so the newer peer's `if (reverseOutline)` receive guard is a
  // no-op and the local outline is preserved); and the sender's legacy-strip
  // retry drops the key so the record/issues still land. Whole-doc LWW on
  // `generatedAt` means there's no per-field strip-then-LWW-back corruption to
  // gate against. The FIRST incompatible outline-doc shape change (reverseOutline.js
  // SCHEMA_VERSION 1→2) MUST introduce a gate then, same as the review above.
  mediaCollections: 1,
  // v1 = author personas (PostgreSQL `authors` table) federated via the
  // per-record peer-sync push pipeline (record kind `author`, sync category
  // `authors`). A brand-NEW synced record type like `storyBuilder` below, so it
  // gets its own per-category gate: a v1 sender pushing to a ≤v0 (pre-feature)
  // receiver is sender-ahead on `authors` and gets a 412 (the older peer's
  // `sanitizeAuthor` would silently strip any future field and LWW it back) —
  // only the authors category pauses; every other category keeps flowing
  // (per-category gate via scopeVersionDiff). A v1 receiver still accepts a ≤v0
  // sender (sender-behind): pre-feature peers never push an `author` record at
  // all, so there's nothing to gate. The FIRST incompatible author-shape change
  // MUST bump this to 2 then (where a v1 peer would round-trip the new shape
  // through an unaware sanitizer).
  authors: 1,
  // v1 = music artists/albums/tracks (PostgreSQL `artists`, `albums`, and
  // `tracks` tables) federated via the per-record peer-sync push pipeline.
  // Each kind gets its own category gate so an older peer can reject only the
  // music record type it cannot parse while unrelated categories keep flowing.
  artists: 1,
  albums: 1,
  // tracks v2 = `track.renders[]` render-history added (every generated/uploaded
  // take, so the studio shows each render as a card + can re-select an earlier
  // one). Additive + gracefully degrading, but version-gated for the same reason
  // as the universes relationshipLinks/attachments fields: a ≤v1 peer that
  // receives and re-sanitizes a track through its renders-unaware `sanitizeTrack`
  // would silently strip the history (keeping only the active pointer) and
  // last-writer-wins the loss back onto the newer peer. Bumping makes the older
  // peer reject the ahead-version track transfer instead. Per-category gate →
  // only track sync pauses with old peers; artists/albums keep flowing. The
  // backfill itself needs no migration — `sanitizeTrack` synthesizes a render
  // from the legacy active pointer on read (see services/tracks/logic.js).
  tracks: 2,
  // v1 = creative ingredients catalog (Postgres tables: catalog_scraps,
  // catalog_ingredients, catalog_ingredient_sources, catalog_ingredient_refs).
  // v2 = `catalog_ingredients.search_tsv` expanded to also index the
  // character canon fields (physicalDescription, personality) and the
  // type-specific role/motivations/significance fields, so bible-promoted
  // characters become searchable on their main narrative text. The schema
  // is a DROP+re-ADD of the STORED generated column (Postgres can't ALTER
  // its expression); applied in lockstep by `ensureSchema`.
  // v3 = `catalog_ingredient_refs` gained `deleted`/`deleted_at` soft-delete
  // tombstones + an UPDATE trigger that bumps sync_sequence on delete/revive.
  // Older peers (≤v2) hard-DELETE on unlink and never tombstone, so the
  // version gate prevents a v3 receiver from accepting an older sender's
  // payload that would silently miss tombstones.
  //
  // Per-category gate so a new peer can sync its catalog independently of
  // whether other categories are version-locked. Older peers are
  // sender-behind on `catalog` (not ahead), so the receiver still accepts
  // their pushes; newer peers pushing to older receivers are sender-ahead
  // and get 412. `cat-ingredient` and `cat-scrap` record kinds map back
  // here via RECORD_KIND_SCHEMA_CATEGORIES.
  //
  // NOT bumped for the per-record `payload.schemaVersion` stamp added by
  // catalog-payload-schemaversion: that key is additive JSONB that both old
  // and new peers store verbatim (`upsertIngredientFromPeer` writes payload
  // as-is — no sanitizer strips it), and all types are payload-v1 today so no
  // shape actually changed on the wire. The FIRST type that bumps its
  // registry `payloadSchemaVersion` to 2 with a genuine shape change (a peer
  // ≤ that version would round-trip the new shape through an unaware
  // sanitizer) MUST bump `catalog` here in lockstep.
  //
  // v4 = `catalog_ingredient_relations` table (ingredient↔ingredient edges)
  // + a new `relations: [...]` block in the catalog sync envelope. An older
  // (≤v3) receiver doesn't understand the relations block, so a v4 sender
  // pushing to it is sender-ahead on `catalog` and gets a 412 — correct,
  // since the older peer would silently drop every relation edge. v4 receivers
  // still accept ≤v3 senders (sender-behind): those envelopes simply carry no
  // `relations` block and the receiver applies the other four kinds as before.
  // v5 = `catalog_tags` first-class table (id, label, description?, color?,
  // parent_id?, created_at, sync_sequence) + a new `tags: [...]` block in the
  // catalog sync envelope. Same gating rationale as v4: a ≤v4 receiver doesn't
  // understand the `tags` block, so a v5 sender pushing to it is sender-ahead
  // and gets a 412 (otherwise the older peer would silently drop every canonical
  // tag row + its parent hierarchy). The freeform `catalog_ingredients.tags
  // TEXT[]` column is unchanged — canonical tag rows are an additive index, so
  // a v5 receiver still accepts ≤v4 ingredient/scrap/ref/relation pushes; those
  // envelopes simply carry no `tags` block.
  // v6 = `catalog_ingredient_media` join table (typed image/audio/video/doc
  // attachments) + a new `media: [...]` block in the catalog sync envelope.
  // Each media row ships a `media_key` REFERENCE into the receiver's own media
  // library (data/images + history.jsonl sidecar) — never the bytes. Same
  // gating rationale as v4/v5: a ≤v5 receiver doesn't understand the `media`
  // block, so a v6 sender pushing to it is sender-ahead on `catalog` and gets
  // a 412 (otherwise the older peer would silently drop every attachment). A v6
  // receiver still accepts ≤v5 senders (sender-behind); those envelopes carry
  // no `media` block. Media keys that don't resolve against the receiver's own
  // library surface via the metadata-missing integrity endpoint rather than
  // failing the apply.
  // v7 = `catalog_scraps` gained `chunk_index` + `parent_scrap_id` (a long paste
  // chunks into a parent + N child rows; the extractor unions per-child drafts).
  // Both fields ride the scrap sync envelope. Same gating rationale as v4–v6: a
  // ≤v6 receiver doesn't understand child scrap rows, so a v7 sender pushing to
  // it is sender-ahead and gets a 412. A v7 receiver still accepts ≤v6 senders
  // (their scraps carry no chunk fields → chunkIndex 0 / parentScrapId null).
  // v8 = user-defined ingredient types. The definitions are persisted in the
  // catalogUserTypes store (`catalog_user_types` as of #1001; settings.json
  // `catalogUserTypes` before that — the move did NOT bump this version because
  // the wire shape is storage-independent), merge into the active type registry
  // at boot/runtime, and ride a new additive `catalogTypes: [...]` block in the
  // catalog sync envelope (LWW-merged into the receiver's own user-type store).
  // Same gating rationale as v4–v7: a ≤v7 receiver doesn't understand the
  // `catalogTypes` block, so a v8 sender pushing to it is sender-ahead and gets
  // a 412 (otherwise the older peer would silently drop every user-type
  // definition, then reject every ingredient row carrying one of those unknown
  // types). A v8 receiver still accepts ≤v7 senders (sender-behind); their
  // envelopes carry no `catalogTypes` block and the receiver applies the other
  // kinds as before.
  catalog: 8,
  // v1 = cross-machine resumable Story Builder sessions (#730). Sessions are
  // local-only by default and excluded from sync; only `sync: true` sessions
  // ride the `storyBuilder` snapshot category. This is a brand-NEW synced
  // record type (not a sibling doc on an existing bundle), so it gets its own
  // per-category gate: a sender ahead on `storyBuilder` would push a session
  // shape an older receiver's `sanitizeSession` would silently strip and then
  // LWW back, so a v1 sender pushing to a ≤v0 (pre-feature) receiver is
  // sender-ahead on `storyBuilder` and gets a 412 — only the storyBuilder
  // category pauses; every other category keeps flowing (per-category gate via
  // scopeVersionDiff). A v1 receiver still accepts a ≤v0 sender (sender-behind):
  // pre-feature peers never send a `storyBuilder` snapshot at all, so there's
  // nothing to gate. The FIRST incompatible session-shape change MUST bump this
  // to 2 then (where a v1 peer would round-trip the new shape through an
  // unaware sanitizer).
  storyBuilder: 1,
  // v1 = Creative Director projects (PostgreSQL `creative_director_projects`)
  // federated via the per-record peer-sync push pipeline (record kind
  // `creativeDirectorProject`, sync category `creativeDirectorProjects`, #1564).
  // A brand-NEW synced record type like `authors`/`storyBuilder`, so it gets its
  // own per-category gate: a v1 sender pushing to a ≤v0 (pre-feature) receiver is
  // sender-ahead on `creativeDirectorProjects` and gets a 412 — only that
  // category pauses; every other keeps flowing (per-category gate via
  // scopeVersionDiff). A v1 receiver still accepts a ≤v0 sender (sender-behind):
  // pre-feature peers never push a `creativeDirectorProject` at all, so there's
  // nothing to gate. The FIRST incompatible project-shape change MUST bump this
  // to 2 then (where a v1 peer would round-trip the new shape through an unaware
  // sanitizer). The project body is LWW-overwritten whole; scene video renders
  // ride the project's linked media collection (federated separately).
  creativeDirectorProjects: 1,
  // v1 = Mood boards (PostgreSQL `mood_boards`) federated via the per-record
  // peer-sync push pipeline (record kind `moodBoard`, sync category `moodBoards`,
  // #1564). Same posture as `creativeDirectorProjects` above: a brand-NEW synced
  // record type with its own per-category gate — a v1 sender pushing to a ≤v0
  // (pre-feature) receiver is sender-ahead on `moodBoards` and gets a 412 (only
  // that category pauses); a v1 receiver still accepts a ≤v0 sender (pre-feature
  // peers never push a `moodBoard`). The FIRST incompatible board-shape change
  // MUST bump this to 2 then. The board body (name/description/items) is
  // LWW-overwritten whole; referenced image bytes ride the asset manifest.
  moodBoards: 1,
  // v1 = Writers Room works (PostgreSQL `writers_room_works` + decomposed
  // `writers_room_draft_versions`) federated via the per-record peer-sync push
  // pipeline (record kind `writersRoomWork`, sync category `writersRoomWorks`,
  // #1565). Same posture as `creativeDirectorProjects`/`moodBoards`: a brand-NEW
  // synced record type with its own per-category gate — a v1 sender pushing to a
  // ≤v0 (pre-feature) receiver is sender-ahead on `writersRoomWorks` and gets a
  // 412 (only that category pauses); a v1 receiver still accepts a ≤v0 sender
  // (pre-feature peers never push a `writersRoomWork`). The FIRST incompatible
  // work-shape change MUST bump this to 2 then. The work manifest (metadata +
  // decomposed draft-version metadata in drafts[]) is LWW-overwritten whole; the
  // file-primary `.md` draft prose bodies ride a separate body manifest (SHA256
  // diff + receiver-pull), never round-tripped through the record.
  writersRoomWorks: 1,
  // v1 = Writers Room folders (PostgreSQL `writers_room_folders`) federated via
  // the per-record peer-sync push pipeline (record kind `writersRoomFolder`,
  // #1645 — follow-up to #1565). Same posture as `writersRoomWorks`: a brand-NEW
  // synced record type with its own per-category gate, so a v1 sender pushing to
  // a ≤v0 (pre-feature) receiver is sender-ahead on `writersRoomFolders` and gets
  // a 412 (only that category pauses); a v1 receiver still accepts a ≤v0 sender.
  // Folders are body-less (no file-primary `.md`, no asset manifest) and
  // LWW-overwritten whole. The FIRST incompatible folder-shape change MUST bump
  // this to 2. Federating folders requires the soft-delete tombstone columns
  // (deleted/deleted_at) added in the same change — the LWW merge never
  // propagates a hard delete.
  writersRoomFolders: 1,
  // v1 = Writers Room exercises (PostgreSQL `writers_room_exercises`) federated
  // via the per-record peer-sync push pipeline (record kind `writersRoomExercise`,
  // #1645). Body-less + LWW-overwritten whole, same per-category gate semantics as
  // `writersRoomFolders`. Exercises predate federation and carry no
  // `updatedAt`/`createdAt` — the wire sanitizer derives a stable LWW key from
  // their existing `startedAt`/`finishedAt` (see sanitizeExerciseForSync). The
  // FIRST incompatible exercise-shape change MUST bump this to 2.
  writersRoomExercises: 1,
  // v1 = Music Video projects (PostgreSQL `music_video_projects`) federated via
  // the per-record peer-sync push pipeline (record kind `musicVideoProject`, sync
  // category `musicVideoProjects`, #1770 — follow-up to #1760 Phase 1). Same
  // posture as `creativeDirectorProjects`/`writersRoomFolders`: a brand-NEW synced
  // record type with its own per-category gate — a v1 sender pushing to a ≤v0
  // (pre-feature) receiver is sender-ahead on `musicVideoProjects` and gets a 412
  // (only that category pauses); a v1 receiver still accepts a ≤v0 sender
  // (pre-feature peers never push a `musicVideoProject`). The project body
  // (metadata + beat-aligned scenes) is LWW-overwritten whole; referenced media
  // (uploaded audio, scene images/rendered videos) is NOT bundled in this phase —
  // it federates via its own channels / a follow-up. The FIRST incompatible
  // project-shape change MUST bump this to 2.
  musicVideoProjects: 1,
  // v1 = standalone media-library federation (#1566). NOT a record kind — it's
  // the wire contract for the library-level asset manifest a full-sync peer
  // advertises at GET /api/peer-sync/library-manifest. The receiver-pull sweep
  // (syncMediaLibraryFromPeer) reads the sender's advertised `schemaVersion` and
  // GENTLY SKIPS (logs, no reject) a sender ahead of its local `mediaLibrary` —
  // unlike the push gate's hard 412, because a library sweep is best-effort
  // background convergence, not an authoritative record transfer. The asset
  // BYTES themselves are version-agnostic (an image is an image); only the
  // MANIFEST envelope shape is gated, so the FIRST incompatible manifest-shape
  // change (new required field, kind semantics) MUST bump this to 2. Adding a
  // new media KIND to the manifest is additive — the receiver ignores kinds it
  // can't route (directoryForAssetKind returns null) — and does NOT require a
  // bump on its own.
  mediaLibrary: 1,
  // v1 = completed-agent CoS history federation (#1650, part of epic #1561). NOT
  // a record kind — it's the wire contract for the archive manifest a full-sync
  // peer advertises at GET /api/peer-sync/cos-history-manifest. The receiver-pull
  // sweep (syncCosHistoryFromPeer) reads the sender's advertised `schemaVersion`
  // and GENTLY SKIPS (logs, no reject) a sender ahead of its local `cosHistory` —
  // same posture as `mediaLibrary` above, because a history sweep is best-effort
  // background convergence, not an authoritative record transfer. The archive
  // BYTES (metadata.json / output.txt / prompt.txt) are version-agnostic; only
  // the MANIFEST envelope shape is gated, so the FIRST incompatible
  // manifest-shape change (new required entry field, segment semantics) MUST bump
  // this to 2.
  cosHistory: 1,
  // v1 = live CoS task-list + claim-metadata federation (#1712, second half of
  // #1650, part of epic #1561). NOT a record kind — it's the wire contract for
  // the task payload a full-sync peer advertises at GET /api/peer-sync/cos-tasks.
  // Unlike the immutable, append-only `cosHistory` archives (pure byte
  // replication), the task files (data/COS-TASKS.md / data/TASKS.md) are mutated
  // live by BOTH peers and carry `claimedBy`/`claimedAt`/`leaseExpiresAt` (#1563),
  // so they ride a claim-aware per-task LWW merge (syncCosTasksFromPeer →
  // cosTaskStore.mergePeerTasks), not the asset path. The receiver reads the
  // sender's advertised `schemaVersion` and GENTLY SKIPS (logs, no reject) a
  // sender ahead of its local `cosTasks` — same posture as `mediaLibrary` /
  // `cosHistory`, because a task sweep is best-effort background convergence, not
  // an authoritative record transfer. Only the payload envelope + task-entry
  // shape is gated; the FIRST incompatible change (new required entry field, new
  // claim semantics) MUST bump this to 2.
  cosTasks: 1,
  // NOTE: `videoHistory` is intentionally NOT listed here. The version gate
  // rejects the ENTIRE snapshot/push payload on ANY ahead-mismatch (the
  // comparator walks the union of keys), so declaring a brand-new key would
  // make every not-yet-upgraded peer reject ALL categories (universe,
  // pipeline, …) — severing sync across a federation that upgrades on
  // independent schedules. videoHistory is a flat append-only array merged by
  // id with LWW-on-createdAt; the merge already tolerates unknown/extra rows,
  // so it does not need whole-payload gating. An older peer that lacks the
  // `videoHistory` route simply rejects that one category request and keeps
  // syncing everything else.
  //
  // The gate is now PER-CATEGORY (see `scopeVersionDiff` below + its three
  // call sites: dataSync `applyRemote`, peerSync push, sharing importer), so
  // adding a new key here or bumping one category only gates transfers of
  // THAT category — unrelated categories keep flowing. videoHistory stays
  // unlisted because it has no versioned storage layout at all, not because
  // of the old whole-payload footgun.
});

/**
 * Map a federated record KIND (the unit a peer push or share manifest moves)
 * to the `PORTOS_SCHEMA_VERSIONS` categories its storage layout touches. The
 * per-category gate uses this to block a transfer ONLY when the sender is
 * ahead on a category that record actually writes.
 *
 * Kinds absent from this map carry no versioned storage layout and are never
 * gated — media-job records (flat re-render metadata), media-annotations,
 * goals/character/digitalTwin/meatspace, videoHistory, etc. A `series` push
 * that bundles issues, or a universe/series push that bundles a linked media
 * collection, unions the additional kinds' categories at the call site.
 */
export const RECORD_KIND_SCHEMA_CATEGORIES = Object.freeze({
  universe: Object.freeze(['universes']),
  series: Object.freeze(['pipelineSeries']),
  issue: Object.freeze(['pipelineIssues']),
  mediaCollection: Object.freeze(['mediaCollections']),
  author: Object.freeze(['authors']),
  artist: Object.freeze(['artists']),
  album: Object.freeze(['albums']),
  track: Object.freeze(['tracks']),
  'cat-ingredient': Object.freeze(['catalog']),
  'cat-scrap': Object.freeze(['catalog']),
  storyBuilder: Object.freeze(['storyBuilder']),
  creativeDirectorProject: Object.freeze(['creativeDirectorProjects']),
  moodBoard: Object.freeze(['moodBoards']),
  writersRoomWork: Object.freeze(['writersRoomWorks']),
  writersRoomFolder: Object.freeze(['writersRoomFolders']),
  writersRoomExercise: Object.freeze(['writersRoomExercises']),
  musicVideoProject: Object.freeze(['musicVideoProjects']),
});

/**
 * Schema-version categories that are versioned but NOT reachable from a record
 * push — they ride their OWN transport with their OWN compatibility gate, not the
 * per-record push gate that `RECORD_KIND_SCHEMA_CATEGORIES` drives. Listing one
 * here is the explicit, reviewed way to say "this version is gated elsewhere, so
 * the gate-map-completeness guard should not require a record-kind mapping."
 *
 * - `mediaLibrary` (#1566): the standalone media-library manifest a full-sync
 *   peer advertises at GET /api/peer-sync/library-manifest. The RECEIVER pulls
 *   it and GENTLY SKIPS a sender ahead of its local version (see
 *   syncMediaLibraryFromPeer) — there is no push to gate, so it has no entry in
 *   RECORD_KIND_SCHEMA_CATEGORIES by design.
 * - `cosHistory` (#1650): the completed-agent CoS history archive manifest a
 *   full-sync peer advertises at GET /api/peer-sync/cos-history-manifest. Same
 *   receiver-pull shape as `mediaLibrary` (see syncCosHistoryFromPeer) — no push
 *   to gate, so no RECORD_KIND_SCHEMA_CATEGORIES entry.
 * - `cosTasks` (#1712): the live CoS task-list + claim-metadata payload a
 *   full-sync peer advertises at GET /api/peer-sync/cos-tasks. Receiver-pull +
 *   claim-aware per-task merge (see syncCosTasksFromPeer) — no push to gate, so
 *   no RECORD_KIND_SCHEMA_CATEGORIES entry.
 *
 * Do NOT add a real record-push category here to silence the guard — that would
 * leave its push transfers ungated (silent cross-install corruption). Only
 * genuinely non-push categories belong.
 */
export const NON_RECORD_SCHEMA_CATEGORIES = Object.freeze(new Set(['mediaLibrary', 'cosHistory', 'cosTasks']));

/**
 * Lazy-read the current PortOS version from the ROOT package.json so a
 * pull-and-restart picks it up without a process-relative cache.
 *
 * Tested-without-files fallback: when PATHS.root is mutated for a test to
 * a directory without package.json, return '0.0.0' instead of throwing.
 * Mirrors `getCurrentVersion` in `server/services/updateChecker.js`.
 */
export async function getPortosVersion() {
  const pkgPath = join(PATHS.root, 'package.json');
  const raw = await tryReadFile(pkgPath);
  if (!raw) return '0.0.0';
  const parsed = safeJSONParse(raw, null);
  return typeof parsed?.version === 'string' && parsed.version ? parsed.version : '0.0.0';
}

/**
 * Build the `portosMeta` envelope that every outbound sync payload carries
 * at the top level. Receivers feed `meta.schemaVersions` into
 * `compareSchemaVersions(sender, PORTOS_SCHEMA_VERSIONS)` to decide whether
 * to apply the payload.
 *
 *   {
 *     "portosMeta": {
 *       "portosVersion": "2.7.0",
 *       "schemaVersions": { "universes": 5 }
 *     }
 *   }
 *
 * `portosVersion` is informational — for UI surfacing only. The gate logic
 * runs on `schemaVersions` because the on-disk shape is what matters; the
 * PortOS version is just a friendly label users recognize.
 */
export async function buildPortosMeta(overrides = {}) {
  const portosVersion = await getPortosVersion();
  return {
    portosVersion,
    schemaVersions: { ...PORTOS_SCHEMA_VERSIONS, ...(overrides.schemaVersions || {}) },
  };
}

/**
 * Compare a peer's schemaVersions against the local code's expectations.
 *
 * Returns a structured diff so callers (push-rejection, UI surfacing) can
 * tell users WHICH category is mismatched and in which direction.
 *
 *   ahead[]  — categories where the SENDER has a newer schema than the
 *              RECEIVER. The receiver can't safely apply the payload; reject.
 *   behind[] — categories where the SENDER is older than the receiver. The
 *              sanitizer can usually backfill, but some forward-only
 *              contracts may still require the sender to upgrade. Callers
 *              decide whether to gate.
 *
 *   compatible — `true` only when neither list has entries.
 *
 * Absent or zero entries on either side are treated as "no contract" — the
 * comparator skips them. So legacy peers that don't send `portosMeta` at
 * all simply pass through (treat their schemaVersions as `{}` → no
 * `ahead` entries → compatible).
 */
export function compareSchemaVersions(senderVersions = {}, receiverVersions = PORTOS_SCHEMA_VERSIONS) {
  const sender = senderVersions && typeof senderVersions === 'object' ? senderVersions : {};
  const receiver = receiverVersions && typeof receiverVersions === 'object' ? receiverVersions : {};
  const ahead = [];
  const behind = [];
  // Walk the UNION of keys so we catch (a) sender has a category receiver
  // doesn't know (sender ahead), AND (b) receiver requires a category the
  // sender doesn't carry (sender behind on that category).
  const keys = new Set([
    ...Object.keys(sender),
    ...Object.keys(receiver),
  ]);
  for (const cat of keys) {
    const senderV = Number.isInteger(sender[cat]) ? sender[cat] : 0;
    const receiverV = Number.isInteger(receiver[cat]) ? receiver[cat] : 0;
    if (senderV === 0 && receiverV === 0) continue;          // no contract on either side
    if (senderV === receiverV) continue;                      // exact match
    if (senderV > receiverV) ahead.push({ category: cat, senderV, receiverV });
    else behind.push({ category: cat, senderV, receiverV });
  }
  return { ahead, behind, compatible: ahead.length === 0 && behind.length === 0 };
}

/**
 * Restrict a comparator result to the categories actually being transferred.
 *
 * `compareSchemaVersions` walks the UNION of every known category so the full
 * diff stays useful for diagnostics/UI. But the GATE decision must be
 * per-category: a sender that bumped (or added) one category should only be
 * blocked for transfers of THAT category — not for unrelated categories that
 * happen to ride a federation upgrading on independent schedules. Pass the
 * schema-version keys this transfer actually moves; categories outside the
 * set are dropped from `ahead`/`behind` so they can't block (and the scoped
 * `ahead` is what callers report, so a "pipeline" snapshot rejection never
 * mis-attributes a `universes` gap).
 *
 * `categories` non-array (null/undefined) → returns the diff unchanged
 * (whole-payload gate; the comparator's union result is used as-is). An empty
 * array → nothing can block (the transfer touches no versioned category).
 */
export function scopeVersionDiff(diff = {}, categories) {
  if (!Array.isArray(categories)) return diff;
  const allow = new Set(categories);
  const ahead = (Array.isArray(diff.ahead) ? diff.ahead : []).filter((g) => allow.has(g.category));
  const behind = (Array.isArray(diff.behind) ? diff.behind : []).filter((g) => allow.has(g.category));
  return { ahead, behind, compatible: ahead.length === 0 && behind.length === 0 };
}

/**
 * Human-readable explanation of a comparator result. Used both for log lines
 * and for the UI badge tooltip. Keeps the wording in one place so a peer-
 * sync 409 message, the Instances UI, and the share-bucket panel all
 * describe the gap identically.
 *
 *   formatVersionGap({ ahead: [{ category: 'universes', senderV: 5, receiverV: 4 }] })
 *     → 'sender ahead of receiver on universes (v5 vs v4)'
 */
export function formatVersionGap({ ahead = [], behind = [] } = {}) {
  const parts = [];
  if (ahead.length) {
    parts.push(`sender ahead of receiver on ${ahead.map((g) => `${g.category} (v${g.senderV} vs v${g.receiverV})`).join(', ')}`);
  }
  if (behind.length) {
    parts.push(`sender behind receiver on ${behind.map((g) => `${g.category} (v${g.senderV} vs v${g.receiverV})`).join(', ')}`);
  }
  return parts.join('; ') || 'compatible';
}
