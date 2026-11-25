import { describe, it, expect } from 'vitest';
import { codeFirstProductionAssets, musicVideoGenerationAllowance, musicVideoNoVideoMessage, musicVideoToolPolicyConflict, planMusicVideoMedia, summarizeMusicVideoMediumPlan } from './musicVideoMediumPlan.js';
import { musicVideoAllowsMedia } from './musicVideoMediaPolicy.js';

describe('musicVideoGenerationAllowance', () => {
  const policy = { legacy: { strategy: 'legacy' }, cf0: { strategy: 'code-first', maxGeneratedVideoPercent: 0 }, cf20: { strategy: 'code-first', maxGeneratedVideoPercent: 20 } };
  const make = (mediaMode, pol, tools) => ({ ...(mediaMode ? { mediaMode } : {}), productionPolicy: policy[pol], ...(tools ? { automation: { tools } } : {}) });

  // [mediaMode, policy, tools, video, videoPercent, reason, image]
  it.each([
    ['code-images-video', 'legacy', undefined, true, 100, null, true],
    ['code-images-video', 'legacy', [], true, 100, null, true],
    ['code-images-video', 'legacy', ['image:x', 'video:x'], true, 100, null, true],
    ['code-images-video', 'cf20', ['video:x'], true, 20, null, false],
    ['code-images-video', 'cf20', undefined, true, 20, null, true],
    ['code-images-video', 'cf20', ['image:x', 'code:render'], false, 0, 'NO_VIDEO_TOOL', true],
    ['code-images-video', 'cf0', ['image:x', 'video:x'], false, 0, 'ZERO_ALLOWANCE', true],
    ['code-images-video', 'cf0', undefined, false, 0, 'ZERO_ALLOWANCE', true],
    ['code-images', 'legacy', ['video:x'], false, 0, 'MEDIA_MODE', false],
    ['code-images', 'cf20', ['image:x'], false, 0, 'MEDIA_MODE', true],
    ['code-only', 'legacy', undefined, false, 0, 'MEDIA_MODE', false],
    ['code-only', 'cf0', ['video:x', 'image:x'], false, 0, 'MEDIA_MODE', false],
    [undefined, 'cf20', ['image:x', 'video:x'], true, 20, null, true],
    [undefined, 'legacy', ['code:render'], false, 0, 'MEDIA_MODE', false],
  ])('%s + %s + %j answers video %s at %s%% (%s), images %s', (mode, pol, tools, video, videoPercent, reason, image) => {
    expect(musicVideoGenerationAllowance(make(mode, pol, tools))).toMatchObject({ video, videoPercent, reason, image });
  });

  it('keeps every field that rules video out visible, whichever combination was saved', () => {
    for (const mode of [undefined, 'code-only', 'code-images', 'code-images-video']) {
      for (const pol of Object.keys(policy)) {
        for (const tools of [undefined, [], ['image:x'], ['video:x'], ['code:render'], ['image:x', 'video:x'], ['code:render', 'image:x']]) {
          const project = make(mode, pol, tools);
          const a = musicVideoGenerationAllowance(project);
          // Video needs all three fields to agree; the low-level mode check and the tool list are read independently here.
          const named = tools?.length ? tools.some((t) => t.startsWith('video:')) : true;
          expect(a.video).toBe(musicVideoAllowsMedia(project, 'video') && named && (pol === 'legacy' || policy[pol].maxGeneratedVideoPercent > 0));
          expect(a.reason === null).toBe(a.video);
          expect(a.videoPercent === 0).toBe(!a.video);
          expect(a.strategy).toBe(policy[pol].strategy);
        }
      }
    }
  });

  it('leaves the stored fields untouched', () => {
    const project = make('code-images-video', 'cf20', ['image:x']);
    const before = structuredClone(project);
    musicVideoGenerationAllowance(project);
    expect(project).toEqual(before);
  });

  it('words the refusal for the field that ruled video out', () => {
    expect(musicVideoNoVideoMessage(musicVideoGenerationAllowance(make('code-images-video', 'cf0', ['video:x'])))).toMatch(/allows no generated video/);
    expect(musicVideoNoVideoMessage(musicVideoGenerationAllowance(make('code-images-video', 'cf20', ['image:x'])), { remedy: true })).toMatch(/No video tool is selected.*Add a video tool/);
  });
});

