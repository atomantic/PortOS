import { describe, it, expect } from 'vitest';
import { summarizeMusicVideoProject } from '../../../server/lib/musicVideoSummary.js';
import {
  MUSIC_VIDEO_STAGES, currentProductionRun, deriveNextAction, deriveStages, projectSpend, boardJobEstimate, listPreviewSources, describeProjectStatus, resolveStageParam, stageChecklist, stepNotes, autopilotStatus, compareMusicVideoProjectsNewestFirst,
} from './musicVideoStages.js';

const APPROVED = { art: { approved: true }, storyboard: { approved: true }, proof: { approved: true }, readyForProduction: true };
const ANALYSIS = { bpm: 120, durationSec: 30, sections: [] };
// Setup is done only once lyrics are in and their timing is verified (or the song is instrumental).
const LYRICS = { lyricCues: [{ id: 'l1', text: 'la la' }], productionReview: { draft: { timingStatus: 'verified' } } };
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

  it('sends an analyzed song to its lyrics, then to verifying their timing, instead of re-analyzing (#10305 review)', () => {
    const analyzed = { id: 'p', trackId: 't1', audioAnalysis: ANALYSIS, scenes: [] };
    expect(deriveStages(analyzed).current).toBe('setup');
    expect(deriveNextAction(analyzed)).toMatchObject({ id: 'import-lyrics', kind: 'goto', stage: 'setup', anchor: 'mv-lyrics-import' });
    const unverified = { ...analyzed, lyricCues: [{ id: 'l1', text: 'la la' }] };
    expect(deriveNextAction(unverified)).toMatchObject({ id: 'verify-timing', kind: 'goto', stage: 'setup', anchor: 'mv-lyric-timing', label: 'Verify lyric timing' });
    expect(deriveNextAction({ ...analyzed, audioAnalysis: null })).toMatchObject({ id: 'analyze' });
  });

  it('reflects an autonomous run in the header next action instead of asking to attach a track', () => {
    const autoRunning = { id: 'p', autonomousRun: { status: 'running', stage: 'lyrics', stages: { lyrics: { step: 'draft' } } } };
    expect(deriveNextAction(autoRunning)).toMatchObject({ id: 'busy', label: 'Writing the lyric draft…', disabled: true });

    const autoAwaiting = { id: 'p', autonomousRun: { status: 'awaiting-approval', awaiting: 'lyrics' } };
    expect(deriveNextAction(autoAwaiting)).toMatchObject({ id: 'review-autonomous', kind: 'open', label: 'Review Lyrics' });

    const autoStopped = { id: 'p', autonomousRun: { status: 'stopped' } };
    expect(deriveNextAction(autoStopped)).toMatchObject({ id: 'resume-autonomous', kind: 'run', label: 'Resume autonomous run' });

    const autoFailed = { id: 'p', autonomousRun: { status: 'failed' } };
    expect(deriveNextAction(autoFailed)).toMatchObject({ id: 'retry-autonomous', kind: 'run', label: 'Retry autonomous run' });
  });

  it('a project waiting on Cast & Sets approval offers the approval, a stopped check-in offers to resume, and no check-in offers to start', () => {
    const waiting = { id: 'p', trackId: 't1', audioAnalysis: ANALYSIS, ...LYRICS, automation: {}, castAndSets: { status: 'review' }, scenes: [] };
    expect(deriveStages(waiting).current).toBe('cast-sets');
    expect(stateOf(waiting)).toMatchObject({ setup: 'done', 'cast-sets': 'active', board: 'todo' });
    expect(deriveNextAction(waiting)).toMatchObject({ id: 'approve-cast-sets', kind: 'run' });

    const notStarted = { ...waiting, castAndSets: null };
    expect(deriveNextAction(notStarted)).toMatchObject({ id: 'kickoff' });
    expect(deriveNextAction({ ...notStarted, automation: undefined })).toMatchObject({ id: 'start-cast-sets', kind: 'run', disabled: false });

    const unplanned = { ...waiting, castAndSets: { status: 'approved' }, productionReadiness: { art: { approved: true }, storyboard: { approved: false }, proof: { approved: false }, readyForProduction: false } };
    expect(deriveNextAction(unplanned)).toMatchObject({ id: 'plan' });
    expect(deriveNextAction({ ...unplanned, scenes: [{ id: 's1' }] })).toMatchObject({ id: 'review-production', stage: 'board' });

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

  it('walks Storyboard → Make → Final render, then reports a finished project', () => {
    const planned = { productionReadiness: APPROVED, id: 'p', trackId: 't1', audioAnalysis: ANALYSIS, scenes: [scene({ referenceImageId: null, videoHistoryId: null })] };
    expect(deriveStages(planned).current).toBe('produce');
    expect(deriveNextAction(planned)).toMatchObject({ id: 'goto-produce', kind: 'goto', stage: 'produce', anchor: 'mv-generation', label: 'Make the footage' });

    const ready = { ...planned, scenes: [scene()] };
    expect(deriveStages(ready).current).toBe('review');
    expect(deriveNextAction(ready)).toMatchObject({ id: 'render-final', kind: 'run', disabled: false });
    expect(deriveNextAction(ready, { renderBlockedByOther: true })).toMatchObject({ id: 'render-final', disabled: true });
    expect(deriveNextAction(ready, { renderActive: true, renderProgress: 41.6 })).toMatchObject({ id: 'render-progress', disabled: true, label: 'Rendering… 42%' });

    // A composed render needs its text cues before Make is done.
    const composed = { ...ready, composition: { mode: 'composed', textCues: [] } };
    expect(deriveStages(composed).current).toBe('produce');
    expect(deriveNextAction(composed)).toMatchObject({ id: 'goto-compose', stage: 'produce', anchor: 'mv-composition' });

    const finished = { ...ready, renderHistoryId: 'rh-1' };
    expect(stateOf(finished)).toEqual({ setup: 'done', 'cast-sets': 'done', board: 'done', produce: 'done', review: 'done', publish: 'active' });
    // #9281: a rendered project moves on to the release.
    expect(deriveNextAction(finished)).toMatchObject({ id: 'goto-publish', kind: 'goto', stage: 'publish', label: 'Build the publishing kit' });
    // With the kit built, the header names one platform at a time: the next one not yet posted.
    const kitBuilt = { ...finished, publishKit: { builtAt: '2026-01-01T00:00:00.000Z', posts: { youtube: { url: 'https://example.com/v' } } } };
    const publish = { targets: [{ target: 'youtube', label: 'YouTube' }, { target: 'distrokid', label: 'Spotify (via DistroKid)' }] };
    expect(deriveNextAction({ ...finished, publishKit: { builtAt: '2026-01-01T00:00:00.000Z' } })).toMatchObject({ label: 'Open publishing', anchor: 'mv-publish-kit' });
    expect(deriveNextAction(kitBuilt, { publish })).toMatchObject({ label: 'Next: post to Spotify (via DistroKid) · 1 left', anchor: 'mv-post-distrokid' });
    // Every enabled platform posted: nothing left to do here, and no bulk-post wording.
    const allPosted = { ...kitBuilt, publishKit: { ...kitBuilt.publishKit, posts: { youtube: { url: 'https://example.com/v' }, distrokid: { url: 'https://example.com/s' } } } };
    expect(deriveNextAction(allPosted, { publish })).toMatchObject({ label: 'All posted', anchor: 'mv-publish-kit' });
    expect(stageChecklist('publish', kitBuilt, undefined, publish).find((i) => i.id === 'post-distrokid').action).toEqual({ label: 'Post here', anchor: 'mv-post-distrokid' });
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
    expect(stepNotes(stale).review).toBe('Out of date');
    // The project index agrees: a stale render does not finish Final render.
    expect(summarizeMusicVideoProject(stale, APPROVED).stage).toBe('review');
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

  it('derives Make for all five render styles (#10139)', () => {
    const bare = { productionReadiness: APPROVED, id: 'p', trackId: 't1', audioAnalysis: ANALYSIS, scenes: [scene({ referenceImageId: null, videoHistoryId: null })] };
    const withMode = (composition) => ({ ...bare, composition });
    // Footage styles still need footage; composed also needs cues.
    expect(deriveStages(withMode({ mode: 'concat' })).current).toBe('produce');
    expect(deriveStages(withMode({ mode: 'composed', textCues: [] })).current).toBe('produce');
    // Eidoverse needs no footage; Make waits on a saved scene.
    expect(deriveStages(withMode({ mode: 'eidoverse' })).current).toBe('produce');
    expect(stageChecklist('produce', withMode({ mode: 'eidoverse' }), APPROVED).map((i) => [i.id, i.done])).toEqual([['composition', false], ['approve-proof', true]]);
    expect(stageChecklist('produce', withMode({ mode: 'eidoverse' }), APPROVED)[0])
      .toMatchObject({ label: 'Save the Eidoverse scene', done: false, action: { anchor: 'mv-eidoverse-scene' } });
    const saved = withMode({ mode: 'eidoverse', eidoverseScene: { inlineScript: 'scene()' } });
    expect(deriveStages(saved).current).toBe('review');
    expect(stageChecklist('produce', saved, APPROVED)[0].done).toBe(true);
    // Code: composed only once generated (or sections exist).
    expect(deriveStages(withMode({ mode: 'code' })).current).toBe('produce');
    expect(stageChecklist('produce', withMode({ mode: 'code' }), APPROVED)[0]).toMatchObject({ id: 'composition', done: false });
    expect(deriveStages(withMode({ mode: 'code', codeVideo: { generatedAt: '2026-01-01T00:00:00.000Z', sections: [] } })).current).toBe('review');
    // Document: composed once the document is attached.
    expect(deriveStages(withMode({ mode: 'document' })).current).toBe('produce');
  });

  it('does not require scene footage for code-rendered or document projects', () => {
    const bare = { productionReadiness: APPROVED, id: 'p', trackId: 't1', audioAnalysis: ANALYSIS, scenes: [scene({ referenceImageId: null, videoHistoryId: null })] };
    // Make lists no footage row for them; only the composition and its proof remain.
    expect(stageChecklist('produce', { ...bare, composition: { mode: 'code' } }, APPROVED).map((i) => i.id)).toEqual(['composition', 'approve-proof']);
    const doc = { ...bare, composition: { mode: 'document' } };
    expect(deriveStages(doc).current).toBe('produce');
    expect(deriveNextAction(doc).label).toBe('Attach a composition');
    expect(deriveStages({ ...doc, composition: { mode: 'document', document: { directory: 'd' } } }).current).toBe('review');
  });

  it('requires art review for hands-on projects too', () => {
    expect(stateOf({ id: 'p', trackId: 't1', audioAnalysis: ANALYSIS, ...LYRICS, scenes: [] })['cast-sets']).toBe('active');
  });
});

it('never promotes placeholder scenes or imported schematic documents to final production', () => {
  const project = { id: 'example', trackId: 'song', audioAnalysis: ANALYSIS, ...LYRICS, scenes: [scene()], composition: { mode: 'document', document: { directory: 'draft' } } };
  expect(stateOf(project)).toMatchObject({ 'cast-sets': 'active', board: 'todo', produce: 'todo' });
  // Planned shots with no art direction written: build the cast & sets that writes it, rather than "review" nothing.
  expect(deriveNextAction(project)).toMatchObject({ id: 'start-cast-sets', kind: 'run' });
  // A skipped sheet leaves the direction to the director, so the header opens its editor.
  expect(deriveNextAction({ ...project, castAndSets: { status: 'skipped' } }))
    .toMatchObject({ id: 'review-production', stage: 'cast-sets', anchor: 'mv-art-direction-editor', label: 'Write art direction' });
  // The proof is optional: with art and storyboard approved the header moves on to rendering.
  const planned = { ...project, productionReadiness: { ...APPROVED, proof: { approved: false }, readyForProduction: true } };
  expect(deriveNextAction(planned)).toMatchObject({ id: 'render-final' });
});

// Following the steps in order must never send an earlier step back to not
// done. The animated proof is optional: it never holds Make or the render.
describe('following the tab order', () => {
  // The server's proof basis covers the whole composition (productionReview.js),
  // so an approval holds only while the composition it was given over is unchanged.
  const readinessFor = (project, { art = false, storyboard = false, approvedComposition = null } = {}) => {
    const proof = approvedComposition !== null && approvedComposition === JSON.stringify(project.composition || null);
    return { art: { approved: art, problems: [] }, storyboard: { approved: storyboard, problems: [] }, proof: { approved: proof, problems: [] }, readyForProduction: storyboard };
  };
  const doneSet = (project, readiness) => new Set(deriveStages(project, readiness).stages.filter((s) => s.state === 'done').map((s) => s.id));

  it('walks song → look → storyboard → footage → composition → render without a step going backwards', () => {
    let project = { id: 'p', scenes: [], composition: { mode: 'composed', textCues: [] } };
    let approvals = {};
    const steps = [
      ['setup', () => { project = { ...project, trackId: 't1', audioAnalysis: ANALYSIS, ...LYRICS }; }],
      ['cast-sets', () => { approvals = { ...approvals, art: true }; }],
      ['board', () => { project = { ...project, scenes: [scene({ referenceImageId: null, videoHistoryId: null })] }; approvals = { ...approvals, storyboard: true }; }],
      ['produce', () => { project = { ...project, scenes: [scene()] }; }],
      ['compose', () => { project = { ...project, composition: { ...project.composition, textCues: [{ id: 'c1', text: 'Hello', startSec: 0, endSec: 2 }], grade: { contrast: 1.1 } } }; }],
      ['review', () => { project = { ...project, renderHistoryId: 'rh-1' }; }],
    ];
    let before = doneSet(project, readinessFor(project, approvals));
    for (const [step, apply] of steps) {
      apply();
      const readiness = readinessFor(project, approvals);
      const after = doneSet(project, readiness);
      for (const id of before) expect(after.has(id), `${id} regressed after ${step}`).toBe(true);
      // Each action finishes its own step; footage alone leaves Make open until the typography is added.
      if (step === 'produce') expect(after.has('produce'), 'Make done before its composition').toBe(false);
      else expect(after.has(step === 'compose' ? 'produce' : step), `${step} not done`).toBe(true);
      before = after;
    }
    expect(deriveStages(project, readinessFor(project, approvals)).current).toBe('publish');
  });

  it('a typography edit after proof approval keeps Make done and lists the proof as optional', () => {
    const composition = { mode: 'composed', textCues: [{ id: 'c1', text: 'Hello', startSec: 0, endSec: 2 }] };
    const project = { id: 'p', trackId: 't1', audioAnalysis: ANALYSIS, scenes: [scene()], composition };
    const approvals = { art: true, storyboard: true, approvedComposition: JSON.stringify(composition) };
    expect(deriveStages(project, readinessFor(project, approvals)).current).toBe('review');

    const edited = { ...project, composition: { ...composition, textCues: [...composition.textCues, { id: 'c2', text: 'World', startSec: 2, endSec: 4 }] } };
    const readiness = readinessFor(edited, approvals);
    expect(Object.fromEntries(deriveStages(edited, readiness).stages.map((s) => [s.id, s.state])))
      .toMatchObject({ board: 'done', produce: 'done', review: 'active' });
    expect(deriveNextAction(edited, { readiness })).toMatchObject({ id: 'render-final' });
    expect(stageChecklist('produce', edited, readiness).map((i) => [i.id, i.done, !!i.optional, i.label]))
      .toEqual([['footage', true, false, 'Footage for every shot (1 of 1)'], ['composition', true, false, 'Timed typography added'], ['approve-proof', false, true, 'Animated proof (optional)']]);
  });

  it('keeps the header on the footage until it is in, unless a run is parked on its pilot proof', () => {
    const project = { id: 'p', trackId: 't1', audioAnalysis: ANALYSIS, scenes: [scene({ videoHistoryId: null })] };
    const readiness = readinessFor(project, { art: true, storyboard: true });
    expect(deriveNextAction(project, { readiness })).toMatchObject({ id: 'goto-produce', stage: 'produce' });
    // A run parked on its pilot proof before paid bulk generation still sends the director to that proof.
    const parked = { ...project, productionRuns: [run({ status: 'blocked', pilot: { scenes: [{ sceneId: 's1' }] } })] };
    expect(deriveNextAction(parked, { readiness })).toMatchObject({ id: 'review-production', stage: 'produce', anchor: 'mv-review-proof' });
    const parkedNoPilot = { ...project, productionRuns: [run({ status: 'blocked' })] };
    expect(deriveNextAction(parkedNoPilot, { readiness })).toMatchObject({ id: 'resume-production' });
  });
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

  it('counts no generation for card or code shots in a layered composition (#10297)', () => {
    const scenes = [
      scene({ sceneId: 'a', visualLayer: 'code', referenceImageId: null, videoHistoryId: null }),
      scene({ sceneId: 'b', visualLayer: 'card', referenceImageId: null, videoHistoryId: null }),
      scene({ sceneId: 'c', referenceImageId: null, videoHistoryId: null }),
    ];
    expect(boardJobEstimate({ scenes, composition: { mode: 'composed' } })).toMatchObject({ jobs: 2 });
    // A plain render plays footage for every shot, so all three still need generating.
    expect(boardJobEstimate({ scenes })).toMatchObject({ jobs: 6 });
  });
});

describe('stage route param', () => {
  it('accepts a known stage and rejects anything else so the page can fall back to the default', () => {
    for (const stage of MUSIC_VIDEO_STAGES) expect(resolveStageParam(stage.id)).toBe(stage.id);
    expect(resolveStageParam('dev')).toBeNull();
    expect(resolveStageParam(undefined)).toBeNull();
  });

  it('opens Make for an old Compose link, and lists six steps each saying what done means', () => {
    expect(resolveStageParam('compose')).toBe('produce');
    expect(MUSIC_VIDEO_STAGES.map((stage) => stage.label)).toEqual(['Song', 'Look', 'Storyboard', 'Make', 'Final render', 'Publish']);
    for (const stage of MUSIC_VIDEO_STAGES) expect(stage.doneWhen).toMatch(/^Done when /);
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

  it('names the step and flags the one waiting on the director', () => {
    const status = describeProjectStatus({ excerpts: [] },
      { progress: stages('cast-sets', { setup: 'done' }), nextAction: { id: 'review-production', stage: 'cast-sets' } });
    expect(status).toEqual({ headline: 'Step 2 of 6: Look needs you', tone: 'warn', needsYouStage: 'cast-sets' });
    // A blocked step needs the director even with no approval to give.
    expect(describeProjectStatus({}, { progress: stages('produce', { produce: 'blocked' }) }))
      .toMatchObject({ headline: 'Step 4 of 6: Make needs you', needsYouStage: 'produce' });
  });

  it('names the step an approval sits on, even when an earlier step is still open', () => {
    // Song is not done yet, but the header asks for the art approval on Look.
    const status = describeProjectStatus({}, { progress: stages('setup'), nextAction: { id: 'review-production', stage: 'cast-sets' } });
    expect(status).toMatchObject({ headline: 'Step 2 of 6: Look needs you', needsYouStage: 'cast-sets' });
    expect(describeProjectStatus({}, { progress: stages('setup'), nextAction: { id: 'approve-cast-sets', kind: 'run' } }).needsYouStage).toBe('cast-sets');
  });

  it('reads plainly when nothing waits on the director', () => {
    expect(describeProjectStatus({}, { progress: stages('review') })).toEqual({ headline: 'Step 5 of 6: Final render', tone: 'muted', needsYouStage: null });
    const done = describeProjectStatus({ renderHistoryId: 'r1' }, { progress: { current: 'publish', stages: MUSIC_VIDEO_STAGES.map((stage) => ({ ...stage, state: 'done' })) } });
    expect(done).toEqual({ headline: 'Published', tone: 'ok', needsYouStage: null });
  });
});

describe('autopilotStatus', () => {
  it('says what the autonomous run is doing, then a parked production run, else just Autopilot', () => {
    expect(autopilotStatus({ autonomousRun: { status: 'running', stage: 'lyrics', stages: { lyrics: { step: 'draft' } } } }))
      .toEqual({ label: 'Autonomous run: writing the lyric draft', short: 'Autopilot running', tone: 'muted' });
    expect(autopilotStatus({ autonomousRun: { status: 'awaiting-approval', awaiting: 'lyrics' } })).toMatchObject({ short: 'Autopilot needs you', tone: 'warn' });
    // The button keeps the run's state while the header asks for an approval (no suppression).
    const blocked = (status) => autopilotStatus({ productionRuns: [{ id: 'r1', status }] });
    expect(blocked('stopped').label).toBe('Production paused');
    expect(blocked('blocked').label).toBe('Production blocked');
    expect(blocked('limit-reached').label).toBe('Production at its limit');
    expect(blocked('needs-replan').label).toBe('Production needs a replan');
    expect(blocked('running')).toMatchObject({ short: 'Autopilot running', tone: 'muted' });
    expect(autopilotStatus({ autonomousRun: { status: 'completed' } })).toEqual({ label: 'Autopilot', short: 'Autopilot', tone: 'muted' });
    expect(autopilotStatus({})).toEqual({ label: 'Autopilot', short: 'Autopilot', tone: 'muted' });
  });
});

it('links active draft and proof jobs to their own evidence controls before offering approval', () => {
  const project = { id: 'example', trackId: 'song', audioAnalysis: {}, scenes: [] };
  expect(deriveNextAction(project, { draftActive: true })).toMatchObject({ id: 'draft-progress', anchor: 'mv-draft-excerpts' });
  expect(deriveNextAction(project, { proofActive: true })).toMatchObject({ id: 'proof-progress', stage: 'produce', anchor: 'mv-review-render' });
  const nextAction = deriveNextAction(project, { draftActive: true });
  expect(describeProjectStatus(project, { progress: deriveStages(project), nextAction })).toMatchObject({ headline: 'Review render in progress', tone: 'muted' });
});

describe('stageChecklist', () => {
  const NOT_APPROVED = {
    art: { approved: false, problems: [] }, storyboard: { approved: false, problems: ['Review and approve the current art direction first.'] },
    proof: { approved: false, problems: [] }, readyForProduction: false,
  };
  const castProject = (over = {}) => ({
    id: 'p', trackId: 't1', audioAnalysis: ANALYSIS, scenes: [], lyricCues: LYRICS.lyricCues,
    devArtifacts: [{ id: 'sheet', title: 'Cast sheet', mimeType: 'text/html' }, { id: 'gone', title: 'Rejected sheet', deleted: true }],
    productionReview: { draft: { cast: 'c', environments: 'e', visualLanguage: 'v', motionLanguage: 'm', guideArtifactId: 'sheet', timingStatus: 'verified' } },
    ...over,
  });

  it('keeps Cast & Sets open on the art approval, not on a sheet file, and says where to approve it', () => {
    const items = stageChecklist('cast-sets', castProject(), NOT_APPROVED);
    expect(items.map((i) => [i.id, i.done])).toEqual([['direction', true], ['guide', true], ['approve-art', false]]);
    expect(items[1].label).toBe('Visual guide chosen: Cast sheet');
    expect(items[2].detail).toMatch(/Approving a sheet file does not approve the art direction/);
    expect(items[2].action).toEqual({ label: 'Review art direction', anchor: 'mv-review-art', stage: 'cast-sets' });
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
    // No sheet built yet: the row builds it, or the director writes the rest by hand.
    expect(items[0]).toMatchObject({ done: false, detail: 'Still missing: sets, visual language. Build the cast & sets to draft it from your creative direction, song style and mood board.',
      action: { label: 'Build cast & sets', run: 'start-cast-sets' }, secondary: { label: 'Write it yourself', anchor: 'mv-art-direction-editor' } });
    expect(items[1]).toMatchObject({ done: false, label: 'Visual guide chosen', action: { label: 'Choose a guide', anchor: 'mv-look-guides' } });
    // With nothing to approve the approval row neither repeats the server's reasons nor sends anywhere.
    expect(items[2]).toMatchObject({ done: false, detail: 'Opens once the art direction is written and a guide is chosen.', action: null });
  });

  it('offers the Cast & Sets step that writes the art direction at each point of its life', () => {
    const empty = { productionReview: { draft: {} }, devArtifacts: [] };
    const rows = (castAndSets) => stageChecklist('cast-sets', castProject({ ...empty, castAndSets }), NOT_APPROVED);
    expect(rows({ status: 'imaging' })[0]).toMatchObject({ action: null, detail: expect.stringMatching(/being built/) });
    expect(rows({ status: 'imaging', interrupted: true })[0].action).toEqual({ label: 'Resume cast & sets', run: 'resume-cast-sets' });
    expect(rows({ status: 'review' })[0].action).toEqual({ label: 'Review cast & sets', anchor: 'mv-cast-checkin' });
    const approvedSheet = { status: 'approved', direction: { look: 'x' }, artifactId: 'sheet' };
    const filled = rows(approvedSheet);
    expect(filled[0].action).toEqual({ label: 'Fill in from cast & sets', run: 'prepare-art' });
    expect(filled[1].action).toEqual({ label: 'Use the sheet', run: 'prepare-art' });
    expect(rows({ status: 'skipped' })[0].action).toEqual({ label: 'Write art direction', anchor: 'mv-art-direction-editor' });
  });

  it('covers Song, Storyboard and Make with the same done answers deriveStages uses', () => {
    expect(stageChecklist('setup', { id: 'p' }).map((i) => i.done)).toEqual([false, false, false, false]);
    expect(stageChecklist('setup', { id: 'p' })[0].action).toEqual({ label: 'Attach a track', anchor: 'mv-track' });
    // A running autonomous run writes the song itself, so there is nothing to attach.
    expect(stageChecklist('setup', { id: 'p', autonomousRun: { status: 'running' } })[0]).toMatchObject({ action: null, detail: 'The autonomous run is making the song.' });
    // A parked run is not making anything; the row says to resume it instead.
    expect(stageChecklist('setup', { id: 'p', autonomousRun: { status: 'running', interrupted: true } })[0]).toMatchObject({ action: null, detail: 'The autonomous run is paused. Resume it to make the song.' });
    expect(stageChecklist('setup', { id: 'p', autonomousRun: { status: 'stopped' } })[0].detail).toBe('The autonomous run is paused. Resume it to make the song.');
    expect(stageChecklist('setup', { id: 'p', autonomousRun: { status: 'awaiting-approval' } })[0].detail).toBe('The autonomous run is waiting for your approval.');
    expect(stageChecklist('board', castProject({ scenes: [scene()] }), NOT_APPROVED).map((i) => [i.id, i.done]))
      .toEqual([['shots', true], ['board-art', false], ['approve-storyboard', false]]);
    expect(stageChecklist('produce', castProject({ scenes: [scene(), scene({ sceneId: 's2', videoHistoryId: null })] }), APPROVED)[0])
      .toMatchObject({ id: 'footage', label: 'Footage for every shot (1 of 2)', done: false,
        action: { label: 'Make the footage', anchor: 'mv-generation' } });
    // A code-typed shot (#10297) is drawn by the composition, so it never reads as missing footage.
    expect(stageChecklist('produce', castProject({ composition: { mode: 'composed' }, scenes: [scene(), scene({ sceneId: 's2', videoHistoryId: null, visualLayer: 'code', startSec: 0, endSec: 2 })] }), APPROVED)[0])
      .toMatchObject({ id: 'footage', label: 'Footage for every shot (2 of 2)', done: true });
    // A code render draws its own picture: no footage row, just its composition and proof.
    expect(stageChecklist('produce', castProject({ composition: { mode: 'code' } }), APPROVED).map((i) => i.id)).toEqual(['composition', 'approve-proof']);
    // The proof closes Make, after the composition work it is judged over.
    expect(stageChecklist('produce', castProject({ scenes: [scene()], composition: { mode: 'composed', textCues: [] } }), APPROVED).map((i) => [i.id, i.done]))
      .toEqual([['footage', true], ['composition', false], ['approve-proof', true]]);
  });
  it('asks for the storyboard review, not a board plan, when a document storyboard brings its own shots', () => {
    const project = { id: 'p', trackId: 't1', audioAnalysis: ANALYSIS, ...LYRICS, scenes: [], composition: { mode: 'document', document: { directory: 'd' } },
      productionReview: { draft: { ...LYRICS.productionReview.draft, storyboardSource: 'document', storyboard: [{ id: 'shot-1' }] } } };
    const readiness = { ...APPROVED, storyboard: { approved: false, problems: ['Import a shot manifest from the current authored document and master audio.'] }, proof: { approved: false, problems: [] }, readyForProduction: false };
    expect(deriveNextAction(project, { readiness })).toMatchObject({ id: 'review-production', stage: 'board', anchor: 'mv-review-storyboard' });
    expect(deriveNextAction({ ...project, productionReview: { draft: LYRICS.productionReview.draft } }, { readiness })).toMatchObject({ id: 'plan' });
  });

  it('sends a missing document shot manifest to the manifest import, not to lyric timing', () => {
    const readiness = { ...NOT_APPROVED, storyboard: { approved: false, problems: ['Import a shot manifest from the current authored document and master audio. Reauthor or reimport after source, timing or shot changes.'] } };
    const items = stageChecklist('board', castProject({ scenes: [scene()] }), readiness);
    expect(items.find((i) => i.id === 'board-manifest')).toMatchObject({ label: 'Document shot manifest', action: { label: 'Import the shot manifest', anchor: 'mv-review-planning' } });
    expect(items.some((i) => i.id === 'board-timing')).toBe(false);
    // The approval row points at the items above instead of repeating the first problem.
    expect(items.at(-1)).toMatchObject({ id: 'approve-storyboard', detail: 'Approve once the items above are done.' });
    // A stale approval keeps naming what changed, even with an art problem listed above it.
    const stale = { ...readiness, storyboard: { approved: false, problems: ['Review and approve the current art direction first.'], stale: { changedFields: ['art direction', 'cast'] } } };
    expect(stageChecklist('board', castProject({ scenes: [scene()] }), stale).at(-1).detail).toMatch(/changed since: art direction, cast/);
  });
  it('keeps Setup open until lyrics are imported and their timing verified, unless the song is instrumental', () => {
    const base = { id: 'p', trackId: 't1', audioAnalysis: ANALYSIS };
    const setup = (project, readiness) => deriveStages(project, readiness).stages.find((st) => st.id === 'setup').state;
    expect(setup(base)).not.toBe('done');
    expect(stageChecklist('setup', base).filter((i) => !i.done).map((i) => i.id)).toEqual(['lyrics', 'timing']);
    const imported = { ...base, lyricCues: [{ id: 'l1', text: 'la' }] };
    // Timing is verified on the Song step itself (LyricTimingCheck), not in a review panel elsewhere.
    expect(stageChecklist('setup', imported).find((i) => i.id === 'timing')).toMatchObject({ done: false, action: { anchor: 'mv-lyric-timing' } });
    expect(setup(imported)).not.toBe('done');
    // The server's verdict wins over a stale draft: previously verified, timings changed since.
    const verified = { ...imported, ...LYRICS };
    expect(setup(verified)).toBe('done');
    expect(stageChecklist('setup', verified, { alignment: { status: 'stale' } }).find((i) => i.id === 'timing').detail).toMatch(/verify again/);
    expect(setup({ ...base, productionReview: { draft: { lyricsMode: 'instrumental' } } })).toBe('done');
  });

  it('lists every storyboard readiness problem on Board, grouped, each with a jump target', () => {
    const readiness = { ...NOT_APPROVED, storyboard: { approved: false, problems: [
      'Import lyrics and align them to the current vocal; missing lyrics are not an instrumental.',
      'Lyric alignment is provisional or changed. Listen and verify the current word timings.',
      'Storyboard shots must cover the master without unintended gaps or overlaps.',
      'Complete timing, action, staging, camera and transition for Shot 1.',
      'Review lyric anchors for Shot 1.',
      'Complete timing, action, staging, camera and transition for Shot 2.',
      'Review lyric anchors for Shot 2.',
      'Complete timing, action, staging, camera and transition for Shot 3.',
    ] } };
    const items = stageChecklist('board', castProject({ scenes: [scene()] }), readiness).filter((i) => i.details);
    expect(items.map((i) => i.id)).toEqual(['board-lyrics', 'board-timing', 'board-coverage', 'board-shots']);
    expect(items.every((i) => i.action?.anchor)).toBe(true);
    // Per-shot problems are counted, never listed one per shot: the preview is where shots get reviewed.
    expect(items.find((i) => i.id === 'board-shots').details).toEqual([
      '3 shots missing timing, action, staging, camera or transition.',
      '2 shots need lyric anchors reviewed.',
    ]);
  });

  it('gives every open checklist item an action so none is a dead end', () => {
    const stages = ['setup', 'cast-sets', 'board', 'produce', 'compose', 'review', 'publish'];
    const modes = [undefined, 'composed', 'document', 'eidoverse', 'code'];
    for (const mode of modes) {
      const project = castProject({ composition: mode ? { mode } : undefined, lyricCues: [] });
      for (const stage of stages) {
        const open = stageChecklist(stage, project, NOT_APPROVED).filter((i) => !i.done && !i.action);
        expect(open.map((i) => `${mode}/${stage}/${i.id}`)).toEqual([]);
      }
    }
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

describe('stale approval text (#10141)', () => {
  it('says what changed since an earlier approval and marks the checklist item stale', () => {
    const readiness = { art: { approved: false, problems: [], stale: { approvedAt: 'x', changedFields: ['concept', 'scene 3 prompt'] } }, storyboard: { approved: false, problems: [] }, proof: { approved: false, problems: [] } };
    const item = stageChecklist('cast-sets', { productionReview: { draft: {} } }, readiness).find((i) => i.id === 'approve-art');
    expect(item).toMatchObject({ done: false, stale: true });
    expect(item.detail).toMatch(/^Approved earlier — changed since: concept, scene 3 prompt\./);
    // The owning tab carries the stale mark; tabs whose approvals are current do not.
    const { stages } = deriveStages({ scenes: [] }, readiness);
    expect(stages.filter((s) => s.stale).map((s) => s.id)).toEqual(['cast-sets']);
  });
});

describe('stepNotes', () => {
  it('gives each step one fact from the project, and nothing for a step with nothing to say yet', () => {
    const project = {
      id: 'p', trackId: 't1', audioAnalysis: { durationSec: 280 }, lyricCues: [{ id: 'a', text: 'One' }, { id: 'b', text: 'Two' }],
      scenes: [scene(), scene({ sceneId: 's2', videoHistoryId: null })],
      devArtifacts: [{ id: 'g', title: 'Guide' }], productionReview: { draft: { guideArtifactId: 'g' } },
    };
    expect(stepNotes(project)).toEqual({
      setup: '4:40 · 2 lyric lines', 'cast-sets': 'Visual guide chosen', board: '2 shots',
      produce: '1 of 2 shots have their picture', review: '', publish: '',
    });
    expect(stepNotes({ ...project, composition: { mode: 'document' } }).produce).toBe('Picture drawn by the composition');
    expect(stepNotes({ id: 'p' })).toMatchObject({ setup: 'No track yet', board: '', produce: '' });
    expect(stepNotes({ ...project, renderHistoryId: 'r', renderDependencyState: { status: 'stale' } }).review).toBe('Out of date');
    // Before the final render, Final render says how many drafts and proofs there are to watch.
    expect(stepNotes({ ...project, excerpts: [{ id: 'a', status: 'complete', filename: 'a.mp4' }, { id: 'b', status: 'complete', filename: 'b.mp4' }, { id: 'c', status: 'error' }] }).review).toBe('2 drafts to watch');
  });
});

describe('preview source order on Storyboard', () => {
  it('leads with the storyboard, the live document or else the animatic, ahead of draft clips', () => {
    const drafts = [{ id: 'aaaaaa', status: 'complete', filename: 'a.mp4', startSec: 72, endSec: 95 }];
    const board = { trackId: 't1', scenes: [scene()], excerpts: drafts };
    expect(listPreviewSources(board).map((s) => s.id)).toEqual(['excerpt:aaaaaa', 'animatic']);
    expect(listPreviewSources(board, { storyboardFirst: true }).map((s) => s.id)).toEqual(['animatic', 'excerpt:aaaaaa']);
    const doc = { ...board, composition: { mode: 'document', document: { directory: 'd' } } };
    expect(listPreviewSources(doc, { storyboardFirst: true }).map((s) => s.id)).toEqual(['document', 'animatic', 'excerpt:aaaaaa']);
  });
});

describe('preview source order on Final render', () => {
  it('puts the drafts ahead of the live composition until a final render exists', () => {
    const project = { composition: { mode: 'document', document: { directory: 'd' } }, excerpts: [{ id: 'aaaaaa', status: 'complete', filename: 'a.mp4', startSec: 0, endSec: 5 }] };
    expect(listPreviewSources(project).map((s) => s.id)).toEqual(['document', 'excerpt:aaaaaa']);
    expect(listPreviewSources(project, { draftsFirst: true }).map((s) => s.id)).toEqual(['excerpt:aaaaaa', 'document']);
  });
});

describe('storyboard animatic preview source', () => {
  it('is offered last once the project has a track and shots', () => {
    expect(listPreviewSources({ trackId: 't1', scenes: [scene()] }).map((s) => s.id)).toEqual(['animatic']);
    expect(listPreviewSources({ trackId: 't1', scenes: [] })).toEqual([]);
    expect(listPreviewSources({ scenes: [scene()] })).toEqual([]);
    const excerpts = [{ id: 'a', status: 'complete', filename: 'a.mp4', startSec: 0, endSec: 5 }];
    expect(listPreviewSources({ trackId: 't1', scenes: [scene()], excerpts }).map((s) => s.id)).toEqual(['excerpt:a', 'animatic']);
  });
});

describe('finished outside PortOS', () => {
  // A video made elsewhere: rendered and posted, with no approval ever recorded here.
  const external = {
    id: 'p', trackId: 't1', audioAnalysis: ANALYSIS, lyricCues: [{ id: 'l1', text: 'la la' }], automation: { tools: [] },
    scenes: [scene()], composition: { mode: 'document', document: { directory: 'd' } }, renderHistoryId: 'rh-1',
    publishKit: { posts: { youtube: { url: 'https://example.com/v' } } },
  };
  const unapproved = { art: { approved: false, problems: ['x'] }, storyboard: { approved: false, problems: ['x'] }, proof: { approved: false, problems: ['x'] }, alignment: { status: 'provisional' } };
  const marked = { ...external, finishedOutside: { markedAt: '2026-10-05T00:00:00.000Z', note: 'Made elsewhere' } };

  it('without the marker, a published external project reads as stuck on Song', () => {
    expect(deriveStages(external, unapproved).current).toBe('setup');
    expect(deriveNextAction(external, { readiness: unapproved })).toMatchObject({ id: 'review-production' });
  });

  it('counts Song through Make as done, and reads Published once the render and posts are real', () => {
    const progress = deriveStages(marked, unapproved);
    expect(progress.stages.map((s) => [s.id, s.state, s.stale])).toEqual(
      MUSIC_VIDEO_STAGES.map((s) => [s.id, 'done', false]),
    );
    const nextAction = deriveNextAction(marked, { readiness: unapproved });
    expect(nextAction.id).not.toBe('review-production');
    expect(describeProjectStatus(marked, { progress, nextAction })).toMatchObject({ headline: 'Published', needsYouStage: null });
    expect(stageChecklist('board', marked, unapproved)).toEqual([{ id: 'finished-outside', label: 'Finished outside PortOS', done: true, detail: 'Made elsewhere' }]);
    expect(summarizeMusicVideoProject(marked, unapproved).stage).toBe('publish');
  });

  it('still asks for the posts it never had', () => {
    const unposted = { ...marked, publishKit: {} };
    expect(deriveStages(unposted, unapproved).current).toBe('publish');
    expect(summarizeMusicVideoProject(unposted, unapproved).stage).toBe('publish');
  });

  it('does not count without a final render, so the approvals that rendering needs are still asked for', () => {
    const unrendered = { ...marked, renderHistoryId: null, publishKit: {} };
    expect(deriveStages(unrendered, unapproved).current).toBe('setup');
    expect(summarizeMusicVideoProject(unrendered, unapproved).stage).toBe('setup');
    expect(deriveNextAction(unrendered, { readiness: unapproved })).toMatchObject({ id: 'review-production' });
    expect(stageChecklist('board', unrendered, unapproved)[0].id).not.toBe('finished-outside');
  });

  it('says a stale render can only be redone here with the approvals', () => {
    const stale = { ...marked, renderDependencyState: { status: 'stale' } };
    expect(deriveStages(stale, unapproved).current).toBe('review');
    expect(stageChecklist('review', stale, unapproved)[0].detail).toMatch(/needs the Song through Make approvals; unmark Finished outside PortOS/);
  });
});

describe('server project summary', () => {
  it('reports the same current step the page derives, for every step', () => {
    const base = { id: 'p', trackId: 't1', audioAnalysis: ANALYSIS, ...LYRICS };
    const projects = [
      { id: 'p', trackId: 't1', audioAnalysis: ANALYSIS },
      base,
      { ...base, scenes: [scene({ videoHistoryId: null })] },
      { ...base, scenes: [scene()], composition: { mode: 'composed', textCues: [] } },
      { ...base, scenes: [scene()] },
      { ...base, scenes: [scene()], renderHistoryId: 'rh-1' },
    ];
    const readinesses = [undefined, { ...APPROVED, art: { approved: false, problems: [] } }, APPROVED, APPROVED, APPROVED, APPROVED];
    const stages = projects.map((project, i) => [summarizeMusicVideoProject(project, readinesses[i]).stage, deriveStages(project, readinesses[i]).current]);
    for (const [summary, page] of stages) expect(summary).toBe(page);
    expect(stages.map(([summary]) => summary)).toEqual(['setup', 'cast-sets', 'produce', 'produce', 'review', 'publish']);
  });
});
