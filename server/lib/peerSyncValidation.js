/**
 * Zod schemas for federated peer-sync wire payloads: push, subscribe, sync-now, pull-metadata and
 * library manifest, plus tombstone request header constants.
 *
 * Federated peer-sync wire/request schemas (push payload, subscribe, sync-now, pull-metadata, the
 * library manifest with its optional image `tombstones` and the `PEER_LIBRARY_TOMBSTONES_HEADER` that
 * requests them plus the `PEER_LIBRARY_TOMBSTONES_SINCE_HEADER` cursor).
 */

import { z } from 'zod';
import { catalogSyncIngredientSchema, catalogSyncRefSchema } from './catalog/catalogValidation.js';
import { TASK_STATUS_VALUES, TASK_PRIORITY_VALUES } from './taskParser.js';
import { peerSyncTombstoneSchema } from './peerSyncEventSchema.js';
import { MEDIA_COLLECTION_ITEMS_MAX } from './mediaItemKey.js';

// Wire/request schemas for federated peer-to-peer record sync (see server/services/sharing/peerSync.js).

// Subscribe a record (universe / series) to a federated peer for live push (the destination is another PortOS
// instance over Tailnet, unlike share-bucket subscriptions).
export const peerSubscribeSchema = z.object({
  peerId: z.string().trim().min(1).max(120),
  recordKind: z.enum(['universe', 'series', 'mediaCollection', 'author', 'artist', 'album', 'track', 'creativeDirectorProject', 'moodBoard', 'fableLoom', 'writersRoomWork', 'writersRoomFolder', 'writersRoomExercise', 'musicVideoProject', 'commissionFeedback', 'creativeCommission', 'deck', 'storyboard']),
  recordId: z.string().trim().min(1).max(120),
}).strict();

// Asset manifest entry the receiver gets in a push payload. Filename gets a
// second-pass scrub against path separators inside the service layer; this
// schema just constrains shape + caps so a malformed manifest doesn't bypass
// validation entirely. SHA-256 is hex-64 when present.
//
// Discriminated on `kind` because `sidecarSha256` (the gen-params sidecar hash)
// is ONLY meaningful for images — image-ref/video entries carry no sidecar, so
// `.strict()` on the non-image branch rejects a stray `sidecarSha256` instead
// of silently accepting a malformed sender payload.
const hex64 = z.string().regex(/^[a-f0-9]{64}$/i);
const peerAssetManifestEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    filename: z.string().trim().min(1).max(255),
    kind: z.literal('image'),
    sha256: hex64.optional(),
    sidecarSha256: hex64.optional(),
    // When this copy was made: only in a library manifest sent to a receiver
    // that asked for tombstones (an older receiver's strict schema refuses it).
    createdAt: z.string().max(64).optional(),
  }).strict(),
  z.object({
    filename: z.string().trim().min(1).max(255),
    // `audio` joins the per-record kinds for the standalone media-library manifest; like video/music it has no
    // sidecar, so it rides the non-image branch. Per-record push never emits it; one shared entry schema.
    kind: z.enum(['image-ref', 'video', 'music', 'audio', 'model']),
    sha256: hex64.optional(),
  }).strict(),
]);

// One sanitized record on the wire. Mirrors sanitizeRecordForWire's output:
// id is required, soft-delete fields are tail-canonical, and the receiver's
// merge*FromSync paths handle everything else by shape. We don't `.strict()`
// because record shapes vary across kinds (universe vs series vs issue) and
// adding new fields shouldn't require a schema bump for every PR.
const peerWireRecordSchema = z.object({
  id: z.string().trim().min(1).max(120),
}).passthrough();

