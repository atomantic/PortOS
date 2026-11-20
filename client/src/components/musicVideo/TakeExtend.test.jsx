import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const getVideoHistoryItem = vi.fn();
const extendVideoHistoryItem = vi.fn();
vi.mock('../../services/apiImageVideo.js', () => ({
  getVideoHistoryItem,
  extendVideoHistoryItem,
}));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const { default: TakeExtend } = await import('./TakeExtend.jsx');

const scene = { sceneId: 's1' };
const take = (assetId) => ({ takeId: `t-${assetId}`, kind: 'video', assetId });

describe('TakeExtend', () => {
  beforeEach(() => {
    getVideoHistoryItem.mockReset();
    extendVideoHistoryItem.mockReset();
  });

  // Uniquely catches an Extend button on a clip whose recorded model declares no extend endpoint.
  it('offers extend only when the clip was rendered by a model that declares it', async () => {
    getVideoHistoryItem.mockImplementation(async (id) => ({ modelId: id === 'veo' ? 'fal:fal-ai/veo3.1/fast/image-to-video' : 'fal:fal-ai/kling-video/v3/pro/image-to-video' }));
    const { container } = render(<TakeExtend projectId="p1" scene={scene} take={take('kling')} />);
    await waitFor(() => expect(getVideoHistoryItem).toHaveBeenCalled());
    expect(container.textContent).toBe('');
    render(<TakeExtend projectId="p1" scene={scene} take={take('veo')} />);
    expect(await screen.findByRole('button', { name: /Extend this clip/ })).toBeTruthy();
  });

  // Uniquely catches a send that skips the price preview or rewrites the director's prompt.
  it('previews the price first, then sends the prompt as typed against the take', async () => {
    getVideoHistoryItem.mockResolvedValue({ modelId: 'fal:fal-ai/veo3.1/fast/image-to-video' });
    extendVideoHistoryItem.mockResolvedValue({ seconds: 7, resolution: '720p', estimatedCostUsd: 1.05, body: { prompt: 'Walk on' } });
    render(<TakeExtend projectId="p1" scene={scene} take={take('veo2')} />);
    fireEvent.click(await screen.findByRole('button', { name: /Extend this clip/ }));
    fireEvent.change(screen.getByLabelText(/What happens next/), { target: { value: 'Walk on' } });
    expect(screen.getByRole('button', { name: /Send for/ }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Preview price' }));
    await screen.findByText(/7s at 720p/);
    expect(extendVideoHistoryItem).toHaveBeenLastCalledWith('veo2', { prompt: 'Walk on', dryRun: true, musicVideo: { projectId: 'p1', sceneId: 's1', takeId: 't-veo2' } }, { silent: true });
    fireEvent.click(screen.getByRole('button', { name: /Send for/ }));
    await waitFor(() => expect(extendVideoHistoryItem).toHaveBeenLastCalledWith('veo2', expect.objectContaining({ prompt: 'Walk on', dryRun: false }), { silent: true }));
  });

  // Uniquely catches formatUsd's nullish contract ($0.00) leaking into an unpriced extend.
  it('reads an unpriced extend as an unknown price, never $0.00', async () => {
    getVideoHistoryItem.mockResolvedValue({ modelId: 'fal:fal-ai/veo3.1/fast/image-to-video' });
    extendVideoHistoryItem.mockResolvedValue({ seconds: 7, resolution: '720p', estimatedCostUsd: null, body: { prompt: 'Walk on' } });
    render(<TakeExtend projectId="p1" scene={scene} take={take('veo3')} />);
    fireEvent.click(await screen.findByRole('button', { name: /Extend this clip/ }));
    fireEvent.change(screen.getByLabelText(/What happens next/), { target: { value: 'Walk on' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview price' }));
    await screen.findByText(/7s at 720p, about an unknown price/);
    expect(screen.getByRole('button', { name: 'Send for unknown price' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\$0\.00/);
  });
});
