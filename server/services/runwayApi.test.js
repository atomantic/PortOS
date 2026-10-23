import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/fetchWithTimeout.js', () => ({ fetchWithTimeout: vi.fn() }));
const { fetchWithTimeout } = await import('../lib/fetchWithTimeout.js');
const { submitRunwayTask } = await import('./runwayApi.js');

describe('submitRunwayTask', () => {
  it('does not start a paid POST for a job canceled before submission', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(submitRunwayTask({ apiKey: 'k', endpoint: 'text_to_image', body: { model: 'gpt_image_2' }, signal: controller.signal })).rejects.toThrow();
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });
});
