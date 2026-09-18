/**
 * Maturity-aware phase picker for the Persistent Mind continuous-play
 * playbook (issue #7458). SwarmWorld-style minds drift among explore,
 * construct, maintain, and coordinate as the shared Eidoverse Commons
 * matures, rather than running one fixed explore→invent loop forever. This
 * module picks the active phase from bounded world signals — never from a
 * wall-clock or fixed cron personality — so a sparse Commons gets more
 * exploring and a dense, aging one gets more maintenance and coordination.
 *
 * Pure and side-effect-free: it takes the numeric signals already reduced
 * from `buildEidoverseWorldSignals()` and from an `observeEidoverseWorld()`
 * report (see `derivePersistentMindPlaybookPhaseSignals`) and returns a phase
 * plus a short human-readable reason. Live signal gathering (I/O) lives in
 * `server/services/persistentMindPlaybookSignals.js`.
 */

export const PERSISTENT_MIND_PLAYBOOK_PHASES = Object.freeze([
  'explore',
  'construct',
  'maintain',
  'coordinate',
]);

/**
 * Thresholds are counted in what a MIND BUILT, not in what PortOS ships.
 *
 * The count sums the genuinely-variable world populations (apps, active
 * agents, active tasks, peers, goals, memory categories, Jira groups) plus the
 * two durable Eidoverse populations a mind grows itself: locally-authored
 * foundations and installed controllers. It deliberately EXCLUDES the
 * install-constant scaffolding `buildEidoverseWorldSignals()` also projects —
 * `features` (one row per registry feature, enabled or not: a fixed ~15),
 * `storage` (always `database` + `filesystem`: a fixed 2), and the single
 * `operations` / `productivity` / `activity` summary rows (a fixed 3). Those
 * five sources put a floor of ~19 under the old count, which is above the old
 * `matureDistrictCount: 16` — so `explore` and `construct` were unreachable on
 * every install and a brand-new one was told to steward a mature Commons
 * (#7630). The districts still SHOW features and storage; only this maturity
 * signal stops counting them.
 *
 * Calibration on the recalibrated scale: a fresh install with nothing built
 * measures 0. One with a few apps, a task or two, and a handful of authored
 * foundations or an installed controller lands in the single digits. An
 * established Commons — authored foundations, armed controllers, goals, memory
 * categories, live work — clears the mature threshold comfortably.
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

/**
 * A failure rate only exists when work actually ran. `getTodayActivity()`
 * reports `successRate: 0` for a day with zero completed agents, so trusting
 * that number unguarded reads an idle morning as a 100% failure rate and jams
 * every wake into `maintain`. A measured-but-empty sample yields `null`
 * ("no signal"), never a fabricated rate; a measured zero-failure sample still
 * correctly yields `0`.
 */
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

/**
 * The coarse health enum is a STAND-IN for a failure rate, not a measurement
 * of one — `attention` is set by a stopped managed app, an open review alert,
 * or 85% disk, none of which is a failed unit of work. It still belongs in the
 * ladder (a mind whose install is unhealthy should maintain), but it must
 * never be rendered as "N% recent failure rate": a day on which nothing ran
 * would print a measurement that was never taken. The caller keeps the two
 * apart via the `failureRateMeasured` flag.
 */
const healthFailureRate = (health) => {
  if (!health || typeof health.status !== 'string') return null;
  if (health.status === 'error') return 1;
  if (health.status === 'attention') return 0.5;
  if (health.status === 'healthy') return 0;
  return null;
};

/**
 * Foundations this install AUTHORED, excluding the copies it pulled from a
 * peer. A mind that inherited fifty foundations has a well-connected Commons,
 * not a densely-built one, and counting them here would let federation alone
 * carry an install to `maintain`. `inherited` is a documented subset of
 * `baseline` (see `listEidoverseFoundations`), so subtracting it is exact.
 */
