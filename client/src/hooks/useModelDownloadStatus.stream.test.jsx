import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useModelDownloadStatus } from './useModelDownloadStatus';

vi.mock('../services/apiImageVideo.js', () => ({
  getImageModelStatuses: vi.fn(async () => [{ id: 'example', cached: false }]),
  getVideoModelStatuses: vi.fn(async () => ({ models: [{ id: 'example', cached: false }] })),
  verifyImageModels: vi.fn(), verifyVideoModels: vi.fn(),
  repairImageModel: vi.fn(), repairVideoModel: vi.fn(),
  repairTextEncoder: vi.fn(), repairTextEncoderOption: vi.fn(), repairIcLora: vi.fn(),
}));
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

describe('model picker download transport', () => {
  it.each(['image', 'video'])('%s picker uses one POST, surfaces disconnect, and permits explicit retry', async (kind) => {
    let stream;
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({ start(controller) { stream = controller; } })));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useModelDownloadStatus({ kind }));
    await waitFor(() => expect(result.current.statuses).toHaveLength(1));
    act(() => result.current.start('example', { force: true }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0]).toEqual([
      `/api/${kind}-gen/models/example/download?force=1`, expect.objectContaining({ method: 'POST' }),
    ]);
    act(() => stream.enqueue(new TextEncoder().encode('data: {"type":"progress","downloaded":10}\n\n')));
    await waitFor(() => expect(result.current.progress).toMatchObject({ type: 'progress', downloaded: 10 }));
    act(() => stream.error(new Error('Network lost')));
    await waitFor(() => expect(result.current.downloading).toBe(false));
    expect(result.current.lastError).toMatchObject({ modelId: 'example', message: 'Network lost' });
    expect(fetchMock).toHaveBeenCalledOnce();
    act(() => result.current.start('example'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => result.current.cancel());
    expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true);
  });
});
