import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

vi.mock('../services/apiMusicVideo.js', () => ({ placeMusicVideoPoolItem: vi.fn() }));
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

import { placeMusicVideoPoolItem } from '../services/apiMusicVideo.js';
import useMusicVideoTakes from './useMusicVideoTakes.js';

describe('useMusicVideoTakes placePoolItem', () => {
  // Uniquely catches a swapped still landing on the card while its start or end prompt keeps describing the old picture.
  it('shows the placed still\'s frame prompt, and leaves the prompts alone for a clip on its own', async () => {
    const applyScenePatch = vi.fn();
    const scene = { sceneId: 's1', framePrompt: 'old frame', endFramePrompt: 'old end', takes: [] };
    const { result } = renderHook(() => useMusicVideoTakes({ project: { id: 'mv-1' }, applyScenePatch }));

    placeMusicVideoPoolItem.mockResolvedValueOnce({ scene: { ...scene, referenceImageId: 'diner.png', framePrompt: 'A neon diner' } });
    await act(() => result.current.placePoolItem(scene, { kind: 'image', assetId: 'diner.png' }));
    expect(applyScenePatch).toHaveBeenCalledWith('mv-1', 's1', { framePrompt: 'A neon diner' });

    placeMusicVideoPoolItem.mockResolvedValueOnce({ scene: { ...scene, endImageId: 'smile.png', endFramePrompt: 'She smiles' } });
    await act(() => result.current.placePoolItem(scene, { kind: 'endImage', assetId: 'smile.png' }));
    expect(applyScenePatch).toHaveBeenCalledWith('mv-1', 's1', { endFramePrompt: 'She smiles' });

    applyScenePatch.mockClear();
    placeMusicVideoPoolItem.mockResolvedValueOnce({ scene: { ...scene, framePrompt: 'saved frame', videoHistoryId: 'clip-1' } });
    await act(() => result.current.placePoolItem(scene, { kind: 'video', assetId: 'clip-1' }));
    expect(applyScenePatch.mock.calls.every(([, , patch]) => !('framePrompt' in patch))).toBe(true);
  });
});
