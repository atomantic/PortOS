import { describe, expect, it } from 'vitest';
import { summarizeMusicVideoProject } from '../../../server/lib/musicVideo/musicVideoSummary.js';
import { deriveStages } from './musicVideoStageProgress.js';

const readiness = { art: { approved: true }, storyboard: { approved: true, problems: [], problemItems: [] }, alignment: { status: 'instrumental' } };
// A ready scene (still + clip) and one with a clip; `shotSheet.checked` marks a shot Done on the sheet.
const scene = (id, extra = {}) => ({ sceneId: id, startSec: 0, endSec: 3, videoHistoryId: `vid-${id}`, referenceImageId: `img-${id}`, ...extra });
const base = (extra = {}) => ({
  id: 'mv-test', name: 'Example', trackId: 'track-example', audioAnalysis: { durationSec: 6 }, scenes: [scene('a')], ...extra,
});

const both = (project) => ({
  card: summarizeMusicVideoProject(project, readiness).stage,
  detail: deriveStages(project, readiness).current,
});

describe('card and detail agree on the current stage', () => {
  it('holds Shots while a shot is unchecked on the sheet', () => {
    const project = base({ scenes: [scene('a', { shotSheet: { checked: true } }), scene('b', { shotSheet: { checked: false } })] });
    expect(both(project)).toEqual({ card: 'produce', detail: 'produce' });
  });

  it('moves on from a stopped run once its shots are all done', () => {
    const project = base({ productionRuns: [{ id: 'run-1', status: 'stopped' }] });
    expect(both(project)).toEqual({ card: 'review', detail: 'review' });
  });

  it('keeps Shots for a resumable Awaiting video run followed by a completed one', () => {
    const project = base({
      scenes: [scene('a', { videoHistoryId: null })],
      productionRuns: [{ id: 'run-1', status: 'awaiting-video' }, { id: 'run-2', status: 'complete' }],
    });
    expect(both(project)).toEqual({ card: 'produce', detail: 'produce' });
  });
});
