import { z } from 'zod';
import { catalogSyncIngredientSchema, catalogSyncRefSchema } from './catalogValidation.js';

// =============================================================================
// PEER SYNC SCHEMAS
// =============================================================================
// Wire/request schemas for federated peer-to-peer record sync (see
// server/services/sharing/peerSync.js). Split out of validation.js
// (issue #1151); validation.js re-exports everything here so existing deep
// imports keep working.

// Subscribe a record (universe / series) to a federated peer for live push.
// Sibling of share-bucket subscriptionCreateSchema; the difference is the
// destination — share-bucket subscriptions hit a cloud-synced folder, peer
// subscriptions target another PortOS instance over Tailnet.
export const peerSubscribeSchema = z.object({
  peerId: z.string().trim().min(1).max(120),
  recordKind: z.enum(['universe', 'series', 'mediaCollection', 'author', 'artist', 'album', 'track', 'creativeDirectorProject', 'moodBoard', 'writersRoomWork', 'writersRoomFolder', 'writersRoomExercise', 'musicVideoProject', 'commissionFeedback']),
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
  }).strict(),
  z.object({
    filename: z.string().trim().min(1).max(255),
    // `audio` (#1566) joins the per-record kinds (image-ref/video/music) for the
    // standalone media-library manifest. Like video/music it carries no gen-params
    // sidecar, so it rides the non-image branch (`.strict()` rejects a stray
    // sidecarSha256). The per-record push pipeline never emits `audio`; accepting
    // it here is harmless and keeps one shared entry schema across both manifests.
    kind: z.enum(['image-ref', 'video', 'music', 'audio']),
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
// `portosMeta` envelope — every outbound payload built by `buildPushPayload`
// stamps the sender's PortOS version + schemaVersions map so the receiver
// can detect a version mismatch before applying the record. Optional on
// the wire so legacy peers (no portosMeta) still validate; the receiver's
// version-gate treats absent meta as "no contract" and falls through to
// the existing merge path.
//
// CRITICAL: uses `.passthrough()` (not `.strict()`). The whole point of
// the envelope is to enable graceful version negotiation. If a future
// PortOS adds a new field to `portosMeta` (e.g. `clientName`,
// `capabilities`, `regionCode`), `.strict()` would 400-reject every push
// from that version at Zod validation BEFORE the receiver's schema-version
// gate runs — surfacing as a generic 400 with no `blockedBySchema`
// persistence, no cooldown, no SchemaGapBadge surfacing. `.passthrough()`
// lets unknown fields flow through to the gate, which is the actual
// compat decision point.
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
// Optional bundled media collection — Stage 5 media-collections sync attaches
// the universe / series's linked collection so collection-only edits propagate
// via the per-record push pipeline. Same shape as a record on the wire (id
// required, sanitizer handles the rest). ONLY valid on universe/series pushes:
// a mediaCollection push IS the collection, so accepting linkedCollection there
// would let a sender smuggle an arbitrary EXTRA collection that the receiver's
// applyIncomingPush merges — a side-channel to overwrite collections outside the
// explicit per-record subscription. The mediaCollection branch's .strict()
// therefore rejects it. See peerSync.js buildPushPayload (never sets it for the
// mediaCollection kind) and applyIncomingPush.
const linkedCollectionField = { linkedCollection: peerWireRecordSchema.optional() };
// Optional bundled catalog rows — a universe push carries the catalog
// ingredients + universe→ingredient ref links referenced by its embedded
// canon, so the receiver gets the enriched catalog row (tags, embedding,
// payload.summary) instead of re-deriving a lossy view. Same wire shapes as
// the direct catalog-sync envelope. ONLY valid on universe pushes (series /
// mediaCollection .strict() reject it) — series catalog refs ride their own
// catalog-sync category; smuggling them here would be a side-channel.
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
// Optional bundled manuscript-review sibling doc — a series push carries the
// "Finish the draft" comment set (data/pipeline-series/{id}/manuscript-review.json)
// so review-only edits propagate via the per-record push pipeline. ONLY valid on
// series pushes. `.passthrough()` on the review + each comment (same rationale as
// portosMeta) so a newer sender that adds a comment field doesn't 400 at this
// receiver BEFORE its merge — `sanitizeReview` clamps/drops everything on apply.
// Comments are bounded (5000) so the array can't be used to force unbounded work.
const manuscriptReviewField = {
  manuscriptReview: z.object({
    schemaVersion: z.number().int().min(0).max(1_000_000).optional(),
    comments: z.array(z.object({
      id: z.string().trim().min(1).max(120),
    }).passthrough()).max(5000),
  }).passthrough().optional(),
};
// Optional bundled reverse-outline sibling doc (#1348) — a series push carries
// the scene-by-scene segmentation (data/pipeline-series/{id}/reverse-outline.json)
// so a regenerate-only change propagates via the per-record push pipeline. ONLY
// valid on series pushes. `.passthrough()` on the doc + each scene/plotline
// (same rationale as manuscriptReview) so a newer sender that adds a field
// doesn't 400 at this receiver BEFORE its merge — `sanitizeSyncedOutline`
// clamps/drops everything on apply. Arrays are bounded so the payload can't
// force unbounded work (the sanitizer caps them again at 600 scenes / 10 plotlines).
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
}).strict();
// Author personas push the bare record + its headshot image in the asset
// manifest — no bundled children, linked collection, or catalog rows, so the
// base shape alone (`.strict()` rejects any smuggled bundle keys, same posture
// as mediaCollection).
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
// Creative Director projects (#1564) push the bare record + the project's
// `startingImageFile` in the asset manifest — no bundled children/linked
// collection/catalog rows (scene renders ride the project's linked media
// collection, federated separately), so the base shape alone (`.strict()`
// rejects smuggled bundle keys, same posture as author/mediaCollection).
const creativeDirectorProjectPushSchema = z.object({
  kind: z.literal('creativeDirectorProject'),
  ...peerSyncPushBase,
}).strict();
// Mood boards (#1564) push the bare record + any local image bytes its items[]
// reference in the asset manifest — no bundled children/linked collection rows,
// so the base shape alone suffices (`.strict()` rejects smuggled bundle keys,
// same posture as author/creativeDirectorProject).
const moodBoardPushSchema = z.object({
  kind: z.literal('moodBoard'),
  ...peerSyncPushBase,
}).strict();
// Writers Room works (#1565) push the bare work manifest (the decomposed
// draft-version metadata rides inside the record's `drafts[]`). The file-primary
// `.md` prose bodies do NOT ride `assetManifest` (which keys on a flat basename +
// single dir per kind) — they ride a dedicated `draftBodyManifest` of per-draft
// SHA-256 hashes the receiver diffs + pulls by nested `works/<workId>/drafts/<draftId>.md`
// path. workId/draftId get a second-pass `WORK_ID_RE`/`DRAFT_ID_RE` scrub in the
// service before any FS op; this schema just caps shape. `.strict()` rejects
// smuggled bundle keys (same posture as author/creativeDirectorProject/moodBoard).
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
}).strict();
// Writers Room folders + exercises (#1645) push the bare record — body-less, no
// asset manifest entries, no draft bodies, no bundled children. The base shape
// alone suffices (`.strict()` rejects smuggled bundle/draftBody keys, same
// posture as author/moodBoard). assetManifest is still required by the base but
// the sender always ships `[]`.
const writersRoomFolderPushSchema = z.object({
  kind: z.literal('writersRoomFolder'),
  ...peerSyncPushBase,
}).strict();
const writersRoomExercisePushSchema = z.object({
  kind: z.literal('writersRoomExercise'),
  ...peerSyncPushBase,
}).strict();
// Optional bundled linked-track record (#1858) — a music-video project created
// the create-UI way stores `trackId` (not `uploadedAudioFilename`), so its
// master audio rides as a `music` asset-manifest entry AND the linked track
// RECORD rides here, so a peer subscribed to musicVideoProjects ONLY (no Tracks
// category) can resolve `project.trackId` at render time. ONLY valid on a
// music-video push (a track push IS the track; other kinds' `.strict()` reject
// it). Same wire shape as any record (id required, sanitizer handles the rest).
const linkedTrackField = { linkedTrack: peerWireRecordSchema.optional() };
// Music Video projects (#1770) push the bare record (metadata + beat-aligned
// scenes[]). #1772 bundles referenced media (uploaded audio as a `music` entry,
// rendered scene clips as `video` entries) via the base `assetManifest`; #1858
// adds the optional `linkedTrack` record bundle above (`.strict()` still rejects
// any OTHER smuggled bundle key, same posture as creativeDirectorProject).
const musicVideoProjectPushSchema = z.object({
  kind: z.literal('musicVideoProject'),
  ...peerSyncPushBase,
  ...linkedTrackField,
}).strict();
// Creative Commission feedback (#2686) — a body-less reaction record, no assets;
// the sender always ships `assetManifest: []` (base still requires the field).
const commissionFeedbackPushSchema = z.object({
  kind: z.literal('commissionFeedback'),
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
  writersRoomWorkPushSchema,
  writersRoomFolderPushSchema,
  writersRoomExercisePushSchema,
  musicVideoProjectPushSchema,
  commissionFeedbackPushSchema,
]);

