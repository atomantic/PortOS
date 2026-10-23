/**
 * Federated peer-sync — receiver-side push handler.
 *
 * `applyIncomingPush` merges an inbound record via the existing
 * `merge*FromSync` LWW paths, computes the missing-asset / missing-body diff
 * the sender must satisfy, kicks off the background asset pull, advances
 * tombstone cursors, and (best-effort) creates a reverse subscription back to
 * the sender. Asset diffing + pulling live in `peerSyncAssets.js`.
 *
 * Split out of the former 4,004-line peerSync.js (#1830).
 */
import { authorizeIncomingPush } from './peerPushAuthorization.js';
import { isPlainObject } from '../../lib/objects.js';
import {
  PORTOS_SCHEMA_VERSIONS,
  RECORD_KIND_SCHEMA_CATEGORIES,
  compareSchemaVersions,
  catalogEnvelopeHasLiveRows,
  scopeVersionDiff,
  formatVersionGap,
  getPortosVersion,
} from '../../lib/schemaVersions.js';
import { UNKNOWN_INSTANCE_ID } from '../instanceIdentity.js';
import { mergeIssuesFromSync } from '../pipeline/issues.js';
import { SERIES_ID_RE } from '../pipeline/series.js';
import { diffWorkBodyManifest } from '../writersRoom/sync.js';
import {
  ackDeletesUpTo,
} from './peerTombstoneCursors.js';
import {
  diffAssetManifestAgainstLocal,
  referenceCollectionAssetManifest,
  pullMissingAssetsFromPeer,
  pullMissingWorkBodies,
  pullMissingWorkBibles,
} from './peerSyncAssets.js';
import { RECORD_KINDS } from './recordKinds.js';
import { takeHostedAssets } from '../peerHostedMedia.js';
import { findPeerSubscription, subscribePeer } from './peerSubscriptions.js';
import {
  makeErr,
  findPeerById,
  loadOrNotFound,
  peerSyncEvents,
  ERR_VALIDATION,
  ERR_SCHEMA_VERSION_AHEAD,
  PEER_SUBSCRIBABLE_KINDS,
  ENVELOPE_PENDING_KEYS,
} from './peerSyncShared.js';
import { isStr, isNonBlankStr } from '../../lib/textUtils.js';


async function isPostgresBackend() {
  const { getBackendName } = await import('../memoryBackend.js');
  return getBackendName() === 'postgres';
}

/**
 * Apply a received catalog bundle on the receiver. Reuses
 * `catalogSync.applyRemoteChanges` so the bundle goes through the exact same
 * per-row LWW upsert + schema gate + try/catch isolation as direct catalog
 * sync — we forward `portosMeta` so applyRemoteChanges runs the gate itself
 * (defense in depth; the push-level gate already ran). Postgres-only; the
 * applyIncomingPush caller already null-checks `catalogBundle`, but we re-gate
 * the backend here so a stray call on a non-Postgres install is a clean no-op.
 */
async function applyCatalogBundle(catalogBundle, portosMeta) {
  if (!(await isPostgresBackend())) return;
  const { applyRemoteChanges } = await import('../catalogSync.js');
  await applyRemoteChanges({
    ingredients: Array.isArray(catalogBundle.ingredients) ? catalogBundle.ingredients : [],
    refs: Array.isArray(catalogBundle.refs) ? catalogBundle.refs : [],
    portosMeta,
  });
}

/**
 * Bundled companion records (`linkedCollection`, `catalogBundle`,
 * `linkedTrack`) ride a push admitted for ONE record's category. Without a
 * binding to that record, a peer admitted for `universe` could overwrite
 * media collections, catalog rows or tracks outside the categories the user
 * enabled for it (#12427). Each bundle is kept only when it provably belongs
 * to `record`; an unbound bundle is skipped with one warning and never fails
 * the push (the bundle contract is non-fatal, so older peers that send
 * well-formed bundles are unaffected).
 */
const COLLECTION_PARENT_FIELD = { universe: 'universeId', series: 'seriesId' };

async function bindLinkedCollection({ kind, record, linkedCollection, sourceInstanceId }) {
  if (!isPlainObject(linkedCollection)) return null;
  const parentField = COLLECTION_PARENT_FIELD[kind];
  if (!parentField || linkedCollection[parentField] !== record.id) {
    console.warn(`⚠️ peerSync: skipped unbound linkedCollection from ${sourceInstanceId} — not linked to ${kind} ${record.id}`);
    return null;
  }
  // The merge overwrites the collection's own parent link by id, so a peer that
  // names another collection's id while claiming this record as parent would
  // re-parent it. Refuse when the local collection is linked elsewhere.
  // A failed lookup is not "no local collection": skip the bundle (the snapshot
  // sync reconciles collections) rather than merge past an unverified owner.
  let local;
  try {
    local = await loadOrNotFound(() => RECORD_KINDS.mediaCollection.load(linkedCollection.id));
  } catch (err) {
    console.warn(`⚠️ peerSync: skipped linkedCollection from ${sourceInstanceId} — local collection lookup failed: ${err.message}`);
    return null;
  }
  // Parent field and id must both match: a local collection parented by a
  // series that shares this universe's id is still another category's record.
  const linkedElsewhere = local && (local.universeId || local.seriesId) && local[parentField] !== record.id;
  if (linkedElsewhere) {
    console.warn(`⚠️ peerSync: skipped linkedCollection from ${sourceInstanceId} — local collection belongs to another parent`);
    return null;
  }
  return linkedCollection;
}

