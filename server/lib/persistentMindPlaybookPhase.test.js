import { describe, expect, it } from 'vitest';
import { buildEidoverseWorldSignals, eidoversePeerId } from './eidoverseWorldSignals.js';
import { buildEidoverseObservation } from './eidoverseObservation.js';
import {
  PERSISTENT_MIND_PLAYBOOK_PHASES,
  derivePersistentMindPlaybookPhaseSignals,
  selectPersistentMindPlaybookPhase,
} from './persistentMindPlaybookPhase.js';

describe('selectPersistentMindPlaybookPhase', () => {
  it('explores when signals are entirely unavailable', () => {
    expect(selectPersistentMindPlaybookPhase()).toMatchObject({ phase: 'explore', reason: expect.stringContaining('unavailable') });
    expect(selectPersistentMindPlaybookPhase({ districtCount: null })).toMatchObject({ phase: 'explore' });
  });

  it('explores a Commons at and just below the sparse threshold', () => {
    expect(selectPersistentMindPlaybookPhase({ districtCount: 0 }).phase).toBe('explore');
    expect(selectPersistentMindPlaybookPhase({ districtCount: 2 }).phase).toBe('explore');
  });

  it('constructs once the Commons clears the sparse threshold with no failures or peer activity', () => {
    const result = selectPersistentMindPlaybookPhase({ districtCount: 3, failureRate: 0, peersReachable: 0 });
    expect(result).toMatchObject({ phase: 'construct' });
  });

  it('maintains when the recent failure rate crosses the threshold, even with unread peer contributions', () => {
    const result = selectPersistentMindPlaybookPhase({
      districtCount: 20, failureRate: 0.25, failureRateMeasured: true, peersReachable: 3, peerContributionsUnread: 4,
    });
    expect(result).toMatchObject({ phase: 'maintain', reason: expect.stringContaining('25%') });
  });

  // The health-derived rate is a coarse enum standing in for a measurement
  // nobody took. It still routes to `maintain`, but printing it as "50% recent
  // failure rate" would claim a rate on a day when zero work ran.
  it('never reports an unmeasured, health-derived rate as a percentage', () => {
    const result = selectPersistentMindPlaybookPhase({
      districtCount: 20, failureRate: 0.5, failureRateMeasured: false, peersReachable: 0,
    });
    expect(result.phase).toBe('maintain');
    expect(result.reason).not.toMatch(/%/);
    expect(result.reason).toContain('health');
  });

  // Coordination must not outrank construction below the maturity threshold:
  // a mind with a thin Commons should keep building rather than go visiting.
  it('keeps building below the mature threshold even with unread peer contributions', () => {
    const result = selectPersistentMindPlaybookPhase({
      districtCount: 10, failureRate: 0.1, peersReachable: 1, peerContributionsUnread: 3,
    });
    expect(result).toMatchObject({ phase: 'construct' });
  });

  // The regression #7630 names: reachability alone selected `coordinate`, and
  // the template it selects tells the mind "peers have activity worth your
  // attention" — a claim nothing measured. One always-online peer made that
  // the steady state for every mature install.
  it('does not coordinate for a reachable peer with nothing unread', () => {
    expect(selectPersistentMindPlaybookPhase({
      districtCount: 20, failureRate: 0, peersReachable: 2, peerContributionsUnread: 0,
    })).toMatchObject({ phase: 'maintain' });
    // An unmeasured contribution count (first observation, failed read) is
    // likewise not a reason to claim a peer is waiting.
    expect(selectPersistentMindPlaybookPhase({
      districtCount: 20, failureRate: 0, peersReachable: 2, peerContributionsUnread: null,
    })).toMatchObject({ phase: 'maintain' });
  });

  // Reachability stays a necessary-but-insufficient precondition: a mind
  // cannot visit a peer it cannot travel to, however much arrived from it.
  it('does not coordinate with unread contributions from an unreachable peer', () => {
    expect(selectPersistentMindPlaybookPhase({
      districtCount: 20, failureRate: 0, peersReachable: 0, peerContributionsUnread: 3,
    })).toMatchObject({ phase: 'maintain' });
  });

  it('coordinates once the Commons is mature and unread contributions arrived from a reachable peer', () => {
    const result = selectPersistentMindPlaybookPhase({
      districtCount: 12, failureRate: 0.1, peersReachable: 1, peerContributionsUnread: 2,
    });
    expect(result).toMatchObject({ phase: 'coordinate', reason: expect.stringContaining('unread peer contribution') });
  });

  it('stays in construct just below the mature threshold once failures/peers are quiet', () => {
    const result = selectPersistentMindPlaybookPhase({ districtCount: 11, failureRate: 0, peersReachable: 0 });
    expect(result).toMatchObject({ phase: 'construct' });
  });

  it('falls back to maintain for a mature, healthy, peer-quiet Commons', () => {
    const result = selectPersistentMindPlaybookPhase({ districtCount: 12, failureRate: 0, peersReachable: 0 });
    expect(result).toMatchObject({ phase: 'maintain', reason: expect.stringContaining('mature') });
  });

  it('always resolves to a documented phase', () => {
    const matrix = [
      {},
      { districtCount: -5, failureRate: -1, peersReachable: -2, peerContributionsUnread: -3 },
      { districtCount: Number.NaN, failureRate: Number.NaN },
      { districtCount: 100, failureRate: 0.9, peersReachable: 5, peerContributionsUnread: 5 },
    ];
    for (const signals of matrix) {
      expect(PERSISTENT_MIND_PLAYBOOK_PHASES).toContain(selectPersistentMindPlaybookPhase(signals).phase);
    }
  });

  it('treats a negative/NaN failure rate as absent rather than throwing', () => {
    expect(() => selectPersistentMindPlaybookPhase({ districtCount: 10, failureRate: Number.NaN })).not.toThrow();
    expect(selectPersistentMindPlaybookPhase({ districtCount: 10, failureRate: -1 }).phase).toBe('construct');
  });
});

