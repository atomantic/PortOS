import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
vi.mock('../services/apiCore.js', () => ({ request: vi.fn() }));
import { request } from '../services/apiCore.js';
import { useRunwayCatalog } from './useRunwayCatalog.js';

const initial = {
  available: { text_to_image: ['gen4_image', 'gpt_image_2'], image_to_video: ['gen4.5', 'gen4_turbo', 'veo3.1'], text_to_video: ['gen4.5', 'veo3.1'] },
  unsupported: [{ id: 'act_two', reason: 'Requires performance inputs' }], stale: false,
};
describe('Runway form catalog lifecycle', () => {
  it('shares repeated/concurrent loads, filters by capability, refreshes all open forms and keeps stale options on failure', async () => {
    request.mockResolvedValue(initial);
    const image = renderHook(() => useRunwayCatalog());
    const video = renderHook(() => useRunwayCatalog(true, 'text'));
    await waitFor(() => expect(image.result.current.stale).toBe(false));
    expect(request).toHaveBeenCalledTimes(1);
    expect(image.result.current.imageModels.map((m) => m.id)).toEqual(['gen4_image', 'gpt_image_2']);
    expect(video.result.current.videoModels.map((m) => m.id)).toEqual(['gen4.5', 'veo3.1']);
    image.unmount();
    const reopened = renderHook(() => useRunwayCatalog());
    expect(request).toHaveBeenCalledTimes(1);
    request.mockResolvedValue({ ...initial, available: { ...initial.available, text_to_image: ['gpt_image_2'], text_to_video: [] } });
    await act(async () => { await reopened.result.current.refresh(); });
    expect(request).toHaveBeenLastCalledWith('/image-gen/runway-models/refresh', { method: 'POST', silent: true });
    expect(reopened.result.current.imageModels.map((m) => m.id)).toEqual(['gpt_image_2']);
    expect(video.result.current.videoModels).toEqual([]);
    request.mockRejectedValue(new Error('offline'));
    await act(async () => { await reopened.result.current.refresh(); });
    expect(reopened.result.current).toMatchObject({ stale: true, error: 'offline' });
    expect(reopened.result.current.imageModels.map((m) => m.id)).toEqual(['gpt_image_2']);
    renderHook(() => useRunwayCatalog());
    expect(request).toHaveBeenCalledTimes(3);
  });
});
