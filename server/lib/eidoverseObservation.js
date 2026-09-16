/**
 * Observation-first discovery for the Eidoverse (#7457, epic #7453).
 *
 * SwarmWorld's finding is that reuse between agents starts with LOOKING at the
 * world, not with asking its author about it. PortOS's mind tools grew the
 * other way round: a mind could speak (`eidoverse.say`), travel
 * (`eidoverse.visit`), and chat (`eidoverse.chat`, `eidoverse.visit-chat`)
 * long before it could see what was already standing in its own world. The
 * playbook has told it to "move through the world and map what already exists"
 * since the continuous-play loop landed, naming places, projections, and
 * affordances it had no tool to read. This module is that missing read.
 *
 * It is deliberately PURE and takes already-collected snapshots. The service
 * beside it (`services/eidoverseObservationLedger.js`) owns the I/O, the
 * clock, and the visit marker; everything here is a total function of its
 * arguments, so the whole diff contract is testable without a world runtime,
 * a socket, or a file.
 *
 * **Two things it must not do.** It must not require a running world — a mind
 * that cannot start the runtime still needs to know what is in its Commons,
 * so occupancy is derived from the live PortOS signals a projection would
 * place rather than from a live entity dump. And it must not widen what a mind
 * can see: every identity that reaches the report is already one the existing
 * mind tools return (`summarizeFoundation`'s opaque `originInstanceId`,
 * `eidoversePeerId`'s digest), and nothing here reads a record body.
 */

import { EIDOVERSE_DISTRICTS_V2 } from './eidoverseWorldDesign.js';
import { eidoversePeerId } from './eidoverseWorldSignals.js';

/** Storage-layout version stamped on the persisted visit marker. */
export const EIDOVERSE_OBSERVATION_SCHEMA_VERSION = 1;

// Bounds. An observation is a tool result read by a language model, so every
// list is capped rather than trusted to stay small: a busy install has
// hundreds of foundations and an unbounded report would crowd out the turn it
// is supposed to inform. The caps are per-section so one crowded section
// cannot starve the others.
const MAX_PEERS = 32;
const MAX_INHERITED = 20;
const MAX_ATTENTION_CONTROLLERS = 10;
const MAX_CHANGE_ENTRIES = 20;
// The marker is rewritten on every observation, so it is capped well above the
// report's own limits but still bounded — an install that somehow accumulates
// more foundations than this simply stops distinguishing the oldest ones as
// "seen", which degrades to reporting them as new once, not to a broken file.
const MAX_MARKER_IDS = 2000;

const asArray = (value) => (Array.isArray(value) ? value : []);
const capped = (values, limit) => asArray(values).slice(0, limit);

/**
 * How many live signals a source currently reports. `null` means the source
 * could not be read at all, which is NOT the same as an empty source and must
 * never collapse into `0` — an unreadable app list would otherwise read as
 * "the App Terraces are empty", exactly the misreport #7458 fixed for district
 * density. `health` is a single object rather than a list, mirroring
 * `sourceAvailable()` in the projection.
 */
function sourceSignalCount(source, key) {
  const value = source?.[key];
  if (key === 'health') return value === null || value === undefined ? null : 1;
  return Array.isArray(value) ? value.length : null;
}

/**
 * One district as something a mind can stand in and describe: what feeds it,
 * how much is currently there, and whether any of it wants attention.
 *
 * `signalCount` is what the district's sources REPORT, not a count of placed
 * entities. The projection allocates a capped, round-robin sample of those
 * signals into the world (`buildProjectionPlan`), so the world may hold fewer.
 * Reporting the source count keeps this readable without a live runtime; the
 * field name and the tool description both say "signals" rather than
 * "entities" so the difference is never implied away.
 */
function observePlace(district, source) {
  const counts = district.sources.map((key) => ({ key, count: sourceSignalCount(source, key) }));
  const readable = counts.filter(({ count }) => count !== null);
  const unreadable = counts.filter(({ count }) => count === null).map(({ key }) => key);
  const signalCount = readable.length ? readable.reduce((total, { count }) => total + count, 0) : null;
  const severities = district.sources.flatMap((key) => {
    const value = source?.[key];
    if (key === 'health') return value?.status ? [value.status] : [];
    return asArray(value).map((item) => item?.status).filter(Boolean);
  });
  // A district is `quiet` only when every source read cleanly and reported
  // nothing. When a source failed we say `unknown`, never `quiet`.
  const status = severities.some((value) => value === 'error' || value === 'attention')
    ? 'attention'
    : (signalCount === null ? 'unknown' : (signalCount > 0 ? 'active' : 'quiet'));
  return {
    id: district.id,
    label: district.label,
    direction: district.direction,
    landmark: district.landmark,
    sources: [...district.sources],
    unreadableSources: unreadable,
    signalCount,
    status,
  };
}