async function bindCatalogBundle({ kind, record, catalogBundle, sourceInstanceId }) {
  if (!isPlainObject(catalogBundle)) return null;
  const rawRefs = Array.isArray(catalogBundle.refs) ? catalogBundle.refs : [];
  const rawIngredients = Array.isArray(catalogBundle.ingredients) ? catalogBundle.ingredients : [];
  let refs = rawRefs.filter((ref) => isPlainObject(ref) && ref.refKind === kind && ref.refId === record.id);
  let ingredients = rawIngredients.filter((ing) => isPlainObject(ing) && refs.some((ref) => ref.ingredientId === ing.id));
  const dropped = (rawRefs.length - refs.length) + (rawIngredients.length - ingredients.length);
  if (dropped > 0) {
    console.warn(`⚠️ peerSync: dropped ${dropped} catalog bundle rows from ${sourceInstanceId} not bound to ${kind} ${record.id}`);
  }
  // A ref naming the pushed record proves nothing about an ingredient another
  // record already owns: the sender writes both. Only an ingredient with no
  // local row, or one this record already refs locally, may merge (#12466).
  // The ref is dropped with it, or the forged link would authorize the
  // overwrite on the next push. Postgres-only, like the apply itself.
  const named = [...new Set(refs.map((ref) => ref.ingredientId))];
  if (named.length > 0 && (await isPostgresBackend())) {
    let ownership;
    try {
      const { getLocalIngredientRefOwnership } = await import('../catalogDB.js');
      ownership = await getLocalIngredientRefOwnership(named, kind, record.id);
    } catch (err) {
      console.warn(`⚠️ peerSync: skipped catalog bundle from ${sourceInstanceId} — local ingredient lookup failed: ${err.message}`);
      return null;
    }
    const foreign = new Set(named.filter((id) => ownership.existing.has(id) && !ownership.linked.has(id)));
    if (foreign.size > 0) {
      console.warn(`⚠️ peerSync: skipped ${foreign.size} catalog ingredients from ${sourceInstanceId} owned by another record`);
      refs = refs.filter((ref) => !foreign.has(ref.ingredientId));
      ingredients = ingredients.filter((ing) => !foreign.has(ing.id));
    }
  }
  return refs.length === 0 && ingredients.length === 0 ? null : { ingredients, refs };
}

// A project bundles only the track it links, and only when no local track has
// that id. Track records carry no sender provenance, so a track that already
// exists locally is never overwritten here — not even one the local project
// links, since a prior push can set that link (#12466). Later edits arrive
// through the Tracks category.
async function bindLinkedTrack({ record, linkedTrack, sourceInstanceId, onLookupError }) {
  if (!isPlainObject(linkedTrack) || linkedTrack.id !== record.trackId) return null;
  let localTrack;
  try {
    localTrack = await loadOrNotFound(() => RECORD_KINDS.track.load(linkedTrack.id));
  } catch (err) {
    onLookupError(err);
    return null;
  }
  if (localTrack) {
    console.warn(`⚠️ peerSync: skipped linkedTrack from ${sourceInstanceId} — a local track with that id already exists`);
    return null;
  }
  return linkedTrack;
}

/**
 * SCHEMA-VERSION GATE — runs BEFORE any merge so a sender on a newer storage
 * layout can't corrupt local state. Outside catalog, legacy senders without
 * `portosMeta` pass through (absent versions compare as zero, and their records
 * use the existing sanitizer backfill chain). When the sender
 * is AHEAD on any category, throws a structured error the route layer maps
 * to HTTP 409 + body so the sender can persist the gap on the subscription
 * and surface it in the UI. Returns `{ senderSchemaVersions }` on success —
 * the caller threads it into every merge call.
 *
 * Live catalog rows also reject sender-behind (including absent versions):
 * their whole-row LWW payload can erase fields an older sanitizer dropped.
 * Other categories retain their existing sanitizer backfill behavior.
 *
 * Extracted out of `applyIncomingPush`'s own body (#6843) — a self-contained
 * validate-or-throw step with one clear output, and one of the two chunks
 * (with the merge-dispatch ladder) needed to bring that function's
 * complexity down after collapsing the per-kind ladders to table lookups.
 */
