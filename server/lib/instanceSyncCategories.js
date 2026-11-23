// Shared peer sync-category policy. This module performs no I/O.
//
// Pure peer sync-category defaults and `resolveEffectiveCategories`, shared by instance management and
// usage coverage. `instances.js` re-exports the existing public policy names.

// Default sync categories. Everything that replicates the user's own CONTENT is
// off until explicitly enabled per-peer; the exception is `usage`, which is
// default-ON (see DEFAULT_ON_SYNC_CATEGORIES below).
export const DEFAULT_SYNC_CATEGORIES = {
  brain: false,
  memory: false,
  goals: false,
  character: false,
  digitalTwin: false,
  meatspace: false,
  universe: false,
  pipeline: false,
  mediaCollections: false,
  videoHistory: false,
  storyBuilder: false,
  // ON by default — the only category that is. Rationale + the rules that
  // follow from it: docs/decisions/2026-09-01-federated-usage-metrics.md.
  usage: true,
  fableLoom: false,
  authors: false,
  artists: false,
  albums: false,
  tracks: false,
  creativeDirectorProjects: false,
  moodBoards: false,
  writersRoomWorks: false,
  writersRoomFolders: false,
  writersRoomExercises: false,
  musicVideoProjects: false,
  commissionFeedback: false,
  creativeCommissions: false,
  decks: false,
  storyboards: false,
  catalog: false
};

// Categories that stay on for a peer even when the user's master `syncEnabled`
// switch is off — that switch predates them and means "don't replicate my
// content to this peer", so it must not silently retract a default-ON one.
// Turning one off is an explicit per-category act; disabling the PEER
// (`enabled: false`) still stops everything.
export const DEFAULT_ON_SYNC_CATEGORIES = Object.freeze(
  Object.entries(DEFAULT_SYNC_CATEGORIES).filter(([, on]) => on).map(([key]) => key)
);
const DEFAULT_ON_SET = new Set(DEFAULT_ON_SYNC_CATEGORIES);

/** Is this category one that ships ON? The single definition of that policy. */
export const isDefaultOnCategory = (key) => DEFAULT_ON_SET.has(key);

// Does this category map enable anything the user actually opted into?
// `syncEnabled` is derived from this and also gates per-record OUTBOUND pushes
// (`peerAllowsOutbound`), so a default-ON category must never flip it on by
// itself or it would silently widen what every existing peer may receive.
export function hasOptedInCategory(categories) {
  return Object.entries(categories || {}).some(([key, on]) => on === true && !isDefaultOnCategory(key));
}

/**
 * Did the USER establish this peer relationship from this machine? Mirrors
 * `peerAllowsOutbound`'s reading of `directions`: an absent/empty array is a
 * legacy record (permissive), `['outbound']` is a peer the user added here, and
 * `['inbound']` is one that merely ANNOUNCED itself to us and was auto-created
 * by `handleAnnounce` — never approved by anyone.
 */
function peerUserEstablished(peer) {
  const directions = Array.isArray(peer?.directions) ? peer.directions : [];
  return directions.length === 0 || directions.includes('outbound');
}

/**
 * The effective sync-category map for a peer — the single resolution used by
 * BOTH the sync loop (syncOrchestrator) and the client-facing peer payload
 * (sanitizePeerForClient), so the UI never shows something the loop doesn't do.
 *
 *  - A full-sync peer implies every current AND future category on.
 *  - Shipped defaults sit UNDER the stored map, so a category added later picks
 *    up its default instead of reading as `undefined` (= off); a key the user
 *    toggled always wins.
 *  - **A default-ON category defaults on only for a peer the user established.**
 *    `handleAnnounce` auto-creates an inbound-only record for any host that can
 *    reach the port with no approval step, so a default must not start pulling
 *    an unknown machine's data. An explicit stored `true` still wins.
 *  - `masterSwitch` (default true) applies `syncEnabled: false` by masking the
 *    result down to the default-ON categories. Pass `false` to read what the
 *    user has CONFIGURED (what the settings UI renders). Disabling the PEER
 *    (`enabled: false`) always stops everything.
 */
export function resolveEffectiveCategories(peer, { masterSwitch = true } = {}) {
  if (peer?.fullSync === true) return allSyncCategoriesOn();
  const defaults = { ...DEFAULT_SYNC_CATEGORIES };
  if (!peerUserEstablished(peer)) {
    for (const key of DEFAULT_ON_SYNC_CATEGORIES) defaults[key] = false;
  }
  const storedRaw = peer?.syncCategories
    ? { ...defaults, ...peer.syncCategories }
    // Legacy fallback: a peer with no stored map but sync on gets brain+memory,
    // the pre-per-category behavior.
    : { ...defaults, ...(peer?.syncEnabled !== false ? { brain: true, memory: true } : {}) };
  // Video-history rows are the metadata half of Media Collections (synced
  // `{ kind:'video' }` items render only once the row exists), so
  // `mediaCollections` implies `videoHistory`; OR, never AND, so a legacy peer
  // with only `videoHistory` keeps it.
  const stored = storedRaw.mediaCollections ? { ...storedRaw, videoHistory: true } : storedRaw;
  if (!masterSwitch || peer?.syncEnabled !== false) return stored;
  return Object.fromEntries(DEFAULT_ON_SYNC_CATEGORIES.map((key) => [key, stored[key] === true]));
}

// A category map with every key forced on — the effective view of a full-sync
// peer. Derived from DEFAULT_SYNC_CATEGORIES so new categories are covered
// with no per-peer change.
export function allSyncCategoriesOn() {
  return Object.fromEntries(Object.keys(DEFAULT_SYNC_CATEGORIES).map((k) => [k, true]));
}


// Subscribable per-record kind → the per-peer `syncCategories` key gating auto-subscribe (inverse of
// syncOrchestrator.js `categoriesCoveredByPeerSync`). Single source: the server validators, instance
// toggle backfill, integrity listers and the client controls all derive from it (#17724). `series`
// rides the `pipeline` category (it bundles child issues at push time).
export const KIND_TO_CATEGORY = Object.freeze({
  universe: 'universe',
  series: 'pipeline',
  mediaCollection: 'mediaCollections',
  author: 'authors',
  artist: 'artists',
  album: 'albums',
  track: 'tracks',
  creativeDirectorProject: 'creativeDirectorProjects',
  moodBoard: 'moodBoards',
  fableLoom: 'fableLoom',
  writersRoomWork: 'writersRoomWorks',
  writersRoomFolder: 'writersRoomFolders',
  writersRoomExercise: 'writersRoomExercises',
  musicVideoProject: 'musicVideoProjects',
  commissionFeedback: 'commissionFeedback',
  creativeCommission: 'creativeCommissions',
  deck: 'decks',
  storyboard: 'storyboards',
});

export const PEER_SUBSCRIBABLE_KINDS = Object.freeze(Object.keys(KIND_TO_CATEGORY));

// `[category, kind]` pairs: categories whose records ride the per-record push pipeline, so a false→true
// toggle backfills existing local records of that kind.
export const PER_RECORD_CATEGORY_KINDS = Object.freeze(
  Object.entries(KIND_TO_CATEGORY).map(([kind, cat]) => Object.freeze([cat, kind])),
);