/**
 * The federated neighbours, as the world shows them. `peerId` is the same
 * opaque digest `eidoverse.destinations` returns, so a mind can carry one
 * straight into `eidoverse.visit` — and so nothing here is a hostname.
 *
 * `inheritedFoundations` is the observation-first payoff: it links a peer in
 * the Federation Harbor to the foundations this install actually pulled from
 * it, which is how a peer's contribution becomes discoverable by touring the
 * Commons instead of by reading a repository.
 */
function observePeers(source, destinations, inheritedByPeer) {
  if (!Array.isArray(source?.peers)) return null;
  const travelable = new Set(asArray(destinations).map((entry) => entry?.peerId).filter(Boolean));
  return capped(source.peers, MAX_PEERS).map((peer) => ({
    peerId: peer.id,
    status: peer.status,
    enabled: peer.enabled === true,
    fullSync: peer.fullSync === true,
    travelAvailable: peer.travelAvailable === true || travelable.has(peer.id),
    inheritedFoundations: inheritedByPeer.get(peer.id) || 0,
  }));
}

/**
 * Inherited foundations, keyed back to the peer chamber they arrived through.
 *
 * `sourceInstanceId` (pulled-FROM) is hashed with `eidoversePeerId` so it lines
 * up with the opaque ids in `peers` above; `originInstanceId` (authored-BY)
 * stays as-is because that is exactly what `summarizeFoundation` already hands
 * the mind, and a multi-hop re-share is only legible when the two are distinct.
 */
function observeInherited(foundations) {
  const inherited = asArray(foundations).filter((entry) => entry?.inheritance);
  const byPeer = new Map();
  for (const entry of inherited) {
    const sourceInstanceId = entry.inheritance?.sourceInstanceId;
    if (!sourceInstanceId) continue;
    const peerId = eidoversePeerId({ instanceId: sourceInstanceId });
    byPeer.set(peerId, (byPeer.get(peerId) || 0) + 1);
  }
  const rows = [...inherited]
    .sort((left, right) => String(right.inheritance?.inheritedAt || '').localeCompare(String(left.inheritance?.inheritedAt || '')))
    .slice(0, MAX_INHERITED)
    .map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      title: entry.title,
      originInstanceId: entry.inheritance?.originInstanceId ?? null,
      fromPeerId: entry.inheritance?.sourceInstanceId
        ? eidoversePeerId({ instanceId: entry.inheritance.sourceInstanceId })
        : null,
      inheritedAt: entry.inheritance?.inheritedAt ?? null,
    }));
  return { rows, byPeer };
}

/**
 * Controller health, filtered to what a maintenance wake would act on. A
 * controller is worth surfacing when the supervisor disarmed it, when it is
 * failing, or when its last tick failed — `lastTickOk === null` means it has
 * never stepped yet, which is the normal state one interval after an install
 * and deliberately NOT an alarm.
 */
function observeControllers(installs) {
  return capped(asArray(installs)
    .filter((install) => install?.disarmedReason
      || (install?.consecutiveFailures ?? 0) > 0
      || install?.lastTickOk === false)
    .map((install) => ({
      id: install.id,
      controllerId: install.controllerId,
      armed: install.armed === true,
      lastTickOk: install.lastTickOk ?? null,
      lastTickReason: install.lastTickReason ?? null,
      consecutiveFailures: install.consecutiveFailures ?? 0,
      disarmedReason: install.disarmedReason ?? null,
    })), MAX_ATTENTION_CONTROLLERS);
}

const sortedUnique = (values) => [...new Set(asArray(values).filter(Boolean))].sort();

/**
 * What changed since the marker this mind left last time.
 *
 * A first observation reports `firstObservation: true` and NO new items rather
 * than declaring the entire world new — a mind waking into an install that has
 * been running for months should be told it has not looked before, not handed
 * two hundred "new" foundations. That distinction is the absent-versus-empty
 * rule from AGENTS.md applied to the marker itself.
 *
 * Places report a change only when their STATUS flips, never on a count
 * change: signal counts move every wake as tasks and agents come and go, so
 * diffing them would make `changes` noise instead of signal. The live count
 * stays in `places` for a mind that wants it.
 */