async function assertSchemaVersionGate({ kind, record, issues, linkedCollection, catalogBundle, linkedTrack, portosMeta, sourceInstanceId }) {
  const senderSchemaVersions = isPlainObject(portosMeta?.schemaVersions) ? portosMeta.schemaVersions : {};
  const senderPortosVersion = typeof portosMeta?.portosVersion === 'string' ? portosMeta.portosVersion : null;
  // Per-category gate, scoped to the categories THIS push actually writes a
  // LIVE (non-tombstone) record into. A sender ahead on an unrelated category
  // no longer rejects this push; the full union diff stays for diagnostics.
  //
  // Tombstones are folded INTO the per-category scoping rather than exempted
  // wholesale. A tombstone payload carries only id+deleted+deletedAt+updatedAt
  // — fields that exist at EVERY schema version and can't corrupt local state
  // — so its category needn't gate, and exempting it keeps federated deletes
  // converging even when one peer upgrades ahead (otherwise blockedBySchema →
  // edit-push cooldown → the delete never lands). BUT a deleted `series` push
  // still bundles its LIVE child issues (deleteSeries does not cascade-
  // tombstone them; buildPushPayload ships every child so the receiver can
  // finish its cascade), and those live, full-shape issue records WOULD
  // corrupt an older receiver. So gate a category only when it carries at
  // least one live record:
  const relevantCategories = new Set();
  if (record.deleted !== true) {
    for (const c of (RECORD_KIND_SCHEMA_CATEGORIES[kind] || [])) relevantCategories.add(c);
  }
  if (kind === 'series' && Array.isArray(issues) && issues.some((i) => i?.deleted !== true)) {
    for (const c of RECORD_KIND_SCHEMA_CATEGORIES.issue) relevantCategories.add(c);
  }
  // A linked collection only rides a non-deleted push (buildPushPayload drops
  // it for tombstones) and is itself a live record when present. This gate
  // mirrors the merge predicate's OWNER-tombstone check (the merge refuses the
  // collection when the owner record is a tombstone) — so the gate never
  // blocks `mediaCollections` over a collection the merge would ignore. It is
  // intentionally MORE permissive on the collection itself: the extra
  // `linkedCollection.deleted !== true` check here is defensive (today's
  // exporter never bundles a deleted collection), and a tombstone collection
  // is schema-version-safe at any version anyway, so it needn't gate.
  if (record.deleted !== true && isPlainObject(linkedCollection) && linkedCollection.deleted !== true) {
    for (const c of RECORD_KIND_SCHEMA_CATEGORIES.mediaCollection) relevantCategories.add(c);
  }
  // A catalog bundle ships catalog-schema-shaped rows. Gate the `catalog`
  // category whenever the bundle carries at least one LIVE row in ANY of its
  // blocks — a sender ahead on `catalog` would otherwise push forward-shaped
  // payload an older receiver can't interpret. The check must NOT be keyed on
  // `ingredients` alone: today's exporter already emits ingredient-free
  // bundles (`refs` only), and catalog v4–v8 added `relations`, `tags`,
  // `media` and `catalogTypes` blocks — any of which a newer sender can bundle
  // with no ingredients at all, slipping past an ingredients-only gate and
  // landing forward-shaped rows on an older receiver (#3926). Scanning every
  // array-valued block rather than an enumerated key list also covers blocks
  // introduced by a FUTURE catalog version, which an older receiver cannot
  // name by definition. Tombstone-only bundles (every row deleted) are
  // id+deleted+deletedAt+updatedAt — safe at every version, so they needn't
  // gate (same reasoning as the tombstone-record exemption above).
  if (record.deleted !== true && isPlainObject(catalogBundle) && catalogEnvelopeHasLiveRows(catalogBundle)) {
    for (const c of (RECORD_KIND_SCHEMA_CATEGORIES['cat-ingredient'] || ['catalog'])) relevantCategories.add(c);
  }
  // A bundled linked track (#1858) ships a live, full-shape `track` record. Gate
  // the `tracks` category so a sender ahead on the track schema can't smuggle a
  // forward-shaped track row past the gate via a music-video push (same reasoning
  // as the linkedCollection gate above). Skip the gate for a tombstone track —
  // id+deleted+deletedAt+updatedAt is schema-safe at every version.
  if (record.deleted !== true && isPlainObject(linkedTrack) && linkedTrack.deleted !== true
      && linkedTrack.id === record.trackId) {
    for (const c of RECORD_KIND_SCHEMA_CATEGORIES.track) relevantCategories.add(c);
  }
  const fullDiff = compareSchemaVersions(senderSchemaVersions, PORTOS_SCHEMA_VERSIONS);
  const versionDiff = scopeVersionDiff(fullDiff, [...relevantCategories]);
  const catalogBehind = versionDiff.behind.some((gap) => gap.category === 'catalog');
  if (versionDiff.ahead.length > 0 || catalogBehind) {
    console.log(
      `⏸️ peerSync: rejecting push from ${sourceInstanceId} — ${formatVersionGap(versionDiff)} (sender PortOS ${senderPortosVersion || 'unknown'})`,
    );
    // Surface the receiver's PortOS version so the sender can show the user
    // *which* version their peer is on (the label the user thinks of as "the
    // peer's PortOS version"). Without this field the sender's UI would fall
    // back to its own version, which is misleading.
    const receiverPortosVersion = await getPortosVersion().catch(() => null);
    throw makeErr(
      `sender's schema is ${versionDiff.ahead.length ? 'ahead' : 'behind'} — receiver cannot apply (${formatVersionGap(versionDiff)})`,
      ERR_SCHEMA_VERSION_AHEAD,
      {
        ahead: versionDiff.ahead,
        behind: versionDiff.behind,
        senderPortosVersion,
        receiverPortosVersion,
        receiverSchemaVersions: PORTOS_SCHEMA_VERSIONS,
      },
    );
  }
  return { senderSchemaVersions };
}

