/**
 * Data Sync Routes
 *
 * Endpoints for snapshot-based data sync between PortOS peer instances.
 * Each category returns its full data + checksum for merge-based sync.
 *
 * Authorization (#5663). This is the OLDER of the two pull transports; the
 * per-record `/api/peer-sync/*` routes got receiver-side peer-pull
 * authorization in #3659 and these did not, so the whole of every category —
 * including the user's identity record — was served to anything that could
 * reach the port. Both reads now run the SAME `authorizePeerPull` gate, keyed
 * on the caller's `X-PortOS-Instance-Id` (which `syncOrchestrator.fetchPeer`
 * sends via `peerFetch`).
 *
 * Two tiers, deliberately:
 *  - Ordinary categories keep #3659's warn-first ramp — an un-upgraded peer is
 *    still served and logs one `⚠️`, because the distribution model requires
 *    peers that upgrade on their own schedule to keep syncing.
 *  - `PII_CATEGORIES` are refused outright (`alwaysEnforce`) whatever
 *    `federation.strictPullAuthorization` says. Root `AGENTS.md` forbids PII on
 *    the federation layer at all, and the privacy ADR's stated reason for
 *    refusing to federate these records was precisely that "the pull path
 *    carries no peer identity": docs/decisions/2026-08-08-privacy-records-machine-local.md.
 *
 * Consent is per-category, not just per-peer: the gate resolves the caller's
 * `syncCategories` map (`peerAllowsCategoryPull`) rather than only asking
 * whether the peer may receive anything at all. A peer the user enabled for
 * `universe` must not be able to ask for `digitalTwin` — that is the same
 * shape of hole #3659 closed for records. Resolving through
 * `resolveEffectiveCategories` also keeps a default-ON category (`usage`)
 * flowing for a peer whose other sync the user switched off.
 *
 * Scope: what a category CONTAINS is unchanged, and a user federating their own
 * two machines keeps working as long as the SOURCE machine has that category
 * ticked for the peer asking — which is exactly what its sharing config means.
 */

import { Router } from 'express';
import { z } from 'zod';
import * as dataSync from '../services/dataSync.js';
import { sweepTombstones, getSweepStatus, TOMBSTONE_GRACE_MS } from '../services/sharing/tombstoneGc.js';
import { authorizePeerPull } from '../services/sharing/peerPullAuthorization.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';

const router = Router();

// MUST stay in sync with dataSync.getSupportedCategories() — a category
// registered in the service but absent here 400s before its snapshot/apply
// handler can run (the latent bug #730 hit for `storyBuilder`).
const categoryParam = z.enum(['goals', 'character', 'digitalTwin', 'meatspace', 'universe', 'pipeline', 'mediaCollections', 'videoHistory', 'storyBuilder', 'usage']);

// Categories whose payload is the user's own person rather than their creative
// work — `digitalTwin` alone carries identity, chronotype, longevity markers,
// taste profile, autobiography stories and social accounts. These skip the
// warn-first ramp entirely (see the header note).
const PII_CATEGORIES = new Set(['digitalTwin', 'meatspace', 'character']);

// The one gate both reads share, so the checksum can never become the weaker
// door: a checksum is a fingerprint of the same payload.
const authorizeSyncPull = (req, category) => authorizePeerPull(req, {
  syncCategory: category,
  route: `sync ${category}`,
  alwaysEnforce: PII_CATEGORIES.has(category),
});

// Tombstone GC manual trigger. Declared BEFORE `/:category/*` so the literal
// "tombstones" segment wins Express's first-match lookup (categoryParam's
// Zod enum would otherwise 400 before our handler runs). graceMs is clamped
// to [0, 24h] — the trigger can only SHRINK the grace, never bypass the ack
// horizon; the per-kind null-cutoff refusal still fires regardless.
const tombstoneSweepBodySchema = z.object({
  graceMs: z.number().int().min(0).max(TOMBSTONE_GRACE_MS).optional(),
}).strict();

