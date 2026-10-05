import { describe, it, expect } from 'vitest';
import {
  MUSIC_VIDEO_STAGES, currentProductionRun, deriveNextAction, deriveStages, projectSpend, boardJobEstimate, listPreviewSources, describeProjectStatus, resolveStageParam, stageChecklist, compareMusicVideoProjectsNewestFirst,
} from './musicVideoStages.js';

const APPROVED = { art: { approved: true }, storyboard: { approved: true }, proof: { approved: true }, readyForProduction: true };
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

  it('reflects an autonomous run in the header next action instead of asking to attach a track', () => {
    const autoRunning = { id: 'p', autonomousRun: { status: 'running', stage: 'lyrics', stages: { lyrics: { step: 'draft' } } } };
    expect(deriveNextAction(autoRunning)).toMatchObject({ id: 'busy', label: 'Writing the lyric draft…', disabled: true });

    const autoAwaiting = { id: 'p', autonomousRun: { status: 'awaiting-approval', awaiting: 'lyrics' } };
    expect(deriveNextAction(autoAwaiting)).toMatchObject({ id: 'review-autonomous', kind: 'goto', stage: 'setup', anchor: 'mv-auto-edit', label: 'Review Lyrics' });

    const autoStopped = { id: 'p', autonomousRun: { status: 'stopped' } };
    expect(deriveNextAction(autoStopped)).toMatchObject({ id: 'resume-autonomous', kind: 'run', label: 'Resume autonomous run' });

    const autoFailed = { id: 'p', autonomousRun: { status: 'failed' } };
    expect(deriveNextAction(autoFailed)).toMatchObject({ id: 'retry-autonomous', kind: 'run', label: 'Retry autonomous run' });
  });

  it('a project waiting on Cast & Sets approval offers the approval, and a stopped check-in offers to resume', () => {
    const waiting = { id: 'p', trackId: 't1', audioAnalysis: ANALYSIS, automation: {}, castAndSets: { status: 'review' }, scenes: [] };
    expect(deriveStages(waiting).current).toBe('cast-sets');
    expect(stateOf(waiting)).toMatchObject({ setup: 'done', 'cast-sets': 'active', board: 'todo' });
    expect(deriveNextAction(waiting)).toMatchObject({ id: 'review-production', kind: 'goto', stage: 'cast-sets', shortLabel: 'Art' });

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
    const planned = { productionReadiness: APPROVED, id: 'p', trackId: 't1', audioAnalysis: ANALYSIS, scenes: [scene({ referenceImageId: null, videoHistoryId: null })] };
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

  it('sends a stale final render back to Review with a re-render prompt (#10143)', () => {
    const ready = { audioAnalysis: ANALYSIS, uploadedAudioFilename: 'a.mp3', scenes: [scene()], productionReadiness: APPROVED, renderHistoryId: 'rh-1' };
    const stale = { ...ready, renderDependencyState: { status: 'stale', reasons: ['Selected clip changed'] } };
    expect(deriveStages({ ...ready, renderDependencyState: { status: 'current', reasons: [] } }).current).toBe('publish');
    expect(deriveStages(stale)).toMatchObject({ current: 'review' });
    expect(stateOf(stale).review).toBe('active');
    expect(deriveNextAction(stale)).toMatchObject({ id: 'render-final', label: 'Re-render final video' });
    expect(stageChecklist('review', stale)[0]).toMatchObject({ done: false, detail: 'Final render is out of date — re-render.' });
    expect(describeProjectStatus(stale, { progress: deriveStages(stale) }).facts.find((f) => f.id === 'render'))
      .toMatchObject({ label: 'Final render is out of date — re-render', tone: 'warn' });
  });

  it('counts Publish per enabled platform, done only when each has a post (#10143)', () => {
    const ready = { audioAnalysis: ANALYSIS, uploadedAudioFilename: 'a.mp3', scenes: [scene()], productionReadiness: APPROVED, renderHistoryId: 'rh-1',
      publishKit: { builtAt: '2026-01-01T00:00:00.000Z', master: { renderHistoryId: 'rh-1' }, copyDraftedAt: '2026-01-02T00:00:00.000Z', posts: { youtube: { url: 'https://example.com/v' } } } };
    const targets = [{ target: 'youtube', label: 'YouTube' }, { target: 'x', label: 'X thread' }, { target: 'reddit', label: 'Reddit' }];
    const publish = { targets, drafts: { x: { summary: {} } } };
    expect(deriveStages(ready, undefined, publish).current).toBe('publish');
    expect(stageChecklist('publish', ready, undefined, publish).map((i) => [i.label, i.done])).toEqual([
      ['Kit built from the current render', true], ['Copy drafted', true],
      ['Posted to every enabled platform (1 of 3)', false],
      ['YouTube: posted', true], ['X thread: draft filled', false], ['Reddit: not started', false],
    ]);
    const all = { ...ready, publishKit: { ...ready.publishKit, posts: { youtube: {}, x: {}, reddit: {} } } };
    expect(deriveStages(all, undefined, publish).stages.find((s) => s.id === 'publish').state).toBe('done');
    // A kit built from an older render is not "from the current render".
    expect(stageChecklist('publish', { ...ready, renderHistoryId: 'rh-2' }, undefined, publish)[0].done).toBe(false);
  });

  it('derives Produce and Compose for all five render styles (#10139)', () => {
    const bare = { productionReadiness: APPROVED, id: 'p', trackId: 't1', audioAnalysis: ANALYSIS, scenes: [scene({ referenceImageId: null, videoHistoryId: null })] };
    const withMode = (composition) => ({ ...bare, composition });
    // Footage styles still need footage; composed also needs cues.
    expect(deriveStages(withMode({ mode: 'concat' })).current).toBe('produce');
    expect(deriveStages(withMode({ mode: 'composed', textCues: [] })).current).toBe('produce');
    // Eidoverse: Produce done without footage; Compose waits on a saved scene.
    expect(stateOf(withMode({ mode: 'eidoverse' })).produce).toBe('done');
    expect(deriveStages(withMode({ mode: 'eidoverse' })).current).toBe('compose');
    expect(stageChecklist('produce', withMode({ mode: 'eidoverse' }), APPROVED).map((i) => i.id)).toEqual(['approve-proof']);
    expect(stageChecklist('compose', withMode({ mode: 'eidoverse' }), APPROVED)[1])
      .toMatchObject({ label: 'Save the Eidoverse scene', done: false, action: { anchor: 'mv-eidoverse-scene' } });
    const saved = withMode({ mode: 'eidoverse', eidoverseScene: { inlineScript: 'scene()' } });
    expect(deriveStages(saved).current).toBe('review');
    expect(stageChecklist('compose', saved, APPROVED)[1].done).toBe(true);
    // Code: composed only once generated (or sections exist).
    expect(deriveStages(withMode({ mode: 'code' })).current).toBe('compose');
    expect(stageChecklist('compose', withMode({ mode: 'code' }), APPROVED)[1].done).toBe(false);
    expect(deriveStages(withMode({ mode: 'code', codeVideo: { generatedAt: '2026-01-01T00:00:00.000Z', sections: [] } })).current).toBe('review');
    // Document: composed once the document is attached.
    expect(deriveStages(withMode({ mode: 'document' })).current).toBe('compose');
  });

  it('does not require scene footage for code-rendered or document projects', () => {
    const bare = { productionReadiness: APPROVED, id: 'p', trackId: 't1', audioAnalysis: ANALYSIS, scenes: [scene({ referenceImageId: null, videoHistoryId: null })] };
    expect(stateOf({ ...bare, composition: { mode: 'code' } }).produce).toBe('done');
    const doc = { ...bare, composition: { mode: 'document' } };
    expect(deriveStages(doc).current).toBe('compose');
    expect(deriveNextAction(doc).label).toBe('Attach a composition');
    expect(deriveStages({ ...doc, composition: { mode: 'document', document: { directory: 'd' } } }).current).toBe('review');
  });

  it('requires art review for hands-on projects too', () => {
    expect(stateOf({ id: 'p', trackId: 't1', audioAnalysis: ANALYSIS, scenes: [] })['cast-sets']).toBe('active');
  });
});

