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
 * **Absent is never empty, here or in the trail.** A section that failed to
 * collect arrives as `null` rather than `[]`, and an unavailable section
 * contributes no changes and carries the previous marker's ids forward. A
 * transient peer-read failure that presented as "no peers" would otherwise
 * report every peer departed, rewrite the marker without them, and then report
 * them all as new on the next observation.
 *
 * **Three things it must not do.** It must not require a running world — a
 * mind that cannot start the runtime still needs to know what is in its
 * Commons, so occupancy is derived from the live PortOS signals a projection
 * would place rather than from a live entity dump. It must not invent its own
 * idea of the world's shape: places come from the install's RESOLVED design
 * recipe, so a mind never names a district the world renamed (V3 calls it the
 * Federation Terminal, not the V2 Harbor) or one the user's overrides moved.
 * And it must not widen what a mind can see: every identity that reaches the
 * report is already one the existing mind tools return
 * (`summarizeFoundation`'s opaque `originInstanceId`, `eidoversePeerId`'s
 * digest), and nothing here reads a record body.
 */

import { asArray } from './arrayUtils.js';
import {
  EIDOVERSE_SCALAR_SOURCE_KEYS,
  EIDOVERSE_WORLD_DESIGN_V3,
} from './eidoverseWorldDesign.js';
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
// Only `foundationIds` needs this: the other two marker lists are derived from
// report sections that are already capped far below it. An install that
// somehow exceeds it simply stops distinguishing the oldest ids as "seen",
// which degrades to reporting them as new once, not to a broken file.
const MAX_MARKER_FOUNDATION_IDS = 2000;

const sortedUnique = (values) => [...new Set(asArray(values).filter(Boolean))].sort();

/**
 * Read one signal source for a district in a single pass.
 *
 * `count: null` means the source could not be read at all, which is NOT the
 * same as an empty source and must never collapse into `0` — an unreadable app
 * list would otherwise read as "the App Arcade is empty", exactly the
 * misreport #7458 fixed for district density. Which sources are a single
 * object rather than a list is `EIDOVERSE_SCALAR_SOURCE_KEYS`, the same
 * constant the projection's `sourceAvailable()` keys on, so the two cannot
 * drift into disagreeing about what an empty district looks like.
 *
 * A source the install's recipe has switched OFF is reported as disabled
 * rather than counted: the projection places nothing for it, so counting it
 * would show a mind density that does not exist in the world.
 */
function readSource(source, key, includes) {
  if (includes?.[key] !== true) return { count: null, disabled: true, attention: false };
  const value = source?.[key];
  if (EIDOVERSE_SCALAR_SOURCE_KEYS.includes(key)) {
    if (value === null || value === undefined) return { count: null, disabled: false, attention: false };
    return { count: 1, disabled: false, attention: value.status === 'error' || value.status === 'attention' };
  }
  if (!Array.isArray(value)) return { count: null, disabled: false, attention: false };
  return {
    count: value.length,
    disabled: false,
    attention: value.some((item) => item?.status === 'error' || item?.status === 'attention'),
  };
}

/**
 * One district as something a mind can stand in and describe: what feeds it,
 * how much is currently there, and whether any of it wants attention.
 *
 * `signalCount` is what the district's enabled sources REPORT, not a count of
 * placed entities. The projection allocates a capped, round-robin sample of
 * those signals into the world (`buildProjectionPlan`), so the world may hold
 * fewer. Reporting the source count keeps this readable without a live
 * runtime; the field name and the tool description both say "signals" rather
 * than "entities" so the difference is never implied away.
 */
