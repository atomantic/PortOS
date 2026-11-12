import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';

const handlers = vi.hoisted(() => new Map());
vi.mock('../../services/socket', () => ({
  default: {
    on: (event, fn) => { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); },
    off: (event, fn) => { handlers.get(event)?.delete(fn); },
  },
}));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// The shared Blender setup reads its own API; here it only needs to be present.
vi.mock('../codeAnimation/ProductionContainment', () => ({ default: ({ onExecutionChange }) => <div data-testid="blender-setup">Blender setup<button type="button" onClick={() => onExecutionChange({ executionMode: 'trusted-local', lanes: { blender: { ready: true } } })}>Report ready Blender</button></div> }));
vi.mock('../../services/apiMusicVideo.js', () => ({
  getMusicVideoBlender: vi.fn(),
  saveMusicVideoBlenderSettings: vi.fn(),
  createMusicVideoBlenderWorkspace: vi.fn(),
  listMusicVideoBlenderFiles: vi.fn(),
  getMusicVideoBlenderFile: vi.fn(),
  saveMusicVideoBlenderFile: vi.fn(),
  deleteMusicVideoBlenderFile: vi.fn(),
  syncMusicVideoBlender: vi.fn(),
  renderMusicVideoBlender: vi.fn(),
  cancelMusicVideoBlenderJob: vi.fn(),
  cancelMusicVideoBlenderJobs: vi.fn(),
  assembleMusicVideoBlenderCut: vi.fn(),
  saveMusicVideoBlenderShotNote: vi.fn(),
  openMusicVideoBlenderShot: vi.fn(),
  getMusicVideoBlenderLog: vi.fn(),
  getMusicVideoBlenderUsage: vi.fn(),
  clearMusicVideoBlenderFrames: vi.fn(),
  musicVideoBlenderMediaUrl: (id, path) => `/api/music-video/${id}/blender/media?path=${encodeURIComponent(path)}`,
}));

import BlenderFilmPanel from './BlenderFilmPanel.jsx';
import useMusicVideoBlender from '../../hooks/useMusicVideoBlender.js';
import toast from '../ui/Toast';
import {
  assembleMusicVideoBlenderCut, cancelMusicVideoBlenderJob, clearMusicVideoBlenderFrames, createMusicVideoBlenderWorkspace, getMusicVideoBlender, getMusicVideoBlenderFile,
  getMusicVideoBlenderLog, getMusicVideoBlenderUsage, listMusicVideoBlenderFiles, renderMusicVideoBlender, saveMusicVideoBlenderFile, saveMusicVideoBlenderSettings,
  saveMusicVideoBlenderShotNote, syncMusicVideoBlender,
} from '../../services/apiMusicVideo.js';
import { blenderFilmProject, blenderFilmState, blenderShot } from '../../test/blenderFilmFixture.js';

const GIB = 1024 ** 3;
const board = { openPreview: vi.fn(), goToStage: vi.fn() };
function Harness() {
  const blender = useMusicVideoBlender('mv-test');
  return <BlenderFilmPanel board={{ project: blenderFilmProject(), blender, audioUrl: '/data/music/example-song.wav', ...board }} />;
}
function Where() {
  const { search } = useLocation();
  return <output data-testid="search">{search}</output>;
}
const renderPanel = async (search = '') => {
  render(<MemoryRouter initialEntries={[`/music-video/mv-test/produce${search}`]}><Harness /><Where /></MemoryRouter>);
  await screen.findByRole('tablist', { name: 'Blender film' });
};
const push = (event, payload) => act(async () => { for (const fn of handlers.get(event) || []) fn(payload); });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const openTab = (name) => fireEvent.click(screen.getByRole('tab', { name }));
const row = (id) => within(screen.getByRole('list', { name: 'Shots' })).getByRole('button', { name: new RegExp(`^${id}\\b`) });
const detail = (id) => screen.getByRole('region', { name: `Shot ${id}` });
const search = () => screen.getByTestId('search').textContent;

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  getMusicVideoBlender.mockResolvedValue(blenderFilmState());
  listMusicVideoBlenderFiles.mockResolvedValue({ files: [] });
  getMusicVideoBlenderUsage.mockResolvedValue({ sourceBytes: 4096, rendersBytes: 3 * GIB, frameBytes: 2 * GIB, frameFiles: 2160, clearableBytes: 2 * GIB, removedShots: [] });
});

