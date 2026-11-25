import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import toast from '../components/ui/Toast';
import { cancelImagePendingDelete, deleteImage, deleteVideoHistoryItem } from '../services/apiImageVideo.js';
import { useMediaDelete } from './useMediaDelete';
import { refreshMediaUsages } from './useMediaUsages';

vi.mock('../components/ui/Toast');
vi.mock('../services/apiImageVideo.js', () => ({
  cancelImagePendingDelete: vi.fn(),
  cancelVideoPendingDelete: vi.fn(),
  deleteImage: vi.fn(),
  deleteVideoHistoryItem: vi.fn(),
}));
vi.mock('./useMediaUsages', () => ({ refreshMediaUsages: vi.fn() }));

const image = { kind: 'image', filename: 'example.png', key: 'image:example.png' };
const video = { kind: 'video', id: 'clip', key: 'video:clip' };

function renderDelete(options) {
  const onPending = vi.fn();
  const onRemoved = vi.fn();
  const { result } = renderHook(() => useMediaDelete({ rows: [], onPending, onRemoved, ...options }));
  return { result, onPending, onRemoved };
}

describe('useMediaDelete', () => {
  beforeEach(() => vi.resetAllMocks());

  it('removes the confirmed video and refreshes its usages', async () => {
    deleteVideoHistoryItem.mockResolvedValue({ status: 'deleted' });
    const { result, onPending, onRemoved } = renderDelete();

    await act(() => result.current.deleteItem(video, { force: true }));

    expect(deleteVideoHistoryItem).toHaveBeenCalledWith(video.id, { silent: true, force: true });
    expect(onRemoved).toHaveBeenCalledWith(video);
    expect(onPending).not.toHaveBeenCalled();
    expect(refreshMediaUsages).toHaveBeenCalledOnce();
  });

  it('keeps a pending image, remembers its peer, and clears its marker only after cancellation succeeds', async () => {
    const pendingDelete = { peerId: 'example-peer' };
    deleteImage.mockResolvedValue({ status: 'pending', pendingDelete, peerName: 'Example Peer' });
    cancelImagePendingDelete.mockRejectedValueOnce(new Error('Cancel unavailable')).mockResolvedValueOnce({});
    const { result, onPending, onRemoved } = renderDelete();

    await act(() => result.current.deleteItem(image));

    expect(deleteImage).toHaveBeenCalledWith(image.filename, { silent: true, force: false });
    expect(onRemoved).not.toHaveBeenCalled();
    expect(onPending).toHaveBeenCalledWith(image, pendingDelete);
    expect(result.current.pendingPeerNames).toEqual({ 'example-peer': 'Example Peer' });
    expect(toast).toHaveBeenCalledWith('Delete pending until Example Peer is reachable');

    await act(() => result.current.cancelPendingDelete(image));
    expect(onPending).toHaveBeenCalledOnce();
    expect(toast.error).toHaveBeenCalledWith('Cancel unavailable');

    await act(() => result.current.cancelPendingDelete(image));
    expect(cancelImagePendingDelete).toHaveBeenCalledWith(image.filename, { silent: true });
    expect(onPending).toHaveBeenLastCalledWith(image, null);
    expect(toast.success).toHaveBeenCalledWith('Pending delete cancelled');
  });

  it('keeps an in-use image, refreshes its usages, and shows one error', async () => {
    deleteImage.mockRejectedValue(Object.assign(new Error('Image is in use'), { code: 'MEDIA_IN_USE' }));
    const { result, onPending, onRemoved } = renderDelete();

    await act(() => result.current.deleteItem(image));

    expect(onRemoved).not.toHaveBeenCalled();
    expect(onPending).not.toHaveBeenCalled();
    expect(refreshMediaUsages).toHaveBeenCalledOnce();
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Image is in use');
  });

  it('keeps an image when the request layer has already shown the refusal', async () => {
    deleteImage.mockRejectedValue(Object.assign(new Error('Host control refused'), { toasted: true }));
    const { result, onRemoved } = renderDelete();

    await act(() => result.current.deleteItem(image));

    expect(onRemoved).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
