import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import { startApp, startWithCommand, execPm2 } from './pm2.js';

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

  // PortOS itself runs under PM2, which exports its pm2_env into our
  // environment as lowercase config keys — and the PM2 CLI reads those keys
  // back as config, outranking explicit flags. Unstripped, portos-server's own
  // 4GB `max_memory_restart` reached every app it launched: PM2's memory
  // watchdog then killed a fully loaded 25GB llama-server seconds after each
  // successful start, in a loop that read as "the server won't start".
  describe('inherited PM2 config in the environment', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('strips PM2\'s own config keys before spawning the CLI', async () => {
      vi.stubEnv('max_memory_restart', '4294967296');
      vi.stubEnv('exec_mode', 'cluster_mode');
      vi.stubEnv('watch', 'true');
      // portos-server carries its own V8 heap cap; inherited, it would cap every
      // app PortOS launches — including one whose job is to hold more than that.
      vi.stubEnv('node_args', '--max-old-space-size=3072');

      await execPm2(['start', '/usr/local/bin/llama-server', '--name', 'portos-llama-server']);

      const [, , spawnOpts] = mockSpawn.mock.calls[0];
      expect(spawnOpts.env).not.toHaveProperty('max_memory_restart');
      expect(spawnOpts.env).not.toHaveProperty('exec_mode');
      expect(spawnOpts.env).not.toHaveProperty('watch');
      expect(spawnOpts.env).not.toHaveProperty('node_args');
      expect(spawnOpts.env.PATH).toBe(process.env.PATH);
    });

    it('strips them from a caller-supplied env too, which inherits the same keys', async () => {
      vi.stubEnv('max_memory_restart', '4294967296');

      await execPm2(['jlist'], { env: { ...process.env, PM2_HOME: '/tmp/example-pm2' } });

      const [, , spawnOpts] = mockSpawn.mock.calls[0];
      expect(spawnOpts.env).not.toHaveProperty('max_memory_restart');
      expect(spawnOpts.env.PM2_HOME).toBe('/tmp/example-pm2');
    });
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
