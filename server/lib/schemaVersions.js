/**
 * PortOS schema-version contract for cross-instance sync: lets a receiver detect a version mismatch BEFORE applying records it can't parse.
 *
 * `PORTOS_SCHEMA_VERSIONS` is the per-sync-category WIRE contract, distinct from the storage-layout version on `data/{type}/index.json` (each service's `TYPE_SCHEMA_VERSION`).
 * Bump it for (a) a storage layout change (ship the matching `scripts/migrations/NNN-…js` too) or (b) an additive record-shape change a not-yet-upgraded peer would strip on round-trip.
 * The number flows through every outbound `portosMeta.schemaVersions`; receivers reject ahead-mismatches (sender too new) or behind-mismatches (sender too old for a forward-only field).
 * Absent categories default to 0; live record pushes also enforce the per-category minimums below.
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
  // Pipeline issues; v7 omits stage run history, which older receivers would erase on overwrite.
  pipelineIssues: 7,
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
  // Music video project body (LWW whole); v64 = last MIDI transcription failure.
  musicVideoProjects: 64,
  // Creative Commission feedback reactions (body-less, tombstoned).
  commissionFeedback: 1,
  // Creative Commission brief (schedule and runs stay machine-local); v9 = Google backend pins in `generation`.
  creativeCommissions: 9,
  // Media-library manifest envelope (receiver-pull; ahead senders are skipped, not rejected).
  mediaLibrary: 1,
  // CoS history archive manifest envelope (receiver-pull; ahead senders are skipped).
  cosHistory: 1,
  // CoS task queues and claim metadata (receiver-pull, claim-aware merge); v13 = one spawn counter and no spawn-budget proof metadata; a v12 peer would hold every such task (#16807).
  cosTasks: 13,
  // Eidoverse foundation offering envelope and withdrawal tombstones (receiver-pull); v3 = `tombstones`.
  eidoverseFoundations: 3,
  // Meatspace daily-log snapshot; v2 = identity-keyed blood, epigenetic and eye rows with `rowTombstones`.
  meatspace: 2,
  // Paired-peer credential handshake (`X-PortOS-Peer-Auth`), advertised in health details.
  peerAuth: 1,
  // Image `createdAt` on push asset manifests (capability, advertised in health details).
  peerAssetStamps: 1,
  // The gate is per-category (`scopeVersionDiff`): a bump blocks only transfers of that category.
});

/**
 * Map a federated record KIND to the `PORTOS_SCHEMA_VERSIONS` categories its storage layout touches. The gate only checks categories being written.
 * Kinds absent here carry no versioned layout and are never gated; a push bundling other kinds unions their categories at the call site.
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
 * Minimum sender wire versions for live record pushes. Tombstones carry no
 * versioned body. Categories omitted here can backfill older live payloads.
 */
export const RECORD_SCHEMA_MIN_SENDER_VERSIONS = Object.freeze({
  // Live catalog rows require equality because older peers drop newer fields.
  catalog: PORTOS_SCHEMA_VERSIONS.catalog,
  // v54 replaced previz.night with timeline and cast-bound vehicles. A whole
  // project save from an older peer can overwrite these migrated fields.
  musicVideoProjects: 54,
});

/**
 * Versioned categories NOT reachable from a record push: they ride their OWN transport and compatibility gate, so the gate-map-completeness guard needs no
 * `RECORD_KIND_SCHEMA_CATEGORIES` mapping for them. Do NOT add a real record-push category here to silence the guard (its transfers would go ungated).
 *
 * - `mediaLibrary`, `cosHistory`, `cosTasks`, `eidoverseFoundations`: manifests a full-sync peer advertises under /api/peer-sync/*; the RECEIVER pulls and GENTLY SKIPS a sender
 *   ahead of its version (`cosTasks` also merges claim-aware per task). Nothing is pushed.
 * - `appQuality`: numeric-only local evidence at GET /api/apps/quality-federation, validated by collectAppQuality, never written or pushed; the repo file format is versioned
 *   separately (`appQualitySnapshotFormat.js`) and must not bump this version.
 * - `meatspace`, `videoHistory`: SNAPSHOT categories gated by dataSync via SNAPSHOT_CATEGORY_SCHEMA_KEYS, never per-record pushes.
 * - `peerAssetStamps`, `peerAuth`: capabilities advertised in the receiver's health details; they gate what a sender adds or which header it presents, never a record transfer.
 */