function observePlace(district, source, includes) {
  let signalCount = null;
  let attention = false;
  const unreadableSources = [];
  const disabledSources = [];
  for (const key of district.sources) {
    const { count, disabled, attention: wantsAttention } = readSource(source, key, includes);
    if (disabled) disabledSources.push(key);
    else if (count === null) unreadableSources.push(key);
    else signalCount = (signalCount ?? 0) + count;
    if (wantsAttention) attention = true;
  }
  // Priority order, and `quiet` only when every enabled source read cleanly:
  // an unreadable source must never render as an empty district.
  const status = attention ? 'attention'
    : signalCount === null ? 'unknown'
      : signalCount > 0 ? 'active' : 'quiet';
  return {
    id: district.id,
    label: district.label,
    direction: district.direction,
    landmark: district.landmark,
    sources: district.sources,
    unreadableSources,
    disabledSources,
    signalCount,
    status,
  };
}

/**
 * Inherited foundations, keyed back to the peer chamber they arrived through.
 *
 * `sourceInstanceId` (pulled-FROM) is hashed with `eidoversePeerId` so it lines
 * up with the opaque ids in `peers`; `originInstanceId` (authored-BY) stays as
 * it is because that is exactly what `summarizeFoundation` already hands the
 * mind, and a multi-hop re-share is only legible when the two are distinct.
 */
function observeInherited(inherited) {
  const peerIdByInstance = new Map();
  const peerIdFor = (instanceId) => {
    if (!instanceId) return null;
    if (!peerIdByInstance.has(instanceId)) peerIdByInstance.set(instanceId, eidoversePeerId({ instanceId }));
    return peerIdByInstance.get(instanceId);
  };
  const byPeer = new Map();
  for (const entry of inherited) {
    const peerId = peerIdFor(entry.inheritance?.sourceInstanceId);
    if (peerId) byPeer.set(peerId, (byPeer.get(peerId) || 0) + 1);
  }
  // ISO-8601 timestamps sort correctly as plain strings; `localeCompare` would
  // run full ICU collation over every inherited foundation to keep 20.
  const rows = inherited
    .map((entry) => ({ entry, at: entry.inheritance?.inheritedAt || '' }))
    .sort((left, right) => (left.at < right.at ? 1 : left.at > right.at ? -1 : 0))
    .slice(0, MAX_INHERITED)
    .map(({ entry }) => ({
      id: entry.id,
      kind: entry.kind,
      title: entry.title,
      originInstanceId: entry.inheritance?.originInstanceId ?? null,
      fromPeerId: peerIdFor(entry.inheritance?.sourceInstanceId),
      inheritedAt: entry.inheritance?.inheritedAt ?? null,
    }));
  return { rows, byPeer };
}

/**
 * The federated neighbours, as the world shows them. `peerId` is the same
 * opaque digest `eidoverse.destinations` returns, so a mind can carry one
 * straight into `eidoverse.visit` — and so nothing here is a hostname.
 * `travelAvailable` is read from the signal rather than re-probed: the source
 * collector already resolved it against the live destination list.
 *
 * `inheritedFoundations` is the observation-first payoff — it links a peer to
 * the foundations this install actually pulled from it, which is how a peer's
 * contribution becomes discoverable by touring the Commons instead of by
 * reading a repository.
 */
function observePeers(source, byPeer) {
  if (!Array.isArray(source?.peers)) return null;
  return source.peers.slice(0, MAX_PEERS).map((peer) => ({
    peerId: peer.id,
    status: peer.status,
    enabled: peer.enabled === true,
    fullSync: peer.fullSync === true,
    travelAvailable: peer.travelAvailable === true,
    inheritedFoundations: byPeer.get(peer.id) || 0,
  }));
}

/**
 * Controller health, filtered to what a maintenance wake would act on.
 *
 * Takes the SUMMARY projection (`summarizeControllerInstall`), never a raw
 * ledger record: the raw record carries `lastOutcome: { ok, reason }`, and
 * reading `lastTickOk` off one silently yields `undefined` for every install,
 * which would quietly disable the failed-tick clause below.
 *
 * `lastTickOk === null` means the controller has never stepped yet, which is
 * the normal state one interval after an install and deliberately NOT an
 * alarm. `lastDelivery` is the SEPARATE verdict #7628 added: a step can read
 * `ok: true` while every effect it produced was refused by the world, so a
 * clean step alone does not clear this filter — `lastDelivery.ok === false`
 * is checked too. `lastDelivery.ok === null` (delivery off, or nothing to
 * deliver this tick) is deliberately NOT an alarm either.
 */