// --- Receiver-side push handler -----------------------------------------

/**
 * Bundled sidecars that ride a series push: child issues, the manuscript-review
 * doc and the reverse-outline doc. A merge failure never fails the push (the
 * series already merged); the sidecar docs have no independent reconciliation
 * cycle, so a failure raises the row's pending flag via `markPending` and the
 * sender withholds its hash and retries next cycle.
 */
async function mergeSeriesSidecars({ record, issues, manuscriptReview, reverseOutline, localEphemeral, bundlesMergeable, source, senderSchemaVersions, markPending }) {
  // Issues are also skipped for a local-ephemeral series: mergeSeriesFromSync
  // refused the parent, but `updateSeries` doesn't flip child issues'
  // `ephemeral` flag, so a stale reverse subscription could otherwise
  // overwrite the private fork's issue stages. Tombstone pushes still carry
  // issue tombstones, hence `localEphemeral` rather than `bundlesMergeable`.
  if (!localEphemeral && Array.isArray(issues) && issues.length > 0) {
    await mergeIssuesFromSync(issues, { source, senderSchemaVersions });
  }
  // Sidecars write under the series record dir, so a malformed id (e.g.
  // containing `../`) would escape the series store. NOT marked pending: an
  // invalid id can never become valid, so withholding the hash would retry forever.
  const seriesIdValid = SERIES_ID_RE.test(record.id);
  if (!seriesIdValid && (isPlainObject(manuscriptReview) || isPlainObject(reverseOutline))) {
    console.warn(`⚠️ peerSync: skipped bundled series sidecars for invalid series id`);
  }
  if (!seriesIdValid || !bundlesMergeable) return;
  // Dynamic imports keep the arcPlanner graph off peerSync's load path.
  if (isPlainObject(manuscriptReview)) {
    const { mergeReviewFromSync } = await import('../pipeline/manuscriptReview.js');
    await mergeReviewFromSync(record.id, manuscriptReview).catch(markPending('manuscriptReview'));
  }
  if (isPlainObject(reverseOutline)) {
    const { mergeOutlineFromSync } = await import('../pipeline/reverseOutline.js');
    await mergeOutlineFromSync(record.id, reverseOutline).catch(markPending('reverseOutline'));
  }
}

/**
 * #1858: merge the bundled linked track so a receiver WITHOUT the Tracks
 * category can still resolve `project.trackId` at render time. The bundle's id
 * must MATCH the project's `trackId` so a malformed/malicious sender can't
 * smuggle an unrelated track through. Routed through RECORD_KINDS.track.merge so
 * exactly one place knows how to merge a track. Non-fatal; returns true only when
 * the merge RAN and succeeded (#1922: gates `linkedTrack` in `ackedDeletesUpTo`,
 * so the sender is never told a track tombstone was applied when it wasn't).
 */
async function mergeLinkedTrack({ record, linkedTrack, bundlesMergeable, source, markPending }) {
  if (!bundlesMergeable || !isPlainObject(linkedTrack) || linkedTrack.id !== record.trackId) return false;
  return RECORD_KINDS.track.merge([linkedTrack], { source }).then(() => true, (err) => {
    markPending('linkedTrack')(err);
    return false;
  });
}

/**
 * Media Collections `host` mode: this peer keeps the collection's image/video
 * bytes, so record them as peer-hosted (rendered on demand via the static-mount
 * fallback) instead of copying. Only collection-owned assets qualify — a
 * universe/series' own art still copies. Returns the still-missing assets.
 */
async function takeHostedCollectionAssets({ kind, record, desc, issues, linkedCollection, linkedTrack, sourceInstanceId, missingAssets }) {
  const senderPeer = await findPeerById(sourceInstanceId);
  if (senderPeer?.mediaSyncMode !== 'host') return missingAssets;
  const collection = kind === 'mediaCollection' ? record : linkedCollection;
  const assetKey = (entry) => `${entry.kind}:${entry.filename}`;
  const collectionKeys = new Set(isPlainObject(collection) ? referenceCollectionAssetManifest(collection).map(assetKey) : []);
  if (kind !== 'mediaCollection' && desc.referencedAssets) {
    // Assets the record itself references stay copies even when the linked
    // collection also holds them.
    for (const entry of await desc.referencedAssets(record, { issues, linkedTrack })) collectionKeys.delete(assetKey(entry));
  }
  return collectionKeys.size > 0 ? takeHostedAssets(sourceInstanceId, missingAssets, collectionKeys) : missingAssets;
}

/**
 * Writers Room: the file-primary draft `.md` bodies and bible docs ride their
 * own manifests (the generic asset pipeline keys on a flat basename + single dir
 * per kind). Diff against local disk and background-pull the missing ones from
 * the sender. `includeMismatched: workMergeApplied` is the data-safety gate — a
 * present-but-different local body is only replaced when the receiver also
 * accepted the remote record (so a stale push can't clobber newer local prose);
 * an absent body is always pulled. Returns the draft bodies still missing.
 */
