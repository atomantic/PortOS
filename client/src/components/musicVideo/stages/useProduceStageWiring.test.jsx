/**
 * Music Video page suite for the Shots step container (`useProduceStageWiring`): shot media and takes, the video renderer, shot edits, revisions, composition and the Blender film.
 * Drives the real page through the shared scaffold in `test/musicVideoPageMocks.jsx`.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
// The scaffold registers the mocks, so it loads before any mocked module.
import {
  PROJECT_WITH_CLIP,
  PROJECT_NO_CLIP,
  feedbackCalls,
  pushSocket,
  providerModelsState,
  PROJECT_ANALYZED,
  MV_ROUTES,
  renderMV,
  settle,
  openSettings,
  closeSettings,
  openStage,
  openProject,
  LocationProbe,
  showFrames,
  installMusicVideoPageHooks,
  editResult,
  savedSceneReplies,
} from '../../../test/musicVideoPageMocks.jsx';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import { findEnabledByRole } from '../../../test/enabledBarrier.js';
import { MemoryRouter } from 'react-router';
import toast from '../../ui/Toast';
import { createTestPhaseDiagnostics } from '../../../../../lib/testPhaseDiagnostics.js';
import { addMusicVideoScene, approveMusicVideoFinal, rejectUnusedMusicVideoSceneTakes, measureMusicVideoColorMatch, listMusicVideoProjects, renderMusicVideoProject, reorderMusicVideoScenes, updateMusicVideoProject, updateMusicVideoScene, proposeMusicVideoShotSheet, splitMusicVideoScene, moveMusicVideoSceneStart, selectMusicVideoSceneTake, reviewMusicVideoSceneTake, importMusicVideoHandoff, addMusicVideoSceneTake, getMusicVideoHandoffBundle, getMusicVideoProject, startMusicVideoRevision, resumeMusicVideoRevision, cancelMusicVideoRevision, renderMusicVideoSceneFrame, getMusicVideoBlender, getMusicVideoCastAndSets } from '../../../services/apiMusicVideo.js';
import { generateImage, uploadGalleryImage } from '../../../services/apiSystem.js';
import { generateVideo, getVideoGenModelContext, getVideoHistoryItem, previewImagePrompt, previewVideoPrompt, trimVideo } from '../../../services/apiImageVideo.js';
import { downloadBlob } from '../../../lib/downloadBlob.js';
import { blenderFilmProject, blenderFilmState } from '../../../test/blenderFilmFixture.js';
import { problem, withProblems } from '../../../test/musicVideoProblems.js';
import { finalApprovalPatch } from '../../../../../server/lib/musicVideo/musicVideoFinalApproval.js';
import { warmSceneCard } from '../sceneCardTestWarmup.jsx';
beforeAll(warmSceneCard, 30000);

installMusicVideoPageHooks();

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
    getVideoGenModelContext.mockResolvedValueOnce({
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
    // The picker reads the probe-free catalog route; /video-gen/status (which spawns
    // Python per call) is not part of this surface's API mock at all (#17108).
    expect(getVideoGenModelContext).toHaveBeenCalledWith({ silent: true });
  });

  it('renders a scene image-to-video through a saved fal.ai pin (#8968)', async () => {
    getVideoGenModelContext.mockResolvedValueOnce({
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
    // Hailuo-02 offers two resolutions, so the card renders a draft or a final (#16136); final is its highest.
    fireEvent.click(await findEnabledByRole('button', { name: /^Render final/ }));
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
    getVideoGenModelContext.mockResolvedValueOnce({ connected: true, defaultModel: 'ltx23_distilled_q4', falEnabled: true,
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
    expect(render.getByRole('button', { name: /^Render final.*\$/ })).toBeTruthy();
    fireEvent.click(render.getByRole('button', { name: /^Render final/ }));
    await waitFor(() => expect(generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      backend: 'fal', falModelId: 'fal-ai/minimax/hailuo-02/standard/image-to-video', mode: 'image', sourceImageFile: 'img1',
    })));
    expect(generateVideo.mock.calls.at(-1)[0]).not.toHaveProperty('modelId');
    expect(updateMusicVideoProject.mock.calls.some(([, patch]) => patch?.videoSettings)).toBe(false);
  });

  // A hosted cutaway cannot hear the song, even when the Local project default supplies it.
  it('previews and renders a Grok override without inheriting Local song audio', async () => {
    localStorage.removeItem('portos.musicVideo.lastRenderOn');
    generateVideo.mockResolvedValue({ jobId: 'grok-pick-job' });
    await openProject({ ...PROJECT_NO_CLIP, videoSettings: { backend: 'local', generationMode: 'suppliedAudio' } }, 'produce');
    const render = within(await screen.findByRole('region', { name: 'Render' }));
    fireEvent.change(render.getByLabelText('Render on'), { target: { value: 'grok' } });
    expect(render.getByLabelText('Song audio')).toBeDisabled();
    expect(render.getByLabelText('Song audio')).not.toBeChecked();
    await waitFor(() => expect(previewVideoPrompt).toHaveBeenCalledWith(expect.objectContaining({
      backend: 'grok', musicVideo: expect.objectContaining({ songAudio: false }),
    }), { silent: true }));
    fireEvent.click(await findEnabledByRole('button', { name: /^Render$/ }));
    await waitFor(() => expect(generateVideo).toHaveBeenCalledWith(expect.objectContaining({ backend: 'grok', mode: 'image' })));
    expect(JSON.parse(generateVideo.mock.calls.at(-1)[0].musicVideo)).toMatchObject({ songAudio: false, expectedShot: 'cutaway' });
    expect(updateMusicVideoProject.mock.calls.some(([, patch]) => patch?.videoSettings)).toBe(false);
  });

  // Uniquely catches "Local LTX" falling through to the install's default model, and a picked length being dropped.
  it('renders a Local LTX pick on the model and length its card shows, LTX-2.5 before the install default', async () => {
    getVideoGenModelContext.mockResolvedValueOnce({ connected: true, defaultModel: 'ltx23_distilled_q4', falEnabled: true,
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
    getVideoGenModelContext.mockResolvedValueOnce({ connected: true, defaultModel: '', falEnabled: true, models: [] });
    generateVideo.mockResolvedValue({ jobId: 'fal-h3-job' });
    await openProject({
      ...PROJECT_NO_CLIP,
      videoSettings: { backend: 'fal', falModelId: 'minimax/h3-max/image-to-video', falResolution: '1080P' },
      scenes: [{ ...PROJECT_NO_CLIP.scenes[0], startSec: 0, endSec: 7.2 }],
    }, 'produce');

    // A 7.2s shot on H3 Max (5–15s whole seconds) renders 8s at $0.16/s.
    expect((await screen.findByTestId('fal-cutaway-plan')).textContent).toContain('est. $1.28 (8s at 1080P)');
    fireEvent.click(await findEnabledByRole('button', { name: /^Render final/ }));
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
    // getVideoGenModelContext's default mock omits falEnabled, so it resolves false —
    // exactly the "no fal.ai API key configured" install this covers.
    await openProject({ ...PROJECT_NO_CLIP, videoSettings: { backend: 'fal' } }, 'produce');

    const generate = await screen.findByRole('button', { name: /^Render final/ });
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
      getVideoGenModelContext.mockResolvedValueOnce({
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
      // With no final resolution set, Render final takes the lip-sync model's highest tier (#16136).
      fireEvent.click(await findEnabledByRole('button', { name: /^Render final/ }));
      await waitFor(() => expect(generateVideo).toHaveBeenCalledWith(expect.objectContaining({
        backend: 'fal', mode: 'image', sourceImageFile: 'img1', falResolution: '2K',
      })));
      expect(generateVideo.mock.calls.at(-1)[0]).not.toHaveProperty('falDuration');
      expect(generateVideo.mock.calls.at(-1)[0]).not.toHaveProperty('falModelId');
    });

    it('keeps the fal performance song window when overriding a Local supplied-audio project', async () => {
      getVideoGenModelContext.mockResolvedValueOnce({ connected: true, defaultModel: 'ltx23_distilled_q4', falEnabled: true,
        models: [{ id: 'ltx23_distilled_q4', name: 'LTX-2.3 Distilled Q4', runtime: 'ltx2' }] });
      generateVideo.mockResolvedValue({ jobId: 'fal-performance-job' });
      await openProject(performanceProject({ backend: 'local', generationMode: 'suppliedAudio' }), 'produce');
      const render = within(await screen.findByRole('region', { name: 'Render' }));
      fireEvent.change(render.getByLabelText('Render on'), { target: { value: 'fal' } });
      expect(render.getByLabelText('Song audio')).toBeChecked();
      expect(render.getByLabelText('Song audio')).toBeDisabled();
      fireEvent.click(await findEnabledByRole('button', { name: /^Render final/ }));
      await waitFor(() => expect(generateVideo).toHaveBeenCalledWith(expect.objectContaining({ backend: 'fal', mode: 'image' })));
      expect(JSON.parse(generateVideo.mock.calls.at(-1)[0].musicVideo)).toMatchObject({ songAudio: false, expectedShot: 'lipsync' });
    });

    // #16136: catches the card's Approve for final not reaching the route, or its reply not reaching the board.
    it('approves a draft clip for final from the shot card and badges its board thumbnail', async () => {
      const take = { takeId: 'tk1', kind: 'video', assetId: 'h1', tier: 'draft', status: 'candidate' };
      const project = { ...PROJECT_WITH_CLIP, scenes: [{ ...PROJECT_WITH_CLIP.scenes[0], label: 'Opening', takes: [take] }] };
      approveMusicVideoFinal.mockImplementation(async (_id, { sceneIds, approved }) => {
        const scenes = project.scenes.map((scene) => (sceneIds.includes(scene.sceneId)
          ? { ...scene, finalApproval: approved ? finalApprovalPatch(project.scenes[0], true).patch.finalApproval : null } : scene));
        return { scenes: scenes.filter((scene) => sceneIds.includes(scene.sceneId)), counts: { draft: 1, approved: approved ? 1 : 0, final: 0, missing: 0 }, edit: editResult(scenes, sceneIds) };
      });
      await openProject(project, 'produce');
      fireEvent.click(within(await screen.findByLabelText('Storyboard thumbnails')).getByRole('button', { name: /Opening/ }));
      fireEvent.click(await screen.findByLabelText(/Approve for final/));
      await waitFor(() => expect(approveMusicVideoFinal).toHaveBeenCalledWith('mv-1', { sceneIds: ['s1'], approved: true }, { silent: true }));
      await waitFor(() => expect(screen.getByLabelText(/Approve for final/)).toBeChecked());
      expect(screen.getByTestId('scene-tier-badge')).toHaveTextContent('Approved for final');
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
      splitMusicVideoScene.mockResolvedValue({ scenes: pieces, edit: editResult(pieces) });
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
      splitMusicVideoScene.mockResolvedValue({ scenes: pieces, edit: editResult(pieces) });
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
      moveMusicVideoSceneStart.mockResolvedValue({ scene: moved[1], previous: moved[0], edit: editResult(moved) });
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

describe('MusicVideo clip timing saves', () => {
  it('previews each nudge immediately and coalesces unsent speed and offset changes while a save is slow', async () => {
    const project = {
      ...PROJECT_WITH_CLIP,
      scenes: [{ ...PROJECT_WITH_CLIP.scenes[0], startSec: 0, endSec: 4, beatAligned: true }],
    };
    const reply = savedSceneReplies(project);
    let finishFirst;
    let finishNext;
    updateMusicVideoScene
      .mockImplementationOnce((...args) => new Promise((resolve) => { finishFirst = () => resolve(reply(...args)); }))
      .mockImplementationOnce((...args) => new Promise((resolve) => { finishNext = () => resolve(reply(...args)); }));
    await openProject(project, 'produce');
    const faster = await screen.findByRole('button', { name: 'Play the clip one fps faster' });
    const further = screen.getByRole('button', { name: 'Start the clip one frame further in' });
    fireEvent.click(faster);
    fireEvent.click(faster);
    fireEvent.click(further);
    fireEvent.click(faster);
    fireEvent.click(further);

    expect(screen.getByLabelText('Speed')).toHaveValue(3);
    expect(screen.getByLabelText('Offset')).toHaveValue(2);
    expect(updateMusicVideoScene).toHaveBeenCalledTimes(1);
    expect(updateMusicVideoScene).toHaveBeenLastCalledWith('mv-1', 's1', { speedFps: 1 }, { silent: true });
    expect(screen.getByRole('button', { name: 'Prepare clip with music' })).toBeDisabled();

    await act(async () => finishFirst());
    expect(screen.getByLabelText('Speed')).toHaveValue(3);
    expect(screen.getByLabelText('Offset')).toHaveValue(2);
    expect(updateMusicVideoScene).toHaveBeenCalledTimes(2);
    expect(updateMusicVideoScene).toHaveBeenLastCalledWith('mv-1', 's1', { speedFps: 3, offsetFrames: 2 }, { silent: true });
    expect(screen.getByRole('button', { name: 'Prepare clip with music' })).toBeDisabled();

    await act(async () => finishNext());
    expect(screen.getByLabelText('Speed')).toHaveValue(3);
    expect(screen.getByLabelText('Offset')).toHaveValue(2);
    expect(screen.getByRole('button', { name: 'Prepare clip with music' })).toBeEnabled();
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

describe('MusicVideo lyrics and shot coverage (#8964)', () => {
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
    updateMusicVideoScene.mockImplementation(savedSceneReplies(project));
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

describe('MusicVideo typography composition (#8984)', () => {
  it('seeds text cues from the timed lyrics, switches to a composed render, and saves an edited cue whole', async () => {
    const lyricCues = [
      { id: 'lc-1', text: 'first line', startSec: 1, endSec: 3 },
      { id: 'lc-2', text: 'untimed line', startSec: null, endSec: null },
    ];
    let saves = 0;
    updateMusicVideoProject.mockImplementation(async (_id, patch) => ({ edit: editResult([], [], { updatedAt: `2026-01-01T00:00:0${++saves}.000Z`, project: patch }) }));
    await openProject({ ...PROJECT_ANALYZED, lyricCues }, 'compose');

    fireEvent.click(await screen.findByRole('button', { name: /Copy timed lyrics \(1\)/ }));
    const text = await screen.findByLabelText('Text cue 1 text');
    expect(text).toHaveValue('first line');
    expect(screen.queryByLabelText('Text cue 2 text')).toBeNull();
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenLastCalledWith('mv-3', {
      composition: expect.objectContaining({ mode: 'concat', textCues: [expect.objectContaining({ text: 'first line', startSec: 1, endSec: 3, template: 'fade' })] }),
    }, { silent: true, edit: true }));

    expect(document.getElementById('mv-typo-mode')).toBeNull(); // render style is chosen in Setup only
    fireEvent.change(screen.getByLabelText('Text cue 1 motion'), { target: { value: 'typewriter' } });
    fireEvent.change(text, { target: { value: 'first line, typed' } });
    fireEvent.blur(text);
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenLastCalledWith('mv-3', {
      composition: expect.objectContaining({
        mode: 'concat',
        textCues: [expect.objectContaining({ text: 'first line, typed', template: 'typewriter' })],
      }),
    }, { silent: true, edit: true }));
  });
});

it('reloads persisted shots when a one-tap render repair fails partway through', async () => {
  const first = { ...PROJECT_WITH_CLIP.scenes[0], startSec: 0, endSec: 4 };
  const second = { ...first, sceneId: 's2', order: 1, startSec: 4, endSec: 8 };
  const project = { ...PROJECT_WITH_CLIP, scenes: [first, second] };
  let persisted = project;
  getMusicVideoProject.mockImplementation(async () => persisted);
  renderMusicVideoProject.mockRejectedValueOnce(Object.assign(new Error('Clips are too short'), {
    code: 'INSUFFICIENT_CLIP_COVERAGE',
    context: { shortfalls: [{ sceneId: 's1' }, { sceneId: 's2' }] },
  }));
  updateMusicVideoScene.mockImplementationOnce(async (_id, _sceneId, patch) => {
    const scenes = [{ ...first, ...patch }, second];
    const updatedAt = '2026-01-01T00:00:01.000Z';
    persisted = { ...project, scenes, updatedAt };
    return { edit: editResult(scenes, ['s1'], { updatedAt }) };
  }).mockRejectedValueOnce(new Error('Second shot could not be saved'));

  await openProject(project, 'review');
  fireEvent.click(await findEnabledByRole('button', { name: 'Render final' }));
  const repair = await screen.findByRole('button', { name: 'Hold the last frame on these 2' });
  getMusicVideoProject.mockClear();
  fireEvent.click(repair);

  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Second shot could not be saved'));
  expect(updateMusicVideoScene).toHaveBeenNthCalledWith(1, project.id, 's1', { holdLastFrame: true }, expect.anything());
  expect(updateMusicVideoScene).toHaveBeenNthCalledWith(2, project.id, 's2', { holdLastFrame: true }, expect.anything());
  await waitFor(() => expect(getMusicVideoProject).toHaveBeenCalledWith(project.id, { silent: true }));
  await openStage('produce');
  fireEvent.click(await screen.findByRole('button', { name: 'Open Shot 1' }));
  expect(await screen.findByRole('checkbox', { name: /Hold last frame/ })).toBeChecked();
  fireEvent.click(await screen.findByRole('button', { name: 'Open Shot 2' }));
  await waitFor(() => expect(screen.getByRole('checkbox', { name: /Hold last frame/ })).not.toBeChecked());
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

  it('opens the lightbox from a scene-clip expand control without hijacking play/pause', async ({ onTestFailed }) => {
    const phase = createTestPhaseDiagnostics(onTestFailed);
    await openProject(PROJECT_WITH_CLIP, 'produce', phase);
    // Inline thumb keeps its own controls attribute for native play/pause.
    const inlineVideo = document.querySelector('video[src="/data/videos/h1.mp4"]');
    expect(inlineVideo).toBeTruthy();
    expect(inlineVideo.hasAttribute('controls')).toBe(true);

    const expand = await phase('find-expand-control', () => screen.findByRole('button', { name: 'View scene 1 clip full size' }));
    fireEvent.click(expand);
    const dialog = await phase('viewer-dialog', () => screen.findByRole('dialog', { name: /Media viewer/i }));
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
    await openProject(SPEC_PROJECT, 'produce');
    fireEvent.click(screen.getByRole('button', { name: /^Generate frame$/ }));
    await waitFor(() => expect(renderMusicVideoSceneFrame).toHaveBeenCalledWith(
      'mv-spec', 's1', { slot: 'start' }, { silent: true },
    ));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      expect.stringMatching(/Reference images are only supported.*Switch the image backend/),
    ));
  });

  it('asks the server for a frame on a shot whose section plate is approved', async () => {
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
    await waitFor(() => expect(renderMusicVideoSceneFrame).toHaveBeenCalledWith(
      'mv-spec', 's1', { slot: 'start' }, { silent: true },
    ));
  });

  // Uniquely catches a frame picked as the render's image reference not reaching the request.
  it('renders a new frame take from the shot\'s own start frame when it is picked as the reference', async () => {
    await openProject({ ...SPEC_PROJECT, scenes: [{ ...SPEC_PROJECT.scenes[0], referenceImageId: 'start.png' }] }, 'produce');
    fireEvent.change(screen.getByLabelText('From', { selector: '#mv-scene-s1-start-from' }), { target: { value: 'start' } });
    await showFrames();
    fireEvent.click(screen.getByRole('button', { name: /^New frame take$/ }));
    await waitFor(() => expect(renderMusicVideoSceneFrame).toHaveBeenCalledWith(
      'mv-spec', 's1', { slot: 'start', fromFrame: true, referenceImageId: 'start.png' }, { silent: true },
    ));
  });

  it('submits a model override for one new frame take without saving it as the shot default', async () => {
    await openProject({ ...SPEC_PROJECT, imageMode: 'grok', scenes: [{ ...SPEC_PROJECT.scenes[0], referenceImageId: 'start.png' }] }, 'produce');
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
    await openProject({ ...SPEC_PROJECT, scenes: [{ ...SPEC_PROJECT.scenes[0], referenceImageId: 'start.png' }] }, 'produce');
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
    await openProject({ ...SPEC_PROJECT, visualSpec: { ...SPEC_PROJECT.visualSpec, references },
      scenes: [{ ...SPEC_PROJECT.scenes[0], referenceImageId: 'start.png' }] }, 'produce');
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
    await openProject({ ...PROJECT_WITH_CLIP, id: 'mv-trim', scenes: [scene] }, 'produce');
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
});

it('waits for a grade save before rendering and keeps the saved look when a later save fails', async () => {
  const project = { ...PROJECT_WITH_CLIP, composition: { mode: 'composed', textCues: [], style: { color: '#ffffff', font: 'sans' } } };
  let finishSave;
  updateMusicVideoProject.mockImplementationOnce((_id, patch) => new Promise((resolve) => {
    finishSave = () => resolve({ edit: editResult(project.scenes || [], [], { updatedAt: '2026-01-01T00:00:01.000Z', project: patch }) });
  }));
  await openProject(project, 'compose');
  fireEvent.change(screen.getByLabelText('Default section look'), { target: { value: 'teal-night' } });
  await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith(project.id,
    { composition: expect.objectContaining({ grade: expect.objectContaining({ preset: 'teal-night' }) }) }, { silent: true, edit: true }));
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

describe('stage checklist and project options', () => {
  it('lists open storyboard feedback on its own Feedback row, settled with buttons there, never under Lyrics', async () => {
    const note = { id: 'fb-a', stage: 'storyboard', target: 'Chorus', text: 'Put the lyrics on the wall, not the screen', decision: 'request-changes', basis: 'board' };
    const project = { ...PROJECT_ANALYZED, scenes: [{ sceneId: 's-a', order: 0, label: 'Chorus', startSec: 0, endSec: 4 }],
      productionReview: { draft: { storyboard: [] }, feedback: [note] },
      productionReadiness: { readyForProduction: false, basis: { storyboard: 'board' }, art: { approved: true, problems: [] },
        storyboard: withProblems({ approved: false }, [problem('feedback', `Resolve storyboard feedback for ${note.target}: ${note.text}`)]), proof: { approved: false, problems: [] } } };
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
    // Storyboard approval, on Shots, waits on the same request.
    await openStage('produce', false);
    expect(screen.getByRole('region', { name: 'Approve: Lyric-timed storyboard' })).toHaveTextContent('Resolve the change request on Chorus first.');
  });

  // Uniquely catches a lyric anchor problem the director cannot find or settle from the checklist.
  it('names each shot whose lyric anchors differ from the singing, opens it, and anchors them all in one tap', async () => {
    const project = { ...PROJECT_ANALYZED, scenes: [{ sceneId: 's-a', order: 0, label: 'Drummer', startSec: 0, endSec: 4 }, { sceneId: 's-b', order: 1, label: 'Singer', startSec: 4, endSec: 8 }],
      productionReview: { draft: { storyboard: [] } },
      productionReadiness: { readyForProduction: false, basis: {}, art: { approved: true, problems: [] },
        storyboard: withProblems({ approved: false,
          lyricAnchors: [{ sceneId: 's-b', sung: ['If you think this is slop'], anchored: [] }] }, [problem('lyric-anchors', 'Review lyric anchors for Singer.', 's-b')]), proof: { approved: false, problems: [] } } };
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

  // Uniquely catches a coverage or details problem the director cannot trace to a shot.
  it('names the shots behind Shot coverage and Shot details, each opening its card', async () => {
    const project = { ...PROJECT_ANALYZED, scenes: [{ sceneId: 's-a', order: 0, label: 'Drummer', startSec: 0, endSec: 4 }, { sceneId: 's-b', order: 1, label: 'Singer', startSec: 4.5, endSec: 8 }],
      productionReview: { draft: { storyboard: [] } },
      productionReadiness: { readyForProduction: false, basis: {}, art: { approved: true, problems: [] },
        storyboard: withProblems({ approved: false,
          coverage: [{ sceneId: 's-b', issue: 'gap', startSec: 4, endSec: 4.5 }],
          incompleteShots: [{ sceneId: 's-b', missing: ['staging'] }] },
        [problem('coverage', 'Storyboard shots must cover the master without unintended gaps or overlaps.'), problem('shot-incomplete', 'Complete timing, action, staging, camera and transition for Singer.', 's-b')]), proof: { approved: false, problems: [] } } };
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
    getMusicVideoBlender.mockResolvedValueOnce(state);
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
    expect(getMusicVideoBlender).toHaveBeenCalledTimes(1);
    expect(getMusicVideoBlender).toHaveBeenCalledWith('mv-test', { silent: true });
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
    getMusicVideoBlender.mockResolvedValueOnce(rerendered('2026-10-02T09:00:00.000Z'));
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
    getMusicVideoBlender.mockResolvedValueOnce(rerendered('2026-10-02T10:00:00.000Z'));
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

describe('Code video storyboard approval gating on Produce stage (#15723)', () => {
  it('enables Generate code video with default approved readiness', async () => {
    const codeProject = {
      ...PROJECT_WITH_CLIP,
      composition: { mode: 'code' },
    };

    // Default readiness (storyboard: { approved: true })
    await openProject(codeProject, 'produce');
    const generateBtn = await screen.findByRole('button', { name: /Generate code video/ });
    await waitFor(() => expect(generateBtn).toBeEnabled());
    expect(screen.queryByText('Approve the storyboard first')).toBeNull();
  });

  it('disables Generate code video with reason when storyboard is not approved', async () => {
    const unapprovedProject = {
      ...PROJECT_WITH_CLIP,
      id: 'mv-code-unapproved',
      name: 'Unapproved Code Video Project',
      composition: { mode: 'code' },
      productionReadiness: {
        readyForProduction: false,
        basis: {},
        art: { approved: true, problems: [] },
        storyboard: { approved: false, problems: ['Storyboard not approved'] },
        proof: { approved: false, problems: [] },
      },
    };
    await openProject(unapprovedProject, 'produce');
    const unapprovedBtn = await screen.findByRole('button', { name: /Generate code video/ });
    await waitFor(() => expect(unapprovedBtn).toBeDisabled());
    expect(await screen.findByText('Approve the storyboard first')).toBeTruthy();
  });
});

it('shares Done between editor, board and sheet, and accepts remote changes after a failed save', async () => {
  const project = { ...PROJECT_WITH_CLIP, scenes: [{ ...PROJECT_WITH_CLIP.scenes[0], label: 'Shot 1', shotSheet: { location: 'Park', checked: false } }] };
  let settle;
  updateMusicVideoScene.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
  await openProject(project, 'produce');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Done', exact: true }));
  expect(updateMusicVideoScene).toHaveBeenCalledWith('mv-1', project.scenes[0].sceneId, { shotSheet: { checked: true } }, { silent: true });
  await act(async () => settle(await savedSceneReplies(project)(project.id, project.scenes[0].sceneId, { shotSheet: { checked: true } })));
  expect(screen.getByRole('checkbox', { name: 'Done', exact: true })).toBeChecked();
  expect(within(screen.getByLabelText('Storyboard thumbnails')).getByRole('button', { name: 'Open Shot 1' })).toHaveClass('border-port-success');
  fireEvent.click(screen.getByRole('button', { name: 'Close shot' }));
  fireEvent.click(screen.getByText('Shot sheet'));
  expect(screen.getByRole('checkbox', { name: 'Shot 1 done' })).toBeChecked();
  fireEvent.click(screen.getAllByRole('button', { name: 'Open Shot 1' }).find(button => button.closest('tr')));
  updateMusicVideoScene.mockRejectedValueOnce(new Error('Save unavailable'));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Done', exact: true }));
  await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Done', exact: true })).not.toBeDisabled());
  expect(screen.getByRole('checkbox', { name: 'Done', exact: true })).toBeChecked();
  getMusicVideoProject.mockResolvedValue({ ...project, scenes: [{ ...project.scenes[0], shotSheet: { location: 'Station', checked: false } }] });
  await pushSocket('music-video:project:changed', { id: project.id });
  await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Done', exact: true })).not.toBeChecked());
  expect(screen.getByRole('combobox', { name: 'Location' })).toHaveValue('Station');
});

// #16247: a shot edit from this tab patches the board from its reply and never reads the whole project again.
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
describe('take decisions then shot edits keep the takes as the server holds them', () => {
  const image = (takeId, assetId, extra = {}) => ({ takeId, kind: 'image', assetId, source: 'generated', provider: 'portos', status: 'candidate', note: null, ...extra });
  const first = { ...PROJECT_NO_CLIP.scenes[0], label: 'First', startSec: 0, endSec: 10, referenceImageId: 'a.png', shotSheet: { checked: false },
    takes: [image('t-a', 'a.png'), image('t-b', 'b.png'), image('t-c', 'c.png')] };
  const second = { ...PROJECT_NO_CLIP.scenes[0], sceneId: 's2', order: 1, label: 'Second', startSec: 10, endSec: 14, referenceImageId: null, takes: [] };
  const board = { ...PROJECT_NO_CLIP, updatedAt: '2026-01-01T00:00:00.000Z', scenes: [first, second] };
  const asThisTab = async () => { (await import('../../../services/socket.js')).default.id = 'tab-socket'; };
  const reads = () => getMusicVideoProject.mock.calls.length;
  const unusedControl = () => screen.queryByRole('button', { name: /^Reject unused/ });

  // A stand-in for the server: every write moves the revision and answers with the edit result of
  // the record before it (server/services/musicVideo/editResult.js), as the routes do.
  const fakeServer = (start = board) => {
    let record = start;
    let writes = 0;
    const write = (touches, change) => {
      const before = record;
      writes += 1;
      const scenes = before.scenes.map((scene) => (touches(scene) ? change(scene) : scene));
      record = { ...before, scenes, updatedAt: `2026-01-01T00:00:${String(writes).padStart(2, '0')}.000Z` };
      const changed = scenes.filter((scene) => JSON.stringify(scene) !== JSON.stringify(before.scenes.find((s) => s.sceneId === scene.sceneId)));
      return { edit: { updatedAt: record.updatedAt, baseUpdatedAt: before.updatedAt, sceneIds: scenes.map((scene) => scene.sceneId), scenes: changed, project: {}, removed: [] },
        scene: (id) => scenes.find((scene) => scene.sceneId === id) };
    };
    const only = (id) => (scene) => scene.sceneId === id;
    const takeReply = (sceneId, change) => { const { edit, scene } = write(only(sceneId), change); return { ...scene(sceneId), edit }; };
    getMusicVideoProject.mockImplementation(async () => record);
    rejectUnusedMusicVideoSceneTakes.mockImplementation(async (_id, sceneId) => {
      const { edit, scene } = write(only(sceneId), (shot) => ({ ...shot, takes: shot.takes.map((take) => (take.assetId === shot.referenceImageId ? take : { ...take, status: 'rejected' })) }));
      return { scene: scene(sceneId), rejected: 2, edit };
    });
    selectMusicVideoSceneTake.mockImplementation(async (_id, sceneId, takeId) => takeReply(sceneId, (shot) => ({ ...shot,
      referenceImageId: shot.takes.find((take) => take.takeId === takeId).assetId })));
    reviewMusicVideoSceneTake.mockImplementation(async (_id, sceneId, takeId, review) => takeReply(sceneId, (shot) => ({ ...shot, takes: shot.takes.map((take) => (take.takeId !== takeId ? take
      : review.confirmFrame ? { ...take, dependencyState: { status: 'current', reasons: [] } } : { ...take, status: review.status })) })));
    updateMusicVideoScene.mockImplementation(async (_id, sceneId, patch) => {
      const { edit, scene } = write(only(sceneId), (shot) => ({ ...shot, ...patch, ...(patch.shotSheet ? { shotSheet: { ...shot.shotSheet, ...patch.shotSheet } } : {}) }));
      return { ...scene(sceneId), edit };
    });
    moveMusicVideoSceneStart.mockImplementation(async (_id, sceneId, startSec) => {
      const { edit, scene } = write((shot) => shot.sceneId === sceneId || shot.endSec === record.scenes.find((s) => s.sceneId === sceneId).startSec,
        (shot) => (shot.sceneId === sceneId ? { ...shot, startSec } : { ...shot, endSec: startSec }));
      return { scene: scene(sceneId), edit };
    });
    return { record: () => record };
  };
  const openShot = async (name, project = board) => {
    await asThisTab();
    await openProject(project, 'produce');
    await act(async () => fireEvent.click(await screen.findByRole('button', { name })));
  };
  const markDone = async () => {
    fireEvent.click(screen.getByRole('checkbox', { name: 'Done', exact: true }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Done', exact: true })).toBeChecked());
    await settle();
  };

  // Uniquely catches #16275: Done bringing back takes the director already rejected, or reading the whole project to get there.
  it('reject unused, then Done: the unused count stays 0 with no project read', async () => {
    fakeServer();
    await openShot(/^Open Shot 1/);
    const loaded = reads();
    fireEvent.click(screen.getByRole('button', { name: 'Reject unused (2)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject 2' }));
    await waitFor(() => expect(unusedControl()).toBeNull());
    await markDone();
    expect(unusedControl()).toBeNull();
    expect(reads()).toBe(loaded);
  });

  it('select a take, then edit the prompt: the selection stays with no project read', async () => {
    const server = fakeServer();
    await openShot(/^Open Shot 1/);
    const loaded = reads();
    await showFrames();
    const strip = screen.getByRole('list', { name: /Frame takes/ });
    fireEvent.click(within(within(strip).getAllByRole('listitem')[1]).getByRole('button', { name: /Use/ }));
    await waitFor(() => expect(selectMusicVideoSceneTake).toHaveBeenCalledWith('mv-2', 's1', 't-b', expect.anything()));
    await settle();
    const prompt = screen.getByLabelText(/^(Clip|Shot) prompt$/);
    fireEvent.change(prompt, { target: { value: 'waves, at dusk' } });
    fireEvent.blur(prompt);
    await waitFor(() => expect(updateMusicVideoScene).toHaveBeenCalledWith('mv-2', 's1', { prompt: 'waves, at dusk' }, expect.anything()));
    await settle();
    expect(server.record().scenes[0].referenceImageId).toBe('b.png');
    const items = within(screen.getByRole('list', { name: /Frame takes/ })).getAllByRole('listitem');
    expect(within(items[1]).queryByRole('button', { name: /Use/ })).toBeNull();
    expect(within(items[0]).getByRole('button', { name: /Use/ })).toBeTruthy();
    expect(reads()).toBe(loaded);
  });

  it('reject one take, then move the shot start: the take stays rejected and both cuts move, with no project read', async () => {
    const project = { ...board, scenes: [first, { ...second, takes: [image('t-x', 'x.png'), image('t-y', 'y.png')], referenceImageId: 'x.png' }] };
    fakeServer(project);
    await openShot(/^Open Shot 2/, project);
    const loaded = reads();
    await showFrames();
    const items = within(screen.getByRole('list', { name: /Frame takes/ })).getAllByRole('listitem');
    fireEvent.click(within(items[1]).getByRole('button', { name: /Reject/ }));
    await waitFor(() => expect(within(items[1]).getByRole('button', { name: /Restore/ })).toBeTruthy());
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Start one frame later' }));
    await waitFor(() => expect(screen.getByLabelText('Start frame').value).toBe('241'));
    await settle();
    expect(within(within(screen.getByRole('list', { name: /Frame takes/ })).getAllByRole('listitem')[1]).getByRole('button', { name: /Restore/ })).toBeTruthy();
    expect(unusedControl()).toBeNull();
    expect(reads()).toBe(loaded);
  });

  it('Still matches, then Done: the frame stays confirmed with no project read', async () => {
    const stale = { status: 'stale', reasons: ['Frame prompt changed'] };
    const project = { ...board, scenes: [{ ...first, takes: [image('t-a', 'a.png', { dependencyState: stale })] }, second] };
    fakeServer(project);
    await openShot(/^Open Shot 1/, project);
    const loaded = reads();
    await showFrames();
    fireEvent.click(screen.getByRole('button', { name: 'Still matches' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Still matches' })).toBeNull());
    await markDone();
    expect(screen.queryByRole('button', { name: 'Still matches' })).toBeNull();
    expect(reads()).toBe(loaded);
  });

  // #16270: what a take decision changes elsewhere on the board (here readiness) comes with its reply.
  it('takes readiness from a take decision reply', async () => {
    const readiness = (approved) => ({ readyForProduction: approved, basis: {}, art: { approved: true, problems: [] }, storyboard: { approved, problems: [] }, proof: { approved: false, problems: [] } });
    const success = vi.spyOn(toast, 'success');
    const approvedBoard = { ...board, productionReadiness: readiness(true) };
    fakeServer(approvedBoard);
    rejectUnusedMusicVideoSceneTakes.mockImplementationOnce(async () => {
      const scene = { ...first, takes: first.takes.map((take) => (take.takeId === 't-a' ? take : { ...take, status: 'rejected' })) };
      return { scene, rejected: 2, edit: { updatedAt: '2026-01-01T00:00:01.000Z', baseUpdatedAt: board.updatedAt, sceneIds: ['s1', 's2'], scenes: [scene], project: { productionReadiness: readiness(false) }, removed: [] } };
    });
    reorderMusicVideoScenes.mockImplementation(async (_id, ids) => ({ edit: { updatedAt: '2026-01-01T00:00:02.000Z', baseUpdatedAt: '2026-01-01T00:00:01.000Z',
      sceneIds: ids, scenes: ids.map((id, i) => ({ ...(id === 's1' ? first : second), order: i, startSec: board.scenes[i].startSec, endSec: board.scenes[i].endSec })), project: {}, removed: [] } }));
    await openShot(/^Open Shot 1/, approvedBoard);
    const loaded = reads();
    fireEvent.click(screen.getByRole('button', { name: 'Reject unused (2)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject 2' }));
    await waitFor(() => expect(unusedControl()).toBeNull());
    fireEvent.click(await findEnabledByRole('button', { name: /Move later/ }));
    await waitFor(() => expect(success).toHaveBeenCalled());
    expect(success.mock.calls.at(-1)[0]).not.toMatch(/re-approve/);
    expect(reads()).toBe(loaded);
  });

  // Uniquely catches a color match pinning the shot's takes as typed text: every later reply and reload
  // then kept that copy over the server's, so takes rejected elsewhere still showed as unused.
  it('a color match keeps no copy of the takes: a rejection made elsewhere shows after the reload', async () => {
    const shot = { ...first, shotSheet: { checked: false, cameraId: 'cam', location: 'Set', timeOfDay: 'Day' } };
    const project = { ...board, composition: { mode: 'document' }, cameras: [{ id: 'cam', name: 'Main' }], scenes: [shot, second] };
    fakeServer(project);
    measureMusicVideoColorMatch.mockResolvedValue({ scenes: [{ ...shot, takes: [{ ...shot.takes[0], colorMatch: { enabled: true, strength: 0.5 } }] }] });
    await openShot(/^Open Shot 1/, project);
    fireEvent.click(await screen.findByRole('button', { name: 'Measure this shot' }));
    await waitFor(() => expect(measureMusicVideoColorMatch).toHaveBeenCalled());
    await settle();
    getMusicVideoProject.mockResolvedValue({ ...project, updatedAt: '2026-01-01T00:00:05.000Z',
      scenes: [{ ...shot, takes: shot.takes.map((take) => (take.takeId === 't-a' ? take : { ...take, status: 'rejected' })) }, second] });
    await pushSocket('music-video:project:changed', { id: project.id, origin: 'another-tab' });
    await waitFor(() => expect(unusedControl()).toBeNull());
  });

  // The overlap rule still holds: a shot edit whose reply arrives while a take decision runs may predate it.
  it('reloads when a shot edit answers while a take decision is in flight', async () => {
    fakeServer();
    await openShot(/^Open Shot 1/);
    const loaded = reads();
    let answerReject;
    rejectUnusedMusicVideoSceneTakes.mockImplementationOnce(() => new Promise((resolve) => { answerReject = resolve; }));
    let answerDone;
    const saved = updateMusicVideoScene.getMockImplementation();
    updateMusicVideoScene.mockImplementationOnce((...args) => new Promise((resolve) => { answerDone = () => resolve(saved(...args)); }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Done', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject unused (2)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject 2' }));
    await act(async () => answerDone());
    await act(async () => answerReject(await rejectUnusedMusicVideoSceneTakes.getMockImplementation()('mv-2', 's1')));
    // The Done reply may predate the rejection, and the rejection's reply was taken after a Done the board never applied.
    await waitFor(() => expect(reads()).toBeGreaterThan(loaded));
    await waitFor(() => expect(unusedControl()).toBeNull());
    expect(screen.getByRole('checkbox', { name: 'Done', exact: true })).toBeChecked();
  });

  // #16306: the Cast & Sets check re-reads only after an edit that can change it, once, after the reply applied.
  describe('Cast & Sets reads', () => {
    const catalogBoard = {
      ...board,
      castAndSets: { source: 'catalog', status: 'approved' },
      concept: { subjects: [{ id: 'c1', kind: 'character', name: 'Lead', ingredientId: 'ing-1' }] },
      visualSpec: { references: [
        { id: 'r1', imageId: 'mood.png', role: 'character', label: 'Lead', note: '', condition: true },
        { id: 'r2', imageId: 'set.png', role: 'set', label: 'Pier', note: '', condition: false },
      ] },
      scenes: [{ ...first, frameReferenceIds: ['r1', 'r2'] }, second],
    };
    const checkinReads = () => getMusicVideoCastAndSets.mock.calls.length;
    // Past the read's settle window (useCatalogCastSetsCheckin CHECKIN_INPUT_SETTLE_MS), so a read it would send has been sent.
    const pastSettle = () => act(() => new Promise((resolve) => { setTimeout(resolve, 700); }));
    const deferredReply = (mock) => {
      const real = mock.getMockImplementation();
      let answer;
      mock.mockImplementationOnce((...args) => new Promise((resolve) => { answer = () => resolve(real(...args)); }));
      // The take chain starts the request a microtask after the click.
      return async () => {
        await waitFor(() => expect(answer).toBeTypeOf('function'));
        await act(async () => answer());
      };
    };

    // Uniquely catches a take decision or Done re-reading the whole-video check, and Reject unused looking unchanged while it waits.
    it('Reject unused shows it is saving, ignores a second press, and with Done sends no cast and sets read', async () => {
      fakeServer(catalogBoard);
      await openShot(/^Open Shot 1/, catalogBoard);
      await waitFor(() => expect(checkinReads()).toBe(1));
      const answer = deferredReply(rejectUnusedMusicVideoSceneTakes);
      fireEvent.click(screen.getByRole('button', { name: 'Reject unused (2)' }));
      fireEvent.click(screen.getByRole('button', { name: 'Reject 2' }));
      const saving = screen.getByRole('button', { name: 'Rejecting 2 unused takes…' });
      expect(saving).toBeDisabled();
      await waitFor(() => expect(rejectUnusedMusicVideoSceneTakes).toHaveBeenCalledTimes(1));
      fireEvent.click(saving);
      await settle();
      expect(rejectUnusedMusicVideoSceneTakes).toHaveBeenCalledTimes(1);
      await answer();
      await waitFor(() => expect(unusedControl()).toBeNull());
      await markDone();
      await pastSettle();
      expect(checkinReads()).toBe(1);
    });

    it('Use shows the take saving until its reply, and sends no cast and sets read', async () => {
      fakeServer(catalogBoard);
      await openShot(/^Open Shot 1/, catalogBoard);
      await waitFor(() => expect(checkinReads()).toBe(1));
      await showFrames();
      const answer = deferredReply(selectMusicVideoSceneTake);
      const take = () => within(screen.getByRole('list', { name: /Frame takes/ })).getAllByRole('listitem')[1];
      fireEvent.click(within(take()).getByRole('button', { name: /Use/ }));
      expect(within(take()).getByRole('status')).toHaveTextContent('Saving…');
      await answer();
      await waitFor(() => expect(within(take()).queryByRole('status')).toBeNull());
      await pastSettle();
      expect(selectMusicVideoSceneTake).toHaveBeenCalledTimes(1);
      expect(checkinReads()).toBe(1);
    });

    // The clip prompt is text the check reads (a subject it names), so its edit reads once, after the reply.
    it('a clip prompt edit reads the check once, after its reply', async () => {
      fakeServer(catalogBoard);
      await openShot(/^Open Shot 1/, catalogBoard);
      await waitFor(() => expect(checkinReads()).toBe(1));
      const prompt = screen.getByLabelText(/^(Clip|Shot) prompt$/);
      fireEvent.change(prompt, { target: { value: 'Lead waves, at dusk' } });
      fireEvent.blur(prompt);
      await waitFor(() => expect(updateMusicVideoScene).toHaveBeenCalledWith('mv-2', 's1', { prompt: 'Lead waves, at dusk' }, expect.anything()));
      await waitFor(() => expect(checkinReads()).toBe(2));
      await pastSettle();
      expect(checkinReads()).toBe(2);
    });

    it('a reference pick reads the check once', async () => {
      fakeServer(catalogBoard);
      await openShot(/^Open Shot 1/, catalogBoard);
      await waitFor(() => expect(checkinReads()).toBe(1));
      await showFrames();
      fireEvent.click(within(screen.getByRole('group', { name: 'References selected for the frames' })).getByRole('button', { name: "Don't send Pier" }));
      await waitFor(() => expect(updateMusicVideoScene).toHaveBeenCalledWith('mv-2', 's1', { frameReferenceIds: ['r1'] }, expect.anything()));
      await waitFor(() => expect(checkinReads()).toBe(2));
      await pastSettle();
      expect(checkinReads()).toBe(2);
    });

    it('a shot sheet cast change reads the check once', async () => {
      fakeServer(catalogBoard);
      await openShot(/^Open Shot 1/, catalogBoard);
      await waitFor(() => expect(checkinReads()).toBe(1));
      fireEvent.click(within(screen.getByRole('group', { name: 'Who' })).getByRole('button', { name: 'Lead' }));
      await waitFor(() => expect(updateMusicVideoScene).toHaveBeenCalledWith('mv-2', 's1', { shotSheet: expect.objectContaining({ characters: ['Lead'] }) }, expect.anything()));
      await waitFor(() => expect(checkinReads()).toBe(2));
      await pastSettle();
      expect(checkinReads()).toBe(2);
    });

    // Uniquely catches the check or a hidden frame prompt preview starting before the project is on screen.
    it('opening a shot reads the check only once the project shows, and previews no frame prompt while the clip view shows', async () => {
      fakeServer(catalogBoard);
      await asThisTab();
      let answerProject;
      getMusicVideoProject.mockImplementationOnce(() => new Promise((resolve) => { answerProject = () => resolve(catalogBoard); }));
      listMusicVideoProjects.mockResolvedValue([catalogBoard]);
      renderMV('/music-video/mv-2/produce/scene/s1');
      await waitFor(() => expect(getMusicVideoProject).toHaveBeenCalled());
      await pastSettle();
      expect(checkinReads()).toBe(0);
      expect(previewImagePrompt).not.toHaveBeenCalled();
      await act(async () => answerProject());
      await screen.findByRole('heading', { level: 2, name: catalogBoard.name });
      await waitFor(() => expect(checkinReads()).toBe(1));
      await screen.findByRole('group', { name: 'Show' });
      await pastSettle();
      expect(previewImagePrompt).not.toHaveBeenCalled();
      await showFrames();
      await waitFor(() => expect(previewImagePrompt).toHaveBeenCalled());
    });
  });
});