describe('derivePersistentMindPlaybookPhaseSignals', () => {
  it('returns null signals for a missing or malformed world-signals projection', () => {
    const empty = {
      districtCount: null, failureRate: null, failureRateMeasured: false, peersReachable: null, peerContributionsUnread: null,
    };
    expect(derivePersistentMindPlaybookPhaseSignals(null)).toEqual(empty);
    expect(derivePersistentMindPlaybookPhaseSignals('not-an-object')).toEqual(empty);
  });

  it('sums only the populations a mind grows, never the install-constant scaffolding', () => {
    const signals = derivePersistentMindPlaybookPhaseSignals({
      apps: [{ id: 'a' }, { id: 'b' }],
      agents: [{ id: 'c' }],
      tasks: null,
      peers: [],
      goals: undefined,
      memory: [{ id: 'h' }],
      jira: [],
      // Install-constant scaffolding: ~15 feature rows whether enabled or not,
      // two fixed storage areas, and one summary row each for operations,
      // productivity, and activity. These put a floor of ~19 under the old
      // count and made explore/construct unreachable (#7630).
      features: [{ id: 'd' }, { id: 'e' }, { id: 'f' }],
      storage: [{ id: 'i' }, { id: 'j' }],
      operations: [{ id: 'k' }],
      productivity: [{ id: 'p' }],
      activity: [{ id: 'q' }],
    });
    expect(signals.districtCount).toBe(2 + 1 + 0 + 1 + 0);
  });

  it('adds locally-authored foundations and installed controllers, excluding inherited copies', () => {
    // A mind that inherited fifty foundations has a well-connected Commons,
    // not a densely-built one, so `inherited` (a subset of `baseline`) is
    // subtracted rather than counted as construction.
    const signals = derivePersistentMindPlaybookPhaseSignals({ apps: [{ id: 'a' }] }, {
      foundations: { counts: { vernacular: 3, baseline: 5, candidates: 1, inherited: 4 } },
      controllers: { counts: { total: 2, armed: 1, delivering: 0 } },
    });
    expect(signals.districtCount).toBe(1 + (3 + 5 - 4) + 2);
  });

  it('treats an unavailable observation as unknown rather than as zero built entities', () => {
    // A failed observation read must not report "this mind has authored
    // nothing" — that is the absent-vs-empty rule the density signal already
    // applies to the world projection.
    const withoutObservation = derivePersistentMindPlaybookPhaseSignals({ apps: [{ id: 'a' }] }, null);
    expect(withoutObservation.districtCount).toBe(1);
    expect(withoutObservation.peerContributionsUnread).toBeNull();

    const everythingUnavailable = derivePersistentMindPlaybookPhaseSignals({ apps: null, agents: null }, null);
    expect(everythingUnavailable.districtCount).toBeNull();

    // An observation alone still measures something, even with no projection.
    const observationOnly = derivePersistentMindPlaybookPhaseSignals(null, {
      foundations: { counts: { vernacular: 2, baseline: 0, candidates: 0, inherited: 0 } },
      controllers: { counts: { total: 0, armed: 0, delivering: 0 } },
    });
    expect(observationOnly.districtCount).toBe(2);
  });

  it('prefers today failed/succeeded counts over successRate when both are present', () => {
    const signals = derivePersistentMindPlaybookPhaseSignals({
      productivity: [{ succeededToday: 3, failedToday: 1, successRate: 99 }],
    });
    expect(signals.failureRate).toBeCloseTo(0.25);
  });

  it('falls back to successRate, then to health status, when today counts are unavailable', () => {
    // successRate is only trustworthy alongside evidence that work ran.
    const viaSuccessRate = derivePersistentMindPlaybookPhaseSignals({ productivity: [{ completedToday: 5, successRate: 80 }] });
    expect(viaSuccessRate.failureRate).toBeCloseTo(0.2);

    const viaHealthError = derivePersistentMindPlaybookPhaseSignals({ health: { status: 'error' } });
    expect(viaHealthError.failureRate).toBe(1);
    const viaHealthAttention = derivePersistentMindPlaybookPhaseSignals({ health: { status: 'attention' } });
    expect(viaHealthAttention.failureRate).toBe(0.5);
    const viaHealthHealthy = derivePersistentMindPlaybookPhaseSignals({ health: { status: 'healthy' } });
    expect(viaHealthHealthy.failureRate).toBe(0);

    expect(derivePersistentMindPlaybookPhaseSignals({}).failureRate).toBeNull();
  });

  it('reads an idle day as "no failure signal", never as a 100% failure rate', () => {
    // getTodayActivity() reports successRate: 0 when zero agents ran today.
    // Trusting that unguarded made every pre-first-task wake claim a 100%
    // failure rate and forced `maintain`, starving construct/coordinate.
    const idleDay = { completedToday: 0, succeededToday: 0, failedToday: 0, successRate: 0 };

    expect(derivePersistentMindPlaybookPhaseSignals({ productivity: [idleDay] }).failureRate).toBeNull();
    expect(derivePersistentMindPlaybookPhaseSignals({ productivity: [idleDay], health: { status: 'healthy' } }).failureRate).toBe(0);

    // End to end: a mid-density Commons on an idle, healthy morning builds.
    const signals = derivePersistentMindPlaybookPhaseSignals({
      apps: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }],
      productivity: [idleDay],
      health: { status: 'healthy' },
    });
    expect(selectPersistentMindPlaybookPhase(signals).phase).toBe('construct');
  });

  it('keeps a measured zero-failure day at 0 rather than falling through to health', () => {
    const signals = derivePersistentMindPlaybookPhaseSignals({
      productivity: [{ completedToday: 8, succeededToday: 8, failedToday: 0, successRate: 100 }],
      health: { status: 'attention' },
    });
    expect(signals.failureRate).toBe(0);
  });

  it('distinguishes every district read failing (null) from a genuinely empty Commons (0)', () => {
    // buildEidoverseWorldSignals() returns null per district when that source
    // read failed. Summing those as 0 would report a confidently empty world
    // and hide the outage behind "sparse Commons (0 live signal(s))".
    const allSourcesFailed = {
      apps: null, agents: null, tasks: null, features: null, peers: null,
      activity: null, goals: null, memory: null, storage: null, jira: null, operations: null,
    };
    expect(derivePersistentMindPlaybookPhaseSignals(allSourcesFailed).districtCount).toBeNull();
    expect(selectPersistentMindPlaybookPhase(derivePersistentMindPlaybookPhaseSignals(allSourcesFailed)).reason)
      .toContain('unavailable');

    // A district that really is empty still reports a measured zero.
    const measuredEmpty = derivePersistentMindPlaybookPhaseSignals({ ...allSourcesFailed, apps: [] });
    expect(measuredEmpty.districtCount).toBe(0);
    expect(selectPersistentMindPlaybookPhase(measuredEmpty).reason).toContain('sparse');
  });

  // Reachability is the whole signal. A travel destination is only ever built
  // from a peer `listEidoverseDestinations()` saw as `online`, which
  // `coarseStatus` maps to `active` — so a status filter on top of
  // `travelAvailable` matched every travelable peer and measured nothing.
  it('counts travelable peers regardless of their coarse status', () => {
    const signals = derivePersistentMindPlaybookPhaseSignals({
      peers: [
        { travelAvailable: true, status: 'active' },
        { travelAvailable: true, status: 'steady' },
        { travelAvailable: false, status: 'attention' },
        { travelAvailable: true, status: 'error' },
      ],
    });
    expect(signals.peersReachable).toBe(3);
  });

  describe('peerContributionsUnread', () => {
    const observationWith = (changes, inheritedRows = []) => ({
      foundations: { counts: { vernacular: 0, baseline: 0, candidates: 0, inherited: 0 }, inherited: inheritedRows },
      changes,
    });

    it('is null on a first observation, which measured nothing to compare against', () => {
      const signals = derivePersistentMindPlaybookPhaseSignals({}, observationWith({
        firstObservation: true, newFoundations: [], newPeers: [],
      }));
      expect(signals.peerContributionsUnread).toBeNull();
    });

    it('is a measured zero when the marker diff ran and nothing arrived', () => {
      const signals = derivePersistentMindPlaybookPhaseSignals({}, observationWith({
        firstObservation: false, newFoundations: [], newPeers: [],
      }));
      expect(signals.peerContributionsUnread).toBe(0);
    });

    it('ignores foundations this mind authored itself since the last look', () => {
      // `changes.newFoundations` lists every foundation id absent from the
      // marker, including the mind's own work. Counting those would tell it a
      // peer is waiting because of something it built.
      const signals = derivePersistentMindPlaybookPhaseSignals({}, observationWith(
        { firstObservation: false, newFoundations: ['local:mine'], newPeers: [] },
        [{ id: 'peer:alpha:one' }],
      ));
      expect(signals.peerContributionsUnread).toBe(0);
    });

    it('counts newly inherited foundations and newly appeared peers', () => {
      const signals = derivePersistentMindPlaybookPhaseSignals({}, observationWith(
        { firstObservation: false, newFoundations: ['peer:alpha:one', 'local:mine'], newPeers: ['peer-digest'] },
        [{ id: 'peer:alpha:one' }],
      ));
      expect(signals.peerContributionsUnread).toBe(2);
    });

    it('is null when the observation carries no readable changes section', () => {
      expect(derivePersistentMindPlaybookPhaseSignals({}, { changes: null }).peerContributionsUnread).toBeNull();
      expect(derivePersistentMindPlaybookPhaseSignals({}, observationWith({ firstObservation: false }))
        .peerContributionsUnread).toBeNull();
    });
  });
});