async function reconcileWriterRoomBodies({ record, draftBodyManifest, bibleManifest, workMergeApplied, sourceInstanceId, pending }) {
  const { diffWorkBibleManifest } = await import('../writersRoom/bibleSync.js');
  // Scope the manifests to THIS work: an entry's path is works/<workId>/..., so
  // an entry for another workId would write bytes into a DIFFERENT local work's
  // draft. A peer may only replicate the bodies of the work it actually pushed.
  const ownBodies = Array.isArray(draftBodyManifest)
    ? draftBodyManifest.filter((e) => e && e.workId === record.id)
    : [];
  const missingDraftBodies = await diffWorkBodyManifest(ownBodies, { includeMismatched: workMergeApplied });
  const ownBibles = Array.isArray(bibleManifest) ? bibleManifest.filter((e) => e?.workId === record.id) : [];
  const bibleDiffFailed = (err) => {
    pending.add('bibleSyncPending');
    console.error(`❌ peerSync: bible diff failed: ${err.message}`);
  };
  const missingBibles = await diffWorkBibleManifest(ownBibles, { onError: bibleDiffFailed }).catch((err) => {
    bibleDiffFailed(err);
    return [];
  });
  if (missingBibles.length) {
    pending.add('bibleSyncPending');
    pullMissingWorkBibles(sourceInstanceId, missingBibles).catch((err) => {
      console.error(`❌ peerSync: bible pull failed: ${err.message}`);
    });
  }
  if (missingDraftBodies.length > 0) {
    pullMissingWorkBodies(sourceInstanceId, missingDraftBodies).catch((err) => {
      console.log(`⚠️ peerSync: draft-body pull from ${sourceInstanceId} failed: ${err.message}`);
    });
  }
  return missingDraftBodies;
}

/**
 * Cheap shape validation, run BEFORE auth and the schema-version gate. The gate's
 * 409 body includes `receiverSchemaVersions` — a mild version-fingerprint
 * disclosure — so unidentified or malformed requests get a clean 400 with no
 * version information. Returns the payload for destructuring.
 */
function assertPushEnvelopeShape(payload) {
  if (!isPlainObject(payload)) {
    throw makeErr('payload must be an object', ERR_VALIDATION);
  }
  const { kind, record, sourceInstanceId } = payload;
  if (!PEER_SUBSCRIBABLE_KINDS.includes(kind)) {
    throw makeErr(`unknown kind: ${kind}`, ERR_VALIDATION);
  }
  if (!isNonBlankStr(sourceInstanceId) || sourceInstanceId === UNKNOWN_INSTANCE_ID) {
    throw makeErr('sourceInstanceId required (and not "unknown")', ERR_VALIDATION);
  }
  if (!isPlainObject(record) || !isNonBlankStr(record.id)) {
    throw makeErr('record must be an object with a string id', ERR_VALIDATION);
  }
  return payload;
}

/**
 * Apply the bundled linkedCollection and catalog rows. Both are best-effort: the
 * record itself already merged and the next snapshot/catalog-sync cycle reconciles
 * a divergence. Both bundles are already null unless bound to the record (#12427);
 * the `bundlesMergeable` gate is kept as defense in depth against a tombstone
 * push resurrecting collection/catalog state, or a stale subscription mutating a
 * record the user opted out of syncing. Merges route through RECORD_KINDS /
 * applyCatalogBundle so each has exactly one merge implementation.
 */
async function applyLinkedBundles({ bundlesMergeable, linkedCollection, catalogBundle, portosMeta, source }) {
  if (!bundlesMergeable) return;
  if (isPlainObject(linkedCollection)) {
    await RECORD_KINDS.mediaCollection.merge([linkedCollection], { source }).catch((err) => {
      console.log(`⚠️ peerSync: linkedCollection merge failed: ${err.message}`);
    });
  }
  if (isPlainObject(catalogBundle)) {
    await applyCatalogBundle(catalogBundle, portosMeta).catch((err) => {
      console.log(`⚠️ peerSync: catalog bundle apply failed: ${err.message}`);
    });
  }
}

/**
 * Diff the pushed asset manifest against local disk and return what is missing.
 * Only assets the record (or its bundles) actually references count. A
 * non-mergeable push references nothing, so it reports no missing assets (no
 * "still syncing" UI for a record we refused).
 */
async function diffIncomingAssets({ kind, record, desc, issues, linkedCollection, linkedTrack, assetManifest, applied, bundlesMergeable, sourceInstanceId }) {
  const references = bundlesMergeable && desc.referencedAssets
    ? await desc.referencedAssets(record, { issues, linkedCollection, linkedTrack })
    : [];
  const referencedKeys = new Set(references.map((entry) => `${entry.kind}:${entry.filename}`));
  const incomingAssets = Array.isArray(assetManifest) ? assetManifest : [];
  const ownAssets = incomingAssets.filter((entry) => entry && referencedKeys.has(`${entry.kind}:${entry.filename}`));
  if (ownAssets.length < incomingAssets.length) {
    console.warn(`⚠️ peerSync: ignored ${incomingAssets.length - ownAssets.length} unreferenced push assets`);
  }
  const missingAssets = await diffAssetManifestAgainstLocal(ownAssets, { includeMismatched: applied });
  if (missingAssets.length === 0 || !bundlesMergeable) return missingAssets;
  return takeHostedCollectionAssets({ kind, record, desc, issues, linkedCollection, linkedTrack, sourceInstanceId, missingAssets });
}

