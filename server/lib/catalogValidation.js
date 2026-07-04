/**
 * Zod validation schemas for the Creative Ingredients Catalog routes.
 *
 * Domain-namespaced (imported as `catalogValidation.X` from the lib barrel)
 * so cross-domain identifier collisions never bite. The route handler in
 * server/routes/catalog.js uses `validateRequest(schema, body)` against these.
 *
 * Payload shapes for character/place/object intentionally accept the
 * server/lib/storyBible.js field set verbatim — backfilled and freshly
 * ingested records produce identical rows on the wire.
 */

import { z } from 'zod';
import { BIBLE_LIMITS } from './storyBible.js';
import {
  INGREDIENT_TYPE_IDS,
  RELATION_KIND_IDS,
  MEDIA_KIND_IDS,
  USER_TYPE_FIELD_KINDS,
  isActiveType,
} from './catalogTypes.js';

// Derived from the shared type registry (`catalogTypes.js`) — adding a SYSTEM
// type there flows through to consumers automatically. Kept as a frozen
// re-export so existing `import { INGREDIENT_TYPES }` callers are unaffected.
// NOTE: this is the SYSTEM list only — the local-create `type` gate below uses
// the runtime `isActiveType` refinement so user-defined types validate too.
export const INGREDIENT_TYPES = INGREDIENT_TYPE_IDS;

// Local ingredient `type` gate. Was a frozen `z.enum(INGREDIENT_TYPES)`; now a
// runtime refinement against the active registry (system + user-defined types)
// so a user-typed create/query passes. The cross-instance SYNC path stays loose
// (`z.string().max(32)` below) — a peer ingredient may arrive before its type
// row applies, and the version gate already covers true shape skew.
const ingredientTypeGate = z.string().trim().min(1).max(32)
  .refine(isActiveType, 'unknown ingredient type');

// Query-string booleans arrive as the strings 'true'/'false'. Coerce to a real
// boolean; anything else (including absent) collapses to undefined so an
// `.optional()` field reads cleanly as "not set" rather than truthy-by-presence.
const booleanish = z.preprocess((v) => {
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return undefined;
}, z.boolean());

export const REF_KINDS = Object.freeze([
  'universe',
  'series',
  'issue',
  'work',
  'creative-director',
]);

// Relation kinds derived from the shared registry (`catalogTypes.js`) — adding
// a kind there flows through to the Zod enum below.
export const RELATION_KINDS = RELATION_KIND_IDS;

// Media-attachment kinds derived from the shared registry — same pattern.
export const MEDIA_KINDS = MEDIA_KIND_IDS;

const tag = z.string().trim().min(1).max(BIBLE_LIMITS.TAG_MAX);
const tags = z.array(tag).max(BIBLE_LIMITS.TAGS_PER_ENTRY_MAX).optional();

// `payload` is a JSONB blob — the route accepts arbitrary content because the
// six ingredient types have very different shapes. We cap the round-tripped
// size at the JSON.stringify length to keep a single user accident from
// landing a 50-MB blob in the catalog. The extraction service is responsible
// for shape correctness; the schema only enforces the boundary.
const payload = z.record(z.string(), z.unknown())
  .refine((p) => JSON.stringify(p).length <= 200_000, {
    message: 'payload exceeds 200KB JSON size cap',
  })
  .optional();

// Scrap source kinds. The DB column is a free VARCHAR(32) so peers running a
// newer build can push kinds an older build doesn't enumerate (the sync-apply
// path uses the looser `z.string().max(32)` below, NOT this enum). This enum
// gates the LOCAL ingest routes only — every value here is one a local ingest
// path actually produces.
export const SCRAP_SOURCE_KINDS = Object.freeze([
  'paste',
  'brain-bridge',
  'importer-handoff',
  'manual',
  'url',         // POST /catalog/ingest/url — fetched + main-text-extracted page
  'file',        // POST /catalog/ingest/file — uploaded .txt/.md/.pdf
  'voice-memo',  // POST /catalog/ingest/voice — recorded memo, Whisper-transcribed
]);

