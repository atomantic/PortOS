import { describe, it, expect, vi, afterEach } from 'vitest';
import { imageGenEvents } from './imageGenEvents.js';

describe('imageGenEvents', () => {
  afterEach(() => {
    imageGenEvents.removeAllListeners('completed');
  });

  it('runs later listeners on the same event even when an earlier listener throws (#8931)', () => {
    const secondListener = vi.fn();
    imageGenEvents.on('completed', () => {
      throw new Error('quota accounting exploded');
    });
    imageGenEvents.on('completed', secondListener);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => imageGenEvents.emit('completed', { jobId: 'job-1' })).not.toThrow();
    errorSpy.mockRestore();

    expect(secondListener).toHaveBeenCalledWith({ jobId: 'job-1' });
  });
});