/**
 * Apply an incoming push to local state. Wraps the existing `merge*FromSync`
 * dispatch + computes the asset-diff response + (best-effort) creates a
 * reverse subscription back to the sender so subsequent edits flow both
 * ways without manual re-configuration.
 *
 * The HTTP route in Stage 3 will be a thin wrapper around this — validate
 * the body shape, call this function, return the response.
 */
export async function applyIncomingPush(payload, authorization) {
  const { kind, record, issues, linkedCollection: pushedCollection, linkedTrack: pushedTrack, catalogBundle: pushedCatalog, manuscriptReview, reverseOutline, assetManifest, draftBodyManifest, bibleManifest, sourceInstanceId, portosMeta } = assertPushEnvelopeShape(payload);
  await authorizeIncomingPush(payload, authorization);

  // The gate sees the bundles as pushed: a schema-ahead sender is rejected even
  // when its bundle is later found unbound and skipped.
  const { senderSchemaVersions } = await assertSchemaVersionGate({
    kind, record, issues, linkedCollection: pushedCollection, catalogBundle: pushedCatalog, linkedTrack: pushedTrack, portosMeta, sourceInstanceId,
  });

  // Look up the LOCAL record state BEFORE merging so we can detect the
  // "local user marked this record ephemeral" case. The merge functions
  // already silently drop ephemeral records, but the side effects below
  // (linkedCollection merge, asset pull, reverse subscription) ran
  // unconditionally — meaning a stale peer subscription could still
  // mutate a local collection, download bytes the user opted out of, and
  // auto-create a reverse sub the user explicitly torn down. Computing
  // `localEphemeral` here is one extra read but closes the gap. Only kinds
  // with an ephemeral concept (`desc.hasEphemeral` — today universe/series)
  // pay for the read at all; #1858 used to also probe musicVideoProject
  // here, but the store has no ephemeral flag on that kind (see recordKinds.js),
  // so that probe's result was always false — dropped as documented drift.
  const desc = RECORD_KINDS[kind];
  const localEphemeral = desc.hasEphemeral
    ? (await desc.load(record.id).catch(() => null))?.ephemeral === true
    : false;

  // Attribute any conflict journaled by the merge below to THIS push's origin
  // peer so the Conflicts tab can show which peer collided (without `source`,
  // the merge fns fall back to `{ via:'sync', peerId:null }` and the
  // attribution is lost).
  const source = { via: 'peer-push', peerId: sourceInstanceId };
  // ENVELOPE_EXTENSIONS pending flags to echo to the sender: a bundled sidecar
  // doc whose merge threw AFTER the record itself merged is still owed, and
  // the sender withholds lastPushedHash on the flag until it lands. The record
  // push itself never fails on these.
  const pending = new Set();
  const markPending = (key) => (err) => {
    console.log(`⚠️ peerSync: ${key} merge failed: ${err.message}`);
    pending.add(ENVELOPE_PENDING_KEYS[key]);
  };
  // Bundles that are not bound to `record` are dropped here (#12427), so every
  // later use (merge, asset diff, host-mode ownership) sees only bound ones.
  // The receiver's safety rule, defined once: a local-ephemeral record or a
  // tombstone push merges no bundled sidecars, pulls no assets or bodies, and
  // binds no bundles. Every bundle/asset/body step below gates on this.
  const bundlesMergeable = !localEphemeral && record.deleted !== true;
  const linkedCollection = bundlesMergeable
    ? await bindLinkedCollection({ kind, record, linkedCollection: pushedCollection, sourceInstanceId })
    : null;
  const catalogBundle = bundlesMergeable
    ? await bindCatalogBundle({ kind, record, catalogBundle: pushedCatalog, sourceInstanceId })
    : null;
  // Only a music-video push has a linked track to bundle.
  const linkedTrack = bundlesMergeable && kind === 'musicVideoProject'
    ? await bindLinkedTrack({ record, linkedTrack: pushedTrack, sourceInstanceId, onLookupError: markPending('linkedTrack') })
    : null;
  // #1922: true only once the bundled linkedTrack merge ran and succeeded.
  let linkedTrackApplied = false;
  // Set true when a writersRoomWork merge accepted the remote (insert/remote-won)
  // — gates whether a present-but-different local draft body may be overwritten.
  let workMergeApplied = false;
  // Merge into local state via the existing LWW path, dispatched through the
  // same per-kind table isSubscriptionRecordTombstone/buildPushPayload use —
  // every PEER_SUBSCRIBABLE_KINDS entry has a descriptor (the registry guard
  // in recordKinds.test.js enforces it), so `desc` is never null here.
  // `senderSchemaVersions` rides every merge call uniformly: only
  // mergeUniversesFromSync, mergeCommissionsFromSync (both gate the
  // omitted-vs-cleared disambiguation of additive fields, #4188/#8414) and
  // mergeLoomsFromSync read it — every other merger ignores the extra key. The 12 kinds with no extra per-kind
  // behavior need nothing further; the three genuinely special kinds below
  // add their bundled-doc handling on top of this single call.
  const mergeResult = await desc.merge([record], { source, senderSchemaVersions });
  if (kind === 'series') {
    await mergeSeriesSidecars({ record, issues, manuscriptReview, reverseOutline, localEphemeral, bundlesMergeable, source, senderSchemaVersions, markPending });
  } else if (kind === 'writersRoomWork') {
    workMergeApplied = mergeResult?.applied === true;
  } else if (kind === 'musicVideoProject') {
    linkedTrackApplied = await mergeLinkedTrack({ record, linkedTrack, bundlesMergeable, source, markPending });
  }

  await applyLinkedBundles({ bundlesMergeable, linkedCollection, catalogBundle, portosMeta, source });
  const missingAssets = await diffIncomingAssets({ kind, record, desc, issues, linkedCollection, linkedTrack, assetManifest, applied: mergeResult?.applied === true, bundlesMergeable, sourceInstanceId });

  // Compute the deletedAt water-mark we can ack. Use the maximum across the
  // record + its issues + a bundled linkedTrack tombstone (#1858 bundles the
  // music-video project's linked track; #1922 folds its deletedAt into this
  // water-mark too — without it, a musicVideoProjects-only peer with no
  // independent `track` subscription would never ack a bundled track delete
  // through ANY cursor, so the sender's track-tombstone GC could prune the
  // tombstone before a transient delivery failure got a chance to retry).
  // Only pass `linkedTrack` through when `linkedTrackApplied` — i.e. the
  // merge gate above actually ran AND succeeded. Acking it unconditionally
  // would tell the sender "delivered" for a track that was skipped (mismatched
  // id, local-ephemeral, tombstoned project) or whose merge threw
  // (`trackSyncPending`), letting the sender's cursor advance past a deletion
  // this receiver never actually applied.
  // We return this to the sender so THEY can advance THEIR cursor (which
  // tracks what we — the receiver — have acked of THEIR pushes). We do
  // NOT call ackDeletesUpTo here: that would write
  // `localCursors[sourceInstanceId] = ackedDeletesUpTo`, which is
  // mis-directional. Our cursors track "what peer X has acked of OUR
  // local deletions" so tombstoneGc can prune our local tombstones once
  // every subscribed peer has confirmed receipt. The receive-side ack
  // here would let GC prune OUR older local tombstones as if peer-A had
  // seen them — even though peer-A is just telling us about ITS own
  // tombstones. In bidirectional sync, that lets peer-A's stale live
  // records resurrect after GC drops our tombstones.
  const ackedDeletesUpTo = computeAckedDeletesFromPayload(record, issues, linkedTrackApplied ? linkedTrack : null);

  // Best-effort reverse subscription. Failures don't fail the push — the
  // record is already merged and the response will tell the sender what
  // assets to push next. The reverse subscription only affects whether
  // future edits flow BACK; the user can also create one manually.
  // Skip for local-ephemeral: the user said "don't sync this record"; we
  // shouldn't auto-create a sub the next edit would push out to a peer.
  // A tombstone is not skipped here: only a local-ephemeral record (the user's
  // opt-out) blocks a reverse subscription.
  const reverseSubscriptionCreated = localEphemeral ? false : await maybeCreateReverseSubscription({
    peerId: sourceInstanceId,
    recordKind: kind,
    recordId: record.id,
  }).catch(() => false);

  // Schedule background pulls for every asset we're missing. The sender just
  // told us they have these files — fetch them via their `/data/{kind-dir}/`
  // static mount (acceptRanges enabled so resumes work over flaky Tailnet).
  // Fire-and-forget so the push response isn't blocked on a slow pull; the
  // worker emits a socket event when each asset lands so the UI can swap
  // the MediaImage placeholder for the real bytes.
  // (missingAssets is already [] for localEphemeral above, so the worker
  // can never schedule pulls for opted-out records.)
  if (missingAssets.length > 0) {
    pullMissingAssetsFromPeer(sourceInstanceId, missingAssets, { includeMismatched: mergeResult?.applied === true }).catch((err) => {
      console.log(`⚠️ peerSync: asset pull from ${sourceInstanceId} failed: ${err.message}`);
    });
  }

  // Writers Room draft bodies and bibles (see reconcileWriterRoomBodies).
  const missingDraftBodies = kind === 'writersRoomWork' && bundlesMergeable
    ? await reconcileWriterRoomBodies({ record, draftBodyManifest, bibleManifest, workMergeApplied, sourceInstanceId, pending })
    : [];

  return {
    missingAssets,
    // Surfaced like missingAssets so the sender withholds lastPushedHash while
    // bodies are still pending and keeps re-pushing until the pulls land.
    ...(missingDraftBodies.length > 0 ? { missingDraftBodies } : {}),
    reverseSubscriptionCreated,
    ackedDeletesUpTo,
    // One `<pendingKey>: true` per sidecar doc whose merge threw, keyed off the
    // same ENVELOPE_EXTENSIONS table the sender reads them back from.
    ...Object.fromEntries([...pending].map((k) => [k, true])),
  };
}

