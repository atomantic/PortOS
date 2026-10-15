// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import BoardStage from './BoardStage.jsx';
import { ShotLockContext } from '../ShotLock.jsx';

vi.mock('../../../hooks/useVideoFileSrc.js', () => ({ useVideoFileSrc: () => ({}) }));
vi.mock('../BeatTimeline.jsx', () => ({ default: () => null }));
vi.mock('../ContactSheetButton.jsx', () => ({ default: () => null }));
vi.mock('../TreatmentPanel.jsx', () => ({ default: () => null, treatmentSummary: () => '' }));
vi.mock('../ProjectActionGroups.jsx', () => ({ PlanActions: () => null }));
vi.mock('../../../services/apiMusicVideo.js', async (load) => ({ ...await load(),
  getMusicVideoOutroStats: vi.fn(async () => ({ stats: { stills: { made: 30, kept: 12 }, clips: { made: 9, kept: 4 }, rejected: 5, shots: 3, transitions: 0, imageEffects: 0, cameraMoves: 0, lipSyncs: 0, floorImages: [] } })) }));

const scene = (n, extra = {}) => ({ sceneId: `s${n}`, order: n - 1, label: `Part ${n}`, referenceImageId: 'f.png', videoHistoryId: 'v', startSec: (n - 1) * 3, endSec: n * 3, takes: [], ...extra });
const board = (scenes, over = {}) => ({
  project: { id: 'p', scenes, composition: { mode: 'concat' } }, locked: false, busy: {},
  sceneMedia: { genScenes: {}, genVideoScenes: {}, failedScenes: { frame: {}, video: {} } },
  videoSettings: { settings: { backend: 'local' } }, takes: {}, treatment: {}, activeSceneId: null, onToggleSceneExpand: vi.fn(), ...over,
});
const Search = () => <output data-testid="search">{useLocation().search}</output>;
const renderBoard = (b, url = '/') => render(<MemoryRouter initialEntries={[url]}><BoardStage board={b} /><Search /></MemoryRouter>);