// --- User-defined catalog types (PostgreSQL `catalog_user_types`, #1001) --
// A user type is a DB-persisted (formerly settings.json), federated definition
// that merges into the active type registry at boot/runtime as a `system:false`
// entry. The schemas below still validate the slice/entry SHAPE — which is
// storage-independent — at the route + sync boundaries. The
// shape is intentionally minimal: an id (the stored `type` discriminator), a
// label, a primary content key, and a flat list of typed fields the generic
// editor renders. There is NO per-type React file — the renderer is generic.
const userTypeIdentifier = z.string().trim().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, 'must be a slug/identifier').max(64);
const userTypeField = z.object({
  key: userTypeIdentifier,
  label: z.string().trim().min(1).max(80),
  kind: z.enum(USER_TYPE_FIELD_KINDS),
  maxLength: z.number().int().min(1).max(20_000).optional(),
}).strict();

export const catalogUserTypeSchema = z.object({
  // The type id is also the `cat-<prefix>-<uuid>` discriminator stored in the
  // DB — slug-only, ≤32 so it stays a tidy column value.
  id: z.string().trim().regex(/^[a-z][a-z0-9-]*$/, 'id must be a lowercase slug').max(32),
  label: z.string().trim().min(1).max(80),
  primaryContentKey: userTypeIdentifier,
  fields: z.array(userTypeField).max(40),
  // Mutation timestamp — drives the cross-peer LWW merge (a newer mutation
  // wins). Stamped server-side on every create/edit; clients don't send it.
  updatedAt: z.string().datetime().optional(),
  // Soft-delete tombstone. A deleted user type is KEPT in the slice with
  // `deletedAt` set rather than physically removed, so the deletion FEDERATES
  // to peers instead of a peer resurrecting it on the next sync. Filtered out
  // of the active registry. LWW compares the later of {updatedAt, deletedAt}:
  // a delete newer than a peer's edit wins, and an edit newer than the delete
  // revives the type.
  deletedAt: z.string().datetime().nullable().optional(),
}).strict();

// The whole user-type slice: ≤64 user types, unique ids, and no id colliding
// with a built-in system type. (Prefix-collision is resolved deterministically
// at merge time in `normalizeUserType`, so it's not gated here — two user types
// with prefix-deriving-to-the-same base just get `name2`.) The name retains the
// `Settings` suffix for back-compat with the many importers; the slice now lives
// in `catalog_user_types`, not settings.json.
export const catalogUserTypesSettingsSchema = z.array(catalogUserTypeSchema).max(64)
  .refine((list) => new Set(list.map((t) => t.id)).size === list.length, {
    message: 'duplicate catalog user-type id',
  })
  .refine((list) => list.every((t) => !INGREDIENT_TYPE_IDS.includes(t.id)), {
    message: 'catalog user-type id collides with a built-in type',
  });

export const catalogScrapCreateSchema = z.object({
  title: z.string().trim().max(300).optional().nullable(),
  rawText: z.string().min(1).max(2_000_000),
  sourceKind: z.enum(SCRAP_SOURCE_KINDS).optional(),
  metadata: payload,
}).strict();

export const catalogScrapPatchSchema = catalogScrapCreateSchema.partial();

// --- Source-kind ingest routes (url / file / voice) ---------------------
// Each ingest route creates a scrap with the matching `sourceKind`, then runs
// the same extraction pipeline the paste→extract→commit flow uses, so the
// client lands on the identical review phase. `providerOverride` mirrors
// catalogExtractRequestSchema below.

