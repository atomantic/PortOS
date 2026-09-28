import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureSectionSource } from './codeFrame.js';

const h = vi.hoisted(() => ({ project: null, calls: 0, response: '' }));

vi.mock('../promptRunner.js', () => ({
  assertProvider: () => {},
  resolveProviderAndModel: vi.fn(async ({ providerId, model }) => ({
    provider: { id: providerId || 'stub-provider' },
    selectedModel: model || 'fixture-model',
  })),
  runPromptThroughProvider: vi.fn(async () => {
    h.calls += 1;
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
  h.calls = 0;
  h.response = '';
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
});