function observeControllers(installs) {
  if (!Array.isArray(installs)) return null;
  return installs
    .filter((install) => install?.disarmedReason
      || (install?.consecutiveFailures ?? 0) > 0
      || install?.lastTickOk === false
      || install?.lastDelivery?.ok === false)
    .slice(0, MAX_ATTENTION_CONTROLLERS)
    .map((install) => ({
      id: install.id,
      controllerId: install.controllerId,
      armed: install.armed === true,
      lastTickOk: install.lastTickOk ?? null,
      lastTickReason: install.lastTickReason ?? null,
      consecutiveFailures: install.consecutiveFailures ?? 0,
      lastDelivery: install.lastDelivery ?? null,
      disarmedReason: install.disarmedReason ?? null,
    }));
}

const NO_CHANGES = Object.freeze({
  newFoundations: [],
  newPeers: [],
  departedPeers: [],
  placesChanged: [],
  controllersNeedingAttention: [],
});

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
function diffAgainstMarker({ marker, foundations, peers, controllers, placeStatus }) {
  if (!marker) return { firstObservation: true, since: null, ...NO_CHANGES };
  const seenFoundations = new Set(asArray(marker.foundationIds));
  const seenPeers = new Set(asArray(marker.peerIds));
  const seenAttention = new Set(asArray(marker.attentionControllerIds));
  const previousPlaceStatus = marker.placeStatus && typeof marker.placeStatus === 'object' ? marker.placeStatus : {};
  const currentPeers = new Set(peers.ids);
  return {
    firstObservation: false,
    since: marker.observedAt ?? null,
    newFoundations: foundations.available
      ? foundations.ids.filter((id) => !seenFoundations.has(id)).slice(0, MAX_CHANGE_ENTRIES)
      : [],
    newPeers: peers.available
      ? peers.ids.filter((id) => !seenPeers.has(id)).slice(0, MAX_CHANGE_ENTRIES)
      : [],
    departedPeers: peers.available
      ? [...seenPeers].filter((id) => !currentPeers.has(id)).sort().slice(0, MAX_CHANGE_ENTRIES)
      : [],
    placesChanged: Object.entries(placeStatus)
      .filter(([id, status]) => previousPlaceStatus[id] !== undefined && previousPlaceStatus[id] !== status)
      .map(([id, status]) => ({ id, was: previousPlaceStatus[id], now: status }))
      .slice(0, MAX_CHANGE_ENTRIES),
    // Only controllers that were NOT already wanting attention last time, so a
    // long-broken controller stops re-alarming every single wake.
    controllersNeedingAttention: controllers.available
      ? controllers.ids.filter((id) => !seenAttention.has(id)).slice(0, MAX_CHANGE_ENTRIES)
      : [],
  };
}

/**
 * An id list for one section, plus whether the section could be read at all.
 *
 * A section that FAILED to collect must not present as empty. Treating it as
 * empty would report every peer as departed and every foundation as gone on a
 * transient read failure, and — because the marker is rewritten from the same
 * lists — would then report all of them as NEW again on the next observation.
 * So an unavailable section contributes no changes and CARRIES FORWARD what
 * the previous marker held, which is the absent-versus-empty rule applied to
 * the trail itself.
 */
function section(ids, available, carriedForward) {
  return available ? { ids, available: true } : { ids: asArray(carriedForward), available: false };
}

const GUIDANCE = 'Observation before conversation: what you see here is this install\'s own world. '
  + 'Read `places` and `changes` first, act on what is already standing (eidoverse.foundations, '
  + 'eidoverse.controllers, eidoverse.augment), and only then reach for chat or a peer visit. '
  + 'A peer\'s inherited foundation is a durable contribution you can build on without asking its author.';