// Manual sync action schemas — used by POST /sync-record, /sync-now, /pull-metadata.

export const peerSyncRecordSchema = z.object({
  peerId: z.string().trim().min(1).max(120),
  recordKind: z.enum(['universe', 'series', 'mediaCollection', 'author', 'artist', 'album', 'track', 'creativeDirectorProject', 'moodBoard', 'writersRoomWork', 'writersRoomFolder', 'writersRoomExercise', 'musicVideoProject', 'commissionFeedback']),
  recordId: z.string().trim().min(1).max(200),
}).strict();

export const peerSyncNowSchema = z.object({
  peerId: z.string().trim().min(1).max(120),
}).strict();

// Standalone media-library manifest the SENDER advertises at
// GET /api/peer-sync/library-manifest (#1566). A full-sync receiver fetches it,
// validates it through this schema, then diffs `assets` vs local disk and
// receiver-pulls the missing bytes. Reuses `peerAssetManifestEntrySchema` (now
// incl. `audio`) so the wire shape stays identical to the per-record manifest.
//
// `assets` is capped well above the per-record manifest (a whole library is far
// larger than one record's refs); the sender logs + truncates beyond the cap
// rather than shipping an unbounded list. `manifestHash` lets the receiver
// short-circuit an unchanged library without diffing every entry. `.strict()`
// so a malformed envelope is rejected at the boundary.
export const peerLibraryManifestSchema = z.object({
  schemaVersion: z.number().int().min(0).max(1_000_000),
  manifestHash: hex64,
  assets: z.array(peerAssetManifestEntrySchema).max(100_000),
}).strict();

