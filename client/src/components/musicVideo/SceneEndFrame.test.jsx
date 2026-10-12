import { describe, expect, it } from 'vitest';
import { sceneEndFramePlanFor } from './SceneEndFrame.jsx';

const scene = { sceneId: 's1', referenceImageId: 'start.png', endImageId: 'end.png', endFramePrompt: 'head thrown back' };
const models = [{ id: 'ltx25_example', runtime: 'ltx25' }, { id: 'fast_example', runtime: 'fastmetal' }];

// Uniquely catches the Render section telling the director a local LTX clip
// ignores the end frame it now renders to (#11258), or promising it on a
// one-frame model, for both a card pick and the install default.
describe('sceneEndFramePlanFor on the local renderer', () => {
  it('uses the end frame on a local LTX pick', () => {
    expect(sceneEndFramePlanFor(scene, { backend: 'local', modelId: 'ltx25_example' }, { models }).used).toBe(true);
  });

  it('falls back to the default local model', () => {
    expect(sceneEndFramePlanFor(scene, { backend: 'local' }, { models, defaultModel: 'ltx25_example' }).used).toBe(true);
  });

  it('warns that a single-frame local model ignores it', () => {
    const plan = sceneEndFramePlanFor(scene, { backend: 'local', modelId: 'fast_example' }, { models });
    expect(plan.used).toBe(false);
    expect(plan.reason).toMatch(/animates from the start frame only/);
  });
});
