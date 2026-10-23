import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'loom-shots-'));
vi.mock('../../lib/fileUtils.js', async (original) => {
  const actual = await original();
  return { ...actual, PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT } };
});
const runStagedLLM = vi.hoisted(() => vi.fn());
vi.mock('../stageRunner.js', () => ({ runStagedLLM, resolveStageRoute: async () => ({ provider: { id: 'test-provider', timeout: 300000 } }) }));
vi.mock('../universeBuilder.js', () => ({ getUniverse: async () => ({ id: 'example-universe' }) }));
vi.mock('../pipeline/series.js', () => ({ getSeries: async () => null }));
const { createLoom, addEpisode, addNode, updateNode, getLoom } = await import('./records.js');
const { _resetFableLoomBackend } = await import('./store.js');
const { runEpisodeShotAutopilot, applyEpisodeShots } = await import('./shots.js');
beforeEach(() => { rmSync(join(TEST_DATA_ROOT, 'fableloom'), { recursive: true, force: true }); _resetFableLoomBackend(); runStagedLLM.mockReset(); });
afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));
const shot = (title, dialogue = []) => ({ title, durationSeconds: 8, action: 'A courier watches the gate.', framing: 'Medium static shot', dialogue, imagePrompt: 'Courier at the gate', videoPrompt: 'Courier waits.' });
async function setup() {
  let loom = await createLoom({ name: 'Example Story', universeId: 'example-universe' });
  loom = await addEpisode(loom.id, { title: 'Pilot' });
  const ep = loom.episodes[0].id;
  loom = await addEpisode(loom.id, { title: 'Later' });
  loom = await addNode(loom.id, ep, { title: 'Choice', playbackMode: 'decision' });
  loom = await addNode(loom.id, ep, { title: 'North', isEnding: true });
  loom = await addNode(loom.id, ep, { title: 'South', isEnding: true });
  const [choice, north, south] = loom.episodes[0].nodes;
  loom = await updateNode(loom.id, ep, choice.id, { transitions: [{ targetNodeId: north.id, intent: 'north' }, { targetNodeId: south.id, intent: 'south' }] });
  const groups = [{ sceneId: choice.id, shots: [shot('Ask', [{ speaker: 'Courier', text: 'Which gate?' }]), shot('Wait')] }, { sceneId: north.id, shots: [shot('North')] }, { sceneId: south.id, shots: [shot('South')] }];
  return { loom, ep, groups };
}
function mockPlan(groups) {
  runStagedLLM.mockImplementation(async (stage, variables) => stage === 'fableloom-plan-shots'
    ? { content: { groups: groups.filter(group => group.sceneId === JSON.parse(variables.source).scenes[0].id) } }
    : { content: { summary: 'Clear and filmable.', risks: [] } });
}
describe('timed shot autopilot', () => {
  it('grounds both planning and review in existing shot geography and camera context', async () => {
    const { loom, ep, groups } = await setup();
    const visual = {
      imagePrompt: 'A blue gate at screen left, courier beside a brass lamp at screen right.',
      videoPrompt: 'The courier turns toward the blue gate; the lamp stays on the desk.',
      cameraMovement: 'static',
      shot: { dramaticSceneId: 'example-scene', dramaticSceneTitle: 'At the gate', durationSeconds: 8, framing: 'Wide from the courtyard' },
    };
    const updated = await updateNode(loom.id, ep, groups[0].sceneId, visual);
    mockPlan(groups);
    await runEpisodeShotAutopilot(loom.id, ep);
    const groundedCalls = runStagedLLM.mock.calls.filter(([, variables]) => JSON.parse(variables.source).scenes[0]?.shot);
    expect(groundedCalls).toHaveLength(2);
    for (const [, variables] of groundedCalls) {
      const source = JSON.parse(variables.source);
      expect(source.startNodeId).toBe(updated.episodes[0].startNodeId);
      if (source.scenes[0].id === groups[0].sceneId) expect(source.scenes[0]).toMatchObject(visual);
      if (source.scenes[0].id === groups[0].sceneId) expect(source.scenes[0].transitions.map(t => t.targetNodeId)).toEqual(groups.slice(1).map(g => g.sceneId));
    }
    expect((await getLoom(loom.id)).episodes).toEqual(updated.episodes);
  });
  it('applies a reviewed split with preserved choices, quiet loop and untouched later episode', async () => {
    const { loom, ep, groups } = await setup();
    groups[0].shots[0].durationSeconds = 9;
    groups[0].shots[0].dialogue = [{ speaker: 'Courier', text: 'We can open the northern gate now or take the long road around before the guards come back.' }];
    mockPlan(groups);
    const result = await runEpisodeShotAutopilot(loom.id, ep, { apply: true });
    const saved = await getLoom(loom.id);
    expect(saved.episodes[1]).toEqual(loom.episodes[1]);
    const nodes = saved.episodes[0].nodes;
    expect(nodes).toHaveLength(4);
    expect(nodes[0].id).toBe(loom.episodes[0].nodes[0].id);
    expect(nodes[0].transitions[0].targetNodeId).toBe(nodes[1].id);
    expect(nodes[1].transitions.map(t => t.targetNodeId)).toEqual(nodes.slice(2).map(n => n.id));
    expect(nodes[1].playbackMode).toBe('decision');
    expect(nodes[0].shot.durationSeconds).toBe(10);
    expect(nodes[0].shot.dramaticSceneId).toBe(nodes[1].shot.dramaticSceneId);
    expect(result.validation.stats.ready).toBe(true);
  });
  it('counts short and compound speaker cues before accepting a shot plan', async () => {
    const { loom, ep, groups } = await setup();
    groups[0].shots[0].dialogue = [{ speaker: 'Q', text: 'Too many spoken words. '.repeat(8) }, { speaker: 'RADIO/AI', text: '\n\nMore spoken words. '.repeat(8) }];
    mockPlan(groups);
    await expect(runEpisodeShotAutopilot(loom.id, ep, { maxRounds: 1, apply: true })).rejects.toThrow('dialogue needs');
    expect(runStagedLLM).toHaveBeenCalledTimes(1);
    expect((await getLoom(loom.id)).episodes).toEqual(loom.episodes);
  });

  it('rejects oversized dialogue before editorial or mutation, and rejects stale previews', async () => {
    const { loom, ep, groups } = await setup();
    const bad = structuredClone(groups);
    bad[0].shots[0].dialogue[0].text = 'too many words '.repeat(20);
    mockPlan(bad);
    await expect(runEpisodeShotAutopilot(loom.id, ep, { maxRounds: 1, apply: true })).rejects.toThrow('dialogue needs');
    expect(runStagedLLM).toHaveBeenCalledTimes(1);
    expect((await getLoom(loom.id)).episodes).toEqual(loom.episodes);
    mockPlan(groups);
    const preview = await runEpisodeShotAutopilot(loom.id, ep);
    await updateNode(loom.id, ep, groups[0].sceneId, { title: 'Revised choice' });
    await expect(applyEpisodeShots(loom.id, ep, preview)).rejects.toThrow('episode changed');
    expect((await getLoom(loom.id)).episodes[0].nodes).toHaveLength(3);
  });
});