function diffAgainstMarker({ marker, foundationIds, peerIds, placeStatus, attentionControllerIds }) {
  if (!marker) {
    return {
      firstObservation: true,
      since: null,
      newFoundations: [],
      newPeers: [],
      departedPeers: [],
      placesChanged: [],
      controllersNeedingAttention: [],
    };
  }
  const seenFoundations = new Set(asArray(marker.foundationIds));
  const seenPeers = new Set(asArray(marker.peerIds));
  const seenAttention = new Set(asArray(marker.attentionControllerIds));
  const previousPlaceStatus = marker.placeStatus && typeof marker.placeStatus === 'object' ? marker.placeStatus : {};
  const currentPeers = new Set(peerIds);
  return {
    firstObservation: false,
    since: marker.observedAt ?? null,
    newFoundations: foundationIds.filter((id) => !seenFoundations.has(id)).slice(0, MAX_CHANGE_ENTRIES),
    newPeers: peerIds.filter((id) => !seenPeers.has(id)).slice(0, MAX_CHANGE_ENTRIES),
    departedPeers: [...seenPeers].filter((id) => !currentPeers.has(id)).sort().slice(0, MAX_CHANGE_ENTRIES),
    placesChanged: Object.entries(placeStatus)
      .filter(([id, status]) => previousPlaceStatus[id] !== undefined && previousPlaceStatus[id] !== status)
      .map(([id, status]) => ({ id, was: previousPlaceStatus[id], now: status }))
      .slice(0, MAX_CHANGE_ENTRIES),
    // Only controllers that were NOT already wanting attention last time, so a
    // long-broken controller stops re-alarming every single wake.
    controllersNeedingAttention: attentionControllerIds.filter((id) => !seenAttention.has(id)).slice(0, MAX_CHANGE_ENTRIES),
  };
}

const GUIDANCE = 'Observation before conversation: what you see here is this install\'s own world. '
  + 'Read `places` and `changes` first, act on what is already standing (eidoverse.foundations, '
  + 'eidoverse.controllers, eidoverse.augment), and only then reach for chat or a peer visit. '
  + 'A peer\'s inherited foundation is a durable contribution you can build on without asking its author.';

/**
 * Build one observation report plus the marker to persist for the next one.
 *
 * Every argument is an already-read snapshot, and `marker` is the previously
 * persisted marker (`null` on a first observation). Returns
 * `{ report, marker }`: the caller decides whether to commit the new marker,
 * which keeps the diff contract testable without a write.
 */
export function buildEidoverseObservation({
  source = {},
  districts = EIDOVERSE_DISTRICTS_V2,
  foundations = [],
  foundationCounts = null,
  controllerInstalls = [],
  controllerCounts = null,
  destinations = [],
  marker = null,
  observedAt,
} = {}) {
  const places = asArray(districts.length ? districts : EIDOVERSE_DISTRICTS_V2).map((district) => observePlace(district, source));
  const { rows: inheritedRows, byPeer } = observeInherited(foundations);
  const peers = observePeers(source, destinations, byPeer);
  const attentionControllers = observeControllers(controllerInstalls);

  const foundationIds = sortedUnique(asArray(foundations).map((entry) => entry?.id));
  const peerIds = sortedUnique(asArray(peers).map((entry) => entry.peerId));
  const placeStatus = Object.fromEntries(places.map(({ id, status }) => [id, status]));
  const attentionControllerIds = sortedUnique(attentionControllers.map((entry) => entry.id));

  const changes = diffAgainstMarker({ marker, foundationIds, peerIds, placeStatus, attentionControllerIds });

  return {
    report: {
      schemaVersion: EIDOVERSE_OBSERVATION_SCHEMA_VERSION,
      observedAt,
      places,
      peers,
      foundations: {
        counts: foundationCounts,
        inherited: inheritedRows,
        inheritedTruncated: asArray(foundations).filter((entry) => entry?.inheritance).length > inheritedRows.length,
      },
      controllers: {
        counts: controllerCounts,
        needsAttention: attentionControllers,
      },
      changes,
      guidance: GUIDANCE,
    },
    marker: {
      schemaVersion: EIDOVERSE_OBSERVATION_SCHEMA_VERSION,
      observedAt,
      foundationIds: foundationIds.slice(0, MAX_MARKER_IDS),
      peerIds: peerIds.slice(0, MAX_MARKER_IDS),
      placeStatus,
      attentionControllerIds: attentionControllerIds.slice(0, MAX_MARKER_IDS),
    },
  };
}
