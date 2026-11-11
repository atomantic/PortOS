import { describe, expect, it } from 'vitest';
import { summarizeMusicVideoProject } from './musicVideoSummary.js';

// Song, Plan and Look done; the stage then rests on the Shots step alone.
const readiness = { art: { approved: true }, storyboard: { approved: true, problems: [] }, alignment: { status: 'instrumental' } };
const film = (blenderShots) => ({
  id: 'mv-test', name: 'Example Film', trackId: 'track-example', audioAnalysis: { durationSec: 6 },
  composition: { mode: 'blender' },
  // Mirrored Board scenes carry no clip and no frame: a footage rule would hold Shots open forever.
  scenes: [{ sceneId: 'mvs-a', startSec: 0, endSec: 6, visualLayer: 'code' }],
  ...(blenderShots ? { blenderShots } : {}),
});

describe('summary stage of a Blender film', () => {
  it('holds the Shots step until every shot has a complete, current final render', () => {
    const stage = (blenderShots) => summarizeMusicVideoProject(film(blenderShots), readiness).stage;
    expect(stage(null)).toBe('produce');
    expect(stage({ total: 0, finalReady: 0 })).toBe('produce');
    expect(stage({ total: 3, finalReady: 2 })).toBe('produce');
    expect(stage({ total: 3, finalReady: 3 })).toBe('review');
  });
});