// A host (bracket-stripped, lowercased) that the URL ingest must refuse:
// loopback, link-local (incl. the 169.254.169.254 cloud-metadata endpoint),
// and the unspecified address — in plain IPv4, IPv6, IPv4-mapped-IPv6
// (`::ffff:127.0.0.1` → WHATWG-hex `::ffff:7f00:1`), AND the deprecated
// IPv4-compatible-IPv6 form (`::127.0.0.1` → `::7f00:1`), so the guard can't be
// bypassed by embedding a blocked v4 address inside an IPv6 literal. A trailing
// FQDN dot (`localhost.`, `127.0.0.1.`) is stripped first since resolvers treat
// it as equivalent. NOTE: decimal / hex / octal / shorthand IPv4 (`2130706433`,
// `0x7f000001`, `127.1`) need no special handling — `new URL()` already
// normalizes them to canonical dotted-quad in `.hostname` before this runs. We
// deliberately ALLOW other private/LAN hosts (incl. IPv6 ULA `fd00::/8`):
// reaching a Tailscale peer or home-network wiki is a legit use of this
// single-user tool. This is a host-literal guard, not a DNS-resolution or
// post-redirect check — a hostname that RESOLVES to loopback, or a redirect to
// a blocked host, is not caught here.
export const isBlockedIngestHost = (host) => {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === 'metadata.google.internal') return true;
  if (h === '::1' || h === '::' || h === '0.0.0.0') return true;
  // IPv6 link-local fe80::/10 (first hextet fe80–febf), e.g. [fe80::1].
  if (h.includes(':') && /^fe[89ab][0-9a-f]?:/i.test(h)) return true;
  const v4Blocked = (ip) => /^127\./.test(ip) || /^169\.254\./.test(ip) || ip === '0.0.0.0';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return v4Blocked(h);
  // A blocked v4 address embedded in an IPv6 literal — either IPv4-mapped
  // (`::ffff:…`) or the deprecated IPv4-compatible (`::…`) form. WHATWG
  // normalizes the trailing v4 to a pair of hex hextets (`7f00:1`), or keeps it
  // dotted in older inputs; handle both. A `::ffff:`-less match also catches the
  // compatible form; the real `::1` / `::` cases were already returned above.
  const embedded = /^::(?:ffff:)?(.+)$/i.exec(h);
  if (embedded) {
    const tail = embedded[1];
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return v4Blocked(tail);
    const parts = tail.split(':');
    if (parts.length === 2 && parts.every((p) => /^[0-9a-f]{1,4}$/.test(p))) {
      const hi = parseInt(parts[0], 16), lo = parseInt(parts[1], 16);
      return v4Blocked(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
    }
  }
  return false;
};

// Block schemes and hosts that would turn "fetch this page" into local-file
// exfiltration or cloud-metadata SSRF: non-http(s) schemes (file:/chrome:/
// javascript:/ftp:) and the blocked hosts above.
export const isSafeIngestUrl = (raw) => {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return !isBlockedIngestHost(u.hostname);
};

export const catalogUrlIngestSchema = z.object({
  url: z.string().trim().max(4_000).url()
    .refine(isSafeIngestUrl, 'only http(s) URLs to non-loopback/non-link-local hosts are allowed'),
  providerOverride: z.string().trim().min(1).max(120).optional(),
}).strict();

// Text-bearing file ingest. The client reads .txt/.md text locally and posts
// it here with the original filename + mime so the scrap metadata records
// provenance without the server needing an upload/parse dependency.
export const catalogFileIngestSchema = z.object({
  text: z.string().min(1).max(2_000_000),
  filename: z.string().trim().min(1).max(300),
  mime: z.string().trim().min(1).max(120).optional(),
  providerOverride: z.string().trim().min(1).max(120).optional(),
}).strict();

