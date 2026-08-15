/**
 * Focused tests for the music-video Render control (#1760 Phase 2): the button
 * gates on a scene having a generated clip, and clicking it kicks off the render.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
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
  renderMusicVideoProject: vi.fn(async () => ({ jobId: 'job-1' })),
  musicVideoRenderEventsUrl: (jobId) => `/api/music-video/render/${jobId}/events`,
  cancelMusicVideoRender: vi.fn(async () => ({ ok: true })),
  transcribeMusicVideoMidi: vi.fn(async () => ({ jobId: 'midi-job-1', model: 'medium' })),
  musicVideoMidiEventsUrl: (jobId) => `/api/music-video/transcribe-midi/${jobId}/events`,
  cancelMusicVideoMidiTranscription: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../services/apiSystem.js', () => ({ generateImage: vi.fn() }));
vi.mock('../services/apiImageVideo.js', () => ({
  generateVideo: vi.fn(),
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
  // By-id resolver behind useVideoFileSrc (#4165) — 404s (rejects) for any
  // other id, exactly as the real endpoint does.
  getVideoHistoryItem: vi.fn(async (id) => (id === 'rh-9'
    ? { id: 'rh-9', filename: 'final.mp4' }
    : Promise.reject(Object.assign(new Error('Not found'), { status: 404 })))),
  // Restricted-model license gate — none of the models above carry a
  // `termsGate`, so the board renders no acceptance panel and nothing blocks.
  getVideoModelTerms: vi.fn(async () => ({ accepted: [] })),
  setVideoModelTerms: vi.fn(async () => ({ accepted: [] })),
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
vi.mock('../components/PageHeader', () => ({ default: ({ title }) => <div>{title}</div> }));

import MusicVideo from './MusicVideo.jsx';
import {
  listMusicVideoProjects, createMusicVideoProject, cloneMusicVideoProject, renderMusicVideoProject, planMusicVideoProject, updateMusicVideoProject,
  deleteMusicVideoProject, transcribeMusicVideoMidi,
} from '../services/apiMusicVideo.js';
import { importTrackFromYoutube, trackImportEventsUrl, listTracks } from '../services/apiTracks.js';
import { generateVideo, getVideoGenStatus } from '../services/apiImageVideo.js';

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

    const generate = await screen.findByRole('button', { name: /^Generate video$/ });
    await waitFor(() => expect(generate).toBeEnabled());
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
    const importBtns = screen.getAllByRole('button', { name: /Import/i });
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

    const createBtn = screen.getByRole('button', { name: /^Create$/ });
    expect(createBtn).toHaveProperty('disabled', true);
    fireEvent.click(createBtn);
    expect(createMusicVideoProject).not.toHaveBeenCalled();
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

  it('opens the lightbox from a ?preview= deep link on mount', async () => {
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP]);
    renderMVAt('/music-video/mv-1?preview=image%3Aimg1');
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    const dialog = await screen.findByRole('dialog', { name: /Media viewer/i });
    expect(dialog.getAttribute('aria-label')).toMatch(/img1|image:img1/);
  });
});
