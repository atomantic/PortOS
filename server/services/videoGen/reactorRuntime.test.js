import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(async () => 'reactor-sdk==1.0.1\r\n') }));
vi.mock('../../lib/childProcess.js', () => ({ execFile: mocks.execFile }));
vi.mock('../../lib/fileUtils.js', () => ({ PATHS: { root: '/example/app', data: '/example/data' } }));
let ensureReactorRuntime;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('REACTOR_PYTHON_PATH', '');
  ({ ensureReactorRuntime } = await import('./reactorRuntime.js'));
});
afterEach(() => vi.unstubAllEnvs());
const reply = (error = null) => (file, args, options, callback) => callback(error, '', '');

describe('automatic Reactor runtime preparation', () => {
  it('reuses a verified SDK without downloading or starting a model session', async () => {
    mocks.execFile.mockImplementation(reply());
    expect(await ensureReactorRuntime()).toBe(join('/example/data', 'venvs', 'reactor', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
    expect(mocks.execFile).toHaveBeenCalledOnce();
    expect(mocks.execFile.mock.calls[0][1][2]).toBe('1.0.1');
  });

  it('shares one repair for concurrent jobs and verifies the repaired runtime', async () => {
    let installed = false;
    let finish;
    mocks.execFile.mockImplementation((file, args, options, callback) => {
      if (file === process.execPath) finish = () => { installed = true; callback(null, '', ''); };
      else callback(installed ? null : new Error('missing SDK'), '', '');
    });
    const first = ensureReactorRuntime();
    const second = ensureReactorRuntime();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(mocks.execFile.mock.calls.filter(([file]) => file === process.execPath)).toHaveLength(1);
    finish();
    expect(await first).toBe(await second);
    expect(mocks.execFile).toHaveBeenCalledTimes(3);
  });

  it('retries a failed install without exposing installer diagnostics', async () => {
    mocks.execFile.mockImplementation(reply(new Error('private installer details')));
    await expect(ensureReactorRuntime()).rejects.toThrow('Automatic Reactor runtime preparation failed');
    mocks.execFile.mockImplementationOnce(reply(new Error('missing'))).mockImplementation(reply());
    await expect(ensureReactorRuntime()).resolves.toBeTruthy();
  });

  it('refuses an incompatible custom environment without modifying it', async () => {
    vi.stubEnv('REACTOR_PYTHON_PATH', '/example/custom/python');
    mocks.execFile.mockImplementation(reply(new Error('incompatible')));
    await expect(ensureReactorRuntime()).rejects.toThrow('remove the custom override');
    expect(mocks.execFile).toHaveBeenCalledOnce();
  });

  it('preserves the safe Python preparation failure through the subprocess boundary', async () => {
    mocks.execFile.mockImplementationOnce(reply(new Error('missing SDK')))
      .mockImplementationOnce(reply(Object.assign(new Error('private installer details'), { code: 23 })));
    await expect(ensureReactorRuntime()).rejects.toThrow('Reactor Python environment preparation failed; check uv access to Python downloads on GitHub releases');
  });

  it.each([1, 'ENOENT', 'toString'])('keeps unknown setup code %s private', async (code) => {
    mocks.execFile.mockImplementationOnce(reply(new Error('missing SDK')))
      .mockImplementationOnce(reply(Object.assign(new Error('private installer details'), { code })));
    await expect(ensureReactorRuntime()).rejects.toThrow('Automatic Reactor runtime preparation failed; check network access and disk space, then retry the render');
  });
});
