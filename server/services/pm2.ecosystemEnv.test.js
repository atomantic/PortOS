import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { pinPlatform } from '../lib/testHelper.js';

vi.mock('pm2', () => ({ default: {} }));
const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock('../lib/childProcess.js', async original => ({ ...(await original()), spawn: mockSpawn }));
const execFileAsync = promisify(execFile);
let root;
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('ecosystem launch credential boundary', () => {
  it.each([['linux', false], ['win32', false], ['win32', true]])('evaluates %s configs safely and removes its wrapper (configThrows=%s)', async (platform, configThrows) => {
    root = await mkdtemp(join(tmpdir(), 'portos-ecosystem-env-'));
    await writeFile(join(root, 'relative.cjs'), 'module.exports = "relative-import";');
    await writeFile(join(root, 'ecosystem.config.cjs'), configThrows ? 'throw new Error("fixture config rejected");' : `module.exports = { apps: [{
      name: 'example-app', script: 'npm', env: {
        PGPASSWORD: 'app-owned', relative: require('./relative.cjs'),
        leaked: process.env.PRIVACY_VAULT_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.FAL_KEY || null
      }
    }] };`);
    vi.stubEnv('PRIVACY_VAULT_KEY', 'vault');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'claude');
    vi.stubEnv('FAL_KEY', 'fal');
    vi.stubEnv('PGPASSWORD', 'server-database');
    const restore = pinPlatform(platform);
    let service;
    try { vi.resetModules(); service = await import('./pm2.js'); }
    finally { restore(); }
    let evaluated;
    mockSpawn.mockImplementation((_bin, argv, options) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      // Evaluate precisely what the PM2 CLI would require, with its supplied
      // environment, without contacting or starting any PM2 daemon.
      const config = join(root, argv[2]);
      void execFileAsync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require(process.argv[1])))', config], {
        cwd: options.cwd, env: options.env,
      }).then(({ stdout }) => {
        evaluated = JSON.parse(stdout);
        child.emit('close', 0);
      }, error => child.emit('error', error));
      return child;
    });
    const launch = service.startFromEcosystem(root, ['example-app'], join(root, 'pm2'));
    if (configThrows) await expect(launch).rejects.toThrow('fixture config rejected');
    else {
      await launch;
      expect(evaluated.apps[0].env).toEqual({ PGPASSWORD: 'app-owned', relative: 'relative-import', leaked: null });
      if (platform === 'win32') expect(evaluated.apps[0]).toMatchObject({ interpreter: 'none', windowsHide: true, max_restarts: 10 });
    }
    expect((await readdir(root)).filter(name => name.startsWith('_portos_pm2_'))).toEqual([]);
    expect(process.env.PRIVACY_VAULT_KEY).toBe('vault');
    expect(process.env.PGPASSWORD).toBe('server-database');
  });
});