describe('brief tools vs production policy', () => {
  const codeFirst = (percent) => ({ strategy: 'code-first', maxGeneratedVideoPercent: percent });

  it('flags a saved pair that plans generated footage with no video tool, and nothing else', () => {
    const noVideo = ['image:codex', 'code:render'];
    // Legacy defaults to 100% generated video; a non-zero code-first allowance also contradicts the tools.
    expect(musicVideoToolPolicyConflict({ automation: { tools: noVideo } })).toMatchObject({ code: 'NO_VIDEO_TOOL' });
    expect(musicVideoToolPolicyConflict({ automation: { tools: noVideo }, productionPolicy: codeFirst(20) })).toMatchObject({ code: 'NO_VIDEO_TOOL' });
    expect(musicVideoToolPolicyConflict({ automation: { tools: noVideo }, productionPolicy: codeFirst(0) })).toBeNull();
    expect(musicVideoToolPolicyConflict({ automation: { tools: ['video:fal'] }, productionPolicy: codeFirst(20) })).toBeNull();
    expect(musicVideoToolPolicyConflict({ productionPolicy: codeFirst(20) })).toBeNull();
  });

  it('flags a media mode that rules out video under a policy that still plans footage, and stays quiet once the policy agrees', () => {
    expect(musicVideoToolPolicyConflict({ mediaMode: 'code-images', productionPolicy: codeFirst(20) })).toMatchObject({ code: 'NO_VIDEO_TOOL' });
    expect(musicVideoToolPolicyConflict({ mediaMode: 'code-images', productionPolicy: codeFirst(0) })).toBeNull();
  });
});

describe('planning agrees with the allowance', () => {
  const project = (tools, percent = 20, mediaMode = 'code-images-video') => ({
    mediaMode, automation: { tools },
    productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: percent },
    audioAnalysis: { durationSec: 100 },
    scenes: [{ sceneId: 's1', startSec: 0, endSec: 10, shotMode: 'cutaway' }],
  });
  const directions = [{ sceneId: 's1', mode: 'cutaway', route: 'generated', medium: 'generated-footage', mediumRationale: 'footage' }];

  it('plans a requested generated shot as code when the brief selected no video tool, and as footage when it can be dispatched', () => {
    expect(planMusicVideoMedia(project(['image:x', 'code:render']), directions)[0].medium).toBe('procedural');
    expect(planMusicVideoMedia(project(['image:x', 'video:x']), directions)[0].medium).toBe('generated-footage');
    expect(planMusicVideoMedia(project(undefined), directions)[0].medium).toBe('generated-footage');
  });

  it('measures the final-edit allowance with the effective percent', () => {
    const noTool = summarizeMusicVideoMediumPlan(project(['image:x']), directions);
    expect(noTool).toMatchObject({ maxGeneratedVideoPercent: 0, allowedGeneratedSec: 0, blocked: true });
    expect(noTool.unresolved.map((u) => u.message)).toContain('Generated footage needs a video tool, but the brief selected none. Change its medium, or add a video tool to the brief.');
    expect(summarizeMusicVideoMediumPlan(project(['video:x']), directions)).toMatchObject({ maxGeneratedVideoPercent: 20, allowedGeneratedSec: 20, blocked: false });
  });
});

describe('footage tools on a code-first project (#10450)', () => {
  const project = (tools, backend) => ({
    automation: { tools },
    productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: 100 },
    videoSettings: { backend },
    audioAnalysis: { durationSec: 20 },
    scenes: [
      { sceneId: 's1', startSec: 0, endSec: 10, shotMode: 'cutaway' },
      { sceneId: 's2', startSec: 10, endSec: 20, shotMode: 'cutaway' },
    ],
  });
  const directions = [{ sceneId: 's1', mode: 'performance', route: 'generated' }, { sceneId: 's2', mode: 'cutaway', route: 'generated' }];

  it('plans generated footage for a brief that selected a video tool, and stays procedural without one', () => {
    expect(planMusicVideoMedia(project(['image:local', 'video:local']), directions).map((d) => d.medium)).toEqual(['generated-footage', 'generated-footage']);
    expect(planMusicVideoMedia(project(['image:local']), directions).map((d) => d.medium)).toEqual(['procedural', 'procedural']);
  });

  it('does not demand a Performance shot mode when the backend has no lip-sync lane', () => {
    const p = project(['video:grok'], 'grok');
    p.treatment = { revision: 1, appliedRevision: 1, shotDirections: planMusicVideoMedia(p, directions).map((d) => ({ ...d, mediumRationale: 'x' })) };
    expect(codeFirstProductionAssets(p).conflicts).toEqual([]);
  });
});

