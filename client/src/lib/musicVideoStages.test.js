import { describe, it, expect } from 'vitest';
import {
  MUSIC_VIDEO_STAGES, currentProductionRun, deriveNextAction, deriveStages, projectSpend, resolvePreviewSource, resolveStageParam,
} from './musicVideoStages.js';

const ANALYSIS = { bpm: 120, durationSec: 30, sections: [] };
const scene = (over = {}) => ({ sceneId: 's1', order: 0, prompt: 'a', referenceImageId: 'img', videoHistoryId: 'vid', ...over });
const run = (over = {}) => ({
  id: 'run-1', status: 'running', interrupted: false, limits: { maxGenerations: 12, spendCapUsd: 20 }, usage: { generations: 3, spentUsd: 4.5 }, ...over,
});
const stateOf = (project) => Object.fromEntries(deriveStages(project).stages.map((s) => [s.id, s.state]));

describe('deriveStages / deriveNextAction', () => {
  it('a fresh autopilot project starts at Setup and offers to run autopilot once a track is attached', () => {
    const fresh = { id: 'p', trackId: 't1', automation: { tools: [] }, scenes: [] };
    expect(deriveStages(fresh).current).toBe('setup');
    expect(deriveNextAction(fresh)).toMatchObject({ id: 'kickoff', kind: 'run', disabled: false });
    // With the autopilot blocked (e.g. unsaved creative setup) the action stays visible but disabled, with the reason.
    expect(deriveNextAction(fresh, { kickoffBlockedReason: 'Save the creative setup first.' }))
      .toMatchObject({ id: 'kickoff', disabled: true, reason: 'Save the creative setup first.' });
    // No track: the only useful step is attaching one.
    expect(deriveNextAction({ ...fresh, trackId: null })).toMatchObject({ id: 'goto-setup', kind: 'goto', stage: 'setup' });
    // A hands-on project (no brief) analyzes the song.
    expect(deriveNextAction({ id: 'p', trackId: 't1', scenes: [] })).toMatchObject({ id: 'analyze' });
  });

  it('a project waiting on Cast & Sets approval offers the approval, and a stopped check-in offers to resume', () => {
    const waiting = { id: 'p', trackId: 't1', audioAnalysis: ANALYSIS, automation: {}, castAndSets: { status: 'review' }, scenes: [] };
    expect(deriveStages(waiting).current).toBe('cast-sets');
    expect(stateOf(waiting)).toMatchObject({ setup: 'done', 'cast-sets': 'active', board: 'todo' });
    expect(deriveNextAction(waiting)).toMatchObject({ id: 'approve-cast-sets', kind: 'run' });

    const interrupted = { ...waiting, castAndSets: { status: 'imaging', interrupted: true } };
    expect(stateOf(interrupted)['cast-sets']).toBe('blocked');
    expect(deriveNextAction(interrupted)).toMatchObject({ id: 'resume-cast-sets' });

    const working = { ...waiting, castAndSets: { status: 'imaging' } };
    expect(deriveNextAction(working)).toMatchObject({ id: 'busy', disabled: true });
  });

  it('a live production run owns the project: stop while it runs, resume once it is paused or needs a new basis', () => {
    // Nothing else is done yet — the run still pins the header to Produce.
    const running = { id: 'p', trackId: 't1', scenes: [], productionRuns: [run()] };
    expect(deriveStages(running).current).toBe('produce');
    expect(stateOf(running).produce).toBe('active');
    expect(deriveNextAction(running)).toMatchObject({ id: 'stop-production', runId: 'run-1' });

    const paused = { ...running, productionRuns: [run({ status: 'stopped' })] };
    expect(deriveNextAction(paused)).toMatchObject({ id: 'resume-production', acceptBasis: false });
    const replan = { ...running, productionRuns: [run({ status: 'needs-replan' })] };
    expect(deriveNextAction(replan)).toMatchObject({ id: 'resume-production', acceptBasis: true });
    const interrupted = { ...running, productionRuns: [run({ interrupted: true })] };
    expect(deriveNextAction(interrupted)).toMatchObject({ id: 'resume-production' });
  });

  it('walks Board → Produce → Compose → Review, then reports a finished project', () => {
    const planned = { id: 'p', trackId: 't1', audioAnalysis: ANALYSIS, scenes: [scene({ referenceImageId: null, videoHistoryId: null })] };
    expect(deriveStages(planned).current).toBe('produce');
    expect(deriveNextAction(planned)).toMatchObject({ id: 'goto-produce', kind: 'goto', stage: 'produce' });

    const ready = { ...planned, scenes: [scene()] };
    expect(deriveStages(ready).current).toBe('review');
    expect(deriveNextAction(ready)).toMatchObject({ id: 'render-final', kind: 'run', disabled: false });
    expect(deriveNextAction(ready, { renderBlockedByOther: true })).toMatchObject({ id: 'render-final', disabled: true });
    expect(deriveNextAction(ready, { renderActive: true, renderProgress: 41.6 })).toMatchObject({ id: 'render-progress', disabled: true, label: 'Rendering… 42%' });

    // A composed render needs its text cues before it is ready to render.
    const composed = { ...ready, composition: { mode: 'composed', textCues: [] } };
    expect(deriveStages(composed).current).toBe('compose');
    expect(deriveNextAction(composed)).toMatchObject({ id: 'goto-compose', stage: 'compose' });

    const finished = { ...ready, renderHistoryId: 'rh-1' };
    expect(stateOf(finished)).toMatchObject({ setup: 'done', board: 'done', produce: 'done', compose: 'done', review: 'done', publish: 'active' });
    // #9281: a rendered project moves on to the release.
    expect(deriveNextAction(finished)).toMatchObject({ id: 'goto-publish', kind: 'goto', stage: 'publish', label: 'Build the publishing kit' });
    expect(deriveNextAction({ ...finished, publishKit: { builtAt: '2026-01-01T00:00:00.000Z' } })).toMatchObject({ label: 'Publish the release' });
    expect(stateOf({ ...finished, publishKit: { posts: { youtube: { url: 'https://example.com/v' } } } }).publish).toBe('done');
  });

  it('does not require scene footage for code-rendered or document projects', () => {
    const bare = { id: 'p', trackId: 't1', audioAnalysis: ANALYSIS, scenes: [scene({ referenceImageId: null, videoHistoryId: null })] };
    expect(stateOf({ ...bare, composition: { mode: 'code' } }).produce).toBe('done');
    const doc = { ...bare, composition: { mode: 'document' } };
    expect(deriveStages(doc).current).toBe('compose');
    expect(deriveNextAction(doc).label).toBe('Attach a composition');
    expect(deriveStages({ ...doc, composition: { mode: 'document', document: { directory: 'd' } } }).current).toBe('review');
  });

  it('treats the check-in as not applicable to a hands-on project', () => {
    expect(stateOf({ id: 'p', trackId: 't1', audioAnalysis: ANALYSIS, scenes: [] })['cast-sets']).toBe('done');
  });
});