function computeAckedDeletesFromPayload(record, issues, linkedTrack) {
  let max = 0;
  const consider = (rec) => {
    if (!rec?.deleted || !isStr(rec.deletedAt)) return;
    const ms = Date.parse(rec.deletedAt);
    if (Number.isFinite(ms) && ms > max) max = ms;
  };
  consider(record);
  if (Array.isArray(issues)) for (const i of issues) consider(i);
  consider(linkedTrack);
  return max;
}

async function maybeCreateReverseSubscription({ peerId, recordKind, recordId }) {
  // Skip if a subscription back to the sender already exists.
  const existing = await findPeerSubscription(peerId, recordKind, recordId);
  if (existing) return false;

  // Cheap in-memory checks FIRST. Honor the per-peer `directions` flag — a
  // peer marked inbound-only is one we accept pushes FROM but never push
  // back TO — auto-creating a reverse subscription would break that
  // explicit configuration. Doing this BEFORE the ephemeral-record disk
  // read (classifyLocalRecord's `desc.load` below) means inbound-only /
  // unknown peers don't trigger an extra record read on every incoming push.
  const peer = await findPeerById(peerId);
  if (!peer) return false;
  const directions = Array.isArray(peer.directions) ? peer.directions : [];
  if (directions.length > 0 && !directions.includes('outbound')) return false;

  // Now the disk read: only reverse-subscribe when the local record exists
  // AND is non-ephemeral. Three reasons to hard-stop on missing/read-failed:
  //
  // 1. Ephemeral: auto-creating a reverse sub for a local-only record
  //    would accumulate orphan rows in peer_subscriptions.json. Every
  //    future edit on the local side fires recordEvents.updated →
  //    triggerPushForRecord → pushRecordToPeer → buildPushPayload →
  //    sanitizeRecordForWire returns null (ephemeral filter) → push
  //    aborts with "record-not-found". The sub burns an asset-manifest
  //    sha-pass on every edit and never sends bytes. The merge path
  //    upstream already refused the inbound edit (local-ephemeral →
  //    continue), so the sender's record state isn't reflected locally
  //    anyway — there's nothing meaningful to push back.
  //
  // 2. Record-missing: the sender pushed a record that passed Zod but was
  //    dropped by the service sanitizer (missing name, etc.). The merge
  //    never created the local copy, so a reverse sub would point at a
  //    nonexistent record and every push would resolve to null. Same
  //    orphan-row dynamic as ephemeral, but worse because there's never
  //    going to be a record to clear it via the ephemeral lifecycle
  //    transition.
  //
  // 3. Read-failed: a transient IO error reading the record file —
  //    treating it as "non-ephemeral, go ahead and subscribe" can create
  //    a sub for a record that turns out to be ephemeral once the IO
  //    settles. Conservative default: don't subscribe.
  const localState = await classifyLocalRecord(recordKind, recordId);
  if (localState !== 'syncable') return false;

  const sub = await subscribePeer({ peerId, recordKind, recordId }, { adoptedFromReverse: true });
  // subscribePeer is idempotent — only announce when a row was genuinely
  // inserted (created=true). The existing-sub short-circuit at the top of
  // this function already returns early, but guarding on `created` keeps the
  // event honest if a race ever lands an identical row between the
  // findPeerSubscription check and the insert. `sharing/index.js` wires this
  // to the `peerSync:subscription:created` socket event so the Instances page
  // re-fetches that peer's subs without a manual reload.
  if (sub?.created) {
    peerSyncEvents.emit('subscription-created', {
      peerId,
      recordKind,
      recordId,
      subId: sub.id,
    });
  }
  return true;
}