// Push payload from a sender. Modeled as a discriminated union on `kind` so
// only series payloads can carry `issues[]` — without the discrimination, an
// adversarial peer could send `kind: 'universe'` with a 100k-entry `issues`
// array and force the receiver to iterate it through `computeAckedDeletesFromPayload`
// and the sanitizers. The series branch caps issues at 1000 (well above any
// realistic series — most cap out at a few dozen) so neither branch is
// unbounded. `sourceInstanceId` is required + must be a real instance id
// (the receiver rejects "unknown" at the service layer; here we just enforce
// non-empty + length cap).
// `portosMeta` envelope: every outbound payload stamps the sender's PortOS version + schemaVersions so the
// receiver can detect a mismatch before applying. Optional so legacy peers still validate.
//
// CRITICAL: `.passthrough()`, not `.strict()`. A new `portosMeta` field would otherwise 400-reject every push
// at Zod validation BEFORE the receiver's schema-version gate runs (no `blockedBySchema`, cooldown or
// SchemaGapBadge). Unknown fields must flow through to the gate, the real compat decision point.
const portosMetaSchema = z.object({
  portosVersion: z.string().trim().min(1).max(40).optional(),
  schemaVersions: z.record(z.string().min(1).max(60), z.number().int().min(0).max(1_000_000)).optional(),
}).passthrough().optional();
const peerSyncPushBase = {
  record: peerWireRecordSchema,
  assetManifest: z.array(peerAssetManifestEntrySchema).max(2000),
  sourceInstanceId: z.string().trim().min(1).max(120),
  portosMeta: portosMetaSchema,
};
// Optional bundled media collection so collection-only edits propagate via per-record push. ONLY valid on
// universe/series pushes: a mediaCollection push IS the collection, so accepting linkedCollection there would let
// a sender smuggle an EXTRA collection past the explicit per-record subscription; its `.strict()` rejects it.
const linkedCollectionField = { linkedCollection: peerWireRecordSchema.optional() };
// Optional bundled catalog rows (ingredients + universe->ingredient refs) so the receiver gets the enriched row
// instead of a lossy re-derivation. ONLY valid on universe pushes; series catalog refs ride their own
// catalog-sync category, so bundling them here would be a side-channel.
const catalogBundleField = {
  catalogBundle: z.object({
    ingredients: z.array(catalogSyncIngredientSchema).max(5_000).optional(),
    refs: z.array(catalogSyncRefSchema).max(20_000).optional(),
  }).strict().optional(),
};
const universePushSchema = z.object({
  kind: z.literal('universe'),
  ...peerSyncPushBase,
  ...linkedCollectionField,
  ...catalogBundleField,
}).strict();
// Optional bundled manuscript-review sibling doc (series pushes only). `.passthrough()` on the review + each
// comment (same rationale as portosMeta); `sanitizeReview` clamps/drops everything on apply. Comments bounded.
const manuscriptReviewField = {
  manuscriptReview: z.object({
    schemaVersion: z.number().int().min(0).max(1_000_000).optional(),
    comments: z.array(z.object({
      id: z.string().trim().min(1).max(120),
    }).passthrough()).max(5000),
  }).passthrough().optional(),
};
// Optional bundled reverse-outline sibling doc (series pushes only). `.passthrough()` (same rationale as
// manuscriptReview); `sanitizeSyncedOutline` clamps on apply. Arrays bounded (sanitizer caps 600 scenes / 10 plotlines).
const reverseOutlineField = {
  reverseOutline: z.object({
    schemaVersion: z.number().int().min(0).max(1_000_000).optional(),
    status: z.string().max(40).optional(),
    generatedAt: z.string().max(64).optional(),
    plotlines: z.array(z.object({}).passthrough()).max(64).optional(),
    scenes: z.array(z.object({}).passthrough()).max(2000).optional(),
  }).passthrough().optional(),
};
const seriesPushSchema = z.object({
  kind: z.literal('series'),
  ...peerSyncPushBase,
  ...linkedCollectionField,
  ...manuscriptReviewField,
  ...reverseOutlineField,
  issues: z.array(peerWireRecordSchema).max(1000).optional(),
}).strict();
const mediaCollectionPushSchema = z.object({
  kind: z.literal('mediaCollection'),
  ...peerSyncPushBase,
  assetManifest: z.array(peerAssetManifestEntrySchema).max(MEDIA_COLLECTION_ITEMS_MAX),
}).strict();
// Author personas push the bare record + headshot via the asset manifest; `.strict()` rejects smuggled bundle keys.
const authorPushSchema = z.object({
  kind: z.literal('author'),
  ...peerSyncPushBase,
}).strict();
const artistPushSchema = z.object({
  kind: z.literal('artist'),
  ...peerSyncPushBase,
}).strict();
const albumPushSchema = z.object({
  kind: z.literal('album'),
  ...peerSyncPushBase,
}).strict();
const trackPushSchema = z.object({
  kind: z.literal('track'),
  ...peerSyncPushBase,
}).strict();
// Creative Director projects push the bare record + `startingImageFile` in the asset manifest (scene renders ride
// the linked media collection); `.strict()` rejects smuggled bundle keys.
const creativeDirectorProjectPushSchema = z.object({
  kind: z.literal('creativeDirectorProject'),
  ...peerSyncPushBase,
}).strict();
// Mood boards push the bare record + local item images via the asset manifest; `.strict()` rejects bundle keys.
const moodBoardPushSchema = z.object({
  kind: z.literal('moodBoard'),
  ...peerSyncPushBase,
}).strict();
// FableLoom stories push the whole branching graph plus scene image/video
// bytes through the base asset manifest. No child records or extra bundles.
const fableLoomPushSchema = z.object({
  kind: z.literal('fableLoom'),
  ...peerSyncPushBase,
}).strict();
// Writers Room works push the bare work manifest. The `.md` prose bodies do NOT ride `assetManifest` (flat
// basename + single dir per kind); a dedicated `draftBodyManifest` of per-draft SHA-256 hashes lets the receiver
// diff + pull by nested path. workId/draftId get a second-pass `WORK_ID_RE`/`DRAFT_ID_RE` scrub in the service
// before any FS op; `.strict()` rejects smuggled bundle keys.
const peerDraftBodyManifestEntrySchema = z.object({
  kind: z.literal('writers-room-draft'),
  workId: z.string().trim().min(1).max(120),
  draftId: z.string().trim().min(1).max(120),
  sha256: hex64,
}).strict();
const draftBodyManifestField = {
  draftBodyManifest: z.array(peerDraftBodyManifestEntrySchema).max(2000).optional(),
};
const writersRoomWorkPushSchema = z.object({
  kind: z.literal('writersRoomWork'),
  ...peerSyncPushBase,
  ...draftBodyManifestField,
  bibleManifest: z.array(z.object({
    workId: z.string().trim().min(1).max(120),
    kind: z.enum(['character', 'place', 'object']),
    sha256: hex64,
    updatedAt: z.string().datetime({ offset: true }),
  }).strict()).max(3).optional(),
}).strict();
// Writers Room folders + exercises push the bare record, body-less; the sender always ships `assetManifest: []`.
const writersRoomFolderPushSchema = z.object({
  kind: z.literal('writersRoomFolder'),
  ...peerSyncPushBase,
}).strict();
const writersRoomExercisePushSchema = z.object({
  kind: z.literal('writersRoomExercise'),
  ...peerSyncPushBase,
}).strict();
// Optional bundled linked-track record: a project using `trackId` rides its master audio as a `music` entry AND
// the track RECORD here, so a peer without the Tracks category can resolve it. ONLY valid on music-video
// pushes (other kinds' `.strict()` reject it).
const linkedTrackField = { linkedTrack: peerWireRecordSchema.optional() };
// Music Video projects push the bare record; media rides the base `assetManifest`, plus the optional
// `linkedTrack` bundle above (`.strict()` rejects any OTHER bundle key).
const musicVideoProjectPushSchema = z.object({
  kind: z.literal('musicVideoProject'),
  ...peerSyncPushBase,
  ...linkedTrackField,
}).strict();
// Creative Commission feedback: body-less, no assets (`assetManifest: []`).
// Card decks push the deck with its card roster inline in `record.cards[]` (cards aren't independently
// subscribable); card art rides the base `assetManifest`.
const deckPushSchema = z.object({
  kind: z.literal('deck'),
  ...peerSyncPushBase,
}).strict();
// Storyboards push the whole board (beats → panels → takes inline); panel art
// rides the base `assetManifest` as gallery images.
const storyboardPushSchema = z.object({
  kind: z.literal('storyboard'),
  ...peerSyncPushBase,
}).strict();
const commissionFeedbackPushSchema = z.object({
  kind: z.literal('commissionFeedback'),
  ...peerSyncPushBase,
}).strict();
// Creative Commission brief (#2686) — body-less; the sender ships `assetManifest: []`.
const creativeCommissionPushSchema = z.object({
  kind: z.literal('creativeCommission'),
  ...peerSyncPushBase,
}).strict();
export const peerSyncPushSchema = z.discriminatedUnion('kind', [
  universePushSchema,
  seriesPushSchema,
  mediaCollectionPushSchema,
  authorPushSchema,
  artistPushSchema,
  albumPushSchema,
  trackPushSchema,
  creativeDirectorProjectPushSchema,
  moodBoardPushSchema,
  fableLoomPushSchema,
  writersRoomWorkPushSchema,
  writersRoomFolderPushSchema,
  writersRoomExercisePushSchema,
  musicVideoProjectPushSchema,
  commissionFeedbackPushSchema,
  creativeCommissionPushSchema,
  deckPushSchema,
  storyboardPushSchema,
]);

