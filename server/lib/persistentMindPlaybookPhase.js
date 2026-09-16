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
 * from `buildEidoverseWorldSignals()` (see `derivePersistentMindPlaybookPhaseSignals`)
 * and returns a phase plus a short human-readable reason. Live signal
 * gathering (I/O) lives in `server/services/persistentMindPlaybookSignals.js`.
 */

export const PERSISTENT_MIND_PLAYBOOK_PHASES = Object.freeze([
  'explore',
  'construct',
  'maintain',
  'coordinate',
]);

/**
 * Thresholds are counted in live world-signal entities — one per projected
 * district landmark/aggregate from `buildEidoverseWorldSignals()` (apps,
 * agents, tasks, enabled features, peers, activity days, goals, memory
 * categories, storage areas, Jira groups, operations) — the same population
 * the Eidoverse World Design V2 recipe places across its eight districts.
 */
const THRESHOLDS = Object.freeze({
  sparseDistrictCount: 4,
  matureDistrictCount: 16,
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
 * Reduce a `buildEidoverseWorldSignals()` projection (see
 * `server/lib/eidoverseWorldSignals.js`) to the bounded numbers the phase
 * picker needs. Every field degrades to `null` ("unknown") rather than a
 * guessed zero when the source signal was unavailable, so the picker can
 * fall back to the safe `explore` phase instead of reading absence as
 * emptiness.
 */
export function derivePersistentMindPlaybookPhaseSignals(worldSignals) {
  if (!worldSignals || typeof worldSignals !== 'object') {
    return { districtCount: null, failureRate: null, failureRateMeasured: false, peersReachable: null };
  }

  // A failed source read arrives as `null`, not `[]`. Counting those as zero
  // would report a confidently empty Commons when the truth is that nothing
  // could be read, so an all-null projection degrades to `null` ("unknown")
  // and only genuinely-present districts contribute to the count.
  const districtEntries = [
    worldSignals.apps, worldSignals.agents, worldSignals.tasks, worldSignals.features,
    worldSignals.peers, worldSignals.activity, worldSignals.goals, worldSignals.memory,
    worldSignals.storage, worldSignals.jira, worldSignals.operations,
  ].filter((entries) => Array.isArray(entries));
  const districtCount = districtEntries.length > 0
    ? districtEntries.reduce((total, entries) => total + entries.length, 0)
    : null;

  const productivity = Array.isArray(worldSignals.productivity) ? worldSignals.productivity[0] : null;
  // `??` (not `||`) so a measured zero-failure day stays 0 rather than
  // falling through to the coarse health signal.
  const measured = measuredFailureRate(productivity);
  const failureRate = measured ?? healthFailureRate(worldSignals.health);

  // Peers this mind can actually travel to. This is NOT "peers with unread
  // contributions": a peer is only a travel destination when `listEidoverse
  // Destinations()` saw it `status === 'online'`, which `coarseStatus` maps to
  // `active` — so filtering the projection for a non-`steady` status was true
  // for every travelable peer and measured nothing. Count reachability, say
  // reachability, and let it rank below construction so one permanently-online
  // peer cannot pin every wake to `coordinate`.
  const peersReachable = Array.isArray(worldSignals.peers)
    ? worldSignals.peers.filter((peer) => peer?.travelAvailable === true).length
    : null;

  return { districtCount, failureRate, failureRateMeasured: measured !== null, peersReachable };
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
 * short of the maturity threshold keeps building; a mature Commons with a
 * reachable peer goes visiting; an otherwise mature, peer-less Commons falls
 * back to steady-state maintenance.
 *
 * `coordinate` deliberately ranks BELOW `construct`. The peer signal measures
 * reachability, not unread activity, so a single always-online peer would
 * otherwise satisfy it on every wake and `construct` would never run.
 */
export function selectPersistentMindPlaybookPhase(signals = {}) {
  const districtCount = nonNegativeIntOrNull(signals.districtCount);
  const failureRate = clampFractionOrNull(signals.failureRate);
  const peersReachable = nonNegativeIntOrNull(signals.peersReachable);

  if (districtCount === null || districtCount < THRESHOLDS.sparseDistrictCount) {
    return {
      phase: 'explore',
      reason: districtCount === null ? 'world signals unavailable' : `sparse Commons (${districtCount} live signal(s))`,
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
    return { phase: 'construct', reason: `${districtCount} live signal(s), room to densify before ${THRESHOLDS.matureDistrictCount}` };
  }
  if (peersReachable !== null && peersReachable > 0) {
    return { phase: 'coordinate', reason: `${peersReachable} reachable peer(s) to visit` };
  }
  return { phase: 'maintain', reason: `mature Commons (${districtCount} live signal(s)), steady-state upkeep` };
}