describe('BlenderFilmPanel: shots', () => {
  it('lists every shot with its renders named in words and plays the selected shot\'s newest render', async () => {
    await renderPanel();
    expect(screen.getByRole('region', { name: 'Blender film' })).toHaveTextContent('3 shots · 1 previews · 1 finals current');
    expect(screen.getByText('Blender 5.2.3 ready')).toBeInTheDocument();
    expect(row('s010')).toHaveTextContent('Preview done');
    expect(row('s010')).toHaveTextContent('Final done');
    expect(row('s010')).toHaveTextContent('Note ready for review');
    expect(row('s020')).toHaveTextContent('Preview stale');
    expect(row('s020')).toHaveTextContent('Final none');
    expect(row('s030')).toHaveTextContent('Preview none');
    // Its thumbnail is the poster the server made with the preview.
    expect(row('s020').querySelector('img').getAttribute('src')).toBe('/api/music-video/mv-test/blender/media?path=s020%2Fpreview%2Fposter.jpg');

    const first = detail('s010');
    expect(first.querySelector('video').getAttribute('src')).toBe('/api/music-video/mv-test/blender/media?path=s010%2Ffinal%2Fshot.mp4');
    expect(first.querySelector('video').loop).toBe(true);
    expect(first.querySelector('audio').getAttribute('src')).toBe('/data/music/example-song.wav');
    expect(within(first).getByText('Lights rise on the empty stage.')).toBeInTheDocument();
    // An up-to-date render is only re-rendered on purpose.
    fireEvent.click(within(first).getByRole('button', { name: 'Re-render preview' }));
    expect(renderMusicVideoBlender).toHaveBeenCalledWith('mv-test', { shotIds: ['s010'], quality: 'preview', force: true }, { silent: true });
    await act(async () => {});

    fireEvent.click(row('s020'));
    expect(within(detail('s020')).getByText(/Preview is out of date: its scripts changed\./)).toBeInTheDocument();
    fireEvent.click(within(detail('s020')).getByRole('button', { name: 'Render preview' }));
    expect(renderMusicVideoBlender).toHaveBeenLastCalledWith('mv-test', { shotIds: ['s020'], quality: 'preview' }, { silent: true });
    await act(async () => {});
  });

  it('moves a shot\'s progress from a job frame without another read, and re-reads when the job finishes', async () => {
    await renderPanel();
    const frame = { id: 'j1', kind: 'render', shotId: 's030', quality: 'preview', status: 'running', index: 18, total: 72, startedAt: '2026-10-01T11:00:00.000Z' };
    await push('music-video:blender', { projectId: 'mv-other', kind: 'job', job: frame });
    expect(row('s030')).toHaveTextContent('Preview none');
    await push('music-video:blender', { projectId: 'mv-test', kind: 'job', job: frame });
    expect(row('s030')).toHaveTextContent('Preview rendering 25%');
    await push('music-video:blender', { projectId: 'mv-test', kind: 'job', job: { ...frame, index: 54 } });
    expect(row('s030')).toHaveTextContent('Preview rendering 75%');
    expect(screen.getByText('1 job at work')).toBeInTheDocument();
    expect(getMusicVideoBlender).toHaveBeenCalledTimes(1);

    const finished = blenderFilmState({ jobs: [{ ...frame, status: 'done', finishedAt: '2026-10-01T11:01:00.000Z' }] });
    finished.renders.s030 = { preview: { file: 's030/preview/shot.mp4', frames: 72, complete: true, stale: false, finishedAt: '2026-10-01T11:01:00.000Z' }, stills: [] };
    getMusicVideoBlender.mockResolvedValueOnce(finished);
    await push('music-video:blender', { projectId: 'mv-test', kind: 'job', job: { ...frame, status: 'done' } });
    expect(getMusicVideoBlender).toHaveBeenCalledTimes(1);
    await push('music-video:blender', { projectId: 'mv-test', kind: 'state' });
    expect(getMusicVideoBlender).toHaveBeenCalledTimes(2);
    expect(row('s030')).toHaveTextContent('Preview done');
    expect(screen.queryByText('1 job at work')).toBeNull();
  });

  it('reserves the Cancel control in the action row before a job starts', async () => {
    await renderPanel('?bshot=s030');
    const actions = within(detail('s030')).getByRole('group', { name: 'Render this shot' });
    const cancel = [...actions.querySelectorAll('button')].find((button) => button.textContent.includes('Cancel'));
    expect(cancel).toBeDisabled();
    expect(cancel).toHaveClass('invisible');
    const count = actions.children.length;
    await push('music-video:blender', { projectId: 'mv-test', kind: 'job', job: { id: 'j1', kind: 'render', shotId: 's030', quality: 'preview', status: 'running' } });
    expect(actions.children).toHaveLength(count);
    expect(cancel).not.toHaveClass('invisible');
    expect(cancel).toBeEnabled();
  });

  it('keeps the selected shot in the URL, restores it from a link, and steps shots from the timeline with the arrow keys', async () => {
    await renderPanel('?bshot=s030');
    expect(detail('s030')).toBeInTheDocument();
    expect(row('s030')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(row('s020'));
    expect(search()).toBe('?bshot=s020');
    expect(detail('s020')).toBeInTheDocument();

    const strip = screen.getByRole('toolbar', { name: 'Shots across the song' });
    const segment = (id) => within(strip).getByRole('button', { name: new RegExp(`^${id} `) });
    expect(segment('s010')).toHaveAccessibleName('s010 Cold open, 0:00.00–0:04.50 · 4.5s · 108 frames, final done');
    // One tab stop: the selected shot.
    expect(within(strip).getAllByRole('button').filter((button) => button.tabIndex === 0)).toEqual([segment('s020')]);
    segment('s020').focus();
    fireEvent.keyDown(strip, { key: 'ArrowRight' });
    expect(search()).toBe('?bshot=s030');
    expect(document.activeElement).toBe(segment('s030'));
    fireEvent.keyDown(strip, { key: 'ArrowLeft' });
    fireEvent.keyDown(strip, { key: 'ArrowLeft' });
    expect(search()).toBe('?bshot=s010');
    // Space is the app's push-to-talk key: the strip leaves it alone.
    expect(fireEvent.keyDown(strip, { key: ' ' })).toBe(true);
  });

  it('says so when a linked shot is gone instead of showing an empty panel', async () => {
    await renderPanel('?bshot=s999');
    expect(screen.getByText('Shot s999 is no longer in the film. Showing s010.')).toBeInTheDocument();
    expect(detail('s010')).toBeInTheDocument();
  });

  it('asks before a bulk render of more than ten shots and starts a small one directly', async () => {
    const shots = Array.from({ length: 12 }, (_, index) => blenderShot(`s${String((index + 1) * 10).padStart(3, '0')}`, index, index + 1));
    getMusicVideoBlender.mockResolvedValue(blenderFilmState({ manifest: { title: 'Example Film', syncedAt: null, srcChanged: false, problems: [], shots }, renders: {}, notes: {} }));
    renderMusicVideoBlender.mockResolvedValue({ jobs: [] });
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Render previews (12)' }));
    expect(screen.getByText('Queue 12 preview renders?')).toBeInTheDocument();
    expect(renderMusicVideoBlender).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Render' }));
    expect(renderMusicVideoBlender).toHaveBeenCalledWith('mv-test', { quality: 'preview' }, { silent: true });
    await act(async () => {});

    // Nothing is out of date, so that scope has nothing to render.
    fireEvent.change(screen.getByLabelText('Render'), { target: { value: 'stale' } });
    expect(screen.getByRole('button', { name: 'Render finals (0)' })).toBeDisabled();
  });

  it('starts a bulk render of ten shots or fewer without asking', async () => {
    renderMusicVideoBlender.mockResolvedValue({ jobs: [] });
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Render finals (2)' }));
    expect(renderMusicVideoBlender).toHaveBeenCalledWith('mv-test', { quality: 'final' }, { silent: true });
    await act(async () => {});
  });

  it('holds a bulk confirmation when a film refresh makes rendering unavailable', async () => {
    const shots = Array.from({ length: 12 }, (_, index) => blenderShot(`s${String((index + 1) * 10).padStart(3, '0')}`, index, index + 1));
    const state = blenderFilmState({ manifest: { title: 'Example Film', syncedAt: null, fps: 24, srcChanged: false, problems: [], shots }, renders: {}, notes: {} });
    getMusicVideoBlender.mockResolvedValue(state);
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Render previews (12)' }));
    expect(screen.getByRole('button', { name: 'Render' })).toBeEnabled();
    getMusicVideoBlender.mockResolvedValue({ ...state, tool: { ...state.tool, ready: false } });
    await push('music-video:blender', { projectId: 'mv-test', kind: 'state' });
    expect(screen.queryByRole('button', { name: 'Render' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Render previews (12)' })).toBeDisabled();
    expect(renderMusicVideoBlender).not.toHaveBeenCalled();
  });

  it('renders the paused first frame and clamps a near-end position to the shot last frame', async () => {
    renderMusicVideoBlender.mockResolvedValue({ jobs: [] });
    await renderPanel();
    const video = detail('s010').querySelector('video');
    Object.defineProperty(video, 'paused', { configurable: true, value: true });
    video.currentTime = 0;
    fireEvent.click(within(detail('s010')).getByRole('button', { name: 'Render still' }));
    await waitFor(() => expect(renderMusicVideoBlender).toHaveBeenCalledWith('mv-test', { shotIds: ['s010'], quality: 'still', times: [0] }, { silent: true }));
    await waitFor(() => expect(within(detail('s010')).getByRole('button', { name: 'Render still' })).toBeEnabled());
    video.currentTime = 4.499;
    fireEvent.click(within(detail('s010')).getByRole('button', { name: 'Render still' }));
    expect(renderMusicVideoBlender).toHaveBeenLastCalledWith('mv-test', { shotIds: ['s010'], quality: 'still', times: [107 / 24] }, { silent: true });
    await act(async () => {});
  });

  it('requests a contact sheet from shot detail and opens it when clicked or finished', async () => {
    renderMusicVideoBlender.mockResolvedValue({ jobs: [{ id: 'job-sheet-1', kind: 'render', shotId: 's010', quality: 'sheet', status: 'queued' }] });
    await renderPanel();
    fireEvent.click(within(detail('s010')).getByRole('button', { name: 'Contact sheet' }));
    await waitFor(() => expect(renderMusicVideoBlender).toHaveBeenCalledWith('mv-test', { shotIds: ['s010'], quality: 'sheet' }, { silent: true }));
    const finished = blenderFilmState();
    finished.jobs.push({ id: 'job-sheet-1', kind: 'render', shotId: 's010', quality: 'sheet', status: 'done' });
    finished.renders.s010.sheets = [{ file: 's010/sheets/sheet-0-105-e3.jpg', firstFrame: 0, lastFrame: 105, every: 3, tiles: 36, stale: false }];
    getMusicVideoBlender.mockResolvedValue(finished);
    await push('music-video:blender', { projectId: 'mv-test', kind: 'state' });
    await waitFor(() => expect(board.openPreview).toHaveBeenCalledWith('blender-sheet:s010:s010/sheets/sheet-0-105-e3.jpg'));
    fireEvent.click(within(within(detail('s010')).getByRole('region', { name: 'Contact sheets' })).getByRole('button', { name: /Frames 0–105/ }));
    expect(board.openPreview).toHaveBeenLastCalledWith('blender-sheet:s010:s010/sheets/sheet-0-105-e3.jpg');
  });

  it('saves a director note only on Save, sending only what changed', async () => {
    saveMusicVideoBlenderShotNote.mockResolvedValue({ ok: true });
    await renderPanel();
    const save = screen.getByRole('button', { name: 'Save note' });
    expect(screen.getByLabelText('Director note')).toHaveValue('Hold the last frame.');
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'approved' } });
    expect(saveMusicVideoBlenderShotNote).not.toHaveBeenCalled();
    fireEvent.click(save);
    expect(saveMusicVideoBlenderShotNote).toHaveBeenCalledWith('mv-test', 's010', { status: 'approved' }, { silent: true });
    await waitFor(() => expect(row('s010')).toHaveTextContent('Note approved'));
    expect(screen.getByRole('button', { name: 'Save note' })).toBeDisabled();
  });
});

describe('BlenderFilmPanel: getting started', () => {
  it('offers a starter workspace and an agent brief when there is no film yet', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const empty = blenderFilmState({ manifest: null, renders: {}, notes: {}, workspace: { exists: false, dir: 'data/music-video/mv-test/blender', hasFilm: false, files: 0 } });
    getMusicVideoBlender.mockResolvedValue(empty);
    createMusicVideoBlenderWorkspace.mockResolvedValue(blenderFilmState({ manifest: null, renders: {}, notes: {} }));
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Copy agent brief' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const brief = writeText.mock.calls[0][0];
    for (const needle of ['Project id: mv-test', 'data/music-video/mv-test/blender', 'portos-music-video-blender', '/api/music-video/mv-test/blender']) expect(brief).toContain(needle);

    fireEvent.click(screen.getByRole('button', { name: 'Create starter workspace' }));
    expect(createMusicVideoBlenderWorkspace).toHaveBeenCalledWith('mv-test', { template: 'starter' }, { silent: true });
    // With film.py in place the next step is the sync.
    expect(await screen.findByRole('button', { name: 'Sync shots from scripts' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Create starter workspace' })).toBeNull();
    vi.unstubAllGlobals();
  });

  it('explains Trusted local and shows Blender setup when renders cannot run', async () => {
    getMusicVideoBlender.mockResolvedValue(blenderFilmState({ tool: { ready: true, reason: '', executionMode: 'contained', engine: 'CYCLES', version: '5.2.3' } }));
    await renderPanel();
    expect(screen.getByText('Blender not ready')).toBeInTheDocument();
    const readiness = screen.getByRole('region', { name: 'Blender readiness' });
    expect(readiness).toHaveTextContent(/contained execution.*choose Trusted local, save, then Check Blender/);
    expect(readiness).not.toHaveTextContent(/acknowledge|you trust/i);
    expect(screen.getByTestId('blender-setup')).toBeInTheDocument();
    expect(within(detail('s010')).getByRole('button', { name: 'Re-render preview' })).toBeDisabled();
    expect(within(detail('s010')).getByText(/Blender film renders need Trusted local execution/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Render finals (2)' })).toBeDisabled();
    // What is already rendered stays watchable.
    expect(detail('s010').querySelector('video')).not.toBeNull();
  });
});

describe('BlenderFilmPanel: settings', () => {
  // The saved mode is the operator's choice: readiness states it with no acknowledgement step or trust warning.
  it('reports a ready Blender in Trusted local mode in plain words', async () => {
    await renderPanel('?btab=settings');
    const readiness = screen.getByRole('region', { name: 'Blender readiness' });
    expect(readiness).toHaveTextContent('Blender 5.2.3 is ready in Trusted local mode.');
    expect(readiness).not.toHaveTextContent(/acknowledge|you trust|host access/i);
  });

  it('refreshes when setup restores readiness after the film state changed independently', async () => {
    await renderPanel('?btab=settings');
    const blocked = blenderFilmState({ tool: { ready: false, executionMode: 'trusted-local', reason: 'Recheck required' } });
    getMusicVideoBlender.mockResolvedValueOnce(blocked);
    await push('music-video:blender', { projectId: 'mv-test', kind: 'state' });
    expect(screen.getByText('Blender not ready')).toBeInTheDocument();
    const before = getMusicVideoBlender.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Report ready Blender' }));
    await waitFor(() => expect(getMusicVideoBlender).toHaveBeenCalledTimes(before + 1));
    expect(await screen.findByText('Blender 5.2.3 ready')).toBeInTheDocument();
  });

  it('saves only the changed settings and holds renders until the save lands', async () => {
    await renderPanel();
    openTab(/Settings/);
    fireEvent.change(screen.getByLabelText('Final samples'), { target: { value: '128' } });
    openTab(/Shots/);
    expect(within(detail('s010')).getByRole('button', { name: 'Re-render preview' })).toBeDisabled();
    expect(within(detail('s010')).getByText('Save or discard the render settings first.')).toBeInTheDocument();

    openTab(/Settings/);
    expect(screen.getByLabelText('Final samples')).toHaveValue(128);
    const saving = deferred();
    saveMusicVideoBlenderSettings.mockReturnValueOnce(saving.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(saveMusicVideoBlenderSettings).toHaveBeenCalledWith('mv-test', { finalSamples: 128 }, { silent: true });
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    openTab(/Shots/);
    expect(within(detail('s010')).getByText('Saving the render settings…')).toBeInTheDocument();
    expect(within(detail('s010')).getByRole('button', { name: 'Re-render preview' })).toBeDisabled();

    const saved = blenderFilmState();
    saved.settings.finalSamples = 128;
    await act(async () => { saving.resolve(saved); });
    expect(within(detail('s010')).getByRole('button', { name: 'Re-render preview' })).toBeEnabled();
    openTab(/Settings/);
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();

    // A new frame rate is another frame grid: the shots were synced on the old one, so renders
    // (which the server would refuse) wait for a sync, and the sync itself is offered.
    const retimed = blenderFilmState();
    retimed.settings.fps = 30;
    saveMusicVideoBlenderSettings.mockResolvedValueOnce(retimed);
    fireEvent.change(screen.getByLabelText('Frame rate (fps)'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Sync shots from scripts' })).toBeEnabled();
    openTab(/Shots/);
    expect(within(detail('s010')).getByRole('button', { name: 'Re-render preview' })).toBeDisabled();
    expect(within(detail('s010')).getByText(/frame rate changed from 24 to 30 since the last sync/)).toBeInTheDocument();
  });

  it('names a value the server would refuse and keeps Save off', async () => {
    await renderPanel('?btab=settings');
    fireEvent.change(screen.getByLabelText('Width (px)'), { target: { value: '1921' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Width must be an even number.');
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByLabelText('Width (px)')).toHaveValue(1920);
  });

  it('asks before a sync replaces storyboard scenes, then follows the sync as a job that can be cancelled and says why it failed', async () => {
    syncMusicVideoBlender.mockRejectedValueOnce(Object.assign(new Error('Two storyboard scenes are not part of this film.'), { status: 409, code: 'MUSIC_VIDEO_BLENDER_SCENES_CONFLICT' }));
    await renderPanel('?btab=settings');
    fireEvent.click(screen.getByRole('button', { name: 'Sync shots from scripts' }));
    expect(await screen.findByText('Two storyboard scenes are not part of this film. Replace them with the film\'s shots?')).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();

    // The request answers with the queued job at once: describe may run for minutes.
    const sync = { id: 'sync-1', kind: 'sync', status: 'queued', startedAt: '2026-10-01T12:00:00.000Z' };
    syncMusicVideoBlender.mockResolvedValueOnce({ job: sync });
    fireEvent.click(screen.getByRole('button', { name: 'Replace scenes' }));
    expect(syncMusicVideoBlender).toHaveBeenLastCalledWith('mv-test', { replaceScenes: true }, { silent: true });
    expect(await screen.findByText('Waiting to start')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Syncing…' })).toBeDisabled();
    await push('music-video:blender', { projectId: 'mv-test', kind: 'job', job: { ...sync, status: 'running', logFile: 'logs/sync-1.log' } });
    expect(screen.getByText('Blender is reading the film')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sync' }));
    expect(cancelMusicVideoBlenderJob).toHaveBeenCalledWith('mv-test', 'sync-1', { silent: true });

    // The film's shot list was refused: every problem is named, the button is back, and the log is one press away.
    const failed = {
      ...sync, status: 'error', logFile: 'logs/sync-1.log', finishedAt: '2026-10-01T12:00:09.000Z', code: 'MUSIC_VIDEO_BLENDER_MANIFEST_INVALID',
      error: 'The film\'s shot list was refused: Shot s020: starts before shot s010 ends (and 1 more)',
      problems: ['Shot s020: starts before shot s010 ends', 'Option palette: "default" must be one of dusk, neon'],
    };
    getMusicVideoBlender.mockResolvedValue(blenderFilmState({ jobs: [failed] }));
    getMusicVideoBlenderLog.mockResolvedValue('PortOS: Shot s020: starts before shot s010 ends');
    await push('music-video:blender', { projectId: 'mv-test', kind: 'job', job: failed });
    expect(await screen.findByRole('alert')).toHaveTextContent('The last sync failed and the shot list is unchanged');
    expect(within(screen.getByRole('list', { name: 'Problems in the film\'s shot list' })).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Sync shots from scripts' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'View the sync log' }));
    expect(search()).toBe('?btab=jobs&bjob=sync-1');
    expect(await screen.findByLabelText('Job log text')).toHaveTextContent('starts before shot s010 ends');
  });

  it('draws the options the film declares, saves a changed one with the settings, and shows the renders it made out of date', async () => {
    await renderPanel('?btab=settings');
    // A film that declares none has no Film options group at all.
    expect(screen.queryByRole('group', { name: 'Film options' })).toBeNull();

    const state = blenderFilmState();
    state.manifest.options = [
      { key: 'palette', label: 'Palette', type: 'choice', choices: [{ value: 'dusk', label: 'Dusk' }, { value: 'neon', label: 'Neon' }], default: 'dusk', help: 'Colors of the set.' },
      { key: 'debug', label: 'Debug overlay', type: 'boolean', default: false },
      { key: 'glow', label: 'Glow', type: 'number', min: 0, max: 1, step: 0.1, default: 0.5 },
      { key: 'card', label: 'Title card', type: 'text', default: '' },
    ];
    state.settings.options = { palette: 'neon' };
    getMusicVideoBlender.mockResolvedValue(state);
    await push('music-video:blender', { projectId: 'mv-test', kind: 'state' });
    const group = await screen.findByRole('group', { name: 'Film options' });
    expect(within(group).getByLabelText('Palette')).toHaveValue('neon');
    expect(within(group).getByLabelText('Debug overlay')).not.toBeChecked();
    expect(within(group).getByLabelText('Glow')).toHaveValue(0.5);
    expect(within(group).getByLabelText('Title card')).toHaveValue('');
    expect(group).toHaveTextContent('Colors of the set. The film\'s default is Dusk.');
    expect(group).toHaveTextContent('Changing an option marks every preview, final and still out of date');

    // A value the film would refuse is named beside its field and cannot be saved.
    fireEvent.change(within(group).getByLabelText('Glow'), { target: { value: '2' } });
    expect(within(group).getByRole('alert')).toHaveTextContent('Glow must be at most 1.');
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();
    fireEvent.change(within(group).getByLabelText('Glow'), { target: { value: '0.8' } });
    fireEvent.change(within(group).getByLabelText('Palette'), { target: { value: 'dusk' } });
    fireEvent.click(within(group).getByLabelText('Debug overlay'));
    // Renders wait for the save: they would be built with the saved values, not the ones on screen.
    openTab(/Shots/);
    expect(within(detail('s010')).getByText('Save or discard the render settings first.')).toBeInTheDocument();

    openTab(/Settings/);
    const saved = structuredClone(state);
    saved.settings.options = { glow: 0.8, debug: true };
    saved.renders.s010.preview = { ...saved.renders.s010.preview, stale: true, staleReasons: ['options'] };
    saveMusicVideoBlenderSettings.mockResolvedValueOnce(saved);
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    // Only the changed options are sent, and one put back to the film's default is cleared.
    expect(saveMusicVideoBlenderSettings).toHaveBeenCalledWith('mv-test', { options: { palette: null, debug: true, glow: 0.8 } }, { silent: true });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled());
    expect(within(screen.getByRole('group', { name: 'Film options' })).getByLabelText('Palette')).toHaveValue('dusk');
    expect(screen.queryByText('Unsaved changes. Syncs and renders wait until they are saved.')).toBeNull();
    openTab(/Shots/);
    expect(row('s010')).toHaveTextContent('Preview stale');
    expect(detail('s010')).toHaveTextContent('Preview is out of date: a film option changed.');
  });

  it('shows what the renders take on disk and clears the frames of finished renders only after a confirm', async () => {
    clearMusicVideoBlenderFrames.mockResolvedValue({
      freedBytes: 2 * GIB, usage: { sourceBytes: 4096, rendersBytes: GIB, frameBytes: 0, frameFiles: 0, clearableBytes: 0, removedShots: [] },
    });
    getMusicVideoBlenderUsage.mockResolvedValueOnce({ sourceBytes: 4096, rendersBytes: 3 * GIB, frameBytes: 2 * GIB, frameFiles: 2160, clearableBytes: 2 * GIB, removedShots: ['s040'] });
    await renderPanel('?btab=settings');
    const disk = screen.getByRole('region', { name: 'Disk use' });
    expect(await within(disk).findByText(/Renders take 3 GB, of which 2 GB is 2,160 rendered frames\. The film's scripts take 4 KB\./)).toBeInTheDocument();
    fireEvent.click(within(disk).getByRole('button', { name: 'Clear rendered frames (2 GB)' }));
    expect(clearMusicVideoBlenderFrames).not.toHaveBeenCalled();
    expect(within(disk).getByText(/Remove 2 GB of frames from finished renders\? Every shot video, still and cut stays\. This also removes everything rendered for 1 shot the film no longer lists\./)).toBeInTheDocument();
    fireEvent.click(within(disk).getByRole('button', { name: 'Clear frames' }));
    await waitFor(() => expect(clearMusicVideoBlenderFrames).toHaveBeenCalledWith('mv-test', { silent: true }));
    expect(await within(disk).findByText(/Renders take 1 GB, of which 0 B is 0 rendered frames/)).toBeInTheDocument();
    expect(within(disk).getByRole('button', { name: 'Clear rendered frames (0 B)' })).toBeDisabled();
    expect(toast.success).toHaveBeenCalledWith('Cleared 2 GB of rendered frames');

    // While shots render the frames on disk are still being written: clearing waits.
    getMusicVideoBlender.mockResolvedValue(blenderFilmState());
    await push('music-video:blender', { projectId: 'mv-test', kind: 'job', job: { id: 'j1', kind: 'render', shotId: 's030', quality: 'final', status: 'running', index: 1, total: 72 } });
    expect(within(disk).getByText('Wait for the renders to finish, or cancel them, before clearing frames.')).toBeInTheDocument();
  });
});

describe('BlenderFilmPanel: cut', () => {
  it('assembles a cut with the chosen options and marks film-look cuts and their gaps', async () => {
    const cuts = [
      { id: 'cut-2', quality: 'preview', file: 'cuts/preview-2.mp4', createdAt: '2026-10-01T12:00:00.000Z', durationSec: 12, missing: ['s030'], stale: ['s020'], rerendered: ['s010'], filmLook: true },
      { id: 'cut-1', quality: 'preview', file: 'cuts/preview-1.mp4', createdAt: '2026-10-01T11:00:00.000Z', durationSec: 12, missing: [], stale: [], rerendered: [] },
    ];
    getMusicVideoBlender.mockResolvedValue(blenderFilmState({ cuts }));
    assembleMusicVideoBlenderCut.mockResolvedValue({ job: { id: 'c1', kind: 'cut', quality: 'preview', status: 'queued' } });
    await renderPanel('?btab=cut');
    const list = screen.getByRole('list', { name: 'Cuts' });
    expect(within(list).getAllByText('film look')).toHaveLength(1);
    expect(within(list).getAllByRole('button')[0]).toHaveTextContent('1 missing · 1 out of date · 1 rendered since');
    expect(within(list).getAllByRole('button')[1]).toHaveTextContent('matches the renders');
    expect(screen.getByText('1 shot was rendered again after this cut: s010. Assemble a new cut to see it.')).toBeInTheDocument();
    expect(screen.getByText('1 shot was not rendered and plays as black: s030.')).toBeInTheDocument();
    expect(screen.getByLabelText('Preview cut').getAttribute('src')).toBe('/api/music-video/mv-test/blender/media?path=cuts%2Fpreview-2.mp4');

    fireEvent.click(within(list).getAllByRole('button')[1]);
    expect(search()).toBe('?btab=cut&bcut=cut-1');
    expect(screen.getByLabelText('Preview cut').getAttribute('src')).toContain('preview-1.mp4');

    fireEvent.click(screen.getByLabelText('Apply film look (slower)'));
    fireEvent.click(screen.getByRole('button', { name: 'Assemble preview cut' }));
    expect(assembleMusicVideoBlenderCut).toHaveBeenCalledWith('mv-test', { quality: 'preview', filmLook: true }, { silent: true });
    expect(await screen.findByRole('button', { name: 'Assembling preview cut…' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Also publish as review draft'));
    fireEvent.click(screen.getByRole('button', { name: 'Assemble final cut' }));
    expect(assembleMusicVideoBlenderCut).toHaveBeenLastCalledWith('mv-test', { quality: 'final', animatic: true, filmLook: true }, { silent: true });
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: /Go to Final render/ }));
    expect(board.goToStage).toHaveBeenCalledWith('review', 'mv-final-video');
  });
});

describe('BlenderFilmPanel: files', () => {
  const files = [
    { path: 'film.py', bytes: 120, mtime: '2026-10-01T09:00:00.000Z', text: true },
    { path: 'textures/wall.png', bytes: 2048, mtime: '2026-10-01T09:00:00.000Z', text: false },
  ];
  const source = 'def describe(ctx):\n    return {"title": "Example Film", "shots": []}\n';

  it('opens a text file from the list, gates Save on a real change, and lists a binary asset without an editor', async () => {
    listMusicVideoBlenderFiles.mockResolvedValue({ files });
    getMusicVideoBlenderFile.mockResolvedValue({ path: 'film.py', content: source });
    saveMusicVideoBlenderFile.mockResolvedValue({ ok: true });
    await renderPanel('?btab=files');
    const list = await screen.findByRole('list', { name: 'Source files' });
    expect(within(list).queryByRole('button', { name: /wall\.png/ })).toBeNull();
    expect(list).toHaveTextContent('asset · 2 KB');

    fireEvent.click(within(list).getByRole('button', { name: /film\.py/ }));
    expect(search()).toBe('?btab=files&bfile=film.py');
    const editor = await screen.findByLabelText('src/film.py');
    await waitFor(() => expect(editor).toHaveValue(source));
    expect(getMusicVideoBlenderFile).toHaveBeenCalledWith('mv-test', 'film.py', { silent: true });
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    fireEvent.change(editor, { target: { value: `${source}# tweak\n` } });
    expect(save).toBeEnabled();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    // Typing it back to what is saved is not a change.
    fireEvent.change(editor, { target: { value: source } });
    expect(save).toBeDisabled();

    fireEvent.change(editor, { target: { value: `${source}# tweak\n` } });
    // A render would read the file on disk, so it waits for the edit.
    openTab(/Shots/);
    expect(within(detail('s010')).getByText('Save or discard your changes to src/film.py first.')).toBeInTheDocument();
    // The way out is one click, and it leads to the file, not to Settings.
    fireEvent.click(within(detail('s010')).getByRole('button', { name: 'Open Files' }));
    const reopened = await screen.findByLabelText('src/film.py');
    await waitFor(() => expect(reopened).toHaveValue(`${source}# tweak\n`));

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(saveMusicVideoBlenderFile).toHaveBeenCalledWith('mv-test', { path: 'film.py', content: `${source}# tweak\n` }, { silent: true });
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByLabelText('src/film.py')).toHaveValue(`${source}# tweak\n`);
  });

  it('refuses a new file name the workspace would not accept', async () => {
    listMusicVideoBlenderFiles.mockResolvedValue({ files });
    await renderPanel('?btab=files');
    await screen.findByRole('list', { name: 'Source files' });
    const name = screen.getByLabelText('New text file under src/');
    fireEvent.change(name, { target: { value: '../escape.py' } });
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    fireEvent.change(name, { target: { value: 'film.py' } });
    expect(screen.getByRole('alert')).toHaveTextContent('already exists');
    fireEvent.change(name, { target: { value: 'kit/rig.blend' } });
    expect(screen.getByRole('alert')).toHaveTextContent('must end in');
    expect(saveMusicVideoBlenderFile).not.toHaveBeenCalled();
  });

  it('keeps an open file and its draft usable after a failed refresh and retries the read in place', async () => {
    listMusicVideoBlenderFiles.mockResolvedValue({ files });
    getMusicVideoBlenderFile.mockResolvedValue({ path: 'film.py', content: source });
    await renderPanel('?btab=files&bfile=film.py');
    const editor = await screen.findByLabelText('src/film.py');
    await waitFor(() => expect(editor).toHaveValue(source));
    fireEvent.change(editor, { target: { value: `${source}# my draft\n` } });
    listMusicVideoBlenderFiles.mockResolvedValue({ files: files.map(file => ({ ...file, mtime: '2026-10-01T10:00:00.000Z' })) });
    getMusicVideoBlenderFile.mockRejectedValueOnce(new Error('disk unavailable'));
    await push('music-video:blender', { projectId: 'mv-test', kind: 'state' });
    expect(await screen.findByRole('alert')).toHaveTextContent('disk unavailable');
    expect(screen.getByLabelText('src/film.py')).toHaveValue(`${source}# my draft\n`);
    expect(screen.getByLabelText('src/film.py')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    getMusicVideoBlenderFile.mockResolvedValueOnce({ path: 'film.py', content: `${source}# disk changed\n` });
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(getMusicVideoBlenderFile).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByLabelText('src/film.py')).toHaveValue(`${source}# my draft\n`);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByLabelText('src/film.py')).toHaveValue(`${source}# disk changed\n`);
  });

  it('says a failed list read failed instead of showing an empty workspace', async () => {
    listMusicVideoBlenderFiles.mockRejectedValue(new Error('disk unavailable'));
    await renderPanel('?btab=files');
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the source files — disk unavailable');
    expect(screen.queryByText(/No source files yet/)).toBeNull();
  });
});

describe('BlenderFilmPanel: jobs', () => {
  it('shows each job\'s progress, cancels a running one and reads a job\'s log through the media route', async () => {
    const jobs = [
      { id: 'j2', kind: 'render', shotId: 's030', quality: 'final', status: 'error', error: 'film.py raised KeyError', startedAt: '2026-10-01T11:00:00.000Z', finishedAt: '2026-10-01T11:00:30.000Z', logFile: 'logs/j2.log' },
      { id: 'j3', kind: 'render', shotId: 's020', quality: 'preview', status: 'running', index: 27, total: 108, secPerFrame: 0.41, startedAt: '2026-10-01T11:02:00.000Z', logFile: 'logs/j3.log' },
    ];
    getMusicVideoBlender.mockResolvedValue(blenderFilmState({ jobs }));
    getMusicVideoBlenderLog.mockResolvedValue('Traceback (most recent call last):\nKeyError: rig');
    cancelMusicVideoBlenderJob.mockResolvedValue({ ok: true });
    await renderPanel('?btab=jobs');
    const rows = within(screen.getByRole('list', { name: 'Jobs' })).getAllByRole('listitem');
    // Work first, then history.
    expect(rows[0]).toHaveTextContent('Render preview · s020');
    expect(rows[0]).toHaveTextContent('frame 27 of 108');
    expect(rows[0]).toHaveTextContent('0.41 s/frame');
    expect(within(rows[0]).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
    expect(rows[1]).toHaveTextContent('Failed');
    expect(within(rows[1]).getByRole('alert')).toHaveTextContent('film.py raised KeyError');

    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Cancel' }));
    expect(cancelMusicVideoBlenderJob).toHaveBeenCalledWith('mv-test', 'j3', { silent: true });
    await act(async () => {});

    fireEvent.click(within(rows[1]).getByRole('button', { name: 'View log' }));
    expect(search()).toBe('?btab=jobs&bjob=j2');
    expect(await screen.findByText(/KeyError: rig/)).toBeInTheDocument();
    expect(getMusicVideoBlenderLog).toHaveBeenCalledWith('mv-test', 'logs/j2.log', { silent: true });
  });
});