// Voice-memo ingest. `audioBase64` is a base64-encoded WAV the client records
// via MediaRecorder (matching the voice agent's STT path). The server decodes
// it, transcribes via Whisper, persists the audio under data/audio to mint a
// `media_key`, then ingests the transcript with that key in scrap metadata.
// 8 MB base64 ≈ 6 MB raw ≈ several minutes of 16 kHz mono WAV.
export const catalogVoiceIngestSchema = z.object({
  audioBase64: z.string().min(1).max(8_000_000),
  mimeType: z.string().trim().min(1).max(64).optional(),
  title: z.string().trim().max(300).optional(),
  providerOverride: z.string().trim().min(1).max(120).optional(),
}).strict();

// Brain-bridge ingest. Instead of pasted/fetched text, the source is an existing
// brain record (an idea, journal memory, project, admin item, or person). The
// route resolves the record by `{ brainType, brainId }`, folds its prose into
// one rawText block, and runs the SAME extraction pipeline — so a captured
// thought becomes typed catalog ingredients (characters/scenes/ideas/…) the
// user reviews and commits. This is the "make the catalog the universal sink"
// ingestion bridge: brain entries finally flow into the catalog the way
// paste/url/file/voice already do. The supported types mirror
// `BRAIN_INGEST_GETTERS` in catalogIngestSources.js (keep the two in lockstep).
export const CATALOG_BRAIN_INGEST_TYPES = Object.freeze(['ideas', 'memories', 'projects', 'admin', 'people']);
export const catalogBrainIngestSchema = z.object({
  brainType: z.enum(CATALOG_BRAIN_INGEST_TYPES),
  brainId: z.string().trim().min(1).max(200),
  providerOverride: z.string().trim().min(1).max(120).optional(),
}).strict();

export const catalogIngredientCreateSchema = z.object({
  type: ingredientTypeGate,
  name: z.string().trim().min(1).max(BIBLE_LIMITS.NAME_MAX),
  payload,
  tags,
}).strict();

// Revision-history sources, mirrored from the catalog_ingredient_revisions
// DB CHECK constraint. The PATCH route accepts an optional `source`/`actor` so
// AI-driven callers (story-builder refine) can label their edits; a manual
// detail-page save omits them and the DB layer defaults to 'user'.
export const REVISION_SOURCES = Object.freeze(['user', 'extract', 'refine', 'sync']);
const revisionSource = z.enum(REVISION_SOURCES).optional();
const revisionActor = z.string().trim().min(1).max(120).optional();

export const catalogIngredientPatchSchema = z.object({
  name: z.string().trim().min(1).max(BIBLE_LIMITS.NAME_MAX).optional(),
  payload,
  tags,
  source: revisionSource,
  actor: revisionActor,
}).strict();

// /ingredients/:id/revisions — paginated history list. Newest first.
export const catalogRevisionQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
}).strict();

// /ingredients/:id/revisions/:revisionId/restore — re-applies a prior
// revision's name/payload/tags. Optional `source`/`actor` label the NEW
// revision the restore itself produces (defaults to 'user').
export const catalogRevisionRestoreSchema = z.object({
  source: revisionSource,
  actor: revisionActor,
}).strict();

