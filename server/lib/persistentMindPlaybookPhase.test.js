import { describe, expect, it } from 'vitest';
import { buildEidoverseWorldSignals, eidoversePeerId } from './eidoverseWorldSignals.js';
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
    expect(selectPersistentMindPlaybookPhase({ districtCount: 3 }).phase).toBe('explore');
  });

  it('constructs once the Commons clears the sparse threshold with no failures or peer activity', () => {
    const result = selectPersistentMindPlaybookPhase({ districtCount: 4, failureRate: 0, peersReachable: 0 });
    expect(result).toMatchObject({ phase: 'construct' });
  });

  it('maintains when the recent failure rate crosses the threshold, even with peers reachable', () => {
    const result = selectPersistentMindPlaybookPhase({
      districtCount: 10, failureRate: 0.25, failureRateMeasured: true, peersReachable: 3,
    });
    expect(result).toMatchObject({ phase: 'maintain', reason: expect.stringContaining('25%') });
  });

  // The health-derived rate is a coarse enum standing in for a measurement
  // nobody took. It still routes to `maintain`, but printing it as "50% recent
  // failure rate" would claim a rate on a day when zero work ran.
  it('never reports an unmeasured, health-derived rate as a percentage', () => {
    const result = selectPersistentMindPlaybookPhase({
      districtCount: 10, failureRate: 0.5, failureRateMeasured: false, peersReachable: 0,
    });
    expect(result.phase).toBe('maintain');
    expect(result.reason).not.toMatch(/%/);
    expect(result.reason).toContain('health');
  });

  // A reachable peer must not outrank construction: the peer signal measures
  // reachability, so one always-online peer would otherwise pin every wake to
  // `coordinate` and `construct` would never run.
  it('keeps building below the mature threshold even with a reachable peer', () => {
    const result = selectPersistentMindPlaybookPhase({ districtCount: 10, failureRate: 0.1, peersReachable: 1 });
    expect(result).toMatchObject({ phase: 'construct' });
  });

  it('coordinates once the Commons is mature and a peer is reachable', () => {
    const result = selectPersistentMindPlaybookPhase({ districtCount: 16, failureRate: 0.1, peersReachable: 1 });
    expect(result).toMatchObject({ phase: 'coordinate', reason: expect.stringContaining('reachable peer') });
  });

  it('stays in construct just below the mature threshold once failures/peers are quiet', () => {
    const result = selectPersistentMindPlaybookPhase({ districtCount: 15, failureRate: 0, peersReachable: 0 });
    expect(result).toMatchObject({ phase: 'construct' });
  });

  it('falls back to maintain for a mature, healthy, peer-quiet Commons', () => {
    const result = selectPersistentMindPlaybookPhase({ districtCount: 16, failureRate: 0, peersReachable: 0 });
    expect(result).toMatchObject({ phase: 'maintain', reason: expect.stringContaining('mature') });
  });

  it('always resolves to a documented phase', () => {
    const matrix = [
      {},
      { districtCount: -5, failureRate: -1, peersReachable: -2 },
      { districtCount: Number.NaN, failureRate: Number.NaN },
      { districtCount: 100, failureRate: 0.9, peersReachable: 5 },
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
    const empty = { districtCount: null, failureRate: null, failureRateMeasured: false, peersReachable: null };
    expect(derivePersistentMindPlaybookPhaseSignals(null)).toEqual(empty);
    expect(derivePersistentMindPlaybookPhaseSignals('not-an-object')).toEqual(empty);
  });

  it('sums entities across every projected district array', () => {
    const signals = derivePersistentMindPlaybookPhaseSignals({
      apps: [{ id: 'a' }, { id: 'b' }],
      agents: [{ id: 'c' }],
      tasks: null,
      features: [{ id: 'd' }],
      peers: [],
      activity: [{ id: 'e' }, { id: 'f' }, { id: 'g' }],
      goals: undefined,
      memory: [{ id: 'h' }],
      storage: [{ id: 'i' }, { id: 'j' }],
      jira: [],
      operations: [{ id: 'k' }],
    });
    expect(signals.districtCount).toBe(2 + 1 + 0 + 1 + 0 + 3 + 0 + 1 + 2 + 0 + 1);
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
});

describe('contract with buildEidoverseWorldSignals()', () => {
  // Reads a real projection (not a hand-built fixture matching this module's
  // own assumptions) so a future shape change to eidoverseWorldSignals.js
  // that silently breaks phase derivation fails here rather than only in
  // production. See server/lib/eidoverseWorldSignals.js.
  it('derives a sane, non-null signal set from a representative world-signals projection', () => {
    const peerId = eidoversePeerId({ instanceId: 'fixture-peer' });
    const worldSignals = buildEidoverseWorldSignals({
      apps: [{ overallStatus: 'online', managed: true }, { overallStatus: 'stopped', managed: false }],
      agents: [{ id: 'agent-1', status: 'running' }],
      taskState: { tasks: [{ id: 'task-1', status: 'pending' }] },
      cosStatus: { running: true, activeAgents: 1, pausedAgents: 0 },
      review: { total: 2, cos: 1, alert: 0 },
      featuresState: { features: [{ id: 'feature-a', enabled: true }] },
      peers: [{ instanceId: 'fixture-peer', enabled: true, status: 'active' }],
      backupState: { status: 'success', filesChanged: 3 },
      notifications: { total: 4, unread: 1 },
      character: { level: 3 },
      voiceConfig: { enabled: false },
      memory: { total: 100, used: 10 },
      diskPercent: 40,
      todayActivity: { stats: { completed: 5, succeeded: 4, failed: 1, successRate: 80 }, isRunning: false, isPaused: false },
      velocity: { today: 5, todaySuccesses: 4, todayFailures: 1, velocity: 1.2, avgPerDay: 3, historicalDays: 30 },
      activityCalendar: { weeks: [], summary: {} },
      goalsData: { goals: [{ id: 'goal-1', status: 'active', progress: 40, milestones: [], todos: [] }] },
      memoryGraph: { nodes: [{ id: 'n1', category: 'fact', importance: 1 }], edges: [] },
      inboxCounts: { total: 1, needs_review: 0, classifying: 0 },
      introspection: { db: { tables: ['t1'] }, fs: { domains: ['d1'], totalBytes: 10, totalFiles: 2 } },
      jira: [],
      destinations: new Set([peerId]),
    });

    const signals = derivePersistentMindPlaybookPhaseSignals(worldSignals);
    expect(signals.districtCount).toBeGreaterThan(0);
    expect(signals.failureRate).not.toBeNull();
    expect(signals.peersReachable).toBe(1);
    expect(PERSISTENT_MIND_PLAYBOOK_PHASES).toContain(selectPersistentMindPlaybookPhase(signals).phase);
  });
});
