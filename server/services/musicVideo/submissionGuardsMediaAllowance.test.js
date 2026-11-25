import { describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ project: null }));
vi.mock('./projects.js', () => ({ getProject: async () => m.project }));

import { musicVideoToolPolicyConflict } from '../../lib/musicVideo/musicVideoMediumPlan.js';
import { applyMusicVideoSubmissionGuards } from './submissionGuards.js';
import { directShots } from './shotPlan.js';

const POLICIES = {
  legacy: { strategy: 'legacy' },
  'code-first 0%': { strategy: 'code-first', maxGeneratedVideoPercent: 0 },
  'code-first 20%': { strategy: 'code-first', maxGeneratedVideoPercent: 20 },
};
const TOOLS = [undefined, ['image:x'], ['video:x'], ['code:render'], ['code:render', 'image:x'], ['image:x', 'video:x']];
const combinations = [];
for (const mediaMode of [undefined, 'code-only', 'code-images', 'code-images-video']) {
  for (const [policyName, productionPolicy] of Object.entries(POLICIES)) {
    for (const tools of TOOLS) combinations.push({ mediaMode, policyName, productionPolicy, tools });
  }
}

const footageShot = { sectionIndex: 0, sectionLabel: 'Verse', startSec: 0, endSec: 3, visualLayer: 'footage', shotMode: 'cutaway', visualIntent: 'a walk' };
const dispatch = async (project) => {
  m.project = project;
  try {
    await applyMusicVideoSubmissionGuards({
      body: { mode: 'image', musicVideo: { projectId: 'p', sceneId: 's1' } }, backend: 'fal', performance: null,
      params: { prompt: 'a walk' }, prepared: {},
    });
    return null;
  } catch (err) {
    return err.code;
  }
};

describe('the shot plan and the dispatch guard answer the same question', () => {
  it.each(combinations)('$mediaMode / $policyName / $tools', async ({ mediaMode, productionPolicy, tools }) => {
    const project = { id: 'p', ...(mediaMode ? { mediaMode } : {}), productionPolicy, ...(tools ? { automation: { tools } } : {}),
      scenes: [{ sceneId: 's1', referenceImageId: 'start.png', prompt: 'a walk' }] };
    const [planned] = directShots([footageShot], project);
    const refusal = await dispatch(project);
    if (productionPolicy.strategy === 'code-first') {
      // A code-first plan keeps a footage shot only for a clip dispatch will accept.
      if (planned.visualLayer === 'footage') expect(refusal).toBeNull();
      else expect(planned.visualLayer).toBe('code');
    } else {
      // Legacy plans keep footage; a refusal there is the mismatch the setup panel names, never a silent one.
      expect(planned.visualLayer).toBe('footage');
      if (refusal) expect(musicVideoToolPolicyConflict(project)).not.toBeNull();
    }
    if (refusal) expect(refusal).toBe('MUSIC_VIDEO_NO_VIDEO_TOOL');
  });

  it('keeps code-first footage with a code overlay when video can be generated', () => {
    const project = { mediaMode: 'code-images-video', productionPolicy: POLICIES['code-first 20%'], automation: { tools: ['image:x', 'video:x'] } };
    expect(directShots([footageShot], project)[0]).toMatchObject({ visualLayer: 'footage', codeOverlay: true });
  });

  it('draws a code-first footage shot in code when the brief names no video tool, whatever the allowance', () => {
    const project = { mediaMode: 'code-images-video', productionPolicy: POLICIES['code-first 20%'], automation: { tools: ['image:x'] } };
    expect(directShots([footageShot], project)[0]).toMatchObject({ visualLayer: 'code', shotMode: 'cutaway' });
  });
});