describe('shot sheet camera output', () => {
  const directions = [{ sceneId: 's1', medium: 'procedural', route: 'generated' }];
  const project = {
    productionPolicy: { strategy: 'legacy' },
    cameras: [
      { id: 'vid', name: 'Video', kind: 'observer', output: 'video' },
      { id: 'pic', name: 'Photo', kind: 'observer', output: 'image' },
    ],
    scenes: [{ sceneId: 's1', visualLayer: 'still', shotSheet: { cameraId: 'vid' } }],
  };

  it('lets a video camera beat a still visual layer without pinning the medium', () => {
    const planned = planMusicVideoMedia(project, directions);
    expect(planned[0]).toMatchObject({ medium: 'generated-footage', mediumPinned: false, mediumRationale: 'The shot sheet camera shoots video.' });
    expect(planned[0].fromSheet).toBeUndefined();
  });

  it('keeps a real director pin and replaces only the automatic visual-layer pin', () => {
    const pinned = { ...project, treatment: { shotDirections: [{ sceneId: 's1', medium: 'procedural', mediumPinned: true, mediumRationale: 'The director chose code.' }] } };
    expect(planMusicVideoMedia(pinned, directions)[0]).toMatchObject({ medium: 'procedural', mediumPinned: true, mediumRationale: 'The director chose code.' });
    const automatic = { ...project, treatment: { shotDirections: [{ sceneId: 's1', medium: 'still', mediumPinned: true, mediumRationale: 'Retain the director-selected visual layer.' }] } };
    expect(planMusicVideoMedia(automatic, directions)[0]).toMatchObject({ medium: 'generated-footage', mediumPinned: false });
  });

  it('reuses a selected clip for a video camera and still shoots a photo when a clip is selected', () => {
    const withTake = { ...project, scenes: [{ ...project.scenes[0], videoHistoryId: 'vid-1' }] };
    expect(planMusicVideoMedia(withTake, directions)[0].medium).toBe('existing-footage');
    const photo = { ...project, scenes: [{ sceneId: 's1', visualLayer: 'footage', videoHistoryId: 'vid-1', shotSheet: { cameraId: 'pic' } }] };
    expect(planMusicVideoMedia(photo, directions)[0]).toMatchObject({ medium: 'still', mediumRationale: 'The shot sheet camera shoots photos.' });
  });

  it('does not demote sheet-sourced generated footage to stay inside a code-first allowance', () => {
    const codeFirst = {
      ...project,
      productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: 0 },
      audioAnalysis: { durationSec: 10 },
      scenes: [{ sceneId: 's1', startSec: 0, endSec: 10, visualLayer: 'still', shotSheet: { cameraId: 'vid' } }],
    };
    expect(planMusicVideoMedia(codeFirst, directions)[0].medium).toBe('generated-footage');
  });
});

describe('codeFirstProductionAssets conflicts', () => {
  it('retains each shot id when several shots raise the same medium conflict', () => {
    const scenes = [0, 1, 2].map((i) => ({ sceneId: `s${i}`, startSec: i * 5, endSec: i * 5 + 5, shotMode: 'cutaway' }));
    const shotDirections = scenes.map((s) => ({ sceneId: s.sceneId, mode: 'performance', medium: 'procedural', mediumRationale: 'x' }));
    const p = { productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: 0 }, audioAnalysis: { durationSec: 15 }, scenes,
      treatment: { revision: 1, appliedRevision: 1, shotDirections } };
    expect(codeFirstProductionAssets(p).conflicts).toEqual(scenes.map((scene) => expect.stringMatching(new RegExp(`^${scene.sceneId}: Visible performance is unresolved`))));
  });
});