export const catalogIngredientQuerySchema = z.object({
  // Batch-fetch by id. The wire form is a CSV string (`?ids=a,b,c`); we
  // preprocess it into a trimmed, empties-dropped, ≤50 string[]. An empty/
  // all-blank CSV collapses to `undefined` so the field reads cleanly as
  // absent (the route/service then falls through to the type/tag/q filters).
  // When present, `ids` takes precedence over type/tag/q in `listIngredients`.
  ids: z.preprocess((v) => {
    if (typeof v !== 'string') return v;
    const parts = v.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
    return parts.length ? parts : undefined;
  }, z.array(z.string().trim().min(1).max(64)).max(50).optional()),
  type: ingredientTypeGate.optional(),
  tag: tag.optional(),
  q: z.string().trim().max(500).optional(),
  // Album/facet filters (#1762). `refKind`+`refId` list ingredients linked to a
  // universe/series; `unlinked` = the "Raw" album (no universe/series ref at
  // all); `orphaned` = the "Orphaned" album (has a ref, none resolve live). The
  // wire form sends booleans as `?unlinked=true`, so coerce the string here.
  refKind: z.enum(REF_KINDS).optional(),
  refId: z.string().trim().min(1).max(120).optional(),
  unlinked: booleanish.optional(),
  orphaned: booleanish.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
}).strict()
  // refKind/refId are a pair — one without the other is a malformed query.
  .refine((v) => (v.refKind == null) === (v.refId == null), {
    message: 'refKind and refId must be supplied together',
    path: ['refId'],
  })
  // The three album filters are mutually exclusive — combining them is ambiguous
  // (a ref-filtered row is by definition linked, so it can never be unlinked/
  // orphaned). Reject rather than silently letting one win in the service.
  .refine((v) => [v.refKind != null, v.unlinked === true, v.orphaned === true].filter(Boolean).length <= 1, {
    message: 'refKind/refId, unlinked, and orphaned are mutually exclusive',
    path: ['unlinked'],
  });

// Tag-autocomplete query — `q` is an optional prefix/substring filter, absent
// returns the most-recently-created tags. Drives the tag-picker autocomplete on
// CatalogIngredient.jsx + the Quick Idea widget.
export const catalogTagQuerySchema = z.object({
  q: z.string().trim().max(BIBLE_LIMITS.TAG_MAX).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

export const catalogIngredientLinkSchema = z.object({
  refKind: z.enum(REF_KINDS),
  refId: z.string().trim().min(1).max(120),
  role: z.string().trim().min(1).max(64),
}).strict();

// Ingredient↔ingredient relation link/unlink body. `toId` is the OTHER end of
// the directed edge (the route's `:id` is the `fromId`). `kind` is gated to the
// shared relation registry. The route rejects self-edges (`fromId === toId`) at
// the DB layer; the schema can't see the path param, so that check stays
// server-side in `linkIngredientRelation`.
export const catalogRelationLinkSchema = z.object({
  toId: z.string().trim().min(1).max(80),
  kind: z.enum(RELATION_KINDS),
}).strict();

// Media attach body. `mediaKey` is a REFERENCE into the media library (a
// gallery filename / history sidecar key), not the bytes — capped at a generous
// 512 to allow nested paths but reject blobs. `kind` is gated to the shared
// media registry; `role`/`caption` are optional metadata. The route validates
// that the key resolves against the local library before persisting.
export const catalogMediaAttachSchema = z.object({
  mediaKey: z.string().trim().min(1).max(512),
  kind: z.enum(MEDIA_KINDS),
  role: z.string().trim().max(64).optional().nullable(),
  caption: z.string().trim().max(2_000).optional().nullable(),
}).strict();

// Set-portrait body — same as attach minus `kind` (the route forces 'portrait').
export const catalogPortraitSetSchema = z.object({
  mediaKey: z.string().trim().min(1).max(512),
  role: z.string().trim().max(64).optional().nullable(),
  caption: z.string().trim().max(2_000).optional().nullable(),
}).strict();

// Media detach body — identifies the tuple to soft-delete.
export const catalogMediaDetachSchema = z.object({
  mediaKey: z.string().trim().min(1).max(512),
  kind: z.enum(MEDIA_KINDS),
}).strict();

// File-upload attach body: raw base64 bytes + the browser-reported MIME. The
// server decides the media `kind` (image→reference, audio, video) from the MIME
// and persists into the matching federating library dir before attaching — the
// client never picks the storage kind. 32 MB base64 (~24 MB raw) upper-bounds a
// runaway paste; per-category size is re-checked server-side.
export const catalogMediaFileUploadSchema = z.object({
  dataBase64: z.string().min(1).max(32 * 1024 * 1024),
  mimeType: z.string().trim().min(1).max(128),
  filename: z.string().trim().max(300).optional().nullable(),
  role: z.string().trim().max(64).optional().nullable(),
  caption: z.string().trim().max(2_000).optional().nullable(),
}).strict();

// Voice-memo body: a recorded WAV (16 kHz mono, base64) the server transcribes
// via Whisper and attaches as a `kind:'audio'` media row with the transcript in
// `caption`. 16 MB base64 (~12 MB raw) fits several minutes of 16 kHz mono WAV.
export const catalogMediaVoiceMemoSchema = z.object({
  audioBase64: z.string().min(1).max(16 * 1024 * 1024),
  mimeType: z.string().trim().max(64).optional(),
  role: z.string().trim().max(64).optional().nullable(),
}).strict();

export const catalogScrapCommitSchema = z.object({
  accepted: z.array(catalogIngredientCreateSchema.extend({
    // Optional source-span hint (server forwards as-is to linkIngredientToSource).
    span: z.record(z.string(), z.unknown()).optional(),
  })).min(0).max(200),
}).strict();

// /scraps/:id/extract — optional provider override (e.g., force a specific
// LLM provider for this extraction). Empty body is valid.
export const catalogExtractRequestSchema = z.object({
  providerOverride: z.string().trim().min(1).max(64).optional(),
}).strict();

// /embeddings/backfill — re-embed up to `limit` rows. By default only fills
// rows where embedding IS NULL; pass `includeStale: true` to also re-embed
// rows whose stored `embedding_model` differs from the current settings
// model (used after a provider/model switch to refresh the vector space).
export const catalogEmbeddingsBackfillSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  includeStale: z.boolean().optional(),
}).strict();

