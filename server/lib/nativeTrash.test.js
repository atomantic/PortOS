import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import { pinPlatform } from './testHelper.js';
import { windowsPowerShell51Path } from './processEnv.js';
import { MACOS_TRASH_SCRIPT, NATIVE_TRASH_DEADLINE_MS, WINDOWS_TRASH_SCRIPT, moveToNativeTrash } from './nativeTrash.js';

const state = vi.hoisted(() => ({ execFile: vi.fn(), trashXdg: vi.fn() }));
// The module only ever calls `promisify(execFile)`, which resolves to `{ stdout, stderr }`.
vi.mock('./childProcess.js', () => ({ execFile: Object.assign(() => {}, { [promisify.custom]: (...args) => state.execFile(...args) }) }));
vi.mock('./nativeTrashXdg.js', () => ({ trashXdg: (...args) => state.trashXdg(...args) }));

const PATHS = ['/synthetic/scene[1].png', '/synthetic/a sp ace.mp4'];
const refusal = (fields) => Object.assign(new Error('Command failed'), fields);

let restore;
afterEach(() => { restore?.(); vi.resetAllMocks(); });

describe('macOS adapter', () => {
  it('spawns osascript once per file with the embedded JXA script, no shell, and a deadline', async () => {
    restore = pinPlatform('darwin');
    state.execFile.mockResolvedValue({ stdout: '[{"path":"x","trashedPath":"y"}]', stderr: '' });
    await moveToNativeTrash(PATHS);
    expect(state.execFile.mock.calls).toEqual(PATHS.map(path => [
      '/usr/bin/osascript', ['-l', 'JavaScript', '-e', MACOS_TRASH_SCRIPT, path], { timeout: NATIVE_TRASH_DEADLINE_MS },
    ]));
    expect(state.trashXdg).not.toHaveBeenCalled();
  });

  it('embeds the Foundation call and reports on stdout only', () => {
    expect(MACOS_TRASH_SCRIPT).toContain('trashItemAtURLResultingItemURLError');
    expect(MACOS_TRASH_SCRIPT).toContain('$.exit(1)');
    expect(MACOS_TRASH_SCRIPT).not.toContain('fileHandleWithStandardError');
  });

  it('stops at the first refused file and surfaces the per-file report', async () => {
    restore = pinPlatform('darwin');
    const report = [{ path: PATHS[0], code: 4, domain: 'NSCocoaErrorDomain', error: 'missing' }];
    state.execFile.mockRejectedValue(refusal({ code: 1, stdout: `${JSON.stringify(report)}\n`, stderr: '' }));
    await expect(moveToNativeTrash(PATHS)).rejects.toMatchObject({ code: 'TRASH_REFUSED', exitCode: 1, report });
    expect(state.execFile).toHaveBeenCalledTimes(1);
  });
});

