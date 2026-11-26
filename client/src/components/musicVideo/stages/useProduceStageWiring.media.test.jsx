/**
 * Media and stage interaction cases from the Music Video page suite for `useProduceStageWiring`.
 * Drives the real page through the shared scaffold in `test/musicVideoPageMocks.jsx`.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
// The scaffold registers the mocks, so it loads before any mocked module.
import {
  PROJECT_WITH_CLIP,
  PROJECT_NO_CLIP,
  pushSocket,
  renderMV,
  settle,
  openSettings,
  closeSettings,
  openStage,
  openProject,
  showFrames,
  installMusicVideoPageHooks,
  editResult,
} from '../../../test/musicVideoPageMocks.jsx';
import { screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import { findEnabledByRole } from '../../../test/enabledBarrier.js';
import toast from '../../ui/Toast';
import { approveMusicVideoFinal, rejectUnusedMusicVideoSceneTakes, measureMusicVideoColorMatch, listMusicVideoProjects, reorderMusicVideoScenes, updateMusicVideoProject, updateMusicVideoScene, splitMusicVideoScene, moveMusicVideoSceneStart, selectMusicVideoSceneTake, reviewMusicVideoSceneTake, getMusicVideoProject, getMusicVideoCastAndSets } from '../../../services/apiMusicVideo.js';
import { generateVideo, getVideoGenModelContext, previewImagePrompt, previewVideoPrompt, } from '../../../services/apiImageVideo.js';
import { finalApprovalPatch } from '../../../../../server/lib/musicVideo/musicVideoFinalApproval.js';
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
    await renderProjectStage(project, 'produce');
    const thumbnails = within(screen.getByLabelText('Storyboard thumbnails'));
    await act(async () => fireEvent.click(thumbnails.getByRole('button', { name })));
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
