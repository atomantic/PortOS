import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('../lib/childProcess.js', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: (...args) => spawn(...args),
}));

const { default: mediaService } = await import('./mediaService.js');

function fakeProcess() {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  return proc;
}

beforeEach(() => {
  mediaService.stopAll();
  spawn.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  mediaService.stopAll();
  vi.restoreAllMocks();
});

describe('mediaService stream ownership', () => {
  it('ignores a replaced video process close event', () => {
    const oldProcess = fakeProcess();
    const replacementProcess = fakeProcess();
    spawn.mockReturnValueOnce(oldProcess).mockReturnValueOnce(replacementProcess);

    mediaService.startVideoStream('0');
    const replacement = mediaService.startVideoStream('1');
    oldProcess.emit('close', 0);

    expect(oldProcess.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mediaService.getVideoStream()).toBe(replacement);
    expect(mediaService.isVideoStreaming()).toBe(true);

    replacementProcess.emit('close', 0);
    expect(mediaService.getVideoStream()).toBeNull();
    expect(mediaService.isVideoStreaming()).toBe(false);
  });

  it('ignores a replaced audio process close event', () => {
    const oldProcess = fakeProcess();
    const replacementProcess = fakeProcess();
    spawn.mockReturnValueOnce(oldProcess).mockReturnValueOnce(replacementProcess);

    mediaService.startAudioStream('0');
    const replacement = mediaService.startAudioStream('1');
    oldProcess.emit('close', 0);

    expect(oldProcess.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mediaService.getAudioStream()).toBe(replacement);
    expect(mediaService.isAudioStreaming()).toBe(true);

    replacementProcess.emit('close', 0);
    expect(mediaService.getAudioStream()).toBeNull();
    expect(mediaService.isAudioStreaming()).toBe(false);
  });
});

describe('media device probe bounds', () => {
  it('kills a hung probe and rejects without retaining its output listener', async () => {
    vi.useFakeTimers();
    const proc = fakeProcess();
    spawn.mockReturnValue(proc);
    const result = expect(mediaService.listDevices()).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10_000);
    await result;
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    expect(proc.stderr.listenerCount('data')).toBe(0);
    proc.emit('close', 1);
    vi.useRealTimers();
  });

  it('rejects oversized probe output and still parses the next normal probe', async () => {
    const oversized = fakeProcess();
    const normal = fakeProcess();
    spawn.mockReturnValueOnce(oversized).mockReturnValueOnce(normal);
    const failure = expect(mediaService.listDevices()).rejects.toThrow('exceeded limit');
    oversized.stderr.emit('data', Buffer.alloc(1024 * 1024 + 1));
    await failure;
    expect(oversized.kill).toHaveBeenCalledWith('SIGKILL');
    const devices = mediaService.listDevices();
    normal.stderr.emit('data', '[AVFoundation] AVFoundation video devices:\n[AVFoundation] [0] Example Camera\n[AVFoundation] AVFoundation audio devices:\n[AVFoundation] [1] Example Microphone\n');
    normal.emit('close', 1);
    await expect(devices).resolves.toEqual({ video: [{ id: '0', name: 'Example Camera' }], audio: [{ id: '1', name: 'Example Microphone' }] });
  });
});