// Manual sync action schemas — used by POST /sync-record, /sync-now, /pull-metadata.

export const peerSyncRecordSchema = z.object({
  peerId: z.string().trim().min(1).max(120),
  recordKind: z.enum(['universe', 'series', 'mediaCollection', 'author', 'artist', 'album', 'track', 'creativeDirectorProject', 'moodBoard', 'fableLoom', 'writersRoomWork', 'writersRoomFolder', 'writersRoomExercise', 'musicVideoProject', 'commissionFeedback', 'creativeCommission', 'deck', 'storyboard']),
  recordId: z.string().trim().min(1).max(200),
}).strict();

export const peerSyncNowSchema = z.object({
  peerId: z.string().trim().min(1).max(120),
}).strict();

// Standalone media-library manifest the SENDER advertises at GET /api/peer-sync/library-manifest. A full-sync
// receiver diffs `assets` vs local disk and pulls the missing bytes. Reuses `peerAssetManifestEntrySchema`.
//
// `assets` is capped well above the per-record manifest; the sender logs + truncates beyond the cap.
// `manifestHash` lets the receiver short-circuit an unchanged library. `.strict()` rejects a malformed envelope.
export const peerLibraryManifestQuerySchema = z.object({ models: z.literal('1').optional() }).strict();

// A receiver applying gallery image tombstones sends this header; only then does the manifest carry
// `tombstones`, since an older receiver's strict schema would refuse it. A header, not a query flag, because an
// older sender's query schema is strict too.
export const PEER_LIBRARY_TOMBSTONES_HEADER = 'X-PortOS-Library-Tombstones';

