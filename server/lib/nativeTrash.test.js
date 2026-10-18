import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { pinPlatform } from './testHelper.js';
import { moveToNativeTrash } from './nativeTrash.js';

const state = vi.hoisted(() => ({ execFile: vi.fn(), trash: vi.fn() }));
vi.mock('./childProcess.js', () => ({ execFile: (...args) => state.execFile(...args) }));
vi.mock('trash', () => ({ default: state.trash }));
let restore;
afterEach(() => { restore?.(); vi.resetAllMocks(); });

describe('native recycling adapter', () => {
  it.each([['darwin', 'macos-trash'], ['win32', 'windows-trash.exe']])('uses a hidden, bounded native helper on %s', async (platform, binary) => {
    restore = pinPlatform(platform);
    state.execFile.mockImplementation((_command, _args, _options, callback) => { callback(null, '', ''); });
    await moveToNativeTrash(['/synthetic/scene[1].png']);
    expect(state.execFile).toHaveBeenCalledWith(expect.stringContaining(binary), ['/synthetic/scene[1].png'], { timeout: 30_000 }, expect.any(Function));
    expect(existsSync(state.execFile.mock.calls[0][0])).toBe(true);
    expect(state.trash).not.toHaveBeenCalled();
  });

  it('uses literal paths for Linux XDG trash', async () => {
    restore = pinPlatform('linux');
    state.trash.mockResolvedValueOnce();
    await moveToNativeTrash(['/synthetic/scene[1].png']);
    expect(state.trash).toHaveBeenCalledWith(['/synthetic/scene[1].png'], { glob: false });
    expect(state.execFile).not.toHaveBeenCalled();
  });
});

it('does not fall back when the native macOS operation is rejected', async () => {
  restore = pinPlatform('darwin');
  state.execFile.mockImplementation((_command, _args, _options, callback) => { callback(new Error('trash unavailable')); });
  await expect(moveToNativeTrash(['/synthetic/scene.png'])).rejects.toThrow('trash unavailable');
  expect(state.trash).not.toHaveBeenCalled();
});
