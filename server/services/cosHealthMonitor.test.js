import { describe, it, expect, beforeEach, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  daemonRunning: true,
  state: null,
  savedState: null,
  pm2Stdout: '[]',
  restartImpl: null,
  events: [],
  // PM2 process names belonging to desktop (GUI) apps — exempt from auto-restart.
  desktopProcessNames: new Set(),
  desktopLookupError: null
}));

// Mocked so the health check never reads the real apps registry off disk.
// Mirrors the real annotateExpectedExit, including its fail-open behavior: a
// registry read failure marks nothing expected, so nothing is exempted.
vi.mock('./apps.js', () => ({
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

// The jlist poll and the auto-restart both run through execPm2 now, so the mock
// dispatches on the verb. Restarts deliberately do NOT go through
// execFile('pm2', …, { shell: true }) — that resolves to pm2.cmd on Windows and
// flashes a console window (docs/WINDOWS_CONSOLE.md).
vi.mock('./pm2.js', () => ({
  execPm2: vi.fn(async (args) => (
    args[0] === 'jlist' ? { stdout: mock.pm2Stdout } : mock.restartImpl(args)
  ))
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
    mock.pm2Stdout = '[]';
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

  it('extracts the JSON array from pm2 output prefixed with ANSI noise', async () => {
    mock.pm2Stdout = '[31mwarning[0m[{"name":"a","pm2_env":{"status":"online"},"monit":{"memory":1000}}]';
    const { metrics } = await runHealthCheck();
    expect(metrics.pm2).toEqual({ total: 1, online: 1, errored: 0, stopped: 0, desktopExited: 0 });
  });

  it('flags a high process count over the configured limit', async () => {
    const procs = Array.from({ length: 12 }, (_, i) => ({ name: `p${i}`, pm2_env: { status: 'online' }, monit: { memory: 0 } }));
    mock.pm2Stdout = JSON.stringify(procs);
    const { issues } = await runHealthCheck();
    expect(issues.some(i => i.category === 'processes' && /High process count/.test(i.message))).toBe(true);
  });

  it('auto-restarts errored processes and records a warning on success', async () => {
    mock.pm2Stdout = JSON.stringify([{ name: 'boom', pm2_env: { status: 'errored' }, monit: { memory: 0 } }]);
    const { issues } = await runHealthCheck();
    expect(issues.some(i => i.type === 'warning' && /Auto-restarted 1/.test(i.message))).toBe(true);
    expect(issues.some(i => i.type === 'error')).toBe(false);
  });

  it('records an error issue and emits health:critical when a restart fails', async () => {
    mock.pm2Stdout = JSON.stringify([{ name: 'boom', pm2_env: { status: 'errored' }, monit: { memory: 0 } }]);
    mock.restartImpl = async () => { throw new Error('restart failed'); };
    const { issues } = await runHealthCheck();
    expect(issues.some(i => i.type === 'error' && /failed to auto-restart/.test(i.message))).toBe(true);
    expect(mock.events.some(e => e.name === 'health:critical')).toBe(true);
  });

  // Desktop (GUI) processes: closing or force-quitting the window can leave PM2
  // `errored`, and restarting would reopen the window the user just closed —
  // the relaunch loop `autorestart: false` prevents, by another path (#2991).
  describe('desktop (GUI) process exemption', () => {
    const erroredGame = () => JSON.stringify([
      { name: 'game', pm2_env: { status: 'errored' }, monit: { memory: 0 } }
    ]);

    it('never auto-restarts an errored desktop process', async () => {
      mock.desktopProcessNames = new Set(['game']);
      mock.pm2Stdout = erroredGame();
      const restarted = [];
      mock.restartImpl = recordRestarts(restarted);

      const { issues } = await runHealthCheck();

      expect(restarted).toEqual([]);
      expect(issues.some(i => /Auto-restarted/.test(i.message))).toBe(false);
    });

    it('reports a quit game separately instead of as an error', async () => {
      mock.desktopProcessNames = new Set(['game']);
      mock.pm2Stdout = erroredGame();

      const { metrics } = await runHealthCheck();

      expect(metrics.pm2.errored).toBe(0);
      expect(metrics.pm2.desktopExited).toBe(1);
    });

    it('counts a cleanly stopped desktop process as exited too', async () => {
      mock.desktopProcessNames = new Set(['game']);
      mock.pm2Stdout = JSON.stringify([
        { name: 'game', pm2_env: { status: 'stopped' }, monit: { memory: 0 } }
      ]);

      const { metrics } = await runHealthCheck();

      expect(metrics.pm2.errored).toBe(0);
      expect(metrics.pm2.desktopExited).toBe(1);
    });

    it('still counts a RUNNING desktop process as online', async () => {
      // The exemption is about exit semantics, not liveness. Filtering `online`
      // on it too would leave a live game in `total` and in no bucket at all —
      // and make the metric read identically whether it is running or quit.
      mock.desktopProcessNames = new Set(['game']);
      mock.pm2Stdout = JSON.stringify([
        { name: 'game', pm2_env: { status: 'online' }, monit: { memory: 0 } },
        { name: 'web', pm2_env: { status: 'online' }, monit: { memory: 0 } }
      ]);

      const { metrics } = await runHealthCheck();

      expect(metrics.pm2).toEqual({ total: 2, online: 2, errored: 0, stopped: 0, desktopExited: 0 });
    });

    it('still auto-restarts non-desktop processes alongside an exempt one', async () => {
      mock.desktopProcessNames = new Set(['game']);
      mock.pm2Stdout = JSON.stringify([
        { name: 'game', pm2_env: { status: 'errored' }, monit: { memory: 0 } },
        { name: 'web', pm2_env: { status: 'errored' }, monit: { memory: 0 } }
      ]);
      const restarted = [];
      mock.restartImpl = recordRestarts(restarted, (args) => args[1]);

      const { metrics, issues } = await runHealthCheck();

      expect(restarted).toEqual(['web']);
      expect(metrics.pm2.errored).toBe(1);
      expect(issues.some(i => /Auto-restarted 1/.test(i.message))).toBe(true);
    });

    it('exempts nothing when the registry read fails (pre-existing behavior stands)', async () => {
      mock.desktopLookupError = new Error('registry unreadable');
      mock.pm2Stdout = JSON.stringify([
        { name: 'web', pm2_env: { status: 'errored' }, monit: { memory: 0 } }
      ]);
      const restarted = [];
      mock.restartImpl = recordRestarts(restarted, (args) => args[1]);

      const { metrics } = await runHealthCheck();

      expect(restarted).toEqual(['web']);
      expect(metrics.pm2.errored).toBe(1);
    });
  });

  it('flags processes over the memory limit', async () => {
    const overLimitBytes = 2048 * 1024 * 1024;
    mock.pm2Stdout = JSON.stringify([{ name: 'hog', pm2_env: { status: 'online' }, monit: { memory: overLimitBytes } }]);
    const { issues } = await runHealthCheck();
    expect(issues.some(i => i.category === 'memory' && /High memory usage/.test(i.message))).toBe(true);
  });

  it('persists the latest snapshot to state and emits health:check', async () => {
    mock.pm2Stdout = '[]';
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

  it('defaults issues to an empty array when none recorded', async () => {
    mock.state = { ...baseState(), stats: {} };
    const status = await getHealthStatus();
    expect(status.issues).toEqual([]);
  });
});