// /migration/rerun — pass `force: true` to ignore the marker file.
export const catalogMigrationRerunSchema = z.object({
  force: z.boolean().optional(),
}).strict();

// /bulk-import — accept a structured payload in one of three formats. The
// route parses `payload` into a list of ingredient drafts (per the format),
// then validates each entry against catalogIngredientCreateSchema before
// insert. `defaults.tags` are merged onto every row; `defaults.*Ref` (if any)
// creates a catalog_ingredient_refs row in the same transaction.
//
// Payload is capped at 2MB (same ceiling as scrap rawText) so a single
// import can't blow the request body limit. Per-entry shape is validated
// after parse, not here.
export const catalogBulkImportSchema = z.object({
  format: z.enum(['json', 'csv', 'markdown']),
  payload: z.string().min(1).max(2_000_000),
  defaults: z.object({
    universeRef: z.string().trim().min(1).max(120).optional(),
    seriesRef: z.string().trim().min(1).max(120).optional(),
    workRef: z.string().trim().min(1).max(120).optional(),
    issueRef: z.string().trim().min(1).max(120).optional(),
    role: z.string().trim().min(1).max(64).optional(),
    tags: z.array(tag).max(BIBLE_LIMITS.TAGS_PER_ENTRY_MAX).optional(),
  }).strict().optional(),
}).strict();

// /export — query params for the export endpoint. Returns the bundle in
// the requested serialization; the response is `Content-Disposition:
// attachment` so the browser saves it directly.
export const catalogExportQuerySchema = z.object({
  refKind: z.enum(REF_KINDS),
  refId: z.string().trim().min(1).max(120),
  format: z.enum(['json', 'markdown', 'yaml']).optional(),
}).strict();

