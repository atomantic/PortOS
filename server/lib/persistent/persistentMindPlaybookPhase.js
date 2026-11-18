/**
 * Maturity-aware phase picker (explore/construct/maintain/coordinate) for the Persistent Mind continuous-play playbook (#7458).
 *
 * Maturity-aware continuous-play phase picker (explore/construct/maintain/coordinate) for the Persistent Mind playbook (#7458) from bounded Eidoverse world signals (density, recent failure rate, active peers),
 * never from wall-clock or a fixed cron personality: a sparse Commons explores more, a dense aging one maintains and coordinates. Pure: takes the numeric signals reduced from `buildEidoverseWorldSignals()` and an
 * `observeEidoverseWorld()` report (see `derivePersistentMindPlaybookPhaseSignals`) and returns a phase plus a short reason. Live signal gathering lives in `server/services/persistent/persistentMindPlaybookSignals.js`.
 */

export const PERSISTENT_MIND_PLAYBOOK_PHASES = Object.freeze([
  'explore',
  'construct',
  'maintain',
  'coordinate',
]);

/**
 * Thresholds are counted in what a MIND BUILT, not what PortOS ships. The count sums the variable populations (apps, active agents, active tasks, peers, goals, memory categories, Jira groups) plus the two
 * durable Eidoverse populations a mind grows (locally-authored foundations, installed controllers) and EXCLUDES the install-constant scaffolding `buildEidoverseWorldSignals()` also projects: `features` (~15),
 * `storage` (2), and the `operations`/`productivity`/`activity` summary rows (3). Those put a floor of ~19 under the old count, above the old `matureDistrictCount: 16`, so `explore` and `construct` were
 * unreachable and a new install was told to steward a mature Commons (#7630). Districts still SHOW features and storage; only this maturity signal skips them.
 * Calibration: a fresh install measures 0; a few apps, a task or two and a handful of authored foundations or a controller land in single digits; an established Commons clears the mature threshold comfortably.
 */
const THRESHOLDS = Object.freeze({
  sparseDistrictCount: 3,
  matureDistrictCount: 12,
  highFailureRate: 0.25,
});

const nonNegativeIntOrNull = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
};

const clampFractionOrNull = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
};

/** A failure rate only exists when work ran: `getTodayActivity()` reports `successRate: 0` for a day with zero completed agents, which would read as a 100% failure rate and jam every wake into `maintain`. A measured-but-empty sample yields `null`; a measured zero-failure sample yields `0`. */
const measuredFailureRate = (productivity) => {
  const succeeded = nonNegativeIntOrNull(productivity?.succeededToday);
  const failed = nonNegativeIntOrNull(productivity?.failedToday);
  if (succeeded !== null && failed !== null) {
    return succeeded + failed > 0 ? failed / (succeeded + failed) : null;
  }
  const completed = nonNegativeIntOrNull(productivity?.completedToday);
  if (completed !== null && completed > 0 && typeof productivity?.successRate === 'number') {
    return clampFractionOrNull(1 - productivity.successRate / 100);
  }
  return null;
};

/** The coarse health enum is a STAND-IN for a failure rate, not a measurement (`attention` comes from a stopped app, an open review alert or 85% disk). It still belongs in the ladder but must never render as "N% recent failure rate"; the caller keeps them apart via `failureRateMeasured`. */
const healthFailureRate = (health) => {
  if (!health || typeof health.status !== 'string') return null;
  if (health.status === 'error') return 1;
  if (health.status === 'attention') return 0.5;
  if (health.status === 'healthy') return 0;
  return null;
};

/** Foundations this install AUTHORED, excluding peer copies (inherited ones would let federation alone carry an install to `maintain`). `inherited` is a documented subset of `baseline` (`listEidoverseFoundations`), so subtracting is exact. */
function authoredFoundationCount(observation) {
  const counts = observation?.foundations?.counts;
  if (!counts || typeof counts !== 'object') return null;
  const vernacular = nonNegativeIntOrNull(counts.vernacular);
  const baseline = nonNegativeIntOrNull(counts.baseline);
  if (vernacular === null || baseline === null) return null;
  return Math.max(0, vernacular + baseline - (nonNegativeIntOrNull(counts.inherited) ?? 0));
}

/**
 * Peer contributions this mind has not looked at yet (the "unread peer contributions" signal #7458 named and never wired up).
 * - A FIRST observation has no marker to diff against, so it is `null` (unknown), never a measured `0` (the same fabricated-signal defect mirrored).
 * - Only INHERITED arrivals count: `changes.newFoundations` also lists foundations this mind authored (#7630). The inherited list is capped at the 20 most recent, which covers every newly-inherited id.
 * - A new peer counts on its own: a federation link that didn't exist last wake is worth reading.
 */