/**
 * Calibration against the SHIPPED builders, not against hand-built signal
 * objects with the counts a test author chose.
 *
 * #7630's root cause is that every earlier fixture here was hand-written, so a
 * count the real builder could never produce (its floor was ~19, above the
 * old mature threshold of 16) passed a suite that pinned only the shape. These
 * cases run `buildEidoverseWorldSignals()` and `buildEidoverseObservation()`
 * and assert that all four phases are reachable from what they actually emit.
 */
describe('calibration against the shipped signal + observation builders', () => {
  const PEER_INSTANCE = 'fixture-peer-instance';
  const PEER_ID = eidoversePeerId({ instanceId: PEER_INSTANCE });

  // The install-constant scaffolding the old count summed: one row per
  // registry feature whether enabled or not (~15 on a shipped install).
  const registryFeatures = (count = 15) => Array.from({ length: count }, (_, index) => ({
    id: `feature-${index}`, enabled: index % 2 === 0,
  }));

  const worldSignalsFor = ({
    apps = [], agents = [], tasks = [], peers = [], goals = [], memoryNodes = [],
    features = registryFeatures(), destinations = new Set(),
  } = {}) => buildEidoverseWorldSignals({
    apps,
    agents,
    taskState: { tasks },
    cosStatus: { running: true, activeAgents: 0, pausedAgents: 0 },
    review: { total: 0, cos: 0, alert: 0 },
    featuresState: { features },
    peers,
    backupState: { status: 'success', filesChanged: 0 },
    notifications: { total: 0, unread: 0 },
    character: { level: 1 },
    voiceConfig: { enabled: false },
    memory: { total: 100, used: 10 },
    diskPercent: 30,
    todayActivity: { stats: { completed: 4, succeeded: 4, failed: 0, successRate: 100 }, isRunning: false, isPaused: false },
    activityCalendar: { weeks: [], summary: {} },
    goalsData: { goals },
    memoryGraph: { nodes: memoryNodes, edges: [] },
    inboxCounts: { total: 0, needs_review: 0, classifying: 0 },
    introspection: { db: { tables: [] }, fs: { domains: [], totalBytes: 0, totalFiles: 0 } },
    jira: [],
    destinations,
  });

  const authored = (id) => ({ id, kind: 'affordance', title: 'Local build', layer: 'vernacular' });
  const inheritedFrom = (id) => ({
    id,
    kind: 'affordance',
    title: 'Inherited build',
    layer: 'baseline',
    inheritance: {
      type: 'inherited-from',
      originInstanceId: PEER_INSTANCE,
      sourceInstanceId: PEER_INSTANCE,
      inheritedAt: '2026-09-17T10:00:00.000Z',
    },
  });

  const countsFor = (foundations) => ({
    vernacular: foundations.filter((entry) => entry.layer === 'vernacular').length,
    baseline: foundations.filter((entry) => entry.layer === 'baseline').length,
    candidates: 0,
    inherited: foundations.filter((entry) => entry.inheritance).length,
  });

  const observationFor = (worldSignals, { foundations = [], controllers = 0, marker = null } = {}) => buildEidoverseObservation({
    source: worldSignals,
    foundations,
    foundationCounts: countsFor(foundations),
    controllerInstalls: [],
    controllerCounts: { total: controllers, armed: controllers, delivering: 0 },
    marker,
    observedAt: '2026-09-18T09:00:00.000Z',
  });

  const phaseFor = (world, observationOptions) => {
    const { report } = observationFor(world, observationOptions);
    return selectPersistentMindPlaybookPhase(derivePersistentMindPlaybookPhaseSignals(world, report));
  };

  const emptyInstall = () => worldSignalsFor();
  const someBuilt = () => worldSignalsFor({
    apps: [{ overallStatus: 'online', managed: true }, { overallStatus: 'online', managed: true }],
    tasks: [{ id: 'task-1', status: 'pending' }],
  });
  const denseCommons = ({ peers = [], destinations = new Set() } = {}) => worldSignalsFor({
    apps: [1, 2, 3, 4].map(() => ({ overallStatus: 'online', managed: true })),
    agents: [{ id: 'agent-1', status: 'running' }, { id: 'agent-2', status: 'running' }],
    tasks: [1, 2, 3, 4, 5].map((n) => ({ id: `task-${n}`, status: 'pending' })),
    goals: [{ id: 'goal-1', status: 'active', progress: 10, milestones: [], todos: [] }],
    memoryNodes: [{ id: 'n1', category: 'fact', importance: 1 }, { id: 'n2', category: 'plan', importance: 1 }],
    peers,
    destinations,
  });

  it('reaches explore on a maximally-empty install', () => {
    // The defect: this install measured 19 and was told its Commons was mature.
    expect(phaseFor(emptyInstall())).toMatchObject({ phase: 'explore' });
  });

  it('reaches construct with a handful of authored foundations and a little live work', () => {
    const foundations = ['f-1', 'f-2', 'f-3'].map(authored);
    expect(phaseFor(someBuilt(), { foundations })).toMatchObject({ phase: 'construct' });
  });

  it('reaches maintain on a dense Commons with nothing unread', () => {
    const foundations = ['f-1', 'f-2', 'f-3', 'f-4', 'f-5', 'f-6'].map(authored);
    expect(phaseFor(denseCommons(), { foundations, controllers: 2 })).toMatchObject({ phase: 'maintain' });
  });

  it('reaches coordinate only once the marker reports a foundation inherited since the last look', () => {
    const peers = [{ instanceId: PEER_INSTANCE, enabled: true, status: 'active' }];
    const world = denseCommons({ peers, destinations: new Set([PEER_ID]) });
    const authoredSix = ['f-1', 'f-2', 'f-3', 'f-4', 'f-5', 'f-6'].map(authored);

    // A settled world: the mind has looked before and nothing arrived since.
    const settled = observationFor(world, { foundations: authoredSix, controllers: 2 });
    const steady = observationFor(world, { foundations: authoredSix, controllers: 2, marker: settled.marker });
    expect(selectPersistentMindPlaybookPhase(derivePersistentMindPlaybookPhaseSignals(world, steady.report)))
      .toMatchObject({ phase: 'maintain' });

    // The mind's OWN new foundation is not a peer waiting.
    const selfAuthored = observationFor(world, {
      foundations: [...authoredSix, authored('f-7')], controllers: 2, marker: settled.marker,
    });
    expect(selfAuthored.report.changes.newFoundations).toContain('f-7');
    expect(selectPersistentMindPlaybookPhase(derivePersistentMindPlaybookPhaseSignals(world, selfAuthored.report)))
      .toMatchObject({ phase: 'maintain' });

    // A foundation inherited from the peer is.
    const arrived = observationFor(world, {
      foundations: [...authoredSix, inheritedFrom('peer:alpha:one')], controllers: 2, marker: settled.marker,
    });
    expect(selectPersistentMindPlaybookPhase(derivePersistentMindPlaybookPhaseSignals(world, arrived.report)))
      .toMatchObject({ phase: 'coordinate' });
  });

  // The guard #7630's acceptance names: density must move with what a mind
  // built and stay still when PortOS scaffolding changes underneath it.
  it('responds to an authored foundation and ignores an instance-feature toggle', () => {
    const foundations = ['f-1', 'f-2', 'f-3'].map(authored);
    const baseline = derivePersistentMindPlaybookPhaseSignals(someBuilt(), observationFor(someBuilt(), { foundations }).report);

    const featuresChanged = worldSignalsFor({
      apps: [{ overallStatus: 'online', managed: true }, { overallStatus: 'online', managed: true }],
      tasks: [{ id: 'task-1', status: 'pending' }],
      // Every feature enabled, plus five more registry entries.
      features: registryFeatures(20).map((feature) => ({ ...feature, enabled: true })),
    });
    const afterToggle = derivePersistentMindPlaybookPhaseSignals(featuresChanged, observationFor(featuresChanged, { foundations }).report);
    expect(afterToggle.districtCount).toBe(baseline.districtCount);
    // The districts themselves still show features — only the maturity signal stops counting them.
    expect(featuresChanged.features).toHaveLength(20);

    const grown = ['f-1', 'f-2', 'f-3', 'f-4'].map(authored);
    const afterAuthoring = derivePersistentMindPlaybookPhaseSignals(someBuilt(), observationFor(someBuilt(), { foundations: grown }).report);
    expect(afterAuthoring.districtCount).toBe(baseline.districtCount + 1);
  });

  it('derives a sane, non-null signal set from a representative projection', () => {
    const world = denseCommons({
      peers: [{ instanceId: PEER_INSTANCE, enabled: true, status: 'active' }],
      destinations: new Set([PEER_ID]),
    });
    const signals = derivePersistentMindPlaybookPhaseSignals(world, observationFor(world).report);
    expect(signals.districtCount).toBeGreaterThan(0);
    expect(signals.failureRate).not.toBeNull();
    expect(signals.peersReachable).toBe(1);
    expect(PERSISTENT_MIND_PLAYBOOK_PHASES).toContain(selectPersistentMindPlaybookPhase(signals).phase);
  });
});
