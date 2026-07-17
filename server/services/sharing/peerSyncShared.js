/**
 * Federated peer-sync — shared kernel.
 *
 * The state machine (subscription file read/write + the single serialized
 * write tail), error constants, tiny predicates, the subscribable-kind list,
 * the kind→category map + peer-capability predicates, and the cross-cutting
 * event bus that every peer-sync module emits on. This is the leaf of the
 * peer-sync module graph: it imports nothing from its siblings, so they can
 * all import from it without an evaluation-order cycle.
 *
 * Split out of the former 4,004-line peerSync.js (#1830).
 */
import { join } from 'path';
import { EventEmitter } from 'events';
import { PATHS, atomicWrite, readJSONFile, ensureDir } from '../../lib/fileUtils.js';
import { getPeers } from '../instances.js';


export const PEER_SUBSCRIBABLE_KINDS = Object.freeze(['universe', 'series', 'mediaCollection', 'author', 'artist', 'album', 'track', 'creativeDirectorProject', 'moodBoard', 'writersRoomWork', 'writersRoomFolder', 'writersRoomExercise', 'musicVideoProject', 'commissionFeedback']);

/**
 * Cross-cutting event bus for the peer-sync receiver. The asset-pull worker
 * emits `asset-arrived` ({ filename, kind, peerId }) when a previously-missing
 * file lands locally; `sharing/index.js` wires that to a socket emission so
 * the client's MediaImage component can swap its "syncing" placeholder for
 * the real bytes without polling. `maybeCreateReverseSubscription` emits
 * `subscription-created` ({ peerId, recordKind, recordId, subId }) when an
 * incoming push auto-creates a reverse subscription, which `sharing/index.js`
 * relays as the `peerSync:subscription:created` socket event so the Instances
 * page can re-fetch that peer's subscriptions without a manual reload.
 */
export const peerSyncEvents = new EventEmitter();
peerSyncEvents.setMaxListeners(100);

export const ERR_NOT_FOUND = 'PEER_SYNC_SUBSCRIPTION_NOT_FOUND';
export const ERR_VALIDATION = 'PEER_SYNC_SUBSCRIPTION_VALIDATION';
// Receiver-side rejection — the incoming payload's `portosMeta.schemaVersions`
// is ahead of our local PORTOS_SCHEMA_VERSIONS for one or more categories,
// so applying the record would corrupt local state. The HTTP route maps this
// to 409 + a structured body { ahead, behind, senderPortosVersion } so the
// sender can persist the gap on the subscription and surface it in the UI.
export const ERR_SCHEMA_VERSION_AHEAD = 'PEER_SYNC_SCHEMA_VERSION_AHEAD';
export const makeErr = (message, code, details = null) => {
  const err = new Error(message);
  err.code = code;
  if (details) err.details = details;
  return err;
};

const STATE_PATH = () => join(PATHS.data, 'sharing', 'peer_subscriptions.json');
export const DEBOUNCE_MS = 3000;
export const PUSH_TIMEOUT_MS = 30000;

export const isNonEmptyStr = (v) => typeof v === 'string' && v.length > 0;

export function subscriptionId({ peerId, recordKind, recordId }) {
  return `peer-${recordKind}-${recordId}-${peerId}`;
}

export async function readState() {
  await ensureDir(join(PATHS.data, 'sharing'));
  const raw = await readJSONFile(STATE_PATH(), { subscriptions: [] }, { logError: false });
  const subs = Array.isArray(raw?.subscriptions) ? raw.subscriptions : [];
  return { subscriptions: subs };
}

export async function writeState(state) {
  await ensureDir(join(PATHS.data, 'sharing'));
  await atomicWrite(STATE_PATH(), state);
}

// Serialize every readState→modify→writeState pair through a single tail
// promise. The push pipeline runs fire-and-forget after each subscribe; its
// `persistPushSuccess` writes race the subscribe's own writes for the same
// file, and a naive concurrent run can clobber a just-persisted record
// (subscribe-s1 reads [u1] from file, push-u1 finishes by writing [u1+meta],
// subscribe-s1 writes [u1, s1] from its stale in-memory copy, AND VICE VERSA
// where push-u1 reads [u1] mid-write and clobbers [u1, s1] with [u1+meta]).
// Single-user / single-instance app, so a module-level tail is sufficient.
let writeTail = Promise.resolve();
export function withStateLock(fn) {
  const next = writeTail.then(() => fn(), () => fn());
  writeTail = next.catch(() => {});
  return next;
}

// Map a subscribable record kind to the per-peer `syncCategories` key that
// controls whether auto-subscribe is allowed for that kind. Matches the
// inverse mapping in syncOrchestrator.js `categoriesCoveredByPeerSync`.
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
  writersRoomWork: 'writersRoomWorks',
  writersRoomFolder: 'writersRoomFolders',
  writersRoomExercise: 'writersRoomExercises',
  musicVideoProject: 'musicVideoProjects',
  commissionFeedback: 'commissionFeedback',
});

export function peerAllowsOutbound(peer) {
  if (!peer || peer.enabled === false) return false;
  // `syncEnabled` is the global "sync this peer at all" toggle (separate from
  // per-category `syncCategories.*`). When the user has globally disabled sync
  // for a peer, auto-subscribe MUST NOT create subscriptions or fire pushes —
  // doing so would leak records to a peer the user explicitly silenced. The
  // per-category check (peerHasCategory) is necessary but not sufficient on
  // its own, because syncCategories can be set independently.
  if (peer.syncEnabled === false) return false;
  const directions = Array.isArray(peer.directions) ? peer.directions : [];
  if (directions.length > 0 && !directions.includes('outbound')) return false;
  return true;
}

export function peerHasCategory(peer, recordKind) {
  const cat = KIND_TO_CATEGORY[recordKind];
  if (!cat) return false;
  // A full-sync ("mirror everything") peer implies every current and future
  // category on — so a newly added subscribable kind is covered with no
  // per-peer change. This is what makes the back-subscribe sweep, the
  // peer:online convergence, and auto-subscribe-on-create all fan a full-sync
  // peer's mirror without enumerating categories by hand.
  if (peer?.fullSync === true) return true;
  const cats = peer?.syncCategories;
  return !!(cats && cats[cat] === true);
}

export async function findPeerById(peerId) {
  const peers = await getPeers().catch(() => []);
  return peers.find((p) => p.instanceId === peerId) || null;
}
export const FORCE_REVALIDATE_EVERY = 10; // ~10 min at the 60s sweep cadence

/**
 * Test-support: await the in-flight subscription-write tail. Lets callers
 * (`__resetForTests` / `__drainForTests` in peerSync.js) settle fire-and-forget
 * writes without reaching into the module-private `writeTail` binding.
 */
export function drainWriteTail() {
  return writeTail.catch(() => {});
}
