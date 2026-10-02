// Creative approval behavior is covered through production review routes and orchestration.
vi.mock('./productionReview.js', async (load) => ({ ...await load(), assertProductionApproval: vi.fn() }));
import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixtureSectionSource = (color) => `function render(ctx, env) {\n  ctx.fillStyle = ${JSON.stringify(color)};\n  ctx.fillRect(env.safe.x, env.safe.y, 12 + (env.frame % 3), 12);\n}`;

const h = vi.hoisted(() => ({ project: null, calls: 0, response: '', prompts: [], beforeExecute: null }));

vi.mock('../promptRunner.js', () => ({
  assertProvider: () => {},
  resolveProviderAndModel: vi.fn(async ({ providerId, model }) => ({
    provider: { id: providerId || 'stub-provider' },
    selectedModel: model || 'fixture-model',
  })),
  runPromptThroughProvider: vi.fn(async ({ prompt, beforeExecute }) => {
    await h.beforeExecute?.();
    await beforeExecute?.({ provider: { id: 'stub-provider' }, model: 'fixture-model' });
    h.calls += 1;
    h.prompts.push(prompt);
    return { text: h.response };
  }),
}));

vi.mock('./projects.js', () => ({
  getProject: vi.fn(async () => h.project),
  mutateProjectRecord: vi.fn(async (_id, transform) => transform(h.project)),
}));

const { generateMusicVideoCode, regenerateMusicVideoCodeSection } = await import('./codeGeneration.js');
const { buildMusicVideoCodePrompt } = await import('../codeAnimation/prompt.js');

const base = () => ({
  id: 'mv-code',
  name: 'Click track',
  concept: { universeId: null },
  audioAnalysis: {
    durationSec: 2,
    beats: [0, 0.5, 1, 1.5],
    downbeats: [0, 1],
    sections: [
      { id: 'a', label: 'Verse', startSec: 0, endSec: 1 },
      { id: 'b', label: 'Chorus', startSec: 1, endSec: 2 },
    ],
  },
  lyricCues: [{ id: 'l1', text: 'hello', startSec: 0.2, endSec: 0.8 }],
  scenes: [{ sceneId: 's1', startSec: 0, endSec: 2 }],
  composition: {
    mode: 'code',
    textCues: [{ id: 'c1', text: 'kept', startSec: 0, endSec: 1 }],
    codeVideo: { sections: [
      { id: 'a', source: fixtureSectionSource('#111111') },
      { id: 'b', source: fixtureSectionSource('#222222') },
    ] },
  },
});

beforeEach(() => {
  h.project = base();
  h.beforeExecute = null;
  h.calls = 0;
  h.response = '';
  h.prompts = [];
});

