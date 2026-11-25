import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

vi.mock('../../../services/apiMusicVideo.js', () => ({
  placeMusicVideoPoolItem: vi.fn(), selectMusicVideoSceneTake: vi.fn(), reviewMusicVideoSceneTake: vi.fn(),
  markMusicVideoPoolAssets: vi.fn(), getMusicVideoProject: vi.fn(), rejectUnusedMusicVideoSceneTakes: vi.fn(),
  continueMusicVideoSceneFromPrevious: vi.fn(), checkMusicVideoSceneTake: vi.fn(), moveMusicVideoSceneTake: vi.fn(),
}));
vi.mock('../../ui/Toast');
vi.mock('../../../services/socket.js', () => ({ default: { id: 'socket-example' } }));

import { placeMusicVideoPoolItem, selectMusicVideoSceneTake, reviewMusicVideoSceneTake, getMusicVideoProject, rejectUnusedMusicVideoSceneTakes, continueMusicVideoSceneFromPrevious, checkMusicVideoSceneTake, moveMusicVideoSceneTake } from '../../../services/apiMusicVideo.js';
import useMusicVideoTakes from './useMusicVideoTakes.js';
import { takeControl } from '../../../lib/musicVideoTakes.js';

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
  it('exposes a failed reconciliation with retry that preserves later queued decisions', async () => {
    const board = boardScene({ sceneId: 's1', referenceImageId: 'a.png', takes: [takeA, takeB] });
    const reloadProject = vi.fn();
    selectMusicVideoSceneTake.mockRejectedValueOnce(new Error('Refused'));
    getMusicVideoProject.mockRejectedValueOnce(new Error('Project service unavailable'));
    const { result } = renderHook(() => useMusicVideoTakes({ project: { id: 'mv-1' }, applyScenePatch: board.applyScenePatch, reloadProject }));
    await act(() => result.current.selectTake(board.current(), takeB));
    await vi.waitFor(() => expect(result.current.reconcileError?.message).toBe('Project service unavailable'));
    expect(reloadProject).not.toHaveBeenCalled();
    const later = deferred();
    reviewMusicVideoSceneTake.mockReturnValueOnce(later.promise);
    let saving;
    act(() => { saving = result.current.reviewTake(board.current(), takeB, { status: 'rejected' }); });
    const savedScene = { sceneId: 's1', referenceImageId: null, takes: [takeA, { ...takeB, status: 'rejected' }] };
    const saved = { id: 'mv-1', scenes: [savedScene] };
    getMusicVideoProject.mockResolvedValueOnce(saved);
    let retry;
    act(() => { retry = result.current.retryReconcile(); });
    expect(reloadProject).not.toHaveBeenCalled();
    later.resolve(savedScene);
    await act(() => saving);
    await act(() => retry);
    expect(reloadProject).toHaveBeenCalledWith(saved);
    expect(result.current.reconcileError).toBeNull();
    expect(board.current().referenceImageId).toBeNull();
  });

  // Uniquely catches "Still matches" for an older character reference (#16473) having no control of its own: the
  // button would not show it is saving, and a second press would send a second request.
  it('holds a character-reference acceptance on its own control until the server answers', async () => {
    const warning = { code: 'character-reference-changed', reasons: ['Character reference changed after this render: Ada'], characters: [], revision: 'rev-1' };
    const flagged = { ...takeA, characterReferenceState: warning };
    const board = boardScene({ sceneId: 's1', referenceImageId: 'a.png', takes: [flagged] });
    const { result } = renderHook(() => useMusicVideoTakes({ project: { id: 'mv-1' }, applyScenePatch: board.applyScenePatch }));
    const reply = deferred();
    reviewMusicVideoSceneTake.mockClear();
    reviewMusicVideoSceneTake.mockReturnValueOnce(reply.promise);
    const review = { acceptCharacterReferences: { revision: 'rev-1' } };
    let saving;
    act(() => { saving = result.current.reviewTake(board.current(), flagged, review); });
    expect(board.current().takes[0].characterReferenceState).toEqual(warning);
    expect(result.current.pending.has(takeControl.acceptCharacters(board.current(), flagged))).toBe(true);
    act(() => { result.current.reviewTake(board.current(), flagged, review); });
    await vi.waitFor(() => expect(reviewMusicVideoSceneTake).toHaveBeenCalledTimes(1));
    expect(reviewMusicVideoSceneTake.mock.calls[0][3]).toEqual(review);
    reply.resolve({ sceneId: 's1', referenceImageId: 'a.png', takes: [takeA] });
    await act(() => saving);
    expect(reviewMusicVideoSceneTake).toHaveBeenCalledTimes(1);
    expect(result.current.pending.has(takeControl.acceptCharacters(board.current(), flagged))).toBe(false);
  });

});

