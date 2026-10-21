import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const api = vi.hoisted(() => ({ getVideoGenStatus: vi.fn(), listLorasFull: vi.fn() }));
vi.mock('../services/apiImageVideo.js', () => api);
vi.mock('../services/apiMusicVideo.js', () => ({ updateMusicVideoProject: vi.fn() }));
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn() } }));

import useMusicVideoModelSettings from './useMusicVideoModelSettings.js';

const render = () => renderHook(() => useMusicVideoModelSettings({ project: { id: 'p', videoSettings: {} } }));
const FAL = { backend: 'fal' };
const RUNWAY = { backend: 'runway' };
const REACTIVE = { backend: 'local', generationMode: 'audioReactive' };

describe('useMusicVideoModelSettings catalog status', () => {
  beforeEach(() => {
    api.getVideoGenStatus.mockReset();
    api.listLorasFull.mockReset();
    api.listLorasFull.mockResolvedValue([]);
  });

  it('reports a failed status read as a read failure, not a missing key or LoRA', async () => {
    api.getVideoGenStatus.mockRejectedValue(new Error('boom'));
    const { result } = render();
    await waitFor(() => expect(result.current.catalogStatus).toBe('error'));
    for (const pick of [FAL, RUNWAY, REACTIVE]) {
      expect(result.current.blockedReasonFor(pick)).toMatch(/Couldn't read Video Gen status/);
    }
  });

  it('does not report a failed LoRA read as a missing audio-reactive LoRA', async () => {
    api.getVideoGenStatus.mockResolvedValue({ models: [], falEnabled: false });
    api.listLorasFull.mockRejectedValue(new Error('boom'));
    const { result } = render();
    await waitFor(() => expect(result.current.catalogStatus).toBe('error'));
    expect(result.current.blockedReasonFor(REACTIVE)).toMatch(/Couldn't read/);
  });

  it('keeps the key-missing reason when a successful read says fal is unconfigured', async () => {
    api.getVideoGenStatus.mockResolvedValue({ models: [], falEnabled: false, runwayEnabled: false });
    const { result } = render();
    await waitFor(() => expect(result.current.catalogStatus).toBe('ready'));
    expect(result.current.blockedReasonFor(FAL)).toMatch(/No fal.ai API key/);
    expect(result.current.blockedReasonFor(RUNWAY)).toMatch(/No Runway API key/);
  });

  it('unblocks after a successful retry', async () => {
    api.getVideoGenStatus.mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ models: [], falEnabled: true });
    const { result } = render();
    await waitFor(() => expect(result.current.catalogStatus).toBe('error'));
    act(() => result.current.retryCatalog());
    await waitFor(() => expect(result.current.catalogStatus).toBe('ready'));
    expect(result.current.blockedReasonFor(FAL)).toBeNull();
  });
});
