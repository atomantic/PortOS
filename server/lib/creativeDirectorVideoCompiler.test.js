import { describe, it, expect } from 'vitest';
import { compileVideoArtifact, validateVideoShot } from './creativeDirectorVideoCompiler.js';

const project = (over = {}) => ({
  id: 'example-video', aspectRatio: '16:9', targetDurationSeconds: 10,
  renderBackend: { video: { mode: 'gemini' } }, ...over,
});
const shot = (over = {}) => ({ sceneId: 'opening', order: 0, prompt: 'An example lighthouse', durationSeconds: 10, ...over });
const refusal = (run) => {
  try { run(); } catch (err) { return err; }
  return null;
};

// A Video treatment is checked against its pinned backend when it is saved, so the writer
// reads the reason in the 4xx and revises, instead of the run pausing at its first render.
describe('Gemini shot compatibility', () => {
  it('compiles a treatment Gemini can render, in either of its two canvases', () => {
    for (const aspectRatio of ['16:9', '9:16']) {
      expect(compileVideoArtifact(project({ aspectRatio }), { script: 'Example script', scenes: [shot({ negativePrompt: '' })] }))
        .toMatchObject({ aspectRatio, shots: [{ sceneId: 'opening', durationSeconds: 10 }] });
    }
  });

  it('refuses a shot with a negative prompt, naming what to do instead', () => {
    const err = refusal(() => compileVideoArtifact(project(), { script: 'Example script', scenes: [shot({ negativePrompt: 'fog, crowds' })] }));
    expect(err).toMatchObject({ code: 'VIDEO_BACKEND_INPUT_UNSUPPORTED', status: 400 });
    expect(err.message).toContain('negative prompt (Gemini takes none; state exclusions in the prompt)');
  });

  it('refuses a square production', () => {
    const err = refusal(() => validateVideoShot(project({ aspectRatio: '1:1' }), shot(), true));
    expect(err?.code).toBe('VIDEO_BACKEND_INPUT_UNSUPPORTED');
    expect(err.message).toContain('aspect ratio (Gemini renders 16:9 or 9:16)');
  });

  it('applies neither rule to a backend that takes both', () => {
    expect(() => validateVideoShot(project({ aspectRatio: '1:1', renderBackend: { video: { mode: 'fal' } } }), shot({ negativePrompt: 'fog' }), true))
      .not.toThrow();
  });
});
