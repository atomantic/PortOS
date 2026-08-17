import { describe, expect, it, vi } from 'vitest';
import { startRetryableSave, startRetryableSaves } from './completionSave';

describe('completion saves', () => {
  it('starts immediately and reuses a successful save', async () => {
    const action = vi.fn().mockResolvedValue('saved');
    const ensureSaved = startRetryableSave(action);

    await expect(ensureSaved()).resolves.toBe('saved');
    await expect(ensureSaved()).resolves.toBe('saved');
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('retries a failed save when completion is requested', async () => {
    const action = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('saved');
    const ensureSaved = startRetryableSave(action);

    await expect(ensureSaved()).resolves.toBe('saved');
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('rejects when the retry also fails', async () => {
    const error = new Error('still offline');
    const action = vi.fn().mockRejectedValue(error);
    const ensureSaved = startRetryableSave(action);

    await expect(ensureSaved()).rejects.toBe(error);
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('retries only the failed member of a save group', async () => {
    const saved = vi.fn().mockResolvedValue('done');
    const flaky = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('done');
    const ensureSaved = startRetryableSaves([saved, flaky]);

    await expect(ensureSaved()).resolves.toEqual(['done', 'done']);
    expect(saved).toHaveBeenCalledTimes(1);
    expect(flaky).toHaveBeenCalledTimes(2);
  });
});
// @vitest-environment node