// Optional ISO cursor: the newest `deletedAt` already processed; the manifest then carries only newer
// tombstones. Absent means the full list; an older sender ignores the header.
export const PEER_LIBRARY_TOMBSTONES_SINCE_HEADER = 'X-PortOS-Library-Tombstones-Since';

export const peerLibraryManifestSchema = z.object({
  schemaVersion: z.number().int().min(0).max(1_000_000),
  manifestHash: hex64,
  assets: z.array(peerAssetManifestEntrySchema).max(100_000),
  // Capped at the image tombstone store's limit (services/mediaTombstones.js).
  tombstones: z.array(peerSyncTombstoneSchema).max(5000).optional(),
}).strict();

// --- Completed-agent CoS history federation ----------------------------------
// Full-sync peers advertise date-bucketed archives at GET /api/peer-sync/cos-history-manifest. Archives live at
// data/cos/agents/<date>/<agentId>/<file> (nested paths), so each entry carries path segments, validated here AND
// re-scrubbed in the service before any FS op. Exported so the service + byte route share the allowlists.
export const COS_ARCHIVE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// agentIds are `agent-<id>` — alphanumerics, `_` and `-` only. NO dots, so a
// `..` traversal can't form, and NO slash. Capped well above any real id.
export const COS_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
// The exact set of files an archive holds (cosAgentIndex.js). A fixed enum is the
// tightest possible filename allowlist.
export const COS_ARCHIVE_FILES = Object.freeze(['metadata.json', 'output.txt', 'prompt.txt']);
const peerCosHistoryManifestEntrySchema = z.object({
  date: z.string().regex(COS_ARCHIVE_DATE_RE),
  agentId: z.string().regex(COS_AGENT_ID_RE),
  file: z.enum(['metadata.json', 'output.txt', 'prompt.txt']),
  sha256: hex64,
}).strict();
export const peerCosHistoryManifestSchema = z.object({
  schemaVersion: z.number().int().min(0).max(1_000_000),
  manifestHash: hex64,
  entries: z.array(peerCosHistoryManifestEntrySchema).max(150_000),
}).strict();

