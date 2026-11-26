/**
 * Revision cases from the Music Video page suite for `useProduceStageWiring`.
 * Drives the real page through the shared scaffold in `test/musicVideoPageMocks.jsx`.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
// The scaffold registers the mocks, so it loads before any mocked module.
import {
  PROJECT_WITH_CLIP,
  PROJECT_NO_CLIP,
  pushSocket,
  providerModelsState,
  MV_ROUTES,
  renderMV,
  settle,
  openSettings,
  closeSettings,
  openStage,
  openProject,
  showFrames,
  installMusicVideoPageHooks,
  editResult,
  savedSceneReplies,
} from '../../../test/musicVideoPageMocks.jsx';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import { findEnabledByRole } from '../../../test/enabledBarrier.js';
import { MemoryRouter } from 'react-router';
import toast from '../../ui/Toast';
import { addMusicVideoScene, listMusicVideoProjects, reorderMusicVideoScenes, updateMusicVideoProject, updateMusicVideoScene, proposeMusicVideoShotSheet, moveMusicVideoSceneStart, selectMusicVideoSceneTake, reviewMusicVideoSceneTake, importMusicVideoHandoff, addMusicVideoSceneTake, getMusicVideoHandoffBundle, getMusicVideoProject, startMusicVideoRevision, resumeMusicVideoRevision, cancelMusicVideoRevision, renderMusicVideoSceneFrame, musicVideoFilmApi, } from '../../../services/apiMusicVideo.js';
import { generateImage, uploadGalleryImage } from '../../../services/apiSystem.js';
import { generateVideo, trimVideo } from '../../../services/apiImageVideo.js';
import { downloadBlob } from '../../../lib/downloadBlob.js';
import { blenderFilmProject, blenderFilmState } from '../../../test/blenderFilmFixture.js';
import { warmSceneCard } from '../sceneCardTestWarmup.jsx';
beforeAll(warmSceneCard, 30000);

installMusicVideoPageHooks();

// Stage interaction tests can enter through the real route. This avoids mounting
// the default step and scanning its DOM for the picker and stage tabs on every run.
const renderProjectStage = async (project, stage, sceneId) => {
  listMusicVideoProjects.mockResolvedValue([project]);
  const path = `/music-video/${project.id}/${stage}${sceneId ? `/scene/${sceneId}` : ''}`;
  await act(async () => { renderMV(path); });
};

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
    await renderProjectStage(REVIEWED, 'review');

    fireEvent.click(await findEnabledByRole('button', { name: /Revise flagged/i }));
    await waitFor(() => expect(resumeMusicVideoRevision).toHaveBeenCalledWith('mv-1', 'mvr-1', { silent: true }));
    expect(startMusicVideoRevision).toHaveBeenCalledWith('mv-1', 'mve-1', {}, { silent: true });
    await waitFor(() => expect(generateVideo).toHaveBeenCalledTimes(1));
    expect(JSON.parse(generateVideo.mock.calls[0][0].musicVideo)).toEqual({ projectId: 'mv-1', sceneId: 's2', revisionId: 'mvr-1', compose: true, expectedShot: 'cutaway' });
    const panel = screen.getByLabelText('Section revision');
    expect(within(panel).getByText('Kept')).toBeInTheDocument();
  });

  it('resuming once every revised section has a take re-renders the draft without any paid generation', async () => {
    const ready = withRevision('h2-new');
    resumeMusicVideoRevision.mockResolvedValue({
      project: { ...ready, revisions: [{ ...ready.revisions[0], status: 'rendering', renderExcerptId: 'mve-2' }] },
      revision: { ...ready.revisions[0], status: 'rendering' }, needsGeneration: [], generating: [], render: { jobId: 'mve-2', excerptId: 'mve-2' },
    });
    await renderProjectStage(ready, 'review');

    fireEvent.click(await findEnabledByRole('button', { name: /Render revised draft/i }));
    await waitFor(() => expect(resumeMusicVideoRevision).toHaveBeenCalledWith('mv-1', 'mvr-1', { silent: true }));
    await screen.findByText(/Rendering draft/);
    expect(generateVideo).not.toHaveBeenCalled();
    expect(generateImage).not.toHaveBeenCalled();
  });

  it('cancels an open revision', async () => {
    const open = withRevision(null);
    cancelMusicVideoRevision.mockResolvedValue({ project: { ...open, revisions: [{ ...open.revisions[0], status: 'canceled' }] }, revision: { ...open.revisions[0], status: 'canceled' } });
    await renderProjectStage(open, 'review');
    fireEvent.click(await findEnabledByRole('button', { name: /Cancel revision/i }));
    await waitFor(() => expect(cancelMusicVideoRevision).toHaveBeenCalledWith('mv-1', 'mvr-1', { silent: true }));
    await screen.findByText(/Revision — Cancelled/);
    expect(generateVideo).not.toHaveBeenCalled();
  });
});

describe('MusicVideo shot sheet AI help', () => {
  afterEach(() => { providerModelsState.selectedProviderId = ''; });

  // Catches the page's scene edit rebuilding from a captured project, so each applied shot undoes the one before it.
  it('shows every applied shot after Apply saves several in one pass', async () => {
    providerModelsState.selectedProviderId = 'p1';
    const scenes = ['s1', 's2'].map((sceneId, order) => ({ sceneId, order, label: `Shot ${order + 1}`, prompt: 'Old motion', framePrompt: 'Old frame', shotSheet: { checked: true } }));
    proposeMusicVideoShotSheet.mockResolvedValue({ shots: [{ sceneId: 's1', prompt: 'New A' }, { sceneId: 's2', prompt: 'New B' }] });
    updateMusicVideoScene.mockResolvedValue({});
    await openProject({ ...PROJECT_WITH_CLIP, scenes }, 'produce');
    fireEvent.click(screen.getByText('Shot sheet'));
    fireEvent.click(screen.getByLabelText('Show prompts'));
    fireEvent.click(screen.getByRole('button', { name: 'AI help' }));
    fireEvent.click(screen.getByRole('button', { name: /Propose prompts from sheet \(2 checked\)/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply 2 selected' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Apply 2 selected' })).toBeNull());
    expect(updateMusicVideoScene).toHaveBeenCalledTimes(2);
    const motion = (name) => within(screen.getAllByRole('button', { name }).map((button) => button.closest('tr')).find(Boolean)).getByText('Motion:').parentElement.textContent;
    expect(motion('Open Shot 1')).toContain('New A');
    expect(motion('Open Shot 2')).toContain('New B');
  });
});

describe('MusicVideo section layers (#8985)', () => {
  const scenes = [
    { sceneId: 's1', order: 0, prompt: 'a', referenceImageId: 'img1', videoHistoryId: 'h1', startSec: 0, endSec: 4 },
    { sceneId: 's2', order: 1, prompt: 'b', referenceImageId: null, videoHistoryId: null, startSec: 4, endSec: 6 },
  ];
  const composition = (mode) => ({ version: 1, mode, textCues: [], style: { color: '#ffffff', font: 'sans' }, posterSec: null });

  it('makes a footage-less scene a title card so a composed project can render', async () => {
    updateMusicVideoScene.mockImplementation(savedSceneReplies({ ...PROJECT_WITH_CLIP, scenes }));
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

  it('shows no-live-preview note for concat, and hides it for composed', async () => {
    await openProject({ ...PROJECT_WITH_CLIP, composition: composition('concat') }, 'produce');
    expect(screen.getByText(/No live preview for this style — render a draft excerpt to check changes\./)).toBeInTheDocument();
  });

  it('hides no-live-preview note for composed', async () => {
    await openProject({ ...PROJECT_WITH_CLIP, composition: composition('composed') }, 'produce');
    expect(screen.queryByText(/No live preview for this style — render a draft excerpt to check changes\./)).not.toBeInTheDocument();
  });
});

// Shared MediaLightbox for scene frames, scene clips, and the final render (#3718).
// View-only — no remix/clean action handlers. Keys are deep-linkable via ?preview=.
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

  it('keeps the newer shot picks when a reference repair reply arrives after a project update', async () => {
    const { getMusicVideoCastAndSets, repairMusicVideoShotReference } = await import('../../../services/apiMusicVideo.js');
    const project = { ...SPEC_PROJECT, castAndSets: { source: 'catalog', status: 'approved' }, updatedAt: '2026-01-01T00:00:00Z',
      scenes: [{ ...SPEC_PROJECT.scenes[0], frameReferenceIds: ['r1'] }] };
    getMusicVideoCastAndSets.mockResolvedValueOnce({ catalogCheckin: { items: [], problems: [], shotReferenceProblems: [
      { id: 'problem-1', sceneId: 's1', shot: 1, message: 'Shot 1 needs a set reference.', fix: 'Fix shot reference' },
    ] } });
    let respond;
    repairMusicVideoShotReference.mockImplementationOnce(() => new Promise(resolve => { respond = resolve; }));
    listMusicVideoProjects.mockResolvedValue([project]);
    renderMV(`/music-video/${project.id}/produce?scenes=bad-take`);
    const open = await screen.findByRole('button', { name: 'Open shot 1' });
    expect(screen.getByText('No scenes match this filter.')).toBeTruthy();
    fireEvent.click(open);
    await showFrames();
    const refs = () => within(screen.getByRole('group', { name: 'References selected for the frames' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Fix shot reference' }));
    getMusicVideoProject.mockResolvedValueOnce({ ...project, updatedAt: '2026-01-03T00:00:00Z',
      scenes: [{ ...project.scenes[0], frameReferenceIds: ['r2'] }] });
    await pushSocket('music-video:project:changed', { id: project.id });
    await waitFor(() => expect(refs().getByRole('button', { name: "Don't send Pier" })).toBeTruthy());
    await act(async () => respond({ sceneId: 's1', patch: { frameReferenceIds: ['r1', 'r2'] }, updatedAt: '2026-01-02T00:00:00Z' }));
    expect(refs().queryByRole('button', { name: "Don't send Lead" })).toBeNull();
    expect(refs().getByRole('button', { name: "Don't send Pier" })).toBeTruthy();
  });

  it('asks the server for the shot frame and names the capability gap when that render is refused', async () => {
    renderMusicVideoSceneFrame.mockRejectedValueOnce(Object.assign(
      new Error('Reference images are only supported for FLUX.2 and Qwen Image 2.1 models on the local backend'),
      { code: 'REFERENCE_IMAGES_FLUX2_ONLY', status: 400 },
    ));
    await renderProjectStage(SPEC_PROJECT, 'produce', 's1');
    fireEvent.click(screen.getByRole('button', { name: /^Generate frame$/ }));
    await waitFor(() => expect(renderMusicVideoSceneFrame).toHaveBeenCalledWith(
      'mv-spec', 's1', { slot: 'start' }, { silent: true },
    ));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      expect.stringMatching(/Reference images are only supported.*Switch the image backend/),
    ));
  });

  it('asks the server for a frame on a shot whose section plate is approved', async () => {
    await renderProjectStage({ ...SPEC_PROJECT,
      scenes: [{ ...SPEC_PROJECT.scenes[0], sectionIndex: 1 }],
      castAndSets: { status: 'approved', direction: { songMap: [{ section: 0, setId: 'harbor' }, { section: 1, setId: 'roof' }] } },
      visualSpec: { ...SPEC_PROJECT.visualSpec, references: [
        { id: 'authored', imageId: 'authored.png', condition: true },
        { id: 'mvr-cs-character', imageId: 'character.png', condition: true },
        { id: 'mvr-cs-set-harbor', imageId: 'harbor.png', condition: true },
        { id: 'mvr-cs-set-roof', imageId: 'roof.png', condition: false },
      ] },
    }, 'produce', 's1');
    fireEvent.click(screen.getByRole('button', { name: /^Generate frame$/ }));
    await waitFor(() => expect(renderMusicVideoSceneFrame).toHaveBeenCalledWith(
      'mv-spec', 's1', { slot: 'start' }, { silent: true },
    ));
  });

  // Uniquely catches a frame picked as the render's image reference not reaching the request.
  it('renders a new frame take from the shot\'s own start frame when it is picked as the reference', async () => {
    await renderProjectStage({ ...SPEC_PROJECT, scenes: [{ ...SPEC_PROJECT.scenes[0], referenceImageId: 'start.png' }] }, 'produce', 's1');
    fireEvent.change(screen.getByLabelText('From', { selector: '#mv-scene-s1-start-from' }), { target: { value: 'start' } });
    await showFrames();
    fireEvent.click(screen.getByRole('button', { name: /^New frame take$/ }));
    await waitFor(() => expect(renderMusicVideoSceneFrame).toHaveBeenCalledWith(
      'mv-spec', 's1', { slot: 'start', fromFrame: true, referenceImageId: 'start.png' }, { silent: true },
    ));
  });

  it('submits a model override for one new frame take without saving it as the shot default', async () => {
    await renderProjectStage({ ...SPEC_PROJECT, imageMode: 'grok', scenes: [{ ...SPEC_PROJECT.scenes[0], referenceImageId: 'start.png' }] }, 'produce', 's1');
    await showFrames();
    fireEvent.click(screen.getByRole('button', { name: /Image model for this (start )?frame take/ }));
    const override = within(screen.getByRole('group', { name: 'One-take image model' }));
    expect(override.getByLabelText('Render on').textContent).toContain('Current frame setting · Grok');
    fireEvent.change(override.getByLabelText('Render on'), { target: { value: 'codex' } });
    fireEvent.change(override.getByLabelText('Model'), { target: { value: 'gpt-image-test' } });
    fireEvent.click(screen.getByRole('button', { name: /^New frame take$/ }));
    await waitFor(() => expect(renderMusicVideoSceneFrame).toHaveBeenLastCalledWith(
      'mv-spec', 's1', { slot: 'start', imageTarget: { mode: 'codex', cloudModel: 'gpt-image-test' } }, { silent: true },
    ));
    expect(screen.queryByRole('group', { name: 'One-take image model' })).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: /^New frame take$/ }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /^New frame take$/ }));
    await waitFor(() => expect(renderMusicVideoSceneFrame).toHaveBeenLastCalledWith(
      'mv-spec', 's1', { slot: 'start' }, { silent: true },
    ));
    expect(updateMusicVideoScene).not.toHaveBeenCalled();
  });

  // Uniquely catches Refine sending the shot prompt instead of the instruction, the frame not leading, or the shot's picked references not riding along.
  it('refines the start frame by a short instruction, sending the references picked on the shot after that frame', async () => {
    await renderProjectStage({ ...SPEC_PROJECT, scenes: [{ ...SPEC_PROJECT.scenes[0], referenceImageId: 'start.png' }] }, 'produce', 's1');
    // The automatic set shows as chips; swap the flagged Lead for the Pier set.
    await showFrames();
    const refs = within(screen.getByRole('group', { name: 'References selected for the frames' }));
    expect(refs.getByText('Auto: from the prompt')).toBeTruthy();
    fireEvent.click(refs.getByRole('button', { name: "Don't send Lead" }));
    expect(updateMusicVideoScene).toHaveBeenLastCalledWith('mv-spec', 's1', { frameReferenceIds: [] }, expect.anything());
    fireEvent.click(refs.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('button', { name: /Pier/ }));
    expect(updateMusicVideoScene).toHaveBeenLastCalledWith('mv-spec', 's1', { frameReferenceIds: ['r2'] }, expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'Refine' }));
    fireEvent.change(screen.getByLabelText('What to change in the start frame'), { target: { value: 'remove the hand' } });
    fireEvent.click(screen.getByRole('button', { name: 'Render refined start frame' }));
    await waitFor(() => expect(renderMusicVideoSceneFrame).toHaveBeenCalledWith(
      'mv-spec', 's1', { slot: 'start', refine: 'remove the hand', referenceImageId: 'start.png' }, { silent: true },
    ));
    expect(screen.queryByLabelText('What to change in the start frame')).toBeNull();
  });

  // The board sends the refine instruction and the frame; the server applies the shot's picks.
  it('refines a shot with four references by sending the instruction and the start frame', async () => {
    const references = ['a', 'b', 'c', 'd'].map((key) => ({ id: `r-${key}`, imageId: `${key}.png`, role: 'character', label: key, note: '', condition: true }));
    await renderProjectStage({ ...SPEC_PROJECT, visualSpec: { ...SPEC_PROJECT.visualSpec, references },
      scenes: [{ ...SPEC_PROJECT.scenes[0], referenceImageId: 'start.png' }] }, 'produce', 's1');
    await showFrames();
    fireEvent.click(screen.getByRole('button', { name: 'How references are sent' }));
    expect(screen.getByRole('tooltip').textContent).toContain('A refine or end frame counts its frame first');
    fireEvent.click(screen.getByRole('button', { name: 'How references are sent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refine' }));
    fireEvent.change(screen.getByLabelText('What to change in the start frame'), { target: { value: 'remove the hand' } });
    fireEvent.click(screen.getByRole('button', { name: 'Render refined start frame' }));
    await waitFor(() => expect(renderMusicVideoSceneFrame).toHaveBeenCalledWith(
      'mv-spec', 's1', { slot: 'start', refine: 'remove the hand', referenceImageId: 'start.png' }, { silent: true },
    ));
  });

  // Uniquely catches a trimmed clip landing only in Video Gen history, never as this shot's take, or not becoming the shot's clip.
  it('trims the shot clip to a later start frame and makes it the shot\'s selected clip take', async () => {
    const scene = { sceneId: 's1', order: 0, prompt: 'waves', referenceImageId: 'img1', videoHistoryId: 'h1',
      takes: [{ takeId: 't-v', kind: 'video', assetId: 'h1', source: 'generated', provider: 'portos', sourceImageId: 'img1', status: 'selected', note: null }] };
    const trimmedTake = { takeId: 't-trim', kind: 'video', assetId: 'h1-trim', source: 'trimmed', provider: null, status: 'candidate', note: null };
    trimVideo.mockResolvedValueOnce({ video: { id: 'h1-trim' } });
    addMusicVideoSceneTake.mockResolvedValueOnce({ scene: { ...scene, takes: [...scene.takes, trimmedTake] }, take: trimmedTake });
    selectMusicVideoSceneTake.mockResolvedValueOnce({ ...scene, videoHistoryId: 'h1-trim', takes: [{ ...scene.takes[0], status: 'candidate' }, { ...trimmedTake, status: 'selected' }] });
    await renderProjectStage({ ...PROJECT_WITH_CLIP, id: 'mv-trim', scenes: [scene] }, 'produce', 's1');
    const render = within(await screen.findByRole('region', { name: 'Render' }));
    for (let i = 0; i < 12; i += 1) fireEvent.click(render.getByRole('button', { name: 'Next frame' }));
    fireEvent.click(render.getByRole('button', { name: /Start clip here/ }));
    await waitFor(() => expect(selectMusicVideoSceneTake).toHaveBeenCalledWith('mv-trim', 's1', 't-trim', { silent: true }));
    expect(trimVideo).toHaveBeenCalledWith('h1', { startSec: 0.5 }, { silent: true });
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
    await renderProjectStage({ ...PROJECT_NO_CLIP, id: 'mv-takes', name: 'Takes Project', scenes: [scene] }, 'produce', 's1');

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

describe('MusicVideo Blender film render style', () => {
  const film = blenderFilmProject({
    scenes: [
      { sceneId: 'scene-s010', order: 0, prompt: 'The stage wakes up.', startSec: 0, endSec: 4.5, visualLayer: 'code' },
      { sceneId: 'scene-s020', order: 1, prompt: 'First verse', startSec: 4.5, endSec: 9, visualLayer: 'code' },
    ],
  });
  const openFilm = async (path, { project = film, state = blenderFilmState() } = {}) => {
    listMusicVideoProjects.mockResolvedValue([project]);
    musicVideoFilmApi.getMusicVideoBlender.mockResolvedValueOnce(state);
    render(<MemoryRouter initialEntries={[path]}>{MV_ROUTES}</MemoryRouter>);
    await screen.findByRole('heading', { level: 2, name: project.name });
    await settle();
  };

  it('shows the final video as out of date as soon as the film says a shot was rendered again, before the record is re-read', async () => {
    // The record was read while the final still matched its shots; the film state is newer.
    const rendered = { ...film, renderHistoryId: 'rh-1', status: 'complete', renderDependencyState: { status: 'current', reasons: [] } };
    await openFilm('/music-video/mv-test/review', { project: rendered, state: blenderFilmState({ finalStale: true }) });
    expect((await screen.findAllByText(/Final render is out of date/i)).length).toBeGreaterThan(0);
  });

  it('leads Shots with the live film, then the film panel, counts its finals in the step, and opens a still in the shared lightbox', async () => {
    await openFilm('/music-video/mv-test/produce');
    const panel = await screen.findByRole('region', { name: 'Blender film' });
    expect(await within(panel).findByRole('list', { name: 'Shots' })).toBeTruthy();
    // One read for the open project; everything after it is pushed, and the live film shares it.
    expect(musicVideoFilmApi.getMusicVideoBlender).toHaveBeenCalledTimes(1);
    expect(musicVideoFilmApi.getMusicVideoBlender).toHaveBeenCalledWith('mv-test', { silent: true });
    // The step reads the same state: one of three shots has a current final render.
    expect(screen.getByText('Final render for every Blender shot (1 of 3)')).toBeTruthy();
    // The player leads the step as it does for footage: the film's shots, straight from their renders, with no cut assembled.
    const dock = screen.getByRole('complementary', { name: 'Preview' });
    expect(within(dock).getByLabelText('Preview source')).toHaveValue('composite');
    expect(within(dock).getByRole('option', { name: 'Film (live)' })).toBeEnabled();
    const playing = within(dock).getByLabelText('Film preview').querySelector('video:not([aria-hidden="true"])');
    expect(playing.getAttribute('src')).toBe('/api/music-video/mv-test/blender/media?path=s010%2Ffinal%2Fshot.mp4');
    // The player docks beside the step (first, above it, on a narrow screen), and the film panel
    // (its own shot player and cuts) comes before the scene board in the step.
    expect(dock.closest('#mv-stage-produce')).toBeNull();
    expect(document.getElementById('mv-stage-produce').contains(panel)).toBe(true);
    expect(dock.closest('.max-xl\\:order-first')).toBeTruthy();
    const board = screen.getByLabelText('Storyboard thumbnails');
    expect(panel.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(within(panel).getByRole('button', { name: 'Still at 0:02.25' }));
    const lightbox = await screen.findByRole('dialog', { name: 'Cold open · still at 0:02.25' });
    expect(lightbox.querySelector('img').getAttribute('src')).toBe('/api/music-video/mv-test/blender/media?path=s010%2Fstills%2Ft000002250.png');
    // A workspace file is not a gallery record, so it cannot be filed into a collection.
    expect(within(lightbox).queryByRole('button', { name: 'Add to collection' })).toBeNull();
  });

  // Uniquely catches the song sounding twice on Shots (the film panel's shot player loops its shot
  // with the song, and the docked film plays the same song), or a render landing for the selected
  // shot stopping the film the director is watching.
  it('plays one player at a time on Shots: the docked film and the film panel\'s shot player take turns', async () => {
    await openFilm('/music-video/mv-test/produce');
    const panel = await screen.findByRole('region', { name: 'Blender film' });
    const dock = screen.getByRole('complementary', { name: 'Preview' });
    const song = within(dock).getByLabelText('Song for the film preview');
    const shotPlayer = () => within(panel).getByLabelText('Final render of Cold open');
    const looping = shotPlayer();
    song.pause = vi.fn();
    looping.pause = vi.fn();
    // The shot player starts by itself when the step opens; nothing else is playing.
    expect(looping.hasAttribute('autoplay')).toBe(true);
    fireEvent.play(looping);
    expect(song.pause).not.toHaveBeenCalled();
    // A shot's clip under the song is silent and has no say; the song itself takes the turn.
    fireEvent.play(within(dock).getByLabelText('Film preview').querySelector('video:not([aria-hidden="true"])'));
    expect(looping.pause).not.toHaveBeenCalled();
    fireEvent.play(song);
    expect(looping.pause).toHaveBeenCalledTimes(1);
    fireEvent.pause(looping);

    // The selected shot is rendered again while the film plays: its new player waits its turn.
    const rerendered = (finishedAt) => {
      const state = blenderFilmState();
      return { ...state, renders: { ...state.renders, s010: { ...state.renders.s010, final: { ...state.renders.s010.final, finishedAt } } } };
    };
    musicVideoFilmApi.getMusicVideoBlender.mockResolvedValueOnce(rerendered('2026-10-02T09:00:00.000Z'));
    await pushSocket('music-video:blender', { projectId: 'mv-test', kind: 'state' });
    await waitFor(() => expect(shotPlayer()).not.toBe(looping));
    expect(shotPlayer().hasAttribute('autoplay')).toBe(false);
    // Playing the shot is the director's call: the film gives way.
    fireEvent.play(shotPlayer());
    expect(song.pause).toHaveBeenCalledTimes(1);

    // With the film stopped, the next render to land plays by itself again.
    fireEvent.pause(shotPlayer());
    fireEvent.play(song);
    fireEvent.pause(song);
    const waiting = shotPlayer();
    musicVideoFilmApi.getMusicVideoBlender.mockResolvedValueOnce(rerendered('2026-10-02T10:00:00.000Z'));
    await pushSocket('music-video:blender', { projectId: 'mv-test', kind: 'state' });
    await waitFor(() => expect(shotPlayer()).not.toBe(waiting));
    expect(shotPlayer().hasAttribute('autoplay')).toBe(true);
  });

  it('holds the final render on the Final render step until every shot is final-rendered', async () => {
    await openFilm('/music-video/mv-test/review');
    expect(await screen.findByText('Render every shot at final quality in Blender film first (1 of 3 ready)')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Render final$/ })).toBeDisabled();
  });
});

describe('shot edits apply their reply without a project read', () => {
  const first = { ...PROJECT_NO_CLIP.scenes[0], label: 'First', startSec: 0, endSec: 10 };
  const second = { ...first, sceneId: 's2', order: 1, startSec: 10, endSec: 14, label: 'Second' };
  const board = { ...PROJECT_NO_CLIP, updatedAt: '2026-01-01T00:00:00.000Z', scenes: [first, second] };
  const ownOrigin = { silent: true, headers: { 'X-PortOS-Origin': 'tab-socket' } };
  const asThisTab = async () => { (await import('../../../services/socket.js')).default.id = 'tab-socket'; };
  const reads = () => getMusicVideoProject.mock.calls.length;

  // Uniquely catches an own edit that still reloads the project, from its reply or from its own broadcast.
  it('moves a cut from the reply, skips its own broadcast and still reloads for another tab', async () => {
    await asThisTab();
    const moved = [{ ...first, endSec: 10.042 }, { ...second, startSec: 10.042 }];
    moveMusicVideoSceneStart.mockResolvedValue({ scene: moved[1], previous: moved[0], edit: editResult(moved, ['s1', 's2'], { updatedAt: '2026-01-01T00:00:01.000Z' }) });
    await openProject(board, 'produce');
    const loaded = reads();
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: /^Open Shot 2/ })));
    fireEvent.click(screen.getByRole('button', { name: 'Start one frame later' }));
    await waitFor(() => expect(moveMusicVideoSceneStart).toHaveBeenCalledWith('mv-2', 's2', 10.042, ownOrigin));
    await waitFor(() => expect(screen.getByLabelText('Start frame').value).toBe('241'));
    await pushSocket('music-video:project:changed', { id: 'mv-2', origin: 'tab-socket' });
    await settle();
    expect(reads()).toBe(loaded);
    getMusicVideoProject.mockResolvedValue({ ...board, updatedAt: '2026-01-01T00:00:03.000Z', scenes: moved });
    await pushSocket('music-video:project:changed', { id: 'mv-2', origin: 'another-tab' });
    await waitFor(() => expect(reads()).toBe(loaded + 1));
  });

  it('marks a shot done from the reply alone', async () => {
    await asThisTab();
    updateMusicVideoScene.mockImplementation(savedSceneReplies(board));
    await openProject(board, 'produce');
    const loaded = reads();
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: /^Open Shot 1/ })));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Done', exact: true }));
    await waitFor(() => expect(updateMusicVideoScene).toHaveBeenCalledWith('mv-2', 's1', { shotSheet: { checked: true } }, ownOrigin));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Done', exact: true })).toBeChecked());
    await settle();
    expect(reads()).toBe(loaded);
  });

  // Uniquely catches a project-field save that applies the whole project reply, or reloads on its own broadcast.
  it('saves a project field from its edit result alone', async () => {
    await asThisTab();
    updateMusicVideoProject.mockResolvedValue({ edit: editResult([first, second], ['s1', 's2'], { updatedAt: '2026-01-01T00:00:01.000Z', project: { pacing: { minShotSec: 2 } } }) });
    await openProject(board, 'produce');
    const loaded = reads();
    const field = await screen.findByLabelText('Shortest shot (s)');
    fireEvent.change(field, { target: { value: '2' } });
    fireEvent.blur(field);
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith('mv-2', { pacing: { minShotSec: 2 } }, { ...ownOrigin, edit: true }));
    await pushSocket('music-video:project:changed', { id: 'mv-2', origin: 'tab-socket' });
    await settle();
    expect(reads()).toBe(loaded);
    updateMusicVideoProject.mockResolvedValue({ id: 'mv-2' });
    const again = await screen.findByLabelText('Shortest shot (s)');
    fireEvent.change(again, { target: { value: '3' } });
    fireEvent.blur(again);
    await waitFor(() => expect(reads()).toBeGreaterThan(loaded));
  });

  // Uniquely catches an added shot that is appended unpresented and then reloaded by its own broadcast.
  it('adds a shot from the reply alone', async () => {
    await asThisTab();
    const added = { ...first, sceneId: 's3', order: 2, startSec: 14, endSec: 18, label: 'Third' };
    addMusicVideoScene.mockResolvedValue({ ...added, edit: editResult([first, second, added], ['s3'], { updatedAt: '2026-01-01T00:00:01.000Z' }) });
    await openProject(board, 'produce');
    const loaded = reads();
    fireEvent.click(await screen.findByRole('button', { name: /Add scene/ }));
    await waitFor(() => expect(addMusicVideoScene).toHaveBeenCalledWith('mv-2', { prompt: '' }, ownOrigin));
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Open Shot \d+ · / })).toHaveLength(3));
    await pushSocket('music-video:project:changed', { id: 'mv-2', origin: 'tab-socket' });
    await settle();
    expect(reads()).toBe(loaded);
  });

  // Uniquely catches a gallery clip import that keeps only the shot patched, so its broadcast or the next board edit reloads the project.
  it('imports a gallery clip take from the reply alone', async () => {
    await asThisTab();
    const imported = { ...first, videoHistoryId: 'rh-9', takes: [{ takeId: 't1', kind: 'video', assetId: 'rh-9', status: 'candidate' }] };
    addMusicVideoSceneTake.mockResolvedValueOnce({ scene: imported, take: imported.takes[0], edit: editResult([imported, second], ['s1'], { updatedAt: '2026-01-01T00:00:01.000Z' }) });
    await openProject(board, 'produce');
    const loaded = reads();
    fireEvent.click(await screen.findByRole('button', { name: /^Import clip take$/ }));
    const dialog = await screen.findByRole('dialog', { name: /Pick a video from your gallery/i });
    const galleryItem = await within(dialog).findByText('(no prompt)');
    fireEvent.click(galleryItem.closest('.bg-port-card').querySelector('button'));
    await waitFor(() => expect(addMusicVideoSceneTake).toHaveBeenCalledWith('mv-2', 's1', { kind: 'video', assetId: 'rh-9', source: 'imported' }, ownOrigin));
    await pushSocket('music-video:project:changed', { id: 'mv-2', origin: 'tab-socket' });
    await settle();
    expect(reads()).toBe(loaded);
  });

  // Uniquely catches a trimmed clip whose two writes leave the board a revision behind: the select's diff would be refused and reload.
  it('trims a clip from the two replies alone', async () => {
    await asThisTab();
    const clipped = { ...first, referenceImageId: 'img1', videoHistoryId: 'h1',
      takes: [{ takeId: 't-v', kind: 'video', assetId: 'h1', source: 'generated', provider: 'portos', sourceImageId: 'img1', status: 'selected', note: null }] };
    const trimmedTake = { takeId: 't-trim', kind: 'video', assetId: 'h1-trim', source: 'trimmed', provider: null, status: 'candidate', note: null };
    const added = { ...clipped, takes: [...clipped.takes, trimmedTake] };
    const selected = { ...clipped, videoHistoryId: 'h1-trim', takes: [{ ...clipped.takes[0], status: 'candidate' }, { ...trimmedTake, status: 'selected' }] };
    trimVideo.mockResolvedValueOnce({ video: { id: 'h1-trim' } });
    addMusicVideoSceneTake.mockResolvedValueOnce({ scene: added, take: trimmedTake, edit: editResult([added, second], ['s1'], { updatedAt: '2026-01-01T00:00:01.000Z' }) });
    selectMusicVideoSceneTake.mockResolvedValueOnce({ ...selected, edit: { ...editResult([selected, second], ['s1'], { updatedAt: '2026-01-01T00:00:02.000Z' }), baseUpdatedAt: '2026-01-01T00:00:01.000Z' } });
    await openProject({ ...board, scenes: [clipped, second] }, 'produce');
    const loaded = reads();
    const render = within(await screen.findByRole('region', { name: 'Render' }));
    for (let i = 0; i < 12; i += 1) fireEvent.click(render.getByRole('button', { name: 'Next frame' }));
    fireEvent.click(render.getByRole('button', { name: /Start clip here/ }));
    await waitFor(() => expect(selectMusicVideoSceneTake).toHaveBeenCalledWith('mv-2', 's1', 't-trim', ownOrigin));
    await pushSocket('music-video:project:changed', { id: 'mv-2', origin: 'tab-socket' });
    await settle();
    expect(reads()).toBe(loaded);
  });

  // Uniquely catches readiness or approval staying as it was before an edit that changed it.
  it('takes readiness from the reply: a reorder that stales the storyboard approval stops asking to re-approve', async () => {
    await asThisTab();
    const readiness = (approved) => ({ readyForProduction: approved, basis: {}, art: { approved: true, problems: [] }, storyboard: { approved, problems: [] }, proof: { approved: false, problems: [] } });
    const approvedBoard = { ...board, productionReadiness: readiness(true) };
    const success = vi.spyOn(toast, 'success');
    reorderMusicVideoScenes.mockImplementation(async (_id, ids) => {
      const order = ids.map((id) => board.scenes.find((scene) => scene.sceneId === id));
      const retimed = order.map((scene, i) => ({ ...scene, order: i, startSec: board.scenes[i].startSec, endSec: board.scenes[i].endSec }));
      return { edit: editResult(retimed, ids, { updatedAt: '2026-01-01T00:00:02.000Z', project: { productionReadiness: readiness(false) } }) };
    });
    await openProject(approvedBoard, 'produce');
    const loaded = reads();
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: /^Open Shot 1/ })));
    fireEvent.click(await screen.findByRole('button', { name: /Move later/ }));
    await waitFor(() => expect(success).toHaveBeenLastCalledWith(expect.stringMatching(/re-approve the storyboard/)));
    fireEvent.click(await findEnabledByRole('button', { name: /Move earlier/ }));
    await waitFor(() => expect(success).toHaveBeenCalledTimes(2));
    expect(success.mock.calls.at(-1)[0]).not.toMatch(/re-approve/);
    expect(reads()).toBe(loaded);
  });

  // Uniquely catches a take decision that patches only its shot, leaving a following board edit to reload the project.
  it('a take decision applies its edit result, so the next board edit still needs no project read', async () => {
    await asThisTab();
    const takes = [
      { takeId: 't-a', kind: 'image', assetId: 'take-a.png', source: 'generated', provider: 'portos', status: 'candidate', note: null },
      { takeId: 't-b', kind: 'image', assetId: 'take-b.png', source: 'imported', provider: 'midjourney', status: 'candidate', note: null },
    ];
    const withTakes = { ...first, referenceImageId: 'take-a.png', videoHistoryId: null, takes };
    const takeBoard = { ...board, scenes: [withTakes, second] };
    const chosen = { ...withTakes, referenceImageId: 'take-b.png' };
    selectMusicVideoSceneTake.mockResolvedValueOnce({ ...chosen, edit: editResult([chosen, second], ['s1', 's2'], { updatedAt: '2026-01-01T00:00:01.000Z' }) });
    const moved = [{ ...chosen, endSec: 10.042 }, { ...second, startSec: 10.042 }];
    moveMusicVideoSceneStart.mockResolvedValue({ scene: moved[1], previous: moved[0], edit: editResult(moved, ['s1', 's2'], { updatedAt: '2026-01-01T00:00:02.000Z' }) });
    await openProject(takeBoard, 'produce');
    const loaded = reads();
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: /^Open Shot 1/ })));
    await showFrames();
    const strip = screen.getByRole('list', { name: /Frame takes/ });
    fireEvent.click(within(strip).getByRole('button', { name: /Use/ }));
    await waitFor(() => expect(selectMusicVideoSceneTake).toHaveBeenCalledWith('mv-2', 's1', 't-b', ownOrigin));
    await waitFor(() => expect(within(strip).getAllByText('In use', { selector: 'button > span' })).toHaveLength(1));
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: /^Open Shot 2/ })));
    fireEvent.click(screen.getByRole('button', { name: 'Start one frame later' }));
    await waitFor(() => expect(moveMusicVideoSceneStart).toHaveBeenCalled());
    await settle();
    expect(reads()).toBe(loaded);
  });

  it('reloads after a refused (409) edit, and after a reply older than the board', async () => {
    await asThisTab();
    const conflict = Object.assign(new Error('The shot changed'), { status: 409 });
    moveMusicVideoSceneStart.mockRejectedValueOnce(conflict);
    await openProject(board, 'produce');
    const loaded = reads();
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: /^Open Shot 2/ })));
    fireEvent.click(screen.getByRole('button', { name: 'Start one frame later' }));
    await waitFor(() => expect(reads()).toBe(loaded + 1));
    // A reply computed before the record the board already shows is a diff against an older base.
    moveMusicVideoSceneStart.mockResolvedValueOnce({ edit: editResult(board.scenes, ['s2'], { updatedAt: '2025-12-31T00:00:00.000Z' }) });
    fireEvent.click(screen.getByRole('button', { name: 'Start one frame later' }));
    await waitFor(() => expect(reads()).toBe(loaded + 2));
  });
});

// #16275 / #16270: a take decision's reply carries the edit result, so the board is on the server's
// revision afterwards and the next shot edit applies its own reply over the takes as decided.
