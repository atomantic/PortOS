import { describe, it, expect, vi, afterEach } from 'vitest';
import { videoGenEvents } from './events.js';

describe('videoGenEvents', () => {
  afterEach(() => {
    videoGenEvents.removeAllListeners('completed');
  });

  it('runs later listeners on the same event even when an earlier listener throws (#8931)', () => {
    const secondListener = vi.fn();
    videoGenEvents.on('completed', () => {
      throw new Error('socket relay exploded');
    });
    videoGenEvents.on('completed', secondListener);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => videoGenEvents.emit('completed', { jobId: 'job-1' })).not.toThrow();
    errorSpy.mockRestore();

    expect(secondListener).toHaveBeenCalledWith({ jobId: 'job-1' });
  });
});
