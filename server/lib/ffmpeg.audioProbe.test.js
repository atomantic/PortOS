import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from './childProcess.js';
import { hasAudioStream } from './ffmpeg/probe.js';

vi.mock('./ffmpeg/discovery.js', () => ({ findFfmpeg: vi.fn(), findFfprobe: async () => 'ffprobe' }));
vi.mock('./childProcess.js', async original => ({ ...await original(), spawn: vi.fn() }));

afterEach(() => vi.useRealTimers());

it('treats a timed-out audio probe as silent even after receiving audio stream output', async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(signal => child.emit('close', null, signal)),
    exitCode: null,
    signalCode: null,
  });
  spawn.mockReturnValueOnce(child);
  const result = hasAudioStream('/fixture/clip.mp4', { timeoutMs: 15_000 });
  await vi.advanceTimersByTimeAsync(0);
  child.stdout.emit('data', Buffer.from('0\n'));
  await vi.advanceTimersByTimeAsync(14_999);
  expect(child.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toBe(false);
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
});