describe('shot checkpoints and bounded inputs', () => {
  it('preserves a draft across a review timeout and resumes without redrafting', async () => {
    const { loom, ep, groups } = await setup();
    const checkpoint = {};
    let durable;
    mockPlan(groups);
    const implementation = runStagedLLM.getMockImplementation();
    runStagedLLM.mockImplementation(async (stage, variables) => {
      if (stage === 'fableloom-review-shots') throw new Error('CLI run timed out after 300000ms');
      return implementation(stage, variables);
    });
    await expect(runEpisodeShotAutopilot(loom.id, ep, { checkpoint, saveCheckpoint: async value => { durable = structuredClone(value); } }))
      .rejects.toThrow('fableloom-review-shots round 1 scene');
    expect(durable.current.providerId).toBe('test-provider');
    expect(durable.scenes[groups[0].sceneId].rounds[0].draft.groups).toEqual([groups[0]]);
    runStagedLLM.mockClear();
    mockPlan(groups);
    const result = await runEpisodeShotAutopilot(loom.id, ep, { checkpoint: durable });
    expect(result.validation.stats.ready).toBe(true);
    expect(runStagedLLM.mock.calls[0][0]).toBe('fableloom-review-shots');
    expect(runStagedLLM.mock.calls.filter(([stage]) => stage === 'fableloom-plan-shots')).toHaveLength(2);
  });
  it('keeps 20 normal-size scene teleplays out of other scene calls and the consistency pass', async () => {
    let loom = await createLoom({ name: 'Example Long Story', universeId: 'example-universe' });
    loom = await addEpisode(loom.id, { title: 'Twenty scenes' });
    const ep = loom.episodes[0].id;
    for (let i = 0; i < 20; i += 1) loom = await addNode(loom.id, ep, { title: `Scene ${i}`, playbackMode: 'cut', prose: `UNIQUE_${i}_` + 'A courier waits. '.repeat(65), isEnding: i === 19 });
    const nodes = loom.episodes[0].nodes;
    for (let i = 0; i < 19; i += 1) loom = await updateNode(loom.id, ep, nodes[i].id, { transitions: [{ targetNodeId: nodes[i + 1].id, intent: 'continue' }] });
    const groups = nodes.map(node => ({ sceneId: node.id, shots: [shot(node.title)] }));
    mockPlan(groups);
    await expect(runEpisodeShotAutopilot(loom.id, ep)).resolves.toMatchObject({ validation: { stats: { ready: true } } });
    expect(runStagedLLM).toHaveBeenCalledTimes(41);
    const calls = runStagedLLM.mock.calls;
    for (const [, variables] of calls.slice(0, -1)) {
      const source = JSON.parse(variables.source);
      expect(source.scenes).toHaveLength(1);
      expect(variables.source.match(/UNIQUE_\d+_/g)).toHaveLength(1);
      expect(variables.source.length).toBeLessThan(9000);
    }
    expect(calls.at(-1)[1].source).not.toContain('UNIQUE_');
  });
  it('reports a durable interrupted run without calling a provider, then resumes explicitly', async () => {
    const { startEpisodeShotRun, getEpisodeShotRun } = await import('./shotRuns.js');
    const { fableLoomRunEvents } = await import('./runEvents.js');
    const { loom, ep, groups } = await setup();
    let rejectCall;
    let callStarted;
    const startedCall = new Promise(resolve => { callStarted = resolve; });
    runStagedLLM.mockImplementation(() => new Promise((resolve, reject) => { rejectCall = reject; callStarted(); }));
    const started = await startEpisodeShotRun(loom.id, ep);
    expect(started.status).toBe('running');
    const terminal = new Promise(resolve => {
      const handler = run => { if (run.id === started.id && run.status === 'failed') { fableLoomRunEvents.off('shots', handler); resolve(run); } };
      fableLoomRunEvents.on('shots', handler);
    });
    await startedCall;
    rejectCall(new Error('CLI run timed out after 300000ms'));
    const failed = await terminal;
    expect(failed.message).toContain('provider test-provider');
    const { createHash } = await import('node:crypto');
    const path = join(TEST_DATA_ROOT, 'fableloom-shot-runs', createHash('sha256').update(JSON.stringify([loom.id, ep])).digest('hex') + '.json');
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    // Reproduce the bytes a process death leaves, without starting work at boot.
    saved.status = 'running';
    writeFileSync(path, JSON.stringify(saved));
    const count = runStagedLLM.mock.calls.length;
    const interrupted = await getEpisodeShotRun(loom.id, ep);
    expect(interrupted.status).toBe('failed');
    expect(interrupted.message).toContain('restart');
    expect(runStagedLLM).toHaveBeenCalledTimes(count);
    mockPlan(groups);
    const completed = new Promise(resolve => {
      const handler = run => { if (run.id === started.id && run.status === 'completed') { fableLoomRunEvents.off('shots', handler); resolve(run); } };
      fableLoomRunEvents.on('shots', handler);
    });
    const resumed = await startEpisodeShotRun(loom.id, ep, { resume: true });
    expect(resumed.id).toBe(started.id);
    expect((await completed).result.validation.stats.ready).toBe(true);
  });
});

