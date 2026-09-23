import { describe, it, expect, beforeEach, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  daemonRunning: true,
  state: null,
  savedState: null,
  // `null` = PM2 read failed (issue #8164 absent-vs-empty contract); an array
  // (incl. []) = a successful read.
  pm2Processes: [],
  restartImpl: null,
  events: [],
  // PM2 process names belonging to desktop (GUI) apps — exempt from auto-restart.
  desktopProcessNames: new Set(),
  desktopLookupError: null
}));

// Mocked so the health check never reads the real apps registry off disk.
// Mirrors the real annotateExpectedExit, including its fail-open behavior: a
// registry read failure marks nothing expected, so nothing is exempted.
vi.mock('./appProcessStatus.js', () => ({
  annotateExpectedExit: vi.fn(async (processes) => {
    const names = mock.desktopLookupError ? new Set() : mock.desktopProcessNames;
    return processes.map(p => ({ ...p, expectedExit: names.has(p?.name) }));
  })
}));

vi.mock('./cosState.js', () => ({
  loadState: vi.fn(async () => mock.state),
  saveState: vi.fn(async (s) => { mock.savedState = s; }),
  withStateLock: async (fn) => fn(),
  isDaemonRunning: () => mock.daemonRunning
}));

// The process READ now goes through the strict, mapped-shape reader
// (`listProcessesStrict` — issue #8164) instead of raw `execPm2(['jlist'])` +
// private parsing; `execPm2` remains only for the auto-restart call. Restarts
// deliberately do NOT go through execFile('pm2', …, { shell: true }) — that
// resolves to pm2.cmd on Windows and flashes a console window
// (docs/WINDOWS_CONSOLE.md).
vi.mock('./pm2.js', () => ({
  execPm2: vi.fn(async (args) => mock.restartImpl(args)),
  listProcessesStrict: vi.fn(async () => mock.pm2Processes)
}));

vi.mock('../lib/memoryStats.js', () => ({
  getMemoryStats: vi.fn(async () => ({ usedMb: 100 }))
}));

vi.mock('./cosEvents.js', () => ({
  cosEvents: { emit: (name, payload) => mock.events.push({ name, payload }) },
  emitLog: vi.fn()
}));

import { runHealthCheck, getHealthStatus } from './cosHealthMonitor.js';

// The restart assertions differ only in what they record off the pm2 argv —
// the whole argv, or just the process name.
const recordRestarts = (sink, pick = (args) => args) => async (args) => {
  sink.push(pick(args));
  return { stdout: 'restarted', stderr: '' };
};

const baseState = () => ({
  config: { maxTotalProcesses: 10, maxProcessMemoryMb: 1024 },
  stats: {}
});