it('never promotes placeholder scenes or imported schematic documents to final production', () => {
  const project = { id: 'example', trackId: 'song', audioAnalysis: ANALYSIS, scenes: [scene()], composition: { mode: 'document', document: { directory: 'draft' } } };
  expect(stateOf(project)).toMatchObject({ 'cast-sets': 'active', board: 'todo', produce: 'todo', compose: 'todo' });
  expect(deriveNextAction(project)).toMatchObject({ id: 'review-production', stage: 'cast-sets' });
  const planned = { ...project, productionReadiness: { ...APPROVED, proof: { approved: false }, readyForProduction: false } };
  expect(deriveNextAction(planned)).toMatchObject({ id: 'review-production', stage: 'review' });
});

describe('projectSpend', () => {
  it('sums every run and takes the live run\'s cap, falling back to the brief budget', () => {
    const project = {
      automation: { budgetUsd: 50 },
      productionRuns: [run({ id: 'a', status: 'completed', usage: { spentUsd: 1.25 } }), run({ id: 'b', status: 'running', usage: { spentUsd: 2 }, limits: { spendCapUsd: 10 } })],
    };
    expect(projectSpend(project)).toMatchObject({ spentUsd: 3.25, capUsd: 10, autopilot: 3.25, manual: 0, autoReview: 0 });
    expect(projectSpend({ automation: { budgetUsd: 50 }, productionRuns: [] })).toMatchObject({ spentUsd: 0, capUsd: 50 });
    expect(projectSpend({})).toMatchObject({ spentUsd: 0, capUsd: null });
  });

  it('counts manual and auto-review take estimates beside autopilot spend (#10157)', () => {
    const project = {
      productionRuns: [run({ usage: { spentUsd: 2 } })],
      scenes: [scene({ takes: [
        { takeId: 'a', spendKind: 'manual', costUsd: 0.5 },
        { takeId: 'b', spendKind: 'autoReview', costUsd: 0.25 },
        { takeId: 'c' },
      ] })],
    };
    expect(projectSpend(project)).toMatchObject({ autopilot: 2, manual: 0.5, autoReview: 0.25, total: 2.75, spentUsd: 2.75 });
  });
});