it('deduplicates starts and preserves the last draft when canceled during a provider call', async () => {
  const { startEpisodeShotRun, cancelEpisodeShotRun, getEpisodeShotRun } = await import('./shotRuns.js');
  const { fableLoomRunEvents } = await import('./runEvents.js');
  const { loom, ep, groups } = await setup();
  let finishCall, callStarted;
  const ready = new Promise(resolve => { callStarted = resolve; });
  runStagedLLM.mockImplementation(() => new Promise(resolve => { finishCall = resolve; callStarted(); }));
  const started = await startEpisodeShotRun(loom.id, ep, { apply: true });
  await ready;
  expect(await startEpisodeShotRun(loom.id, ep)).toMatchObject({ id: started.id, alreadyRunning: true });
  const terminal = new Promise(resolve => {
    const handler = run => { if (run.id === started.id && run.status === 'canceled') { fableLoomRunEvents.off('shots', handler); resolve(run); } };
    fableLoomRunEvents.on('shots', handler);
  });
  expect((await cancelEpisodeShotRun(loom.id, ep)).status).toBe('canceling');
  finishCall({ content: { groups: [groups[0]] } });
  await terminal;
  expect(runStagedLLM).toHaveBeenCalledTimes(1);
  expect((await getLoom(loom.id)).episodes).toEqual(loom.episodes);
  expect((await getEpisodeShotRun(loom.id, ep)).progress.rounds).toEqual([{ sceneId: groups[0].sceneId, rounds: 1, completed: false }]);
});

