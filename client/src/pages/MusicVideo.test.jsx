/**
 * Focused tests for the music-video Render control (#1760 Phase 2): the button
 * gates on a scene having a generated clip, and clicking it kicks off the render.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import toast from '../components/ui/Toast';

const PROJECT_WITH_CLIP = {
  id: 'mv-1', name: 'Neon Run', mode: 'director', status: 'ready',
  trackId: 't1', uploadedAudioFilename: null, audioAnalysis: null, renderHistoryId: null,
  scenes: [{ sceneId: 's1', order: 0, prompt: 'a', referenceImageId: 'img1', videoHistoryId: 'h1' }],
};
const PROJECT_NO_CLIP = {
  ...PROJECT_WITH_CLIP, id: 'mv-2', name: 'No Clips',
  scenes: [{ sceneId: 's1', order: 0, prompt: 'a', referenceImageId: 'img1', videoHistoryId: null }],
};

// The render job gets its own fixed state. The two independent YouTube-import
// job slots (create form + detail-view track picker, #1945) each get a state
// object keyed by their subscription URL (which encodes the jobId) — a single
// shared state would leak one slot's terminal frame into the other's.
const { sseState, ytSseStates, getYtSseState } = vi.hoisted(() => {
  const states = new Map();
  return {
    sseState: { latest: null, closed: false, frames: [], isOpen: false },
    ytSseStates: states,
    getYtSseState: (url) => {
      if (!states.has(url)) states.set(url, { latest: null, closed: false, frames: [], isOpen: false });
      return states.get(url);
    },
  };
});

vi.mock('../services/apiMusicVideo.js', () => ({
  listMusicVideoProjects: vi.fn(async () => []),
  createMusicVideoProject: vi.fn(),
  updateMusicVideoProject: vi.fn(async (id, patch) => ({ id, ...patch })),
  deleteMusicVideoProject: vi.fn(),
  analyzeMusicVideoProject: vi.fn(),
  planMusicVideoProject: vi.fn(),
  addMusicVideoScene: vi.fn(),
  updateMusicVideoScene: vi.fn(),
  deleteMusicVideoScene: vi.fn(),
  reorderMusicVideoScenes: vi.fn(),
  renderMusicVideoProject: vi.fn(async () => ({ jobId: 'job-1' })),
  musicVideoRenderEventsUrl: (jobId) => `/api/music-video/render/${jobId}/events`,
  cancelMusicVideoRender: vi.fn(async () => ({ ok: true })),
  transcribeMusicVideoMidi: vi.fn(async () => ({ jobId: 'midi-job-1', model: 'medium' })),
  musicVideoMidiEventsUrl: (jobId) => `/api/music-video/transcribe-midi/${jobId}/events`,
  cancelMusicVideoMidiTranscription: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../services/apiSystem.js', () => ({ generateImage: vi.fn() }));
vi.mock('../services/apiImageVideo.js', () => ({ generateVideo: vi.fn() }));
vi.mock('../services/apiTracks.js', () => ({
  listTracks: vi.fn(async () => []),
  trackAudioUrl: (filename) => `/data/music/${encodeURIComponent(filename)}`,
  importTrackFromYoutube: vi.fn(async () => ({ jobId: 'yt-job-1' })),
  trackImportEventsUrl: (jobId) => `/api/tracks/import/${jobId}/events`,
  cancelTrackImport: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../hooks/useSceneRenderLifecycle.js', () => ({
  default: () => ({ genScenes: {}, startScene: vi.fn(), clearScene: vi.fn(), trackJob: vi.fn() }),
}));
const TERMINAL_TYPES = new Set(['complete', 'canceled', 'cancelled', 'error']);
vi.mock('../hooks/useSseProgress.js', () => ({
  useSseProgress: (url) => {
    if (!url) return { latest: null, closed: false, frames: [], isOpen: false };
    return url.includes('/tracks/import/') ? getYtSseState(url) : sseState;
  },
  isTerminalSseFrame: (frame) => TERMINAL_TYPES.has(frame?.type),
}));
vi.mock('../components/ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../components/PageHeader', () => ({ default: ({ title }) => <div>{title}</div> }));

import MusicVideo from './MusicVideo.jsx';
import {
  listMusicVideoProjects, createMusicVideoProject, renderMusicVideoProject, planMusicVideoProject, updateMusicVideoProject,
  deleteMusicVideoProject, transcribeMusicVideoMidi,
} from '../services/apiMusicVideo.js';
import { importTrackFromYoutube, trackImportEventsUrl, listTracks } from '../services/apiTracks.js';

const PROJECT_ANALYZED = {
  ...PROJECT_NO_CLIP,
  id: 'mv-3',
  name: 'Analyzed Track',
  audioAnalysis: { bpm: 120, beats: [], downbeats: [], sections: [{ label: 'Intro', startSec: 0, endSec: 10, energy: 0.5 }], durationSec: 10 },
};

// The page now selects the open project via the route param
// (/media/music-video/:projectId), so tests render it inside a router that
// serves the same component at both the index and the :projectId route —
// clicking a project navigates to its id'd URL, and the component re-reads
// useParams() to open its board (no remount: both routes render the same
// component type, so React preserves the instance across the param change).
const renderMV = () => render(
  <MemoryRouter initialEntries={['/media/music-video']}>
    <Routes>
      <Route path="/media/music-video" element={<MusicVideo />} />
      <Route path="/media/music-video/:projectId" element={<MusicVideo />} />
    </Routes>
  </MemoryRouter>,
);

const openProject = async (project) => {
  listMusicVideoProjects.mockResolvedValue([project]);
  renderMV();
  // Project list button appears, then select it to open the board.
  const btn = await screen.findByRole('button', { name: new RegExp(project.name) });
  fireEvent.click(btn);
};

// Probes/harness for the URL-nav backstop test: a location readout plus a
// button that navigates via the router (standing in for a deep link / browser
// Back / ⌘K jump, which bypass the in-app selectProject guard).
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}
function NavTo({ to }) {
  const navigate = useNavigate();
  return <button onClick={() => navigate(to)}>{`go-${to}`}</button>;
}
const renderMVWithNav = (to) => render(
  <MemoryRouter initialEntries={['/media/music-video']}>
    <LocationProbe />
    <NavTo to={to} />
    <Routes>
      <Route path="/media/music-video" element={<MusicVideo />} />
      <Route path="/media/music-video/:projectId" element={<MusicVideo />} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  sseState.latest = null;
  sseState.closed = false;
  ytSseStates.clear();
});

describe('MusicVideo render control (#1760)', () => {
  it('enables Render and kicks off the job when a scene has a clip', async () => {
    await openProject(PROJECT_WITH_CLIP);
    const renderBtn = await screen.findByRole('button', { name: /^Render$/ });
    expect(renderBtn).toHaveProperty('disabled', false);

    fireEvent.click(renderBtn);
    await waitFor(() => expect(renderMusicVideoProject).toHaveBeenCalledWith('mv-1', { silent: true }));
  });

  it('disables Render when no scene has a generated clip', async () => {
    await openProject(PROJECT_NO_CLIP);
    const renderBtn = await screen.findByRole('button', { name: /^Render$/ });
    expect(renderBtn).toHaveProperty('disabled', true);
  });

  it('shows the rendered-video link once a project carries a renderHistoryId', async () => {
    await openProject({ ...PROJECT_WITH_CLIP, renderHistoryId: 'rh-9' });
    const link = await screen.findByText(/View rendered music video/i);
    // Media History matches video items by their `video:<id>` key via ?preview=.
    expect(link.closest('a').getAttribute('href')).toContain('preview=video%3Arh-9');
  });
});

describe('MusicVideo audio preview + download', () => {
  it('shows preview player + download link for a linked track', async () => {
    listTracks.mockResolvedValue([{ id: 't1', title: 'Neon Song', audioFilename: 'neon song.mp3' }]);
    await openProject(PROJECT_WITH_CLIP);
    const player = await screen.findByLabelText('Preview track audio');
    expect(player.getAttribute('src')).toBe('/data/music/neon%20song.mp3');
    const dl = screen.getByRole('link', { name: /Download audio/i });
    expect(dl.getAttribute('href')).toBe('/data/music/neon%20song.mp3');
    expect(dl.getAttribute('download')).toBe('neon song.mp3');
  });

  it('falls back to the project uploaded-audio file when there is no linked track', async () => {
    await openProject({ ...PROJECT_WITH_CLIP, trackId: null, uploadedAudioFilename: 'upload.wav' });
    const player = await screen.findByLabelText('Preview track audio');
    expect(player.getAttribute('src')).toBe('/data/music/upload.wav');
  });

  it('renders no audio controls when the project has no audio', async () => {
    await openProject({ ...PROJECT_WITH_CLIP, trackId: null, uploadedAudioFilename: null });
    // Board opened (Render button present) but no audio surface.
    await screen.findByRole('button', { name: /^Render$/ });
    expect(screen.queryByLabelText('Preview track audio')).toBeNull();
    expect(screen.queryByRole('link', { name: /Download audio/i })).toBeNull();
  });
});

describe('MusicVideo audio → MIDI transcription (MuScriptor)', () => {
  it('disables the MIDI button when the project has no audio source', async () => {
    await openProject({ ...PROJECT_WITH_CLIP, trackId: null, uploadedAudioFilename: null });
    const btn = await screen.findByRole('button', { name: /^MIDI$/ });
    expect(btn).toHaveProperty('disabled', true);
  });

  it('kicks off a transcription for the selected project', async () => {
    await openProject(PROJECT_WITH_CLIP);
    const btn = await screen.findByRole('button', { name: /^MIDI$/ });
    expect(btn).toHaveProperty('disabled', false);
    fireEvent.click(btn);
    await waitFor(() => expect(transcribeMusicVideoMidi).toHaveBeenCalledWith('mv-1', {}, { silent: true }));
  });

  it('shows the MIDI download link once the project carries a transcription pointer', async () => {
    listTracks.mockResolvedValue([{ id: 't1', title: 'Neon Song', audioFilename: 'neon.mp3' }]);
    await openProject({ ...PROJECT_WITH_CLIP, midiTranscription: { filename: 'neon-midi.mid', model: 'medium' } });
    const dl = await screen.findByRole('link', { name: /Download MIDI/i });
    // Served from the music dir (same static route as the master audio) so the
    // federated .mid resolves on peers too.
    expect(dl.getAttribute('href')).toBe('/data/music/neon-midi.mid');
  });
});

describe('MusicVideo autonomous shot planner (#1855)', () => {
  it('disables AI Plan until the track is analyzed', async () => {
    await openProject(PROJECT_NO_CLIP);
    const planBtn = await screen.findByRole('button', { name: /AI Plan/i });
    expect(planBtn).toHaveProperty('disabled', true);
  });

  it('calls the planner and replaces the project on success', async () => {
    const plannedProject = { ...PROJECT_ANALYZED, scenes: [{ sceneId: 's1', order: 0, prompt: 'p' }] };
    planMusicVideoProject.mockResolvedValue({ project: plannedProject, scenesAdded: 1, promptsSeeded: false, promptsSkippedReason: 'no-provider' });

    await openProject(PROJECT_ANALYZED);
    const planBtn = await screen.findByRole('button', { name: /AI Plan/i });
    expect(planBtn).toHaveProperty('disabled', false);

    fireEvent.click(planBtn);
    await waitFor(() => expect(planMusicVideoProject).toHaveBeenCalledWith('mv-3', { seedPrompts: true }));
  });
});

describe('MusicVideo YouTube audio import (#1945)', () => {
  it('starts an import from the detail view and attaches the finished track to the project', async () => {
    await openProject(PROJECT_NO_CLIP);
    // Two matches now (create form + detail-view row share the same
    // placeholder/aria-label) — the create form's carries the `mv-yt-create`
    // id, so the other one is the detail view's.
    const urlInput = screen.getAllByPlaceholderText(/Import audio from a YouTube URL/i)
      .find((el) => el.id !== 'mv-yt-create');
    fireEvent.change(urlInput, { target: { value: 'https://youtu.be/dQw4w9WgXcQ' } });
    const row = urlInput.closest('div');
    fireEvent.click(within(row).getByRole('button', { name: /Import/i }));
    await waitFor(() => expect(importTrackFromYoutube).toHaveBeenCalledWith('https://youtu.be/dQw4w9WgXcQ', { silent: true }));

    // Simulate the SSE terminal frame the job's kickoff subscribed to. The mock
    // hook returns a plain mutable object (not real React state), so mutating
    // it alone doesn't trigger a re-render — nudge one via an unrelated input
    // so the component re-reads the hook and its effect dependency changes.
    const url = trackImportEventsUrl('yt-job-1');
    getYtSseState(url).latest = {
      type: 'complete', trackId: 'track-yt-1', track: { id: 'track-yt-1', title: 'Imported Song' },
    };
    fireEvent.change(screen.getByPlaceholderText('Project name'), { target: { value: 'x' } });
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith('mv-2', { trackId: 'track-yt-1' }, { silent: true }));
  });

  it('disables the Import button until a URL is entered', async () => {
    await openProject(PROJECT_NO_CLIP);
    const importBtns = screen.getAllByRole('button', { name: /Import/i });
    importBtns.forEach((btn) => expect(btn).toHaveProperty('disabled', true));
  });

  it('running the create-form and detail-view imports at once does not orphan either job', async () => {
    await openProject(PROJECT_NO_CLIP);
    importTrackFromYoutube
      .mockResolvedValueOnce({ jobId: 'yt-job-create' })
      .mockResolvedValueOnce({ jobId: 'yt-job-edit' });

    const inputs = screen.getAllByPlaceholderText(/Import audio from a YouTube URL/i);
    const createInput = inputs.find((el) => el.id === 'mv-yt-create');
    const editInput = inputs.find((el) => el.id !== 'mv-yt-create');

    fireEvent.change(createInput, { target: { value: 'https://youtu.be/create111' } });
    fireEvent.click(within(createInput.closest('div')).getByRole('button', { name: /Import/i }));
    await waitFor(() => expect(importTrackFromYoutube).toHaveBeenCalledWith('https://youtu.be/create111', { silent: true }));

    fireEvent.change(editInput, { target: { value: 'https://youtu.be/edit222' } });
    fireEvent.click(within(editInput.closest('div')).getByRole('button', { name: /Import/i }));
    await waitFor(() => expect(importTrackFromYoutube).toHaveBeenCalledWith('https://youtu.be/edit222', { silent: true }));

    // Both slots must independently show themselves as in-flight — a shared
    // slot would have the second kickoff silently take over the first's spot.
    const cancelBtns = screen.getAllByRole('button', { name: /%$/ });
    expect(cancelBtns).toHaveLength(2);

    // Completing the EDIT job must attach to the project without disturbing
    // the still-in-flight CREATE job.
    getYtSseState(trackImportEventsUrl('yt-job-edit')).latest = {
      type: 'complete', trackId: 'track-edit', track: { id: 'track-edit', title: 'Edit Track' },
    };
    fireEvent.change(screen.getByPlaceholderText('Project name'), { target: { value: 'x' } });
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith('mv-2', { trackId: 'track-edit' }, { silent: true }));
    // The create-form job is still running — its Cancel/percent button remains.
    expect(screen.getAllByRole('button', { name: /%$/ })).toHaveLength(1);

    // Completing the CREATE job independently attaches to the form.
    getYtSseState(trackImportEventsUrl('yt-job-create')).latest = {
      type: 'complete', trackId: 'track-create', track: { id: 'track-create', title: 'Create Track' },
    };
    fireEvent.change(screen.getByPlaceholderText('Project name'), { target: { value: 'y' } });
    await waitFor(() => expect(screen.getByText(/Track set: Create Track/i)).toBeTruthy());
  });

  it('blocks switching projects while the detail-view import is in flight (single shared job slot)', async () => {
    const projectB = { ...PROJECT_NO_CLIP, id: 'mv-3', name: 'Other Project' };
    listMusicVideoProjects.mockResolvedValue([PROJECT_NO_CLIP, projectB]);
    renderMV();
    const listBtnA = await screen.findByRole('button', { name: new RegExp(PROJECT_NO_CLIP.name) });
    fireEvent.click(listBtnA);

    const editInput = screen.getAllByPlaceholderText(/Import audio from a YouTube URL/i)
      .find((el) => el.id !== 'mv-yt-create');
    fireEvent.change(editInput, { target: { value: 'https://youtu.be/xyz' } });
    fireEvent.click(within(editInput.closest('div')).getByRole('button', { name: /Import/i }));
    await waitFor(() => expect(importTrackFromYoutube).toHaveBeenCalled());

    // Switching to the OTHER project while this one's import is in flight
    // must be blocked — it would silently orphan the in-flight job's SSE
    // subscription and misattribute its progress UI to the new selection.
    fireEvent.click(screen.getByRole('button', { name: new RegExp(projectB.name) }));
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/before switching projects/i));
    expect(listBtnA).toHaveClass('border-port-accent');
  });

  it('bounces URL-driven navigation (deep link / Back / ⌘K) away from a project with an in-flight import back to it', async () => {
    listMusicVideoProjects.mockResolvedValue([PROJECT_NO_CLIP]); // mv-2
    renderMVWithNav('/media/music-video/mv-3');
    // Open mv-2 and start its detail-view import.
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(PROJECT_NO_CLIP.name) }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/media/music-video/mv-2'));
    const editInput = screen.getAllByPlaceholderText(/Import audio from a YouTube URL/i)
      .find((el) => el.id !== 'mv-yt-create');
    fireEvent.change(editInput, { target: { value: 'https://youtu.be/xyz' } });
    fireEvent.click(within(editInput.closest('div')).getByRole('button', { name: /Import/i }));
    await waitFor(() => expect(importTrackFromYoutube).toHaveBeenCalled());

    // A router-driven jump to another project (not via the list buttons, so it
    // bypasses selectProject's guard) must be bounced back to the import's
    // project with the same guard message.
    fireEvent.click(screen.getByRole('button', { name: 'go-/media/music-video/mv-3' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/before switching projects/i)));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/media/music-video/mv-2'));
  });

  it('blocks deleting the selected project while its import is in flight', async () => {
    await openProject(PROJECT_NO_CLIP);
    const editInput = screen.getAllByPlaceholderText(/Import audio from a YouTube URL/i)
      .find((el) => el.id !== 'mv-yt-create');
    fireEvent.change(editInput, { target: { value: 'https://youtu.be/xyz' } });
    fireEvent.click(within(editInput.closest('div')).getByRole('button', { name: /Import/i }));
    await waitFor(() => expect(importTrackFromYoutube).toHaveBeenCalled());

    fireEvent.click(screen.getByTitle('Delete project'));
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/before deleting this project/i));
    expect(deleteMusicVideoProject).not.toHaveBeenCalled();
  });

  it('pressing Enter in the create-form URL input starts the import instead of submitting the form', async () => {
    listMusicVideoProjects.mockResolvedValue([]);
    renderMV();
    const createInput = await screen.findByPlaceholderText(/Import audio from a YouTube URL/i);
    fireEvent.change(createInput, { target: { value: 'https://youtu.be/enterkey' } });
    fireEvent.keyDown(createInput, { key: 'Enter' });
    await waitFor(() => expect(importTrackFromYoutube).toHaveBeenCalledWith('https://youtu.be/enterkey', { silent: true }));
    expect(createMusicVideoProject).not.toHaveBeenCalled();
  });

  it('ignores a second Import click while the first kickoff request is still in flight', async () => {
    listMusicVideoProjects.mockResolvedValue([]);
    let resolveKickoff;
    importTrackFromYoutube.mockImplementation(() => new Promise((resolve) => { resolveKickoff = resolve; }));
    renderMV();
    const createInput = await screen.findByPlaceholderText(/Import audio from a YouTube URL/i);
    fireEvent.change(createInput, { target: { value: 'https://youtu.be/doubleclick' } });
    const importBtn = within(createInput.closest('div')).getByRole('button', { name: /Import/i });
    fireEvent.click(importBtn);
    fireEvent.click(importBtn); // fires before the first request resolves
    resolveKickoff({ jobId: 'yt-job-1' });
    await waitFor(() => expect(importTrackFromYoutube).toHaveBeenCalledTimes(1));
  });

  it('blocks switching projects during the pending kickoff window, before the job even exists', async () => {
    const projectB = { ...PROJECT_NO_CLIP, id: 'mv-3', name: 'Other Project' };
    listMusicVideoProjects.mockResolvedValue([PROJECT_NO_CLIP, projectB]);
    let resolveKickoff;
    importTrackFromYoutube.mockImplementation(() => new Promise((resolve) => { resolveKickoff = resolve; }));
    renderMV();
    const listBtnA = await screen.findByRole('button', { name: new RegExp(PROJECT_NO_CLIP.name) });
    fireEvent.click(listBtnA);

    const editInput = screen.getAllByPlaceholderText(/Import audio from a YouTube URL/i)
      .find((el) => el.id !== 'mv-yt-create');
    fireEvent.change(editInput, { target: { value: 'https://youtu.be/pending' } });
    fireEvent.click(within(editInput.closest('div')).getByRole('button', { name: /Import/i }));
    // The kickoff POST has NOT resolved yet — no jobId, no SSE subscription —
    // but switching away must already be blocked, or this project's import
    // would attach with nobody listening once it lands.
    expect(importTrackFromYoutube).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: new RegExp(projectB.name) }));
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/before switching projects/i));
    expect(listBtnA).toHaveClass('border-port-accent');

    resolveKickoff({ jobId: 'yt-job-pending' });
  });

  it('blocks creating the project while the create-form YouTube import is in flight', async () => {
    listMusicVideoProjects.mockResolvedValue([]);
    renderMV();
    const nameInput = await screen.findByPlaceholderText('Project name');
    fireEvent.change(nameInput, { target: { value: 'New MV' } });
    const createInput = screen.getAllByPlaceholderText(/Import audio from a YouTube URL/i)
      .find((el) => el.id === 'mv-yt-create');
    fireEvent.change(createInput, { target: { value: 'https://youtu.be/xyz' } });
    fireEvent.click(within(createInput.closest('div')).getByRole('button', { name: /Import/i }));
    await waitFor(() => expect(importTrackFromYoutube).toHaveBeenCalled());

    const createBtn = screen.getByRole('button', { name: /^Create$/ });
    expect(createBtn).toHaveProperty('disabled', true);
    fireEvent.click(createBtn);
    expect(createMusicVideoProject).not.toHaveBeenCalled();
  });

  it('blocks relinking the track while a render is in progress for the selected project', async () => {
    await openProject(PROJECT_WITH_CLIP);
    fireEvent.click(await screen.findByRole('button', { name: /^Render$/ }));
    await waitFor(() => expect(renderMusicVideoProject).toHaveBeenCalled());

    const trackSelect = screen.getByLabelText('Change track');
    expect(trackSelect).toHaveProperty('disabled', true);
    fireEvent.change(trackSelect, { target: { value: 'other-track' } });
    expect(updateMusicVideoProject).not.toHaveBeenCalled();

    const editInput = screen.getAllByPlaceholderText(/Import audio from a YouTube URL/i)
      .find((el) => el.id !== 'mv-yt-create');
    expect(editInput).toHaveProperty('disabled', true);
  });
});
