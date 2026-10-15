import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const pool = [
  { kind: 'image', assetId: 'late.png', sceneId: 's2', prompt: 'Reel on the bench', clipIds: [], inUseBy: ['s2'] },
  { kind: 'image', assetId: 'floor.png', sceneId: null, prompt: 'Spare frame', clipIds: [] },
  { kind: 'image', assetId: 'early.png', sceneId: 's1', prompt: 'Splicer close-up', clipIds: [] },
  { kind: 'image', assetId: 'marked.png', sceneId: 's1', prompt: 'Out of focus', clipIds: [], mark: 'bad' },
  { kind: 'video', assetId: 'clip-1', sceneId: 's1', sourceImageId: 'early.png', inUseBy: ['s1'] },
];
vi.mock('../../../services/apiMusicVideo.js', () => ({
  getMusicVideoMediaPool: vi.fn(async () => ({ items: pool })),
  markMusicVideoPoolAssets: vi.fn(async () => ({ assetMarks: { 'image:early.png': 'bad' } })),
  deleteMusicVideoPoolAssets: vi.fn(async () => ({ deleted: 1 })),
  searchMusicVideoMediaPool: vi.fn(async () => ({ items: [] })),
  listMusicVideoProjectSummaries: vi.fn(async () => ({ items: [{ id: 'mv-1', name: 'This video' }, { id: 'mv-draft', name: 'Early draft' }] })),
  searchMusicVideoLibrary: vi.fn(async () => ({ items: [{ kind: 'image', assetId: 'sheet.png', prompt: 'Director sheet' }, { kind: 'video', assetId: 'old-clip', prompt: 'Director turns' }], more: false })),
  addMusicVideoLibraryMedia: vi.fn(async () => ({ added: 1, items: [...pool, { kind: 'image', assetId: 'sheet.png', sceneId: null, clipIds: [] }] })),
  importMusicVideoPool: vi.fn(async () => ({ added: 2, total: 3, items: [...pool, { kind: 'image', assetId: 'draft.png', sceneId: null, clipIds: [] }] })),
}));
const { default: AssetsStage } = await import('./AssetsStage.jsx');
const api = await import('../../../services/apiMusicVideo.js');

const project = { id: 'mv-1', scenes: [{ sceneId: 's2', startSec: 4 }, { sceneId: 's1', startSec: 0 }] };
const renderPage = (board = {}) => render(
  <MemoryRouter initialEntries={['/music-video/mv-1/assets']}>
    <AssetsStage board={{ project, takes: { applyPoolMarks: vi.fn() }, onEditShot: vi.fn(), ...board }} />
  </MemoryRouter>,
);
const tiles = () => within(screen.getByRole('list', { name: 'Stills' })).getAllByRole('button').map((b) => b.getAttribute('aria-label').split(':')[0]);

describe('Music video Assets page', () => {
  // Uniquely catches the page losing shot order, the floor's place, or the Unsorted queue counting used or marked files.
  it('lists stills in shot order with the floor last, and Unsorted holds only unused, unmarked ones', async () => {
    renderPage();
    await waitFor(() => expect(tiles()).toHaveLength(4));
    expect(tiles()).toEqual(['still from shot 1', 'still from shot 1', 'still from shot 2, used on #2', 'still on the floor']);
    fireEvent.click(screen.getByRole('button', { name: 'Unsorted 2' }));
    expect(tiles()).toEqual(['still from shot 1', 'still on the floor']);
    expect(screen.getByRole('tab', { name: /Clips/ })).toBeTruthy();
  });

  // Uniquely catches a mark that skips the shots' take update, or Open shot losing which shot a file was made for.
  it('marks a still bad, updates the shots, and opens the shot it was made for', async () => {
    const applyPoolMarks = vi.fn();
    const onEditShot = vi.fn();
    renderPage({ takes: { applyPoolMarks }, onEditShot });
    fireEvent.click(await screen.findByRole('button', { name: /still from shot 1: Splicer close-up/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Bad' }));
    await waitFor(() => expect(api.markMusicVideoPoolAssets).toHaveBeenCalledWith('mv-1', [{ kind: 'image', assetId: 'early.png' }], 'bad', { silent: true }));
    await waitFor(() => expect(applyPoolMarks).toHaveBeenCalledWith('mv-1', { assetMarks: { 'image:early.png': 'bad' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Open shot 1' }));
    expect(onEditShot).toHaveBeenCalledWith('s1');
  });

  // Uniquely catches the import offering this video as its own source, or the page not showing what it filed.
  it('adds an earlier draft\'s media from a picker of the other videos', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Add media from another video' }));
    const picker = screen.getByLabelText('Add media from');
    await waitFor(() => expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual(['Pick a video', 'Early draft']));
    fireEvent.change(picker, { target: { value: 'mv-draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(api.importMusicVideoPool).toHaveBeenCalledWith('mv-1', 'mv-draft', { silent: true }));
    expect(await screen.findByText('Added 2 stills and clips from Early draft (1 were already here).')).toBeTruthy();
    await waitFor(() => expect(tiles()).toHaveLength(5));
  });

  // Uniquely catches the library add sending files that weren't picked, or the page not showing what it filed.
  it('adds picked media from a library prompt search', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Add from the media library' }));
    fireEvent.change(screen.getByLabelText('Search the media library by prompt'), { target: { value: 'director' } });
    fireEvent.click(await screen.findByRole('button', { name: 'still: Director sheet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add 1' }));
    await waitFor(() => expect(api.addMusicVideoLibraryMedia).toHaveBeenCalledWith('mv-1', [{ kind: 'image', assetId: 'sheet.png' }], { silent: true }));
    expect(await screen.findByText('Added 1 from the media library.')).toBeTruthy();
    await waitFor(() => expect(tiles()).toHaveLength(5));
  });
});