export const NON_RECORD_SCHEMA_CATEGORIES = Object.freeze(new Set(['memoryHistory', 'mediaLibrary', 'cosHistory', 'cosTasks', 'appQuality', 'eidoverseFoundations', 'meatspace', 'peerAuth', 'peerAssetStamps', 'videoHistory']));

/**
 /** Lazy-read the PortOS version from the ROOT package.json (so a pull-and-restart picks it up); '0.0.0' when PATHS.root has none (tests). Mirrors `updateChecker.getCurrentVersion`. */
export async function getPortosVersion() {
  const pkgPath = join(PATHS.root, 'package.json');
  const raw = await tryReadFile(pkgPath);
  if (!raw) return '0.0.0';
  const parsed = safeJSONParse(raw, null);
  return typeof parsed?.version === 'string' && parsed.version ? parsed.version : '0.0.0';
}

/**
 /**
  * Build the `portosMeta` envelope every outbound sync payload carries (`{ portosVersion, schemaVersions }`). Receivers feed `schemaVersions` to
  * `compareSchemaVersions(sender, PORTOS_SCHEMA_VERSIONS)`; `portosVersion` is a UI label only, since the on-disk shape is what the gate runs on.
  */
export async function buildPortosMeta(overrides = {}) {
  const portosVersion = await getPortosVersion();
  return {
    portosVersion,
    schemaVersions: { ...PORTOS_SCHEMA_VERSIONS, ...(overrides.schemaVersions || {}) },
  };
}

/**
 /**
  * Compare a peer's schemaVersions against local expectations, returning a structured diff so callers can say WHICH category mismatched and which way.
  *   ahead[]  - SENDER newer than RECEIVER; the payload can't be safely applied.
  *   behind[] - SENDER older; the sanitizer can usually backfill but forward-only contracts may need an upgrade, so callers decide whether to gate.
  *   compatible - `true` only when neither list has entries.
  * Absent or invalid entries compare as zero; a legacy sender without `portosMeta` is behind every versioned category.
  */
export function compareSchemaVersions(senderVersions = {}, receiverVersions = PORTOS_SCHEMA_VERSIONS) {
  const sender = senderVersions && typeof senderVersions === 'object' ? senderVersions : {};
  const receiver = receiverVersions && typeof receiverVersions === 'object' ? receiverVersions : {};
  const ahead = [];
  const behind = [];
  // Walk the UNION of keys: catches a sender category the receiver doesn't know (ahead) and a receiver-required one the sender lacks (behind).
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
 /**
  * Restrict a comparator result to the categories actually being transferred. `compareSchemaVersions` walks the UNION for diagnostics, but the GATE must be per-category
  * so an unrelated bumped category can't block this transfer (and the scoped `ahead` doesn't mis-attribute a gap).
  * Non-array `categories` returns the diff unchanged (whole-payload gate); an empty array means nothing can block.
  */
export function scopeVersionDiff(diff = {}, categories) {
  if (!Array.isArray(categories)) return diff;
  const allow = new Set(categories);
  const ahead = (Array.isArray(diff.ahead) ? diff.ahead : []).filter((g) => allow.has(g.category));
  const behind = (Array.isArray(diff.behind) ? diff.behind : []).filter((g) => allow.has(g.category));
  return { ahead, behind, compatible: ahead.length === 0 && behind.length === 0 };
}

/**
 /**
  * Human-readable explanation of a comparator result (log lines, UI badge tooltip, peer-sync 409), kept in one place so they describe the gap identically:
  *   formatVersionGap({ ahead: [{ category: 'universes', senderV: 5, receiverV: 4 }] }) → 'sender ahead of receiver on universes (v5 vs v4)'
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
