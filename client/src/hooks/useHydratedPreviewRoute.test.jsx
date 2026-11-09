import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import socket from '../services/socket';
import useHydratedPreviewRoute from './useHydratedPreviewRoute';
import { fetchMediaRecord } from '../components/media/mediaDetail';

vi.mock('../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('./usePreviewRoute', () => ({
  default: () => [{ kind: 'video', id: 'vid-1', key: 'video:vid-1' }, vi.fn()],
}));
vi.mock('../components/media/mediaDetail', async (orig) => ({
  ...(await orig()),
  fetchMediaRecord: vi.fn(),
}));

const emit = (payload) => {
  const handler = socket.on.mock.calls.findLast(([e]) => e === 'media:history:changed')[1];
  act(() => handler(payload));
};

beforeEach(() => {
  vi.clearAllMocks();
});

it('refetches the open record when history changes for it, ignores other ids', async () => {
  fetchMediaRecord
    .mockResolvedValueOnce({ id: 'vid-1', prompt: 'old' })
    .mockResolvedValueOnce({ id: 'vid-1', prompt: 'new' });
  const { result } = renderHook(() => useHydratedPreviewRoute([]));
  await waitFor(() => expect(result.current[0].prompt).toBe('old'));
  expect(fetchMediaRecord).toHaveBeenCalledTimes(1);

  emit({ kind: 'video', op: 'update', ids: ['other'] });
  expect(fetchMediaRecord).toHaveBeenCalledTimes(1);

  emit({ kind: 'video', op: 'update', ids: ['vid-1'] });
  await waitFor(() => expect(result.current[0].prompt).toBe('new'));
  expect(fetchMediaRecord).toHaveBeenCalledTimes(2);
});

it('does not refetch when the open item is deleted', async () => {
  fetchMediaRecord.mockResolvedValue({ id: 'vid-1', prompt: 'old' });
  const { result } = renderHook(() => useHydratedPreviewRoute([]));
  await waitFor(() => expect(result.current[0].prompt).toBe('old'));
  emit({ kind: 'video', op: 'delete', ids: ['vid-1'] });
  expect(fetchMediaRecord).toHaveBeenCalledTimes(1);
});
