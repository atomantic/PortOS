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
 * Absent categories default to 0. Receivers choose which mismatch directions
 * to reject; live catalog rows require equality even for unversioned peers.
 * Future PRs that introduce a layout change for `series`, `issues`, etc.
 * add an entry here.
 */

import { join } from 'path';
import { PATHS, tryReadFile, safeJSONParse } from './fileUtils.js';

export const PORTOS_SCHEMA_VERSIONS = Object.freeze({
  // Numeric-only peer wire payload for app quality (GET /api/apps/quality-federation); the .quality.json file format is versioned separately.
  appQuality: 1,
  // Memory pull capability; each receiver keeps its own monotonic history.
  memoryHistory: 1,
  // Universe canon layout (characters, places, objects, styles, mood-board link); v22 = place `world` map.
  universes: 22,
  // Pipeline issue record (stages, arc role, shot framings); v6 = shot framing `group`.
  pipelineIssues: 6,
  // Pipeline series record (arc, styleGuide, characterArcs, exportSettings); v14 = author-owned `arc.seriesDesign`.
  pipelineSeries: 14,
  // Media collections; v2 = per-item `removedItems` removal records.
  mediaCollections: 2,
  // Video history snapshot rows; v1 = Make-primary designation (`primaryInstanceId`/`primaryAt`).
  videoHistory: 1,
  // Card decks; v2 = deck-level `cardOrientation` and `cardOrientationPrompt`.
  decks: 2,
  // Storyboards (boards, beats, panels, takes); v15 = panel `linkMedia`.
  storyboards: 15,
  // Author personas (per-record push).
  authors: 1,
  // Artists; v2 = press and submission profile.
  artists: 2,
  // Albums.
  albums: 1,
  // Tracks and render history; v13 = `sunoSongId` on takes.
  tracks: 13,
  // Creative ingredient catalog (ingredients, scraps, relations, tags, media, user types); live rows need an exact match, tombstones do not; v17 = place/object `size`.
  catalog: 17,
  // Story Builder sessions, synced only when `sync: true`.
  storyBuilder: 1,
  // FableLoom story graph; v16 = Google backend pins in `renderSettings`.
  fableLoom: 16,
  // Creative Director projects; v10 = validated assembled cuts and retained cut history.
  creativeDirectorProjects: 10,
  // Mood boards; v2 = `video` board items.
  moodBoards: 2,
  // Writers Room works (manifest, draft-version metadata, bible siblings); draft prose rides its own body manifest.
  writersRoomWorks: 1,
  // Writers Room folders (body-less, tombstoned).
  writersRoomFolders: 1,
  // Writers Room exercises (body-less).
  writersRoomExercises: 1,
  // Music video project body (LWW whole); v63 = title card slide-in, own fade-out and steady flag.
  musicVideoProjects: 63,
  // Creative Commission feedback reactions (body-less, tombstoned).
  commissionFeedback: 1,
  // Creative Commission brief (schedule and runs stay machine-local); v9 = Google backend pins in `generation`.
  creativeCommissions: 9,
  // Media-library manifest envelope (receiver-pull; ahead senders are skipped, not rejected).
  mediaLibrary: 1,
  // CoS history archive manifest envelope (receiver-pull; ahead senders are skipped).
  cosHistory: 1,
  // CoS task queues and claim metadata (receiver-pull, claim-aware merge); v11 = retry-episode and dispatch proof.
  cosTasks: 11,
  // Eidoverse foundation offering envelope and withdrawal tombstones (receiver-pull); v3 = `tombstones`.
  eidoverseFoundations: 3,
  // Meatspace daily-log snapshot; v2 = identity-keyed blood, epigenetic and eye rows with `rowTombstones`.
  meatspace: 2,
  // Paired-peer credential handshake (`X-PortOS-Peer-Auth`), advertised in health details.
  peerAuth: 1,
  // Image `createdAt` on push asset manifests (capability, advertised in health details).
  peerAssetStamps: 1,
  // The gate is per-category (`scopeVersionDiff`, used at the dataSync, peerSync and sharing call sites):
  // a bump blocks only transfers of that category, so unrelated categories keep flowing.
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
  fableLoom: Object.freeze(['fableLoom']),
  creativeDirectorProject: Object.freeze(['creativeDirectorProjects']),
  moodBoard: Object.freeze(['moodBoards']),
  writersRoomWork: Object.freeze(['writersRoomWorks']),
  writersRoomFolder: Object.freeze(['writersRoomFolders']),
  writersRoomExercise: Object.freeze(['writersRoomExercises']),
  musicVideoProject: Object.freeze(['musicVideoProjects']),
  commissionFeedback: Object.freeze(['commissionFeedback']),
  creativeCommission: Object.freeze(['creativeCommissions']),
  deck: Object.freeze(['decks']),
  storyboard: Object.freeze(['storyboards']),
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
 * - `eidoverseFoundations` (#7455): the promoted Eidoverse foundation candidates
 *   an install advertises at GET /api/peer-sync/eidoverse-foundations. Same
 *   receiver-pull shape as `cosTasks` (see syncEidoverseFoundationsFromPeer) —
 *   no push to gate, so no RECORD_KIND_SCHEMA_CATEGORIES entry. A foundation is
 *   not a peer-subscribable record kind and never rides the record pipeline.
 *
 * `appQuality`: numeric-only local evidence at GET /api/apps/quality-federation,
 * validated against its exact wire version by collectAppQuality; never written or pushed.
 * The repository file format is versioned separately (`appQualitySnapshotFormat.js`)
 * and a file-schema change must not bump this wire version.
 *
 * `meatspace` (#8143): the daily-log snapshot category, gated by dataSync
 * `applyRemote` through SNAPSHOT_CATEGORY_SCHEMA_KEYS; meatspace is never a
 * per-record push.
 *
 * `peerAssetStamps` (#14067): advertised by the receiver's health details; it
 * gates whether a sender adds image `createdAt` to push manifests, never a
 * record transfer.
 *
 * `videoHistory` (#14093): gates the `videoHistory` SNAPSHOT apply (dataSync.js
 * SNAPSHOT_CATEGORY_SCHEMA_KEYS); video rows never ride the per-record push.
 *
 * `peerAuth` (#8356): the peer credential handshake version, advertised by the
 * receiver's health details; it gates which header a sender presents, never a
 * record transfer.
 *
 * Do NOT add a real record-push category here to silence the guard — that would
 * leave its push transfers ungated (silent cross-install corruption). Only
 * genuinely non-push categories belong.
 */
export const NON_RECORD_SCHEMA_CATEGORIES = Object.freeze(new Set(['memoryHistory', 'mediaLibrary', 'cosHistory', 'cosTasks', 'appQuality', 'eidoverseFoundations', 'meatspace', 'peerAuth', 'peerAssetStamps', 'videoHistory']));

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
 * Absent or invalid entries are compared as zero. A legacy sender without
 * `portosMeta` is behind every versioned receiver category; callers decide
 * whether those behind gaps block the transfer.
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

/** Catalog row blocks share `deleted`, except user types use `deletedAt`.
 * Unknown blocks and malformed rows conservatively count as live so a future
 * payload cannot bypass the version gate. Envelope metadata is not a row block.
 */
export function catalogEnvelopeHasLiveRows(envelope) {
  return Object.entries(envelope).some(([kind, block]) => Array.isArray(block) && block.some(
    (row) => kind === 'catalogTypes' ? !row?.deletedAt : row?.deleted !== true,
  ));
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
