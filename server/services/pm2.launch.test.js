import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

const mockPm2 = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  start: vi.fn()
}));

vi.mock('pm2', () => ({ default: mockPm2 }));

const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock('../lib/childProcess.js', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: mockSpawn,
}));

import { startApp, startWithCommand } from './pm2.js';

// Fake child_process.spawn result: closes with the given exit code on next tick.
function fakeChild(exitCode = 0) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => child.emit('close', exitCode));
  return child;
}

describe('PM2 command launch interpreters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPm2.connect.mockImplementation(callback => callback(null));
    mockPm2.start.mockImplementation((options, callback) => callback(null, options));
    mockSpawn.mockImplementation(() => fakeChild(0));
  });

  it('executes shell-script commands directly instead of parsing them with Node', async () => {
    await startWithCommand(
      'elsewhere-acres-godot',
      '/repo/elsewhere-acres',
      './scripts/game run',
      { autorestart: false }
    );

    expect(mockPm2.start).toHaveBeenCalledWith(expect.objectContaining({
      name: 'elsewhere-acres-godot',
      script: './scripts/game',
      args: ['run'],
      interpreter: 'none',
      autorestart: false
    }), expect.any(Function));
  });

  it('keeps JavaScript entrypoints on PM2\'s Node interpreter', async () => {
    await startWithCommand('web-app', '/repo/web-app', './server.mjs');

    const [options] = mockPm2.start.mock.calls[0];
    expect(options).not.toHaveProperty('interpreter');
  });

  it('applies the same direct-execution rule to configured app scripts', async () => {
    await startApp('tooling-app', { script: 'npm', args: 'run dev' });

    expect(mockPm2.start).toHaveBeenCalledWith(expect.objectContaining({
      script: 'npm',
      args: 'run dev',
      interpreter: 'none'
    }), expect.any(Function));
  });

  describe('with a custom pm2Home', () => {
    it('starts via the PM2 CLI (not the default-daemon Node API) so the process is visible to CLI-based status/log/delete calls targeting the same home', async () => {
      const result = await startWithCommand(
        'elsewhere-acres-godot',
        '/repo/elsewhere-acres',
        './scripts/game run',
        { autorestart: false, pm2Home: '/tmp/example-pm2' }
      );

      expect(result).toEqual({ success: true });
      expect(mockPm2.start).not.toHaveBeenCalled();
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const [, spawnArgv, spawnOpts] = mockSpawn.mock.calls[0];
      const pm2Args = spawnArgv.slice(1); // spawnArgv[0] is the local pm2 CLI binary path
      expect(pm2Args).toEqual(expect.arrayContaining([
        'start', './scripts/game', '--name', 'elsewhere-acres-godot',
        '--cwd', '/repo/elsewhere-acres', '--interpreter', 'none', '--no-autorestart',
      ]));
      expect(pm2Args.slice(-2)).toEqual(['--', 'run']);
      expect(spawnOpts.env.PM2_HOME).toBe('/tmp/example-pm2');
    });

    it('rejects when the pm2 CLI exits non-zero', async () => {
      mockSpawn.mockImplementation(() => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(() => {
          child.stderr.emit('data', Buffer.from('pm2 blew up'));
          child.emit('close', 1);
        });
        return child;
      });

      await expect(startWithCommand(
        'elsewhere-acres-godot', '/repo/elsewhere-acres', './scripts/game run',
        { autorestart: false, pm2Home: '/tmp/example-pm2' }
      )).rejects.toThrow(/pm2 blew up|exited with code 1/);
    });
  });
});