function authoredFoundationCount(observation) {
  const counts = observation?.foundations?.counts;
  if (!counts || typeof counts !== 'object') return null;
  const vernacular = nonNegativeIntOrNull(counts.vernacular);
  const baseline = nonNegativeIntOrNull(counts.baseline);
  if (vernacular === null || baseline === null) return null;
  return Math.max(0, vernacular + baseline - (nonNegativeIntOrNull(counts.inherited) ?? 0));
}

/**
 * Peer contributions this mind has not looked at yet — the signal #7458's own
 * acceptance criteria named ("unread peer contributions") and never wired up.
 *
 * Three distinctions matter here:
 *
 * - A FIRST observation has no marker to diff against, so nothing was
 *   measured and this is `null` ("unknown"), never a measured `0`. Reporting
 *   zero there would be the same fabricated-signal defect in mirror image.
 * - Only INHERITED arrivals count. `changes.newFoundations` also lists
 *   foundations this mind authored since its last look, and telling it a peer
 *   is waiting because of its own work is exactly the claim #7630 removed.
 *   The inherited row list is capped at the most recent 20, which by
 *   construction covers every newly-inherited id.
 * - A new peer counts on its own: a federation link that did not exist last
 *   wake is a contribution worth going to read.
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
 * Reduce a `buildEidoverseWorldSignals()` projection (see
 * `server/lib/eidoverseWorldSignals.js`) and, optionally, an
 * `observeEidoverseWorld()` report (see
 * `server/services/eidoverseObservationLedger.js`) to the bounded numbers the
 * phase picker needs. Every field degrades to `null` ("unknown") rather than a
 * guessed zero when the source signal was unavailable, so the picker can
 * fall back to the safe `explore` phase instead of reading absence as
 * emptiness.
 */
export function derivePersistentMindPlaybookPhaseSignals(worldSignals, observation = null) {
  const world = worldSignals && typeof worldSignals === 'object' ? worldSignals : null;

  // A failed source read arrives as `null`, not `[]`. Counting those as zero
  // would report a confidently empty Commons when the truth is that nothing
  // could be read, so an all-null projection degrades to `null` ("unknown")
  // and only genuinely-present populations contribute to the count.
  //
  // `features`, `storage`, `operations`, and the `productivity`/`activity`
  // summary rows are deliberately absent — see THRESHOLDS above.
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
  // `??` (not `||`) so a measured zero-failure day stays 0 rather than
  // falling through to the coarse health signal.
  const measured = measuredFailureRate(productivity);
  const failureRate = measured ?? healthFailureRate(world?.health);

  // Peers this mind can actually travel to. This is NOT "peers with unread
  // contributions": a peer is only a travel destination when `listEidoverse
  // Destinations()` saw it `status === 'online'`, which `coarseStatus` maps to
  // `active` — so filtering the projection for a non-`steady` status was true
  // for every travelable peer and measured nothing. Reachability is a
  // NECESSARY-BUT-INSUFFICIENT precondition for `coordinate` (you cannot visit
  // a peer you cannot reach); `peerContributionsUnread` is what makes it fire.
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
 * Pick the active playbook phase from bounded signals. Never throws: an
 * absent or malformed signal set degrades to `explore`, the safe default for
 * a mind that cannot yet see the world it would otherwise
 * construct/maintain/coordinate in.
 *
 * Priority, highest first: a still-sparse Commons always explores first; a
 * high recent failure rate (or an unhealthy install) outranks everything else,
 * because fixing what is broken comes before building or visiting; a Commons
 * short of the maturity threshold keeps building; a mature Commons with unread
 * peer contributions it can actually reach goes visiting; an otherwise mature
 * Commons falls back to steady-state maintenance.
 *
 * `coordinate` requires BOTH halves of its claim to be measured: unread
 * contributions (what the phase tells the mind is waiting) and a reachable
 * peer (whether it can go). Reachability alone is not enough — one
 * always-online peer would otherwise satisfy it on every wake, and the
 * template would tell the mind peers are waiting when nothing was measured.
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
    // Only a MEASURED rate is reported as one. The health-derived fallback is
    // a coarse enum standing in for a rate nobody took, and printing it as a
    // percentage claims a measurement that was never made.
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
