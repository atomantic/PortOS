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
vi.mock('./apps.js', () => ({
  getDesktopProcessNames: vi.fn(async () => {
    if (mock.desktopLookupError) throw mock.desktopLookupError;
    return mock.desktopProcessNames;
  })
}));

vi.mock('./cosState.js', () => ({
  loadState: vi.fn(async () => mock.state),
  saveState: vi.fn(async (s) => { mock.savedState = s; }),
  withStateLock: async (fn) => fn(),
  isDaemonRunning: () => mock.daemonRunning
}));

vi.mock('./pm2.js', () => ({
  execPm2: vi.fn(async () => ({ stdout: mock.pm2Stdout }))
}));

vi.mock('../lib/memoryStats.js', () => ({
  getMemoryStats: vi.fn(async () => ({ usedMb: 100 }))
}));

vi.mock('./cosEvents.js', () => ({
  cosEvents: { emit: (name, payload) => mock.events.push({ name, payload }) },
  emitLog: vi.fn()
}));

vi.mock('child_process', () => ({
  execFile: (cmd, args, opts, cb) => mock.restartImpl(cmd, args, opts, cb)
}));

import { runHealthCheck, getHealthStatus } from './cosHealthMonitor.js';

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
    // default execFile success
    mock.restartImpl = (cmd, args, opts, cb) => cb(null, { stdout: 'restarted', stderr: '' });
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
    mock.restartImpl = (cmd, args, opts, cb) => cb(new Error('restart failed'), null);
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
      mock.restartImpl = (cmd, args, opts, cb) => {
        restarted.push(args);
        cb(null, { stdout: 'restarted', stderr: '' });
      };

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

    it('still auto-restarts non-desktop processes alongside an exempt one', async () => {
      mock.desktopProcessNames = new Set(['game']);
      mock.pm2Stdout = JSON.stringify([
        { name: 'game', pm2_env: { status: 'errored' }, monit: { memory: 0 } },
        { name: 'web', pm2_env: { status: 'errored' }, monit: { memory: 0 } }
      ]);
      const restarted = [];
      mock.restartImpl = (cmd, args, opts, cb) => {
        restarted.push(args[1]);
        cb(null, { stdout: 'restarted', stderr: '' });
      };

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
      mock.restartImpl = (cmd, args, opts, cb) => {
        restarted.push(args[1]);
        cb(null, { stdout: 'restarted', stderr: '' });
      };

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