describe('cosHealthMonitor.runHealthCheck', () => {
  beforeEach(() => {
    mock.daemonRunning = true;
    mock.state = baseState();
    mock.savedState = null;
    mock.pm2Processes = [];
    mock.events = [];
    mock.desktopProcessNames = new Set();
    mock.desktopLookupError = null;
    // default restart success
    mock.restartImpl = async () => ({ stdout: 'restarted', stderr: '' });
  });

  it('short-circuits when the daemon is not running', async () => {
    mock.daemonRunning = false;
    const result = await runHealthCheck();
    expect(result).toBeUndefined();
    expect(mock.savedState).toBeNull();
  });

  // Issue #8164: a FAILED PM2 read (listProcessesStrict → null) must be
  // recorded as unavailable, never as zero processes — collapsing it to []
  // would suppress restart of a genuinely errored process and report a
  // health check as clean when PM2 was simply unreachable.
  it('records PM2 metrics as unavailable (not empty) when the read fails', async () => {
    mock.pm2Processes = null;
    const { metrics, issues } = await runHealthCheck();
    expect(metrics.pm2).toBeNull();
    expect(issues.some(i => i.type === 'error' && i.category === 'processes' && /read failed/.test(i.message))).toBe(true);
  });

  it('attempts no auto-restart when the PM2 read fails', async () => {
    mock.pm2Processes = null;
    const restarted = [];
    mock.restartImpl = recordRestarts(restarted);
    await runHealthCheck();
    expect(restarted).toEqual([]);
  });

  it('counts a genuine empty read as zero processes, not unavailable', async () => {
    mock.pm2Processes = [];
    const { metrics } = await runHealthCheck();
    expect(metrics.pm2).toEqual({ total: 0, online: 0, errored: 0, stopped: 0, desktopExited: 0 });
  });

  it('flags a high process count over the configured limit', async () => {
    mock.pm2Processes = Array.from({ length: 12 }, (_, i) => ({ name: `p${i}`, status: 'online' }));
    const { issues } = await runHealthCheck();
    expect(issues.some(i => i.category === 'processes' && /High process count/.test(i.message))).toBe(true);
  });

  it('auto-restarts errored processes without reporting a resolved problem', async () => {
    mock.pm2Processes = [{ name: 'boom', status: 'errored' }];
    const { issues } = await runHealthCheck();
    expect(issues).toEqual([]);
    expect(issues.some(i => i.type === 'error')).toBe(false);
  });

  it('records an error issue and emits health:critical when a restart fails', async () => {
    mock.pm2Processes = [{ name: 'boom', status: 'errored' }];
    mock.restartImpl = async () => { throw new Error('restart failed'); };
    const { issues } = await runHealthCheck();
    expect(issues.some(i => i.type === 'error' && /failed to auto-restart/.test(i.message))).toBe(true);
    expect(mock.events.some(e => e.name === 'health:critical')).toBe(true);
  });

  // Desktop (GUI) processes: closing or force-quitting the window can leave PM2
  // `errored`, and restarting would reopen the window the user just closed —
  // the relaunch loop `autorestart: false` prevents, by another path (#2991).
  describe('desktop (GUI) process exemption', () => {
    const erroredGame = () => [{ name: 'game', status: 'errored' }];

    it('never auto-restarts an errored desktop process', async () => {
      mock.desktopProcessNames = new Set(['game']);
      mock.pm2Processes = erroredGame();
      const restarted = [];
      mock.restartImpl = recordRestarts(restarted);

      const { issues } = await runHealthCheck();

      expect(restarted).toEqual([]);
      expect(issues.some(i => /Auto-restarted/.test(i.message))).toBe(false);
    });

    it('reports a quit game separately instead of as an error', async () => {
      mock.desktopProcessNames = new Set(['game']);
      mock.pm2Processes = erroredGame();

      const { metrics } = await runHealthCheck();

      expect(metrics.pm2.errored).toBe(0);
      expect(metrics.pm2.desktopExited).toBe(1);
    });

    it('counts a cleanly stopped desktop process as exited too', async () => {
      mock.desktopProcessNames = new Set(['game']);
      mock.pm2Processes = [{ name: 'game', status: 'stopped' }];

      const { metrics } = await runHealthCheck();

      expect(metrics.pm2.errored).toBe(0);
      expect(metrics.pm2.desktopExited).toBe(1);
    });

    it('still counts a RUNNING desktop process as online', async () => {
      // The exemption is about exit semantics, not liveness. Filtering `online`
      // on it too would leave a live game in `total` and in no bucket at all —
      // and make the metric read identically whether it is running or quit.
      mock.desktopProcessNames = new Set(['game']);
      mock.pm2Processes = [
        { name: 'game', status: 'online' },
        { name: 'web', status: 'online' }
      ];

      const { metrics } = await runHealthCheck();

      expect(metrics.pm2).toEqual({ total: 2, online: 2, errored: 0, stopped: 0, desktopExited: 0 });
    });

    it('still auto-restarts non-desktop processes alongside an exempt one', async () => {
      mock.desktopProcessNames = new Set(['game']);
      mock.pm2Processes = [
        { name: 'game', status: 'errored' },
        { name: 'web', status: 'errored' }
      ];
      const restarted = [];
      mock.restartImpl = recordRestarts(restarted, (args) => args[1]);

      const { metrics, issues } = await runHealthCheck();

      expect(restarted).toEqual(['web']);
      expect(metrics.pm2.errored).toBe(1);
      expect(issues).toEqual([]);
    });

    it('exempts nothing when the registry read fails (pre-existing behavior stands)', async () => {
      mock.desktopLookupError = new Error('registry unreadable');
      mock.pm2Processes = [{ name: 'web', status: 'errored' }];
      const restarted = [];
      mock.restartImpl = recordRestarts(restarted, (args) => args[1]);

      const { metrics } = await runHealthCheck();

      expect(restarted).toEqual(['web']);
      expect(metrics.pm2.errored).toBe(1);
    });
  });

  it('keeps memory telemetry without flagging large processes', async () => {
    mock.pm2Processes = [
      { name: 'example-worker', status: 'online' },
      { name: 'portos-llama-server', status: 'online' }
    ];
    const { metrics, issues } = await runHealthCheck();
    expect(metrics.memory).toEqual({ usedMb: 100 });
    expect(issues).toEqual([]);
  });

  it('persists the latest snapshot to state and emits health:check', async () => {
    mock.pm2Processes = [];
    const { metrics } = await runHealthCheck();
    expect(mock.savedState.stats.lastHealthCheck).toBe(metrics.timestamp);
    expect(mock.events.some(e => e.name === 'health:check')).toBe(true);
  });
});

describe('cosHealthMonitor.getHealthStatus', () => {
  it('returns the persisted last check and issues', async () => {
    mock.state = { ...baseState(), stats: { lastHealthCheck: 'T', healthIssues: [{ type: 'warning' }] } };
    const status = await getHealthStatus();
    expect(status).toEqual({ lastCheck: 'T', issues: [{ type: 'warning' }] });
  });

  it('drops legacy memory and successful-restart warnings before the next poll', async () => {
    const failure = { type: 'error', category: 'processes', message: 'Failed to restart' };
    mock.state = { ...baseState(), stats: { healthIssues: [
      { type: 'warning', category: 'memory', message: 'High memory usage' },
      { type: 'warning', category: 'processes', message: 'Auto-restarted 1 errored PM2 process(es)' },
      failure
    ] } };
    expect((await getHealthStatus()).issues).toEqual([failure]);
  });

  it('defaults issues to an empty array when none recorded', async () => {
    mock.state = { ...baseState(), stats: {} };
    const status = await getHealthStatus();
    expect(status.issues).toEqual([]);
  });
});