describe('projectSpend', () => {
  it('sums every run and takes the live run\'s cap, falling back to the brief budget', () => {
    const project = {
      automation: { budgetUsd: 50 },
      productionRuns: [run({ id: 'a', status: 'completed', usage: { spentUsd: 1.25 } }), run({ id: 'b', status: 'running', usage: { spentUsd: 2 }, limits: { spendCapUsd: 10 } })],
    };
    expect(projectSpend(project)).toEqual({ spentUsd: 3.25, capUsd: 10 });
    expect(projectSpend({ automation: { budgetUsd: 50 }, productionRuns: [] })).toEqual({ spentUsd: 0, capUsd: 50 });
    expect(projectSpend({})).toEqual({ spentUsd: 0, capUsd: null });
  });
});

describe('stage route param', () => {
  it('accepts a known stage and rejects anything else so the page can fall back to the default', () => {
    for (const stage of MUSIC_VIDEO_STAGES) expect(resolveStageParam(stage.id)).toBe(stage.id);
    expect(resolveStageParam('dev')).toBeNull();
    expect(resolveStageParam(undefined)).toBeNull();
  });

  it('picks the live run over an older completed one', () => {
    expect(currentProductionRun({ productionRuns: [run({ id: 'live' }), run({ id: 'done', status: 'completed' })] }).id).toBe('live');
    expect(currentProductionRun({})).toBeNull();
  });
});

describe('resolvePreviewSource', () => {
  it('prefers the composition document, then the newest finished excerpt, then nothing', () => {
    const excerpts = [
      { id: 'a', status: 'complete', filename: 'a.mp4', startSec: 0, endSec: 10 },
      { id: 'b', status: 'complete', filename: 'b.mp4', startSec: 10, endSec: 20 },
      { id: 'c', status: 'rendering', filename: null },
    ];
    expect(resolvePreviewSource({ composition: { mode: 'document', document: { directory: 'd' } }, excerpts })).toEqual({ kind: 'document' });
    expect(resolvePreviewSource({ composition: { mode: 'document' }, excerpts }).excerpt.id).toBe('b');
    expect(resolvePreviewSource({ composition: { mode: 'concat', document: { directory: 'd' } }, excerpts }).kind).toBe('excerpt');
    expect(resolvePreviewSource({ excerpts: [{ id: 'c', status: 'error' }] })).toBeNull();
  });
});
