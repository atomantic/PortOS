import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { basename, dirname } from 'path';

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock('child_process', () => childProcessMocks);

import { safeChildProcessOptions, whichFirst, whichFirstSync } from './processEnv.js';

const pathProbeCommand = process.platform === 'win32' ? 'where' : 'which';

describe('safeChildProcessOptions', () => {
  it('hides console windows and sanitizes an explicitly supplied environment', () => {
    expect(safeChildProcessOptions({
      cwd: '/example',
      env: { PATH: '/bin', MallocStackLogging: '1' },
      windowsHide: false,
    })).toEqual({
      cwd: '/example',
      env: { PATH: '/bin' },
      windowsHide: true,
    });
  });
});

describe('PATH probe spawn options', () => {
  beforeEach(() => {
    childProcessMocks.execFile.mockReset();
    childProcessMocks.execFileSync.mockReset();
  });

  afterEach(() => vi.unstubAllEnvs());

  it('hides the async probe console', async () => {
    childProcessMocks.execFile.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, { stdout: '/example/node\n', stderr: '' });
    });

    await expect(whichFirst('node')).resolves.toBe('/example/node');
    expect(childProcessMocks.execFile).toHaveBeenCalledWith(pathProbeCommand, ['node'], expect.objectContaining({
      windowsHide: true,
    }), expect.any(Function));
  });

  it('hides the synchronous probe console', () => {
    childProcessMocks.execFileSync.mockReturnValue('/example/node\n');

    expect(whichFirstSync('node')).toBe('/example/node');
    expect(childProcessMocks.execFileSync).toHaveBeenCalledWith(pathProbeCommand, ['node'], expect.objectContaining({
      windowsHide: true,
    }));
  });

  it.each([
    ['async', whichFirst],
    ['sync', whichFirstSync],
  ])('still discovers installed executables when the %s probe times out', async (_mode, probe) => {
    vi.stubEnv('PATH', dirname(process.execPath));
    vi.stubEnv('Path', dirname(process.execPath));
    const timeout = Object.assign(new Error('PATH probe timed out'), { killed: true, signal: 'SIGTERM' });
    childProcessMocks.execFile.mockImplementation((_cmd, _args, _opts, callback) => callback(timeout));
    childProcessMocks.execFileSync.mockImplementation(() => { throw timeout; });

    expect(await probe(basename(process.execPath))).toBe(process.execPath);
    expect(await probe('portos-nonexistent-binary-xyz-2392')).toBeNull();
  });
});