// --- Completed-agent CoS history federation (#1650) ----------------------
// A full-sync peer advertises its date-bucketed completed-agent archives at
// GET /api/peer-sync/cos-history-manifest; a receiver (only for peers it flags
// fullSync) diffs the entries vs local disk and receiver-pulls the missing
// archive files. Archives live at data/cos/agents/<date>/<agentId>/<file> —
// nested paths, NOT flat basenames — so each entry carries the path segments,
// validated here AND re-scrubbed in the service before any FS op (the
// "parse-not-existsSync" guard). Exported so the service + byte route share one
// source of truth for the allowlists.
export const COS_ARCHIVE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// agentIds are `agent-<id>` — alphanumerics, `_` and `-` only. NO dots, so a
// `..` traversal can't form, and NO slash. Capped well above any real id.
export const COS_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
// The exact set of files an archive holds (cosAgents.js). A fixed enum is the
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

// --- Live CoS task-list + claim-metadata federation (#1712) --------------
// A full-sync peer advertises its live task backlog (both the user TASKS.md and
// the internal COS-TASKS.md) at GET /api/peer-sync/cos-tasks; a receiver (only
// for peers it flags fullSync) runs a claim-aware per-task LWW merge into its own
// task files (see cosTaskStore.mergePeerTasks). Unlike the cos-history archives
// this is NOT byte replication — both peers mutate the files live and each task
// carries claim/lease metadata (#1563), so the merge unions by id and respects
// `leaseExpiresAt` so a peer's fresh claim is never clobbered.
//
// Each entry mirrors a parsed task (taskParser.parseTasksMarkdown output) plus a
// `taskType` discriminator telling the receiver which file it belongs in.
// `metadata` is permissive (task metadata shapes vary — context, reviewers[],
// screenshots[], claim fields) and is re-escaped/re-parsed safely on the
// receiver's next file read, so we only bound the key length + entry count here.
// `.strict()` on the entry rejects a smuggled extra top-level field; the metadata
// record stays open.
// `challenged` (#2441) rides the wire like any other status — the challenge
// case + resolution live in `metadata` (permissive record below), so they
// federate verbatim with no extra top-level fields.
const TASK_STATUSES = ['pending', 'in_progress', 'challenged', 'blocked', 'completed'];
const TASK_PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const peerCosTaskEntrySchema = z.object({
  id: z.string().trim().min(1).max(200),
  taskType: z.enum(['user', 'internal']),
  status: z.enum(TASK_STATUSES),
  priority: z.enum(TASK_PRIORITIES),
  description: z.string().max(20_000),
  approvalRequired: z.boolean().optional(),
  autoApproved: z.boolean().optional(),
  // `.default({})` so a sender that omits metadata yields `{}` rather than
  // undefined — the receiver's markdown generator does Object.entries(metadata)
  // and would otherwise throw, failing the whole file merge (the merge layer
  // also defends, but normalizing at the boundary is cheaper + clearer).
  //
  // The newest-edit-wins stamp (`metadata.updatedAt`, #1714) rides here verbatim:
  // it lives in metadata (not a top-level entry field) so it survives the TASKS.md
  // markdown round-trip the receiver re-reads, and is already covered by the
  // permissive value schema + the listHash's `JSON.stringify(metadata)`.
  metadata: z.record(z.string().min(1).max(120), z.any()).optional().default({}),
}).strict();
export const peerCosTasksSchema = z.object({
  schemaVersion: z.number().int().min(0).max(1_000_000),
  listHash: hex64,
  // A pathological backlog can't force unbounded merge work; the sender logs +
  // truncates beyond its own cap (kept under the byte cap the receiver enforces
  // on the response). 50k is far beyond any realistic single-user backlog.
  tasks: z.array(peerCosTaskEntrySchema).max(50_000),
}).strict();

export const peerPullMetadataSchema = z.object({
  // Backfill tries every online peer; no per-peer scoping field today.
  // .trim() so a stray-whitespace filename ('  a.png  ') normalizes to the real
  // name instead of passing validation and then failing sanitization/disk
  // lookup (a confusing 200 with attempted>0, recovered=0). Matches the
  // manifest-entry filename handling.
  filenames: z.array(z.string().trim().min(1).max(300)).max(5000),
}).strict();
