import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const pool = [
  { kind: 'image', assetId: 'mine.png', sceneId: 's8', prompt: 'Film strip held to the lamp', clipIds: [] },
  { kind: 'image', assetId: 'other.png', sceneId: 's12', prompt: 'Splicer close-up', clipIds: ['clip-12'] },
  { kind: 'image', assetId: 'floor.png', sceneId: null, prompt: 'Reel on the floor', clipIds: [] },
  { kind: 'image', assetId: 'blurry.png', sceneId: null, prompt: 'Out of focus', clipIds: [], mark: 'bad' },
  { kind: 'image', assetId: 'bird.png', sceneId: null, prompt: null, clipIds: [] },
  { kind: 'video', assetId: 'clip-12', sceneId: 's12', sourceImageId: 'other.png' },
];
vi.mock('../../services/apiMusicVideo.js', () => ({
  getMusicVideoMediaPool: vi.fn(async () => ({ items: pool })),
  markMusicVideoPoolAssets: vi.fn(async () => ({})),
  deleteMusicVideoPoolAssets: vi.fn(async () => ({ deleted: 1 })),
  searchMusicVideoMediaPool: vi.fn(async () => ({ items: [] })),
}));
const { default: SceneTakePicker } = await import('./SceneTakePicker.jsx');
const api = await import('../../services/apiMusicVideo.js');

