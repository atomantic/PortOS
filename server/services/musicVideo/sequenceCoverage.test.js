import { describe, it, expect } from 'vitest';
import { previewSequenceCoverage } from './sequenceCoverage.js';

const scene = (sceneId, startSec, endSec, extra = {}) => ({
  sceneId, sectionIndex: 0, coverage: 'sequence', startSec, endSec, shotMode: 'cutaway', visualLayer: 'footage',
  set: { id: 'attic' }, protagonist: 'mara', prompt: `shot ${sceneId}`, referenceImageId: `${sceneId}.png`, ...extra,
});
const project = (scenes, falModelId = 'minimax/h3-max/reference-to-video') => ({ videoSettings: { backend: 'fal', falModelId }, scenes });

describe('previewSequenceCoverage', () => {
  it('shows a three-shot section as one H3 request with expansion disabled and three clip spans; the performance shot stays out', () => {
    const preview = previewSequenceCoverage(project([
      scene('a', 0, 4), scene('b', 4, 8), scene('c', 8, 12), scene('p', 12, 18, { shotMode: 'performance' }),
    ]));
    expect(preview.groups).toHaveLength(1);
    const [group] = preview.groups;
    expect(group.prompt).toBe('0-4s: Image 1. shot a\n4-8s: Image 2. shot b\n8-12s: Image 3. shot c');
    expect(group.request.body).toMatchObject({ prompt: group.prompt, prompt_expansion_mode: 'disabled', duration: 12 });
    expect(group.request.promptAdditions).toEqual([expect.objectContaining({ id: 'prompt-expansion', text: expect.stringMatching(/disabled/) })]);
    expect(group.spans.map((s) => [s.clipStartSec, s.clipEndSec])).toEqual([[0, 4], [4, 8], [8, 12]]);
    expect(preview.perShot).toEqual([expect.objectContaining({ sceneId: 'p', reason: expect.stringMatching(/performance/) })]);
  });

  it('keeps a section longer than the model max per-shot', () => {
    const preview = previewSequenceCoverage(project([scene('a', 0, 9), scene('b', 9, 18)]));
    expect(preview.groups).toEqual([]);
    expect(preview.perShot).toHaveLength(2);
  });
});