// Sync envelope shape — used by POST /api/catalog/sync/apply when a peer
// forwards changes pulled from another instance. Each kind is optional so
// callers can apply a partial envelope (e.g. ingredients-only).
//
// Read-path caps MIRROR the create-path caps above: rawText 2MB, payload
// 200KB JSON-stringified, name ≤ NAME_MAX, tags count/length. The create
// path can't be the only line of defense — a peer running an older / forked
// PortOS that skipped its own validation could otherwise push an unbounded
// blob through here. The receiver enforces its own size contract.
const isoDate = z.string().min(1);
const syncEmbedding = z.array(z.number()).max(4096).optional().nullable();
const syncPayload = z.unknown().optional().refine(
  (p) => p === undefined || p === null || (typeof p === 'object' && JSON.stringify(p).length <= 200_000),
  { message: 'payload exceeds 200KB JSON size cap' },
);
const syncMetadata = syncPayload;
const syncTags = z.array(z.string().max(BIBLE_LIMITS.TAG_MAX))
  .max(BIBLE_LIMITS.TAGS_PER_ENTRY_MAX)
  .optional();

export const catalogSyncScrapSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().max(300).nullable().optional(),
  rawText: z.string().max(2_000_000),
  sourceKind: z.string().max(32).optional(),
  metadata: syncMetadata,
  embedding: syncEmbedding,
  embeddingModel: z.string().max(100).nullable().optional(),
  originInstanceId: z.string().max(64).nullable().optional(),
  // Scrap chunking (catalog v7). Optional so a ≤v6 peer's scrap rows (which
  // carry neither field) still validate: chunkIndex defaults to 0 and
  // parentScrapId to null on the receiver — a plain non-chunked scrap.
  chunkIndex: z.number().int().min(0).optional(),
  parentScrapId: z.string().max(80).nullable().optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
  deleted: z.boolean().optional(),
  deletedAt: z.string().nullable().optional(),
  syncSequence: z.string().optional(),
}).passthrough();

export const catalogSyncIngredientSchema = z.object({
  id: z.string().min(1).max(80),
  // Loose on the wire (NOT the active-type refinement): a peer ingredient may
  // arrive before its user-type row applies, so a not-yet-known type stores
  // harmlessly. The version gate covers true cross-instance shape skew.
  type: z.string().max(32),
  name: z.string().max(BIBLE_LIMITS.NAME_MAX),
  payload: syncPayload,
  tags: syncTags,
  embedding: syncEmbedding,
  embeddingModel: z.string().max(100).nullable().optional(),
  originInstanceId: z.string().max(64).nullable().optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
  deleted: z.boolean().optional(),
  deletedAt: z.string().nullable().optional(),
  syncSequence: z.string().optional(),
}).passthrough();

export const catalogSyncSourceSchema = z.object({
  ingredientId: z.string().max(80),
  scrapId: z.string().max(80),
  // span shape isn't strictly typed (`{ start, end }` today, may grow); cap
  // its JSON size so a peer can't push a 50MB "span" blob.
  span: z.unknown().optional().refine(
    (p) => p === undefined || p === null || JSON.stringify(p).length <= 10_000,
    { message: 'span exceeds 10KB JSON size cap' },
  ),
  extractedAt: isoDate,
  syncSequence: z.string().optional(),
}).passthrough();

export const catalogSyncRefSchema = z.object({
  ingredientId: z.string().max(80),
  refKind: z.string().max(32),
  refId: z.string().max(120),
  role: z.string().max(64),
  createdAt: isoDate,
  syncSequence: z.string().optional(),
}).passthrough();

// Relation rows carry tombstone fields (soft-delete from day one). `kind` is a
// freeform string on the wire (not the strict enum) so a peer running a newer
// PortOS with an additional relation kind doesn't get its whole envelope
// rejected by an older receiver — the version gate already covers true
// shape skew, and an unknown-kind row stores harmlessly.
export const catalogSyncRelationSchema = z.object({
  fromId: z.string().max(80),
  toId: z.string().max(80),
  kind: z.string().max(32),
  createdAt: isoDate,
  deleted: z.boolean().optional(),
  deletedAt: z.string().nullable().optional(),
  syncSequence: z.string().optional(),
}).passthrough();