describe('boardJobEstimate', () => {
  it('sizes the generation limit to missing frames and clips plus a 25% allowance', () => {
    const scenes = [scene({ sceneId: 'a', referenceImageId: null, videoHistoryId: null }), scene({ sceneId: 'b', videoHistoryId: null }), scene({ sceneId: 'c' })];
    expect(boardJobEstimate({ scenes })).toMatchObject({ jobs: 3, unpriced: 3, knownUsd: 0, suggestedMaxGenerations: 4 });
    expect(boardJobEstimate({ scenes: [scene()] })).toMatchObject({ jobs: 0, suggestedMaxGenerations: 1 });
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

describe('listPreviewSources', () => {
  it('orders the final render, the composition document, then finished excerpts newest first', () => {
    const excerpts = [
      { id: 'a', status: 'complete', filename: 'a.mp4', startSec: 0, endSec: 10 },
      { id: 'b', status: 'complete', filename: 'b.mp4', startSec: 10, endSec: 20 },
      { id: 'c', status: 'rendering', filename: null },
    ];
    const ids = (project, opts) => listPreviewSources(project, opts).map((source) => source.id);
    expect(ids({ renderHistoryId: 'r1', composition: { mode: 'document', document: { directory: 'd' } }, excerpts }, { finalVideoSrc: '/data/videos/final.mp4' }))
      .toEqual(['final', 'document', 'excerpt:b', 'excerpt:a']);
    // The final render plays only once its file has resolved; a non-document mode has no live composition.
    expect(ids({ renderHistoryId: 'r1', composition: { mode: 'concat', document: { directory: 'd' } }, excerpts })).toEqual(['excerpt:b', 'excerpt:a']);
    // Composing puts the live document ahead of an old final render, and a stale final says so.
    const stale = { renderHistoryId: 'r1', renderDependencyState: { status: 'stale' }, composition: { mode: 'document', document: { directory: 'd' } }, excerpts };
    expect(ids(stale, { finalVideoSrc: '/data/videos/final.mp4', liveFirst: true })).toEqual(['document', 'final', 'excerpt:b', 'excerpt:a']);
    expect(listPreviewSources(stale, { finalVideoSrc: '/data/videos/final.mp4' })[0].label).toBe('Final render (out of date)');
    expect(listPreviewSources({ excerpts: [{ id: 'c', status: 'error' }] })).toEqual([]);
    expect(listPreviewSources({ excerpts })[0]).toMatchObject({ kind: 'video', src: '/data/videos/b.mp4', startSec: 10, endSec: 20 });
  });
});

describe('describeProjectStatus', () => {
  const stages = (current, overrides = {}) => ({
    current,
    stages: MUSIC_VIDEO_STAGES.map((stage) => ({ ...stage, state: overrides[stage.id] || (stage.id === current ? 'active' : 'todo') })),
  });
  const readiness = (art, storyboard, proof) => ({
    art: { approved: art }, storyboard: { approved: storyboard }, proof: { approved: proof }, readyForProduction: proof,
  });

  it('names the stage, flags a pending approval and says nothing has been rendered', () => {
    const status = describeProjectStatus(
      { autonomousRun: { status: 'stopped' }, excerpts: [] },
      { progress: stages('cast-sets', { setup: 'done' }), nextAction: { id: 'review-production' }, readiness: readiness(false, false, false) },
    );
    expect(status.headline).toBe('Stage 2 of 7: Cast & Sets · needs you');
    expect(status.tone).toBe('warn');
    expect(status.facts.map((fact) => fact.label)).toEqual([
      'Approvals: 0 of 3 approved · needs art, storyboard, proof', 'Nothing rendered yet',
    ]);
  });

  it('says why a stopped production run is waiting rather than calling every stop a pause', () => {
    const fact = (status) => describeProjectStatus({ productionRuns: [{ id: 'r1', status }] }, { progress: stages('produce') })
      .facts.find((entry) => entry.id === 'production').label;
    expect(fact('stopped')).toBe('Production paused');
    expect(fact('blocked')).toBe('Production blocked');
    expect(fact('limit-reached')).toBe('Production at its limit');
    expect(fact('needs-replan')).toBe('Production needs a replan');
  });

  it('reports drafts and the final render', () => {
    const drafts = describeProjectStatus({ excerpts: [{ id: 'a', status: 'complete', filename: 'a.mp4' }] }, { progress: stages('review') });
    expect(drafts.headline).toBe('Stage 6 of 7: Review');
    expect(drafts.facts.at(-1).label).toBe('1 draft excerpt, no final render');
    const done = describeProjectStatus({ renderHistoryId: 'r1' }, {
      progress: { current: 'publish', stages: MUSIC_VIDEO_STAGES.map((stage) => ({ ...stage, state: 'done' })) },
      readiness: readiness(true, true, true),
    });
    expect(done.headline).toBe('Published');
    expect(done.facts.map((fact) => fact.label)).toEqual(['Approvals: All 3 approved', 'Final render ready']);
  });

  it('shows detailed autopilot progress and omits approvals during setup without scenes', () => {
    const status = describeProjectStatus(
      { autonomousRun: { status: 'running', stage: 'lyrics', stages: { lyrics: { step: 'draft' } } }, excerpts: [] },
      { progress: stages('setup'), readiness: readiness(false, false, false) },
    );
    expect(status.headline).toBe('Stage 1 of 7: Setup');
    expect(status.facts.map((fact) => fact.label)).toEqual([
      'Autonomous run: writing the lyric draft', 'Nothing rendered yet',
    ]);
  });
});

it('links active draft and proof jobs to their own evidence controls before offering approval', () => {
  const project = { id: 'example', trackId: 'song', audioAnalysis: {}, scenes: [] };
  expect(deriveNextAction(project, { draftActive: true })).toMatchObject({ id: 'draft-progress', anchor: 'mv-draft-excerpts' });
  expect(deriveNextAction(project, { proofActive: true })).toMatchObject({ id: 'proof-progress', anchor: 'mv-review-render' });
  const nextAction = deriveNextAction(project, { draftActive: true });
  expect(describeProjectStatus(project, { progress: deriveStages(project), nextAction })).toMatchObject({ headline: 'Review render in progress', tone: 'muted' });
});

describe('stageChecklist', () => {
  const NOT_APPROVED = {
    art: { approved: false, problems: [] }, storyboard: { approved: false, problems: ['Review and approve the current art direction first.'] },
    proof: { approved: false, problems: [] }, readyForProduction: false,
  };
  const castProject = (over = {}) => ({
    id: 'p', trackId: 't1', audioAnalysis: ANALYSIS, scenes: [],
    devArtifacts: [{ id: 'sheet', title: 'Cast sheet', mimeType: 'text/html' }, { id: 'gone', title: 'Rejected sheet', deleted: true }],
    productionReview: { draft: { cast: 'c', environments: 'e', visualLanguage: 'v', motionLanguage: 'm', guideArtifactId: 'sheet' } },
    ...over,
  });

  it('keeps Cast & Sets open on the art approval, not on a sheet file, and says where to approve it', () => {
    const items = stageChecklist('cast-sets', castProject(), NOT_APPROVED);
    expect(items.map((i) => [i.id, i.done])).toEqual([['direction', true], ['guide', true], ['approve-art', false]]);
    expect(items[1].label).toBe('Visual guide chosen: Cast sheet');
    expect(items[2].detail).toMatch(/Approving a sheet file does not approve the art direction/);
    expect(items[2].action).toEqual({ label: 'Review art direction', anchor: 'mv-review-art' });
    // Its done answer matches the tab's own state, so the checklist and the "needs you" mark agree.
    expect(deriveStages(castProject(), NOT_APPROVED).current).toBe('cast-sets');
    const approved = stageChecklist('cast-sets', castProject(), APPROVED);
    expect(approved.every((i) => i.done)).toBe(true);
    expect(deriveStages(castProject(), APPROVED).stages.find((s) => s.id === 'cast-sets').state).toBe('done');
  });

  it('names what Cast & Sets is missing: unwritten direction, a deleted guide, and the server reason', () => {
    const items = stageChecklist('cast-sets', castProject({
      productionReview: { draft: { cast: 'c', environments: ' ', visualLanguage: '', motionLanguage: 'm', guideArtifactId: 'gone' } },
    }), { ...NOT_APPROVED, art: { approved: false, problems: ['Attach a visual cast/environment sheet from Development artifacts.'] } });
    expect(items[0]).toMatchObject({ done: false, detail: 'Still missing: sets, visual language.' });
    expect(items[1]).toMatchObject({ done: false, label: 'Visual guide chosen' });
    expect(items[2].detail).toBe('Attach a visual cast/environment sheet from Development artifacts.');
  });

  it('covers Setup, Board, Produce and Compose with the same done answers deriveStages uses', () => {
    expect(stageChecklist('setup', { id: 'p' }).map((i) => i.done)).toEqual([false, false]);
    expect(stageChecklist('setup', { id: 'p' })[0].action).toEqual({ label: 'Attach a track', anchor: 'mv-track' });
    // A running autonomous run writes the song itself, so there is nothing to attach.
    expect(stageChecklist('setup', { id: 'p', autonomousRun: { status: 'running' } })[0]).toMatchObject({ action: null, detail: 'The autonomous run is making the song.' });
    expect(stageChecklist('board', castProject({ scenes: [scene()] }), NOT_APPROVED).map((i) => [i.id, i.done]))
      .toEqual([['shots', true], ['approve-storyboard', false]]);
    expect(stageChecklist('produce', castProject({ scenes: [scene(), scene({ sceneId: 's2', videoHistoryId: null })] }), APPROVED)[0])
      .toMatchObject({ id: 'footage', label: 'Footage for every shot (1 of 2)', done: false });
    // A code render draws its own picture: no footage item.
    expect(stageChecklist('produce', castProject({ composition: { mode: 'code' } }), APPROVED).map((i) => i.id)).toEqual(['approve-proof']);
    expect(stageChecklist('compose', castProject({ composition: { mode: 'composed', textCues: [] } }), APPROVED).map((i) => i.done)).toEqual([true, false]);
  });
});

describe('compareMusicVideoProjectsNewestFirst', () => {
  it('sorts projects by createdAt descending so newest is first', () => {
    const p1 = { id: 'p1', createdAt: '2026-09-01T00:00:00.000Z' };
    const p2 = { id: 'p2', createdAt: '2026-10-01T00:00:00.000Z' };
    const p3 = { id: 'p3', createdAt: '2026-09-15T00:00:00.000Z' };
    const sorted = [p1, p2, p3].sort(compareMusicVideoProjectsNewestFirst);
    expect(sorted.map((p) => p.id)).toEqual(['p2', 'p3', 'p1']);
  });

  it('falls back to updatedAt descending when createdAt is absent or identical', () => {
    const p1 = { id: 'p1', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' };
    const p2 = { id: 'p2', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z' };
    const pNoCreated = { id: 'p3', updatedAt: '2026-09-03T00:00:00.000Z' };
    const sorted = [p1, p2, pNoCreated].sort(compareMusicVideoProjectsNewestFirst);
    expect(sorted.map((p) => p.id)).toEqual(['p3', 'p2', 'p1']);
  });

  it('preserves order when neither project has timestamps', () => {
    const p1 = { id: 'p1', name: 'First' };
    const p2 = { id: 'p2', name: 'Second' };
    const sorted = [p1, p2].sort(compareMusicVideoProjectsNewestFirst);
    expect(sorted.map((p) => p.id)).toEqual(['p1', 'p2']);
  });
});