/**
 * Look up the local record (live or tombstoned) and tri-state-classify it
 * for the reverse-subscribe gate. Returns one of:
 *
 *   'syncable'   — record exists, is non-ephemeral; safe to reverse-subscribe.
 *   'ephemeral'  — record exists but is local-only; reverse-subscribe would
 *                  accumulate an orphan sub that never sends bytes.
 *   'missing'    — record is not on disk OR a read error occurred; can't
 *                  classify, so the conservative default is to skip the
 *                  reverse-subscribe (callers treat anything other than
 *                  'syncable' as a no-go).
 *
 * Includes deleted records on the lookup so a tombstone-as-state record
 * still gets classified as 'syncable' (we WANT peer pushes to converge
 * a deleted record's tombstone if they're targeting it). Every kind but
 * universe/series has no ephemeral concept at all (`desc.hasEphemeral ===
 * false`), so a found record there is always 'syncable' — that's what lets
 * an inbound push of those kinds bootstrap bidirectional sync with no
 * ping-pong risk (the lastPushedHash short-circuit + LWW same-`updatedAt`
 * no-op merge prevent it).
 */
async function classifyLocalRecord(recordKind, recordId) {
  const desc = RECORD_KINDS[recordKind];
  if (!desc) return 'missing';
  const record = await desc.load(recordId).catch(() => null);
  if (!record) return 'missing';
  return desc.hasEphemeral && record.ephemeral === true ? 'ephemeral' : 'syncable';
}
