// Shared peer sync-category policy. This module performs no I/O.

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
//
// `syncEnabled` is derived from this, and it is NOT a cosmetic flag: it also
// gates per-record OUTBOUND pushes (`peerAllowsOutbound`). A default-ON category
// must therefore never flip it on by itself, or adding one would silently widen
// what every existing peer is allowed to receive.
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
 * The effective sync-category map for a peer — the single resolution of "what
 * syncs with this peer", used by BOTH the sync loop (syncOrchestrator) and the
 * client-facing peer payload (sanitizePeerForClient). Two resolvers would drift,
 * and the UI would then show something the loop doesn't do.
 *
 * The rules, in order:
 *  - A full-sync ("mirror everything") peer implies every current AND future
 *    category on, whatever its stored map says.
 *  - The shipped defaults sit UNDER the stored map, so a category added after
 *    this peer record was written picks up its default instead of reading as
 *    `undefined` (= off) forever. No migration needed; a key the user actually
 *    toggled is present in the stored map and always wins.
 *  - **A default-ON category defaults on only for a peer the user established.**
 *    `handleAnnounce` auto-creates an inbound-only record for any host that can
 *    reach the port, with no approval step — so letting a default reach those
 *    would start pulling an unknown machine's data into this install the moment
 *    it announced itself. An explicit stored `true` still wins there: if the
 *    user ticked the box for an inbound peer, that is a decision, not a default.
 *  - `masterSwitch` (default true) applies `syncEnabled: false` — the user's
 *    "don't replicate my content to this peer" switch — by masking the result
 *    down to the default-ON categories rather than silencing the peer outright.
 *    Pass `false` to read what the user has CONFIGURED, independent of that
 *    switch (what the settings UI renders). Disabling the PEER
 *    (`enabled: false`) always stops everything, in either mode.
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
  // Video-history rows are the metadata half of Media Collections: a synced
  // collection's `{ kind:'video' }` items only render once the matching row
  // exists. There is no separate user-facing toggle, so `mediaCollections`
  // implies `videoHistory`; a legacy peer that only had `videoHistory` on keeps
  // it (OR, never AND), so upgrading stops nothing that was flowing.
  const stored = storedRaw.mediaCollections ? { ...storedRaw, videoHistory: true } : storedRaw;
  if (!masterSwitch || peer?.syncEnabled !== false) return stored;
  return Object.fromEntries(DEFAULT_ON_SYNC_CATEGORIES.map((key) => [key, stored[key] === true]));
}

// A category map with every key forced on — the effective view a full-sync
// ("mirror everything") peer presents. Derived from DEFAULT_SYNC_CATEGORIES so a
// newly added category is covered by full-sync peers with no per-peer change.
// Used by the snapshot orchestrator (what a full-sync peer pulls) and the
// reciprocation send (the all-on map a full-sync peer asks its mirror to adopt).
export function allSyncCategoriesOn() {
  return Object.fromEntries(Object.keys(DEFAULT_SYNC_CATEGORIES).map((k) => [k, true]));
}