describe('Swap from unused', () => {
  // Uniquely catches the picker offering the wrong kind or group, a shot-number search missing, or the partner clip dropped.
  it('groups unused stills by where they came from, finds a shot by number, and uses a still with its clip', async () => {
    const onPlace = vi.fn(async () => {});
    const onClose = vi.fn();
    render(<SceneTakePicker open projectId="mv-1" scene={{ sceneId: 's8' }} kind="image" onClose={onClose} onPlace={onPlace}
      shotNumbers={new Map([['s8', 8], ['s12', 12]])} />);
    expect(await screen.findByRole('tab', { name: /This shot/ })).toBeTruthy();
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));

    fireEvent.click(screen.getByRole('tab', { name: /Other shots/ }));
    fireEvent.change(screen.getByLabelText('Search prompts or shot number'), { target: { value: '#12' } });
    fireEvent.click(screen.getByRole('button', { name: /still from shot 12/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Use still + its clip' }));
    expect(onPlace).toHaveBeenCalledWith({ kind: 'image', assetId: 'other.png', withAssetId: 'clip-12' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('tab', { name: /Floor/ }));
    fireEvent.change(screen.getByLabelText('Search prompts or shot number'), { target: { value: 'reel' } });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  // Uniquely catches Swap's search missing a still whose prompt only the file itself carries (no take left to hold it).
  it('finds a floor still by the prompt it was made from', async () => {
    api.searchMusicVideoMediaPool.mockResolvedValueOnce({ items: [{ kind: 'image', assetId: 'bird.png' }] });
    render(<SceneTakePicker open projectId="mv-1" scene={{ sceneId: 's8' }} kind="image" onPlace={vi.fn()} shotNumbers={new Map([['s8', 8]])} />);
    fireEvent.click(await screen.findByRole('tab', { name: /Floor/ }));
    fireEvent.change(screen.getByLabelText('Search prompts or shot number'), { target: { value: 'Falcon' } });
    await waitFor(() => expect(api.searchMusicVideoMediaPool).toHaveBeenCalledWith('mv-1', 'Falcon', { silent: true }));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
  });

  // Uniquely catches a mark that never reaches the server, a Bad filter that misses a mark, or a delete that skips its confirm.
  it('marks a floor still as an ingredient, and deletes the bad ones after a confirm', async () => {
    render(<SceneTakePicker open projectId="mv-1" scene={{ sceneId: 's8' }} kind="image" onPlace={vi.fn()} shotNumbers={new Map([['s8', 8]])} />);
    fireEvent.click(await screen.findByRole('tab', { name: /Floor/ }));
    fireEvent.click(screen.getByRole('button', { name: /still: Reel on the floor/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Ingredient' }));
    await waitFor(() => expect(api.markMusicVideoPoolAssets).toHaveBeenCalledWith('mv-1', [{ kind: 'image', assetId: 'floor.png' }], 'ingredient', { silent: true }));
    expect(await screen.findByRole('button', { name: '★ Ingredients 1' })).toBeTruthy();
    // Tapping the active mark clears it.
    fireEvent.click(screen.getByRole('button', { name: 'Ingredient' }));
    await waitFor(() => expect(api.markMusicVideoPoolAssets).toHaveBeenLastCalledWith('mv-1', [{ kind: 'image', assetId: 'floor.png' }], null, { silent: true }));
    expect(await screen.findByRole('button', { name: '★ Ingredients 0' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '✕ Bad 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete 1 bad' }));
    expect(api.deleteMusicVideoPoolAssets).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' }));
    await waitFor(() => expect(api.deleteMusicVideoPoolAssets).toHaveBeenCalledWith('mv-1', [{ kind: 'image', assetId: 'blurry.png' }], { silent: true }));
    expect(await screen.findByRole('button', { name: '✕ Bad 0' })).toBeTruthy();
  });

  // Uniquely catches a peer-owned asset vanishing from the pool before its owner has deleted it.
  it('keeps an asset whose delete is pending on its owner, marked as pending', async () => {
    api.deleteMusicVideoPoolAssets.mockResolvedValueOnce({ deleted: 0, items: [{ kind: 'image', assetId: 'blurry.png', status: 'pending', pendingDelete: { peerId: 'p1' }, peerName: 'Example Peer' }] });
    render(<SceneTakePicker open projectId="mv-1" scene={{ sceneId: 's8' }} kind="image" onPlace={vi.fn()} shotNumbers={new Map([['s8', 8]])} />);
    fireEvent.click(await screen.findByRole('tab', { name: /Floor/ }));
    fireEvent.click(screen.getByRole('button', { name: '✕ Bad 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete 1 bad' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' }));
    expect(await screen.findByText('Delete pending')).toBeTruthy();
    expect(screen.getByRole('button', { name: '✕ Bad 1' })).toBeTruthy();
  });

  // Uniquely catches a frame another shot uses dropping out of the picker, or one this slot holds being offered back.
  it('offers a still another shot uses, says where, and never offers to delete it', async () => {
    api.getMusicVideoMediaPool.mockImplementationOnce(async () => ({ items: [
      { kind: 'image', assetId: 'start-12.png', sceneId: 's12', prompt: 'Splicer close-up', clipIds: [], inUseBy: ['s12'], mark: 'bad' },
      { kind: 'image', assetId: 'mine-now.png', sceneId: 's8', prompt: 'Current still', clipIds: [], inUseBy: ['s8'] },
    ] }));
    const onPlace = vi.fn(async () => {});
    render(<SceneTakePicker open projectId="mv-1" scene={{ sceneId: 's8', referenceImageId: 'mine-now.png' }} kind="image" onPlace={onPlace}
      shotNumbers={new Map([['s8', 8], ['s12', 12]])} />);
    fireEvent.click(await screen.findByRole('tab', { name: /Other shots/ }));
    fireEvent.click(screen.getByRole('button', { name: /still from shot 12, used on #12/ }));
    expect(screen.getByText('Used on #12')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '✕ Bad 1' }));
    expect(screen.queryByRole('button', { name: /Delete 1 bad/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Use still' }));
    expect(onPlace).toHaveBeenCalledWith({ kind: 'image', assetId: 'start-12.png' });
    // The still already in this slot isn't offered back.
    fireEvent.click(screen.getByRole('tab', { name: /This shot/ }));
    expect(screen.queryByRole('button', { name: /Current still/ })).toBeNull();
  });

  // Uniquely catches the grid stopping at its first page instead of loading more as its bottom scrolls into view.
  it('loads the next page of stills when the bottom of the grid comes into view', async () => {
    const many = Array.from({ length: 70 }, (_, i) => ({ kind: 'image', assetId: `f${i}.png`, sceneId: null, prompt: `Frame ${i}`, clipIds: [] }));
    api.getMusicVideoMediaPool.mockImplementationOnce(async () => ({ items: many }));
    const observers = [];
    vi.stubGlobal('IntersectionObserver', function IntersectionObserver(callback) {
      const self = { observe: () => observers.push(self), disconnect: () => {}, fire: () => callback([{ isIntersecting: true }]) };
      return self;
    });
    render(<SceneTakePicker open projectId="mv-1" scene={{ sceneId: 's8' }} kind="image" onPlace={vi.fn()} shotNumbers={new Map()} />);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(60));
    // The footer starts observing in an effect that can land after the first page paints.
    await waitFor(() => expect(observers.length).toBeGreaterThan(0));
    act(() => observers.at(-1).fire());
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(70));
    expect(screen.queryByRole('button', { name: /Show more/ })).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("the shot's own other frame", () => {
  // Uniquely catches the picker hiding the shot's end frame (in use, so not in the unused pool) when swapping its start.
  it('lists the end frame first on This shot when swapping the start, and places it', async () => {
    const onPlace = vi.fn(async () => {});
    const scene = { sceneId: 's8', referenceImageId: 'start.png', endImageId: 'end.png', endFramePrompt: 'Door shut',
      takes: [{ takeId: 't1', kind: 'endImage', assetId: 'end.png', prompt: 'Door shut', status: 'candidate' }] };
    render(<SceneTakePicker open projectId="mv-1" scene={scene} kind="image" onClose={vi.fn()} onPlace={onPlace} shotNumbers={new Map([['s8', 8]])} />);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
    const first = screen.getAllByRole('listitem')[0];
    expect(first.textContent).toContain('End frame');
    fireEvent.click(screen.getByRole('button', { name: "This shot's end frame: Door shut" }));
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Use still' }));
    expect(onPlace).toHaveBeenCalledWith({ kind: 'image', assetId: 'end.png' });
  });
});