/**
 * Build one observation report plus the marker to persist for the next one.
 *
 * Every argument is an already-read snapshot: `districts`/`includes` come from
 * the install's RESOLVED design recipe (the service resolves it the same way
 * the projection does), `controllerInstalls` is the summarized projection, and
 * `marker` is the previously persisted marker (`null` on a first observation).
 * Returns `{ report, marker }`: the caller decides whether to commit the new
 * marker, which keeps the diff contract testable without a write.
 */
export function buildEidoverseObservation({
  source = {},
  districts = EIDOVERSE_WORLD_DESIGN_V3.districts,
  includes = EIDOVERSE_WORLD_DESIGN_V3.includes,
  foundations = null,
  foundationCounts = null,
  controllerInstalls = null,
  controllerCounts = null,
  marker = null,
  observedAt,
} = {}) {
  const places = districts.map((district) => observePlace(district, source, includes));
  const inherited = asArray(foundations).filter((entry) => entry?.inheritance);
  const { rows: inheritedRows, byPeer } = observeInherited(inherited);
  const peers = observePeers(source, byPeer);
  const attentionControllers = observeControllers(controllerInstalls);

  // `null` means the section could not be read; `[]` means it read as empty.
  // Collapsing the two here is what would make a transient failure flap — see
  // `section()`.
  const foundationSection = section(
    sortedUnique(asArray(foundations).map((entry) => entry?.id)),
    Array.isArray(foundations),
    marker?.foundationIds,
  );
  const peerSection = section(
    sortedUnique(asArray(peers).map((entry) => entry.peerId)),
    peers !== null,
    marker?.peerIds,
  );
  const controllerSection = section(
    sortedUnique(asArray(attentionControllers).map((entry) => entry.id)),
    attentionControllers !== null,
    marker?.attentionControllerIds,
  );
  // `signalCount === null` alone is not a failed read — a district whose
  // sources are all disabled by the recipe also lands there, legitimately.
  // Only a district that actually FAILED a source read (`unreadableSources`
  // non-empty) gets the section()-equivalent carry-forward treatment: the
  // report keeps `status: 'unknown'` (built into `places` above) so the mind
  // still sees the read failed, but the committed marker — and therefore the
  // diff below — keeps the PREVIOUS marker's status for that district
  // instead of overwriting it with `unknown`. Same rule `section()` applies
  // to the three id-list sections, applied per key because this section is a
  // map rather than a list.
  const previousPlaceStatus = marker?.placeStatus && typeof marker.placeStatus === 'object' ? marker.placeStatus : {};
  const placeStatus = Object.fromEntries(places.map((place) => {
    const unreadable = place.signalCount === null && place.unreadableSources.length > 0;
    const carried = previousPlaceStatus[place.id];
    const status = unreadable && carried !== undefined ? carried : place.status;
    return [place.id, status];
  }));

  return {
    report: {
      schemaVersion: EIDOVERSE_OBSERVATION_SCHEMA_VERSION,
      observedAt,
      places,
      peers,
      foundations: {
        counts: foundationCounts,
        inherited: inheritedRows,
        inheritedTruncated: inherited.length > inheritedRows.length,
      },
      controllers: {
        counts: controllerCounts,
        needsAttention: attentionControllers,
      },
      changes: diffAgainstMarker({
        marker,
        foundations: foundationSection,
        peers: peerSection,
        controllers: controllerSection,
        placeStatus,
      }),
      guidance: GUIDANCE,
    },
    marker: {
      schemaVersion: EIDOVERSE_OBSERVATION_SCHEMA_VERSION,
      observedAt,
      foundationIds: foundationSection.ids.slice(0, MAX_MARKER_FOUNDATION_IDS),
      peerIds: peerSection.ids,
      placeStatus,
      attentionControllerIds: controllerSection.ids,
    },
  };
}