describe('BoardStage scene filter', () => {
  const scenes = [scene(1), scene(2, { videoHistoryId: null }), scene(3)];

  it('shows chips and counts, and lists only affected scenes from ?scenes=missing', () => {
    renderBoard(board(scenes), '/?scenes=missing');
    expect(screen.getByRole('button', { name: 'Needs attention (1)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Missing footage (1)' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getAllByText('Shot 2 · Part 2').length).toBeGreaterThan(0);
    expect(screen.queryByText('Shot 1 · Part 1')).toBeNull();
    expect(screen.getByText('No clip')).toBeTruthy();
  });

  it('writes the filter to the URL and removes it for All', () => {
    renderBoard(board(scenes));
    expect(screen.getByText('Shot 1 · Part 1')).toBeTruthy();
    // Each card reads its run time beside where it sits in the song.
    expect(screen.getAllByText('3.00s ·')[0].parentElement.textContent).toBe('3.00s · 0:00.00–0:03.00');
    fireEvent.click(screen.getByRole('button', { name: 'Needs attention (1)' }));
    expect(screen.getByTestId('search').textContent).toBe('?scenes=attention');
    expect(screen.queryByText('Shot 1 · Part 1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'All (3)' }));
    expect(screen.getByTestId('search').textContent).toBe('');
  });

  it('j and k step through the listed scenes', () => {
    const b = board(scenes);
    renderBoard(b);
    fireEvent.keyDown(window, { key: 'j' });
    expect(b.onToggleSceneExpand).toHaveBeenLastCalledWith('s1', true);
    const second = board(scenes, { activeSceneId: 's2' });
    renderBoard(second);
    fireEvent.keyDown(window, { key: 'k' });
    expect(second.onToggleSceneExpand).toHaveBeenLastCalledWith('s1', true);
  });

  it('the open card steps to the neighboring shots in song order, past the filter', () => {
    // Listed out of song order, and shot 2 has its clip so ?scenes=missing hides it.
    const shuffled = [scene(3), scene(1), scene(2)];
    const b = board(shuffled, { activeSceneId: 's1', seekToScene: vi.fn() });
    renderBoard(b, '/?scenes=missing');
    expect(screen.getByRole('button', { name: 'Previous shot' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Next shot' }));
    expect(b.seekToScene).toHaveBeenLastCalledWith(expect.objectContaining({ sceneId: 's2' }));
    expect(b.onToggleSceneExpand).toHaveBeenLastCalledWith('s2', true);
  });
});

describe('BoardStage thumbnail media badges', () => {
  it('marks each thumbnail with what its selected media is, plus an end frame', () => {
    const scenes = [
      scene(1),
      scene(2, { videoHistoryId: null, endImageId: 'end.png' }),
      scene(3, { visualLayer: 'code', referenceImageId: null, videoHistoryId: null }),
    ];
    renderBoard(board(scenes, { project: { id: 'p', scenes, composition: { mode: 'composed' } } }));
    const descriptionOf = (name) => screen.getByRole('button', { name }).getAttribute('aria-describedby');
    expect(document.getElementById(descriptionOf('Open Shot 1 · Part 1')).textContent).toBe('Clip');
    expect(document.getElementById(descriptionOf('Open Shot 2 · Part 2')).textContent).toBe('ImageEnd frame');
    expect(document.getElementById(descriptionOf('Open Shot 3 · Part 3')).textContent).toBe('Code');
  });
});

describe('BoardStage thumbnail lock marks', () => {
  it('marks locked, still-only and changed shots, and leaves open ones bare', () => {
    const scenes = [scene(1), scene(2), scene(3), scene(4)];
    render(<MemoryRouter><ShotLockContext.Provider value={{ locks: { s1: 'locked', s2: 'changed', s3: 'open', s4: 'locked' },
      clips: { s1: 'locked', s2: 'open', s3: 'open', s4: 'open' }, toggle: vi.fn() }}>
      <BoardStage board={board(scenes)} /></ShotLockContext.Provider></MemoryRouter>);
    const described = (name) => screen.getByRole('button', { name }).getAttribute('aria-describedby').split(' ')
      .map(id => document.getElementById(id).textContent);
    expect(described('Open Shot 1 · Part 1')).toEqual(['Locked', 'Clip']);
    expect(described('Open Shot 2 · Part 2')).toEqual(['Changed since locked', 'Clip']);
    expect(described('Open Shot 3 · Part 3')).toEqual(['Clip']);
    // A video shot whose still is locked but whose clip is not reads "Still".
    expect(document.getElementById('scene-lock-s4')).toMatchObject({ title: 'Still locked, video not locked yet' });
  });
});

describe('BoardStage scene cards', () => {
  // Uniquely catches the board card naming only its section (no shot number), a locked shot still
  // flagged "Takes to review", and a code-rendered clip labelled Clip with no picture.
  it('numbers shots in song order, settles a locked shot, and marks a code-rendered clip', () => {
    const pending = { takes: [{ takeId: 't1', kind: 'video', assetId: 'v', status: 'selected' }, { takeId: 't2', kind: 'video', assetId: 'v2', status: 'candidate' }] };
    const scenes = [scene(1, { startSec: 3, endSec: 6, sectionLabel: 'Verse', ...pending }), scene(2, { startSec: 0, endSec: 3, sectionLabel: 'Intro' }),
      scene(3, { startSec: 6, endSec: 9, sectionLabel: 'Code', referenceImageId: null, videoHistoryId: 'upload-1', codeClip: true })];
    const view = (locks) => render(<MemoryRouter><ShotLockContext.Provider value={{ locks, toggle: vi.fn() }}>
      <BoardStage board={board(scenes, { project: { id: 'p', scenes, composition: { mode: 'composed' } } })} /></ShotLockContext.Provider></MemoryRouter>);
    const { unmount } = view({ s1: 'open', s2: 'open', s3: 'open' });
    expect(screen.getByRole('button', { name: 'Open Shot 1 · Intro' })).toBeTruthy();
    const verse = screen.getByRole('button', { name: 'Open Shot 2 · Verse' });
    expect(verse.textContent).toContain('Takes to review');
    const code = screen.getByRole('button', { name: 'Open Shot 3 · Code' });
    expect(document.getElementById('scene-media-s3').textContent).toBe('Code');
    expect(code.querySelector('img').getAttribute('src')).toBe('/data/video-thumbnails/upload-1.jpg');
    expect(code.textContent).not.toContain('No frame');
    unmount();
    view({ s1: 'locked', s2: 'open', s3: 'open' });
    expect(screen.getByRole('button', { name: 'Open Shot 2 · Verse' }).textContent).not.toContain('Takes to review');
  });
});

describe('BoardStage ending', () => {
  // Uniquely catches the ending after the song being unreachable from the board, where the shots are managed.
  it('lists the ending after the last shot and opens its preview and settings there', async () => {
    const scenes = [scene(1), scene(2)];
    const saveProjectFields = vi.fn(async () => {});
    const b = board(scenes, { editProjectLocal: vi.fn(), saveProjectFields });
    // happy-dom paints no canvas; the scene's drawing is covered by StatsOutro.test.jsx.
    const canvas = vi.spyOn(window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    renderBoard(b, '/?scenes=all');
    const thumbs = screen.getByLabelText('Storyboard thumbnails').querySelectorAll(':scope > button');
    const ending = thumbs[thumbs.length - 1];
    expect(ending.getAttribute('aria-label')).toBe('Open the ending: cutting room floor');
    expect(ending.textContent).toContain('Off');
    fireEvent.click(ending);
    expect(screen.getByTestId('search').textContent).toContain('ending=1');
    const card = screen.getByRole('region', { name: 'Ending: cutting room floor' });
    await waitFor(() => expect(card.textContent).toContain('Left on the floor'));
    expect(card.textContent).toContain('Renders reviewed39');
    expect(screen.getByRole('button', { name: /Play 8s/ })).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Off/));
    expect(saveProjectFields).toHaveBeenCalledWith({ statsOutro: { enabled: true, durationSec: 8, title: 'Human Directed', subtitle: 'Human Imagined', hidden: [] } });
    fireEvent.click(screen.getByRole('button', { name: 'Close the ending' }));
    expect(screen.getByTestId('search').textContent).not.toContain('ending');
    expect(screen.queryByRole('region', { name: 'Ending: cutting room floor' })).toBeNull();
    canvas.mockRestore();
  });
});