// Receiver may receive `portosMeta.schemaVersions.catalog` for the version
// gate; the rest of portosMeta is informational. We accept arbitrary keys
// inside portosMeta with passthrough but cap its size at 4KB to deny a peer
// stuffing junk through the metadata escape hatch.
const portosMeta = z.object({
  portosVersion: z.string().max(64).optional(),
  schemaVersions: z.record(z.string(), z.number().int()).optional(),
}).passthrough().refine(
  (m) => JSON.stringify(m).length <= 4_000,
  { message: 'portosMeta exceeds 4KB size cap' },
).optional();

// Canonical tag rows on the wire. `label` carries the first-seen casing; the
// mutable fields (description/color/parentId) round-trip via LWW on updatedAt.
// `parentId` is freeform (the receiver's parent-less retry tolerates a parent
// that hasn't arrived yet), so no enum/FK gate here.
export const catalogSyncTagSchema = z.object({
  id: z.string().min(1).max(120),
  label: z.string().max(BIBLE_LIMITS.TAG_MAX),
  description: z.string().max(2_000).nullable().optional(),
  color: z.string().max(32).nullable().optional(),
  parentId: z.string().max(120).nullable().optional(),
  createdAt: isoDate,
  updatedAt: isoDate.optional(),
  syncSequence: z.string().optional(),
}).passthrough();

// Media rows carry tombstone fields + editable metadata (role/caption).
// `kind` is freeform on the wire (not the strict enum) for the same forward-
// compat reason as relations: a newer peer's extra media kind stores
// harmlessly rather than 400-ing the whole envelope. `mediaKey` is a reference,
// not bytes — the receiver matches it against its own library on apply.
export const catalogSyncMediaSchema = z.object({
  ingredientId: z.string().max(80),
  mediaKey: z.string().max(512),
  kind: z.string().max(32),
  role: z.string().max(64).nullable().optional(),
  caption: z.string().max(2_000).nullable().optional(),
  createdAt: isoDate,
  deleted: z.boolean().optional(),
  deletedAt: z.string().nullable().optional(),
  syncSequence: z.string().optional(),
}).passthrough();

// User-defined type DEFINITIONS on the wire (catalog v8). LWW-merged on the
// receiver into its own user-type store (`catalog_user_types` as of #1001; the
// `settings.json` `catalogUserTypes` slice before that). Loose-shaped
// (passthrough, no field-kind enum) so a forked peer's extra field shape still
// stores — the active-registry merge re-normalizes on apply, and a malformed
// entry is dropped there rather than 400-ing the whole envelope. `updatedAt`
// drives the LWW window; absent → treated as createdAt for the comparison.
export const catalogSyncUserTypeSchema = z.object({
  id: z.string().min(1).max(32),
  label: z.string().max(80).optional(),  // a pure tombstone may omit label
  primaryContentKey: z.string().max(64).optional(),
  fields: z.array(z.unknown()).max(40).optional(),
  updatedAt: z.string().optional(),
  // A deletion tombstone rides the wire so a delete federates instead of a
  // peer resurrecting the type. Null/absent = live.
  deletedAt: z.string().nullable().optional(),
}).passthrough();

export const catalogSyncEnvelopeSchema = z.object({
  scraps: z.array(catalogSyncScrapSchema).max(5_000).optional(),
  ingredients: z.array(catalogSyncIngredientSchema).max(5_000).optional(),
  sources: z.array(catalogSyncSourceSchema).max(20_000).optional(),
  refs: z.array(catalogSyncRefSchema).max(20_000).optional(),
  relations: z.array(catalogSyncRelationSchema).max(20_000).optional(),
  tags: z.array(catalogSyncTagSchema).max(20_000).optional(),
  media: z.array(catalogSyncMediaSchema).max(20_000).optional(),
  // Additive catalog v8 block — user-defined type definitions. Optional so a
  // ≤v7 peer's envelope (no `catalogTypes`) still validates.
  catalogTypes: z.array(catalogSyncUserTypeSchema).max(64).optional(),
  portosMeta,
}).passthrough();