describe('useMusicVideoTakes rejectUnusedTakes', () => {
  // Uniquely catches Reject unused dropping its reply's edit result: the board then keeps the pre-decision
  // revision, so the next shot edit (Done) is diffed against a record this tab never advanced to.
  it('hands the reply\'s edit result to the board', async () => {
    const applyEdit = vi.fn();
    const applyScenePatch = vi.fn();
    const scene = { sceneId: 's1', takes: [] };
    const edit = { updatedAt: '2026-01-02T00:00:00.000Z', baseUpdatedAt: '2026-01-01T00:00:00.000Z', sceneIds: ['s1'], scenes: [] };
    rejectUnusedMusicVideoSceneTakes.mockResolvedValueOnce({ scene, rejected: 2, edit });
    const { result } = renderHook(() => useMusicVideoTakes({ project: { id: 'mv-1' }, applyScenePatch, applyEdit }));
    await act(() => result.current.rejectUnusedTakes(scene));
    expect(applyEdit).toHaveBeenCalledWith('mv-1', edit);
  });

  // Uniquely catches #16306: a second press during a slow reply sending a second request, or the control
  // never leaving its pending state, after either answer.
  it('holds the pressed control pending until its reply and ignores a second press meanwhile', async () => {
    const scene = { sceneId: 's1', takes: [] };
    const reply = deferred();
    rejectUnusedMusicVideoSceneTakes.mockReset().mockReturnValueOnce(reply.promise).mockRejectedValueOnce(new Error('Refused'));
    const { result } = renderHook(() => useMusicVideoTakes({ project: { id: 'mv-1' }, applyScenePatch: vi.fn() }));
    let first;
    let second;
    act(() => { first = result.current.rejectUnusedTakes(scene); second = result.current.rejectUnusedTakes(scene); });
    expect(result.current.pending.has(takeControl.rejectUnused(scene))).toBe(true);
    expect(await second).toBe(false);
    reply.resolve({ scene, rejected: 1 });
    await act(() => first);
    expect(rejectUnusedMusicVideoSceneTakes).toHaveBeenCalledTimes(1);
    expect(result.current.pending.size).toBe(0);
    await act(() => result.current.rejectUnusedTakes(scene));
    expect(rejectUnusedMusicVideoSceneTakes).toHaveBeenCalledTimes(2);
    expect(result.current.pending.size).toBe(0);
  });
});

const EDIT = { updatedAt: '2026-01-02T00:00:00.000Z', baseUpdatedAt: '2026-01-01T00:00:00.000Z', sceneIds: ['s1'], scenes: [] };
const OWN = { silent: true, headers: { 'X-PortOS-Origin': 'socket-example' } };

