// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import BoardStage from './BoardStage.jsx';

vi.mock('../../../services/apiRunwayCatalog.js', async (importOriginal) => ({ ...await importOriginal(), loadRunwayCatalog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../hooks/useVideoFileSrc.js', () => ({ useVideoFileSrc: () => ({}) }));
vi.mock('../BeatTimeline.jsx', () => ({ default: () => null }));
vi.mock('../ContactSheetButton.jsx', () => ({ default: () => null }));
vi.mock('../TreatmentPanel.jsx', () => ({ default: () => null, treatmentSummary: () => '' }));
vi.mock('../ProjectActionGroups.jsx', () => ({ PlanActions: () => null }));
vi.mock('../../../services/apiMusicVideo.js', async (load) => ({ ...await load(),
  getMusicVideoOutroStats: vi.fn(async () => ({ stats: { stills: { made: 30, kept: 12 }, clips: { made: 9, kept: 4 }, rejected: 5, shots: 3, transitions: 0, imageEffects: 0, cameraMoves: 0, lipSyncs: 0, floorImages: [] } })),
  getMusicVideoCreditsPrefill: vi.fn(async () => ({ credits: { enabled: true, durationSec: 10, title: 'Example Song', artist: 'Example Artist', lines: [{ role: 'Directed by', name: 'Example Artist' }], footer: '' } })) }));

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

describe('BoardStage effects', () => {
  // Uniquely catches a badge in the wrong slot, a count that misses a slot, or the effect filter not narrowing the board.
  it('badges each shot\'s start, mid-shot and end effects, counts every option, and shows only the shots using one', () => {
    const scenes = [
      scene(1, { transitionIn: 'vhs-glitch', glitches: [{ atSec: 1, style: 'film-burn' }, { atSec: 2, style: 'vhs-glitch' }], cutEffect: { style: 'dissolve' } }),
      scene(2, { transitionOut: 'vhs-glitch' }),
      scene(3),
    ];
    renderBoard(board(scenes));
    expect(screen.getByRole('button', { name: 'Open Shot 1 · Part 1' }).getAttribute('aria-describedby')).toContain('scene-effects-s1');
    expect(document.getElementById('scene-effects-s1').textContent).toBe('VHS glitchStart: VHS glitch.Film burn+1Mid-shot: Film burn, VHS glitch.DissolveEnd: Dissolve.');
    expect(document.getElementById('scene-effects-s3')).toBeNull();
    const row = (name) => [...screen.getByRole('button', { name }).closest('tr').querySelectorAll('td')].map((td) => td.textContent);
    expect(row('Show shots with VHS glitch')).toEqual(['1', '1', '1', '2']);
    expect(row('Show shots with Dissolve')).toEqual(['—', '—', '1', '1']);
    expect(screen.getByRole('button', { name: 'Shutter: not used' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Show shots with Film burn' }));
    expect(screen.getByTestId('search').textContent).toBe('?effect=film-burn');
    expect(screen.queryByText('Shot 2 · Part 2')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop showing only shots with Film burn' }));
    expect(screen.getByText('Shot 2 · Part 2')).toBeTruthy();
  });
});

describe('BoardStage thumbnail marks', () => {
  it('shows media marks and no lock marks', () => {
    const scenes = [scene(1), scene(2), scene(3), scene(4)];
    render(<MemoryRouter><BoardStage board={board(scenes)} /></MemoryRouter>);
    const described = (name) => screen.getByRole('button', { name }).getAttribute('aria-describedby').split(' ')
      .map(id => document.getElementById(id).textContent);
    expect(described('Open Shot 1 · Part 1')).toEqual(['Clip']);
    expect(described('Open Shot 2 · Part 2')).toEqual(['Clip']);
    expect(described('Open Shot 3 · Part 3')).toEqual(['Clip']);
    expect(document.getElementById('scene-lock-s4')).toBeNull();
  });
});

describe('BoardStage scene cards', () => {
  it('numbers shots in song order, keeps candidate review visible, and marks a code-rendered clip', () => {
    const pending = { takes: [{ takeId: 't1', kind: 'video', assetId: 'v', status: 'selected' }, { takeId: 't2', kind: 'video', assetId: 'v2', status: 'candidate' }] };
    const scenes = [scene(1, { startSec: 3, endSec: 6, sectionLabel: 'Verse', ...pending }), scene(2, { startSec: 0, endSec: 3, sectionLabel: 'Intro' }),
      scene(3, { startSec: 6, endSec: 9, sectionLabel: 'Code', referenceImageId: null, videoHistoryId: 'upload-1', codeClip: true })];
    render(<MemoryRouter><BoardStage board={board(scenes, { project: { id: 'p', scenes, composition: { mode: 'composed' } } })} /></MemoryRouter>);
    expect(screen.getByRole('button', { name: 'Open Shot 1 · Intro' })).toBeTruthy();
    const verse = screen.getByRole('button', { name: 'Open Shot 2 · Verse' });
    expect(verse.textContent).toContain('Takes to review');
    const code = screen.getByRole('button', { name: 'Open Shot 3 · Code' });
    expect(document.getElementById('scene-media-s3').textContent).toBe('Code');
    expect(code.querySelector('img').getAttribute('src')).toBe('/data/video-thumbnails/upload-1.jpg');
    expect(code.textContent).not.toContain('No frame');
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
    const ending = thumbs[thumbs.length - 2];
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

  it('lists the credits last and fills them from the song and artist when turned on', async () => {
    const saveProjectFields = vi.fn(async () => {});
    const b = board([scene(1)], { editProjectLocal: vi.fn(), saveProjectFields });
    const canvas = vi.spyOn(window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    renderBoard(b, '/?scenes=all');
    const thumbs = screen.getByLabelText('Storyboard thumbnails').querySelectorAll(':scope > button');
    const credits = thumbs[thumbs.length - 1];
    expect(credits.getAttribute('aria-label')).toBe('Open the ending: credits');
    fireEvent.click(credits);
    expect(screen.getByTestId('search').textContent).toContain('ending=credits');
    const card = screen.getByRole('region', { name: 'Ending: credits' });
    fireEvent.click(within(card).getByLabelText(/Off/));
    await waitFor(() => expect(saveProjectFields).toHaveBeenCalledWith({ creditsOutro: {
      enabled: true, durationSec: 10, layout: 'roll', title: 'Example Song', artist: 'Example Artist', lines: [{ role: 'Directed by', name: 'Example Artist' }], footer: '',
    } }));
    fireEvent.click(screen.getByRole('button', { name: 'Close the credits' }));
    expect(screen.getByTestId('search').textContent).not.toContain('ending');
    // Refill locks the editor until its lines land, so a newer edit can't be overwritten.
    const { getMusicVideoCreditsPrefill } = await import('../../../services/apiMusicVideo.js');
    let land;
    getMusicVideoCreditsPrefill.mockImplementationOnce(() => new Promise((resolve) => { land = resolve; }));
    const on = board([scene(1)], { editProjectLocal: vi.fn(), saveProjectFields });
    on.project = { ...on.project, creditsOutro: { enabled: true, title: 'Old Title' } };
    cleanup();
    renderBoard(on, '/?scenes=all&ending=credits');
    fireEvent.click(screen.getByRole('button', { name: /Refill from song/ }));
    const editor = () => screen.getByLabelText('Song title').closest('fieldset');
    expect(editor().disabled).toBe(true);
    await act(async () => { land({ credits: { enabled: true, title: 'Example Song' } }); });
    await waitFor(() => expect(editor().disabled).toBe(false));
    // A refill left behind by closing the card is dropped, so the reopened editor's edits stand.
    getMusicVideoCreditsPrefill.mockImplementationOnce(() => new Promise((resolve) => { land = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: /Refill from song/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Close the credits' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open the ending: credits' }));
    expect(editor().disabled).toBe(false);
    saveProjectFields.mockClear();
    await act(async () => { land({ credits: { enabled: true, title: 'Stale Refill' } }); });
    expect(saveProjectFields).not.toHaveBeenCalled();
    canvas.mockRestore();
  });
});

