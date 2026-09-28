/**
 * Focused tests for the music-video Render control (#1760 Phase 2): the button
 * gates on a scene having a generated clip, and clicking it kicks off the render.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import { findEnabledByRole } from '../test/enabledBarrier.js';
import { MemoryRouter, Routes, Route, useNavigate, useLocation } from 'react-router';
import toast from '../components/ui/Toast';

const PROJECT_WITH_CLIP = {
  id: 'mv-1', name: 'Neon Run', mode: 'director', status: 'ready',
  trackId: 't1', uploadedAudioFilename: null, audioAnalysis: null, renderHistoryId: null,
  videoSettings: { backend: 'local' },
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
  cloneMusicVideoProject: vi.fn(),
  updateMusicVideoProject: vi.fn(async (id, patch) => ({
    id,
    ...patch,
    ...(patch.videoSettings ? { videoSettings: { backend: 'local', ...patch.videoSettings } } : {}),
  })),
  deleteMusicVideoProject: vi.fn(),
  analyzeMusicVideoProject: vi.fn(),
  planMusicVideoProject: vi.fn(),
  addMusicVideoScene: vi.fn(),
  updateMusicVideoScene: vi.fn(),
  deleteMusicVideoScene: vi.fn(),
  reorderMusicVideoScenes: vi.fn(),
  splitMusicVideoScene: vi.fn(),
  importMusicVideoLyrics: vi.fn(),
  alignMusicVideoLyrics: vi.fn(),
  renderMusicVideoProject: vi.fn(async () => ({ jobId: 'job-1' })),
  musicVideoRenderEventsUrl: (jobId) => `/api/music-video/render/${jobId}/events`,
  cancelMusicVideoRender: vi.fn(async () => ({ ok: true })),
  transcribeMusicVideoMidi: vi.fn(async () => ({ jobId: 'midi-job-1', model: 'medium' })),
  musicVideoMidiEventsUrl: (jobId) => `/api/music-video/transcribe-midi/${jobId}/events`,
  cancelMusicVideoMidiTranscription: vi.fn(async () => ({ ok: true })),
  addMusicVideoSceneTake: vi.fn(),
  selectMusicVideoSceneTake: vi.fn(),
  reviewMusicVideoSceneTake: vi.fn(),
  getMusicVideoHandoff: vi.fn(),
  getMusicVideoHandoffBundle: vi.fn(),
  importMusicVideoHandoff: vi.fn(),
  getMusicVideoProject: vi.fn(),
  updateMusicVideoTreatment: vi.fn(),
  compileMusicVideoTreatment: vi.fn(),
  previewMusicVideoTreatmentApply: vi.fn(),
  applyMusicVideoTreatment: vi.fn(),
  reviewMusicVideoTreatmentProof: vi.fn(),
  renderMusicVideoExcerpt: vi.fn(async () => ({ jobId: 'mve-job-1', excerptId: 'mve-job-1' })),
  musicVideoExcerptRenderEventsUrl: (jobId) => `/api/music-video/excerpt/${jobId}/events`,
  cancelMusicVideoExcerptRender: vi.fn(async () => ({ ok: true })),
  deleteMusicVideoExcerpt: vi.fn(),
  addMusicVideoExcerptNote: vi.fn(),
  updateMusicVideoExcerptNote: vi.fn(),
  deleteMusicVideoExcerptNote: vi.fn(),
  startMusicVideoRevision: vi.fn(),
  resumeMusicVideoRevision: vi.fn(),
  cancelMusicVideoRevision: vi.fn(),
  getMusicVideoCodeDocument: vi.fn(async () => ({ html: '<!doctype html><html><body></body></html>', durationSec: 2, fps: 24, width: 1280, height: 720, song: { sections: [] }, timeline: { sections: [] } })),
  generateMusicVideoCode: vi.fn(),
  regenerateMusicVideoCodeSection: vi.fn(),
}));
vi.mock('../services/apiUniverseBuilder.js', () => ({ getUniverse: vi.fn(), listUniverseNames: vi.fn(() => Promise.resolve([])) }));
vi.mock('../lib/downloadBlob.js', () => ({ downloadBlob: vi.fn() }));
vi.mock('../services/apiSystem.js', () => ({ generateImage: vi.fn(), uploadGalleryImage: vi.fn() }));
vi.mock('../hooks/useProviderModels', () => ({
  default: () => ({
    providers: [], selectedProviderId: '', selectedModel: '', availableModels: [],
    setSelectedProviderId: vi.fn(), setSelectedModel: vi.fn(), loading: false,
  }),
}));
// MIDI loading/parsing is covered by useMidiNotes; this page checks the link.
vi.mock('../hooks/useMidiNotes.js', () => ({
  default: () => ({ status: 'idle', data: null, error: null, reload: vi.fn() }),
}));
vi.mock('../services/apiImageVideo.js', () => ({
  generateVideo: vi.fn(),
  uploadGalleryVideo: vi.fn(),
  listLorasFull: vi.fn(async () => [{
    filename: 'audio-reactive.safetensors',
    name: 'Audio Reactive',
    loraCompatKey: 'ltx-video',
    recommendedScale: 1.2,
  }, {
    filename: 'audio-reactive-v2.safetensors',
    name: 'Audio Reactive V2',
    loraCompatKey: 'ltx-video',
    recommendedScale: 1.2,
  }]),
  getVideoGenStatus: vi.fn(async () => ({
    connected: true,
    defaultModel: 'ltx23_distilled_q4',
    models: [
      { id: 'ltx23_distilled_q4', name: 'LTX-2.3 Distilled Q4', runtime: 'ltx2' },
      { id: 'wan22_t2v_a14b', name: 'Wan T2V', mode: 't2v' },
    ],
  })),
  listVideoHistory: vi.fn(async () => [{ id: 'rh-9', filename: 'final.mp4' }]),
  // Sidecar lookup behind useHydratedPreviewRoute: the board's scene prompt is
  // only a label — `useMusicVideoSceneMedia` suffixes `concept.style` onto it
  // before rendering, so only the sidecar knows what the renderer was sent.
  getGalleryImages: vi.fn(async (filenames) => (filenames.includes('img1')
    ? [{ filename: 'img1', prompt: 'a wide desert shot, neon noir', seed: 7, cleanedFrom: 'img0' }]
    : [])),
  // By-id resolver behind useVideoFileSrc (#4165) — 404s (rejects) for any
  // other id, exactly as the real endpoint does.
  getVideoHistoryItem: vi.fn(async (id) => (id === 'rh-9'
    ? { id: 'rh-9', filename: 'final.mp4' }
    : Promise.reject(Object.assign(new Error('Not found'), { status: 404 })))),
  // Scene refs are a projection, so the lightbox resolves variant lineage and
  // any variant it opens through the gallery rather than this page's list.
  listImageVariants: vi.fn(async () => ({ items: [] })),
  listMediaGalleryPage: vi.fn(async () => ({ items: [] })),
}));
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
vi.mock('../components/PageHeader', () => ({ default: ({ title, actions }) => <div>{title}{actions}</div> }));

import MusicVideo from './MusicVideo.jsx';
import {
  listMusicVideoProjects, createMusicVideoProject, cloneMusicVideoProject, renderMusicVideoProject, planMusicVideoProject, updateMusicVideoProject,
  deleteMusicVideoProject, transcribeMusicVideoMidi, cancelMusicVideoRender, analyzeMusicVideoProject,
  importMusicVideoLyrics, alignMusicVideoLyrics, updateMusicVideoScene, splitMusicVideoScene,
  selectMusicVideoSceneTake, reviewMusicVideoSceneTake, importMusicVideoHandoff,
  addMusicVideoSceneTake, getMusicVideoHandoffBundle,
  renderMusicVideoExcerpt, deleteMusicVideoExcerpt, addMusicVideoExcerptNote,
  updateMusicVideoExcerptNote, deleteMusicVideoExcerptNote, getMusicVideoProject,
  startMusicVideoRevision, resumeMusicVideoRevision, cancelMusicVideoRevision,
} from '../services/apiMusicVideo.js';
import { generateImage, uploadGalleryImage } from '../services/apiSystem.js';
import { importTrackFromYoutube, trackImportEventsUrl, listTracks } from '../services/apiTracks.js';
import { generateVideo, getVideoGenStatus, getVideoHistoryItem } from '../services/apiImageVideo.js';
import { getUniverse } from '../services/apiUniverseBuilder.js';
import { downloadBlob } from '../lib/downloadBlob.js';

const PROJECT_ANALYZED = {
  ...PROJECT_NO_CLIP,
  id: 'mv-3',
  name: 'Analyzed Track',
  audioAnalysis: {
    bpm: 120,
    beats: [0, 0.5, 1, 1.5],
    downbeats: [0],
    waveform: [0.1, 0.4, 1, 0.6, 0.2],
    sections: [{ label: 'Intro', startSec: 0, endSec: 10, energy: 0.5 }],
    durationSec: 10,
    tempoSource: 'windowed',
    tempoConfidence: 0.72,
    tempoWindow: { startSec: 40, endSec: 70 },
  },
};

// The page now selects the open project via the route param
// (/music-video/:projectId), so tests render it inside a router that
// serves the same component at both the index and the :projectId route —
// clicking a project navigates to its id'd URL, and the component re-reads
// useParams() to open its board (no remount: both routes render the same
// component type, so React preserves the instance across the param change).
const renderMV = () => render(
  <MemoryRouter initialEntries={['/music-video']}>
    <Routes>
      <Route path="/music-video" element={<MusicVideo />} />
      <Route path="/music-video/:projectId" element={<MusicVideo />} />
    </Routes>
  </MemoryRouter>,
);

// Flush pending pre-resolved mock promises inside act so their .then setState
// callbacks can't land outside it after the test body.
const settle = () => act(async () => {});

// The picker renders disabled before the project-list promise settles. Waiting
// only for the select itself races that loading state under CI contention: a
// change fired against the disabled picker can be ignored, leaving the board
// unopened. Wait for both the enabled state and the requested option before
// navigating, then confirm the route-driven selection landed.
const selectProject = async (projectId) => {
  const picker = await screen.findByLabelText('Project');
  await waitFor(() => {
    expect(picker).toHaveProperty('disabled', false);
    expect(Array.from(picker.options, (option) => option.value)).toContain(projectId);
  });
  await act(async () => {
    fireEvent.change(picker, { target: { value: projectId } });
  });
  await waitFor(() => expect(picker).toHaveValue(projectId));
  return picker;
};

const openProject = async (project) => {
  listMusicVideoProjects.mockResolvedValue([project]);
  renderMV();
  await selectProject(project.id);
  await screen.findByRole('heading', { level: 2, name: project.name });
};

const openCreateForm = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /New project/i }));
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
  <MemoryRouter initialEntries={['/music-video']}>
    <LocationProbe />
    <NavTo to={to} />
    <Routes>
      <Route path="/music-video" element={<MusicVideo />} />
      <Route path="/music-video/:projectId" element={<MusicVideo />} />
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
    const renderBtn = await screen.findByRole('button', { name: /^Render final$/ });
    expect(renderBtn).toHaveProperty('disabled', false);

    fireEvent.click(renderBtn);
    await waitFor(() => expect(renderMusicVideoProject).toHaveBeenCalledWith('mv-1', { silent: true }));
  });

  it('reserves preparation across project navigation and applies completion to the captured project', async () => {
    const other = { ...PROJECT_WITH_CLIP, id: 'mv-other', name: 'Other Project' };
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP, other]);
    let resolveKickoff;
    renderMusicVideoProject.mockImplementationOnce(() => new Promise((resolve) => { resolveKickoff = resolve; }));
    renderMV();
    await selectProject(PROJECT_WITH_CLIP.id);

    fireEvent.click(screen.getByRole('button', { name: /^Render final$/ }));
    expect(screen.getByRole('button', { name: 'Preparing render…' })).toBeDisabled();
    expect(screen.getByLabelText('Change track')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Change track'), { target: { value: 'other-track' } });
    expect(updateMusicVideoProject).not.toHaveBeenCalled();

    await selectProject(other.id);
    const otherRender = screen.getByRole('button', { name: 'Rendering another project…' });
    expect(otherRender).toBeDisabled();
    fireEvent.click(otherRender);
    expect(renderMusicVideoProject).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Change track')).not.toBeDisabled();
    expect(screen.queryByTitle('Cancel render')).not.toBeInTheDocument();

    await act(async () => { resolveKickoff({ jobId: 'render-first' }); });
    sseState.latest = { type: 'progress', progress: 0.375 };
    await selectProject(PROJECT_WITH_CLIP.id);
    expect(screen.getByTitle('Cancel render')).toHaveTextContent('38%');
    expect(screen.getByLabelText('Change track')).toBeDisabled();

    // A metadata frame omits progress; the final-render adapter keeps 38%.
    sseState.latest = { type: 'status', message: 'Finishing output' };
    fireEvent.click(screen.getByRole('button', { name: /New project/i }));
    expect(screen.getByTitle('Cancel render')).toHaveTextContent('38%');
    await selectProject(other.id);
    sseState.latest = { type: 'complete', result: { id: 'rh-9' } };
    fireEvent.change(screen.getByPlaceholderText('Project name'), { target: { value: 'Unrelated draft' } });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Music video rendered'));
    expect(screen.queryByText(/Open in Media History/i)).not.toBeInTheDocument();
    await selectProject(PROJECT_WITH_CLIP.id);
    expect(screen.getByText(/Open in Media History/i).closest('a')).toHaveAttribute('href', expect.stringContaining('preview=video%3Arh-9'));
  });

  it('recovers from a preparing 409 and attaches/cancels an existing render with a job id', async () => {
    renderMusicVideoProject
      .mockRejectedValueOnce(Object.assign(new Error('Render is still preparing'), { status: 409, context: { jobId: null } }))
      .mockRejectedValueOnce(Object.assign(new Error('Render already exists'), { status: 409, context: { jobId: 'existing-render' } }));
    await openProject(PROJECT_WITH_CLIP);
    fireEvent.click(screen.getByRole('button', { name: /^Render final$/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Render is still preparing'));
    expect(screen.getByRole('button', { name: /^Render final$/ })).toBeEnabled();
    expect(screen.getByLabelText('Change track')).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: /^Render final$/ }));
    fireEvent.click(await screen.findByTitle('Cancel render'));
    expect(cancelMusicVideoRender).toHaveBeenCalledWith('existing-render', { silent: true });
    expect(toast.error).toHaveBeenCalledTimes(1);
    sseState.latest = { type: 'canceled' };
    fireEvent.click(screen.getByRole('button', { name: /New project/i }));
    expect(toast.info).toHaveBeenCalledWith('Render cancelled');
    expect(screen.getByRole('button', { name: /^Render final$/ })).toBeEnabled();
  });

  it('attributes a render failure after navigation and releases the slot after a dropped stream', async () => {
    const other = { ...PROJECT_WITH_CLIP, id: 'mv-other', name: 'Other Project' };
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP, other]);
    renderMV();
    await selectProject(PROJECT_WITH_CLIP.id);
    fireEvent.click(screen.getByRole('button', { name: /^Render final$/ }));
    await screen.findByTitle('Cancel render');
    await selectProject(other.id);
    sseState.latest = { type: 'error', error: 'Renderer stopped' };
    fireEvent.click(screen.getByRole('button', { name: /New project/i }));
    expect(toast.error).toHaveBeenCalledWith('Renderer stopped');
    expect(screen.getByLabelText('Project').querySelector('option[value="mv-1"]')).toHaveTextContent('failed');
    expect(screen.getByLabelText('Project').querySelector('option[value="mv-other"]')).toHaveTextContent('ready');

    sseState.latest = null;
    fireEvent.click(screen.getByRole('button', { name: /^Render final$/ }));
    await screen.findByTitle('Cancel render');
    sseState.latest = { type: 'progress', progress: 0.4 };
    fireEvent.change(screen.getByPlaceholderText('Project name'), { target: { value: 'Draft' } });
    sseState.closed = true;
    fireEvent.change(screen.getByPlaceholderText('Project name'), { target: { value: 'Draft updated' } });
    expect(toast.info).toHaveBeenCalledWith('Lost connection to the render — check Media History for the result');
    expect(screen.getByRole('button', { name: /^Render final$/ })).toBeEnabled();
  });

  it('disables Render when no scene has a generated clip', async () => {
    await openProject(PROJECT_NO_CLIP);
    const renderBtn = await screen.findByRole('button', { name: /^Render final$/ });
    expect(renderBtn).toHaveProperty('disabled', true);
  });

  it('shows the rendered-video link once a project carries a renderHistoryId', async () => {
    await openProject({ ...PROJECT_WITH_CLIP, renderHistoryId: 'rh-9' });
    await screen.findByText(/Download MP4/i);
    const link = await screen.findByText(/Open in Media History/i);
    // Media History matches video items by their `video:<id>` key via ?preview=.
    expect(link.closest('a').getAttribute('href')).toContain('preview=video%3Arh-9');
  });
});

describe('MusicVideo draft excerpt render (#8986)', () => {
  it('kicks off an excerpt render with the typed range and shows progress', async () => {
    await openProject(PROJECT_WITH_CLIP);
    fireEvent.change(screen.getByLabelText('Start (sec)'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('End (sec)'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: /Render excerpt/i }));
    await waitFor(() => expect(renderMusicVideoExcerpt).toHaveBeenCalledWith('mv-1', { startSec: 10, endSec: 20 }, { silent: true }));
    await settle(); // let the resolved kickoff's jobId land before feeding the SSE frame

    sseState.latest = { type: 'progress', progress: 0.5 };
    // The mocked useSseProgress hook returns the shared, directly-mutated
    // `sseState` object rather than its own React state, so nothing re-renders
    // the component until something else does — force one (mirrors the
    // existing render-job tests' use of this same mock).
    fireEvent.click(screen.getByRole('button', { name: /New project/i }));
    await screen.findByText(/Rendering excerpt — 50%/);
  });

  it('reloads the project on a completed excerpt render and shows the player + contact sheet + notes', async () => {
    getMusicVideoProject.mockResolvedValue({
      ...PROJECT_WITH_CLIP,
      excerpts: [{
        id: 'mve-1', startSec: 10, endSec: 20, status: 'complete',
        filename: 'excerpt-1.mp4', contactSheetFilename: 'excerpt-1-sheet.png', error: null,
        notes: [{ id: 'mvn-1', atSec: 3, note: 'lip-sync drifts here', verdict: null }],
      }],
    });
    await openProject(PROJECT_WITH_CLIP);
    fireEvent.click(screen.getByRole('button', { name: /Render excerpt/i }));
    await waitFor(() => expect(renderMusicVideoExcerpt).toHaveBeenCalled());
    await settle();
    sseState.latest = { type: 'complete', result: { excerptId: 'mve-1', filename: 'excerpt-1.mp4' } };
    fireEvent.click(screen.getByRole('button', { name: /New project/i }));

    await screen.findByLabelText(/Play excerpt/i);
    expect(screen.getByText('lip-sync drifts here')).toBeInTheDocument();
    const contactSheet = await screen.findByAltText(/contact sheet/i);
    expect(contactSheet.getAttribute('src')).toBe('/data/video-thumbnails/excerpt-1-sheet.png');
  });

  it('adds, edits and removes a review note against the excerpt', async () => {
    const project = {
      ...PROJECT_WITH_CLIP,
      excerpts: [{
        id: 'mve-1', startSec: 10, endSec: 20, status: 'complete',
        filename: 'excerpt-1.mp4', contactSheetFilename: null, error: null, notes: [],
      }],
    };
    addMusicVideoExcerptNote.mockResolvedValue({
      project: { ...project, excerpts: [{ ...project.excerpts[0], notes: [{ id: 'mvn-1', atSec: 0, note: 'looks great', verdict: null }] }] },
      note: { id: 'mvn-1', atSec: 0, note: 'looks great', verdict: null },
    });
    await openProject(project);

    fireEvent.change(screen.getByLabelText('New review note'), { target: { value: 'looks great' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(addMusicVideoExcerptNote).toHaveBeenCalledWith('mv-1', 'mve-1', { atSec: 0, note: 'looks great' }, { silent: true }));
    await screen.findByText('looks great');

    updateMusicVideoExcerptNote.mockResolvedValue({
      project: { ...project, excerpts: [{ ...project.excerpts[0], notes: [{ id: 'mvn-1', atSec: 0, note: 'looks great', verdict: 'approved' }] }] },
      note: { id: 'mvn-1', atSec: 0, note: 'looks great', verdict: 'approved' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(updateMusicVideoExcerptNote).toHaveBeenCalledWith('mv-1', 'mve-1', 'mvn-1', { verdict: 'approved' }, { silent: true }));

    deleteMusicVideoExcerptNote.mockResolvedValue({ ...project, excerpts: [{ ...project.excerpts[0], notes: [] }] });
    fireEvent.click(screen.getByRole('button', { name: 'Delete note' }));
    await waitFor(() => expect(deleteMusicVideoExcerptNote).toHaveBeenCalledWith('mv-1', 'mve-1', 'mvn-1', { silent: true }));
    await waitFor(() => expect(screen.queryByText('looks great')).not.toBeInTheDocument());
  });

  it('deletes a completed excerpt', async () => {
    const project = {
      ...PROJECT_WITH_CLIP,
      excerpts: [{ id: 'mve-1', startSec: 10, endSec: 20, status: 'complete', filename: 'excerpt-1.mp4', contactSheetFilename: null, error: null, notes: [] }],
    };
    deleteMusicVideoExcerpt.mockResolvedValue({ ...project, excerpts: [] });
    await openProject(project);
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    await waitFor(() => expect(deleteMusicVideoExcerpt).toHaveBeenCalledWith('mv-1', 'mve-1', { silent: true }));
    await waitFor(() => expect(screen.queryByLabelText(/Play excerpt/i)).not.toBeInTheDocument());
  });
});

describe('MusicVideo selective section revision (#8987)', () => {
  // A reviewed draft: s1 approved, s2 flagged (song time 10 + 7 = 17s).
  const REVIEWED = {
    ...PROJECT_WITH_CLIP,
    scenes: [
      { sceneId: 's1', order: 0, prompt: 'a', referenceImageId: 'img1', videoHistoryId: 'h1' },
      { sceneId: 's2', order: 1, prompt: 'b', referenceImageId: 'img2', videoHistoryId: 'h2' },
    ],
    excerpts: [{
      id: 'mve-1', startSec: 10, endSec: 20, status: 'complete', filename: 'excerpt-1.mp4', contactSheetFilename: null, error: null,
      sections: [{ sceneId: 's1', layer: 'footage', startSec: 10, endSec: 15 }, { sceneId: 's2', layer: 'footage', startSec: 15, endSec: 20 }],
      notes: [{ id: 'mvn-1', atSec: 7, note: 'the jump cut stutters', verdict: 'flagged' }],
    }],
  };
  const revisionOf = (status = 'open') => ({
    id: 'mvr-1', excerptId: 'mve-1', startSec: 10, endSec: 20, status, renderExcerptId: null, renderAttempts: 0, error: null,
    sections: [
      { sceneId: 's1', layer: 'footage', kind: 'video', verdict: 'approved', rejectedAssetId: null, keptAssetId: 'h1', noteIds: [] },
      { sceneId: 's2', layer: 'footage', kind: 'video', verdict: 'rejected', rejectedAssetId: 'h2', keptAssetId: null, noteIds: ['mvn-1'] },
    ],
  });
  const withRevision = (s2Clip, status) => ({
    ...REVIEWED,
    scenes: [REVIEWED.scenes[0], { ...REVIEWED.scenes[1], videoHistoryId: s2Clip }],
    revisions: [revisionOf(status)],
  });

  it('revising a flagged draft generates only the rejected section', async () => {
    const opened = withRevision(null);
    startMusicVideoRevision.mockResolvedValue({ project: opened, revision: opened.revisions[0], skippedSceneIds: [] });
    resumeMusicVideoRevision.mockResolvedValue({ project: opened, revision: opened.revisions[0], needsGeneration: [{ sceneId: 's2', kind: 'video' }], generating: [], render: null });
    generateVideo.mockResolvedValue({ jobId: 'video-job-s2' });
    await openProject(REVIEWED);

    fireEvent.click(await findEnabledByRole('button', { name: /Revise flagged/i }));
    await waitFor(() => expect(resumeMusicVideoRevision).toHaveBeenCalledWith('mv-1', 'mvr-1', { silent: true }));
    expect(startMusicVideoRevision).toHaveBeenCalledWith('mv-1', 'mve-1', {}, { silent: true });
    await waitFor(() => expect(generateVideo).toHaveBeenCalledTimes(1));
    expect(JSON.parse(generateVideo.mock.calls[0][0].musicVideo)).toEqual({ projectId: 'mv-1', sceneId: 's2', revisionId: 'mvr-1' });
    const panel = screen.getByLabelText('Section revision');
    expect(within(panel).getByText('Kept')).toBeInTheDocument();
  });

  it('resuming once every revised section has a take re-renders the draft without any paid generation', async () => {
    const ready = withRevision('h2-new');
    resumeMusicVideoRevision.mockResolvedValue({
      project: { ...ready, revisions: [{ ...ready.revisions[0], status: 'rendering', renderExcerptId: 'mve-2' }] },
      revision: { ...ready.revisions[0], status: 'rendering' }, needsGeneration: [], generating: [], render: { jobId: 'mve-2', excerptId: 'mve-2' },
    });
    await openProject(ready);

    fireEvent.click(await findEnabledByRole('button', { name: /Render revised draft/i }));
    await waitFor(() => expect(resumeMusicVideoRevision).toHaveBeenCalledWith('mv-1', 'mvr-1', { silent: true }));
    await screen.findByText(/Rendering excerpt/);
    expect(generateVideo).not.toHaveBeenCalled();
    expect(generateImage).not.toHaveBeenCalled();
  });

  it('cancels an open revision', async () => {
    const open = withRevision(null);
    cancelMusicVideoRevision.mockResolvedValue({ project: { ...open, revisions: [{ ...open.revisions[0], status: 'canceled' }] }, revision: { ...open.revisions[0], status: 'canceled' } });
    await openProject(open);
    fireEvent.click(await findEnabledByRole('button', { name: /Cancel revision/i }));
    await waitFor(() => expect(cancelMusicVideoRevision).toHaveBeenCalledWith('mv-1', 'mvr-1', { silent: true }));
    await screen.findByText(/Revision — Cancelled/);
    expect(generateVideo).not.toHaveBeenCalled();
  });
});

describe('MusicVideo project video renderer', () => {
  it('lets the server resolve this install default when a synced project has no backend pin', async () => {
    generateVideo.mockResolvedValue({ jobId: 'video-job-default' });
    await openProject({
      ...PROJECT_NO_CLIP,
      videoSettings: { modelId: 'ltx23_distilled_q4' },
    });

    expect(await screen.findByLabelText('Scene video renderer')).toHaveProperty('value', '');
    fireEvent.click(screen.getByRole('button', { name: /^Generate video$/ }));
    await waitFor(() => expect(generateVideo).toHaveBeenCalled());
    expect(generateVideo.mock.calls.at(-1)[0]).not.toHaveProperty('backend');
    expect(generateVideo.mock.calls.at(-1)[0]).not.toHaveProperty('modelId');
  });

  it('clears an existing backend pin with the Install default option', async () => {
    await openProject(PROJECT_NO_CLIP);

    fireEvent.change(await screen.findByLabelText('Scene video renderer'), {
      target: { value: '' },
    });

    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith(
      'mv-2',
      { videoSettings: { backend: null } },
      { silent: true },
    ));
  });

  it('persists the local model and uses it for scene generation', async () => {
    generateVideo.mockResolvedValue({ jobId: 'video-job-1' });
    await openProject(PROJECT_NO_CLIP);

    const model = await screen.findByLabelText('Local video model');
    fireEvent.change(model, { target: { value: 'ltx23_distilled_q4' } });
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith(
      'mv-2',
      { videoSettings: { modelId: 'ltx23_distilled_q4' } },
      { silent: true },
    ));

    fireEvent.click(screen.getByRole('button', { name: /^Generate video$/ }));
    await waitFor(() => expect(generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      backend: 'local',
      modelId: 'ltx23_distilled_q4',
      mode: 'image',
      sourceImageFile: 'img1',
    })));
  });

  it('continues an existing scene through the local model native extend mode', async () => {
    generateVideo.mockResolvedValue({ jobId: 'video-job-2' });
    await openProject(PROJECT_WITH_CLIP);

    fireEvent.click(await screen.findByRole('button', { name: /^Continue shot$/ }));

    await waitFor(() => expect(generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      backend: 'local',
      modelId: 'ltx23_distilled_q4',
      disableAudio: true,
      mode: 'extend',
      extendFromVideoId: 'h1',
      sourceImageFile: 'img1',
    })));
  });

  it('uses project audio as no-vocals conditioning at the scene song offset', async () => {
    generateVideo.mockResolvedValue({ jobId: 'audio-reactive-job' });
    await openProject(PROJECT_NO_CLIP);

    fireEvent.change(await screen.findByLabelText('Scene generation mode'), {
      target: { value: 'audioReactive' },
    });
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith(
      'mv-2',
      {
        videoSettings: expect.objectContaining({
          generationMode: 'audioReactive',
          audioReactiveLora: 'audio-reactive-v2.safetensors',
          modelId: 'ltx23_distilled_q4',
        }),
      },
      { silent: true },
    ));

    fireEvent.click(screen.getByRole('button', { name: /^Generate video$/ }));
    await waitFor(() => expect(generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      backend: 'local',
      modelId: 'ltx23_distilled_q4',
      mode: 'a2v',
      sourceImageFile: 'img1',
      audioStartSec: 0,
      disableAudio: true,
      loraFilenames: ['audio-reactive-v2.safetensors'],
      loraScales: [1.2],
      prompt: expect.stringMatching(/No singing, lip-sync, speaking, mouth movement/i),
    })));
  });

  it('lets the project pin an exact installed audio-reactive LoRA version', async () => {
    await openProject({
      ...PROJECT_NO_CLIP,
      videoSettings: {
        backend: 'local',
        modelId: 'ltx23_distilled_q4',
        generationMode: 'audioReactive',
        audioReactiveLora: 'audio-reactive-v2.safetensors',
        audioReactiveScale: 1.2,
      },
    });

    const lora = await screen.findByLabelText('Audio reactive LoRA');
    expect(lora.value).toBe('audio-reactive-v2.safetensors');
    fireEvent.change(lora, { target: { value: 'audio-reactive.safetensors' } });

    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith(
      'mv-2',
      { videoSettings: { audioReactiveLora: 'audio-reactive.safetensors' } },
      { silent: true },
    ));
  });

  it('persists the fal.ai backend pin (#8968)', async () => {
    getVideoGenStatus.mockResolvedValueOnce({
      connected: true,
      defaultModel: 'ltx23_distilled_q4',
      falEnabled: true,
      models: [{ id: 'ltx23_distilled_q4', name: 'LTX-2.3 Distilled Q4', runtime: 'ltx2' }],
    });
    await openProject(PROJECT_NO_CLIP);

    fireEvent.change(await screen.findByLabelText('Scene video renderer'), {
      target: { value: 'fal' },
    });
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith(
      'mv-2',
      { videoSettings: { backend: 'fal' } },
      { silent: true },
    ));
    expect(await screen.findByLabelText('fal.ai scene clip duration')).toBeTruthy();
  });

  it('renders a scene image-to-video through a saved fal.ai pin (#8968)', async () => {
    getVideoGenStatus.mockResolvedValueOnce({
      connected: true,
      defaultModel: 'ltx23_distilled_q4',
      falEnabled: true,
      models: [{ id: 'ltx23_distilled_q4', name: 'LTX-2.3 Distilled Q4', runtime: 'ltx2' }],
    });
    generateVideo.mockResolvedValue({ jobId: 'fal-video-job' });
    await openProject({
      ...PROJECT_NO_CLIP,
      videoSettings: { backend: 'fal', falDuration: 6 },
    });

    expect(await screen.findByLabelText('fal.ai scene clip duration')).toHaveProperty('value', '6');
    fireEvent.click(await findEnabledByRole('button', { name: /^Generate video$/ }));
    await waitFor(() => expect(generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      backend: 'fal',
      falDuration: 6,
      mode: 'image',
      sourceImageFile: 'img1',
    })));
    expect(generateVideo.mock.calls.at(-1)[0]).not.toHaveProperty('modelId');
    expect(generateVideo.mock.calls.at(-1)[0]).not.toHaveProperty('disableAudio');
  });

  it('blocks fal.ai scene generation with a clear preflight reason when no API key is configured', async () => {
    // getVideoGenStatus's default mock omits falEnabled, so it resolves false —
    // exactly the "no fal.ai API key configured" install this covers.
    await openProject({ ...PROJECT_NO_CLIP, videoSettings: { backend: 'fal' } });

    const generate = await screen.findByRole('button', { name: /^Generate video$/ });
    expect(generate).toBeDisabled();
    expect(generate).toHaveProperty('title', expect.stringContaining('No fal.ai API key configured'));
    fireEvent.click(generate);
    expect(generateVideo).not.toHaveBeenCalled();
  });

  describe('performance shots (#8977)', () => {
    const PERFORMANCE_SCENE = {
      sceneId: 's1', order: 0, prompt: 'singer at the mic', referenceImageId: 'img1', videoHistoryId: null,
      shotMode: 'performance', startSec: 20, endSec: 21.5,
    };
    const performanceProject = (videoSettings) => ({
      ...PROJECT_NO_CLIP,
      audioAnalysis: { bpm: 120, beats: [], downbeats: [], sections: [], durationSec: 30 },
      videoSettings,
      scenes: [PERFORMANCE_SCENE],
    });

    it('labels Grok cutaway-only and blocks a performance shot on it without calling the provider', async () => {
      await openProject(performanceProject({ backend: 'grok', grokDuration: 6 }));

      expect(await screen.findByRole('option', { name: 'Grok video (cutaway only)' })).toBeTruthy();
      expect(await screen.findByText(/Grok video is cutaway-only/)).toBeTruthy();
      const generate = await screen.findByRole('button', { name: /^Generate video$/ });
      expect(generate).toBeDisabled();
      fireEvent.click(generate);
      expect(generateVideo).not.toHaveBeenCalled();
    });

    it('names the lip-sync provider, model, song window and cost, then renders on fal.ai without a clip-length pin', async () => {
      getVideoGenStatus.mockResolvedValueOnce({
        connected: true, defaultModel: 'ltx23_distilled_q4', falEnabled: true,
        models: [{ id: 'ltx23_distilled_q4', name: 'LTX-2.3 Distilled Q4', runtime: 'ltx2' }],
      });
      generateVideo.mockResolvedValue({ jobId: 'fal-lipsync-job' });
      await openProject(performanceProject({ backend: 'fal', falDuration: 6 }));

      const plan = await screen.findByTestId('performance-plan');
      expect(plan.textContent).toContain('minimax/h3-max/lip-sync/image-to-video');
      expect(plan.textContent).toMatch(/shot starts 1\.7[78]s into the take/);
      expect(plan.textContent).toContain('cost unknown');
      fireEvent.click(await findEnabledByRole('button', { name: /^Generate video$/ }));
      await waitFor(() => expect(generateVideo).toHaveBeenCalledWith(expect.objectContaining({
        backend: 'fal', mode: 'image', sourceImageFile: 'img1',
      })));
      expect(generateVideo.mock.calls.at(-1)[0]).not.toHaveProperty('falDuration');
    });

    it('persists a scene switched to a performance shot', async () => {
      updateMusicVideoScene.mockResolvedValue({ ...PROJECT_NO_CLIP.scenes[0], shotMode: 'performance' });
      await openProject(PROJECT_NO_CLIP);

      fireEvent.change(await screen.findByLabelText('Shot'), { target: { value: 'performance' } });
      await waitFor(() => expect(updateMusicVideoScene).toHaveBeenCalledWith(
        'mv-2', 's1', { shotMode: 'performance' }, expect.anything(),
      ));
    });

    it('offers a lyric-boundary split for a shot longer than one lip-sync take and applies the split board', async () => {
      const longShot = { ...PERFORMANCE_SCENE, startSec: 2, endSec: 26 };
      const project = { ...performanceProject({ backend: 'fal' }), scenes: [longShot] };
      const pieces = [
        { ...longShot, label: 'Verse · 1/2', endSec: 14 },
        { ...longShot, sceneId: 's1b', order: 1, label: 'Verse · 2/2', startSec: 14, videoHistoryId: null },
      ];
      splitMusicVideoScene.mockResolvedValue({ project: { ...project, scenes: pieces }, scenes: pieces });
      await openProject(project);

      // The too-long refusal stays, now with a way out that never loops or stretches.
      expect(await screen.findByText(/Split the scene on a lyric or phrase boundary/)).toBeTruthy();
      fireEvent.click(await screen.findByRole('button', { name: /Split on lyric boundaries/ }));
      await waitFor(() => expect(splitMusicVideoScene).toHaveBeenCalledWith('mv-2', 's1', 'fal', expect.anything()));
      expect(await screen.findByText('Verse · 2/2')).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Split on lyric boundaries/ })).toBeNull();
    });

    it('requests the Grok clip that covers a cutaway and adds approximate motion timing', async () => {
      generateVideo.mockResolvedValue({ jobId: 'grok-job' });
      await openProject({
        ...PROJECT_NO_CLIP,
        videoSettings: { backend: 'grok', grokDuration: 6 },
        phrases: [{ id: 'p1', startSec: 12, endSec: 15, intent: 'camera pushes in' }],
        scenes: [{ ...PROJECT_NO_CLIP.scenes[0], startSec: 10, endSec: 17.2 }],
      });

      expect(await screen.findByText(/Grok renders a 10s clip for this 7\.2s cutaway/)).toBeTruthy();
      fireEvent.click(await findEnabledByRole('button', { name: /^Generate video$/ }));
      await waitFor(() => expect(generateVideo).toHaveBeenCalledWith(expect.objectContaining({
        backend: 'grok', grokDuration: 10,
        prompt: expect.stringContaining('around 2.0s: camera pushes in'),
      })));
    });
  });

  it('warns when ready scenes reuse the same frames and clips', async () => {
    await openProject({
      ...PROJECT_WITH_CLIP,
      scenes: [
        PROJECT_WITH_CLIP.scenes[0],
        { ...PROJECT_WITH_CLIP.scenes[0], sceneId: 's2', order: 1 },
      ],
    });

    expect(await screen.findByText('Repetition: 1 unique frames · 1 unique clips')).toBeTruthy();
  });
});

// A model that used to carry a blocking license checkbox still generates
// from this board with no acknowledgement UI — the license lives on the
// Video Gen disclosure, not as a per-render gate.
describe('MusicVideo restricted-model license gate', () => {
  const GATE = {
    id: 'example-community-license-2026-01-01',
    title: 'Example model eligibility and terms',
    summary: 'This model is licensed only in its applicable territory.',
    acknowledgement: 'I am eligible and accept the Example Community License.',
    licenseUrl: 'https://example.com/license',
  };

  it('does not ask for an eligibility acknowledgement before generating', async () => {
    getVideoGenStatus.mockResolvedValueOnce({
      connected: true,
      defaultModel: 'gated_model',
      models: [{ id: 'gated_model', name: 'Gated Model', runtime: 'ltx2', termsGate: GATE }],
    });
    generateVideo.mockResolvedValue({ jobId: 'gated-job' });
    await openProject(PROJECT_NO_CLIP);

    const generate = await findEnabledByRole('button', { name: /^Generate video$/ });
    expect(screen.queryByRole('checkbox', { name: /I am eligible/ })).toBeNull();
    fireEvent.click(generate);
    await waitFor(() => expect(generateVideo).toHaveBeenCalled());
  });
});

describe('MusicVideo project versions', () => {
  it('forks the open project and navigates to the editable next version', async () => {
    cloneMusicVideoProject.mockResolvedValue({
      ...PROJECT_WITH_CLIP,
      id: 'mv-v2',
      name: 'Neon Run v2',
      version: 2,
      parentProjectId: 'mv-1',
      renderHistoryId: null,
    });
    await openProject(PROJECT_WITH_CLIP);

    fireEvent.click(await screen.findByRole('button', { name: /^Fork v2$/ }));

    await waitFor(() => expect(cloneMusicVideoProject).toHaveBeenCalledWith('mv-1', {}, { silent: true }));
    await screen.findByRole('heading', { level: 2, name: 'Neon Run v2' });
    expect(screen.getByText('v2')).toBeTruthy();
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

  it('labels a linked track whose active take was imported from a Suno export (#8967)', async () => {
    listTracks.mockResolvedValue([{
      id: 't1', title: 'Neon Song', audioFilename: 'neon.mp3',
      renders: [{ id: 'r-old', audioFilename: 'old.wav', source: '' }, { id: 'r-1', audioFilename: 'neon.mp3', source: 'suno' }],
    }]);
    await openProject(PROJECT_WITH_CLIP);
    expect(await screen.findByTitle('Audio imported from Suno')).toHaveTextContent('Suno');
  });

  it('falls back to the project uploaded-audio file when there is no linked track', async () => {
    await openProject({ ...PROJECT_WITH_CLIP, trackId: null, uploadedAudioFilename: 'upload.wav' });
    const player = await screen.findByLabelText('Preview track audio');
    expect(player.getAttribute('src')).toBe('/data/music/upload.wav');
  });

  it('renders no audio controls when the project has no audio', async () => {
    await openProject({ ...PROJECT_WITH_CLIP, trackId: null, uploadedAudioFilename: null });
    // Board opened (Render button present) but no audio surface.
    await screen.findByRole('button', { name: /^Render final$/ });
    expect(screen.queryByLabelText('Preview track audio')).toBeNull();
    expect(screen.queryByRole('link', { name: /Download audio/i })).toBeNull();
  });
});

describe('MusicVideo musical timeline', () => {
  it('renders waveform, beat evidence, legend, and the detected rhythmic window', async () => {
    await openProject(PROJECT_ANALYZED);
    expect(screen.getByRole('img', { name: /audio waveform overview with 4 beats and 1 downbeats/i })).toBeTruthy();
    expect(screen.getByText(/waveform, sections, and 4\/4 beat-grid assumption/i)).toBeTruthy();
    expect(screen.getByText(/detected near 0:40\.00–1:10\.00/i)).toBeTruthy();
    expect(screen.getByLabelText('Timeline legend')).toBeTruthy();
  });
});

describe('MusicVideo audio → MIDI transcription (MuScriptor)', () => {
  it('disables the MIDI button when the project has no audio source', async () => {
    await openProject({ ...PROJECT_WITH_CLIP, trackId: null, uploadedAudioFilename: null });
    const btn = await screen.findByRole('button', { name: /^MIDI$/ });
    expect(btn).toHaveProperty('disabled', true);
  });

  it('kicks off a transcription for the selected project with the default model', async () => {
    await openProject(PROJECT_WITH_CLIP);
    const btn = await screen.findByRole('button', { name: /^MIDI$/ });
    expect(btn).toHaveProperty('disabled', false);
    fireEvent.click(btn);
    await waitFor(() => expect(transcribeMusicVideoMidi).toHaveBeenCalledWith('mv-1', { model: 'medium' }, { silent: true }));
  });

  it('kicks off a transcription with the chosen model size', async () => {
    await openProject(PROJECT_WITH_CLIP);
    fireEvent.change(await screen.findByLabelText('MuScriptor model size'), { target: { value: 'large' } });
    fireEvent.click(await screen.findByRole('button', { name: /^MIDI$/ }));
    await waitFor(() => expect(transcribeMusicVideoMidi).toHaveBeenCalledWith('mv-1', { model: 'large' }, { silent: true }));
  });

  it('shows the MIDI download link once the project carries a transcription pointer', async () => {
    listTracks.mockResolvedValue([{ id: 't1', title: 'Neon Song', audioFilename: 'neon.mp3' }]);
    await openProject({ ...PROJECT_WITH_CLIP, midiTranscription: { filename: 'neon-midi.mid', model: 'medium' } });
    // Two links now: the download button and the MidiVisualization panel's
    // download icon (#2477) — both serve from the music dir (same static route
    // as the master audio) so the federated .mid resolves on peers too.
    const links = await screen.findAllByRole('link', { name: /Download MIDI/i });
    expect(links.length).toBeGreaterThanOrEqual(1);
    links.forEach((dl) => expect(dl.getAttribute('href')).toBe('/data/music/neon-midi.mid'));
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
    await waitFor(() => expect(planMusicVideoProject).toHaveBeenCalledWith('mv-3', { seedPrompts: true }, { silent: true }));
  });
});

describe('MusicVideo lyrics and shot coverage (#8964)', () => {
  it('imports pasted lyrics, shows the cues, and persists an edited line on blur', async () => {
    const cues = [
      { id: 'lc-1', text: 'first line', startSec: 1, endSec: 3 },
      { id: 'lc-2', text: 'second line', startSec: 3, endSec: null },
    ];
    importMusicVideoLyrics.mockResolvedValue({ project: { ...PROJECT_ANALYZED, lyricCues: cues }, imported: 2, format: 'lrc' });
    await openProject(PROJECT_ANALYZED);

    fireEvent.change(screen.getByLabelText('Lyrics to import'), { target: { value: '[00:01.00]first line\n[00:03.00]second line' } });
    fireEvent.click(screen.getByRole('button', { name: /^Import lyrics$/ }));
    await waitFor(() => expect(importMusicVideoLyrics).toHaveBeenCalledWith(
      'mv-3',
      { text: '[00:01.00]first line\n[00:03.00]second line', format: 'auto', mode: 'replace' },
      { silent: true },
    ));
    const line = await screen.findByLabelText('Line 2 text');
    expect(line).toHaveValue('second line');
    expect(screen.getByLabelText('Lyrics to import')).toHaveValue('');

    fireEvent.change(line, { target: { value: 'second line, retold' } });
    expect(alignMusicVideoLyrics).not.toHaveBeenCalled();
    fireEvent.blur(line);
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith(
      'mv-3',
      { lyricCues: [cues[0], { ...cues[1], text: 'second line, retold' }] },
      { silent: true },
    ));
  });

  it('aligns words only after the button click and shows the returned timings', async () => {
    const cues = [{
      id: 'lc-1', text: 'walking home', startSec: 0.5, endSec: 1.5,
      words: [
        { w: 'walking', startSec: 0.5, endSec: 1, conf: 'matched' },
        { w: 'home', startSec: 1, endSec: 1.5, conf: 'interpolated' },
      ],
    }];
    await openProject({ ...PROJECT_ANALYZED, lyricCues: [{ id: 'lc-1', text: 'walking home', startSec: null, endSec: null }] });
    expect(alignMusicVideoLyrics).not.toHaveBeenCalled();
    alignMusicVideoLyrics.mockResolvedValue({ id: 'mv-3', lyricCues: cues, updatedAt: 't' });
    fireEvent.click(screen.getByRole('button', { name: 'Align words' }));
    await waitFor(() => expect(alignMusicVideoLyrics).toHaveBeenCalledWith('mv-3', {}, { silent: true }));
    expect(await screen.findByText('walking')).toHaveClass('text-port-accent');
    expect(screen.getByText('home')).toHaveClass('text-port-warning');
    fireEvent.click(screen.getByRole('button', { name: 'Re-align line 1' }));
    await waitFor(() => expect(alignMusicVideoLyrics).toHaveBeenLastCalledWith('mv-3', { cueId: 'lc-1' }, { silent: true }));
  });

  it('flags a non-looping shot longer than its clip and trims it; a legacy scene is left alone', async () => {
    const project = {
      ...PROJECT_WITH_CLIP,
      scenes: [
        { sceneId: 's1', order: 0, prompt: 'a', referenceImageId: 'img1', videoHistoryId: 'h1', beatAligned: true, startSec: 2, endSec: 12, loop: false, lyricText: 'first line' },
        { sceneId: 's2', order: 1, prompt: 'b', referenceImageId: 'img1', videoHistoryId: 'h2', beatAligned: true, startSec: 12, endSec: 30 },
      ],
    };
    updateMusicVideoScene.mockResolvedValue({});
    await openProject(project);
    expect(screen.getByText(/first line/)).toBeTruthy();

    const players = document.body.querySelectorAll('video[src^="/data/videos/h"]');
    expect(players).toHaveLength(2);
    for (const player of players) {
      Object.defineProperty(player, 'duration', { configurable: true, value: 5 });
      fireEvent.loadedMetadata(player);
    }
    const alerts = await screen.findAllByRole('alert');
    expect(alerts).toHaveLength(1); // the legacy s2 keeps looping to fill its span
    expect(alerts[0].textContent).toContain('Shot runs 10.0s but its clip is 5.0s');

    fireEvent.click(within(alerts[0]).getByRole('button', { name: 'Trim to clip' }));
    await waitFor(() => expect(updateMusicVideoScene).toHaveBeenCalledWith('mv-1', 's1', { endSec: 7 }, { silent: true }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});

describe('MusicVideo typography composition (#8984)', () => {
  it('seeds text cues from the timed lyrics, switches to a composed render, and saves an edited cue whole', async () => {
    const lyricCues = [
      { id: 'lc-1', text: 'first line', startSec: 1, endSec: 3 },
      { id: 'lc-2', text: 'untimed line', startSec: null, endSec: null },
    ];
    updateMusicVideoProject.mockResolvedValue({});
    await openProject({ ...PROJECT_ANALYZED, lyricCues });

    fireEvent.click(screen.getByRole('button', { name: /Copy timed lyrics \(1\)/ }));
    const text = await screen.findByLabelText('Text cue 1 text');
    expect(text).toHaveValue('first line');
    expect(screen.queryByLabelText('Text cue 2 text')).toBeNull();
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenLastCalledWith('mv-3', {
      composition: expect.objectContaining({ mode: 'concat', textCues: [expect.objectContaining({ text: 'first line', startSec: 1, endSec: 3, template: 'fade' })] }),
    }, { silent: true }));

    fireEvent.change(document.getElementById('mv-typo-mode'), { target: { value: 'composed' } });
    fireEvent.change(screen.getByLabelText('Text cue 1 motion'), { target: { value: 'typewriter' } });
    fireEvent.change(text, { target: { value: 'first line, typed' } });
    fireEvent.blur(text);
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenLastCalledWith('mv-3', {
      composition: expect.objectContaining({
        mode: 'composed',
        textCues: [expect.objectContaining({ text: 'first line, typed', template: 'typewriter' })],
      }),
    }, { silent: true }));
  });
});

describe('MusicVideo section layers (#8985)', () => {
  const scenes = [
    { sceneId: 's1', order: 0, prompt: 'a', referenceImageId: 'img1', videoHistoryId: 'h1', startSec: 0, endSec: 4 },
    { sceneId: 's2', order: 1, prompt: 'b', referenceImageId: null, videoHistoryId: null, startSec: 4, endSec: 6 },
  ];
  const composition = (mode) => ({ version: 1, mode, textCues: [], style: { color: '#ffffff', font: 'sans' }, posterSec: null });

  it('makes a footage-less scene a title card so a composed project can render', async () => {
    updateMusicVideoScene.mockResolvedValue({});
    await openProject({ ...PROJECT_WITH_CLIP, scenes, composition: composition('composed') });
    const renderBtn = await screen.findByRole('button', { name: /^Render final$/ });
    expect(renderBtn).toBeDisabled();

    const layer = document.getElementById('mv-scene-s2-layer');
    fireEvent.change(layer, { target: { value: 'card' } });
    await waitFor(() => expect(updateMusicVideoScene).toHaveBeenCalledWith('mv-1', 's2', { visualLayer: 'card' }, { silent: true }));
    const cardText = await screen.findByLabelText('Card text');
    fireEvent.change(cardText, { target: { value: 'Chapter two' } });
    fireEvent.blur(cardText);
    await waitFor(() => expect(updateMusicVideoScene).toHaveBeenCalledWith('mv-1', 's2', { cardText: 'Chapter two' }, { silent: true }));
    // A card needs no frame or clip, so the board is ready; only the footage scene counts toward Videos.
    await waitFor(() => expect(screen.getByRole('button', { name: /^Render final$/ })).toBeEnabled());
    expect(screen.getByRole('button', { name: /Videos 1\/1/ })).toBeTruthy();
  });

  it('keeps a plain render on footage and says the layer only applies to composed renders', async () => {
    await openProject({ ...PROJECT_WITH_CLIP, scenes: [scenes[0], { ...scenes[1], visualLayer: 'card' }], composition: composition('concat') });
    expect(await screen.findByText(/Title card sections render in composed mode/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Render final$/ })).toBeDisabled();
  });
});

describe('MusicVideo concept & style editor (#3168)', () => {
  it('seeds the fields from the project and persists each on blur', async () => {
    const withConcept = { ...PROJECT_NO_CLIP, concept: { prompt: 'A road trip through neon ruins', style: 'Cyberpunk anime' } };
    await openProject(withConcept);

    const conceptField = await screen.findByLabelText('Concept');
    const styleField = screen.getByLabelText('Visual style');
    expect(conceptField).toHaveValue('A road trip through neon ruins');
    expect(styleField).toHaveValue('Cyberpunk anime');

    fireEvent.change(conceptField, { target: { value: 'A heist across a dying star' } });
    fireEvent.blur(conceptField);
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith(
      'mv-2',
      { concept: { prompt: 'A heist across a dying star' } },
      { silent: true },
    ));

    fireEvent.change(styleField, { target: { value: 'Watercolor noir' } });
    fireEvent.blur(styleField);
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith(
      'mv-2',
      { concept: { style: 'Watercolor noir' } },
      { silent: true },
    ));
  });

  it('does not re-PATCH when a field is focused and blurred without an edit', async () => {
    const withConcept = { ...PROJECT_NO_CLIP, concept: { prompt: 'Unchanged', style: 'Unchanged' } };
    await openProject(withConcept);
    const conceptField = await screen.findByLabelText('Concept');
    fireEvent.focus(conceptField);
    fireEvent.blur(conceptField);
    await settle();
    expect(updateMusicVideoProject).not.toHaveBeenCalled();
  });

  it('discards an unsaved draft on project switch instead of leaking it onto the next project', async () => {
    // The page reuses one component instance across projects (route param
    // change, no remount) — an edit left unblurred when the selection changes
    // (deep link, browser Back, ⌘K) must not survive to be committed against
    // whichever project is now selected.
    const projectB = { ...PROJECT_NO_CLIP, id: 'mv-3', name: 'Other Project', concept: { prompt: 'B original' } };
    listMusicVideoProjects.mockResolvedValue([PROJECT_NO_CLIP, projectB]);
    renderMV();
    await selectProject(PROJECT_NO_CLIP.id);

    const conceptField = await screen.findByLabelText('Concept');
    fireEvent.change(conceptField, { target: { value: 'A unsaved draft' } });
    // No blur — switch projects while the edit is still pending.
    await selectProject(projectB.id);

    await waitFor(() => expect(screen.getByLabelText('Concept')).toHaveValue('B original'));
    fireEvent.blur(screen.getByLabelText('Concept'));
    await settle();
    expect(updateMusicVideoProject).not.toHaveBeenCalledWith(
      'mv-3',
      { concept: { prompt: 'A unsaved draft' } },
      { silent: true },
    );
  });

  it('starts empty and enables AI Plan to use them once set', async () => {
    await openProject(PROJECT_ANALYZED);
    const conceptField = await screen.findByLabelText('Concept');
    expect(conceptField).toHaveValue('');

    fireEvent.change(conceptField, { target: { value: 'Underwater festival' } });
    fireEvent.blur(conceptField);
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith(
      'mv-3',
      { concept: { prompt: 'Underwater festival' } },
      { silent: true },
    ));
  });
});

describe('MusicVideo YouTube audio import (#1945)', () => {
  it('starts an import from the detail view and attaches the finished track to the project', async () => {
    await openProject(PROJECT_NO_CLIP);
    const urlInput = screen.getByPlaceholderText(/Import audio from a YouTube URL/i);
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
    fireEvent.change(urlInput, { target: { value: 'https://youtu.be/refresh' } });
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith('mv-2', { trackId: 'track-yt-1' }, { silent: true }));
  });

  it('disables the Import button until a URL is entered', async () => {
    await openProject(PROJECT_NO_CLIP);
    // Exact name: the board also carries "Import take" / handoff import controls.
    const importBtns = screen.getAllByRole('button', { name: /^Import$/i });
    expect(importBtns.length).toBeGreaterThan(0);
    importBtns.forEach((btn) => expect(btn).toHaveProperty('disabled', true));
  });

  it('running the create-form and detail-view imports at once does not orphan either job', async () => {
    await openProject(PROJECT_NO_CLIP);
    await openCreateForm();
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
    const picker = await selectProject(PROJECT_NO_CLIP.id);

    const editInput = screen.getAllByPlaceholderText(/Import audio from a YouTube URL/i)
      .find((el) => el.id !== 'mv-yt-create');
    fireEvent.change(editInput, { target: { value: 'https://youtu.be/xyz' } });
    fireEvent.click(within(editInput.closest('div')).getByRole('button', { name: /Import/i }));
    await waitFor(() => expect(importTrackFromYoutube).toHaveBeenCalled());

    // Switching to the OTHER project while this one's import is in flight
    // must be blocked — it would silently orphan the in-flight job's SSE
    // subscription and misattribute its progress UI to the new selection.
    fireEvent.change(picker, { target: { value: projectB.id } });
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/before switching projects/i));
    expect(picker).toHaveValue(PROJECT_NO_CLIP.id);
  });

  it('bounces URL-driven navigation (deep link / Back / ⌘K) away from a project with an in-flight import back to it', async () => {
    listMusicVideoProjects.mockResolvedValue([PROJECT_NO_CLIP]); // mv-2
    renderMVWithNav('/music-video/mv-3');
    // Open mv-2 and start its detail-view import.
    await selectProject(PROJECT_NO_CLIP.id);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/music-video/mv-2'));
    const editInput = screen.getAllByPlaceholderText(/Import audio from a YouTube URL/i)
      .find((el) => el.id !== 'mv-yt-create');
    fireEvent.change(editInput, { target: { value: 'https://youtu.be/xyz' } });
    fireEvent.click(within(editInput.closest('div')).getByRole('button', { name: /Import/i }));
    await waitFor(() => expect(importTrackFromYoutube).toHaveBeenCalled());

    // A router-driven jump to another project (not via the list buttons, so it
    // bypasses selectProject's guard) must be bounced back to the import's
    // project with the same guard message.
    fireEvent.click(screen.getByRole('button', { name: 'go-/music-video/mv-3' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/before switching projects/i)));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/music-video/mv-2'));
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
    await openCreateForm();
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
    await openCreateForm();
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
    const picker = await selectProject(PROJECT_NO_CLIP.id);

    const editInput = screen.getAllByPlaceholderText(/Import audio from a YouTube URL/i)
      .find((el) => el.id !== 'mv-yt-create');
    fireEvent.change(editInput, { target: { value: 'https://youtu.be/pending' } });
    fireEvent.click(within(editInput.closest('div')).getByRole('button', { name: /Import/i }));
    // The kickoff POST has NOT resolved yet — no jobId, no SSE subscription —
    // but switching away must already be blocked, or this project's import
    // would attach with nobody listening once it lands.
    expect(importTrackFromYoutube).toHaveBeenCalledTimes(1);

    fireEvent.change(picker, { target: { value: projectB.id } });
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/before switching projects/i));
    expect(picker).toHaveValue(PROJECT_NO_CLIP.id);

    resolveKickoff({ jobId: 'yt-job-pending' });
    // Settle the kickoff's .then (jobId + SSE-subscription state) inside act —
    // the pending-window assertions above must stay pre-settle.
    await settle();
  });

  it('blocks creating the project while the create-form YouTube import is in flight', async () => {
    listMusicVideoProjects.mockResolvedValue([]);
    renderMV();
    await openCreateForm();
    const nameInput = await screen.findByPlaceholderText('Project name');
    fireEvent.change(nameInput, { target: { value: 'New MV' } });
    const createInput = screen.getAllByPlaceholderText(/Import audio from a YouTube URL/i)
      .find((el) => el.id === 'mv-yt-create');
    fireEvent.change(createInput, { target: { value: 'https://youtu.be/xyz' } });
    fireEvent.click(within(createInput.closest('div')).getByRole('button', { name: /Import/i }));
    await waitFor(() => expect(importTrackFromYoutube).toHaveBeenCalled());

    const createBtn = screen.getByRole('button', { name: /^Create/ });
    expect(createBtn).toHaveProperty('disabled', true);
    fireEvent.click(createBtn);
    expect(createMusicVideoProject).not.toHaveBeenCalled();
  });

  it('creates an autopilot project by default with the chosen tools, guidance and budget', async () => {
    listMusicVideoProjects.mockResolvedValue([]);
    createMusicVideoProject.mockResolvedValue({ ...PROJECT_NO_CLIP, id: 'mv-new', name: 'Auto MV', mode: 'autonomous' });
    renderMV();
    await openCreateForm();
    fireEvent.change(await screen.findByPlaceholderText('Project name'), { target: { value: 'Auto MV' } });
    fireEvent.click(screen.getByLabelText(/fal\.ai video/));
    fireEvent.change(screen.getByLabelText('Guidance'), { target: { value: ' one long take ' } });
    fireEvent.change(screen.getByLabelText('Budget cap (USD)'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: /Create autopilot project/ }));
    await waitFor(() => expect(createMusicVideoProject).toHaveBeenCalled());
    const [body] = createMusicVideoProject.mock.calls[0];
    expect(body).toMatchObject({ name: 'Auto MV', mode: 'autonomous', trackId: null });
    expect(body.automation).toEqual({
      tools: ['image:external', 'image:local', 'video:local', 'video:fal', 'code:render'],
      guidance: 'one long take',
      budgetUsd: 40,
    });
  });

  it('autopilot kickoff analyzes the song, then plans the shots against the brief', async () => {
    const project = { ...PROJECT_NO_CLIP, scenes: [], automation: { tools: ['image:local'], guidance: 'noir', budgetUsd: null } };
    analyzeMusicVideoProject.mockResolvedValue({ ...project, audioAnalysis: PROJECT_ANALYZED.audioAnalysis, status: 'analyzed' });
    planMusicVideoProject.mockResolvedValue({ project: { ...project, audioAnalysis: PROJECT_ANALYZED.audioAnalysis }, scenesAdded: 3, promptsSeeded: true });
    await openProject(project);
    fireEvent.click(screen.getByRole('button', { name: /Analyze & plan/ }));
    await waitFor(() => expect(planMusicVideoProject).toHaveBeenCalledWith(project.id, { seedPrompts: true }, { silent: true }));
    expect(analyzeMusicVideoProject).toHaveBeenCalledWith(project.id, { silent: true });
  });

  it('blocks relinking the track while a render is in progress for the selected project', async () => {
    await openProject(PROJECT_WITH_CLIP);
    fireEvent.click(await screen.findByRole('button', { name: /^Render final$/ }));
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

// Shared MediaLightbox for scene frames, scene clips, and the final render (#3718).
// View-only — no remix/clean action handlers. Keys are deep-linkable via ?preview=.
describe('MusicVideo media lightbox (#3718)', () => {
  const renderMVAt = (path) => render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/music-video" element={<MusicVideo />} />
        <Route path="/music-video/:projectId" element={<MusicVideo />} />
      </Routes>
    </MemoryRouter>,
  );

  it('opens the lightbox from a reference-frame thumbnail click', async () => {
    await openProject(PROJECT_WITH_CLIP);
    fireEvent.click(await screen.findByRole('button', { name: 'View scene 1 reference frame full size' }));
    const dialog = await screen.findByRole('dialog', { name: /Media viewer/i });
    expect(dialog).toBeTruthy();
    // Image uses previewUrl (/data/images/<id>); img may be MediaImage-wrapped.
    expect(dialog.querySelector('img')?.getAttribute('src') || dialog.innerHTML)
      .toMatch(/\/data\/images\/img1/);
  });

  it('opens the lightbox from a scene-clip expand control without hijacking play/pause', async () => {
    await openProject(PROJECT_WITH_CLIP);
    // Inline thumb keeps its own controls attribute for native play/pause.
    const inlineVideo = document.querySelector('video[src="/data/videos/h1.mp4"]');
    expect(inlineVideo).toBeTruthy();
    expect(inlineVideo.hasAttribute('controls')).toBe(true);

    fireEvent.click(await screen.findByRole('button', { name: 'View scene 1 clip full size' }));
    const dialog = await screen.findByRole('dialog', { name: /Media viewer/i });
    const lightboxVideo = dialog.querySelector('video');
    expect(lightboxVideo?.getAttribute('src')).toBe('/data/videos/h1.mp4');
  });

  it('opens the final render from the resolved filename, not the history-id reconstruction', async () => {
    // getVideoHistoryItem is mocked → { id: 'rh-9', filename: 'final.mp4' }; the
    // final-render id is NOT its filename stem, so /data/videos/rh-9.mp4 404s.
    await openProject({ ...PROJECT_WITH_CLIP, renderHistoryId: 'rh-9' });
    const expand = await screen.findByRole('button', { name: 'View final video full size' });
    fireEvent.click(expand);
    const dialog = await screen.findByRole('dialog', { name: /Media viewer/i });
    const lightboxVideo = dialog.querySelector('video');
    expect(lightboxVideo?.getAttribute('src')).toBe('/data/videos/final.mp4');
    expect(lightboxVideo?.getAttribute('src')).not.toBe('/data/videos/rh-9.mp4');
  });

  it('shows the styled prompt the renderer was sent, not the board label', async () => {
    // The scene's own prompt is 'a'; `useMusicVideoSceneMedia` appends the
    // project's concept style before rendering, so the board label is wording
    // the image model never saw. The sidecar is the only record of the real
    // one — and it also carries the `cleanedFrom` lineage the hand-rolled item
    // shape used to drop.
    await openProject(PROJECT_WITH_CLIP);
    fireEvent.click(await screen.findByRole('button', { name: 'View scene 1 reference frame full size' }));
    const dialog = await screen.findByRole('dialog', { name: /Media viewer/i });
    await waitFor(() => {
      expect(dialog.querySelector('img')?.getAttribute('alt')).toBe('a wide desert shot, neon noir');
    });
  });

  it('opens the lightbox from a ?preview= deep link on mount', async () => {
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP]);
    renderMVAt('/music-video/mv-1?preview=image%3Aimg1');
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    const dialog = await screen.findByRole('dialog', { name: /Media viewer/i });
    expect(dialog.getAttribute('aria-label')).toMatch(/img1|image:img1/);
  });
});

describe('MusicVideo visual spec, takes and handoff (#8965)', () => {
  const SPEC_PROJECT = {
    ...PROJECT_NO_CLIP,
    id: 'mv-spec',
    name: 'Spec Project',
    concept: { style: 'grainy 16mm' },
    visualSpec: {
      palette: ['#112233'],
      cameraRules: 'locked-off wides',
      // Non-empty on purpose (#8992): typography guidance must stay out of
      // the generated image/video prompt below even when the spec has it.
      typography: 'condensed sans, all caps, lower-third titles',
      references: [
        { id: 'r1', imageId: 'mood.png', role: 'character', label: 'Lead', note: '', condition: true },
        { id: 'r2', imageId: 'set.png', role: 'set', label: 'Pier', note: '', condition: false },
      ],
    },
    scenes: [{ sceneId: 's1', order: 0, prompt: 'waves', framePrompt: 'harbor at dawn', referenceImageId: null, videoHistoryId: null, takes: [] }],
  };

  it('carries authored character identity and source styles into actual frame requests', async () => {
    await openProject({ ...SPEC_PROJECT, concept: { ...SPEC_PROJECT.concept,
      universeStyle: 'Ink silhouettes', moodBoardStyle: 'Watercolor', subjects: [
        { id: 'lead', kind: 'character', role: 'protagonist', name: 'Example singer', description: 'Silver coat' },
      ],
    } });
    fireEvent.click(screen.getByRole('button', { name: /^Generate frame$/ }));
    await waitFor(() => expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('character (protagonist): Example singer — Silver coat'),
    }), { silent: true }));
    expect(generateImage.mock.calls[0][0].prompt).toContain('Mood board style: Watercolor');
    expect(generateImage.mock.calls[0][0].prompt).toContain('Universe style: Ink silhouettes');
  });

  it('sends flagged references as conditioning inputs and names the capability gap when the backend refuses them', async () => {
    generateImage.mockRejectedValueOnce(Object.assign(
      new Error('Reference images are only supported for FLUX.2 and Qwen Image 2.1 models on the local backend'),
      { code: 'REFERENCE_IMAGES_FLUX2_ONLY', status: 400 },
    ));
    await openProject(SPEC_PROJECT);
    fireEvent.click(screen.getByRole('button', { name: /^Generate frame$/ }));
    await waitFor(() => expect(generateImage).toHaveBeenCalledWith({
      prompt: 'harbor at dawn, grainy 16mm, color palette #112233; camera: locked-off wides',
      referenceImageFiles: ['mood.png'],
      musicVideo: { projectId: 'mv-spec', sceneId: 's1' },
    }, { silent: true }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      expect.stringMatching(/can't condition on 1 reference image: Reference images are only supported/),
    ));
  });

  it('keeps a new render as a candidate and lets the director explicitly pick and reject takes', async () => {
    const scene = {
      sceneId: 's1', order: 0, prompt: 'waves', referenceImageId: 'take-a.png', videoHistoryId: null,
      takes: [
        { takeId: 't-a', kind: 'image', assetId: 'take-a.png', source: 'generated', provider: 'portos', status: 'candidate', note: null },
        { takeId: 't-b', kind: 'image', assetId: 'take-b.png', source: 'imported', provider: 'midjourney', status: 'candidate', note: null },
      ],
    };
    selectMusicVideoSceneTake.mockResolvedValueOnce({ ...scene, referenceImageId: 'take-b.png' });
    reviewMusicVideoSceneTake.mockResolvedValueOnce({
      ...scene,
      referenceImageId: 'take-b.png',
      takes: [{ ...scene.takes[0], status: 'rejected' }, scene.takes[1]],
    });
    await openProject({ ...PROJECT_NO_CLIP, id: 'mv-takes', name: 'Takes Project', scenes: [scene] });

    const strip = screen.getByRole('list', { name: /Frame takes/ });
    expect(within(strip).getByText(/imported · midjourney/)).toBeTruthy();
    fireEvent.click(within(strip).getByRole('button', { name: /Use/ }));
    await waitFor(() => expect(selectMusicVideoSceneTake).toHaveBeenCalledWith('mv-takes', 's1', 't-b', { silent: true }));
    // The server's answer moves the selection; the other take now offers "Use".
    await waitFor(() => expect(within(strip).getAllByText(/Selected/)).toHaveLength(1));
    const items = within(strip).getAllByRole('listitem');
    expect(within(items[1]).queryByRole('button', { name: /Use/ })).toBeNull();

    fireEvent.click(within(items[0]).getByRole('button', { name: /Reject/ }));
    await waitFor(() => expect(reviewMusicVideoSceneTake).toHaveBeenCalledWith('mv-takes', 's1', 't-a', { status: 'rejected' }, { silent: true }));
    await waitFor(() => expect(within(items[0]).getByRole('button', { name: /Restore/ })).toBeTruthy());
  });

  it('imports externally generated files through the gallery upload, then associates them by scene tag with provider provenance', async () => {
    uploadGalleryImage.mockResolvedValueOnce({ filename: 'upload-0001.png', path: '/data/images/upload-0001.png' });
    const importedTake = { takeId: 't-mj', kind: 'image', assetId: 'upload-0001.png', source: 'imported', provider: 'midjourney', status: 'candidate', note: null, originalName: 'S01-s1-harbor.png' };
    importMusicVideoHandoff.mockResolvedValueOnce({
      project: { ...SPEC_PROJECT, scenes: [{ ...SPEC_PROJECT.scenes[0], referenceImageId: 'upload-0001.png', takes: [importedTake] }] },
      imported: [{ sceneId: 's1', takeId: 't-mj', kind: 'image', assetId: 'upload-0001.png', originalName: 'S01-s1-harbor.png' }],
      skipped: [],
    });
    await openProject(SPEC_PROJECT);

    const file = new File(['png-bytes'], 'S01-s1-harbor.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Import generated files'), { target: { files: [file] } });
    await waitFor(() => expect(importMusicVideoHandoff).toHaveBeenCalledWith('mv-spec', {
      provider: 'midjourney',
      items: [{ kind: 'image', assetId: 'upload-0001.png', originalName: 'S01-s1-harbor.png' }],
    }, { silent: true }));
    expect(uploadGalleryImage).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Imported 1 take from midjourney'));
    // The imported take filled the empty slot on the board.
    expect(await screen.findByRole('button', { name: 'View scene 1 reference frame full size' })).toBeTruthy();
  });

  it('downloads the ZIP handoff bundle from Export bundle (#8978)', async () => {
    getMusicVideoHandoffBundle.mockResolvedValueOnce(new ArrayBuffer(8));
    await openProject(SPEC_PROJECT);
    fireEvent.click(await screen.findByRole('button', { name: /^Export bundle$/ }));
    await waitFor(() => expect(getMusicVideoHandoffBundle).toHaveBeenCalledWith('mv-spec', { silent: true }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(
      expect.any(ArrayBuffer), 'spec-project-handoff.zip', 'application/zip',
    ));
  });
});

describe('MusicVideo pull references from universe (#8978)', () => {
  const UNIVERSE_PROJECT = {
    ...PROJECT_NO_CLIP,
    id: 'mv-universe',
    name: 'Universe Project',
    concept: { universeId: 'u1' },
    visualSpec: { references: [{ id: 'r0', imageId: 'harbor.png', role: 'mood', condition: false }] },
  };

  it('adds the universe\'s canon images as new references, skipping ones already present', async () => {
    getUniverse.mockResolvedValueOnce({
      characters: [{ id: 'c1', name: 'Nyra', primaryImageRef: 'nyra.png' }],
      places: [{ id: 'p1', name: 'Harbor', imageRefs: ['harbor.png'] }], // already a reference
      objects: [],
    });
    await openProject(UNIVERSE_PROJECT);

    fireEvent.click(await screen.findByRole('button', { name: /^Pull from universe$/ }));
    await waitFor(() => expect(getUniverse).toHaveBeenCalledWith('u1', { silent: true }));
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith(
      'mv-universe',
      { visualSpec: { references: [
        { id: 'r0', imageId: 'harbor.png', role: 'mood', condition: false },
        // Pulled references get their own client-minted id (not the server's
        // stable one yet) so multiple additions never collide on `undefined`.
        { id: expect.any(String), imageId: 'nyra.png', role: 'character', label: 'Nyra', condition: false },
      ] } },
      { silent: true },
    ));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/Pulled 1 reference/)));
  });

  it('is idempotent — a second pull adds nothing once every canon image is already a reference', async () => {
    getUniverse.mockResolvedValue({
      characters: [], places: [{ id: 'p1', name: 'Harbor', imageRefs: ['harbor.png'] }], objects: [],
    });
    await openProject(UNIVERSE_PROJECT);
    fireEvent.click(await screen.findByRole('button', { name: /^Pull from universe$/ }));
    await waitFor(() => expect(getUniverse).toHaveBeenCalledTimes(1));
    expect(updateMusicVideoProject).not.toHaveBeenCalled();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Every canon image is already a reference'));
  });

  it('applies the pull against the latest references, not a stale click-time snapshot (race guard)', async () => {
    let resolveUniverse;
    getUniverse.mockReturnValueOnce(new Promise((resolve) => { resolveUniverse = resolve; }));
    await openProject(UNIVERSE_PROJECT);

    fireEvent.click(await screen.findByRole('button', { name: /^Pull from universe$/ }));
    await waitFor(() => expect(getUniverse).toHaveBeenCalledTimes(1));

    // While the universe fetch is still in flight, remove the existing
    // reference — a stale click-time snapshot would resurrect it below.
    fireEvent.click(screen.getByRole('button', { name: 'Remove reference' }));
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith(
      'mv-universe', { visualSpec: { references: [] } }, { silent: true },
    ));

    await act(async () => {
      resolveUniverse({ characters: [{ id: 'c1', name: 'Nyra', primaryImageRef: 'nyra.png' }], places: [], objects: [] });
    });

    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenLastCalledWith(
      'mv-universe',
      { visualSpec: { references: [
        { id: expect.any(String), imageId: 'nyra.png', role: 'character', label: 'Nyra', condition: false },
      ] } },
      { silent: true },
    ));
  });

  it('does not offer Pull from universe when the project has no linked universe', async () => {
    await openProject(PROJECT_NO_CLIP);
    expect(screen.queryByRole('button', { name: /Pull from universe/i })).toBeNull();
  });
});

describe('MusicVideo per-scene clip import (#8978)', () => {
  it('imports a picked video-history clip as a candidate take for the scene, filling the empty slot', async () => {
    addMusicVideoSceneTake.mockResolvedValueOnce({
      scene: { ...PROJECT_NO_CLIP.scenes[0], videoHistoryId: 'rh-9', takes: [{ takeId: 't1', kind: 'video', assetId: 'rh-9', status: 'candidate' }] },
    });
    await openProject(PROJECT_NO_CLIP);

    fireEvent.click(await screen.findByRole('button', { name: /^Import clip take$/ }));
    const dialog = await screen.findByRole('dialog', { name: /Pick a video from your gallery/i });
    fireEvent.click(within(dialog).getByText('(no prompt)').closest('.bg-port-card').querySelector('button'));

    await waitFor(() => expect(addMusicVideoSceneTake).toHaveBeenCalledWith(
      'mv-2', 's1', { kind: 'video', assetId: 'rh-9', source: 'imported' }, { silent: true },
    ));
  });
});

describe('MusicVideo scene clip non-MP4 playback (#8978)', () => {
  afterEach(() => {
    // Restore the file-level default so later tests keep seeing the 404
    // (reconstruction-fallback) behavior for 'h1'/'h2'.
    getVideoHistoryItem.mockImplementation((id) => (id === 'rh-9'
      ? Promise.resolve({ id: 'rh-9', filename: 'final.mp4' })
      : Promise.reject(Object.assign(new Error('Not found'), { status: 404 }))));
  });

  it('resolves the clip\'s real stored filename for inline playback instead of assuming .mp4', async () => {
    getVideoHistoryItem.mockImplementation((id) => (id === 'h1'
      ? Promise.resolve({ id: 'h1', filename: 'h1.mov' })
      : Promise.reject(Object.assign(new Error('Not found'), { status: 404 }))));
    await openProject(PROJECT_WITH_CLIP);

    await waitFor(() => expect(document.querySelector('video[src="/data/videos/h1.mov"]')).toBeTruthy());
    expect(document.querySelector('video[src="/data/videos/h1.mp4"]')).toBeNull();
  });
});
