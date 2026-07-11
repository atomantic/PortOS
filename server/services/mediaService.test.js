import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => ({
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