function derivePeerContributionsUnread(observation) {
  const changes = observation?.changes;
  if (!changes || typeof changes !== 'object' || changes.firstObservation === true) return null;
  const newFoundations = Array.isArray(changes.newFoundations) ? changes.newFoundations : null;
  const newPeers = Array.isArray(changes.newPeers) ? changes.newPeers : null;
  if (newFoundations === null && newPeers === null) return null;
  const inheritedIds = new Set((Array.isArray(observation?.foundations?.inherited) ? observation.foundations.inherited : [])
    .map((entry) => entry?.id)
    .filter(Boolean));
  const inheritedArrivals = (newFoundations ?? []).filter((id) => inheritedIds.has(id)).length;
  return inheritedArrivals + (newPeers?.length ?? 0);
}

/**
 * Reduce a `buildEidoverseWorldSignals()` projection (`server/lib/eidoverseWorldSignals.js`) and optionally an `observeEidoverseWorld()` report (`server/services/eidoverseObservationLedger.js`) to the
 * bounded numbers the picker needs. Every field degrades to `null` (unknown), not a guessed zero, so the picker falls back to `explore` instead of reading absence as emptiness.
 */
export function derivePersistentMindPlaybookPhaseSignals(worldSignals, observation = null) {
  const world = worldSignals && typeof worldSignals === 'object' ? worldSignals : null;

  // A failed source read arrives as `null`, not `[]`; counting it as zero would report a confidently empty Commons, so an all-null projection degrades to `null` and only present populations count.
  // `features`, `storage`, `operations` and the summary rows are deliberately absent (see THRESHOLDS).
  const populations = [
    world?.apps, world?.agents, world?.tasks,
    world?.peers, world?.goals, world?.memory, world?.jira,
  ]
    .filter((entries) => Array.isArray(entries))
    .map((entries) => entries.length);
  for (const built of [authoredFoundationCount(observation), nonNegativeIntOrNull(observation?.controllers?.counts?.total)]) {
    if (built !== null) populations.push(built);
  }
  const districtCount = populations.length > 0
    ? populations.reduce((total, count) => total + count, 0)
    : null;

  const productivity = Array.isArray(world?.productivity) ? world.productivity[0] : null;
  // `??` (not `||`) so a measured zero-failure day stays 0 instead of falling through to the coarse health signal.
  const measured = measuredFailureRate(productivity);
  const failureRate = measured ?? healthFailureRate(world?.health);

  // Peers this mind can travel to, NOT "peers with unread contributions": a peer is a destination only when `listEidoverseDestinations()` saw it online (`coarseStatus` → `active`), so a non-`steady` filter
  // was true for every travelable peer. Reachability is a necessary-but-insufficient precondition for `coordinate`; `peerContributionsUnread` makes it fire.
  const peersReachable = Array.isArray(world?.peers)
    ? world.peers.filter((peer) => peer?.travelAvailable === true).length
    : null;

  return {
    districtCount,
    failureRate,
    failureRateMeasured: measured !== null,
    peersReachable,
    peerContributionsUnread: derivePeerContributionsUnread(observation),
  };
}

/**
 * Pick the active playbook phase from bounded signals. Never throws: absent or malformed signals degrade to `explore`. Priority, highest first: a sparse Commons explores; a high recent failure rate (or
 * unhealthy install) outranks the rest (fix what is broken first); a Commons short of the maturity threshold keeps building; a mature one with unread, reachable peer contributions visits; otherwise maintenance.
 * `coordinate` needs BOTH halves measured (unread contributions and a reachable peer): one always-online peer would otherwise satisfy it every wake and the template would claim peers are waiting.
 */
export function selectPersistentMindPlaybookPhase(signals = {}) {
  const districtCount = nonNegativeIntOrNull(signals.districtCount);
  const failureRate = clampFractionOrNull(signals.failureRate);
  const peersReachable = nonNegativeIntOrNull(signals.peersReachable);
  const peerContributionsUnread = nonNegativeIntOrNull(signals.peerContributionsUnread);

  if (districtCount === null || districtCount < THRESHOLDS.sparseDistrictCount) {
    return {
      phase: 'explore',
      reason: districtCount === null ? 'world signals unavailable' : `sparse Commons (${districtCount} built signal(s))`,
    };
  }
  if (failureRate !== null && failureRate >= THRESHOLDS.highFailureRate) {
    // Only a MEASURED rate is reported as one; the health-derived fallback is a coarse enum, and printing it as a percentage claims a measurement never made.
    return {
      phase: 'maintain',
      reason: signals.failureRateMeasured === true
        ? `${Math.round(failureRate * 100)}% recent failure rate`
        : 'install health needs attention',
    };
  }
  if (districtCount < THRESHOLDS.matureDistrictCount) {
    return { phase: 'construct', reason: `${districtCount} built signal(s), room to densify before ${THRESHOLDS.matureDistrictCount}` };
  }
  if (peerContributionsUnread !== null && peerContributionsUnread > 0 && peersReachable !== null && peersReachable > 0) {
    return {
      phase: 'coordinate',
      reason: `${peerContributionsUnread} unread peer contribution(s), ${peersReachable} reachable peer(s)`,
    };
  }
  return { phase: 'maintain', reason: `mature Commons (${districtCount} built signal(s)), steady-state upkeep` };
}