describe('Windows adapter', () => {
  it('runs Windows PowerShell 5.1 once per batch with the encoded script and the paths in the environment', async () => {
    restore = pinPlatform('win32');
    state.execFile.mockResolvedValue({ stdout: '[{"path":"x","recycled":true}]', stderr: '' });
    await moveToNativeTrash(PATHS);
    expect(state.execFile).toHaveBeenCalledTimes(1);
    const [file, args, options] = state.execFile.mock.calls[0];
    expect(file).toBe(windowsPowerShell51Path());
    expect(args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
    expect(Buffer.from(args[5], 'base64').toString('utf16le')).toBe(WINDOWS_TRASH_SCRIPT);
    expect(options.timeout).toBe(NATIVE_TRASH_DEADLINE_MS);
    expect(options.env.PORTOS_TRASH_PATHS).toBe(PATHS.join('\n'));
    expect(options.env.PATH ?? options.env.Path).toBeDefined();
    expect(state.trashXdg).not.toHaveBeenCalled();
  });

  it('runs the drive-type pre-flight before the capacity check and reports on stdout only', () => {
    // A UNC root must be refused by DriveType before GetVolumeNameForVolumeMountPoint sees it.
    expect(WINDOWS_TRASH_SCRIPT.indexOf("$type -ne 'Fixed'")).toBeLessThan(WINDOWS_TRASH_SCRIPT.indexOf('::BinCapacityBytes('));
    // PowerShell serialises a redirected error stream as CLIXML, which would hide the report.
    expect(WINDOWS_TRASH_SCRIPT).not.toContain('[Console]::Error');
  });

  it('rejects a deadline kill without any further attempt', async () => {
    restore = pinPlatform('win32');
    state.execFile.mockRejectedValue(refusal({ killed: true, signal: 'SIGTERM', code: null }));
    await expect(moveToNativeTrash(PATHS)).rejects.toMatchObject({ code: 'TRASH_DEADLINE' });
    expect(state.execFile).toHaveBeenCalledTimes(1);
  });

  it('keeps cancellation pending until the owned child closes, without retry', async () => {
    restore = pinPlatform('win32');
    const controller = new AbortController();
    const child = new EventEmitter();
    state.execFile.mockImplementation((...args) => {
      expect(args[2].signal).toBe(controller.signal);
      controller.abort();
      return Object.assign(Promise.reject(refusal({ name: 'AbortError', code: 'ABORT_ERR' })), { child });
    });
    let settled = false;
    const result = moveToNativeTrash(PATHS, { signal: controller.signal });
    result.catch(() => { settled = true; });
    const assertion = expect(result).rejects.toMatchObject({ code: 'TRASH_ABORTED' });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit('close');
    await assertion;
    expect(settled).toBe(true);
    expect(state.execFile).toHaveBeenCalledTimes(1);
    expect(child.listenerCount('close')).toBe(0);
  });

  it('rejects unparsable output as a failure', async () => {
    restore = pinPlatform('win32');
    state.execFile.mockResolvedValue({ stdout: 'Add-Type : compile error', stderr: '' });
    await expect(moveToNativeTrash(PATHS)).rejects.toMatchObject({ code: 'TRASH_UNPARSABLE' });
  });

  it('reads the refusal report from stdout and ignores the CLIXML error stream', async () => {
    restore = pinPlatform('win32');
    const report = [{ path: PATHS[0], code: -1, error: 'no recycle bin on Network drive' }];
    state.execFile.mockRejectedValue(refusal({ code: 1, stdout: `\uFEFF${JSON.stringify(report)}\r\n`, stderr: '#< CLIXML\r\n<Objs Version="1.1.0.1"></Objs>' }));
    await expect(moveToNativeTrash(PATHS)).rejects.toMatchObject({ code: 'TRASH_REFUSED', exitCode: 1, report });
  });

  it('keeps a refusal with no report bounded', async () => {
    restore = pinPlatform('win32');
    state.execFile.mockRejectedValue(refusal({ code: 1, stdout: '', stderr: 'At line:1 char:1 ...' }));
    await expect(moveToNativeTrash(PATHS)).rejects.toMatchObject({ code: 'TRASH_REFUSED', exitCode: 1, report: null });
  });
});

describe('Linux adapter', () => {
  it('recycles each literal path through the XDG adapter and spawns nothing', async () => {
    restore = pinPlatform('linux');
    state.trashXdg.mockResolvedValue({});
    await moveToNativeTrash(PATHS);
    expect(state.trashXdg.mock.calls).toEqual(PATHS.map(path => [path]));
    expect(state.execFile).not.toHaveBeenCalled();
  });

  it('propagates the adapter refusal code and stops', async () => {
    restore = pinPlatform('linux');
    state.trashXdg.mockRejectedValueOnce(Object.assign(new Error('unsafe'), { code: 'TRASH_DIR_UNSAFE' }));
    await expect(moveToNativeTrash(PATHS)).rejects.toMatchObject({ code: 'TRASH_DIR_UNSAFE' });
    expect(state.trashXdg).toHaveBeenCalledTimes(1);
  });
});

it('rejects any other platform without touching the filesystem or spawning', async () => {
  restore = pinPlatform('freebsd');
  await expect(moveToNativeTrash(PATHS)).rejects.toMatchObject({ code: 'TRASH_UNSUPPORTED_PLATFORM' });
  expect(state.execFile).not.toHaveBeenCalled();
  expect(state.trashXdg).not.toHaveBeenCalled();
});