router.get('/tombstones/status', asyncHandler(async (req, res) => {
  const status = await getSweepStatus();
  res.json(status);
}));

router.post('/tombstones/sweep', asyncHandler(async (req, res) => {
  const parsed = tombstoneSweepBodySchema.safeParse(req.body || {});
  if (!parsed.success) {
    throw new ServerError(
      `Validation failed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
      { status: 400, code: 'VALIDATION_ERROR' },
    );
  }
  const result = await sweepTombstones(parsed.data);
  res.json(result);
}));

// Optional `?forPeer=<instanceId>` — the REQUESTING peer's instanceId. When
// present, the snapshot/checksum is scoped to EXCLUDE records that peer
// already receives from us per-record via the push pipeline (its inbound
// coverage), so the snapshot carries only un-subscribed records + tombstones
// for torn-down subs. Absent (older peers, non-peer callers) → full snapshot,
// applied idempotently by the receiver. Express returns an array for repeated
// query keys; the `typeof === 'string'` guard drops those so only a single
// scalar instanceId scopes the request. Trim + length-cap the value (matching
// the defensive id handling in the peerSync routes) so stray whitespace or a
// malformed/oversized client value can't become a junk cache key.
const forPeerOf = (req) => {
  if (typeof req.query.forPeer !== 'string') return undefined;
  const trimmed = req.query.forPeer.trim().slice(0, 128);
  return trimmed.length > 0 ? trimmed : undefined;
};

// GET /api/sync/:category/checksum — return checksum only (lightweight)
router.get('/:category/checksum', asyncHandler(async (req, res) => {
  const category = categoryParam.parse(req.params.category);
  await authorizeSyncPull(req, category);
  const result = await dataSync.getChecksum(category, { forPeerId: forPeerOf(req) });
  if (!result) throw new ServerError('Category not found', { status: 404 });
  res.json(result);
}));

// GET /api/sync/:category/snapshot — return category data + checksum
router.get('/:category/snapshot', asyncHandler(async (req, res) => {
  const category = categoryParam.parse(req.params.category);
  await authorizeSyncPull(req, category);
  const snapshot = await dataSync.getSnapshot(category, { forPeerId: forPeerOf(req) });
  if (!snapshot) throw new ServerError('Category not found', { status: 404 });
  res.json(snapshot);
}));

// POST /api/sync/:category/apply — apply remote data with merge.
// Forwards `portosMeta` to `applyRemote` so the schema-version gate fires for
// this transport too. Without the forward, a caller hitting this REST path
// (manual debug, future client transport) would silently bypass the gate
// because `applyRemote` defaults the option object to `{}` and the gate
// reads `options.portosMeta` — absent → comparator skips the ahead check.
// `portosMeta` is intentionally `.passthrough()` so newer-PortOS callers
// adding fields don't get 400'd before the gate has a chance to diagnose.
const applyBodySchema = z.object({
  data: z.unknown(),
  portosMeta: z.object({
    portosVersion: z.string().trim().min(1).max(40).optional(),
    schemaVersions: z.record(z.string().min(1).max(60), z.number().int().min(0).max(1_000_000)).optional(),
  }).passthrough().optional(),
});
router.post('/:category/apply', asyncHandler(async (req, res) => {
  const category = categoryParam.parse(req.params.category);
  const parsed = applyBodySchema.safeParse(req.body || {});
  if (!parsed.success) {
    throw new ServerError(`Validation failed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`, { status: 400, code: 'VALIDATION_ERROR' });
  }
  const { data, portosMeta } = parsed.data;
  // `z.unknown()` accepts falsy-but-present payloads (0, false, ''); only
  // reject genuinely missing/null so we don't 400 a valid empty-ish snapshot.
  if (data == null) throw new ServerError('Missing data field', { status: 400 });
  const result = await dataSync.applyRemote(category, data, { portosMeta });
  res.json(result);
}));

// GET /api/sync/categories — list supported sync categories
router.get('/', asyncHandler(async (req, res) => {
  res.json({ categories: dataSync.getSupportedCategories() });
}));

export default router;
