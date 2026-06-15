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
  recordKind: z.enum(['universe', 'series', 'mediaCollection', 'author']),
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
    kind: z.enum(['image-ref', 'video']),
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
const seriesPushSchema = z.object({
  kind: z.literal('series'),
  ...peerSyncPushBase,
  ...linkedCollectionField,
  ...manuscriptReviewField,
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
export const peerSyncPushSchema = z.discriminatedUnion('kind', [
  universePushSchema,
  seriesPushSchema,
  mediaCollectionPushSchema,
  authorPushSchema,
]);

// Manual sync action schemas — used by POST /sync-record, /sync-now, /pull-metadata.

export const peerSyncRecordSchema = z.object({
  peerId: z.string().trim().min(1).max(120),
  recordKind: z.enum(['universe', 'series', 'mediaCollection', 'author']),
  recordId: z.string().trim().min(1).max(200),
}).strict();

export const peerSyncNowSchema = z.object({
  peerId: z.string().trim().min(1).max(120),
}).strict();

export const peerPullMetadataSchema = z.object({
  // Backfill tries every online peer; no per-peer scoping field today.
  // .trim() so a stray-whitespace filename ('  a.png  ') normalizes to the real
  // name instead of passing validation and then failing sanitization/disk
  // lookup (a confusing 200 with attempted>0, recovered=0). Matches the
  // manifest-entry filename handling.
  filenames: z.array(z.string().trim().min(1).max(300)).max(5000),
}).strict();