describe('useMusicVideoTakes edit results beyond the take decisions', () => {
  // Uniquely catches Continue from previous patching only the shot: the board would keep the pre-continue revision.
  it('applies the edit result of continuing from the previous shot, sent with this tab\'s origin', async () => {
    const applyEdit = vi.fn();
    const applyScenePatch = vi.fn();
    const scene = { sceneId: 's1', takes: [] };
    continueMusicVideoSceneFromPrevious.mockResolvedValueOnce({ scene, frame: { imageId: 'f.png' }, edit: EDIT });
    const { result } = renderHook(() => useMusicVideoTakes({ project: { id: 'mv-1' }, applyScenePatch, applyEdit }));
    await act(() => result.current.continueFromPrevious(scene, { keepStillAsEnd: true }));
    expect(continueMusicVideoSceneFromPrevious).toHaveBeenCalledWith('mv-1', 's1', { keepStillAsEnd: true }, OWN);
    expect(applyEdit).toHaveBeenCalledWith('mv-1', EDIT);
    expect(applyScenePatch).not.toHaveBeenCalled();
  });

  // Uniquely catches the plate check's verdict painting over a decision made while the check ran, or never reaching the board.
  it('applies a plate check\'s edit result, and patches only the take list when a decision started meanwhile', async () => {
    const applyEdit = vi.fn();
    const applyScenePatch = vi.fn();
    const scene = { sceneId: 's1', takes: [] };
    const take = { takeId: 't-a', kind: 'image', assetId: 'a.png' };
    checkMusicVideoSceneTake.mockResolvedValueOnce({ ...scene, edit: EDIT });
    const { result } = renderHook(() => useMusicVideoTakes({ project: { id: 'mv-1' }, applyScenePatch, applyEdit }));
    await act(() => result.current.checkTake(scene, take));
    expect(checkMusicVideoSceneTake).toHaveBeenCalledWith('mv-1', 's1', 't-a', OWN);
    expect(applyEdit).toHaveBeenCalledWith('mv-1', EDIT);

    applyEdit.mockClear();
    const reply = deferred();
    checkMusicVideoSceneTake.mockReturnValueOnce(reply.promise);
    reviewMusicVideoSceneTake.mockResolvedValueOnce({ ...scene, edit: null });
    let checking;
    act(() => { checking = result.current.checkTake(scene, take); });
    await act(() => result.current.reviewTake(scene, take, { note: 'Typed meanwhile' }));
    reply.resolve({ ...scene, takes: [], edit: EDIT });
    await act(() => checking);
    expect(applyEdit).not.toHaveBeenCalled();
    expect(applyScenePatch).toHaveBeenCalledWith('mv-1', 's1', expect.objectContaining({ takes: [] }));
  });
});

describe('useMusicVideoTakes moveTake', () => {
  // Uniquely catches a moved take vanishing from its old shot without appearing on the new one when no edit result applies.
  it('redraws both shots from the reply: through the edit result, or each shot patched on its own', async () => {
    const take = { takeId: 't-a', kind: 'video', assetId: 'clip-a', status: 'rejected' };
    const source = { sceneId: 's1', takes: [] };
    const target = { sceneId: 's2', takes: [take] };
    const applyScenePatch = vi.fn();
    const applyEdit = vi.fn();
    const { result } = renderHook(() => useMusicVideoTakes({ project: { id: 'mv-1' }, applyScenePatch, applyEdit }));

    moveMusicVideoSceneTake.mockResolvedValueOnce({ scene: source, target, take, edit: { revision: 'r2' } });
    await act(() => result.current.moveTake({ sceneId: 's1' }, take, 's2'));
    expect(moveMusicVideoSceneTake).toHaveBeenCalledWith('mv-1', 's1', 't-a', 's2', expect.any(Object));
    expect(applyEdit).toHaveBeenCalledWith('mv-1', { revision: 'r2' });

    applyEdit.mockClear();
    moveMusicVideoSceneTake.mockResolvedValueOnce({ scene: source, target, take });
    await act(() => result.current.moveTake({ sceneId: 's1' }, take, 's2'));
    expect(applyEdit).not.toHaveBeenCalled();
    expect(applyScenePatch).toHaveBeenCalledWith('mv-1', 's2', expect.objectContaining({ takes: [take] }));
    expect(applyScenePatch).toHaveBeenCalledWith('mv-1', 's1', expect.objectContaining({ takes: [] }));
    expect(result.current.pending.has(takeControl.move({ sceneId: 's1' }, take))).toBe(false);
  });
});