// --- Live CoS task-list + claim-metadata federation --------------------------
// Full-sync peers advertise their live backlog at GET /api/peer-sync/cos-tasks; the receiver runs a claim-aware
// per-task LWW merge (cosTaskStore.mergePeerTasks) that respects `leaseExpiresAt`, so a peer's fresh claim is
// never clobbered. Not byte replication: both peers mutate live.
//
// Each entry mirrors a stored task plus a `taskType` discriminator. `metadata` is permissive and normalized by
// the receiver's stored form (`cosTaskRows.storedForm`), so only key length + entry count are bounded. `.strict()` on the entry rejects
// extra top-level fields. `challenged` rides like any status (case + resolution live in `metadata`).
// Vocabularies come from taskParser.js: a wire value the receiver's queue cannot represent would be repaired
// on arrival, so the lists must not drift.
const peerCosTaskEntrySchema = z.object({
  id: z.string().trim().min(1).max(200),
  taskType: z.enum(['user', 'internal']),
  status: z.enum(TASK_STATUS_VALUES),
  priority: z.enum(TASK_PRIORITY_VALUES),
  description: z.string().max(20_000),
  approvalRequired: z.boolean().optional(),
  autoApproved: z.boolean().optional(),
  // `.default({})`: a sender omitting metadata yields `{}`, since the receiver's stored form does
  // Object.entries(metadata) and would throw, failing the whole merge.
  //
  // The newest-edit-wins stamp (`metadata.updatedAt`) rides here so it survives the stored form.
  metadata: z.record(z.string().min(1).max(120), z.any()).optional().default({}),
}).strict();
export const peerCosTasksSchema = z.object({
  schemaVersion: z.number().int().min(0).max(1_000_000),
  listHash: hex64,
  // Bounds merge work; the sender logs + truncates beyond its own cap (under the receiver's response byte cap).
  tasks: z.array(peerCosTaskEntrySchema).max(50_000),
}).strict();

/**
 * The Eidoverse foundation offering a peer advertises.
 *
 * Deliberately shallow on `candidates`: the real shape lives in `eidoverseFoundationCandidateSchema`
 * (lib/eidoverseFoundations.js), which the receiver runs (fingerprint, assay evidence, federation-safety scan) on
 * EVERY candidate. Re-declaring it would duplicate a contract that must not drift and drag that module into
 * this module's import closure. This schema only bounds the TRANSPORT: wrapper, capped count, objects.
 */
export const peerEidoverseFoundationsSchema = z.object({
  schemaVersion: z.number().int().min(0).max(1_000_000),
  listHash: hex64,
  // A foundation body caps at 16 KiB, so 500 envelopes stay inside the receiver's byte cap; the sender truncates at the same number.
  candidates: z.array(z.record(z.string().min(1).max(64), z.unknown())).max(500),
  // Withdrawals are declared in full: there is no second gate, and a tombstone DELETES a held record, so its
  // shape is pinned where it arrives. `.default([])` keeps a sender that omits the key parsing as "nothing to retract".
  tombstones: z.array(z.object({
    fingerprint: hex64,
    deletedAt: z.string().datetime(),
  }).strict()).max(500).default([]),
}).strict();

export const peerPullMetadataSchema = z.object({
  // Backfill tries every online peer; no per-peer scoping field today.
  // .trim() so a stray-whitespace filename normalizes instead of passing validation then failing disk lookup.
  filenames: z.array(z.string().trim().min(1).max(300)).max(5000),
}).strict();

// Query strings of the GET peer-sync routes. Scalar strings only; the handlers trim and match them
// against their own allow-lists, and unknown keys are stripped so peers on other versions keep working (#16428).
const peerQueryScalar = z.string().optional();
// A repeated or nested key is dropped, not refused: GET /subscriptions has always treated a non-string filter as absent.
const lenientPeerQueryScalar = peerQueryScalar.catch(undefined);
export const peerSubscriptionsQuerySchema = z.object({ peerId: lenientPeerQueryScalar, recordKind: lenientPeerQueryScalar, recordId: lenientPeerQueryScalar });
export const peerManifestQuerySchema = z.object({ kind: peerQueryScalar });
export const peerCosAgentArchiveQuerySchema = z.object({ date: peerQueryScalar, agentId: peerQueryScalar, file: peerQueryScalar });
export const peerRecordQuerySchema = z.object({ kind: peerQueryScalar, id: peerQueryScalar, collectionIntegrity: z.literal('1').optional() });
export const peerIntegrityQuerySchema = z.object({ peerId: peerQueryScalar, kind: peerQueryScalar, recordId: peerQueryScalar });
// A collection can hold more items than the push endpoint accepts in one
// request. The read-only diagnostic bounds the response by bytes instead.
export const peerCollectionIntegrityPayloadSchema = z.object({
  kind: z.literal('mediaCollection'),
  sourceInstanceId: z.string(),
  record: peerWireRecordSchema,
  assetManifest: z.array(peerAssetManifestEntrySchema),
  videoFilenames: z.record(z.string().max(255), z.string().max(255)).optional(),
  // `<kind>:<filename>` → peers the responder streams that file from (host
  // mode). Optional: older peers omit it and every gap stays a difference.
  hostedBy: z.record(z.string().max(270), z.array(z.string().max(128)).max(16)).optional(),
});
