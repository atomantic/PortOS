import { describe, expect, it } from 'vitest';
import { buildSceneTimingPresentation } from './musicVideoSceneTiming.js';

const shot = (sceneId, startSec, endSec, extra = {}) => ({
  sceneId, startSec, endSec, visualLayer: 'footage', framePrompt: 'two-shot held', ...extra,
});

const present = (scene, project, extra = {}) => buildSceneTimingPresentation({
  scene, layer: 'footage', lipSyncBackend: 'grok', songDurationSec: 30, falVideoSettings: {},
  nextEndSec: null, isLast: false, manifestOwnsShots: false, hasMergeNext: false, project, ...extra,
});

describe('buildSceneTimingPresentation shared clips', () => {
  it('charges a source-take return nothing and names its window', () => {
    const scenes = [
      shot('a', 0, 6, { label: 'Two-shot', videoHistoryId: 'vh-a' }),
      shot('b', 2, 2.8, { sourceTake: { sceneId: 'a' } }),
    ];
    const timing = present(scenes[1], { scenes, videoSettings: { backend: 'grok' } }, { isLast: true });
    expect(timing.sharedNotice).toBe("Plays Two-shot's take from 2.00s");
    expect(timing.grokPlan).toBeNull();
    expect(timing.falCost).toBeNull();
  });

  it('counts one Grok request for an adjacent run and none for the later shots', () => {
    const scenes = [
      shot('a', 0, 0.8, { coverage: 'sequence' }),
      shot('b', 0.8, 1.6, { coverage: 'sequence' }),
      shot('c', 1.6, 2.4, { coverage: 'sequence' }),
    ];
    const project = { scenes, videoSettings: { backend: 'grok' } };
    const lead = present(scenes[0], project);
    const member = present(scenes[1], project);
    expect(lead.coverageNoun).toBe('run');
    expect(lead.coverageSpan).toBeCloseTo(2.4);
    expect(lead.grokPlan).toMatchObject({ requestSec: 6, needsSplit: false });
    expect(lead.sharedNotice).toBeNull();
    expect(member.sharedNotice).toBe('Included in one 6s sequence request');
    expect(member.grokPlan).toBeNull();
    expect(member.falCost).toBeNull();
  });
});
