/**
 * Shared mock scaffold for the Music Video page suites: the routing and shell
 * suite (`pages/MusicVideo.test.jsx`) and the per-step container suites under
 * `components/musicVideo/stages/use*StageWiring.test.jsx`, which all drive the
 * real page at its public boundary.
 *
 * **Importing this module registers the mocks.** `vi.mock` is hoisted to the top
 * of the file it is written in, so these registrations run when this module is
 * evaluated: import it before any mocked module (services, Toast) so the suite's
 * own bindings are the mocked ones. The relative specifiers resolve identically
 * from here and from `pages/`. Each suite calls `installMusicVideoPageHooks()`
 * once at top level for the shared per-test reset.
 */
import { expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate, useLocation } from 'react-router';
import MusicVideo from '../pages/MusicVideo.jsx';
import { listMusicVideoProjects, listMusicVideoProjectSummaries, getMusicVideoProject, getMusicVideoCatalogCompletion } from '../services/apiMusicVideo.js';
vi.mock('../hooks/useMediaUsages', () => ({ useMediaUsages: () => ({}), refreshMediaUsages: () => Promise.resolve() }));
vi.mock('../services/apiCatalog.js', async (importOriginal) => ({ ...await importOriginal(), listCatalogIngredientMedia: vi.fn(async () => []), listCatalogIngredientsMedia: vi.fn(async () => ({})) }));
vi.mock('../hooks/usePrevizJobs.js', () => ({ default: () => ({ running: [], finished: null, drafted: 0, setCount: 0, step: null }) }));
vi.mock('../services/apiRunwayCatalog.js', async (importOriginal) => ({ ...await importOriginal(), loadRunwayCatalog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/apiMediaJobs.js', async (importOriginal) => ({ ...await importOriginal(), listQueueMediaJobs: vi.fn(async () => []) }));

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
const sharedMedia = vi.hoisted(() => ({
  generateVideo: vi.fn(),
  renderMusicVideoSceneFrame: vi.fn(async () => ({ status: 'queued', jobId: 'example-frame-job' })),
}));
vi.mock('../hooks/useMusicVideoProductionReview.js', () => ({ default: ({ project }) => ({
  ...feedbackCalls,
  readiness: project?.productionReadiness || { readyForProduction: true, basis: {}, art: { approved: true, problems: [] }, storyboard: { approved: true, problems: [] }, proof: { approved: true, problems: [] } },
  busy: false, error: null, proof: { active: false }, save: vi.fn(), prepare: vi.fn(), approve: vi.fn(), renderProof: vi.fn(),
}) }));

vi.mock('../services/apiMusicVideo.js', () => ({
  // The dock asks before it plays a document; these projects stay in the isolated worker.
  getMusicVideoCompositionPlayback: vi.fn(async () => ({ native: false })),
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
  getMusicVideoCatalogCompletion: vi.fn(async () => []),
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
  proposeMusicVideoShotSheet: vi.fn(),
  deleteMusicVideoScene: vi.fn(),
  reorderMusicVideoScenes: vi.fn(),
  splitMusicVideoScene: vi.fn(),
  moveMusicVideoSceneStart: vi.fn(),
  importMusicVideoLyrics: vi.fn(),
  importMusicVideoTrackLyrics: vi.fn(),
  alignMusicVideoLyrics: vi.fn(),
  verifyMusicVideoLyrics: vi.fn(async () => ({ jobId: 'verify' })),
  musicVideoLyricVerifyEventsUrl: (jobId) => `/api/music-video/lyrics/verify/${jobId}/events`,
  cancelMusicVideoLyricVerify: vi.fn(async () => ({ ok: true })),
  musicVideoLyricAlignEventsUrl: (jobId) => `/api/music-video/lyrics/align/${jobId}/events`,
  cancelMusicVideoLyricAlign: vi.fn(async () => ({ ok: true })),
  getMusicVideoActiveJobs: vi.fn(async () => ({ alignment: null, separation: null, midi: null })),
  separateMusicVideoVocals: vi.fn(async () => ({ jobId: 'sep-job-1' })),
  musicVideoVocalSeparationEventsUrl: (jobId) => `/api/music-video/vocal-stem/separate/${jobId}/events`,
  cancelMusicVideoVocalSeparation: vi.fn(async () => ({ ok: true })),
  getMusicVideoActiveRender: vi.fn(async () => ({ jobId: null })),
  // Composed views read these after a debounce; slower runs must still have a valid transport.
  getMusicVideoFilmLooks: vi.fn(async () => ({ available: false, total: 0, looks: [] })),
  getMusicVideoShotRenders: vi.fn(async () => ({ available: false, shots: [], outro: null, ready: 0, total: 0 })),
  getMusicVideoSharingCopy: vi.fn(async () => ({ copy: null, jobId: null })),
  prepareMusicVideoSharingCopy: vi.fn(async () => ({ jobId: 'sharing-example' })),
  musicVideoSharingCopyDownloadUrl: id => `/api/music-video/${id}/sharing-copy/download`,
  getMusicVideoSceneJobs: vi.fn(async () => ({ jobs: [] })),
  renderMusicVideoSceneFrame: sharedMedia.renderMusicVideoSceneFrame,
  renderMusicVideoSceneClip: (_id, _sceneId, body) => sharedMedia.generateVideo(body),
  renderMusicVideoProject: vi.fn(async () => ({ jobId: 'job-1' })),
  musicVideoRenderEventsUrl: (jobId) => `/api/music-video/render/${jobId}/events`,
  cancelMusicVideoRender: vi.fn(async () => ({ ok: true })),
  transcribeMusicVideoMidi: vi.fn(async () => ({ jobId: 'midi-job-1', model: 'medium' })),
  getMusicVideoMidiPlanning: vi.fn(async () => ({ facts: null })),
  musicVideoMidiEventsUrl: (jobId) => `/api/music-video/transcribe-midi/${jobId}/events`,
  cancelMusicVideoMidiTranscription: vi.fn(async () => ({ ok: true })),
  addMusicVideoSceneTake: vi.fn(),
  selectMusicVideoSceneTake: vi.fn(),
  rejectUnusedMusicVideoSceneTakes: vi.fn(),
  measureMusicVideoColorMatch: vi.fn(),
  approveMusicVideoFinal: vi.fn(),
  upgradeMusicVideoShots: vi.fn(async () => ({ dryRun: true, method: 'upscale', shots: [], totalCostUsd: 0 })),
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
  syncMusicVideoTreatmentFromShotSheet: vi.fn(),
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
  getMusicVideoCastAndSets: vi.fn(async () => ({ catalogCheckin: { items: [], problems: [] } })),
  repairMusicVideoShotReference: vi.fn(),
  linkMusicVideoCastAndSetsToCatalog: vi.fn(),
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
  // Blender film: read only for a project in that render style; a test that opens one supplies the state.
  getMusicVideoBlender: vi.fn(() => new Promise(() => {})),
  saveMusicVideoBlenderSettings: vi.fn(),
  saveMusicVideoBlenderMotionReferences: vi.fn(),
  makeMusicVideoBlenderMotionStrip: vi.fn(),
  createMusicVideoBlenderWorkspace: vi.fn(),
  listMusicVideoBlenderFiles: vi.fn(async () => ({ files: [] })),
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
  getMusicVideoBlenderUsage: vi.fn(() => new Promise(() => {})),
  clearMusicVideoBlenderFrames: vi.fn(),
  musicVideoBlenderMediaUrl: (id, path) => `/api/music-video/${id}/blender/media?path=${encodeURIComponent(path)}`,
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
  listMoodBoards: vi.fn(async () => []),
  createMoodBoard: vi.fn(),
  addMoodBoardItem: vi.fn(),
  removeMoodBoardItem: vi.fn(),
}));
const providerModelsState = vi.hoisted(() => ({ selectedProviderId: '' }));
vi.mock('../hooks/useProviderModels', () => ({
  default: () => ({
    providers: [], selectedProviderId: providerModelsState.selectedProviderId, selectedModel: '', availableModels: [],
    setSelectedProviderId: vi.fn(), setSelectedModel: vi.fn(), loading: false,
  }),
}));
// MIDI loading/parsing is covered by useMidiNotes; this page checks the link.
vi.mock('../hooks/useMidiNotes.js', () => ({
  default: () => ({ status: 'idle', data: null, error: null, reload: vi.fn() }),
}));
vi.mock('../services/apiImageVideo.js', () => ({
  listMediaCollections: vi.fn(async () => []),
  createMediaCollection: vi.fn(),
  listImageModels: vi.fn(async () => []),
  generateVideo: sharedMedia.generateVideo,
  listOvernightRenders: vi.fn(async () => ({ batches: [] })),
  queueOvernightRenders: vi.fn(),
  cancelOvernightRenders: vi.fn(),
  previewVideoPrompt: vi.fn(async () => ({ backend: 'local', shotPreviewUnavailable: true })),
  previewImagePrompt: vi.fn(async (body) => ({ sentPrompt: body.prompt, promptAdditions: [] })),
  uploadGalleryVideo: vi.fn(),
  trimVideo: vi.fn(),
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
  getVideoGenModelContext: vi.fn(async () => ({
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
const renderMV = (path = '/music-video') => render(
  <MemoryRouter initialEntries={[path]}>{MV_ROUTES}</MemoryRouter>,
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
  setup: /^Song/, story: /^Story(?!board)/, 'cast-sets': /^Look/, board: /^Storyboard/, previz: /^Previz/, produce: /^Shots/, compose: /^Shots/, review: /^Final render/, publish: /^Publish/,
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
    // Shots is a lazy chunk; the first visit in a suite renders its fallback first.
    const thumbnails = await screen.findByLabelText('Storyboard thumbnails');
    const first = within(thumbnails).queryAllByRole('button')[0];
    if (first) await act(async () => { fireEvent.click(first); });
  }
};

// `phase` optionally labels each step for failure evidence (testPhaseDiagnostics).
const untracked = (_name, operation) => operation();
const openProject = async (project, stage = null, phase = untracked) => {
  listMusicVideoProjects.mockResolvedValue([project]);
  renderMV();
  await phase('select-project', () => selectProject(project.id));
  await phase('project-heading', () => screen.findByRole('heading', { level: 2, name: project.name }));
  if (stage) await phase('open-stage', () => openStage(stage));
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

// The shot editor shows the frames or the clip, one at a time.
const showFrames = async () => fireEvent.click(within(await screen.findByRole('group', { name: 'Show' })).getByRole('button', { name: /^(Still|Frames)$/ }));

/** The suite-wide per-test reset every Music Video page suite shares. */
export function installMusicVideoPageHooks() {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(async () => {
    const socket = (await import('../services/socket.js')).default;
    delete socket.id;
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
    getMusicVideoCatalogCompletion.mockReset();
    sseState.latest = null;
    sseState.closed = false;
    sseState.isOpen = true;
    ytSseStates.clear();
  });
}

// A board edit reply's edit result (server/services/musicVideo/editResult.js) for the shots a test changed:
// `scenes` are the board after the edit, `changed` the ids whose presentation changed.
const editResult = (scenes, changed = scenes.map((scene) => scene.sceneId), { updatedAt = null, project = {} } = {}) => ({
  updatedAt, sceneIds: scenes.map((scene) => scene.sceneId), scenes: scenes.filter((scene) => changed.includes(scene.sceneId)), project, removed: [],
});
// An updateMusicVideoProject (`edit: true`) implementation answering like the PATCH route: the edit result
// carries the patched fields beside the shots `project` already has.
const savedProjectEdits = (project) => async (_id, patch) => ({ edit: editResult(project.scenes || [], [], { project: patch }) });
// An updateMusicVideoScene implementation that saves each patch onto a running copy of `project`'s shots
// (object fields merge one level, as the server merges the shot sheet) and answers like the route.
const savedSceneReplies = (project) => {
  let scenes = project.scenes || [];
  return async (_id, sceneId, patch) => {
    scenes = scenes.map((scene) => (scene.sceneId !== sceneId ? scene : Object.fromEntries([...Object.entries(scene), ...Object.entries(patch).map(([key, value]) => [key,
      value && typeof value === 'object' && !Array.isArray(value) && scene[key] && typeof scene[key] === 'object' ? { ...scene[key], ...value } : value])])));
    return { ...scenes.find((scene) => scene.sceneId === sceneId), edit: editResult(scenes, [sceneId], { updatedAt: project.updatedAt ?? null }) };
  };
};

export {
  editResult,
  savedProjectEdits,
  savedSceneReplies,
  PROJECT_WITH_CLIP,
  PROJECT_NO_CLIP,
  sseState,
  ytSseStates,
  getYtSseState,
  feedbackCalls,
  sharedMedia,
  socketHandlers,
  pushSocket,
  providerModelsState,
  PROJECT_ANALYZED,
  MV_ROUTES,
  renderMV,
  settle,
  selectProject,
  STAGE_TABS,
  openSettings,
  closeSettings,
  openStage,
  untracked,
  openProject,
  clickNewProject,
  openCreateForm,
  forceRerender,
  LocationProbe,
  NavTo,
  renderMVWithNav,
  showFrames,
};
