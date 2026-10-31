/**
 * Focused tests for the music-video Render control (#1760 Phase 2): the button
 * gates on a scene having a generated clip, and clicking it kicks off the render.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('../hooks/useMediaUsages', () => ({ useMediaUsages: () => ({}), refreshMediaUsages: () => Promise.resolve() }));
vi.mock('../services/apiRunwayCatalog.js', async (importOriginal) => ({ ...await importOriginal(), loadRunwayCatalog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/apiMediaJobs.js', async (importOriginal) => ({ ...await importOriginal(), listQueueMediaJobs: vi.fn(async () => []) }));
import { listQueueMediaJobs } from '../services/apiMediaJobs.js';
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

// This page suite exercises existing controls with production approvals already granted.
// ProductionReviewPanel and route integration suites exercise the real approval refusals.
const feedbackCalls = vi.hoisted(() => ({ resolveFeedback: vi.fn(async () => null), syncLyricAnchors: vi.fn(async () => null), removeStaleRows: vi.fn(async () => null), revise: vi.fn(async () => ({ revision: { sceneIds: ['s-a'] } })) }));
vi.mock('../hooks/useMusicVideoProductionReview.js', () => ({ default: ({ project }) => ({
  ...feedbackCalls,
  readiness: project?.productionReadiness || { readyForProduction: true, basis: {}, art: { approved: true, problems: [] }, storyboard: { approved: true, problems: [] }, proof: { approved: true, problems: [] } },
  busy: false, error: null, proof: { active: false }, save: vi.fn(), prepare: vi.fn(), approve: vi.fn(), renderProof: vi.fn(),
}) }));

vi.mock('../services/apiMusicVideo.js', () => ({
  // Never settles: the create drawer's character-style list is covered in TrackSelectors.test.jsx.
  listMusicVideoCharacterStyles: vi.fn(() => new Promise(() => {})),
  getMusicVideoMakingOfCatalog: vi.fn(async id => ({ project: { id, name: 'Example making-of project', version: 1 }, snapshot: 'a'.repeat(64), assets: [] })),
  previewMusicVideoMakingOf: vi.fn(),
  exportMusicVideoMakingOf: vi.fn(),
  listMusicVideoProjects: vi.fn(async () => []),
  labelMusicVideoReferencesFromCatalog: vi.fn(async () => ({ labels: {} })),
  listMusicVideoProjectSummaries: vi.fn(async (params, options) => {
    const res = await listMusicVideoProjects(params, options);
    return Array.isArray(res) ? { items: res, total: res.length, nextCursor: null } : res;
  }),
  createMusicVideoProject: vi.fn(),
  cloneMusicVideoProject: vi.fn(),
  updateMusicVideoProject: vi.fn(async (id, patch) => ({
    id,
    ...patch,
    ...(patch.videoSettings ? { videoSettings: { backend: 'local', ...patch.videoSettings } } : {}),
  })),
  deleteMusicVideoProject: vi.fn(),
  analyzeMusicVideoProject: vi.fn(),
  prepareMusicVideoSong: vi.fn((id) => Promise.resolve({ project: { id }, analyzed: false, alignJobId: null })),
  getMusicVideoLyricOverlayPreview: vi.fn(() => new Promise(() => {})),
  planMusicVideoProject: vi.fn(),
  addMusicVideoScene: vi.fn(),
  updateMusicVideoScene: vi.fn(),
  deleteMusicVideoScene: vi.fn(),
  reorderMusicVideoScenes: vi.fn(),
  splitMusicVideoScene: vi.fn(),
  moveMusicVideoSceneStart: vi.fn(),
  importMusicVideoLyrics: vi.fn(),
  importMusicVideoTrackLyrics: vi.fn(),
  alignMusicVideoLyrics: vi.fn(),
  musicVideoLyricAlignEventsUrl: (jobId) => `/api/music-video/lyrics/align/${jobId}/events`,
  cancelMusicVideoLyricAlign: vi.fn(async () => ({ ok: true })),
  getMusicVideoActiveJobs: vi.fn(async () => ({ alignment: null, separation: null, midi: null })),
  separateMusicVideoVocals: vi.fn(async () => ({ jobId: 'sep-job-1' })),
  musicVideoVocalSeparationEventsUrl: (jobId) => `/api/music-video/vocal-stem/separate/${jobId}/events`,
  cancelMusicVideoVocalSeparation: vi.fn(async () => ({ ok: true })),
  getMusicVideoActiveRender: vi.fn(async () => ({ jobId: null })),
  getMusicVideoSharingCopy: vi.fn(async () => ({ copy: null, jobId: null })),
  prepareMusicVideoSharingCopy: vi.fn(async () => ({ jobId: 'sharing-example' })),
  musicVideoSharingCopyDownloadUrl: id => `/api/music-video/${id}/sharing-copy/download`,
  getMusicVideoSceneJobs: vi.fn(async () => ({ jobs: [] })),
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
  getMusicVideoStoryContext: vi.fn(),
  saveMusicVideoStorySummary: vi.fn(),
  proposeMusicVideoStory: vi.fn(),
  applyMusicVideoStory: vi.fn(),
  applyMusicVideoStoryBeats: vi.fn(),
  updateMusicVideoTreatment: vi.fn(),
  compileMusicVideoTreatment: vi.fn(),
  previewMusicVideoTreatmentApply: vi.fn(),
  applyMusicVideoTreatment: vi.fn(),
  reviewMusicVideoTreatmentProof: vi.fn(),
  renderMusicVideoExcerpt: vi.fn(async () => ({ jobId: 'mve-job-1', excerptId: 'mve-job-1' })),
  musicVideoExcerptRenderEventsUrl: (jobId) => `/api/music-video/excerpt/${jobId}/events`,
  inspectMusicVideoDcp: vi.fn(),
  buildMusicVideoDcp: vi.fn(),
  musicVideoDcpEventsUrl: (jobId) => `/api/music-video/dcp/${jobId}/events`,
  cancelMusicVideoDcp: vi.fn(),
  getMusicVideoDcpLocation: vi.fn(),
  musicVideoDcpReportUrl: (id, artifactId) => `/api/music-video/${id}/dcp/${artifactId}/report`,
  buildMusicVideoPublishKit: vi.fn(async () => ({ jobId: 'mvpk-job-1' })),
  musicVideoPublishKitEventsUrl: (jobId) => `/api/music-video/publish-kit/${jobId}/events`,
  cancelMusicVideoPublishKit: vi.fn(async () => ({ ok: true })),
  draftMusicVideoPublishCopy: vi.fn(),
  getMusicVideoFestivalPacket: vi.fn(async () => ({
    packet: { version: 1, fields: {}, rights: 'unknown', musicRights: 'unknown', consent: 'unknown', festivals: [], include: [] },
    fields: [{ id: 'title', label: 'Title', group: 'Film' }], festivalFields: [], rightsLabels: {}, suggestions: [],
    measurements: { status: 'unavailable' }, assets: { render: false, poster: false, still: false, captions: false },
  })),
  saveMusicVideoFestivalPacket: vi.fn(async (_id, packet) => ({ packet })),
  previewMusicVideoFestivalPacket: vi.fn(async () => ({ text: 'Festival submission packet', measurements: { status: 'unavailable' } })),
  getMusicVideoPromotionPlan: vi.fn(async () => ({ steps: [] })),
  planMusicVideoPromotion: vi.fn(),
  updateMusicVideoPublishCopy: vi.fn(),
  composeMusicVideoYoutubeThumbnail: vi.fn(),
  clearMusicVideoYoutubeThumbnail: vi.fn(),
  addMusicVideoThumbnailTest: vi.fn(),
  paintMusicVideoYoutubeThumbnail: vi.fn(),
  previewMusicVideoThumbnailPaint: vi.fn(),
  removeMusicVideoThumbnailTest: vi.fn(),
  prepareMusicVideoPublishDraft: vi.fn(),
  discardMusicVideoPublishDraft: vi.fn(),
  getMusicVideoPublishPlatforms: vi.fn(async () => ({ platforms: {}, history: {} })),
  getMusicVideoPublishDrafts: vi.fn(async () => ({ drafts: [] })),
  updateMusicVideoPublishPlatforms: vi.fn(),
  recordMusicVideoPublishPost: vi.fn(),
  cancelMusicVideoExcerptRender: vi.fn(async () => ({ ok: true })),
  deleteMusicVideoExcerpt: vi.fn(),
  addMusicVideoExcerptNote: vi.fn(),
  updateMusicVideoExcerptNote: vi.fn(),
  deleteMusicVideoExcerptNote: vi.fn(),
  getMusicVideoDependencyImpact: vi.fn(async () => ({ shots: [], evidence: [] })),
  startMusicVideoDependencyRepair: vi.fn(),
  startMusicVideoRevision: vi.fn(),
  resumeMusicVideoRevision: vi.fn(),
  cancelMusicVideoRevision: vi.fn(),
  getMusicVideoCodeDocument: vi.fn(async () => ({ html: '<!doctype html><html><body></body></html>', durationSec: 2, fps: 24, width: 1280, height: 720, song: { sections: [] }, timeline: { sections: [] } })),
  generateMusicVideoCode: vi.fn(),
  regenerateMusicVideoCodeSection: vi.fn(),
  startMusicVideoCastAndSets: vi.fn(),
  regenerateMusicVideoCastAndSets: vi.fn(),
  resumeMusicVideoCastAndSets: vi.fn(),
  approveMusicVideoCastAndSets: vi.fn(),
  skipMusicVideoCastAndSets: vi.fn(),
  musicVideoDevArtifactFileUrl: (id, artifactId, version) => `/api/music-video/${id}/dev-artifacts/${artifactId}/file${version ? `?version=${version}` : ''}`,
  uploadMusicVideoDevArtifact: vi.fn(),
  addMusicVideoDevArtifactNote: vi.fn(),
  resolveMusicVideoDevArtifactNote: vi.fn(),
  reviewMusicVideoDevArtifact: vi.fn(),
  deleteMusicVideoDevArtifact: vi.fn(),
  getMusicVideoCompositionDocument: vi.fn(),
  startMusicVideoCompositionTemplate: vi.fn(),
  importMusicVideoCompositionZip: vi.fn(),
  importMusicVideoCompositionDirectory: vi.fn(),
  getMusicVideoCompositionExport: vi.fn(),
  detachMusicVideoCompositionDocument: vi.fn(),
  startMusicVideoProduction: vi.fn(),
  resumeMusicVideoProduction: vi.fn(),
  stopMusicVideoProduction: vi.fn(),
  cancelMusicVideoProduction: vi.fn(),
}));
// Server pushes (production runs, the Cast & Sets check-in) arrive over the
// socket; tests deliver them through this registry.
const socketHandlers = vi.hoisted(() => new Map());
vi.mock('../services/socket', () => ({
  default: {
    on: (event, fn) => {
      if (!socketHandlers.has(event)) socketHandlers.set(event, new Set());
      socketHandlers.get(event).add(fn);
    },
    off: (event, fn) => { socketHandlers.get(event)?.delete(fn); },
    emit: (event, payload) => {
      if (event !== 'generated-preview:open') return;
      const sessionId = `00000000-0000-4000-8000-${String(socketHandlers.size + 1).padStart(12, '0')}`;
      const opened = {
        requestId: payload.requestId, sessionId, durationSec: 60, fps: 24, width: 1920, height: 1080, audio: 'none', revision: payload.revision,
      };
      for (const fn of socketHandlers.get('generated-preview:opened') || []) fn(opened);
      for (const fn of socketHandlers.get('generated-preview:frame') || []) fn({ ...opened, generation: 0, mime: 'image/jpeg', data: btoa('frame') });
    },
    connected: true,
  },
}));
const pushSocket = (event, payload) => act(async () => {
  for (const fn of socketHandlers.get(event) || []) fn(payload);
});
// The Compose stage's Film style picker reads the catalog from apiCodeAnimation.
vi.mock('../services/apiCodeAnimation.js', async (importOriginal) => ({
  ...(await importOriginal()),
  listFilmStyles: vi.fn(async () => []),
  getFilmStyle: vi.fn(async () => null),
}));
vi.mock('../services/apiUniverseBuilder.js', () => ({ getUniverse: vi.fn(), listUniverseNames: vi.fn(() => Promise.resolve([])) }));
vi.mock('../lib/downloadBlob.js', () => ({ downloadBlob: vi.fn() }));
vi.mock('../services/apiSystem.js', () => ({
  getInstances: vi.fn(async () => ({ peers: [] })),
  generateImage: vi.fn(async () => ({ status: 'queued', jobId: 'example-frame-job' })),
  uploadGalleryImage: vi.fn(),
  getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/apiMoodBoard.js', () => ({
  listMoodBoardNames: vi.fn(async () => []),
}));
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
  listImageModels: vi.fn(async () => []),
  getVideoGenModelContext: vi.fn(async () => null),
  generateVideo: vi.fn(),
  uploadGalleryVideo: vi.fn(),
  trimVideoStart: vi.fn(),
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
  importTrackFromSuno: vi.fn(async () => ({ jobId: 'suno-job-1' })),
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
  listMusicVideoProjects, listMusicVideoProjectSummaries, createMusicVideoProject, cloneMusicVideoProject, renderMusicVideoProject, planMusicVideoProject, updateMusicVideoProject,
  deleteMusicVideoProject, transcribeMusicVideoMidi, cancelMusicVideoRender, analyzeMusicVideoProject, prepareMusicVideoSong,
  importMusicVideoLyrics, importMusicVideoTrackLyrics, separateMusicVideoVocals, alignMusicVideoLyrics, updateMusicVideoScene, splitMusicVideoScene, moveMusicVideoSceneStart,
  selectMusicVideoSceneTake, reviewMusicVideoSceneTake, importMusicVideoHandoff,
  addMusicVideoSceneTake, getMusicVideoHandoffBundle, getMusicVideoFestivalPacket,
  renderMusicVideoExcerpt, deleteMusicVideoExcerpt, addMusicVideoExcerptNote,
  updateMusicVideoExcerptNote, deleteMusicVideoExcerptNote, getMusicVideoProject, getMusicVideoActiveRender, getMusicVideoActiveJobs,
  startMusicVideoRevision, resumeMusicVideoRevision, cancelMusicVideoRevision,
  startMusicVideoCastAndSets, approveMusicVideoCastAndSets, stopMusicVideoProduction,
  getMusicVideoPublishPlatforms, draftMusicVideoPublishCopy,
} from '../services/apiMusicVideo.js';
import { generateImage, uploadGalleryImage } from '../services/apiSystem.js';
import { importTrackFromYoutube, importTrackFromSuno, trackImportEventsUrl, listTracks } from '../services/apiTracks.js';
import { generateVideo, getVideoGenStatus, getVideoHistoryItem, trimVideoStart } from '../services/apiImageVideo.js';
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
const MV_ROUTES = (
  <Routes>
    <Route path="/music-video" element={<MusicVideo />} />
    <Route path="/music-video/:projectId" element={<MusicVideo />} />
    <Route path="/music-video/:projectId/:stage" element={<MusicVideo />} />
    <Route path="/music-video/:projectId/:stage/scene/:sceneId" element={<MusicVideo />} />
    <Route path="/music-video/:projectId/scene/:sceneId" element={<MusicVideo />} />
    <Route path="/music-video/:projectId/dev/:artifactId" element={<MusicVideo />} />
    <Route path="/music-video/:projectId/:stage/dev/:artifactId" element={<MusicVideo />} />
  </Routes>
);
const renderMV = () => render(
  <MemoryRouter initialEntries={['/music-video']}>{MV_ROUTES}</MemoryRouter>,
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
  // The project workspace remounts per project, so its mount-time loads
  // (publish platforms, drafts, the final-render lookup) are settled here
  // rather than landing after the test body.
  await settle();
  return picker;
};

// The page is a set of steps (deep-linked as /music-video/:id/:stage); a
// control is only on screen while its step is open, so tests say which one.
// Compose is part of Shots now; Plan holds the planning tools. The phone's step bar is the tablist.
const STAGE_TABS = {
  setup: /^Song/, story: /^Story(?!board)/, 'cast-sets': /^Look/, board: /^Storyboard/, produce: /^Shots/, compose: /^Shots/, review: /^Final render/, publish: /^Publish/,
};
// Project settings (render style, audio tools, autopilot, files) is a drawer over the step.
const openSettings = async (tab = 'Project') => {
  fireEvent.click(screen.getByRole('button', { name: 'Project settings' }));
  const drawerTab = await screen.findByRole('tab', { name: new RegExp(`^${tab}`) });
  fireEvent.click(drawerTab);
};
const closeSettings = () => fireEvent.click(screen.getByRole('button', { name: 'Close project settings' }));
const openStage = async (stage, selectFirstScene = true) => {
  const tab = await screen.findByRole('tab', { name: STAGE_TABS[stage] });
  fireEvent.click(tab);
  await waitFor(() => expect(screen.getByRole('tab', { name: STAGE_TABS[stage] })).toHaveAttribute('aria-selected', 'true'));
  // Scene controls now belong to one URL-selected inspector. The existing
  // generation/edit tests enter it through the visible thumbnail first.
  if (stage === 'produce' && selectFirstScene) {
    const thumbnails = screen.getByLabelText('Storyboard thumbnails');
    const first = within(thumbnails).queryAllByRole('button')[0];
    if (first) await act(async () => { fireEvent.click(first); });
  }
};

const openProject = async (project, stage = null) => {
  listMusicVideoProjects.mockResolvedValue([project]);
  renderMV();
  await selectProject(project.id);
  await screen.findByRole('heading', { level: 2, name: project.name });
  if (stage) await openStage(stage);
};

// The header hides New project / Autonomous while a project is open, so step
// back to the project list via the picker first.
const clickNewProject = async () => {
  const picker = screen.getByLabelText('Project');
  const previous = picker.value;
  if (!screen.queryByRole('button', { name: /New project/i })) {
    fireEvent.change(picker, { target: { value: '' } });
  }
  fireEvent.click(await screen.findByRole('button', { name: /New project/i }));
  // Keep the drawer open and return to the project the test was on.
  if (previous) fireEvent.change(picker, { target: { value: previous } });
};

const openCreateForm = clickNewProject;

// Mocked useSseProgress mutates shared state without re-rendering; toggling the
// rename form is a harmless page-level state change that forces a render.
const forceRerender = () => {
  fireEvent.click(screen.getByRole('button', { name: /^Rename v\d+$/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
};

// Probes/harness for the URL-nav backstop test: a location readout plus a
// button that navigates via the router (standing in for a deep link / browser
// Back / ⌘K jump, which bypass the in-app selectProject guard).
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}{loc.hash}</div>;
}
function NavTo({ to }) {
  const navigate = useNavigate();
  return <button onClick={() => navigate(to)}>{`go-${to}`}</button>;
}
const renderMVWithNav = (to) => render(
  <MemoryRouter initialEntries={['/music-video']}>
    <LocationProbe />
    <NavTo to={to} />
    {MV_ROUTES}
  </MemoryRouter>,
);

afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  // Keep the real artifact iframe and src assertions without navigating to its API URL.
  window.happyDOM.settings.navigation.disableChildFrameNavigation = true;
  vi.clearAllMocks();
  listMusicVideoProjects.mockReset();
  listMusicVideoProjects.mockResolvedValue([]);
  listMusicVideoProjectSummaries.mockReset();
  listMusicVideoProjectSummaries.mockImplementation(async (params, options) => {
    const res = await listMusicVideoProjects(params, options);
    return Array.isArray(res) ? { items: res, total: res.length, nextCursor: null } : res;
  });
  getMusicVideoProject.mockReset();
  getMusicVideoProject.mockImplementation(async id => (await listMusicVideoProjects({ silent: true })).find(project => project.id === id));
  sseState.latest = null;
  sseState.closed = false;
  sseState.isOpen = true;
  ytSseStates.clear();
});

// The shot editor shows the frames or the clip, one at a time.
const showFrames = async () => fireEvent.click(within(await screen.findByRole('group', { name: 'Show' })).getByRole('button', { name: /^(Still|Frames)$/ }));

describe('MusicVideo project load recovery (#9761)', () => {
  it.each(['/music-video', '/music-video/mv-2/board'])('keeps failures visible and recovers without changing %s', async (path) => {
    let resolveRetry;
    listMusicVideoProjects
      .mockRejectedValueOnce(new Error('Connection unavailable'))
      .mockRejectedValueOnce(new Error('Still unavailable'))
      .mockImplementationOnce(() => new Promise(resolve => { resolveRetry = resolve; }));
    render(
      <MemoryRouter initialEntries={[path]}>
        <LocationProbe />
        {MV_ROUTES}
      </MemoryRouter>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Connection unavailable');
    expect(screen.queryByText(/No music video projects yet/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Project not found/)).not.toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent(path);
    if (path === '/music-video') {
      expect(listMusicVideoProjectSummaries).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 30 }),
        expect.objectContaining({ silent: true }),
      );
    } else {
      expect(getMusicVideoProject).toHaveBeenCalledWith('mv-2', { silent: true });
    }

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Still unavailable'));
    const retry = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    expect(screen.getByRole('button', { name: 'Retrying…' })).toBeDisabled();
    fireEvent.click(retry);
    expect(path === '/music-video' ? listMusicVideoProjectSummaries : getMusicVideoProject).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(/No music video projects yet/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Project not found/)).not.toBeInTheDocument();

    await act(async () => resolveRetry([PROJECT_NO_CLIP]));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent(path);
    if (path === '/music-video') {
      expect(screen.getByTestId('mv-project-grid')).toHaveTextContent(PROJECT_NO_CLIP.name);
    } else {
      expect(screen.getByRole('heading', { level: 2, name: PROJECT_NO_CLIP.name })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /^Storyboard/ })).toHaveAttribute('aria-selected', 'true');
    }
  });

  it.each([
    ['/music-video', /No music video projects yet/],
    ['/music-video/missing-project', /Project not found/],
  ])('shows absence only after a successful read at %s', async (path, message) => {
    listMusicVideoProjects.mockResolvedValue(path === '/music-video' ? [] : [PROJECT_NO_CLIP]);
    render(<MemoryRouter initialEntries={[path]}>{MV_ROUTES}</MemoryRouter>);
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });
});

describe('MusicVideo stage-only nav URLs (#10303)', () => {
  it('/music-video/board redirects to the newest project at that stage', async () => {
    listMusicVideoProjects.mockResolvedValue([
      { ...PROJECT_NO_CLIP, updatedAt: '2026-01-01T00:00:00Z' },
      { ...PROJECT_WITH_CLIP, updatedAt: '2026-02-01T00:00:00Z' },
    ]);
    getMusicVideoProject.mockResolvedValue(PROJECT_WITH_CLIP);
    render(
      <MemoryRouter initialEntries={['/music-video/board']}>
        <LocationProbe />
        {MV_ROUTES}
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/music-video/mv-1/board'));
    expect(screen.queryByText(/Project not found/)).not.toBeInTheDocument();
  });

  it('falls back to the project list when there are no projects', async () => {
    listMusicVideoProjects.mockResolvedValue([]);
    render(
      <MemoryRouter initialEntries={['/music-video/produce']}>
        <LocationProbe />
        {MV_ROUTES}
      </MemoryRouter>,
    );
    expect(await screen.findByText(/No music video projects yet/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/music-video$/));
    expect(screen.queryByText(/Project not found/)).not.toBeInTheDocument();
  });
});

describe('MusicVideo bounded summary index and project isolation (#10169)', () => {
  it('opening /music-video/:id makes one project GET and no full-list call', async () => {
    getMusicVideoProject.mockResolvedValue(PROJECT_WITH_CLIP);
    render(
      <MemoryRouter initialEntries={['/music-video/mv-1/board']}>
        {MV_ROUTES}
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    expect(getMusicVideoProject).toHaveBeenCalledTimes(1);
    expect(getMusicVideoProject).toHaveBeenCalledWith('mv-1', { silent: true });
    expect(listMusicVideoProjects).not.toHaveBeenCalled();
    expect(listMusicVideoProjectSummaries).not.toHaveBeenCalled();
  });

  it('the index view loads summaries with cursor pagination', async () => {
    listMusicVideoProjectSummaries.mockResolvedValue({
      items: [
        {
          id: 'mv-summary-1',
          name: 'Summary Video',
          version: 1,
          rootProjectId: 'mv-summary-1',
          versionRoot: 'mv-summary-1',
          stage: 'board',
          status: 'ready',
          runStatus: null,
          poster: null,
          preview: { kind: 'none', label: 'No render yet' },
          spend: { spentUsd: 0, capUsd: null },
          updatedAt: '2026-10-04T00:00:00Z',
          sceneCount: 3,
          shotSummary: '3 scenes',
        },
      ],
      total: 1,
      nextCursor: null,
    });
    render(
      <MemoryRouter initialEntries={['/music-video']}>
        {MV_ROUTES}
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('mv-project-grid')).toHaveTextContent('Summary Video');
    expect(listMusicVideoProjectSummaries).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 30 }),
      expect.anything(),
    );
  });

  it('a list failure does not break an open project', async () => {
    getMusicVideoProject.mockResolvedValue(PROJECT_WITH_CLIP);
    listMusicVideoProjectSummaries.mockRejectedValueOnce(new Error('List network failure'));
    listMusicVideoProjects.mockRejectedValueOnce(new Error('List network failure'));
    render(
      <MemoryRouter initialEntries={['/music-video/mv-1/board']}>
        {MV_ROUTES}
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name })).toBeInTheDocument();
  });
});

describe('MusicVideo per-project workspace (#12039)', () => {
  it('remounts the workspace per project, so switching projects starts from fresh per-project state', async () => {
    const other = { ...PROJECT_WITH_CLIP, id: 'mv-other', name: 'Other Project' };
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP, other]);
    renderMV();
    await selectProject(PROJECT_WITH_CLIP.id);
    await openStage('setup');
    // Song is not reviewed by watching, so the preview starts folded; opening
    // it is per-project state that used to be reset by a selection effect.
    fireEvent.click(screen.getByRole('button', { name: 'Expand preview' }));
    expect(screen.getByRole('button', { name: 'Collapse preview' })).toBeInTheDocument();

    await selectProject(other.id);
    await openStage('setup');
    expect(screen.getByRole('button', { name: 'Expand preview' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Collapse preview' })).not.toBeInTheDocument();

    // Coming back starts fresh too: nothing from the first visit is carried over.
    await selectProject(PROJECT_WITH_CLIP.id);
    await openStage('setup');
    expect(screen.getByRole('button', { name: 'Expand preview' })).toBeInTheDocument();
  });
});

describe('MusicVideo music library load state (#12040)', () => {
  it('shows a failed library read with Retry in the create form, then the tracks once the retry lands', async () => {
    listTracks.mockRejectedValueOnce(new Error('library offline'));
    renderMV();
    fireEvent.click(await screen.findByRole('button', { name: /New project/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the music library — library offline');
    expect(screen.queryByText(/No tracks in the music library yet/)).not.toBeInTheDocument();

    listTracks.mockResolvedValueOnce([{ id: 't-example', title: 'Example Track' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('option', { name: /Example Track/ })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the empty copy for a genuinely empty library, not an error', async () => {
    renderMV();
    fireEvent.click(await screen.findByRole('button', { name: /New project/i }));
    expect(await screen.findByText(/No tracks in the music library yet/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('MusicVideo project header', () => {
  it('keeps only the picker beside the page title inside a project; fork and delete live in Project settings', async () => {
    await openProject(PROJECT_WITH_CLIP);
    expect(screen.queryByRole('button', { name: /New project/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Autonomous/i })).toBeNull();
    expect(screen.queryByText(/^Project actions/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete project' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Fork/ })).toBeNull();
    await openSettings('Project');
    expect(screen.getByRole('button', { name: 'Delete project' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fork v2' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fork for video generation' })).toBeTruthy();
  });
});

describe('MusicVideo version title', () => {
  it('renames the open version from the pencil beside its title', async () => {
    await openProject(PROJECT_WITH_CLIP);
    fireEvent.click(screen.getByRole('button', { name: 'Rename v1' }));
    // The editor takes the title's place, so the old heading is gone while editing.
    expect(screen.queryByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name })).toBeNull();
    updateMusicVideoProject.mockImplementationOnce(async (_id, patch) => ({ ...PROJECT_WITH_CLIP, ...patch }));
    fireEvent.change(screen.getByLabelText('Project title'), { target: { value: 'Title Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('heading', { level: 2, name: 'Title Renamed' });
  });
});

describe('MusicVideo render control (#1760)', () => {
  it('enables Render and kicks off the job when a scene has a clip', async () => {
    await openProject(PROJECT_WITH_CLIP, 'review');
    const renderBtn = await screen.findByRole('button', { name: /^Render final$/ });
    expect(renderBtn).toHaveProperty('disabled', false);

    fireEvent.click(renderBtn);
    await waitFor(() => expect(renderMusicVideoProject).toHaveBeenCalledWith('mv-1', { silent: true }));
  });

  it('reloads the project when render finishes so stale render status clears and new render loads', async () => {
    const staleProject = {
      ...PROJECT_WITH_CLIP,
      renderHistoryId: 'rh-old',
      renderDependencyState: { status: 'stale', reasons: ['Scene clip changed'] },
    };
    const freshProject = {
      ...PROJECT_WITH_CLIP,
      renderHistoryId: 'rh-new',
      status: 'complete',
      renderDependencyState: { status: 'current', reasons: [] },
    };
    let currentProject = staleProject;
    getMusicVideoProject.mockImplementation(async (id) => (id === staleProject.id ? currentProject : null));
    await openProject(staleProject, 'review');
    expect(screen.getAllByText(/Final render is out of date/i).length).toBeGreaterThan(0);

    sseState.latest = null;
    currentProject = freshProject;
    fireEvent.click(screen.getByRole('button', { name: /^Render final$/ }));
    await screen.findAllByRole('button', { name: 'Cancel render' });

    sseState.latest = { type: 'complete', result: { id: 'rh-new' } };
    forceRerender();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Music video rendered'));
    await waitFor(() => expect(getMusicVideoProject).toHaveBeenCalledWith(staleProject.id, { silent: true }));
    await waitFor(() => expect(screen.queryAllByText(/Final render is out of date/i)).toHaveLength(0));
  });

  it('reserves preparation across project navigation and applies completion to the captured project', async () => {
    const other = { ...PROJECT_WITH_CLIP, id: 'mv-other', name: 'Other Project' };
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP, other]);
    let resolveKickoff;
    renderMusicVideoProject.mockImplementationOnce(() => new Promise((resolve) => { resolveKickoff = resolve; }));
    renderMV();
    await selectProject(PROJECT_WITH_CLIP.id);
    await openStage('review');

    fireEvent.click(screen.getByRole('button', { name: /^Render final$/ }));
    expect(screen.getByText('Preparing render…')).toBeInTheDocument();
    // No job id yet, so there is nothing to stop.
    expect(screen.queryByRole('button', { name: 'Cancel render' })).not.toBeInTheDocument();
    await openStage('setup');
    expect(screen.getByLabelText('Change track')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Change track'), { target: { value: 'other-track' } });
    expect(updateMusicVideoProject).not.toHaveBeenCalled();

    await selectProject(other.id);
    await openStage('review');
    const otherRender = screen.getByRole('button', { name: 'Rendering another project…' });
    expect(otherRender).toBeDisabled();
    fireEvent.click(otherRender);
    expect(renderMusicVideoProject).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Cancel render' })).not.toBeInTheDocument();
    await openStage('setup');
    expect(screen.getByLabelText('Change track')).not.toBeDisabled();

    await act(async () => { resolveKickoff({ jobId: 'render-first' }); });
    sseState.latest = { type: 'progress', progress: 0.375 };
    await selectProject(PROJECT_WITH_CLIP.id);
    await openStage('review');
    expect(screen.getByText('Rendering 38%')).toBeInTheDocument();
    // The header offers no second render while this one is in flight — it shows the progress.
    expect(screen.getByRole('button', { name: 'Rendering… 38%' })).toBeDisabled();
    await openStage('setup');
    expect(screen.getByLabelText('Change track')).toBeDisabled();

    // A metadata frame omits progress; the final-render adapter keeps 38%.
    sseState.latest = { type: 'status', message: 'Finishing output' };
    await clickNewProject();
    await openStage('review');
    expect(screen.getByText('Rendering 38%')).toBeInTheDocument();
    await selectProject(other.id);
    sseState.latest = { type: 'complete', result: { id: 'rh-9' } };
    // The server persists the render result before it emits the terminal
    // frame; the project is read back whole when it is next opened.
    listMusicVideoProjects.mockResolvedValue([{ ...PROJECT_WITH_CLIP, renderHistoryId: 'rh-9' }, other]);
    fireEvent.change(screen.getByPlaceholderText('Project name'), { target: { value: 'Unrelated draft' } });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Music video rendered'));
    await openStage('review');
    expect(screen.queryByText(/Open in Media History/i)).not.toBeInTheDocument();
    await selectProject(PROJECT_WITH_CLIP.id);
    await openStage('review');
    expect(screen.getByText(/Open in Media History/i).closest('a')).toHaveAttribute('href', expect.stringContaining('preview=video%3Arh-9'));
  });

  it('recovers from a preparing 409 and attaches/cancels an existing render with a job id', async () => {
    renderMusicVideoProject
      .mockRejectedValueOnce(Object.assign(new Error('Render is still preparing'), { status: 409, context: { jobId: null } }))
      .mockRejectedValueOnce(Object.assign(new Error('Render already exists'), { status: 409, context: { jobId: 'existing-render' } }));
    await openProject(PROJECT_WITH_CLIP, 'review');
    fireEvent.click(screen.getByRole('button', { name: /^Render final$/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Render is still preparing'));
    expect(screen.getByRole('button', { name: /^Render final$/ })).toBeEnabled();
    await openStage('setup');
    expect(screen.getByLabelText('Change track')).toBeEnabled();
    await openStage('review');

    fireEvent.click(screen.getByRole('button', { name: /^Render final$/ }));
    // Stopping discards the partial render, so the first tap only asks.
    fireEvent.click((await screen.findAllByRole('button', { name: 'Cancel render' }))[0]);
    expect(cancelMusicVideoRender).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop the render' }));
    expect(cancelMusicVideoRender).toHaveBeenCalledWith('existing-render', { silent: true });
    await waitFor(() => expect(screen.getAllByText('Stopping…').length).toBeGreaterThan(0));
    expect(toast.error).toHaveBeenCalledTimes(1);
    sseState.latest = { type: 'canceled' };
    forceRerender();
    expect(toast.info).toHaveBeenCalledWith('Render cancelled');
    // A cancelled render says nothing about the project's status: the page asks the server (#9940).
    await waitFor(() => expect(getMusicVideoProject).toHaveBeenCalledWith('mv-1', { silent: true }));
    expect(screen.getByRole('button', { name: /^Render final$/ })).toBeEnabled();
  });

  it('attributes a render failure after navigation and releases the slot after a dropped stream', async () => {
    const other = { ...PROJECT_WITH_CLIP, id: 'mv-other', name: 'Other Project' };
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP, other]);
    renderMV();
    await selectProject(PROJECT_WITH_CLIP.id);
    await openStage('review');
    fireEvent.click(screen.getByRole('button', { name: /^Render final$/ }));
    await screen.findAllByRole('button', { name: 'Cancel render' });
    await selectProject(other.id);
    await openStage('review');
    sseState.latest = { type: 'error', error: 'Renderer stopped' };
    await clickNewProject();
    expect(toast.error).toHaveBeenCalledWith('Renderer stopped');
    // The picker shows only the project name: no status word or shot counts. The failure stays on mv-1.
    const picker = screen.getByLabelText('Project');
    expect(picker.querySelector('option[value="mv-1"]').textContent).toBe(PROJECT_WITH_CLIP.name);
    expect(picker.querySelector('option[value="mv-other"]').textContent).toBe(other.name);
    expect(screen.queryByText('Renderer stopped')).not.toBeInTheDocument();
    await selectProject(PROJECT_WITH_CLIP.id);
    await openStage('review');
    expect(screen.getByText('Renderer stopped')).toBeInTheDocument();
    await openStage('compose');
    expect(screen.getByText('Renderer stopped')).toBeInTheDocument();
    await selectProject(other.id);
    await openStage('review');


    sseState.latest = null;
    fireEvent.click(screen.getByRole('button', { name: /^Render final$/ }));
    await screen.findAllByRole('button', { name: 'Cancel render' });
    sseState.latest = { type: 'progress', progress: 0.4 };
    fireEvent.change(screen.getByPlaceholderText('Project name'), { target: { value: 'Draft' } });
    sseState.closed = true;
    fireEvent.change(screen.getByPlaceholderText('Project name'), { target: { value: 'Draft updated' } });
    expect(toast.info).toHaveBeenCalledWith('Lost connection to the render — check Media History for the result');
    await waitFor(() => expect(getMusicVideoProject).toHaveBeenCalledWith('mv-other', { silent: true }));
    expect(screen.getByRole('button', { name: /^Render final$/ })).toBeEnabled();
  });

  it('re-attaches a live final render on load without a Render click (#9940)', async () => {
    getMusicVideoActiveRender.mockResolvedValue({ jobId: 'render-live' });
    sseState.latest = { type: 'progress', progress: 0.5 };
    await openProject({ ...PROJECT_WITH_CLIP, status: 'rendering' }, 'review');
    await screen.findAllByRole('button', { name: 'Cancel render' });
    await waitFor(() => expect(screen.getByText('Rendering 50%')).toBeInTheDocument());
    expect(getMusicVideoActiveRender).toHaveBeenCalledWith('mv-1', { silent: true });
    // A page load only READS the render — it never starts one.
    expect(renderMusicVideoProject).not.toHaveBeenCalled();
    // It is on screen, so the header does not flag it as an unwatched render.
    expect(screen.queryByRole('button', { name: 'Reattach to the final render' })).not.toBeInTheDocument();
  });

  it('flags a rendering project nobody is watching and reattaches on request (#9940)', async () => {
    getMusicVideoActiveRender.mockResolvedValueOnce({ jobId: null }).mockResolvedValueOnce({ jobId: 'render-late' });
    sseState.latest = { type: 'progress', progress: 0.25 };
    await openProject({ ...PROJECT_WITH_CLIP, status: 'rendering' }, 'review');
    const reattach = await screen.findByRole('button', { name: 'Reattach to the final render' });
    fireEvent.click(reattach);
    await screen.findAllByRole('button', { name: 'Cancel render' });
    await waitFor(() => expect(screen.getByText('Rendering 25%')).toBeInTheDocument());
    expect(renderMusicVideoProject).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reattach to the final render' })).not.toBeInTheDocument());
  });

  it('disables Render when no scene has a generated clip', async () => {
    await openProject(PROJECT_NO_CLIP, 'review');
    const renderBtn = await screen.findByRole('button', { name: /^Render final$/ });
    expect(renderBtn).toHaveProperty('disabled', true);
  });

  it('keeps full-quality and sharing controls together in the final render section', async () => {
    await openProject({ ...PROJECT_WITH_CLIP, renderHistoryId: 'rh-9' }, 'review');
    const fullQuality = await screen.findByRole('link', { name: /Download MP4/i });
    const sharing = await screen.findByRole('button', { name: 'Prepare sharing copy' });
    const section = fullQuality.closest('#mv-final-video');
    expect(section).toHaveAccessibleName('Final render');
    expect(section).toContainElement(sharing);
    expect(sharing).toHaveClass('min-h-[44px]');
    const link = await screen.findByText(/Open in Media History/i);
    // Media History matches video items by their `video:<id>` key via ?preview=.
    expect(link.closest('a').getAttribute('href')).toContain('preview=video%3Arh-9');
  });
});

describe('MusicVideo needs-attention banner (#9940)', () => {
  const stranded = {
    ...PROJECT_WITH_CLIP,
    revisions: [{ id: 'mvrev-1', status: 'open', sections: [{ sceneId: 's1', kind: 'video', verdict: 'rejected', layer: 'footage' }] }],
  };

  it('keeps a stranded revision\'s Resume and Cancel in the header on every stage after a reload', async () => {
    resumeMusicVideoRevision.mockResolvedValue({ project: stranded, revision: stranded.revisions[0], needsGeneration: [], generating: [] });
    cancelMusicVideoRevision.mockResolvedValue({ project: { ...stranded, revisions: [{ ...stranded.revisions[0], status: 'canceled' }] }, canceledJobIds: [] });
    await openProject(stranded, 'produce');
    const banner = await screen.findByRole('region', { name: 'Needs attention' });
    expect(banner).toHaveTextContent('A section revision is open');
    await openStage('review');
    expect(screen.getByRole('region', { name: 'Needs attention' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Resume the open revision' }));
    await waitFor(() => expect(resumeMusicVideoRevision).toHaveBeenCalledWith('mv-1', 'mvrev-1', { silent: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel the open revision' }));
    await waitFor(() => expect(cancelMusicVideoRevision).toHaveBeenCalledWith('mv-1', 'mvrev-1', { silent: true }));
    // Cancelling clears the banner: production is unblocked.
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Needs attention' })).not.toBeInTheDocument());
  });

  it('shows no banner for a healthy project', async () => {
    await openProject(PROJECT_WITH_CLIP, 'produce');
    expect(screen.queryByRole('region', { name: 'Needs attention' })).not.toBeInTheDocument();
  });
});

describe('MusicVideo draft excerpt render (#8986)', () => {
  it('kicks off an excerpt render with the typed range and shows progress', async () => {
    await openProject(PROJECT_WITH_CLIP, 'review');
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
    forceRerender();
    await screen.findByText(/Rendering draft — 50%/);
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
    await openProject(PROJECT_WITH_CLIP, 'review');
    fireEvent.click(screen.getByRole('button', { name: /Render excerpt/i }));
    await waitFor(() => expect(renderMusicVideoExcerpt).toHaveBeenCalled());
    await settle();
    sseState.latest = { type: 'complete', result: { excerptId: 'mve-1', filename: 'excerpt-1.mp4' } };
    forceRerender();

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
    await openProject(project, 'review');

    fireEvent.change(screen.getByLabelText('New review note'), { target: { value: 'looks great' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(addMusicVideoExcerptNote).toHaveBeenCalledWith('mv-1', 'mve-1', { atSec: 0, note: 'looks great' }, { silent: true }));
    await screen.findByText('looks great');

    updateMusicVideoExcerptNote.mockResolvedValue({
      project: { ...project, excerpts: [{ ...project.excerpts[0], notes: [{ id: 'mvn-1', atSec: 0, note: 'looks great', verdict: 'approved' }] }] },
      note: { id: 'mvn-1', atSec: 0, note: 'looks great', verdict: 'approved' },
    });
    // A note can render before the add action clears its in-flight gate.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Looks good' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Looks good' }));
    await waitFor(() => expect(updateMusicVideoExcerptNote).toHaveBeenCalledWith('mv-1', 'mve-1', 'mvn-1', { verdict: 'approved' }, { silent: true }));

    deleteMusicVideoExcerptNote.mockResolvedValue({ ...project, excerpts: [{ ...project.excerpts[0], notes: [] }] });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete note' })).toBeEnabled());
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
    await openProject(project, 'review');
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
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
    await openProject(REVIEWED, 'review');

    fireEvent.click(await findEnabledByRole('button', { name: /Revise flagged/i }));
    await waitFor(() => expect(resumeMusicVideoRevision).toHaveBeenCalledWith('mv-1', 'mvr-1', { silent: true }));
    expect(startMusicVideoRevision).toHaveBeenCalledWith('mv-1', 'mve-1', {}, { silent: true });
    await waitFor(() => expect(generateVideo).toHaveBeenCalledTimes(1));
    expect(JSON.parse(generateVideo.mock.calls[0][0].musicVideo)).toEqual({ projectId: 'mv-1', sceneId: 's2', revisionId: 'mvr-1', compose: true });
    const panel = screen.getByLabelText('Section revision');
    expect(within(panel).getByText('Kept')).toBeInTheDocument();
  });

  it('resuming once every revised section has a take re-renders the draft without any paid generation', async () => {
    const ready = withRevision('h2-new');
    resumeMusicVideoRevision.mockResolvedValue({
      project: { ...ready, revisions: [{ ...ready.revisions[0], status: 'rendering', renderExcerptId: 'mve-2' }] },
      revision: { ...ready.revisions[0], status: 'rendering' }, needsGeneration: [], generating: [], render: { jobId: 'mve-2', excerptId: 'mve-2' },
    });
    await openProject(ready, 'review');

    fireEvent.click(await findEnabledByRole('button', { name: /Render revised draft/i }));
    await waitFor(() => expect(resumeMusicVideoRevision).toHaveBeenCalledWith('mv-1', 'mvr-1', { silent: true }));
    await screen.findByText(/Rendering draft/);
    expect(generateVideo).not.toHaveBeenCalled();
    expect(generateImage).not.toHaveBeenCalled();
  });

  it('cancels an open revision', async () => {
    const open = withRevision(null);
    cancelMusicVideoRevision.mockResolvedValue({ project: { ...open, revisions: [{ ...open.revisions[0], status: 'canceled' }] }, revision: { ...open.revisions[0], status: 'canceled' } });
    await openProject(open, 'review');
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
    await openSettings('Project');

    expect(await screen.findByLabelText('Scene video renderer')).toHaveProperty('value', '');
    closeSettings();
    await openStage('produce');
    fireEvent.click(screen.getByRole('button', { name: /^Render$/ }));
    await waitFor(() => expect(generateVideo).toHaveBeenCalled());
    expect(generateVideo.mock.calls.at(-1)[0]).not.toHaveProperty('backend');
    expect(generateVideo.mock.calls.at(-1)[0]).not.toHaveProperty('modelId');
  });

  it('clears an existing backend pin with the Install default option', async () => {
    await openProject(PROJECT_NO_CLIP);
    await openSettings('Project');

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
    await openSettings('Project');

    const model = await screen.findByLabelText('Local video model');
    fireEvent.change(model, { target: { value: 'ltx23_distilled_q4' } });
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith(
      'mv-2',
      { videoSettings: { modelId: 'ltx23_distilled_q4' } },
      { silent: true },
    ));

    closeSettings();
    await openStage('produce');
    fireEvent.click(screen.getByRole('button', { name: /^Render$/ }));
    await waitFor(() => expect(generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      backend: 'local',
      modelId: 'ltx23_distilled_q4',
      mode: 'image',
      sourceImageFile: 'img1',
    })));
  });

  it('continues an existing scene through the local model native extend mode', async () => {
    generateVideo.mockResolvedValue({ jobId: 'video-job-2' });
    await openProject(PROJECT_WITH_CLIP, 'produce');

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
    await openSettings('Project');

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

    closeSettings();
    await openStage('produce');
    fireEvent.click(screen.getByRole('button', { name: /^Render$/ }));
    await waitFor(() => expect(generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      backend: 'local',
      modelId: 'ltx23_distilled_q4',
      mode: 'a2v',
      sourceImageFile: 'img1',
      audioStartSec: 0,
      disableAudio: true,
      loraFilenames: ['audio-reactive-v2.safetensors'],
      loraScales: [1.2],
    })));
    // The server adds the audio-reactive guard as a labeled addition.
    expect(JSON.parse(generateVideo.mock.calls.at(-1)[0].musicVideo)).toMatchObject({ compose: true, audioReactive: true });
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
    await openSettings('Project');

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
    await openSettings('Project');

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
    await openSettings('Project');

    expect(await screen.findByLabelText('fal.ai scene clip duration')).toHaveProperty('value', '6');
    closeSettings();
    await openStage('produce');
    // No model pin: the default Hailuo-02 image-to-video take, priced before it is paid for.
    expect((await screen.findByTestId('fal-cutaway-plan')).textContent).toContain('est. $0.27 (6s at 768P)');
    fireEvent.click(await findEnabledByRole('button', { name: /^Render$/ }));
    await waitFor(() => expect(generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      backend: 'fal',
      falDuration: 6,
      falModelId: 'fal-ai/minimax/hailuo-02/standard/image-to-video',
      falResolution: '768P',
      mode: 'image',
      sourceImageFile: 'img1',
    })));
    expect(generateVideo.mock.calls.at(-1)[0]).not.toHaveProperty('modelId');
    expect(generateVideo.mock.calls.at(-1)[0]).not.toHaveProperty('disableAudio');
  });

  // Uniquely catches the card's Render on pick being ignored, or rewriting the project's saved renderer.
  it('renders one shot on the fal.ai model picked on its card, priced there, without changing the project renderer', async () => {
    getVideoGenStatus.mockResolvedValueOnce({ connected: true, defaultModel: 'ltx23_distilled_q4', falEnabled: true,
      models: [{ id: 'ltx23_distilled_q4', name: 'LTX-2.3 Distilled Q4', runtime: 'ltx2' }] });
    generateVideo.mockResolvedValue({ jobId: 'fal-pick-job' });
    await openProject({ ...PROJECT_NO_CLIP, videoSettings: { backend: 'local' } });
    await openStage('produce');
    const render = within(await screen.findByRole('region', { name: 'Render' }));
    const pick = render.getByLabelText('Render on');
    expect(pick.value).toBe('');
    expect(within(pick).getByRole('option', { name: /^fal\.ai · .*Kling/ })).toBeTruthy();
    expect(within(pick).queryByRole('option', { name: /LTX.*fal|fal.*LTX/ })).toBeNull();
    fireEvent.change(pick, { target: { value: 'fal:fal-ai/minimax/hailuo-02/standard/image-to-video' } });
    expect(render.getByText(/^est\. \$/)).toBeTruthy();
    fireEvent.click(render.getByRole('button', { name: /^Render$/ }));
    await waitFor(() => expect(generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      backend: 'fal', falModelId: 'fal-ai/minimax/hailuo-02/standard/image-to-video', mode: 'image', sourceImageFile: 'img1',
    })));
    expect(generateVideo.mock.calls.at(-1)[0]).not.toHaveProperty('modelId');
    expect(updateMusicVideoProject.mock.calls.some(([, patch]) => patch?.videoSettings)).toBe(false);
  });

  // Uniquely catches "Local LTX" falling through to the install's default model, and a picked length being dropped.
  it('renders a Local LTX pick on the model and length its card shows, LTX-2.5 before the install default', async () => {
    getVideoGenStatus.mockResolvedValueOnce({ connected: true, defaultModel: 'ltx23_distilled_q4', falEnabled: true,
      models: [{ id: 'ltx23_distilled_q4', name: 'LTX-2.3 Distilled Q4', runtime: 'mlx_video' }, { id: 'ltx25_mlx_q8', name: 'LTX-2.5 Q8', runtime: 'ltx25' }] });
    generateVideo.mockResolvedValue({ jobId: 'local-pick-job' });
    await openProject({ ...PROJECT_NO_CLIP, videoSettings: { backend: 'fal' }, scenes: [{ ...PROJECT_NO_CLIP.scenes[0], startSec: 0, endSec: 3 }] }, 'produce');
    const render = within(await screen.findByRole('region', { name: 'Render' }));
    fireEvent.change(render.getByLabelText('Render on'), { target: { value: 'local' } });
    expect(render.getByLabelText('Model').value).toBe('ltx25_mlx_q8');
    // A 3s shot: the shortest LTX length that covers it (73 frames at 24 fps).
    const length = render.getByLabelText('Clip length');
    expect(length.value).toBe('73');
    expect(length.selectedOptions[0].textContent).toBe('3s · covers shot');
    fireEvent.change(length, { target: { value: '121' } });
    fireEvent.click(await findEnabledByRole('button', { name: /^Render$/ }));
    await waitFor(() => expect(generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      backend: 'local', modelId: 'ltx25_mlx_q8', numFrames: 121, mode: 'image',
    })));
    expect(updateMusicVideoProject.mock.calls.some(([, patch]) => patch?.videoSettings)).toBe(false);
  });

  it('renders a cutaway on the picked fal.ai model at the shot-covering length, sending exactly the take it prices', async () => {
    getVideoGenStatus.mockResolvedValueOnce({ connected: true, defaultModel: '', falEnabled: true, models: [] });
    generateVideo.mockResolvedValue({ jobId: 'fal-h3-job' });
    await openProject({
      ...PROJECT_NO_CLIP,
      videoSettings: { backend: 'fal', falModelId: 'minimax/h3-max/image-to-video', falResolution: '1080P' },
      scenes: [{ ...PROJECT_NO_CLIP.scenes[0], startSec: 0, endSec: 7.2 }],
    }, 'produce');

    // A 7.2s shot on H3 Max (5–15s whole seconds) renders 8s at $0.16/s.
    expect((await screen.findByTestId('fal-cutaway-plan')).textContent).toContain('est. $1.28 (8s at 1080P)');
    fireEvent.click(await findEnabledByRole('button', { name: /^Render$/ }));
    await waitFor(() => expect(generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      backend: 'fal', falModelId: 'minimax/h3-max/image-to-video', falDuration: 8, falResolution: '1080P',
    })));

    // Switching model clears the resolution pin — its alphabet is per model.
    await openSettings('Project');
    fireEvent.change(await screen.findByLabelText('fal.ai cutaway model'), {
      target: { value: 'fal-ai/kling-video/v3/pro/image-to-video' },
    });
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith(
      'mv-2',
      { videoSettings: { falModelId: 'fal-ai/kling-video/v3/pro/image-to-video', falResolution: null } },
      { silent: true },
    ));
  });

  it('blocks fal.ai scene generation with a clear preflight reason when no API key is configured', async () => {
    // getVideoGenStatus's default mock omits falEnabled, so it resolves false —
    // exactly the "no fal.ai API key configured" install this covers.
    await openProject({ ...PROJECT_NO_CLIP, videoSettings: { backend: 'fal' } }, 'produce');

    const generate = await screen.findByRole('button', { name: /^Render$/ });
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
      await openSettings('Project');

      expect(await screen.findByRole('option', { name: 'Grok video (cutaway only)' })).toBeTruthy();
      closeSettings();
      await openStage('produce');
      expect(await screen.findByText(/Grok video is cutaway-only/)).toBeTruthy();
      const generate = await screen.findByRole('button', { name: /^Render$/ });
      expect(generate).toBeDisabled();
      fireEvent.click(generate);
      expect(generateVideo).not.toHaveBeenCalled();
    });

    it('names the lip-sync provider, model, song window and estimated cost, then renders on fal.ai without a clip-length pin', async () => {
      getVideoGenStatus.mockResolvedValueOnce({
        connected: true, defaultModel: 'ltx23_distilled_q4', falEnabled: true,
        models: [{ id: 'ltx23_distilled_q4', name: 'LTX-2.3 Distilled Q4', runtime: 'ltx2' }],
      });
      generateVideo.mockResolvedValue({ jobId: 'fal-lipsync-job' });
      await openProject(performanceProject({ backend: 'fal', falDuration: 6 }), 'produce');

      const plan = await screen.findByTestId('performance-plan');
      expect(plan.textContent).toContain('minimax/h3-max/lip-sync/image-to-video');
      expect(plan.textContent).toMatch(/shot starts 1\.7[78]s into the take/);
      // The padded 5.05s window at the 1080P lip-sync default ($0.16/s).
      expect(plan.textContent).toContain('est. $0.81 (5.05s at 1080P)');
      fireEvent.click(await findEnabledByRole('button', { name: /^Render$/ }));
      await waitFor(() => expect(generateVideo).toHaveBeenCalledWith(expect.objectContaining({
        backend: 'fal', mode: 'image', sourceImageFile: 'img1', falResolution: '1080P',
      })));
      expect(generateVideo.mock.calls.at(-1)[0]).not.toHaveProperty('falDuration');
      expect(generateVideo.mock.calls.at(-1)[0]).not.toHaveProperty('falModelId');
    });

    it('persists a scene switched to a performance shot', async () => {
      updateMusicVideoScene.mockResolvedValue({ ...PROJECT_NO_CLIP.scenes[0], shotMode: 'performance' });
      await openProject(PROJECT_NO_CLIP, 'produce');

      fireEvent.change(await screen.findByLabelText('Shot'), { target: { value: 'performance' } });
      await waitFor(() => expect(updateMusicVideoScene).toHaveBeenCalledWith(
        'mv-2', 's1', { shotMode: 'performance' }, expect.anything(),
      ));
    });

    it('offers a lyric-boundary split for a shot longer than one lip-sync take and applies the split board', async () => {
      // 38s: past one ~30s lip-sync take.
      const longShot = { ...PERFORMANCE_SCENE, startSec: 2, endSec: 40 };
      const base = performanceProject({ backend: 'fal' });
      const project = { ...base, audioAnalysis: { ...base.audioAnalysis, durationSec: 60 }, scenes: [longShot] };
      const pieces = [
        { ...longShot, label: 'Verse · 1/2', endSec: 21 },
        { ...longShot, sceneId: 's1b', order: 1, label: 'Verse · 2/2', startSec: 21, videoHistoryId: null },
      ];
      splitMusicVideoScene.mockResolvedValue({ project: { ...project, scenes: pieces }, scenes: pieces });
      await openProject(project, 'produce');

      // The too-long refusal stays, now with a way out that never loops or stretches.
      expect(await screen.findByText(/Split the scene on a lyric or phrase boundary/)).toBeTruthy();
      fireEvent.click(await screen.findByRole('button', { name: /Split on lyric boundaries/ }));
      await waitFor(() => expect(splitMusicVideoScene).toHaveBeenCalledWith('mv-2', 's1', 'fal', expect.anything()));
      // The new scene shows on the Board and in the storyboard approval's shot list.
      expect((await screen.findAllByText(/Verse · 2\/2$/, { selector: ':not(option)' })).length).toBeGreaterThan(0);
      expect(screen.queryByRole('button', { name: /Split on lyric boundaries/ })).toBeNull();
    });

    // Uniquely catches a shot with no way to be cut in two at a picked time (only merge, or the lyric-boundary split on a too-long shot).
    it('splits a shot in two at the time picked on its slider', async () => {
      const scene = { ...PROJECT_NO_CLIP.scenes[0], startSec: 10, endSec: 14 };
      const pieces = [{ ...scene, endSec: 11.5, label: 'Shot · 1/2' }, { ...scene, sceneId: 's1b', order: 1, startSec: 11.5, label: 'Shot · 2/2' }];
      splitMusicVideoScene.mockResolvedValue({ project: { ...PROJECT_NO_CLIP, scenes: pieces }, scenes: pieces });
      await openProject({ ...PROJECT_NO_CLIP, scenes: [scene] }, 'produce');

      fireEvent.click(await screen.findByRole('button', { name: /Split shot/ }));
      const slider = screen.getByLabelText('Split at');
      expect(slider.value).toBe('12');
      fireEvent.change(slider, { target: { value: '11.5' } });
      expect(screen.getByText(/1\.5s in/)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /Split here/ }));
      await waitFor(() => expect(splitMusicVideoScene).toHaveBeenCalledWith('mv-2', 's1', null, expect.objectContaining({ atSec: 11.5 })));
      expect((await screen.findAllByText(/Shot · 2\/2$/, { selector: ':not(option)' })).length).toBeGreaterThan(0);
    });

    it('moves a shot start by frame number, and the shot before ends there too', async () => {
      const first = { ...PROJECT_NO_CLIP.scenes[0], startSec: 0, endSec: 10 };
      const second = { ...first, sceneId: 's2', order: 1, startSec: 10, endSec: 14, label: 'Second' };
      const moved = [{ ...first, endSec: 10.042 }, { ...second, startSec: 10.042 }];
      moveMusicVideoSceneStart.mockResolvedValue({ project: { ...PROJECT_NO_CLIP, scenes: moved }, scene: moved[1], previous: moved[0] });
      await openProject({ ...PROJECT_NO_CLIP, scenes: [first, second] }, 'produce');

      await act(async () => fireEvent.click(await screen.findByRole('button', { name: /^Open Shot 2/ })));
      const input = screen.getByLabelText('Start frame');
      expect(input.value).toBe('240');
      const row = input.closest('div');
      expect(within(row).getByTestId('start-frame-time').textContent).toMatch(/^0:10\.00 · 24 fps · the shot before ends here/);
      fireEvent.click(within(row).getByRole('button', { name: 'Start one frame later' }));
      await waitFor(() => expect(moveMusicVideoSceneStart).toHaveBeenCalledWith('mv-2', 's2', 10.042, expect.objectContaining({ silent: true })));
      await waitFor(() => expect(screen.getByLabelText('Start frame').value).toBe('241'));
      // A typed frame moves it there.
      fireEvent.change(screen.getByLabelText('Start frame'), { target: { value: '228' } });
      fireEvent.blur(screen.getByLabelText('Start frame'));
      await waitFor(() => expect(moveMusicVideoSceneStart).toHaveBeenLastCalledWith('mv-2', 's2', 9.5, expect.anything()));
    });

    it('requests the Grok clip that covers a cutaway and adds approximate motion timing', async () => {
      generateVideo.mockResolvedValue({ jobId: 'grok-job' });
      await openProject({
        ...PROJECT_NO_CLIP,
        videoSettings: { backend: 'grok', grokDuration: 6 },
        phrases: [{ id: 'p1', startSec: 12, endSec: 15, intent: 'camera pushes in' }],
        scenes: [{ ...PROJECT_NO_CLIP.scenes[0], startSec: 10, endSec: 17.2 }],
      }, 'produce');

      expect(await screen.findByText(/Grok renders a 10s clip for this 7\.2s cutaway/)).toBeTruthy();
      fireEvent.click(await findEnabledByRole('button', { name: /^Render$/ }));
      await waitFor(() => expect(generateVideo).toHaveBeenCalledWith(expect.objectContaining({
        backend: 'grok', grokDuration: 10,
      })));
      // The server composes Grok's approximate phrase timing onto the director's text.
      expect(JSON.parse(generateVideo.mock.calls.at(-1)[0].musicVideo)).toMatchObject({ compose: true });
    });
  });

  it('warns when ready scenes reuse the same frames and clips', async () => {
    await openProject({
      ...PROJECT_WITH_CLIP,
      scenes: [
        PROJECT_WITH_CLIP.scenes[0],
        { ...PROJECT_WITH_CLIP.scenes[0], sceneId: 's2', order: 1 },
      ],
    }, 'produce');

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
    await openProject(PROJECT_NO_CLIP, 'produce');

    const generate = await findEnabledByRole('button', { name: /^Render$/ });
    expect(screen.queryByRole('checkbox', { name: /I am eligible/ })).toBeNull();
    fireEvent.click(generate);
    await waitFor(() => expect(generateVideo).toHaveBeenCalled());
  });
});

describe('MusicVideo project versions', () => {
  it('forks for video generation without rendering or modifying the source', async () => {
    cloneMusicVideoProject.mockResolvedValue({ ...PROJECT_WITH_CLIP, id: 'mv-footage', name: 'Footage Variant', version: 2, composition: { mode: 'composed' } });
    await openProject({ ...PROJECT_WITH_CLIP, composition: { mode: 'document' } });
    await openSettings('Project');
    fireEvent.click(await screen.findByRole('button', { name: 'Fork for video generation' }));
    await waitFor(() => expect(cloneMusicVideoProject).toHaveBeenCalledWith('mv-1', { variant: 'video-generation' }, { silent: true }));
    await screen.findByRole('heading', { level: 2, name: 'Footage Variant' });
    expect(renderMusicVideoProject).not.toHaveBeenCalled();
    expect(updateMusicVideoProject).not.toHaveBeenCalled();
  });

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
    await openSettings('Project');

    fireEvent.click(await screen.findByRole('button', { name: /^Fork v2$/ }));

    await waitFor(() => expect(cloneMusicVideoProject).toHaveBeenCalledWith('mv-1', {}, { silent: true }));
    await screen.findByRole('heading', { level: 2, name: 'Neon Run v2' });
    expect(screen.getByRole('button', { name: 'Rename v2' })).toBeTruthy();
  });

  it('omits media type parenthetical in the project picker options', async () => {
    const parentheticalProject = {
      ...PROJECT_WITH_CLIP,
      id: 'mv-exp',
      name: 'You Are the Room - Blueprint v7 (experimental, images)',
    };
    await openProject(parentheticalProject);

    const picker = await screen.findByLabelText('Project');
    const option = Array.from(picker.options).find((opt) => opt.value === 'mv-exp');
    expect(option).toBeDefined();
    expect(option?.textContent).toBe('You Are the Room - Blueprint v7');
  });
});

describe('MusicVideo audio preview + download', () => {
  it('shows preview player + download link for a linked track', async () => {
    listTracks.mockResolvedValue([{ id: 't1', title: 'Neon Song', audioFilename: 'neon song.mp3' }]);
    await openProject(PROJECT_WITH_CLIP, 'setup');
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
    await openProject(PROJECT_WITH_CLIP, 'setup');
    expect(await screen.findByTitle('Audio imported from Suno')).toHaveTextContent('Suno');
  });

  it('falls back to the project uploaded-audio file when there is no linked track', async () => {
    await openProject({ ...PROJECT_WITH_CLIP, trackId: null, uploadedAudioFilename: 'upload.wav' }, 'setup');
    const player = await screen.findByLabelText('Preview track audio');
    expect(player.getAttribute('src')).toBe('/data/music/upload.wav');
  });

  it('renders no audio controls when the project has no audio', async () => {
    await openProject({ ...PROJECT_WITH_CLIP, trackId: null, uploadedAudioFilename: null }, 'setup');
    // Setup opened (the track picker is present) but no audio surface.
    await screen.findByLabelText('Change track');
    expect(screen.queryByLabelText('Preview track audio')).toBeNull();
    expect(screen.queryByRole('link', { name: /Download audio/i })).toBeNull();
  });
});

describe('MusicVideo musical timeline', () => {
  it('renders waveform, beat evidence, legend, and the detected rhythmic window', async () => {
    await openProject(PROJECT_ANALYZED, 'produce');
    expect(screen.getByRole('img', { name: /audio waveform overview with 4 beats and 1 downbeats/i })).toBeTruthy();
    expect(screen.getByText(/waveform, sections, and 4\/4 beat-grid assumption/i)).toBeTruthy();
    expect(screen.getByText(/detected near 0:40\.00–1:10\.00/i)).toBeTruthy();
    expect(screen.getByLabelText('Timeline legend')).toBeTruthy();
  });
});

describe('MusicVideo audio → MIDI transcription (MuScriptor)', () => {
  it('disables the MIDI button when the project has no audio source', async () => {
    await openProject({ ...PROJECT_WITH_CLIP, trackId: null, uploadedAudioFilename: null });
    await openSettings('Audio');
    const btn = await screen.findByRole('button', { name: /^MIDI$/ });
    expect(btn).toHaveProperty('disabled', true);
  });

  it('kicks off a transcription for the selected project with the default model', async () => {
    await openProject(PROJECT_WITH_CLIP);
    await openSettings('Audio');
    const btn = await screen.findByRole('button', { name: /^MIDI$/ });
    expect(btn).toHaveProperty('disabled', false);
    fireEvent.click(btn);
    await waitFor(() => expect(transcribeMusicVideoMidi).toHaveBeenCalledWith('mv-1', { model: 'medium' }, { silent: true }));
  });

  it('kicks off a transcription with the chosen model size', async () => {
    await openProject(PROJECT_WITH_CLIP);
    await openSettings('Audio');
    fireEvent.change(await screen.findByLabelText('MuScriptor model size'), { target: { value: 'large' } });
    fireEvent.click(await screen.findByRole('button', { name: /^MIDI$/ }));
    await waitFor(() => expect(transcribeMusicVideoMidi).toHaveBeenCalledWith('mv-1', { model: 'large' }, { silent: true }));
  });

  it('shows the MIDI download link once the project carries a transcription pointer', async () => {
    listTracks.mockResolvedValue([{ id: 't1', title: 'Neon Song', audioFilename: 'neon.mp3' }]);
    await openProject({ ...PROJECT_WITH_CLIP, midiTranscription: { filename: 'neon-midi.mid', model: 'medium' } });
    await openSettings('Audio');
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
    await openProject(PROJECT_NO_CLIP, 'produce');
    const planBtn = await screen.findByRole('button', { name: /AI Plan/i });
    expect(planBtn).toHaveProperty('disabled', true);
  });

  it('calls the planner and replaces the project on success', async () => {
    const plannedProject = { ...PROJECT_ANALYZED, scenes: [{ sceneId: 's1', order: 0, prompt: 'p' }] };
    planMusicVideoProject.mockResolvedValue({ project: plannedProject, scenesAdded: 1, promptsSeeded: false, promptsSkippedReason: 'no-provider' });

    await openProject({ ...PROJECT_ANALYZED, scenes: [] }, 'produce');
    const planBtn = await screen.findByRole('button', { name: /AI Plan/i });
    expect(planBtn).toHaveProperty('disabled', false);

    fireEvent.click(planBtn);
    await waitFor(() => expect(planMusicVideoProject).toHaveBeenCalledWith('mv-3', { seedPrompts: true }, { silent: true }));
  });
});

describe('MusicVideo AI Plan on a board that already has scenes (#10144)', () => {
  const withScenes = { ...PROJECT_ANALYZED, scenes: [{ sceneId: 's1', order: 0, prompt: 'p' }, { sceneId: 's2', order: 1, prompt: 'q' }] };

  it('sends no plan request until the director chooses Replace or Add', async () => {
    planMusicVideoProject.mockClear();
    planMusicVideoProject.mockResolvedValue({ project: withScenes, scenesAdded: 1, promptsSeeded: false });
    await openProject(withScenes, 'produce');
    fireEvent.click(await screen.findByRole('button', { name: /AI Plan/i }));
    expect(await screen.findByRole('button', { name: /Replace 2 shots/ })).toBeTruthy();
    expect(planMusicVideoProject).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(planMusicVideoProject).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /AI Plan/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Replace 2 shots/ }));
    await waitFor(() => expect(planMusicVideoProject).toHaveBeenCalledWith(withScenes.id, { seedPrompts: true, mode: 'replace' }, { silent: true }));
  });
});

describe('MusicVideo autonomous mode setup experience', () => {
  it('opens the autonomous run from the header Autopilot button, hides the lyrics fork callout when no lyrics exist, and reflects progress in next action', async () => {
    const autoProject = {
      id: 'mv-auto-1',
      name: 'Autonomous MV',
      mode: 'autonomous',
      status: 'draft',
      trackId: null,
      uploadedAudioFilename: null,
      audioAnalysis: null,
      scenes: [],
      autonomousRun: {
        id: 'run-1',
        status: 'running',
        stage: 'lyrics',
        stages: { lyrics: { step: 'draft' } },
        output: {},
        brief: { prompt: 'A synthwave adventure' },
      },
    };
    await openProject(autoProject, 'setup');

    // The header's Autopilot button names what the run is doing and opens its panel in Project settings › Autopilot.
    fireEvent.click(screen.getByRole('button', { name: /Autonomous run: writing the lyric draft/i }));
    const runRegion = await screen.findByRole('region', { name: 'Autonomous run' });
    expect(runRegion).toBeInTheDocument();

    // No lyrics yet: the song fork callout (Project settings › Audio) stays hidden.
    fireEvent.click(screen.getByRole('tab', { name: /^Audio/ }));
    expect(screen.queryByRole('heading', { name: 'Revise lyrics & song' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Fork & revise song' })).toBeNull();
    closeSettings();

    expect(screen.queryByRole('button', { name: 'Attach a track' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Writing the lyric draft…' })).toBeDisabled();

    expect(screen.queryByText(/Approvals: 0 of 3 approved/)).toBeNull();
    expect(screen.getByText(/Autonomous run: writing the lyric draft/i)).toBeInTheDocument();
  });
});

describe('MusicVideo lyrics and shot coverage (#8964)', () => {
  it('imports pasted lyrics, shows the cues, and persists an edited line on blur', async () => {
    const cues = [
      { id: 'lc-1', text: 'first line', startSec: 1, endSec: 3 },
      { id: 'lc-2', text: 'second line', startSec: 3, endSec: null },
    ];
    importMusicVideoLyrics.mockResolvedValue({ project: { ...PROJECT_ANALYZED, lyricCues: cues }, imported: 2, format: 'lrc' });
    await openProject(PROJECT_ANALYZED, 'setup');

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

  it('aligns imported lyrics on its own and follows the alignment it started', async () => {
    const cues = [{ id: 'lc-1', text: 'first line', startSec: null, endSec: null }];
    importMusicVideoLyrics.mockResolvedValue({ project: { ...PROJECT_ANALYZED, lyricCues: cues }, imported: 1, format: 'text' });
    prepareMusicVideoSong.mockResolvedValueOnce({ project: { ...PROJECT_ANALYZED, lyricCues: cues }, analyzed: false, alignJobId: 'align-auto' });
    await openProject(PROJECT_ANALYZED, 'setup');
    fireEvent.change(screen.getByLabelText('Lyrics to import'), { target: { value: 'first line' } });
    fireEvent.click(screen.getByRole('button', { name: /^Import lyrics$/ }));
    await waitFor(() => expect(prepareMusicVideoSong).toHaveBeenCalledWith('mv-3', { silent: true }));
    expect((await screen.findAllByRole('button', { name: 'Aligning…' })).length).toBeGreaterThan(0);
    expect(alignMusicVideoLyrics).not.toHaveBeenCalled();
  });

  it('re-aligns words from the button and shows the returned timings', async () => {
    const cues = [{
      id: 'lc-1', text: 'walking home', startSec: 0.5, endSec: 1.5,
      words: [
        { w: 'walking', startSec: 0.5, endSec: 1, conf: 'matched' },
        { w: 'home', startSec: 1, endSec: 1.5, conf: 'interpolated' },
      ],
    }];
    await openProject({ ...PROJECT_ANALYZED, vocalStemFilename: 'stem.wav', lyricCues: [{ id: 'lc-1', text: 'walking home', startSec: null, endSec: null }] }, 'setup');
    expect(alignMusicVideoLyrics).not.toHaveBeenCalled();
    alignMusicVideoLyrics.mockResolvedValue({ jobId: 'align-job-1' });
    fireEvent.click(screen.getByRole('button', { name: 'Align words' }));
    await waitFor(() => expect(alignMusicVideoLyrics).toHaveBeenCalledWith('mv-3', {}, { silent: true }));
    await settle();
    sseState.latest = { type: 'complete', project: { id: 'mv-3', vocalStemFilename: 'stem.wav', lyricCues: cues, updatedAt: 't' } };
    forceRerender();
    expect(await screen.findByText('walking')).toHaveClass('text-port-accent');
    expect(screen.getByText('home')).toHaveClass('text-port-warning');
    sseState.latest = null;
    fireEvent.click(screen.getByRole('button', { name: 'Re-align line 1' }));
    await waitFor(() => expect(alignMusicVideoLyrics).toHaveBeenLastCalledWith('mv-3', { cueId: 'lc-1' }, { silent: true }));
  });

  it('reattaches to an alignment the server is still running after a reload (#10155)', async () => {
    getMusicVideoActiveJobs.mockResolvedValueOnce({ alignment: 'align-live', separation: null, midi: null });
    await openProject({ ...PROJECT_ANALYZED, lyricCues: [{ id: 'lc-1', text: 'walking home', startSec: null, endSec: null }] }, 'setup');
    const running = await screen.findAllByRole('button', { name: 'Aligning…' });
    running.forEach((button) => expect(button).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Re-align line 1' })).toBeDisabled();
    expect(alignMusicVideoLyrics).not.toHaveBeenCalled();
  });

  it('flags a non-looping shot longer than its clip and trims it; a legacy scene is left alone', async () => {
    // The scene cards' players; the preview dock's storyboard animatic plays the shot's clip on its own.
    const cardPlayers = () => [...document.body.querySelectorAll('video[src^="/data/videos/h"]')]
      .filter((video) => !video.closest('figure[aria-label="Storyboard animatic"]'));
    const project = {
      ...PROJECT_WITH_CLIP,
      scenes: [
        { sceneId: 's1', order: 0, prompt: 'a', referenceImageId: 'img1', videoHistoryId: 'h1', beatAligned: true, startSec: 2, endSec: 12, loop: false, lyricText: 'first line' },
        { sceneId: 's2', order: 1, prompt: 'b', referenceImageId: 'img1', videoHistoryId: 'h2', beatAligned: true, startSec: 12, endSec: 30 },
      ],
    };
    updateMusicVideoScene.mockResolvedValue({});
    await openProject(project, 'produce');
    // The card's summary row and its editor both quote the lyric.
    expect(screen.getAllByText(/first line/).length).toBeGreaterThan(0);

    const players = cardPlayers();
    expect(players).toHaveLength(1); // only the selected shot owns a player
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

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Open Shot 2' })));
    const legacyPlayers = cardPlayers();
    expect(legacyPlayers).toHaveLength(1);
    expect(legacyPlayers[0]).toHaveAttribute('src', '/data/videos/h2.mp4');
    Object.defineProperty(legacyPlayers[0], 'duration', { configurable: true, value: 5 });
    fireEvent.loadedMetadata(legacyPlayers[0]);
    expect(screen.queryByRole('alert')).toBeNull(); // legacy shots still loop to fill their span
  });
});

describe('MusicVideo typography composition (#8984)', () => {
  it('seeds text cues from the timed lyrics, switches to a composed render, and saves an edited cue whole', async () => {
    const lyricCues = [
      { id: 'lc-1', text: 'first line', startSec: 1, endSec: 3 },
      { id: 'lc-2', text: 'untimed line', startSec: null, endSec: null },
    ];
    updateMusicVideoProject.mockResolvedValue({});
    await openProject({ ...PROJECT_ANALYZED, lyricCues }, 'compose');

    fireEvent.click(screen.getByRole('button', { name: /Copy timed lyrics \(1\)/ }));
    const text = await screen.findByLabelText('Text cue 1 text');
    expect(text).toHaveValue('first line');
    expect(screen.queryByLabelText('Text cue 2 text')).toBeNull();
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenLastCalledWith('mv-3', {
      composition: expect.objectContaining({ mode: 'concat', textCues: [expect.objectContaining({ text: 'first line', startSec: 1, endSec: 3, template: 'fade' })] }),
    }, { silent: true }));

    expect(document.getElementById('mv-typo-mode')).toBeNull(); // render style is chosen in Setup only
    fireEvent.change(screen.getByLabelText('Text cue 1 motion'), { target: { value: 'typewriter' } });
    fireEvent.change(text, { target: { value: 'first line, typed' } });
    fireEvent.blur(text);
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenLastCalledWith('mv-3', {
      composition: expect.objectContaining({
        mode: 'concat',
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
    await openProject({ ...PROJECT_WITH_CLIP, scenes, composition: composition('composed') }, 'review');
    const renderBtn = await screen.findByRole('button', { name: /^Render final$/ });
    expect(renderBtn).toBeDisabled();

    await openStage('produce');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Open Shot 2' })));
    const layer = document.getElementById('mv-scene-s2-layer');
    fireEvent.change(layer, { target: { value: 'card' } });
    await waitFor(() => expect(updateMusicVideoScene).toHaveBeenCalledWith('mv-1', 's2', { visualLayer: 'card' }, { silent: true }));
    const cardText = await screen.findByLabelText('Card text');
    fireEvent.change(cardText, { target: { value: 'Chapter two' } });
    fireEvent.blur(cardText);
    await waitFor(() => expect(updateMusicVideoScene).toHaveBeenCalledWith('mv-1', 's2', { cardText: 'Chapter two' }, { silent: true }));
    // A card needs no frame or clip, so the board is ready; only the footage scene counts toward Videos.
    await openStage('produce');
    expect(screen.getByRole('button', { name: /Videos 1\/1/ })).toBeTruthy();
    await openStage('review');
    await waitFor(() => expect(screen.getByRole('button', { name: /^Render final$/ })).toBeEnabled());
  });

  it('keeps a plain render on footage and says the layer only applies to composed renders', async () => {
    await openProject({ ...PROJECT_WITH_CLIP, scenes: [scenes[0], { ...scenes[1], visualLayer: 'card' }], composition: composition('concat') }, 'produce');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Open Shot 2' })));
    expect(await screen.findByText(/Title card sections render in composed or document mode/)).toBeTruthy();
    await openStage('review');
    expect(screen.getByRole('button', { name: /^Render final$/ })).toBeDisabled();
  });
});

describe('MusicVideo concept & style editor (#3168)', () => {
  it('seeds the fields from the project and persists each on blur', async () => {
    const withConcept = { ...PROJECT_NO_CLIP, concept: { prompt: 'A road trip through neon ruins', style: 'Cyberpunk anime' } };
    await openProject(withConcept, 'story');

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
    await openProject(withConcept, 'story');
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
    // Concept and style are creative direction, on the Story step.
    await openStage('story');

    const conceptField = await screen.findByLabelText('Concept');
    fireEvent.change(conceptField, { target: { value: 'A unsaved draft' } });
    // No blur — switch projects while the edit is still pending.
    await selectProject(projectB.id);
    await openStage('story');

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
    await openProject(PROJECT_ANALYZED, 'story');
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
    await openProject(PROJECT_NO_CLIP, 'setup');
    const urlInput = screen.getByPlaceholderText(/Paste a YouTube or Suno link/i);
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

  it('imports a pasted Suno song link through the Suno import', async () => {
    await openProject(PROJECT_NO_CLIP, 'setup');
    const urlInput = screen.getByPlaceholderText(/Paste a YouTube or Suno link/i);
    const songUrl = 'https://suno.com/song/11111111-2222-4333-8444-555555555555';
    fireEvent.change(urlInput, { target: { value: songUrl } });
    fireEvent.click(within(urlInput.closest('div')).getByRole('button', { name: /Import/i }));
    await waitFor(() => expect(importTrackFromSuno).toHaveBeenCalledWith(songUrl, { silent: true }));
    expect(importTrackFromYoutube).not.toHaveBeenCalled();
  });

  it('disables the Import button until a URL is entered', async () => {
    await openProject(PROJECT_NO_CLIP, 'setup');
    // Exact name: other stages also carry "Import take" / handoff import controls.
    const importBtns = screen.getAllByRole('button', { name: /^Import$/i });
    expect(importBtns.length).toBeGreaterThan(0);
    importBtns.forEach((btn) => expect(btn).toHaveProperty('disabled', true));
  });

  it('running the create-form and detail-view imports at once does not orphan either job', async () => {
    await openProject(PROJECT_NO_CLIP, 'setup');
    await openCreateForm();
    importTrackFromYoutube
      .mockResolvedValueOnce({ jobId: 'yt-job-create' })
      .mockResolvedValueOnce({ jobId: 'yt-job-edit' });

    const inputs = screen.getAllByPlaceholderText(/Paste a YouTube or Suno link/i);
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

    const editInput = screen.getAllByPlaceholderText(/Paste a YouTube or Suno link/i)
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
    const editInput = screen.getAllByPlaceholderText(/Paste a YouTube or Suno link/i)
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
    await openProject(PROJECT_NO_CLIP, 'setup');
    const editInput = screen.getAllByPlaceholderText(/Paste a YouTube or Suno link/i)
      .find((el) => el.id !== 'mv-yt-create');
    fireEvent.change(editInput, { target: { value: 'https://youtu.be/xyz' } });
    fireEvent.click(within(editInput.closest('div')).getByRole('button', { name: /Import/i }));
    await waitFor(() => expect(importTrackFromYoutube).toHaveBeenCalled());

    await openSettings('Project');
    fireEvent.click(screen.getByTitle('Delete project'));
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/before deleting this project/i));
    expect(deleteMusicVideoProject).not.toHaveBeenCalled();
  });

  it('asks for confirmation before deleting a project and allows cancelling or confirming', async () => {
    deleteMusicVideoProject.mockResolvedValue({});
    await openProject(PROJECT_NO_CLIP, 'setup');
    await openSettings('Project');

    fireEvent.click(screen.getByTitle('Delete project'));
    expect(deleteMusicVideoProject).not.toHaveBeenCalled();
    expect(screen.getByText('Delete?')).toBeTruthy();

    // Cancel deletion
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(deleteMusicVideoProject).not.toHaveBeenCalled();
    expect(screen.getByTitle('Delete project')).toBeTruthy();

    // Arm confirmation again and confirm
    fireEvent.click(screen.getByTitle('Delete project'));
    fireEvent.click(screen.getByRole('button', { name: `Confirm delete project ${PROJECT_NO_CLIP.name}` }));
    await waitFor(() => expect(deleteMusicVideoProject).toHaveBeenCalledWith(PROJECT_NO_CLIP.id, { silent: true }));
  });

  it('pressing Enter in the create-form URL input starts the import instead of submitting the form', async () => {
    listMusicVideoProjects.mockResolvedValue([]);
    renderMV();
    await openCreateForm();
    const createInput = await screen.findByPlaceholderText(/Paste a YouTube or Suno link/i);
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
    const createInput = await screen.findByPlaceholderText(/Paste a YouTube or Suno link/i);
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

    const editInput = screen.getAllByPlaceholderText(/Paste a YouTube or Suno link/i)
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
    const createInput = screen.getAllByPlaceholderText(/Paste a YouTube or Suno link/i)
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
      // A new brief stops for the Cast & Sets check-in unless told otherwise.
      checkins: { castAndSets: 'review' },
    });
  });

  it('selects track first in create drawer, auto-fills name, reads track metadata, and passes concept/style on create', async () => {
    listMusicVideoProjects.mockResolvedValue([]);
    listTracks.mockResolvedValue([{
      id: 'track-cool',
      title: 'Neon Horizon',
      artist: 'SynthWave Artist',
      lyrics: 'Line 1\nLine 2\nLine 3',
      concept: 'Futuristic city chase',
      prompt: 'Cyberpunk neon aesthetics',
      durationSec: 180,
    }]);
    createMusicVideoProject.mockResolvedValue({ ...PROJECT_NO_CLIP, id: 'mv-cool', name: 'Neon Horizon', trackId: 'track-cool' });
    renderMV();
    await openCreateForm();

    const trackSelect = await screen.findByLabelText(/Track/i);
    fireEvent.change(trackSelect, { target: { value: 'track-cool' } });

    // Project name was auto-filled from track title
    expect(screen.getByPlaceholderText('Project name')).toHaveValue('Neon Horizon');
    // Track info badge showing lyrics and concept detected
    expect(screen.getByText(/3 lyric lines loaded/i)).toBeInTheDocument();
    expect(screen.getByText(/Concept loaded/i)).toBeInTheDocument();
    expect(screen.getByText(/Style prompt loaded/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Create/ }));
    await waitFor(() => expect(createMusicVideoProject).toHaveBeenCalled());
    const [body] = createMusicVideoProject.mock.calls[0];
    expect(body).toMatchObject({
      name: 'Neon Horizon',
      trackId: 'track-cool',
    });
    // The new song is analyzed and its lyrics aligned without another click.
    await waitFor(() => expect(prepareMusicVideoSong).toHaveBeenCalledWith('mv-cool', { silent: true }));
  });

  it('changing a track in the edit view auto-seeds the track concept, leaving the song style to the server', async () => {
    const project = { ...PROJECT_NO_CLIP, trackId: null, concept: null };
    listTracks.mockResolvedValue([{
      id: 'track-new',
      title: 'Solar Flare',
      concept: 'Space journey',
      prompt: 'Cosmic sci-fi',
    }]);
    updateMusicVideoProject.mockResolvedValue({ ...project, trackId: 'track-new', concept: { prompt: 'Space journey', songStyle: 'Cosmic sci-fi' } });
    await openProject(project, 'setup');

    const changeTrackSelect = screen.getByLabelText('Change track');
    fireEvent.change(changeTrackSelect, { target: { value: 'track-new' } });

    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith(
      project.id,
      {
        trackId: 'track-new',
        // The Suno style is the song's sound, not the visual style on every frame prompt.
        concept: { prompt: 'Space journey' },
      },
      { silent: true },
    ));
  });

  it('autopilot kickoff analyzes the song, tries the track lyrics, then plans the shots against the brief', async () => {
    // A check-in the director already skipped does not stop the run.
    const project = { ...PROJECT_NO_CLIP, trackId: 'track-1', lyricCues: [], scenes: [], castAndSets: { status: 'skipped' }, automation: { tools: ['image:local'], guidance: 'noir', budgetUsd: null } };
    const analyzed = { ...project, audioAnalysis: PROJECT_ANALYZED.audioAnalysis, status: 'analyzed' };
    analyzeMusicVideoProject.mockResolvedValue(analyzed);
    // An instrumental track: nothing to import, so nothing to separate or align.
    importMusicVideoTrackLyrics.mockResolvedValue({ project: analyzed, imported: 0, markers: 0, skipped: 'no-track-lyrics' });
    planMusicVideoProject.mockResolvedValue({ project: analyzed, scenesAdded: 3, promptsSeeded: true });
    await openProject(project);
    await openSettings('Autopilot');
    fireEvent.click(screen.getByRole('button', { name: /Analyze & plan/ }));
    await waitFor(() => expect(planMusicVideoProject).toHaveBeenCalledWith(project.id, { seedPrompts: true }, { silent: true }));
    expect(analyzeMusicVideoProject).toHaveBeenCalledWith(project.id, { silent: true });
    expect(importMusicVideoTrackLyrics).toHaveBeenCalledWith(project.id, { mode: 'if-empty' }, { silent: true });
    expect(separateMusicVideoVocals).not.toHaveBeenCalled();
    expect(alignMusicVideoLyrics).not.toHaveBeenCalled();
  });

  it('keeps the Cast & Sets check-in for a code-first board and waits for it before planning', async () => {
    const project = { ...PROJECT_ANALYZED, trackId: null, uploadedAudioFilename: 'song.mp3', lyricCues: [], scenes: [],
      composition: { mode: 'document' }, productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: 0 },
      automation: { tools: ['code:render'], guidance: '', budgetUsd: null, checkins: { castAndSets: 'review' } } };
    const directing = { ...project, castAndSets: { status: 'directing', revision: 1, plan: {}, images: {} } };
    startMusicVideoCastAndSets.mockResolvedValue({ project: directing, stage: directing.castAndSets });
    await openProject(project);
    await openSettings('Autopilot');
    fireEvent.click(screen.getByRole('button', { name: /Analyze & plan/ }));
    // The server directs it procedurally (no image backend for a code-only brief); the run still gates on it.
    await waitFor(() => expect(startMusicVideoCastAndSets).toHaveBeenCalledWith(project.id, {}, { silent: true }));
    expect(planMusicVideoProject).not.toHaveBeenCalled();
  });

  it('autopilot stops at the Cast & Sets check-in in review mode, and Approve & continue plans', async () => {
    const project = { ...PROJECT_ANALYZED, trackId: null, uploadedAudioFilename: 'song.mp3', lyricCues: [], scenes: [], automation: { tools: ['image:codex'], guidance: '', budgetUsd: null, checkins: { castAndSets: 'review' } } };
    const directing = { ...project, castAndSets: { status: 'directing', revision: 1, plan: {}, images: {} } };
    startMusicVideoCastAndSets.mockResolvedValue({ project: directing, stage: directing.castAndSets });
    const sheet = { id: 'mvd-1', kind: 'cast-sets', title: 'Cast & Sets — Nova', status: 'pending', version: 1, mimeType: 'text/html', versions: [{ version: 1, mimeType: 'text/html', createdAt: '2026-01-01T00:00:00Z' }], notes: [] };
    const reviewing = { ...project, devArtifacts: [sheet], castAndSets: { status: 'review', revision: 1, artifactId: 'mvd-1', plan: {}, images: {} } };
    const approved = { ...reviewing, castAndSets: { ...reviewing.castAndSets, status: 'approved' }, devArtifacts: [{ ...sheet, status: 'approved' }] };
    approveMusicVideoCastAndSets.mockResolvedValue({ project: approved, stage: approved.castAndSets });
    planMusicVideoProject.mockResolvedValue({ project: approved, scenesAdded: 2, promptsSeeded: true });
    await openProject(project);
    await openSettings('Autopilot');

    fireEvent.click(screen.getByRole('button', { name: /Analyze & plan/ }));
    await waitFor(() => expect(startMusicVideoCastAndSets).toHaveBeenCalledWith(project.id, {}, { silent: true }));
    await pushSocket('music-video:cast-and-sets', { projectId: project.id, project: reviewing, stage: reviewing.castAndSets });
    closeSettings();
    // Existing Cast & Sets controls still apply references; Production review separately authorizes work.
    await openStage('cast-sets');
    expect(await screen.findByText('Waiting for your check-in.')).toBeTruthy();
    await settle();
    expect(planMusicVideoProject).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Approve & continue/ }));
    await waitFor(() => expect(planMusicVideoProject).toHaveBeenCalledWith(project.id, { seedPrompts: true }, { silent: true }));
    expect(approveMusicVideoCastAndSets).toHaveBeenCalledTimes(1);
  });

  it('autopilot continues straight to the plan when the check-in auto-approves', async () => {
    const project = { ...PROJECT_ANALYZED, trackId: null, uploadedAudioFilename: 'song.mp3', lyricCues: [], scenes: [], automation: { tools: ['image:codex'], guidance: '', budgetUsd: null, checkins: { castAndSets: 'auto' } } };
    const directing = { ...project, castAndSets: { status: 'directing', revision: 1, plan: {}, images: {} } };
    startMusicVideoCastAndSets.mockResolvedValue({ project: directing, stage: directing.castAndSets });
    const approved = { ...project, castAndSets: { status: 'approved', revision: 1, plan: {}, images: {} } };
    planMusicVideoProject.mockResolvedValue({ project: approved, scenesAdded: 2, promptsSeeded: true });
    await openProject(project);
    await openSettings('Autopilot');

    fireEvent.click(screen.getByRole('button', { name: /Analyze & plan/ }));
    await waitFor(() => expect(startMusicVideoCastAndSets).toHaveBeenCalled());
    // Progress pushes don't release the gate; only a checkpoint does.
    await pushSocket('music-video:cast-and-sets', { projectId: project.id, project: { ...directing, castAndSets: { ...directing.castAndSets, status: 'imaging' } } });
    expect(planMusicVideoProject).not.toHaveBeenCalled();
    await pushSocket('music-video:cast-and-sets', { projectId: project.id, project: approved, stage: approved.castAndSets });
    await waitFor(() => expect(planMusicVideoProject).toHaveBeenCalledWith(project.id, { seedPrompts: true }, { silent: true }));
    expect(approveMusicVideoCastAndSets).not.toHaveBeenCalled();
  });

  it('opens a development file from its deep link in a sandboxed viewer', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true });
    const sheet = {
      id: 'mvd-1', kind: 'cast-sets', title: 'Cast & Sets — Nova', status: 'approved', version: 2, mimeType: 'text/html', updatedAt: '2026-01-02T00:00:00Z',
      versions: [{ version: 1, mimeType: 'text/html', source: 'upload', createdAt: '2026-01-01T00:00:00Z' }, { version: 2, mimeType: 'text/html', source: 'upload', createdAt: '2026-01-02T00:00:00Z' }],
      notes: [{ id: 'n1', text: 'Shorter braid', target: null, version: 1, createdAt: '2026-01-01T00:00:00Z', resolvedAt: null }],
    };
    const project = { ...PROJECT_NO_CLIP, devArtifacts: [sheet] };
    listMusicVideoProjects.mockResolvedValue([project]);
    render(
      <MemoryRouter initialEntries={[`/music-video/${project.id}/cast-sets/dev/mvd-1?v=1`]}>{MV_ROUTES}</MemoryRouter>,
    );
    const frame = await screen.findByTitle('Cast & Sets — Nova v1');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('src')).toBe(`/api/music-video/${project.id}/dev-artifacts/mvd-1/file?version=1`);
    expect(screen.getByText('Shorter braid')).toBeTruthy();
    // The Development section lists it with its review status.
    expect(screen.getAllByText('Approved').length).toBeGreaterThan(0);
  });

  it('blocks relinking the track while a render is in progress for the selected project', async () => {
    await openProject(PROJECT_WITH_CLIP, 'review');
    fireEvent.click(await screen.findByRole('button', { name: /^Render final$/ }));
    await waitFor(() => expect(renderMusicVideoProject).toHaveBeenCalled());

    await openStage('setup');
    const trackSelect = screen.getByLabelText('Change track');
    expect(trackSelect).toHaveProperty('disabled', true);
    fireEvent.change(trackSelect, { target: { value: 'other-track' } });
    expect(updateMusicVideoProject).not.toHaveBeenCalled();

    const editInput = screen.getAllByPlaceholderText(/Paste a YouTube or Suno link/i)
      .find((el) => el.id !== 'mv-yt-create');
    expect(editInput).toHaveProperty('disabled', true);
  });
});

// Shared MediaLightbox for scene frames, scene clips, and the final render (#3718).
// View-only — no remix/clean action handlers. Keys are deep-linkable via ?preview=.
describe('MusicVideo media lightbox (#3718)', () => {
  const renderMVAt = (path) => render(
    <MemoryRouter initialEntries={[path]}>{MV_ROUTES}</MemoryRouter>,
  );

  it('opens the lightbox from a reference-frame thumbnail click', async () => {
    await openProject(PROJECT_WITH_CLIP, 'produce');
    await showFrames();
    fireEvent.click(await screen.findByRole('button', { name: 'View scene 1 reference frame full size' }));
    const dialog = await screen.findByRole('dialog', { name: /Media viewer/i });
    expect(dialog).toBeTruthy();
    // Image uses previewUrl (/data/images/<id>); img may be MediaImage-wrapped.
    expect(dialog.querySelector('img')?.getAttribute('src') || dialog.innerHTML)
      .toMatch(/\/data\/images\/img1/);
  });

  it('opens the lightbox from an end-frame thumbnail click', async () => {
    await openProject({ ...PROJECT_WITH_CLIP, scenes: [{ ...PROJECT_WITH_CLIP.scenes[0], endImageId: 'end1' }] }, 'produce');
    await showFrames();
    fireEvent.click(await screen.findByRole('button', { name: 'View scene 1 end frame full size' }));
    const dialog = await screen.findByRole('dialog', { name: /Media viewer/i });
    expect(dialog.querySelector('img')?.getAttribute('src') || dialog.innerHTML).toMatch(/\/data\/images\/end1/);
  });

  it('opens the lightbox from a scene-clip expand control without hijacking play/pause', async () => {
    await openProject(PROJECT_WITH_CLIP, 'produce');
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
    await openProject({ ...PROJECT_WITH_CLIP, renderHistoryId: 'rh-9' }, 'review');
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
    await openProject(PROJECT_WITH_CLIP, 'produce');
    await showFrames();
    fireEvent.click(await screen.findByRole('button', { name: 'View scene 1 reference frame full size' }));
    const dialog = await screen.findByRole('dialog', { name: /Media viewer/i });
    await waitFor(() => {
      expect(dialog.querySelector('img')?.getAttribute('alt')).toBe('a wide desert shot, neon noir');
    });
  });

  it('opens Cast & Sets references and their inputs in the lightbox, not the raw file', async () => {
    const castAndSets = {
      revision: 1, status: 'review',
      plan: { lead: { key: 'lead', label: 'Lead', prompt: 'Lead portrait', deps: [], refKeys: [], moodRefs: true } },
      images: { lead: { status: 'done', imageId: 'lead.png', submittedPrompt: 'Lead portrait', submittedRevision: 1, submittedReferences: [{ kind: 'image-ref', filename: 'mood.png' }] } },
      moodImages: [{ kind: 'image-ref', filename: 'mood.png' }],
    };
    await openProject({ ...PROJECT_NO_CLIP, castAndSets }, 'cast-sets');
    const card = within(await screen.findByRole('article', { name: 'Lead' }));
    expect(card.queryByRole('link')).toBeNull();
    fireEvent.click(card.getByRole('button', { name: 'Preview Lead' }));
    let dialog = await screen.findByRole('dialog', { name: /Media viewer/i });
    expect(dialog.innerHTML).toMatch(/\/data\/images\/lead\.png/);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Media viewer/i })).toBeNull());
    fireEvent.click(card.getByRole('button', { name: 'Lead input: mood.png' }));
    dialog = await screen.findByRole('dialog', { name: /Media viewer/i });
    expect(dialog.innerHTML).toMatch(/\/data\/image-refs\/mood\.png/);
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

  it('sends flagged references as conditioning inputs and names the capability gap when the backend refuses them', async () => {
    generateImage.mockRejectedValueOnce(Object.assign(
      new Error('Reference images are only supported for FLUX.2 and Qwen Image 2.1 models on the local backend'),
      { code: 'REFERENCE_IMAGES_FLUX2_ONLY', status: 400 },
    ));
    await openProject(SPEC_PROJECT, 'produce');
    fireEvent.click(screen.getByRole('button', { name: /^Generate frame$/ }));
    await waitFor(() => expect(generateImage).toHaveBeenCalledWith({
      // The director's text; the server composes the look onto it (lib/musicVideoShotPrompt.js).
      prompt: 'harbor at dawn',
      // Frames are requested at the project's aspect (16:9 by default).
      width: 1536,
      height: 864,
      referenceImageFiles: ['mood.png'],
      musicVideo: {
        projectId: 'mv-spec',
        sceneId: 's1',
        compose: true,
        castInputs: { ingredientId: null, guides: [], sheets: [] },
      },
    }, { silent: true }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      expect.stringMatching(/can't condition on 1 reference image: Reference images are only supported/),
    ));
  });

  it('conditions the board frame on its approved character and section plate, including an unflagged plate', async () => {
    await openProject({ ...SPEC_PROJECT,
      scenes: [{ ...SPEC_PROJECT.scenes[0], sectionIndex: 1 }],
      castAndSets: { status: 'approved', direction: { songMap: [{ section: 0, setId: 'harbor' }, { section: 1, setId: 'roof' }] } },
      visualSpec: { ...SPEC_PROJECT.visualSpec, references: [
        { id: 'authored', imageId: 'authored.png', condition: true },
        { id: 'mvr-cs-character', imageId: 'character.png', condition: true },
        { id: 'mvr-cs-set-harbor', imageId: 'harbor.png', condition: true },
        { id: 'mvr-cs-set-roof', imageId: 'roof.png', condition: false },
      ] },
    }, 'produce');
    fireEvent.click(screen.getByRole('button', { name: /^Generate frame$/ }));
    await waitFor(() => expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({
      referenceImageFiles: ['character.png', 'roof.png'],
      musicVideo: expect.objectContaining({ projectId: 'mv-spec', sceneId: 's1', compose: true }),
    }), { silent: true }));
  });

  // Uniquely catches a frame picked as the render's image reference not reaching the request, or not leading the references.
  it('renders a new frame take from the shot\'s own start frame when it is picked as the reference', async () => {
    await openProject({ ...SPEC_PROJECT, scenes: [{ ...SPEC_PROJECT.scenes[0], referenceImageId: 'start.png' }] }, 'produce');
    fireEvent.change(screen.getByLabelText('From', { selector: '#mv-scene-s1-start-from' }), { target: { value: 'start' } });
    await showFrames();
    fireEvent.click(screen.getByRole('button', { name: /^New frame take$/ }));
    await waitFor(() => expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'harbor at dawn',
      referenceImageFiles: ['start.png', 'mood.png'],
      musicVideo: expect.objectContaining({ projectId: 'mv-spec', sceneId: 's1', compose: true, fromFrame: true }),
    }), { silent: true }));
  });

  // Uniquely catches Refine sending the shot prompt instead of the instruction, the frame not leading, or the shot's picked references not riding along.
  it('refines the start frame by a short instruction, sending the references picked on the shot after that frame', async () => {
    await openProject({ ...SPEC_PROJECT, scenes: [{ ...SPEC_PROJECT.scenes[0], referenceImageId: 'start.png' }] }, 'produce');
    // The automatic set shows as chips; swap the flagged Lead for the Pier set.
    await showFrames();
    const refs = within(screen.getByRole('group', { name: 'References sent with the frames' }));
    expect(refs.getByText('Auto: from the prompt')).toBeTruthy();
    fireEvent.click(refs.getByRole('button', { name: "Don't send Lead" }));
    expect(updateMusicVideoScene).toHaveBeenLastCalledWith('mv-spec', 's1', { frameReferenceIds: [] }, expect.anything());
    fireEvent.click(refs.getByRole('button', { name: 'Add' }));
    fireEvent.click(refs.getByRole('button', { name: /Pier/ }));
    expect(updateMusicVideoScene).toHaveBeenLastCalledWith('mv-spec', 's1', { frameReferenceIds: ['r2'] }, expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'Refine' }));
    fireEvent.change(screen.getByLabelText('What to change in the start frame'), { target: { value: 'remove the hand' } });
    fireEvent.click(screen.getByRole('button', { name: 'Render refined start frame' }));
    await waitFor(() => expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'remove the hand',
      referenceImageFiles: ['start.png', 'set.png'],
      musicVideo: expect.objectContaining({ projectId: 'mv-spec', sceneId: 's1', compose: true, refine: true }),
    }), { silent: true }));
    expect(screen.queryByLabelText('What to change in the start frame')).toBeNull();
  });

  // Uniquely catches a refine sending the frame plus 4 references, over the backends' 4-image cap.
  it('refines a shot with four references by sending the frame plus the first three', async () => {
    const references = ['a', 'b', 'c', 'd'].map((key) => ({ id: `r-${key}`, imageId: `${key}.png`, role: 'character', label: key, note: '', condition: true }));
    await openProject({ ...SPEC_PROJECT, visualSpec: { ...SPEC_PROJECT.visualSpec, references },
      scenes: [{ ...SPEC_PROJECT.scenes[0], referenceImageId: 'start.png' }] }, 'produce');
    expect(screen.getByText('Refines and end frames send the frame plus the first 3.')).toBeTruthy();
    await showFrames();
    fireEvent.click(screen.getByRole('button', { name: 'Refine' }));
    fireEvent.change(screen.getByLabelText('What to change in the start frame'), { target: { value: 'remove the hand' } });
    fireEvent.click(screen.getByRole('button', { name: 'Render refined start frame' }));
    await waitFor(() => expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({
      referenceImageFiles: ['start.png', 'a.png', 'b.png', 'c.png'],
    }), { silent: true }));
  });

  // Uniquely catches a trimmed clip landing only in Video Gen history, never as this shot's take, or not becoming the shot's clip.
  it('trims the shot clip to a later start frame and makes it the shot\'s selected clip take', async () => {
    const scene = { sceneId: 's1', order: 0, prompt: 'waves', referenceImageId: 'img1', videoHistoryId: 'h1',
      takes: [{ takeId: 't-v', kind: 'video', assetId: 'h1', source: 'generated', provider: 'portos', sourceImageId: 'img1', status: 'selected', note: null }] };
    const trimmedTake = { takeId: 't-trim', kind: 'video', assetId: 'h1-trim', source: 'trimmed', provider: null, status: 'candidate', note: null };
    trimVideoStart.mockResolvedValueOnce({ video: { id: 'h1-trim' } });
    addMusicVideoSceneTake.mockResolvedValueOnce({ scene: { ...scene, takes: [...scene.takes, trimmedTake] }, take: trimmedTake });
    selectMusicVideoSceneTake.mockResolvedValueOnce({ ...scene, videoHistoryId: 'h1-trim', takes: [{ ...scene.takes[0], status: 'candidate' }, { ...trimmedTake, status: 'selected' }] });
    await openProject({ ...PROJECT_WITH_CLIP, id: 'mv-trim', scenes: [scene] }, 'produce');
    const render = within(await screen.findByRole('region', { name: 'Render' }));
    for (let i = 0; i < 12; i += 1) fireEvent.click(render.getByRole('button', { name: 'Next frame' }));
    fireEvent.click(render.getByRole('button', { name: /Start clip here/ }));
    await waitFor(() => expect(selectMusicVideoSceneTake).toHaveBeenCalledWith('mv-trim', 's1', 't-trim', { silent: true }));
    expect(trimVideoStart).toHaveBeenCalledWith('h1', 0.5, { silent: true });
    expect(addMusicVideoSceneTake).toHaveBeenCalledWith('mv-trim', 's1', { kind: 'video', assetId: 'h1-trim', source: 'trimmed', sourceImageId: 'img1', provider: 'portos' }, { silent: true });
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
    await openProject({ ...PROJECT_NO_CLIP, id: 'mv-takes', name: 'Takes Project', scenes: [scene] }, 'produce');

    await showFrames();
    const strip = screen.getByRole('list', { name: /Frame takes/ });
    // How a take was made is not labeled under it.
    expect(within(strip).queryByText(/imported|generated/)).toBeNull();
    fireEvent.click(within(strip).getByRole('button', { name: /Use/ }));
    await waitFor(() => expect(selectMusicVideoSceneTake).toHaveBeenCalledWith('mv-takes', 's1', 't-b', { silent: true }));
    // The server's answer moves the selection; the other take now offers "Use".
    await waitFor(() => expect(within(strip).getAllByText('In use', { selector: 'button > span' })).toHaveLength(1));
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
    // The external handoff lives in Project settings › Files.
    await openSettings('Files');

    const file = new File(['png-bytes'], 'S01-s1-harbor.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Import generated files'), { target: { files: [file] } });
    await waitFor(() => expect(importMusicVideoHandoff).toHaveBeenCalledWith('mv-spec', {
      provider: 'midjourney',
      items: [{ kind: 'image', assetId: 'upload-0001.png', originalName: 'S01-s1-harbor.png' }],
    }, { silent: true }));
    expect(uploadGalleryImage).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Imported 1 take from midjourney'));
    closeSettings();
    // The imported take filled the empty slot on the board.
    await openStage('produce');
    await showFrames();
    expect(await screen.findByRole('button', { name: 'View scene 1 reference frame full size' })).toBeTruthy();
  });

  it('downloads the ZIP handoff bundle from Export bundle (#8978)', async () => {
    getMusicVideoHandoffBundle.mockResolvedValueOnce(new ArrayBuffer(8));
    await openProject(SPEC_PROJECT);
    // The external handoff lives in Project settings › Files.
    await openSettings('Files');
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
    await openProject(UNIVERSE_PROJECT, 'cast-sets');

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
    await openProject(UNIVERSE_PROJECT, 'cast-sets');
    fireEvent.click(await screen.findByRole('button', { name: /^Pull from universe$/ }));
    await waitFor(() => expect(getUniverse).toHaveBeenCalledTimes(1));
    expect(updateMusicVideoProject).not.toHaveBeenCalled();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Every canon image is already a reference'));
  });

  it('applies the pull against the latest references, not a stale click-time snapshot (race guard)', async () => {
    let resolveUniverse;
    getUniverse.mockReturnValueOnce(new Promise((resolve) => { resolveUniverse = resolve; }));
    await openProject(UNIVERSE_PROJECT, 'cast-sets');

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
    await openProject(PROJECT_NO_CLIP, 'cast-sets');
    expect(screen.queryByRole('button', { name: /Pull from universe/i })).toBeNull();
  });
});

describe('MusicVideo per-scene clip import (#8978)', () => {
  it('imports a picked video-history clip as a candidate take for the scene, filling the empty slot', async () => {
    addMusicVideoSceneTake.mockResolvedValueOnce({
      scene: { ...PROJECT_NO_CLIP.scenes[0], videoHistoryId: 'rh-9', takes: [{ takeId: 't1', kind: 'video', assetId: 'rh-9', status: 'candidate' }] },
    });
    await openProject(PROJECT_NO_CLIP, 'produce');

    fireEvent.click(await screen.findByRole('button', { name: /^Import clip take$/ }));
    const dialog = await screen.findByRole('dialog', { name: /Pick a video from your gallery/i });
    const galleryItem = await within(dialog).findByText('(no prompt)');
    fireEvent.click(galleryItem.closest('.bg-port-card').querySelector('button'));

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
    await openProject(PROJECT_WITH_CLIP, 'produce');

    await waitFor(() => expect(document.querySelector('video[src="/data/videos/h1.mov"]')).toBeTruthy());
    expect(document.querySelector('video[src="/data/videos/h1.mp4"]')).toBeNull();
  });
});

describe('MusicVideo stage tabs (#9243)', () => {
  const renderAt = (path) => render(
    <MemoryRouter initialEntries={[path]}>
      <LocationProbe />
      {MV_ROUTES}
    </MemoryRouter>,
  );
  const selectedTab = () => screen.getByRole('tab', { selected: true });

  it('opens Project settings › Autopilot at the checkpoint editor from an attention deep link', async () => {
    listMusicVideoProjects.mockResolvedValue([{ ...PROJECT_WITH_CLIP,
      autonomousRun: { id: 'auto-1', status: 'awaiting-approval', awaiting: 'lyrics', stage: 'lyrics', output: { lyrics: 'Example lyric line' }, brief: {} },
    }]);
    renderAt('/music-video/mv-1/setup?mvPanel=autopilot#mv-auto-edit');
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('tab', { name: /^Autopilot/ })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(document.getElementById('mv-auto-edit')).toHaveFocus());
    expect(dialog.contains(document.getElementById('mv-auto-edit'))).toBe(true);
  });

  it('lets the header Autopilot button stand in for the attention row of a run awaiting its checkpoint', async () => {
    listMusicVideoProjects.mockResolvedValue([{ ...PROJECT_WITH_CLIP,
      autonomousRun: { id: 'auto-1', status: 'awaiting-approval', awaiting: 'lyrics', stage: 'lyrics', output: { lyrics: 'Example lyric line' }, brief: {} },
    }]);
    renderAt('/music-video/mv-1/setup');
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    expect(screen.queryByRole('region', { name: 'Needs attention' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Autonomous run/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('tab', { name: /^Autopilot/ })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(document.getElementById('mv-auto-edit')).toHaveFocus());
  });

  // Uniquely catches Edit shot losing its route (Shots) or the shot's card not opening in the side panel.
  it('opens the shot playing in the preview on Shots in the side panel', async () => {
    listMusicVideoProjects.mockResolvedValue([{ ...PROJECT_WITH_CLIP, scenes: [{ ...PROJECT_WITH_CLIP.scenes[0], startSec: 0 }] }]);
    renderAt('/music-video/mv-1/cast-sets');
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    const dock = screen.getByRole('complementary', { name: 'Preview' });
    fireEvent.click(within(dock).getByRole('button', { name: 'Edit shot' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/music-video/mv-1/produce/scene/s1'));
    expect(selectedTab()).toHaveAccessibleName(STAGE_TABS.produce);
    const panel = await screen.findByRole('dialog');
    expect(panel.querySelector('#scene-s1')).not.toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'Close shot' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/\/music-video\/mv-1\/produce$/));
  });

  // Uniquely catches the player coming back on Plan, which is checked by reading; watching is on Shots.
  it('opens Plan without a preview', async () => {
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP]);
    renderAt('/music-video/mv-1/board');
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    expect(screen.queryByRole('complementary', { name: 'Preview' })).toBeNull();
    await openStage('produce');
    expect(screen.getByRole('complementary', { name: 'Preview' })).toBeInTheDocument();
  });

  // Uniquely catches the shot list losing its read-through: shots in song order with their lyric, action and own problems, opening each shot.
  it('checks every shot on Shots in song order with its problems on its row, and opens a shot', async () => {
    listMusicVideoProjects.mockResolvedValue([{ ...PROJECT_WITH_CLIP,
      audioAnalysis: { ...PROJECT_ANALYZED.audioAnalysis, durationSec: 12 },
      scenes: [
        { sceneId: 's2', order: 1, startSec: 4, endSec: 12, lyricText: 'Second example line', visualIntent: 'Wide on the rink' },
        { sceneId: 's1', order: 0, startSec: 0, endSec: 4, lyricText: '', visualIntent: 'Close on the skates', panelArt: 'panel-a.png', referenceImageId: 'frame-a.png' },
        { sceneId: 's3', order: 2, startSec: null, endSec: null, label: 'New shot' },
      ],
      productionReadiness: { readyForProduction: false, basis: {}, art: { approved: true, problems: [] }, proof: { approved: false, problems: [] },
        storyboard: { approved: false, problems: [], coverage: [], incompleteShots: [{ sceneId: 's3', missing: ['timing'] }],
          shots: [{ sceneId: 's1', action: 'Close on the skates', camera: 'Low dolly' }],
          lyricAnchors: [{ sceneId: 's2', sung: ['Second example line'], anchored: [] }] } },
    }]);
    renderAt('/music-video/mv-1/produce');
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    const list = screen.getByRole('region', { name: 'Shot list' });
    const rows = within(list).getAllByRole('button', { name: /^Edit / });
    // A new shot with no timing yet stays listed, last and unnumbered, with its problem.
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual(['Edit Shot 1', 'Edit Shot 2', 'Edit untimed shot New shot']);
    expect(rows[2]).toHaveTextContent('Untimed');
    expect(rows[2]).toHaveTextContent('Missing timing');
    expect(rows[0]).toHaveTextContent('Instrumental');
    // The storyboard panel, not the shot's frame: Plan checks the board.
    expect(rows[0].querySelector('img')).toHaveAttribute('src', '/data/images/panel-a.png');
    expect(rows[0]).toHaveTextContent('Shot 1 · Low dolly · Close on the skates');
    expect(rows[1]).toHaveTextContent('“Second example line”');
    expect(rows[1]).toHaveTextContent('Sung “Second example line”, anchored to nothing');
    expect(within(list).getByText('2 need a fix')).toBeInTheDocument();

    fireEvent.click(within(list).getByRole('button', { name: 'Needs a fix (2)' }));
    expect(within(list).getAllByRole('button', { name: /^Edit / })).toHaveLength(2);
    fireEvent.click(within(list).getByRole('button', { name: 'Edit Shot 2' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/music-video/mv-1/produce/scene/s2'));
  });

  // Uniquely catches a lingering ?shots=fix emptying the list once nothing needs a fix (its filter buttons are gone).
  it('lists every shot when the fix filter is left on but nothing needs a fix', async () => {
    listMusicVideoProjects.mockResolvedValue([{ ...PROJECT_WITH_CLIP, scenes: [{ sceneId: 's1', order: 0, startSec: 0, endSec: 4 }] }]);
    renderAt('/music-video/mv-1/produce?shots=fix');
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    const list = screen.getByRole('region', { name: 'Shot list' });
    expect(within(list).getByRole('button', { name: 'Edit Shot 1' })).toBeInTheDocument();
    expect(within(list).queryByRole('group', { name: 'Filter shots' })).toBeNull();
  });

  it('opens Story without a preview and keeps a rough draft across stage navigation', async () => {
    listMusicVideoProjects.mockResolvedValue([{ ...PROJECT_WITH_CLIP, concept: { prompt: 'Existing direction', style: 'Blue', songStyle: 'Synth' } }]);
    renderAt('/music-video/mv-1/story');
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    expect(screen.getByLabelText('Concept')).toHaveValue('Existing direction');
    expect(screen.getByLabelText('Visual style')).toHaveValue('Blue');
    expect(screen.getByLabelText('Song style')).toHaveValue('Synth');
    expect(screen.queryByRole('complementary', { name: 'Preview' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Story in your own words'), { target: { value: 'A rough story draft' } });
    await openStage('cast-sets');
    expect(screen.getByLabelText('Concept')).not.toBeVisible();
    await openStage('story');
    expect(screen.getByLabelText('Story in your own words')).toHaveValue('A rough story draft');
    expect(screen.queryByRole('complementary', { name: 'Preview' })).toBeNull();
  });

  it('keeps failed direction text visible and offers a retry', async () => {
    listMusicVideoProjects.mockResolvedValue([{ ...PROJECT_WITH_CLIP, concept: { prompt: 'Original direction' } }]);
    updateMusicVideoProject.mockRejectedValueOnce(new Error('Could not save'));
    renderAt('/music-video/mv-1/story');
    const concept = await screen.findByLabelText('Concept');
    fireEvent.change(concept, { target: { value: 'My unsaved direction' } });
    fireEvent.blur(concept);
    const retry = await screen.findByRole('button', { name: 'Retry saving' });
    expect(concept).toHaveValue('My unsaved direction');
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry saving' })).toBeNull());
    expect(updateMusicVideoProject).toHaveBeenLastCalledWith('mv-1', { concept: { prompt: 'My unsaved direction' } }, { silent: true });
  });

  it('saves successive direction edits in order after an earlier request fails', async () => {
    listMusicVideoProjects.mockResolvedValue([{ ...PROJECT_WITH_CLIP, concept: { prompt: 'Original direction' } }]);
    let rejectFirst;
    updateMusicVideoProject.mockImplementationOnce(() => new Promise((_, reject) => { rejectFirst = reject; }));
    renderAt('/music-video/mv-1/story');
    const concept = await screen.findByLabelText('Concept');
    fireEvent.change(concept, { target: { value: 'First edit' } });
    fireEvent.blur(concept);
    await waitFor(() => expect(rejectFirst).toBeTypeOf('function'));
    fireEvent.change(concept, { target: { value: 'Second edit' } });
    fireEvent.blur(concept);
    expect(updateMusicVideoProject).toHaveBeenCalledTimes(1);
    await act(async () => rejectFirst(new Error('First request failed')));
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledTimes(2));
    expect(updateMusicVideoProject).toHaveBeenLastCalledWith('mv-1', { concept: { prompt: 'Second edit' } }, { silent: true });
    expect(concept).toHaveValue('Second edit');
    expect(screen.queryByRole('button', { name: 'Retry saving' })).toBeNull();
  });

  // Uniquely catches the opening title card form leaving the Look step or reappearing on Plan/Shots.
  it('edits the opening title card on the Look step only, right under the preview', async () => {
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP]);
    renderAt('/music-video/mv-1/cast-sets');
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    const preview = screen.getByRole('complementary', { name: 'Preview' });
    const card = screen.getByRole('region', { name: 'Opening title card' });
    expect(preview.nextElementSibling).toBe(card);
    for (const stage of ['board', 'produce']) {
      await openStage(stage);
      expect(screen.queryByRole('region', { name: 'Opening title card' })).toBeNull();
    }
  });

  it('leads Shots with the player and Lock all stills, keeps approvals off Plan, closes Look with its approval, keeps the run in Project settings and unsaved planning edits across steps', async () => {
    // Stills not yet locked, so Shots offers Lock all stills beside the player.
    listMusicVideoProjects.mockResolvedValue([{ ...PROJECT_WITH_CLIP,
      autonomousRun: { status: 'needs-human', stage: 'video', output: {}, brief: {} },
      productionReadiness: { readyForProduction: false, basis: {}, art: { approved: true, problems: [] }, storyboard: { approved: false, problems: [] }, proof: { approved: true, problems: [] } },
    }]);
    renderAt('/music-video/mv-1/cast-sets');
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    const review = screen.getByRole('region', { name: 'Production review' });
    expect(within(review).getByRole('region', { name: 'Approve: Art direction' })).toBeInTheDocument();
    expect(within(review).queryByRole('region', { name: 'Approve: Lyric-timed storyboard' })).toBeNull();
    expect(screen.queryByText('Production approvals')).toBeNull();
    const castDraft = within(review).getByLabelText('Cast guide');
    fireEvent.change(castDraft, { target: { value: 'Example unsaved cast direction' } });

    const approvals = { 'cast-sets': 'Art direction', produce: 'Lyric-timed storyboard' };
    for (const stage of ['board', 'produce', 'cast-sets']) {
      await openStage(stage);
      const panel = screen.getByRole('tabpanel');
      // The selected tab also reads its state (", Done") to screen readers; the panel is labelled by the step's heading.
      const title = selectedTab().textContent.split(',')[0];
      expect(within(panel).getByRole('heading', { level: 3, name: title })).toBeInTheDocument();
      expect(panel).toHaveAccessibleName(title);
      // Plan has no approval: its shots are locked on Shots.
      if (stage === 'board') {
        expect(within(panel).queryByRole('region', { name: 'Production review' })).toBeNull();
        continue;
      }
      const stageReview = within(panel).getByRole('region', { name: 'Production review' });
      if (stage === 'cast-sets') {
        // Look is reviewed through its visual guide: the step's work comes first and the approval closes it.
        expect(panel.lastElementChild).toBe(stageReview);
      } else {
        // Shots is reviewed by watching: the player leads, the approval beside it, then the work.
        const player = within(panel).getByRole('complementary', { name: 'Preview' });
        expect(player.compareDocumentPosition(stageReview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(stageReview.parentElement).toBe(player.parentElement.parentElement);
      }
      expect(within(stageReview).getAllByRole('region', { name: /^Approve: / })).toHaveLength(1);
      expect(within(stageReview).getByRole('region', { name: `Approve: ${approvals[stage]}` })).toBeInTheDocument();
      // The run is no longer a shared panel under every step.
      expect(screen.queryByRole('region', { name: 'Autonomous run' })).toBeNull();
    }
    expect(screen.getByLabelText('Cast guide')).toHaveValue('Example unsaved cast direction');

    // The run lives in Project settings › Autopilot, opened from the header.
    fireEvent.click(screen.getByRole('button', { name: /^Autonomous run/ }));
    const drawer = await screen.findByRole('dialog', { name: 'Project settings' });
    expect(within(drawer).getByRole('region', { name: 'Autonomous run' })).toBeInTheDocument();
    closeSettings();
    expect(screen.getByLabelText('Cast guide')).toHaveValue('Example unsaved cast direction');
  });

  it('uses the newly selected project making-of notes and links when drafting publication copy', async () => {
    const first = { ...PROJECT_WITH_CLIP, publishKit: { notes: 'Example first story', links: { youtube: 'https://example.com/first' } } };
    const second = { ...PROJECT_WITH_CLIP, id: 'mv-other', name: 'Example Other Project', publishKit: { notes: 'Example second story', links: { youtube: 'https://example.com/second' } } };
    listMusicVideoProjects.mockResolvedValue([first, second]);
    // Each opened project reads its own platform set.
    getMusicVideoPublishPlatforms.mockResolvedValue({ platforms: { youtube: { enabled: true } } });
    draftMusicVideoPublishCopy.mockResolvedValueOnce({ project: second });
    render(<MemoryRouter initialEntries={['/music-video/mv-1/publish']}>
      <NavTo to="/music-video/mv-other/publish" />
      {MV_ROUTES}
    </MemoryRouter>);
    const notes = await screen.findByLabelText(/Making-of notes/);
    await waitFor(() => expect(listQueueMediaJobs).toHaveBeenCalledWith({ kind: 'video-upscale', limit: 10 }));
    expect(notes).toHaveValue('Example first story');
    fireEvent.change(notes, { target: { value: 'Example unsaved first story' } });
    fireEvent.click(screen.getByRole('button', { name: 'go-/music-video/mv-other/publish' }));
    await screen.findByRole('heading', { level: 2, name: second.name });
    expect(await screen.findByLabelText(/Making-of notes/)).toHaveValue('Example second story');
    await waitFor(() => expect(getMusicVideoFestivalPacket).toHaveBeenLastCalledWith(second.id, { silent: true }));
    expect(screen.getByLabelText(/Full video URL/)).toHaveValue('https://example.com/second');
    fireEvent.click(screen.getByRole('button', { name: 'Draft copy' }));
    await waitFor(() => expect(draftMusicVideoPublishCopy).toHaveBeenCalledWith(second.id, expect.objectContaining({
      notes: 'Example second story', links: { youtube: 'https://example.com/second' }, length: 'short',
    })));
  });

  it('opens the stage named in the URL, falls back to the project\'s own stage for an unknown one, and the tabs navigate', async () => {
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP]);
    renderAt('/music-video/mv-1/produce');
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    expect(selectedTab()).toHaveTextContent(/^Shots/);
    expect(screen.getByRole('region', { name: 'Composition' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Add scene/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: STAGE_TABS.board }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/music-video/mv-1/board'));
    expect(selectedTab()).toHaveTextContent(/^Storyboard/);
    expect(screen.getByText('Start the storyboard')).toBeTruthy();
  });

  it('falls back to the stage the project is in when the URL names no stage or an unknown one', async () => {
    // Track linked but not analyzed: Setup.
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP]);
    renderAt('/music-video/mv-1/not-a-stage');
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    expect(selectedTab()).toHaveTextContent(/^Song/);
  });

  it('keeps the open tab when a stage completes, while the header moves on to the next action', async () => {
    const analyzed = { ...PROJECT_NO_CLIP, audioAnalysis: PROJECT_ANALYZED.audioAnalysis };
    analyzeMusicVideoProject.mockResolvedValue(analyzed);
    await openProject(PROJECT_NO_CLIP);
    expect(selectedTab()).toHaveTextContent(/^Song/);

    fireEvent.click(screen.getByRole('button', { name: 'Analyze song' }));
    await waitFor(() => expect(analyzeMusicVideoProject).toHaveBeenCalledWith('mv-2', { silent: true }));
    // Analysis is done and the shot has no frame or clip: the header now points at making the footage…
    expect(await screen.findByRole('button', { name: 'Make the footage' })).toBeTruthy();
    // …but the tab the director is working in is not pulled out from under them.
    expect(selectedTab()).toHaveTextContent(/^Song/);
  });

  it('every control has exactly one home step or Project settings tab', async () => {
    const project = { ...PROJECT_WITH_CLIP, castAndSets: { status: 'review', revision: 1, plan: {}, images: {} }, audioAnalysis: PROJECT_ANALYZED.audioAnalysis };
    // Each finder searches `root` (the page, or the open settings drawer).
    const steps = {
      setup: {
        'Change track': (root) => root.queryByLabelText('Change track'),
        'Song content': (root) => root.queryByRole('radio', { name: 'Vocal song' }),
      },
      story: { Concept: (root) => root.queryByRole('textbox', { name: 'Concept' }) },
      'cast-sets': { 'Cast & Sets check-in': (root) => root.queryByLabelText('Cast & Sets check-in') },
      board: { 'Start the storyboard': (root) => root.queryByText('Start the storyboard') },
      // Shots: the scene board, its timing tools, the footage, then the composition over it.
      produce: { 'Add scene': (root) => root.queryByRole('button', { name: /Add scene/ }), 'AI Plan': (root) => root.queryByRole('button', { name: /AI Plan/ }),
        'Shot prompt': (root) => root.queryByLabelText('Shot prompt'),
        Footage: () => document.getElementById('mv-generation'), Typography: (root) => root.queryByText(/^Typography —/) },
      review: { 'Render final': (root) => root.queryByRole('button', { name: /^Render final$/ }), 'Render excerpt': (root) => root.queryByRole('button', { name: /Render excerpt/ }) },
    };
    const settings = {
      // The render style and the image/video services are set once, here.
      Project: {
        'Render style': () => document.getElementById('mv-toolbar-render-style'), 'Scene video renderer': (root) => root.queryByLabelText('Scene video renderer'),
        Media: (root) => root.queryByLabelText('Design and composition media'),
      },
      Audio: { MIDI: (root) => root.queryByRole('button', { name: /^MIDI$/ }) },
      Autopilot: { 'Automation brief': (root) => root.queryByLabelText('Automation brief'), 'Start production': (root) => root.queryByRole('button', { name: /Start production/ }) },
      Files: { 'Export bundle': (root) => root.queryByRole('button', { name: /^Export bundle$/ }) },
    };
    // Importing a file is deliberately offered twice: a guide is imported where it is chosen (Look),
    // and any other development file in Project settings › Files.
    const importFile = (root) => root.queryByLabelText('Import development file');
    await openProject(project);
    for (const [stage, own] of Object.entries(steps)) {
      await openStage(stage);
      for (const [name, find] of Object.entries(own)) expect(find(screen), `${name} on ${stage}`).toBeTruthy();
      for (const [other, theirs] of [...Object.entries(steps), ...Object.entries(settings)]) {
        if (other === stage) continue;
        for (const [name, find] of Object.entries(theirs)) expect(find(screen), `${name} must not be on ${stage}`).toBeFalsy();
      }
      expect(!!importFile(screen), `Import development file on ${stage}`).toBe(stage === 'cast-sets');
    }
    // The drawer opens over the last step; only the open settings tab's controls are in it.
    for (const [tab, own] of Object.entries(settings)) {
      await openSettings(tab);
      const drawer = within(screen.getByRole('dialog', { name: 'Project settings' }));
      for (const [name, find] of Object.entries(own)) expect(find(drawer), `${name} in ${tab} settings`).toBeTruthy();
      for (const [other, theirs] of [...Object.entries(steps), ...Object.entries(settings)]) {
        if (other === tab) continue;
        for (const [name, find] of Object.entries(theirs)) {
          const found = find(drawer);
          expect(!!found && screen.getByRole('dialog', { name: 'Project settings' }).contains(found), `${name} must not be in ${tab} settings`).toBe(false);
        }
      }
      expect(!!importFile(drawer), `Import development file in ${tab} settings`).toBe(tab === 'Files');
      closeSettings();
    }
  });

  describe('the sticky header\'s next action', () => {
    it('runs the autopilot for a fresh autopilot project', async () => {
      // The check-in is already skipped, so the run goes straight from analysis to the plan.
      const project = { ...PROJECT_NO_CLIP, scenes: [], lyricCues: [], castAndSets: { status: 'skipped' }, automation: { tools: ['image:local'], guidance: '', budgetUsd: null } };
      const analyzed = { ...project, audioAnalysis: PROJECT_ANALYZED.audioAnalysis };
      analyzeMusicVideoProject.mockResolvedValue(analyzed);
      importMusicVideoTrackLyrics.mockResolvedValue({ project: analyzed, imported: 0, markers: 0 });
      planMusicVideoProject.mockResolvedValue({ project: analyzed, scenesAdded: 1, promptsSeeded: false });
      await openProject(project);
      fireEvent.click(screen.getByRole('button', { name: 'Run autopilot' }));
      await waitFor(() => expect(analyzeMusicVideoProject).toHaveBeenCalledWith(project.id, { silent: true }));
      await waitFor(() => expect(planMusicVideoProject).toHaveBeenCalledWith(project.id, { seedPrompts: true }, { silent: true }));
    });

    it('keeps the Cast & Sets reference check-in available from its tab', async () => {
      const waiting = {
        ...PROJECT_ANALYZED, scenes: [], lyricCues: [], automation: { tools: ['image:local'], guidance: '', budgetUsd: null },
        castAndSets: { status: 'review', revision: 1, plan: {}, images: {} },
      };
      const approved = { ...waiting, castAndSets: { ...waiting.castAndSets, status: 'approved' } };
      approveMusicVideoCastAndSets.mockResolvedValue({ project: approved, stage: approved.castAndSets });
      importMusicVideoTrackLyrics.mockResolvedValue({ project: approved, imported: 0, markers: 0 });
      planMusicVideoProject.mockResolvedValue({ project: approved, scenesAdded: 1, promptsSeeded: false });
      await openProject(waiting, 'setup');
      await openStage('cast-sets');
      fireEvent.click(screen.getByRole('button', { name: /Approve & continue/ }));
      await waitFor(() => expect(approveMusicVideoCastAndSets).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(planMusicVideoProject).toHaveBeenCalled());
    });

    it('stops a running production run and shows what it has spent against its cap', async () => {
      const run = {
        id: 'run-1', status: 'running', interrupted: false, directive: '', stopReason: null, error: null, pool: [],
        limits: { maxGenerations: 12, maxReviewAttempts: 3, spendCapUsd: 20 }, usage: { generations: 3, spentUsd: 4.5 }, steps: [],
      };
      const project = { ...PROJECT_ANALYZED, productionRuns: [run] };
      stopMusicVideoProduction.mockResolvedValue({ project, run });
      await openProject(project, 'produce');
      expect(screen.getByText('$4.50 / $20.00')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Stop production' }));
      await waitFor(() => expect(stopMusicVideoProduction).toHaveBeenCalledWith('mv-3', 'run-1', { silent: true }));
    });

    it('keeps the attention row for a parked production run the Autopilot button does not report', async () => {
      const run = {
        id: 'run-2', status: 'needs-human', interrupted: false, directive: '', stopReason: 'Example stop reason', error: null, pool: [],
        limits: { maxGenerations: 12, maxReviewAttempts: 3, spendCapUsd: 20 }, usage: { generations: 3, spentUsd: 4.5 }, steps: [],
      };
      await openProject({ ...PROJECT_ANALYZED, productionRuns: [run] }, 'produce');
      // "needs-human" has no Resume and the header's Autopilot button stays plain, so the row is the only signal.
      const banner = screen.getByRole('region', { name: 'Needs attention' });
      expect(within(banner).getByText('Production needs you')).toBeTruthy();
    });

    it('takes a finished project on to its release (#9281)', async () => {
      await openProject({ ...PROJECT_WITH_CLIP, audioAnalysis: PROJECT_ANALYZED.audioAnalysis, renderHistoryId: 'rh-9' }, 'produce');
      fireEvent.click(screen.getByRole('button', { name: 'Build the publishing kit' }));
      await waitFor(() => expect(selectedTab()).toHaveTextContent(/^Publish/));
      expect(screen.getByRole('region', { name: 'Release assets' })).toBeTruthy();
      expect(screen.getByRole('button', { name: /Build publishing kit/ })).not.toBeDisabled();
    });
  });

  describe('docked preview', () => {
    const DOCUMENT = { directory: 'music-video/mv-doc/composition/doc-a', entry: 'index.html', updatedAt: '2026-01-01T00:00:00.000Z', source: { kind: 'template', name: 'layered' }, files: 9, bytes: 90000 };
    const docProject = {
      ...PROJECT_WITH_CLIP,
      id: 'mv-doc',
      name: 'Document Project',
      audioAnalysis: null,
      composition: { version: 1, mode: 'document', textCues: [], style: { color: '#ffffff', font: 'sans' }, posterSec: null, document: DOCUMENT },
      scenes: [
        { sceneId: 's1', order: 0, prompt: 'a', referenceImageId: 'img1', videoHistoryId: 'h1', startSec: 0, endSec: 4 },
        { sceneId: 's2', order: 1, prompt: 'b', referenceImageId: 'img1', videoHistoryId: 'h1', startSec: 4, endSec: 8 },
      ],
    };

    it('docks the preview on every stage and seeks it to a scene\'s start when its card is opened', async () => {
      listTracks.mockResolvedValue([{ id: 't1', title: 'Neon Song', audioFilename: 'neon.mp3' }]);
      await openProject(docProject, 'setup');
      expect(await screen.findByTitle('Composition document preview')).toBeTruthy();

      await openStage('produce');
      expect(screen.getByTitle('Composition document preview')).toBeTruthy();
      await waitFor(() => expect(screen.getByText('0.00s / 60.0s')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Open Shot 2' }));
      await waitFor(() => expect(screen.getByText('4.00s / 60.0s')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Open Shot 1' }));
      await waitFor(() => expect(screen.getByText('0.00s / 60.0s')).toBeTruthy());
    });

    it('falls back to the latest finished draft excerpt when there is no composition document', async () => {
      const project = {
        ...PROJECT_WITH_CLIP,
        excerpts: [
          { id: 'mve-1', startSec: 0, endSec: 10, status: 'complete', filename: 'excerpt-old.mp4', notes: [] },
          { id: 'mve-2', startSec: 10, endSec: 20, status: 'complete', filename: 'excerpt-new.mp4', notes: [] },
        ],
      };
      // Final render plays the newest draft; Storyboard leads with the storyboard animatic instead.
      await openProject(project, 'review');
      const player = await screen.findByLabelText('Draft excerpt preview');
      expect(player.getAttribute('src')).toBe('/data/videos/excerpt-new.mp4');
      expect(screen.queryByTitle('Composition document preview')).toBeNull();
      // Every finished draft stays reachable from the dock's source picker.
      fireEvent.change(screen.getByLabelText('Preview source'), { target: { value: 'excerpt:mve-1' } });
      await waitFor(() => expect(screen.getByLabelText('Draft excerpt preview').getAttribute('src')).toBe('/data/videos/excerpt-old.mp4'));
      await openStage('cast-sets', false);
      await waitFor(() => expect(screen.getByLabelText('Preview source')).toHaveValue('excerpt:mve-1'));
    });

    // Uniquely catches resizing the Look/Publish preview remounting its player or resetting the chosen source.
    it('expands the Look and Publish preview into the main column and returns the same player to the sidebar', async () => {
      const project = {
        ...PROJECT_WITH_CLIP,
        renderHistoryId: 'rh-9',
        excerpts: [{ id: 'mve-1', startSec: 0, endSec: 10, status: 'complete', filename: 'excerpt-old.mp4', notes: [] }],
      };
      await openProject(project, 'cast-sets');
      fireEvent.change(screen.getByLabelText('Preview source'), { target: { value: 'excerpt:mve-1' } });
      for (const stage of ['cast-sets', 'publish']) {
        if (stage === 'publish') await openStage(stage, false);
        const player = await screen.findByLabelText('Draft excerpt preview');
        player.currentTime = 3;
        fireEvent.timeUpdate(player);
        const dock = screen.getByRole('complementary', { name: 'Preview' }).closest('.max-xl\\:order-first');
        fireEvent.click(screen.getByRole('button', { name: 'Expand preview into main area' }));
        expect(dock).toHaveClass('xl:col-start-2', 'xl:row-start-1');
        expect(screen.getByRole('tabpanel')).toHaveClass('xl:row-start-2');
        expect(screen.getByLabelText('Draft excerpt preview')).toBe(player);
        expect(player.currentTime).toBe(3);
        expect(screen.getByLabelText('Preview source')).toHaveValue('excerpt:mve-1');
        const restore = screen.getByRole('button', { name: 'Return preview to sidebar' });
        expect(restore).toHaveAttribute('aria-pressed', 'true');
        fireEvent.click(restore);
        expect(dock).toHaveClass('xl:sticky');
        expect(screen.getByRole('tabpanel')).not.toHaveClass('xl:row-start-2');
        expect(screen.getByLabelText('Draft excerpt preview')).toBe(player);
        expect(player.currentTime).toBe(3);
      }
      await openStage('board', false);
      expect(screen.queryByRole('button', { name: 'Expand preview into main area' })).toBeNull();
    });

    it('plays the final render first and keeps a picked draft across stage tabs', async () => {
      const project = {
        ...PROJECT_WITH_CLIP,
        renderHistoryId: 'rh-9',
        excerpts: [{ id: 'mve-1', startSec: 0, endSec: 10, status: 'complete', filename: 'excerpt-old.mp4', notes: [] }],
      };
      await openProject(project, 'setup');
      const final = await screen.findByLabelText('Final render preview');
      expect(final.getAttribute('src')).toBe('/data/videos/final.mp4');
      fireEvent.change(screen.getByLabelText('Preview source'), { target: { value: 'excerpt:mve-1' } });
      await waitFor(() => expect(screen.getByLabelText('Draft excerpt preview').getAttribute('src')).toBe('/data/videos/excerpt-old.mp4'));
      await openStage('cast-sets', false);
      expect(screen.getByLabelText('Draft excerpt preview').getAttribute('src')).toBe('/data/videos/excerpt-old.mp4');
      expect(screen.queryByLabelText('Final render preview')).toBeNull();
    });

    it('keeps the dock with an empty state when there is nothing to play yet', async () => {
      await openProject({ ...PROJECT_WITH_CLIP, trackId: null, uploadedAudioFilename: null }, 'produce');
      const dock = screen.getByRole('complementary', { name: 'Preview' });
      expect(dock).toHaveTextContent('Nothing to play yet');
      expect(within(dock).queryByLabelText('Preview source')).toBeNull();
      expect(within(dock).queryByTitle('Composition document preview')).toBeNull();
      expect(within(dock).queryByLabelText('Draft excerpt preview')).toBeNull();
    });

    it('plays the storyboard animatic when the project has a track and shots but no document or finished excerpt', async () => {
      await openProject(PROJECT_WITH_CLIP, 'produce');
      const dock = screen.getByRole('complementary', { name: 'Preview' });
      expect(dock).toHaveTextContent('Storyboard animatic');
      expect(dock).not.toHaveTextContent('Nothing to play yet');
    });
  });
});

it('waits for a grade save before rendering and keeps the saved look when a later save fails', async () => {
  const project = { ...PROJECT_WITH_CLIP, composition: { mode: 'composed', textCues: [], style: { color: '#ffffff', font: 'sans' } } };
  let finishSave;
  updateMusicVideoProject.mockImplementationOnce((_id, patch) => new Promise((resolve) => {
    finishSave = () => resolve({ ...project, ...patch });
  }));
  await openProject(project, 'compose');
  fireEvent.change(screen.getByLabelText('Default section look'), { target: { value: 'teal-night' } });
  await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith(project.id,
    { composition: expect.objectContaining({ grade: expect.objectContaining({ preset: 'teal-night' }) }) }, { silent: true }));
  expect(screen.getByLabelText('Default section look')).toBeDisabled();
  expect(screen.getByLabelText('Default section look').value).toBe('neutral');
  await openStage('review');
  expect(screen.getByRole('button', { name: /^Render final$/ })).toBeDisabled();
  expect(renderMusicVideoProject).not.toHaveBeenCalled();
  await act(async () => { finishSave(); });
  expect(screen.getByRole('button', { name: /^Render final$/ })).not.toBeDisabled();
  await openStage('compose');
  expect(screen.getByLabelText('Default section look').value).toBe('teal-night');
  updateMusicVideoProject.mockRejectedValueOnce(new Error('Grade save unavailable'));
  fireEvent.change(screen.getByLabelText('Default section look'), { target: { value: 'golden-hour' } });
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Grade save unavailable'));
  expect(screen.getByLabelText('Default section look').value).toBe('teal-night');
});

describe('MusicVideo main page project cards', () => {
  it('renders richly detailed cards for each project below the new project card', async () => {
    const projectWithRender = {
      ...PROJECT_WITH_CLIP,
      id: 'mv-render-1',
      name: 'Electric Skyline',
      status: 'complete',
      renderHistoryId: 'rh-final-1',
      audioAnalysis: { bpm: 124, durationSec: 210 },
      videoSettings: { backend: 'fal', modelId: 'hunyuan_video', generationMode: 'image', audioReactiveLora: 'reactive.safetensors' },
      concept: { universeId: 'cyber-tokyo', style: 'hyper-detailed synthwave' },
      visualSpec: { palette: ['#ff0055', '#00ffee'], references: [] },
      vocalStemFilename: 'electric-vocals.wav',
      midiTranscription: 'electric-midi.mid',
    };
    listMusicVideoProjects.mockResolvedValueOnce([projectWithRender, PROJECT_NO_CLIP]);
    renderMV();

    // The header's New project button is the only one (no duplicate card buttons)
    expect(await screen.findByRole('button', { name: /New project/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New music video/i })).toBeNull();

    // Project cards grid exists below new project card
    const grid = await screen.findByTestId('mv-project-grid');
    expect(grid).toBeInTheDocument();

    // Richly detailed cards rendered
    expect(within(grid).getByText('Electric Skyline')).toBeInTheDocument();
    expect(within(grid).getByText('No Clips')).toBeInTheDocument();

    // Rich configuration options and status on Electric Skyline card
    const card = screen.getByTestId('mv-project-card-mv-render-1');
    expect(within(card).getByText('complete')).toBeInTheDocument();
    expect(within(card).getByText('124 BPM')).toBeInTheDocument();
    expect(within(card).getByText('fal')).toBeInTheDocument();
    expect(within(card).getByText('hunyuan_video')).toBeInTheDocument();
    expect(within(card).getByText('I2V')).toBeInTheDocument();
    expect(within(card).getByText('Reactive')).toBeInTheDocument();
    expect(within(card).getByText('Vocal Stem')).toBeInTheDocument();
    expect(within(card).getByText('MIDI')).toBeInTheDocument();
    expect(within(card).getByText('cyber-tokyo')).toBeInTheDocument();
    expect(within(card).getByText(/hyper-detailed synthwave/i)).toBeInTheDocument();
    expect(within(card).getByText('Final video')).toBeInTheDocument();
  });

  it('navigates to project when clicking Open on its card', async () => {
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP]);
    renderMV();

    const card = await screen.findByTestId(`mv-project-card-${PROJECT_WITH_CLIP.id}`);
    const openBtn = within(card).getByRole('button', { name: /^Open$/i });

    await act(async () => {
      fireEvent.click(openBtn);
    });

    // Navigates and loads the project board
    expect(await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name })).toBeInTheDocument();
  });

  it('renames a version straight from its project card', async () => {
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP]);
    renderMV();
    const card = await screen.findByTestId(`mv-project-card-${PROJECT_WITH_CLIP.id}`);
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: `Rename v1 of ${PROJECT_WITH_CLIP.name}` }));
    });
    const input = await screen.findByLabelText('Project title');
    expect(input).toHaveValue(PROJECT_WITH_CLIP.name);
    updateMusicVideoProject.mockImplementationOnce(async (_id, patch) => ({ ...PROJECT_WITH_CLIP, ...patch }));
    fireEvent.change(input, { target: { value: 'Card Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith(PROJECT_WITH_CLIP.id, { name: 'Card Renamed' }));
    await screen.findByRole('heading', { level: 2, name: 'Card Renamed' });
  });

  it('opens an existing final directly in Final render from the project card', async () => {
    const project = { ...PROJECT_WITH_CLIP, renderHistoryId: 'example-final' };
    listMusicVideoProjects.mockResolvedValue([project]);
    render(<MemoryRouter initialEntries={['/music-video']}><LocationProbe />{MV_ROUTES}</MemoryRouter>);
    const card = await screen.findByTestId(`mv-project-card-${project.id}`);
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: 'Review video' })));
    expect(screen.getByTestId('loc')).toHaveTextContent(`/music-video/${project.id}/review`);
    expect(screen.getByRole('tab', { name: /^Final render/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('handles forking a project directly from its card', async () => {
    cloneMusicVideoProject.mockResolvedValueOnce({
      ...PROJECT_WITH_CLIP,
      id: 'mv-cloned-1',
      name: 'Neon Run (v2)',
      version: 2,
    });
    listMusicVideoProjects.mockResolvedValueOnce([PROJECT_WITH_CLIP]);
    renderMV();

    const card = await screen.findByTestId(`mv-project-card-${PROJECT_WITH_CLIP.id}`);

    const forkBtn = within(card).getByRole('button', { name: /Fork/i });
    await act(async () => {
      fireEvent.click(forkBtn);
    });
    expect(cloneMusicVideoProject).toHaveBeenCalledWith(PROJECT_WITH_CLIP.id, {}, { silent: true });
  });

  it('handles deleting a project directly from its card with confirmation', async () => {
    deleteMusicVideoProject.mockResolvedValueOnce({ ok: true });
    listMusicVideoProjects.mockResolvedValueOnce([PROJECT_WITH_CLIP]);
    renderMV();

    const card = await screen.findByTestId(`mv-project-card-${PROJECT_WITH_CLIP.id}`);

    const deleteBtn = within(card).getByRole('button', { name: `Delete project ${PROJECT_WITH_CLIP.name}` });
    fireEvent.click(deleteBtn);
    expect(within(card).getByText('Delete?')).toBeInTheDocument();

    const confirmBtn = within(card).getByRole('button', { name: `Confirm delete project ${PROJECT_WITH_CLIP.name}` });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });
    expect(deleteMusicVideoProject).toHaveBeenCalledWith(PROJECT_WITH_CLIP.id, { silent: true });
  });

  it('organizes project cards with the newest one first', async () => {
    const older = { ...PROJECT_WITH_CLIP, id: 'mv-old', name: 'Older Video', createdAt: '2026-09-01T00:00:00.000Z' };
    const middle = { ...PROJECT_NO_CLIP, id: 'mv-mid', name: 'Middle Video', createdAt: '2026-09-15T00:00:00.000Z' };
    const newest = { ...PROJECT_WITH_CLIP, id: 'mv-new', name: 'Newest Video', createdAt: '2026-10-01T00:00:00.000Z' };

    listMusicVideoProjects.mockResolvedValueOnce([older, middle, newest]);
    renderMV();

    const grid = await screen.findByTestId('mv-project-grid');
    const cards = within(grid).getAllByTestId(/^mv-project-card-/);
    expect(cards).toHaveLength(3);
    expect(cards[0]).toHaveAttribute('data-testid', 'mv-project-card-mv-new');
    expect(cards[1]).toHaveAttribute('data-testid', 'mv-project-card-mv-mid');
    expect(cards[2]).toHaveAttribute('data-testid', 'mv-project-card-mv-old');
  });
});


describe('direct production review navigation', () => {
  it('focuses the exact step on repeated clicks and restores its deep link with Back/Forward without approval', async () => {
    const project = { ...PROJECT_ANALYZED, scenes: [], castAndSets: { status: 'skipped' }, composition: { mode: 'document' },
      productionReview: { draft: { storyboardSource: 'document', storyboard: [{ id: 'shot-1' }, { id: 'shot-2' }] } },
      productionReadiness: { readyForProduction: false, basis: {}, art: { approved: false, problems: [] },
        storyboard: { approved: false, problems: ['Approve art first'] }, proof: { approved: false, problems: ['Approve storyboard first'] } } };
    listMusicVideoProjects.mockResolvedValue([project]);
    render(<MemoryRouter initialEntries={['/music-video/mv-3/review']}><LocationProbe /><NavTo to={-1} /><NavTo to={1} />{MV_ROUTES}</MemoryRouter>);
    // A skipped sheet left nothing written, so the header sends the director to write it, not to approve it.
    const action = await screen.findByRole('button', { name: 'Write art direction' });
    expect(screen.getByLabelText('Project').querySelector(`option[value="${project.id}"]`).textContent).toBe(project.name);
    fireEvent.click(action);
    // The editor mounts folded at the bottom of the Look step; the jump unfolds it and focuses its first field.
    await waitFor(() => expect(screen.getByLabelText('Cast guide')).toHaveFocus());
    expect(screen.getByLabelText('Cast guide').closest('details').open).toBe(true);
    expect(screen.getByTestId('loc')).toHaveTextContent('/cast-sets#mv-art-direction-editor');
    // With nothing to review the approval is one quiet line, not instructions and a disabled button.
    const art = document.getElementById('mv-review-art');
    expect(art).toHaveAccessibleName('Approve: Art direction');
    expect(art).toHaveTextContent('Opens once the art direction is written and a visual guide is chosen.');
    expect(within(art).queryByRole('button', { name: 'Approve art direction' })).toBeNull();
    expect(art.className).not.toContain('border-port-accent');
    expect(screen.queryByLabelText('Instance password for this approval')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'go--1' }));
    expect(screen.getByTestId('loc')).toHaveTextContent('/review');
    fireEvent.click(screen.getByRole('button', { name: 'go-1' }));
    await waitFor(() => expect(screen.getByLabelText('Cast guide')).toHaveFocus());
  });
});

describe('stage checklist and project options', () => {
  it('keeps Cast & Sets on the art approval after the unwanted sheet is gone, and says an approved sheet file is not that approval', async () => {
    // The guide pick itself is covered by stageChecklist's unit test; selecting
    // one here would make the open approvals panel fetch the sheet's file.
    const project = { ...PROJECT_ANALYZED, scenes: [], castAndSets: { status: 'skipped' },
      devArtifacts: [{ id: 'sheet', kind: 'cast-sets', title: 'Cast sheet', mimeType: 'text/html', version: 1, status: 'approved' }],
      productionReview: { draft: { cast: 'c', environments: 'e', visualLanguage: 'v', motionLanguage: 'm', guideArtifactId: null,
        lyricsMode: 'vocal', timingStatus: 'provisional', timingNotes: '', storyboard: [] } },
      productionReadiness: { readyForProduction: false, basis: {}, art: { approved: false, problems: [] },
        storyboard: { approved: false, problems: [] }, proof: { approved: false, problems: [] } } };
    await openProject(project, 'cast-sets');
    const checklist = screen.getByRole('region', { name: 'What this step needs' });
    expect(checklist).toHaveTextContent('1 of 3 done');
    expect(checklist).toHaveTextContent('Pick a file below with Use as visual guide, or import one.');
    expect(checklist).toHaveTextContent('Art direction approved');
    expect(checklist).toHaveTextContent('Opens once the art direction is written and a guide is chosen.');
    // The guide row lands on the files, where each sheet has Use as visual guide.
    fireEvent.click(within(checklist).getByRole('button', { name: 'Choose a guide' }));
    await waitFor(() => expect(document.getElementById('mv-look-guides')).toHaveFocus());
    expect(within(document.getElementById('mv-look-guides')).getByRole('button', { name: 'Use Cast sheet as visual guide' })).toBeInTheDocument();
  });

  it('lists open storyboard feedback on its own Feedback row, settled with buttons there, never under Lyrics', async () => {
    const note = { id: 'fb-a', stage: 'storyboard', target: 'Chorus', text: 'Put the lyrics on the wall, not the screen', decision: 'request-changes', basis: 'board' };
    const project = { ...PROJECT_ANALYZED, scenes: [{ sceneId: 's-a', order: 0, label: 'Chorus', startSec: 0, endSec: 4 }],
      productionReview: { draft: { storyboard: [] }, feedback: [note] },
      productionReadiness: { readyForProduction: false, basis: { storyboard: 'board' }, art: { approved: true, problems: [] },
        storyboard: { approved: false, problems: [`Resolve storyboard feedback for ${note.target}: ${note.text}`] }, proof: { approved: false, problems: [] } } };
    await openProject(project, 'board');
    const checklist = screen.getByRole('region', { name: 'What this step needs' });
    expect(within(checklist).queryByText('Lyrics')).toBeNull();
    expect(within(checklist).queryByRole('button', { name: /Import lyrics/ })).toBeNull();
    const requests = within(checklist).getByRole('list', { name: 'Open change requests' });
    expect(requests).toHaveTextContent('Chorus: Put the lyrics on the wall, not the screen');
    fireEvent.click(within(checklist).getByRole('button', { name: /Revise from feedback/ }));
    await waitFor(() => expect(feedbackCalls.revise).toHaveBeenCalledWith('storyboard'));
    fireEvent.click(within(requests).getByRole('button', { name: 'Mark resolved: Chorus' }));
    expect(feedbackCalls.resolveFeedback).toHaveBeenCalledWith('fb-a', '');
    // Lock all stills, on Shots, waits on the same request.
    await openStage('produce', false);
    expect(screen.getByRole('region', { name: 'Approve: Lyric-timed storyboard' })).toHaveTextContent('Resolve the change request on Chorus first.');
  });

  // Uniquely catches a lyric anchor problem the director cannot find or settle from the checklist.
  it('names each shot whose lyric anchors differ from the singing, opens it, and anchors them all in one tap', async () => {
    const project = { ...PROJECT_ANALYZED, scenes: [{ sceneId: 's-a', order: 0, label: 'Drummer', startSec: 0, endSec: 4 }, { sceneId: 's-b', order: 1, label: 'Singer', startSec: 4, endSec: 8 }],
      productionReview: { draft: { storyboard: [] } },
      productionReadiness: { readyForProduction: false, basis: {}, art: { approved: true, problems: [] },
        storyboard: { approved: false, problems: ['Review lyric anchors for Singer.'],
          lyricAnchors: [{ sceneId: 's-b', sung: ['If you think this is slop'], anchored: [] }] }, proof: { approved: false, problems: [] } } };
    await openProject(project, 'board');
    const checklist = screen.getByRole('region', { name: 'What this step needs' });
    expect(checklist).not.toHaveTextContent('need lyric anchors reviewed');
    const shots = within(checklist).getByRole('list', { name: 'Lyric anchors shots' });
    expect(shots).toHaveTextContent('Shot 2Sung: “If you think this is slop” · anchored: nothing');
    fireEvent.click(within(checklist).getByRole('button', { name: /Anchor to the sung lyrics/ }));
    expect(feedbackCalls.syncLyricAnchors).toHaveBeenCalledWith();
    fireEvent.click(within(shots).getByRole('button', { name: 'Shot 2' }));
    await waitFor(() => expect(document.getElementById('scene-s-b')).toBeTruthy());
  });

  // Uniquely catches a row left from a cut shot holding the board with no way to clear it from the checklist.
  it('lists the storyboard rows left from deleted shots by time and action, and removes them in one tap', async () => {
    const project = { ...PROJECT_ANALYZED, scenes: [{ sceneId: 's-a', order: 0, label: 'Drummer', startSec: 0, endSec: 4 }],
      productionReview: { draft: { storyboard: [] } },
      productionReadiness: { readyForProduction: false, basis: {}, art: { approved: true, problems: [] },
        storyboard: { approved: false, problems: ['Remove 2 storyboard rows left from deleted shots.'],
          staleRows: [{ id: null, sceneId: 'gone-1', startSec: 62.5, endSec: 64.25, action: 'A figure skids across the floor' },
            { id: null, sceneId: 'gone-2', startSec: 70, endSec: 71, action: '' }] }, proof: { approved: false, problems: [] } } };
    await openProject(project, 'board');
    const checklist = screen.getByRole('region', { name: 'What this step needs' });
    expect(checklist).toHaveTextContent('Rows from deleted shots');
    expect(checklist).toHaveTextContent('1:02.50–1:04.25 · A figure skids across the floor');
    expect(checklist).toHaveTextContent('1:10.00–1:11.00');
    expect(checklist).not.toHaveTextContent('Remove 2 storyboard rows');
    fireEvent.click(within(checklist).getByRole('button', { name: /Remove all 2/ }));
    expect(feedbackCalls.removeStaleRows).toHaveBeenCalledWith();
  });

  // Uniquely catches a coverage or details problem the director cannot trace to a shot.
  it('names the shots behind Shot coverage and Shot details, each opening its card', async () => {
    const project = { ...PROJECT_ANALYZED, scenes: [{ sceneId: 's-a', order: 0, label: 'Drummer', startSec: 0, endSec: 4 }, { sceneId: 's-b', order: 1, label: 'Singer', startSec: 4.5, endSec: 8 }],
      productionReview: { draft: { storyboard: [] } },
      productionReadiness: { readyForProduction: false, basis: {}, art: { approved: true, problems: [] },
        storyboard: { approved: false, problems: ['Storyboard shots must cover the master without unintended gaps or overlaps.', 'Complete timing, action, staging, camera and transition for Singer.'],
          coverage: [{ sceneId: 's-b', issue: 'gap', startSec: 4, endSec: 4.5 }],
          incompleteShots: [{ sceneId: 's-b', missing: ['staging'] }] }, proof: { approved: false, problems: [] } } };
    await openProject(project, 'board');
    const checklist = screen.getByRole('region', { name: 'What this step needs' });
    expect(within(checklist).getByRole('list', { name: 'Shot coverage shots' })).toHaveTextContent('Shot 2Gap of 0.50 s before this shot, 0:04.00–0:04.50');
    expect(checklist).not.toHaveTextContent('without unintended gaps');
    const details = within(checklist).getByRole('list', { name: 'Shot details shots' });
    expect(details).toHaveTextContent('Shot 2Missing staging');
    expect(checklist).not.toHaveTextContent('1 shot missing timing');
    fireEvent.click(within(details).getByRole('button', { name: 'Shot 2' }));
    await waitFor(() => expect(document.getElementById('scene-s-b')).toBeTruthy());
  });

  it('builds the cast & sets from the Look checklist when nothing is written yet', async () => {
    const project = { ...PROJECT_ANALYZED, scenes: [], castAndSets: undefined, devArtifacts: [],
      productionReadiness: { readyForProduction: false, basis: {}, art: { approved: false, problems: ['Cast guide needs editable direction.'] },
        storyboard: { approved: false, problems: [] }, proof: { approved: false, problems: [] } } };
    startMusicVideoCastAndSets.mockResolvedValue({ project, stage: null });
    await openProject(project, 'cast-sets');
    const checklist = screen.getByRole('region', { name: 'What this step needs' });
    expect(checklist).toHaveTextContent('Build the cast & sets to draft it from your creative direction, song style and mood board.');
    expect(checklist).toHaveTextContent('Comes with the cast & sets sheet, or use a file of your own.');
    expect(checklist).not.toHaveTextContent('needs editable direction');
    fireEvent.click(within(checklist).getByRole('button', { name: 'Build cast & sets' }));
    await waitFor(() => expect(startMusicVideoCastAndSets).toHaveBeenCalledWith(project.id, {}, { silent: true }));
    fireEvent.click(within(checklist).getByRole('button', { name: 'Write it yourself' }));
    await waitFor(() => expect(screen.getByLabelText('Cast guide')).toHaveFocus());
  });

  it('shows the project options in Project settings and saves a media mode and an autopilot tool change', async () => {
    const project = { ...PROJECT_ANALYZED, mediaMode: 'code-images-video',
      automation: { tools: ['image:local'], guidance: 'g', budgetUsd: 5, checkins: { castAndSets: 'review' } } };
    updateMusicVideoProject.mockImplementation((_id, patch) => Promise.resolve({ ...project, ...patch }));
    await openProject(project, 'setup');
    // The Song step holds only the song; the project options are one header button away.
    expect(screen.queryByLabelText('Design and composition media')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Project settings' }));
    const drawer = await screen.findByRole('dialog', { name: 'Project settings' });
    expect(within(drawer).getByRole('tab', { name: /^Project/ })).toHaveAttribute('aria-selected', 'true');
    expect(within(drawer).getByLabelText('Design and composition media')).toHaveValue('code-images-video');
    fireEvent.change(screen.getByLabelText('Design and composition media'), { target: { value: 'code-only' } });
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith(project.id, { mediaMode: 'code-only' }, { silent: true }));
    fireEvent.click(screen.getByLabelText('Local video gen'));
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith(project.id, expect.objectContaining({
      mode: 'autonomous', automation: expect.objectContaining({ tools: ['image:local', 'video:local'], guidance: 'g', budgetUsd: 5 }),
    }), { silent: true }));
  });
});

describe('Autopilot collapsed review summary', () => {
  it('shows the current blocker on the run while retaining the historical error in run details', async () => {
    const error = 'Review and approve the current art direction first.';
    const project = { ...PROJECT_ANALYZED, autonomousRun: { id: 'history-run', status: 'needs-human', stage: 'produce',
      error, errorCode: 'MUSIC_VIDEO_APPROVAL_REQUIRED', brief: { autoApprove: [] }, stages: {}, output: {} },
      productionReadiness: { basis: {}, art: { approved: true, problems: [] }, storyboard: { approved: false, problems: ['Approve the current lyric-timed storyboard.'] },
        proof: { approved: false, problems: [] } } };
    listMusicVideoProjects.mockResolvedValue([project]);
    render(<MemoryRouter initialEntries={['/music-video/mv-3/review']}>{MV_ROUTES}</MemoryRouter>);
    // Collapsed, the run is the header's Autopilot button: it never repeats the stale error.
    const autopilot = await screen.findByRole('button', { name: /^(Autopilot|Autonomous run)/ });
    expect(autopilot.textContent).not.toContain(error);
    fireEvent.click(autopilot);
    const drawer = await screen.findByRole('dialog', { name: 'Project settings' });
    const run = within(drawer).getByRole('region', { name: 'Autonomous run' });
    expect(within(run).getByText(`Historical stop reason: ${error}`)).toBeInTheDocument();
    const current = within(run).getByText(/Approve the current lyric-timed storyboard/);
    expect(current.textContent).not.toContain(error);
  });
});

describe('MusicVideo deep-linking and drawer URL routing (#10168)', () => {
  it('opens scene expanded when loaded via /music-video/:projectId/:stage/scene/:sceneId', async () => {
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP]);
    render(
      <MemoryRouter initialEntries={[`/music-video/${PROJECT_WITH_CLIP.id}/board/scene/s1`]}>
        {MV_ROUTES}
      </MemoryRouter>
    );
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    const details = document.getElementById('scene-s1');
    expect(details).toBeInTheDocument();
    expect(details.open).toBe(true);
  });

  it('routes /music-video/:projectId/scene/:sceneId directly to board stage with scene expanded', async () => {
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP]);
    render(
      <MemoryRouter initialEntries={[`/music-video/${PROJECT_WITH_CLIP.id}/scene/s1`]}>
        {MV_ROUTES}
      </MemoryRouter>
    );
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    const details = document.getElementById('scene-s1');
    expect(details).toBeInTheDocument();
    expect(details.open).toBe(true);
  });

  it('opens create project drawer via ?new=project and autonomous drawer via ?new=autonomous', async () => {
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP]);
    const { unmount } = render(
      <MemoryRouter initialEntries={['/music-video?new=project']}>
        {MV_ROUTES}
      </MemoryRouter>
    );
    expect(await screen.findByRole('heading', { level: 2, name: 'New music video' })).toBeInTheDocument();
    unmount();

    render(
      <MemoryRouter initialEntries={['/music-video?new=autonomous']}>
        {MV_ROUTES}
      </MemoryRouter>
    );
    expect(await screen.findByRole('heading', { level: 2, name: 'Autonomous music video' })).toBeInTheDocument();
  });

  it('updates the URL when a scene is expanded and removes it when collapsed', async () => {
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP]);
    render(
      <MemoryRouter initialEntries={[`/music-video/${PROJECT_WITH_CLIP.id}/produce`]}>
        <LocationProbe />
        {MV_ROUTES}
      </MemoryRouter>
    );
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    expect(screen.getByTestId('loc')).toHaveTextContent(`/music-video/${PROJECT_WITH_CLIP.id}/produce`);

    expect(document.getElementById('scene-s1')).toBeNull();
    const thumbnail = screen.getByRole('button', { name: /^Open (Shot 1|Scene 1)/ });
    await act(async () => fireEvent.click(thumbnail));
    const details = document.getElementById('scene-s1');
    expect(details).toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent(`/music-video/${PROJECT_WITH_CLIP.id}/produce/scene/s1`);

    details.querySelector('summary').focus();
    await act(async () => {
      details.open = false;
      fireEvent(details, new Event('toggle'));
    });
    expect(screen.getByTestId('loc')).toHaveTextContent(`/music-video/${PROJECT_WITH_CLIP.id}/produce`);
    expect(document.getElementById('scene-s1')).toBeNull();
    expect(thumbnail).toHaveFocus();
    await settle();
  });

  it('keeps scene routing and focus together when j/k switches the inspector', async () => {
    const first = { ...PROJECT_WITH_CLIP.scenes[0], sceneId: 's1', order: 0 };
    listMusicVideoProjects.mockResolvedValue([{ ...PROJECT_WITH_CLIP, scenes: [first, { ...first, sceneId: 's2', order: 1 }] }]);
    render(<MemoryRouter initialEntries={[`/music-video/${PROJECT_WITH_CLIP.id}/produce/scene/s1`]}><LocationProbe />{MV_ROUTES}</MemoryRouter>);
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    // The heading can land a commit before the inspector; wait for the scene the keys act on.
    await waitFor(() => expect(document.querySelector('#scene-s1 summary')).not.toBeNull());
    document.querySelector('#scene-s1 summary').focus();
    await act(async () => fireEvent.keyDown(document.activeElement, { key: 'j' }));
    expect(screen.getByTestId('loc')).toHaveTextContent(`/music-video/${PROJECT_WITH_CLIP.id}/produce/scene/s2`);
    expect(document.querySelector('#scene-s1')).toBeNull();
    expect(document.querySelector('#scene-s2 summary')).toHaveFocus();
    expect(document.querySelectorAll('video[src^="/data/videos/"]')).toHaveLength(1);
    await act(async () => fireEvent.keyDown(document.activeElement, { key: 'k' }));
    expect(screen.getByTestId('loc')).toHaveTextContent(`/music-video/${PROJECT_WITH_CLIP.id}/produce/scene/s1`);
    expect(document.querySelector('#scene-s2')).toBeNull();
    expect(document.querySelector('#scene-s1 summary')).toHaveFocus();
  });

  it('closes open drawer on back navigation', async () => {
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP]);
    let routerNavigate;
    function NavigateGrabber() {
      const navigate = useNavigate();
      routerNavigate = navigate;
      return null;
    }
    render(
      <MemoryRouter initialEntries={['/music-video', '/music-video?new=project']}>
        <NavigateGrabber />
        {MV_ROUTES}
      </MemoryRouter>
    );
    expect(await screen.findByRole('heading', { level: 2, name: 'New music video' })).toBeInTheDocument();
    act(() => routerNavigate(-1));
    await waitFor(() => expect(screen.queryByRole('heading', { level: 2, name: 'New music video' })).not.toBeInTheDocument());
  });

  it('renders ListLoadError with retry when universe names fail to load in create project drawer', async () => {
    const { listUniverseNames } = await import('../services/apiUniverseBuilder.js');
    listUniverseNames.mockReset();
    listUniverseNames.mockRejectedValueOnce(new Error('Universes offline'));
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP]);

    render(
      <MemoryRouter initialEntries={['/music-video?new=project']}>
        {MV_ROUTES}
      </MemoryRouter>
    );

    expect(await screen.findByRole('heading', { level: 2, name: 'New music video' })).toBeInTheDocument();
    expect(await screen.findByText(/Could not load universes/)).toBeInTheDocument();

    listUniverseNames.mockResolvedValueOnce([{ id: 'u1', name: 'Cyberverse' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(screen.queryByText(/Could not load universes/)).not.toBeInTheDocument();
    });
    expect(screen.getByRole('option', { name: 'Cyberverse' })).toBeInTheDocument();
  });
});
