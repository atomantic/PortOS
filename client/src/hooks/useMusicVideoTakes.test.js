import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

vi.mock('../services/apiMusicVideo.js', () => ({
  placeMusicVideoPoolItem: vi.fn(), selectMusicVideoSceneTake: vi.fn(), reviewMusicVideoSceneTake: vi.fn(),
  markMusicVideoPoolAssets: vi.fn(), getMusicVideoProject: vi.fn(),
}));
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../services/socket.js', () => ({ default: { id: 'socket-example' } }));

import { placeMusicVideoPoolItem, selectMusicVideoSceneTake, reviewMusicVideoSceneTake, getMusicVideoProject } from '../services/apiMusicVideo.js';
import useMusicVideoTakes from './useMusicVideoTakes.js';

// A held reply: resolve it when the test says the server answered.
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

// The board's scene state, patched the way the page's patchScene does.
function boardScene(initial) {
  let scene = initial;
  const applyScenePatch = vi.fn((_projectId, _sceneId, patch) => { scene = { ...scene, ...(typeof patch === 'function' ? patch(scene) : patch) }; });
  return { applyScenePatch, current: () => scene };
}

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

describe('useMusicVideoTakes decisions', () => {
  const takeA = { takeId: 't-a', kind: 'image', assetId: 'a.png', status: 'candidate' };
  const takeB = { takeId: 't-b', kind: 'image', assetId: 'b.png', status: 'rejected' };

  // Uniquely catches Use waiting on the server before the card changes, and an earlier reply
  // flipping the card back while a later decision on the same shot is still on its way.
  it('shows Use and Reject at once and keeps the latest decision while earlier replies land', async () => {
    const board = boardScene({ sceneId: 's1', referenceImageId: 'a.png', takes: [takeA, takeB] });
    const { result } = renderHook(() => useMusicVideoTakes({ project: { id: 'mv-1' }, applyScenePatch: board.applyScenePatch }));
    const selectReply = deferred();
    const rejectReply = deferred();
    selectMusicVideoSceneTake.mockReturnValueOnce(selectReply.promise);
    reviewMusicVideoSceneTake.mockReturnValueOnce(rejectReply.promise);

    let selecting;
    let rejecting;
    act(() => { selecting = result.current.selectTake(board.current(), takeB); });
    expect(board.current().referenceImageId).toBe('b.png');
    expect(board.current().takes.find((t) => t.takeId === 't-b').status).toBe('candidate');
    act(() => { rejecting = result.current.reviewTake(board.current(), takeB, { status: 'rejected' }); });
    expect(board.current().referenceImageId).toBeNull();

    selectReply.resolve({ sceneId: 's1', referenceImageId: 'b.png', takes: [takeA, { ...takeB, status: 'candidate' }] });
    await act(() => selecting);
    expect(board.current().referenceImageId).toBeNull();
    expect(selectMusicVideoSceneTake).toHaveBeenCalledWith('mv-1', 's1', 't-b', { silent: true, headers: { 'X-PortOS-Origin': 'socket-example' } });

    rejectReply.resolve({ sceneId: 's1', referenceImageId: null, takes: [takeA, { ...takeB, status: 'rejected', note: 'saved' }] });
    await act(() => rejecting);
    expect(board.current().takes.find((t) => t.takeId === 't-b')).toMatchObject({ status: 'rejected', note: 'saved' });
  });

  // Uniquely catches a refused decision leaving the card showing a change the server never saved.
  it('reloads the saved project when the server refuses a decision', async () => {
    const board = boardScene({ sceneId: 's1', referenceImageId: 'a.png', takes: [takeA, takeB] });
    const reloadProject = vi.fn();
    const saved = { id: 'mv-1', scenes: [{ sceneId: 's1', referenceImageId: 'a.png', takes: [takeA, takeB] }] };
    getMusicVideoProject.mockResolvedValueOnce(saved);
    selectMusicVideoSceneTake.mockRejectedValueOnce(new Error('Image not found'));
    const { result } = renderHook(() => useMusicVideoTakes({ project: { id: 'mv-1' }, applyScenePatch: board.applyScenePatch, reloadProject }));

    let landed;
    await act(async () => { landed = await result.current.selectTake(board.current(), takeB); });
    expect(landed).toBe(false);
    await vi.waitFor(() => expect(reloadProject).toHaveBeenCalledWith(saved));
  });
});