describe('music video code generation (#9076)', () => {
  it('does not call a provider until generate runs, and names the model it used', async () => {
    expect(h.calls).toBe(0);
    const prompt = buildMusicVideoCodePrompt({
      title: 'Click',
      palette: { background: '#111111', ink: '#ffffff', accent: '#ffaa00', font: 'sans' },
      song: { durationSec: 2, fps: 24, sections: [{ id: 'a', label: 'Verse', startSec: 0, endSec: 2, lyric: 'hello' }], lyrics: [], beats: [0], downbeats: [0] },
    });
    expect(prompt).toContain('song.json');
    expect(prompt).toContain('0.4');
    expect(prompt).toContain('env.frame');
    expect(prompt).toContain('startSec');
    expect(h.calls).toBe(0);

    h.response = JSON.stringify({ sections: [
      { id: 'a', source: fixtureSectionSource('#333333') },
      { id: 'b', source: fixtureSectionSource('#444444') },
    ] });
    const result = await generateMusicVideoCode('mv-code', { providerId: 'stub-provider', model: 'fixture-model' });
    expect(h.calls).toBe(1);
    expect(result.providerId).toBe('stub-provider');
    expect(result.model).toBe('fixture-model');
    expect(result.project.composition.textCues.map((cue) => cue.text)).toEqual(['kept']);
    expect(result.project.scenes).toEqual(base().scenes);
  });

  it('regenerating one section keeps the other section source', async () => {
    const next = fixtureSectionSource('#00ff00');
    h.response = JSON.stringify({ sections: [
      { id: 'a', source: next },
      { id: 'b', source: fixtureSectionSource('#ffffff') },
    ] });
    const result = await regenerateMusicVideoCodeSection('mv-code', 'a', { providerId: 'stub-provider', model: 'fixture-model' });
    const stored = Object.fromEntries(result.project.composition.codeVideo.sections.map((section) => [section.id, section.source]));
    expect(stored.a).toBe(next);
    expect(stored.b).toBe(fixtureSectionSource('#222222'));
    expect(h.calls).toBe(1);
  });

  describe('approved procedural Cast & Sets direction', () => {
    const direction = () => ({
      medium: 'procedural',
      protagonist: { name: 'Boat', description: 'a folded paper boat', construction: 'three triangles hinged at the keel', palette: '#f5f0e6, #ff5a1f', movement: 'bobs on every beat' },
      world: { layout: 'a river through stacked streets', camera: 'slow dolly with a beat-synced push', transitions: 'wipe through reflections' },
      sets: [{ id: 'river', name: 'River', description: 'a neon river', lighting: 'magenta', imageRole: 'background' }],
      definitions: { characters: [{
        id: 'boat', name: 'Boat', renderer: 'svg', palette: [{ name: 'cream', hex: '#f5f0e6' }],
        parts: [{ id: 'hull', shape: 'rect', x: 40, y: 100, width: 120, height: 40, fill: 'cream' }],
        expressions: [{ name: 'proud', overrides: { hull: { rotate: -4 } } }], poses: [],
        motion: [{ name: 'Bob', target: 'hull', property: 'translateY', amplitude: 4, periodBeats: 1, easing: 'ease-in-out', trigger: 'beat' }],
      }] },
    });
    const response = () => JSON.stringify({ sections: [{ id: 'a', source: fixtureSectionSource('#555555') }, { id: 'b', source: fixtureSectionSource('#666666') }] });

    it('sends the approved definitions and motion/camera rules with both the full and the one-section request', async () => {
      h.project = { ...base(), productionReview: { draft: { motionLanguage: 'Energy: playful. 0–1s unfold on the downbeat; 1–2s expand the chorus gesture.', implementationPlan: 'Hinge the paper limbs; arc the camera analytically.' } }, castAndSets: { status: 'approved', direction: direction() } };
      h.response = response();
      await generateMusicVideoCode('mv-code', { providerId: 'stub-provider' });
      await regenerateMusicVideoCodeSection('mv-code', 'a', { providerId: 'stub-provider' });
      expect(h.prompts).toHaveLength(2);
      for (const prompt of h.prompts) {
        expect(prompt).toContain(h.project.productionReview.draft.motionLanguage);
        expect(prompt).toContain(h.project.productionReview.draft.implementationPlan);
        expect(prompt).toContain('APPROVED CAST & SETS DEFINITIONS AND RULES');
        expect(prompt).toContain('camera: slow dolly with a beat-synced push');
        expect(prompt).toContain('movement: bobs on every beat');
        expect(prompt).toContain('"parts":[{"id":"hull","shape":"rect"');
        expect(prompt).toContain('"motion":[{"name":"Bob"');
      }
    });

    it('does not send an unapproved, skipped or photographic direction to the code author', async () => {
      h.response = response();
      for (const castAndSets of [
        { status: 'review', direction: direction() },
        { status: 'skipped', direction: direction() },
        { status: 'approved', direction: { ...direction(), medium: undefined } },
      ]) {
        h.project = { ...base(), castAndSets };
        await generateMusicVideoCode('mv-code', { providerId: 'stub-provider' });
      }
      expect(h.prompts).toHaveLength(3);
      for (const prompt of h.prompts) expect(prompt).not.toContain('APPROVED CAST & SETS');
    });
  });
});


it('refuses standalone authoring when a lyric changes during provider preparation, before spending', async () => {
  h.beforeExecute = () => {
    h.project = { ...h.project, lyricCues: [{ ...h.project.lyricCues[0], text: 'changed lyric' }] };
  };
  await expect(generateMusicVideoCode('mv-code')).rejects.toMatchObject({ code: 'MUSIC_VIDEO_REVIEW_STALE' });
  expect(h.calls).toBe(0);
});