it('repairs cross-scene consistency findings within the remaining rounds and keeps the rejected verdict', async () => {
  const { loom, ep, groups } = await setup();
  const checkpoint = {};
  let consistencyCalls = 0;
  runStagedLLM.mockImplementation(async (stage, variables) => {
    const source = JSON.parse(variables.source);
    if (stage === 'fableloom-plan-shots') {
      const group = structuredClone(groups.find(candidate => candidate.sceneId === source.scenes[0].id));
      if (consistencyCalls) group.shots[0].action += ' The lamp remains at screen right.';
      return { content: { groups: [group] } };
    }
    if (!('prose' in source.scenes[0])) {
      consistencyCalls += 1;
      return { content: { summary: 'Cross-scene check.', risks: consistencyCalls === 1 ? ['Preserve the lamp placement between scenes.'] : [] } };
    }
    return { content: { summary: 'Scene checked.', risks: [] } };
  });
  await expect(runEpisodeShotAutopilot(loom.id, ep, { checkpoint })).resolves.toMatchObject({ attempt: 2 });
  expect(checkpoint.consistency).toHaveLength(2);
  expect(checkpoint.consistency[0].review.risks).toEqual(['Preserve the lamp placement between scenes.']);
  expect(checkpoint.scenes[groups[0].sceneId].rounds[0].feedback).toContain('lamp');
});

it('keeps the synchronous compatibility response backed by a durable background journal', async () => {
  const { planEpisodeShotRun, getEpisodeShotRun } = await import('./shotRuns.js');
  const { loom, ep, groups } = await setup();
  mockPlan(groups);
  const result = await planEpisodeShotRun(loom.id, ep);
  expect(result.validation.stats.ready).toBe(true);
  expect((await getEpisodeShotRun(loom.id, ep))).toMatchObject({ status: 'completed', result: { sourceFingerprint: result.sourceFingerprint } });
});

it('detaches a disconnected compatibility waiter while its durable worker completes', async () => {
  const { planEpisodeShotRun, getEpisodeShotRun } = await import('./shotRuns.js');
  const { fableLoomRunEvents } = await import('./runEvents.js');
  const { loom, ep, groups } = await setup();
  mockPlan(groups);
  const implementation = runStagedLLM.getMockImplementation();
  let finishCall, startedCall;
  const ready = new Promise(resolve => { startedCall = resolve; });
  runStagedLLM.mockImplementationOnce(() => new Promise(resolve => { finishCall = resolve; startedCall(); }));
  const controller = new AbortController();
  const waiting = planEpisodeShotRun(loom.id, ep, {}, { signal: controller.signal });
  await ready;
  controller.abort();
  await expect(waiting).rejects.toMatchObject({ code: 'SHOT_WAITER_CLOSED' });
  expect((await getEpisodeShotRun(loom.id, ep)).status).toBe('running');
  const completed = new Promise(resolve => {
    const handler = run => { if (run.loomId === loom.id && run.status === 'completed') { fableLoomRunEvents.off('shots', handler); resolve(run); } };
    fableLoomRunEvents.on('shots', handler);
  });
  finishCall(await implementation('fableloom-plan-shots', { source: JSON.stringify({ scenes: [{ id: groups[0].sceneId }] }) }));
  expect((await completed).result.validation.stats.ready).toBe(true);
});
