import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'fableloom-weave-test-'));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT },
  };
});

const runStagedLLM = vi.hoisted(() => vi.fn());
vi.mock('../stageRunner.js', () => ({ runStagedLLM }));

const getUniverseMock = vi.hoisted(() => vi.fn(async () => null));
vi.mock('../universeBuilder.js', () => ({ getUniverse: getUniverseMock }));
// records.js validates soft refs at write time through these services.
const getSeriesMock = vi.hoisted(() => vi.fn(async () => null));
vi.mock('../pipeline/series.js', () => ({ getSeries: getSeriesMock }));

const { createLoom, addEpisode, addNode, mutateLoom, updateLoom, updateNode, getLoom } = await import('./records.js');
const { _resetFableLoomBackend } = await import('./store.js');
const { aiStatusEvents } = await import('../aiStatusEvents.js');
const {
  branchNode, buildCanonDigest, feedbackEpisode, feedbackSeriesPlan, generateEpisodeOutline, generateSeriesPlan,
  mapGeneratedGraph, playTurn, reformatEpisodeScenes, reviewEpisode, reviewEpisodeOutline, reviewSeriesPlan,
  validateEpisodeOutline, reviewSeriesTeleplay, weaveEpisode,
} = await import('./weave.js');

beforeEach(() => {
  rmSync(join(TEST_DATA_ROOT, 'fableloom'), { recursive: true, force: true });
  _resetFableLoomBackend();
  runStagedLLM.mockReset();
  getUniverseMock.mockReset().mockResolvedValue(null);
});

afterAll(() => {
  rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
});

const setup = async () => {
  // createLoom validates the universe ref exists before persisting it.
  getUniverseMock.mockResolvedValueOnce({ id: 'uni-1' });
  const loom = await createLoom({ name: 'The Hollow Crown', universeId: 'uni-1' });
  const withEp = await addEpisode(loom.id, { title: 'Pilot', synopsis: 'A crown wakes.' });
  return { loomId: loom.id, episodeId: withEp.episodes[0].id };
};

const generatedGraph = () => ({
  startKey: 's1',
  nodes: [
    { key: 's1', title: 'The Gate', prose: 'You stand before it.', imagePrompt: 'a vast gate at dusk', transitions: [
      { targetKey: 's2', intent: 'enter', triggers: ['go in'], description: 'Step through.' },
      { targetKey: 's3', intent: 'walk away', triggers: [], description: 'Leave.' },
      { targetKey: 'missing', intent: 'dangling — dropped' },
    ] },
    { key: 's2', title: 'Inside', prose: 'Torchlight.', transitions: [{ targetKey: 's3', intent: 'give up' }] },
    { key: 's3', title: 'The Road Home', isEnding: true, endingLabel: 'Turned back', transitions: [] },
  ],
});

const generatedOutline = () => ({
  startKey: 's1',
  scenes: [
    { key: 's1', title: 'Signal', summary: 'A signal proves the missing ship is alive.', playbackMode: 'cut', transitions: [{ targetKey: 's2', intent: 'follow the signal' }] },
    { key: 's2', title: 'The choice', summary: 'The signal offers two routes with different costs.', playbackMode: 'decision', transitions: [{ targetKey: 's3', intent: 'protect the survivors' }, { targetKey: 's4', intent: 'take the shortcut' }] },
    { key: 's3', title: 'Rescue', summary: 'The rescue succeeds but strands the protagonist.', isEnding: true, endingLabel: 'The long way home' },
    { key: 's4', title: 'Shortcut', summary: 'The shortcut opens a door and leaves a voice behind.', isEnding: true, endingLabel: 'The open door' },
  ],
});

describe('mapGeneratedGraph', () => {
  it('mints server ids, remaps targets, and drops unknown-target transitions', () => {
    const { nodes, startNodeId } = mapGeneratedGraph(generatedGraph());
    expect(nodes).toHaveLength(3);
    expect(nodes.every((n) => n.id.startsWith('node-'))).toBe(true);
    expect(startNodeId).toBe(nodes[0].id);
    expect(nodes[0].transitions).toHaveLength(2);
    expect(nodes[0].transitions.map((t) => t.targetNodeId)).toEqual([nodes[1].id, nodes[2].id]);
  });

  it('keeps only the first node when the model repeats a key', () => {
    const graph = generatedGraph();
    graph.nodes.push({ key: 's2', title: 'Duplicate Inside', isEnding: true, transitions: [] });
    const { nodes } = mapGeneratedGraph(graph);
    expect(nodes).toHaveLength(3);
    expect(new Set(nodes.map((n) => n.id)).size).toBe(3);
    expect(nodes.find((n) => n.title === 'Duplicate Inside')).toBeUndefined();
  });

  it('rejects graphs with too few scenes or no endings', () => {
    expect(() => mapGeneratedGraph({ nodes: [{ key: 's1' }] })).toThrowError(/too few scenes/);
    expect(() => mapGeneratedGraph({
      startKey: 's1',
      nodes: [{ key: 's1', transitions: [] }, { key: 's2', transitions: [] }],
    })).toThrowError(/no endings/);
  });
});

describe('weaveEpisode', () => {
  it('replaces the episode graph from the LLM response', async () => {
    const { loomId, episodeId } = await setup();
    runStagedLLM.mockResolvedValue({ content: generatedGraph(), runId: 'run-1' });

    const { loom, runId } = await weaveEpisode(loomId, episodeId, { guidance: 'darker' });
    expect(runId).toBe('run-1');
    const ep = loom.episodes[0];
    expect(ep.nodes).toHaveLength(3);
    expect(ep.startNodeId).toBe(ep.nodes[0].id);

    const [stage, variables] = runStagedLLM.mock.calls[0];
    expect(stage).toBe('fableloom-weave-episode');
    expect(variables.storyContext).toContain('The Hollow Crown');
    expect(variables.guidance).toBe('darker');
    expect(variables.existingGraph).toContain('(none');
    expect(variables.cameraMovementCatalog).toContain('slow-dolly-in');
    expect(variables.participationContract).toContain('audience acts as the protagonist');
    expect(variables).not.toHaveProperty('nodeTarget');
    expect(variables).not.toHaveProperty('endingTarget');
  });

  it('refuses to clobber a non-empty episode without replace', async () => {
    const { loomId, episodeId } = await setup();
    await addNode(loomId, episodeId, { title: 'Handwritten' });
    await expect(weaveEpisode(loomId, episodeId, {})).rejects.toMatchObject({ code: 'EPISODE_NOT_EMPTY' });
    expect(runStagedLLM).not.toHaveBeenCalled();

    runStagedLLM.mockResolvedValue({ content: generatedGraph(), runId: 'run-2' });
    const { loom } = await weaveEpisode(loomId, episodeId, { replace: true });
    expect(loom.episodes[0].nodes).toHaveLength(3);
  });

  it('rejects a helper weave that offers decisions before establishing its audience channel', async () => {
    const { loomId, episodeId } = await setup();
    await updateLoom(loomId, {
      participationMode: 'helper',
      audienceCommunicationMedium: 'A pocket radio.',
    });
    runStagedLLM.mockResolvedValue({ content: generatedGraph(), runId: 'run-disconnected' });

    await expect(weaveEpisode(loomId, episodeId))
      .rejects.toMatchObject({ code: 'AI_RESPONSE_INVALID' });
    expect((await getLoom(loomId)).episodes[0].nodes).toEqual([]);
  });

  it('persists the first helper invitation and its connected decision scenes', async () => {
    const { loomId, episodeId } = await setup();
    await updateLoom(loomId, {
      participationMode: 'helper',
      audienceCommunicationMedium: 'A pocket radio.',
    });
    const graph = generatedGraph();
    graph.nodes[0].playbackMode = 'cut';
    graph.nodes[0].audienceConnection = 'disconnected';
    graph.nodes[0].transitions = [graph.nodes[0].transitions[0]];
    graph.nodes[1].playbackMode = 'decision';
    graph.nodes[1].audienceConnection = 'connected';
    runStagedLLM.mockResolvedValue({ content: graph, runId: 'run-connected' });

    const result = await weaveEpisode(loomId, episodeId);
    expect(result.loom.episodes[0].nodes.map((node) => node.audienceConnection))
      .toEqual(['disconnected', 'connected', 'disconnected']);
  });

  it('requires a validated beat outline before expansion', async () => {
    const { loomId, episodeId } = await setup();
    await expect(weaveEpisode(loomId, episodeId, { expandFromOutline: true }))
      .rejects.toMatchObject({ code: 'OUTLINE_INVALID' });
    expect(runStagedLLM).not.toHaveBeenCalled();
  });

  it('drafts, validates, and expands an outline without losing its story contract', async () => {
    const { loomId, episodeId } = await setup();
    runStagedLLM.mockResolvedValueOnce({ content: generatedOutline(), runId: 'outline-run' });
    const drafted = await generateEpisodeOutline(loomId, episodeId, { guidance: 'Make the choice costly.' });
    expect(drafted.runId).toBe('outline-run');
    expect(drafted.outline.scenes).toHaveLength(4);
    expect(drafted.outline.validation.status).toBe('draft');

    const checked = await validateEpisodeOutline(loomId, episodeId);
    expect(checked.validation.issues).toEqual([]);
    expect(checked.outline.validation.status).toBe('valid');

    runStagedLLM.mockResolvedValueOnce({ content: generatedGraph(), runId: 'expand-run' });
    const expanded = await weaveEpisode(loomId, episodeId, {
      guidance: 'Write the full teleplay now.', replace: false, expandFromOutline: true,
    });
    expect(expanded.runId).toBe('expand-run');
    expect(expanded.loom.episodes[0].nodes).toHaveLength(3);
    expect(runStagedLLM.mock.calls[1][0]).toBe('fableloom-weave-episode');
    expect(runStagedLLM.mock.calls[1][1].outlineDigest).toContain('[s1] Signal');
  });

  it('uses the loom participation mode when normalizing helper outline beats', async () => {
    const { loomId, episodeId } = await setup();
    await updateLoom(loomId, {
      participationMode: 'helper',
      audienceCommunicationMedium: 'A pocket radio.',
    });
    const outline = generatedOutline();
    outline.scenes[1].audienceConnection = 'connected';
    runStagedLLM.mockResolvedValueOnce({ content: outline, runId: 'helper-outline-run' });

    const drafted = await generateEpisodeOutline(loomId, episodeId, {});

    expect(drafted.outline.scenes[1].protagonistPresence).toBe('offscreen');
  });

  it('does not expand one episode until every episode in the series has a validated outline', async () => {
    const { loomId, episodeId } = await setup();
    const withSecond = await addEpisode(loomId, { title: 'Second', synopsis: 'The consequence.' });
    runStagedLLM.mockResolvedValueOnce({ content: generatedOutline(), runId: 'outline-run' });
    await generateEpisodeOutline(loomId, episodeId, {});
    await validateEpisodeOutline(loomId, episodeId);

    await expect(weaveEpisode(loomId, episodeId, { expandFromOutline: true }))
      .rejects.toMatchObject({ code: 'SERIES_OUTLINE_INVALID' });
    expect(withSecond.episodes).toHaveLength(2);
    expect(runStagedLLM).toHaveBeenCalledTimes(1);
  });
});

describe('episode outline AI review', () => {
  it('returns deterministic findings alongside editorial analysis', async () => {
    const { loomId, episodeId } = await setup();
    runStagedLLM.mockResolvedValueOnce({ content: generatedOutline(), runId: 'outline-run' });
    await generateEpisodeOutline(loomId, episodeId, {});
    runStagedLLM.mockResolvedValueOnce({
      content: { summary: 'The turn lands.', strengths: ['The endings diverge.'], risks: ['The handoff needs a sharper hook.'], recommendations: ['Make the final beat reveal the next threat.'] },
      runId: 'outline-review-run',
    });
    const result = await reviewEpisodeOutline(loomId, episodeId, {});
    expect(result).toMatchObject({
      runId: 'outline-review-run',
      structural: { stats: { errorCount: 0 } },
      analysis: { summary: 'The turn lands.' },
    });
  });
});

describe('reviewSeriesTeleplay', () => {
  it('reviews all expanded episodes together and returns per-episode structure', async () => {
    const { loomId, episodeId } = await setup();
    runStagedLLM.mockResolvedValueOnce({ content: generatedGraph(), runId: 'expand-1' });
    await weaveEpisode(loomId, episodeId, {});
    const second = await addEpisode(loomId, { title: 'Second', synopsis: 'The consequence.' });
    runStagedLLM.mockResolvedValueOnce({ content: generatedGraph(), runId: 'expand-2' });
    await weaveEpisode(loomId, second.episodes[1].id, {});
    runStagedLLM.mockResolvedValueOnce({
      content: { summary: 'The series escalates.', strengths: ['The protagonist changes.'], risks: [], recommendations: [] },
      runId: 'teleplay-review-run',
    });

    const result = await reviewSeriesTeleplay(loomId, {});
    expect(result).toMatchObject({
      runId: 'teleplay-review-run',
      structural: [
        { episodeId, episodeNumber: 1 },
        { episodeNumber: 2 },
      ],
      analysis: { summary: 'The series escalates.' },
    });
    expect(runStagedLLM.mock.calls[2][0]).toBe('fableloom-review-series-teleplay');
    expect(runStagedLLM.mock.calls[2][1].teleplayDigest).toContain('## Episode 1: Pilot');
  });

  it('refuses a full-series review while an episode has not expanded', async () => {
    const { loomId } = await setup();
    await expect(reviewSeriesTeleplay(loomId, {})).rejects.toMatchObject({ code: 'TELEPLAY_INCOMPLETE' });
    expect(runStagedLLM).not.toHaveBeenCalled();
  });
});

describe('branchNode', () => {
  it('adds new scenes wired as transitions from the source node', async () => {
    const { loomId, episodeId } = await setup();
    const withNode = await addNode(loomId, episodeId, { title: 'The Gate', prose: 'You stand before it.' });
    const nodeId = withNode.episodes[0].nodes[0].id;

    runStagedLLM.mockResolvedValue({
      content: {
        branches: [
          { intent: 'scale the wall', triggers: ['climb'], description: 'Up and over.', node: { title: 'The Wall', prose: 'Cold stone.' } },
          { intent: 'bribe the guard', node: { title: 'A Deal', prose: 'He smiles.', isEnding: true, endingLabel: 'Bought passage' } },
          'garbage',
        ],
      },
      runId: 'run-3',
    });

    const { loom } = await branchNode(loomId, episodeId, nodeId, { branchCount: 2 });
    const ep = loom.episodes[0];
    expect(ep.nodes).toHaveLength(3);
    const source = ep.nodes.find((n) => n.id === nodeId);
    expect(source.playbackMode).toBe('decision');
    expect(source.transitions.map((t) => t.intent)).toEqual(['scale the wall', 'bribe the guard']);
    const ending = ep.nodes.find((n) => n.title === 'A Deal');
    expect(ending).toMatchObject({ isEnding: true, endingLabel: 'Bought passage' });
    expect(ep.nodes.filter((n) => n.id !== nodeId).every((n) => n.playbackMode === 'decision')).toBe(true);
  });

  it('rejects when the model returns no usable branches', async () => {
    const { loomId, episodeId } = await setup();
    const withNode = await addNode(loomId, episodeId, { title: 'A' });
    runStagedLLM.mockResolvedValue({ content: { branches: [] }, runId: 'r' });
    await expect(branchNode(loomId, episodeId, withNode.episodes[0].nodes[0].id, {}))
      .rejects.toMatchObject({ code: 'AI_RESPONSE_INVALID' });
  });

  it('does not create audience branches while a helper story is disconnected', async () => {
    const { loomId, episodeId } = await setup();
    await updateLoom(loomId, {
      participationMode: 'helper',
      audienceCommunicationMedium: 'A pocket radio.',
    });
    const withNode = await addNode(loomId, episodeId, { title: 'Silent opening', audienceConnection: 'disconnected' });

    await expect(branchNode(loomId, episodeId, withNode.episodes[0].nodes[0].id, {}))
      .rejects.toMatchObject({ code: 'AUDIENCE_DISCONNECTED' });
    expect(runStagedLLM).not.toHaveBeenCalled();
  });
});

describe('reviewEpisode', () => {
  it('combines structural analysis with sanitized LLM findings', async () => {
    const { loomId, episodeId } = await setup();
    const withNode = await addNode(loomId, episodeId, { title: 'Lone scene' }); // dead end → structural error
    const nodeId = withNode.episodes[0].nodes[0].id;
    runStagedLLM.mockResolvedValue({
      content: {
        summary: 'Thin.',
        findings: [
          { severity: 'high', nodeId, problem: 'Only one scene', suggestion: 'Branch it' },
          { severity: 'nonsense', nodeId: 'node-unknown', problem: 'Vague', suggestion: '' },
          { problem: null },
        ],
      },
      runId: 'run-4',
    });

    const result = await reviewEpisode(loomId, episodeId, {});
    expect(result.structural.stats.errorCount).toBeGreaterThan(0);
    expect(result.review.summary).toBe('Thin.');
    expect(result.review.findings).toEqual([
      { severity: 'high', nodeId, problem: 'Only one scene', suggestion: 'Branch it' },
      { severity: 'medium', nodeId: null, problem: 'Vague', suggestion: '' },
    ]);
  });
});

describe('feedbackEpisode', () => {
  it('reports the provider and shell lifecycle for an in-page operation', async () => {
    const { loomId, episodeId } = await setup();
    const events = [];
    const handle = (event) => events.push(event);
    aiStatusEvents.on('status', handle);
    runStagedLLM.mockImplementation(async (_stage, _variables, options) => {
      options.onRunCreated('run-feedback', {
        providerId: 'codex-tui', providerName: 'Codex TUI', model: 'gpt-test', providerType: 'tui',
      });
      options.onRunReady({
        runId: 'run-feedback', providerId: 'codex-tui', providerName: 'Codex TUI',
        model: 'gpt-test', providerType: 'tui', shellReady: true,
      });
      options.onRunSettled('run-feedback');
      return { content: { title: 'Revised' }, runId: 'run-feedback' };
    });

    await feedbackEpisode(loomId, episodeId, {
      feedback: 'Revise the title.', operationId: '00000000-0000-4000-8000-000000000042',
    });
    aiStatusEvents.off('status', handle);

    expect(events.map((event) => event.phase)).toEqual(['start', 'running', 'ready', 'applying', 'complete']);
    expect(events.find((event) => event.phase === 'ready')).toMatchObject({
      runId: 'run-feedback', shellReady: true, operationId: '00000000-0000-4000-8000-000000000042',
    });
  });

  it('applies sparse metadata, scene, and existing-path edits without changing ids', async () => {
    const { loomId, episodeId } = await setup();
    let updated = await addNode(loomId, episodeId, { title: 'The Gate', prose: 'You wait.' });
    const gate = updated.episodes[0].nodes[0];
    updated = await addNode(loomId, episodeId, {
      title: 'Inside', prose: 'Torchlight.', fromNodeId: gate.id, fromIntent: 'enter',
    });
    const inside = updated.episodes[0].nodes.find((node) => node.title === 'Inside');
    const transitionId = (await getLoom(loomId)).episodes[0].nodes[0].transitions[0].id;
    runStagedLLM.mockImplementation(async (stage, variables, options) => {
      expect(stage).toBe('fableloom-feedback-episode');
      expect(variables.feedback).toBe('Make the opening more urgent.');
      expect(options).toMatchObject({
        providerOverride: 'writer', modelOverride: 'writer-large', effortOverride: 'high',
      });
      return {
        content: {
          title: 'The Gate at Midnight',
          synopsis: '',
          scenes: [{
            id: gate.id,
            prose: 'The lock clicks before you touch it.',
            transitions: [{ id: transitionId, intent: 'cross the threshold', triggers: ['go in'], description: 'Enter.' }],
          }],
        },
        runId: 'feedback-run',
      };
    });

    const result = await feedbackEpisode(loomId, episodeId, {
      feedback: ' Make the opening more urgent. ',
      providerId: 'writer', model: 'writer-large', effort: 'high',
    });
    const episode = result.loom.episodes[0];
    const revisedGate = episode.nodes.find((node) => node.id === gate.id);
    expect(result).toMatchObject({ episodeId, changedScenes: 1, runId: 'feedback-run' });
    expect(episode.title).toBe('The Gate at Midnight');
    expect(episode.synopsis).toBe('');
    expect(revisedGate).toMatchObject({ id: gate.id, prose: 'The lock clicks before you touch it.' });
    expect(revisedGate.transitions).toEqual([expect.objectContaining({ id: transitionId, intent: 'cross the threshold' })]);
    expect(episode.nodes.map((node) => node.id)).toEqual([gate.id, inside.id]);
    expect(episode.nodes.find((node) => node.id === inside.id).prose).toBe('Torchlight.');
  });

  it('preserves authored values when the model omits them and rejects unusable edits', async () => {
    const { loomId, episodeId } = await setup();
    const withNode = await addNode(loomId, episodeId, { title: 'Opening', prose: 'Original.' });
    runStagedLLM.mockResolvedValueOnce({ content: { scenes: [{ id: 'node-unknown', prose: 'Nope.' }] } });
    await expect(feedbackEpisode(loomId, episodeId, { feedback: 'Make it better.' }))
      .rejects.toMatchObject({ code: 'AI_RESPONSE_INVALID' });
    expect((await getLoom(loomId)).episodes[0].nodes[0]).toMatchObject({
      id: withNode.episodes[0].nodes[0].id, title: 'Opening', prose: 'Original.',
    });
  });

  it('preserves playback mode when feedback returns an invalid placeholder', async () => {
    const { loomId, episodeId } = await setup();
    const withNode = await addNode(loomId, episodeId, {
      title: 'Opening', playbackMode: 'cut', cameraMovement: 'slow-dolly-in',
    });
    const nodeId = withNode.episodes[0].nodes[0].id;
    runStagedLLM.mockResolvedValue({
      content: { scenes: [{
        id: nodeId,
        playbackMode: 'cut or decision, only when changed',
        cameraMovement: 'slow-dolly-in, only when changed',
        title: 'Revised',
      }] },
    });

    const result = await feedbackEpisode(loomId, episodeId, { feedback: 'Revise the title.' });

    expect(result.loom.episodes[0].nodes[0]).toMatchObject({
      title: 'Revised', playbackMode: 'cut', cameraMovement: 'slow-dolly-in',
    });
  });
});

describe('playTurn', () => {
  const playSetup = async () => {
    const { loomId, episodeId } = await setup();
    let updated = await addNode(loomId, episodeId, { title: 'The Gate', prose: 'You stand before it.' });
    const gateId = updated.episodes[0].nodes[0].id;
    updated = await addNode(loomId, episodeId, { title: 'Inside', prose: 'Torchlight.', fromNodeId: gateId, fromIntent: 'enter the gate' });
    const insideId = updated.episodes[0].nodes.find((n) => n.title === 'Inside').id;
    await updateNode(loomId, episodeId, insideId, { isEnding: true, endingLabel: 'Within' });
    const gate = (await getLoom(loomId)).episodes[0].nodes.find((n) => n.id === gateId);
    return { loomId, episodeId, gate, insideId };
  };

  it('moves through the matched transition and flags endings', async () => {
    const { loomId, episodeId, gate, insideId } = await playSetup();
    runStagedLLM.mockResolvedValue({
      content: { action: 'move', transitionId: gate.transitions[0].id, narration: 'You step through.' },
    });

    const result = await playTurn(loomId, episodeId, { nodeId: gate.id, message: 'go inside' });
    expect(result).toMatchObject({
      action: 'move', narration: 'You step through.', ended: true,
    });
    expect(result.node).toMatchObject({ id: insideId, isEnding: true, endingLabel: 'Within' });
    // Reader-facing shape: choices carry intents only, no trigger phrases.
    expect(result.node.choices).toEqual([]);

    const [stage, variables] = runStagedLLM.mock.calls[0];
    expect(stage).toBe('fableloom-play-turn');
    expect(variables.readerMessage).toBe('go inside');
    expect(variables.choicesDigest).toContain('enter the gate');
  });

  it('stays in place when the model declines or names an invalid transition', async () => {
    const { loomId, episodeId, gate } = await playSetup();
    runStagedLLM.mockResolvedValue({ content: { action: 'move', transitionId: 'tr-bogus', narration: 'Hmm.' } });
    const result = await playTurn(loomId, episodeId, { nodeId: gate.id, message: 'fly to the moon' });
    expect(result).toMatchObject({ action: 'stay', ended: false });
    expect(result.node.id).toBe(gate.id);
  });

  it('short-circuits on ending nodes without calling the LLM', async () => {
    const { loomId, episodeId, insideId } = await playSetup();
    const result = await playTurn(loomId, episodeId, { nodeId: insideId, message: 'now what' });
    expect(result).toMatchObject({ action: 'stay', ended: true });
    expect(runStagedLLM).not.toHaveBeenCalled();
  });

  it('takes a named transition off the graph with no LLM call at all', async () => {
    const { loomId, episodeId, gate, insideId } = await playSetup();
    const result = await playTurn(loomId, episodeId, {
      nodeId: gate.id, transitionId: gate.transitions[0].id,
    });
    expect(result).toMatchObject({
      action: 'move', resolvedBy: 'choice', narration: '', ended: true,
    });
    expect(result.node.id).toBe(insideId);
    expect(runStagedLLM).not.toHaveBeenCalled();
  });

  it('locks typed audience input out while a helper channel is disconnected but permits canon advance', async () => {
    const { loomId, episodeId, gate: originalGate, insideId } = await playSetup();
    await updateLoom(loomId, {
      participationMode: 'helper',
      audienceCommunicationMedium: 'A pocket radio.',
    });
    await updateNode(loomId, episodeId, originalGate.id, {
      playbackMode: 'cut', audienceConnection: 'disconnected',
    });
    // `elsewhereId` deliberately targets a DIFFERENT node than transitions[0]
    // (insideId): a non-interactive scene resolves via the graph's own first
    // transition, not the caller's requested transitionId, and asserting
    // against insideId only pins that if the alternate path leads somewhere
    // else — otherwise both paths land on the same node and the assertion
    // can't distinguish "used transitions[0]" from "honored transitionId".
    const withElsewhere = await addNode(loomId, episodeId, { title: 'Elsewhere', prose: 'Fog.', fromNodeId: originalGate.id, fromIntent: 'go the other way' });
    const elsewhereId = withElsewhere.episodes[0].nodes.find((n) => n.title === 'Elsewhere').id;
    await mutateLoom(loomId, (loom) => {
      const gate = loom.episodes[0].nodes.find((node) => node.id === originalGate.id);
      gate.transitions = gate.transitions.filter((t) => t.targetNodeId !== elsewhereId);
      gate.transitions.push({ id: 'alternate-path', targetNodeId: elsewhereId, intent: 'Choose a different route' });
      return loom;
    });
    const gate = (await getLoom(loomId)).episodes[0].nodes.find((node) => node.id === originalGate.id);
    expect(gate.transitions[0].targetNodeId).toBe(insideId);

    await expect(playTurn(loomId, episodeId, { nodeId: gate.id, message: 'Can you hear me?' }))
      .rejects.toMatchObject({ code: 'AUDIENCE_DISCONNECTED' });
    const advanced = await playTurn(loomId, episodeId, {
      nodeId: gate.id, transitionId: 'alternate-path',
    });
    expect(advanced).toMatchObject({ action: 'move', resolvedBy: 'graph' });
    expect(advanced.node.id).toBe(insideId);
    expect(runStagedLLM).not.toHaveBeenCalled();
  });

  it('rejects a transition id that is not on the current scene', async () => {
    const { loomId, episodeId, gate } = await playSetup();
    await expect(playTurn(loomId, episodeId, { nodeId: gate.id, transitionId: 'tr-bogus' }))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_TRANSITION' });
    expect(runStagedLLM).not.toHaveBeenCalled();
  });

  it("routes typed input through the loom's saved play settings, and lets a per-call pick win", async () => {
    const { loomId, episodeId, gate } = await playSetup();
    await updateLoom(loomId, { playSettings: { providerId: 'claude', model: 'opus', effort: 'high' } });
    runStagedLLM.mockResolvedValue({ content: { action: 'stay', narration: 'Hmm.' } });

    await playTurn(loomId, episodeId, { nodeId: gate.id, message: 'look around' });
    expect(runStagedLLM.mock.calls[0][2]).toMatchObject({
      providerOverride: 'claude', modelOverride: 'opus', effortOverride: 'high',
    });

    // Switching providers per call drops the pinned model and effort with it —
    // both belong to the provider they were picked for.
    await playTurn(loomId, episodeId, { nodeId: gate.id, message: 'look around', providerId: 'codex' });
    expect(runStagedLLM.mock.calls[1][2]).toMatchObject({ providerOverride: 'codex' });
    expect(runStagedLLM.mock.calls[1][2].modelOverride).toBeUndefined();
    expect(runStagedLLM.mock.calls[1][2].effortOverride).toBeUndefined();

    // ...but naming the same provider keeps them.
    await playTurn(loomId, episodeId, { nodeId: gate.id, message: 'look around', providerId: 'claude' });
    expect(runStagedLLM.mock.calls[2][2]).toMatchObject({
      providerOverride: 'claude', modelOverride: 'opus', effortOverride: 'high',
    });

    // A per-call model beats the pinned one outright.
    await playTurn(loomId, episodeId, { nodeId: gate.id, message: 'look around', model: 'sonnet' });
    expect(runStagedLLM.mock.calls[3][2]).toMatchObject({
      providerOverride: 'claude', modelOverride: 'sonnet', effortOverride: 'high',
    });
  });

  it("renders the loom's format into the narration contract", async () => {
    const { loomId, episodeId, gate } = await playSetup();
    await updateLoom(loomId, { format: 'teleplay' });
    runStagedLLM.mockResolvedValue({ content: { action: 'stay', narration: 'Hmm.' } });
    await playTurn(loomId, episodeId, { nodeId: gate.id, message: 'look around' });
    const [, variables] = runStagedLLM.mock.calls[0];
    expect(variables.narrationFormatContract).toContain('teleplay');
    expect(variables.storyContext).toContain('teleplay');
  });
});

describe('reformatEpisodeScenes', () => {
  const proseSetup = async () => {
    const { loomId, episodeId } = await setup();
    let updated = await addNode(loomId, episodeId, { title: 'The Gate', prose: 'You stand before it.' });
    const gateId = updated.episodes[0].nodes[0].id;
    updated = await addNode(loomId, episodeId, { title: 'Inside', prose: 'Torchlight.', fromNodeId: gateId, fromIntent: 'enter' });
    const insideId = updated.episodes[0].nodes.find((n) => n.title === 'Inside').id;
    return { loomId, episodeId, gateId, insideId };
  };

  it('rewrites every returned scene, pins the format, and leaves the graph alone', async () => {
    const { loomId, episodeId, gateId, insideId } = await proseSetup();
    runStagedLLM.mockImplementation(async (stage, variables) => ({
      content: {
        scenes: JSON.parse(variables.scenesJson).map((sc) => ({ id: sc.id, prose: `INT. GATE - NIGHT\n\n${sc.prose}` })),
      },
      runId: 'run-1',
    }));

    const result = await reformatEpisodeScenes(loomId, episodeId, { format: 'teleplay' });
    expect(result).toMatchObject({ format: 'teleplay', rewritten: 2 });
    expect(result.loom.format).toBe('teleplay');
    const nodes = result.loom.episodes[0].nodes;
    expect(nodes.find((n) => n.id === gateId).prose).toContain('INT. GATE - NIGHT');
    expect(nodes.find((n) => n.id === insideId).prose).toContain('Torchlight.');
    // The rewrite is text-only: the authored edges survive it.
    expect(nodes.find((n) => n.id === gateId).transitions[0].targetNodeId).toBe(insideId);
    const [stage, variables] = runStagedLLM.mock.calls[0];
    expect(stage).toBe('fableloom-reformat-scenes');
    expect(variables.sceneFormatContract).toContain('slugline');
  });

  it('counts only scenes it actually wrote, not every id the model echoed back', async () => {
    const { loomId, episodeId, gateId, insideId } = await proseSetup();
    // Ids that are not in the batch: invented, or from another episode. The
    // write applies none of them, so neither may be counted as rewritten.
    runStagedLLM.mockResolvedValue({
      content: { scenes: [{ id: 'node-invented', prose: 'INT. NOWHERE' }, { id: gateId, prose: 'INT. GATE' }] },
    });
    const result = await reformatEpisodeScenes(loomId, episodeId, { format: 'teleplay' });
    expect(result.rewritten).toBe(1);
    const nodes = result.loom.episodes[0].nodes;
    expect(nodes.find((n) => n.id === gateId).prose).toBe('INT. GATE');
    expect(nodes.find((n) => n.id === insideId).prose).toBe('Torchlight.');
  });

  it('leaves the format pin alone when the rewrite never landed a scene', async () => {
    const { loomId, episodeId } = await proseSetup();
    runStagedLLM.mockRejectedValue(new Error('provider unreachable'));
    await expect(reformatEpisodeScenes(loomId, episodeId, { format: 'teleplay' })).rejects.toThrow('provider unreachable');
    // Pinning before the rewrite would leave every later weave/branch/play
    // generating teleplay against a story still written as prose.
    expect((await getLoom(loomId)).format).toBe('prose');

    runStagedLLM.mockReset().mockResolvedValue({ content: { scenes: [] } });
    await expect(reformatEpisodeScenes(loomId, episodeId, { format: 'teleplay' })).rejects.toMatchObject({ code: 'AI_RESPONSE_INVALID' });
    expect((await getLoom(loomId)).format).toBe('prose');
  });

  it('persists each chunk as it lands, so a later failure keeps the earlier work', async () => {
    const { loomId, episodeId } = await setup();
    // Six scenes = two chunks; the second one fails.
    for (let i = 0; i < 6; i += 1) {
      await addNode(loomId, episodeId, { title: `Scene ${i}`, prose: `Prose ${i}.` });
    }
    let call = 0;
    runStagedLLM.mockImplementation(async (stage, variables) => {
      call += 1;
      if (call > 1) throw new Error('provider died mid-run');
      return { content: { scenes: JSON.parse(variables.scenesJson).map((sc) => ({ id: sc.id, prose: `INT. ${sc.prose}` })) } };
    });
    await expect(reformatEpisodeScenes(loomId, episodeId, { format: 'teleplay' })).rejects.toThrow('provider died mid-run');

    const nodes = (await getLoom(loomId)).episodes[0].nodes;
    expect(nodes.slice(0, 5).every((n) => n.prose.startsWith('INT. '))).toBe(true);
    expect(nodes[5].prose).toBe('Prose 5.');
  });

  it('skips title-only scenes rather than asking the model to invent them', async () => {
    const { loomId, episodeId } = await setup();
    await addNode(loomId, episodeId, { title: 'Written', prose: 'You stand before it.' });
    await addNode(loomId, episodeId, { title: 'Placeholder with no prose yet' });
    runStagedLLM.mockImplementation(async (stage, variables) => ({
      content: { scenes: JSON.parse(variables.scenesJson).map((sc) => ({ id: sc.id, prose: 'INT. SOMEWHERE' })) },
    }));

    const result = await reformatEpisodeScenes(loomId, episodeId, { format: 'teleplay' });
    expect(result.rewritten).toBe(1);
    const sent = JSON.parse(runStagedLLM.mock.calls[0][1].scenesJson);
    expect(sent).toHaveLength(1);
    expect(result.loom.episodes[0].nodes.find((n) => n.title.startsWith('Placeholder')).prose).toBe('');
  });

  it('stops at the per-request ceiling, flags it, and continues where it stopped', async () => {
    const { loomId, episodeId } = await setup();
    // The ceiling is 4 chunks x 5 scenes = 20 per request. 25 scenes takes two
    // requests: the first sends 20 and reports 5 it never got to.
    await mutateLoom(loomId, (current) => {
      const ep = current.episodes.find((e) => e.id === episodeId);
      ep.nodes = Array.from({ length: 25 }, (_, i) => ({
        id: `node-ceiling-${i}`, title: `Scene ${i}`, prose: `Prose ${i}.`, transitions: [],
      }));
      return current;
    });
    runStagedLLM.mockImplementation(async (stage, variables) => ({
      content: { scenes: JSON.parse(variables.scenesJson).map((sc) => ({ id: sc.id, prose: `INT. ${sc.prose}` })) },
    }));

    const first = await reformatEpisodeScenes(loomId, episodeId, { format: 'teleplay' });
    expect(runStagedLLM.mock.calls).toHaveLength(4);
    expect(first).toMatchObject({ rewritten: 20, episodeRemaining: 5, remaining: 5, capped: true });
    // The loom is NOT pinned yet — 5 scenes are still prose.
    expect(first.loom.format).toBe('prose');

    const second = await reformatEpisodeScenes(loomId, episodeId, { format: 'teleplay' });
    // Only the one leftover chunk is re-sent; the 20 already converted are skipped.
    expect(runStagedLLM.mock.calls).toHaveLength(5);
    expect(second).toMatchObject({ rewritten: 5, episodeRemaining: 0, remaining: 0, capped: false });
    expect(second.loom.format).toBe('teleplay');
    const allNodes = second.loom.episodes.flatMap((e) => e.nodes);
    expect(allNodes).toHaveLength(25);
    expect(allNodes.every((n) => n.prose.startsWith('INT. '))).toBe(true);
    expect(allNodes.every((n) => n.format === 'teleplay')).toBe(true);
  });

  it('does not flag a run as capped when the model, not the ceiling, left scenes behind', async () => {
    const { loomId, episodeId, gateId } = await proseSetup();
    // One of two scenes comes back. Nothing went unsent, so re-requesting would
    // only re-send a refusal — the caller must NOT loop on this.
    runStagedLLM.mockResolvedValue({ content: { scenes: [{ id: gateId, prose: 'INT. GATE' }] } });
    const result = await reformatEpisodeScenes(loomId, episodeId, { format: 'teleplay' });
    expect(result).toMatchObject({ rewritten: 1, episodeRemaining: 1, capped: false });
  });

  it('holds the loom pin until EVERY episode is converted, not just the one it rewrote', async () => {
    const { loomId, episodeId } = await proseSetup();
    const withEp2 = await addEpisode(loomId, { title: 'Two' });
    const episode2Id = withEp2.episodes[1].id;
    await addNode(loomId, episode2Id, { title: 'Elsewhere', prose: 'Rain on the roof.' });
    runStagedLLM.mockImplementation(async (stage, variables) => ({
      content: { scenes: JSON.parse(variables.scenesJson).map((sc) => ({ id: sc.id, prose: `INT. ${sc.prose}` })) },
    }));

    // Episode one is fully converted — but the loom still holds a prose scene in
    // episode two, and pinning here would point every later weave/branch/play at
    // a contract that scene isn't written in.
    const first = await reformatEpisodeScenes(loomId, episodeId, { format: 'teleplay' });
    expect(first).toMatchObject({ rewritten: 2, episodeRemaining: 0, remaining: 1 });
    expect(first.loom.format).toBe('prose');

    const second = await reformatEpisodeScenes(loomId, episode2Id, { format: 'teleplay' });
    expect(second).toMatchObject({ rewritten: 1, episodeRemaining: 0, remaining: 0 });
    expect(second.loom.format).toBe('teleplay');
  });

  it('is a no-op on an episode with nothing left to convert, and still pins the loom', async () => {
    const { loomId, episodeId } = await proseSetup();
    runStagedLLM.mockImplementation(async (stage, variables) => ({
      content: { scenes: JSON.parse(variables.scenesJson).map((sc) => ({ id: sc.id, prose: `INT. ${sc.prose}` })) },
    }));
    await reformatEpisodeScenes(loomId, episodeId, { format: 'teleplay' });
    const callsAfterFirst = runStagedLLM.mock.calls.length;

    // The caller walks every episode; one already converted must not cost a
    // provider call, and must not be mistaken for "the model returned nothing".
    const again = await reformatEpisodeScenes(loomId, episodeId, { format: 'teleplay' });
    expect(runStagedLLM.mock.calls).toHaveLength(callsAfterFirst);
    expect(again).toMatchObject({ rewritten: 0, remaining: 0, capped: false });
    expect(again.loom.format).toBe('teleplay');
  });

  it('404s on an episode that is not in the loom', async () => {
    const { loomId } = await proseSetup();
    await expect(reformatEpisodeScenes(loomId, 'ep-not-here', { format: 'teleplay' }))
      .rejects.toMatchObject({ status: 404 });
    expect(runStagedLLM).not.toHaveBeenCalled();
  });

  it('reports scenes the model dropped as remaining, and holds the pin back', async () => {
    const { loomId, episodeId, gateId, insideId } = await proseSetup();
    // The model returns one of the two scenes it was given. The run is under
    // the chunk ceiling, so nothing but the dropped scene is left over.
    runStagedLLM.mockResolvedValue({ content: { scenes: [{ id: gateId, prose: 'INT. GATE' }] } });

    const result = await reformatEpisodeScenes(loomId, episodeId, { format: 'teleplay' });
    expect(result).toMatchObject({ rewritten: 1, remaining: 1 });
    // Claiming teleplay here would point every later weave/branch/play at a
    // contract the untouched scene isn't written in.
    expect(result.loom.format).toBe('prose');
    expect(result.loom.episodes[0].nodes.find((n) => n.id === insideId).format).toBeNull();

    // Finishing the job pins it.
    runStagedLLM.mockResolvedValue({ content: { scenes: [{ id: insideId, prose: 'INT. INSIDE' }] } });
    const done = await reformatEpisodeScenes(loomId, episodeId, { format: 'teleplay' });
    expect(done).toMatchObject({ rewritten: 1, remaining: 0 });
    expect(done.loom.format).toBe('teleplay');
  });

  it('asks the model for the TARGET format, not the one the loom still holds', async () => {
    const { loomId, episodeId } = await proseSetup();
    runStagedLLM.mockImplementation(async (stage, variables) => ({
      content: { scenes: JSON.parse(variables.scenesJson).map((sc) => ({ id: sc.id, prose: 'INT. GATE' })) },
    }));
    await reformatEpisodeScenes(loomId, episodeId, { format: 'teleplay' });
    const [, variables] = runStagedLLM.mock.calls[0];
    // Asserting the source format here as fact would contradict the template's
    // own "Target format" heading in the same prompt.
    expect(variables.storyContext).toContain('teleplay');
    expect(variables.storyContext).not.toContain('narrated prose');
  });

  it('ignores scenes the model dropped or blanked, and fails when it returns none', async () => {
    const { loomId, episodeId, gateId, insideId } = await proseSetup();
    runStagedLLM.mockResolvedValue({ content: { scenes: [{ id: gateId, prose: 'INT. GATE' }, { id: insideId, prose: '   ' }] } });
    const kept = await reformatEpisodeScenes(loomId, episodeId, { format: 'teleplay' });
    expect(kept.rewritten).toBe(1);
    expect(kept.loom.episodes[0].nodes.find((n) => n.id === insideId).prose).toBe('Torchlight.');

    runStagedLLM.mockResolvedValue({ content: { scenes: [] } });
    await expect(reformatEpisodeScenes(loomId, episodeId, { format: 'prose' }))
      .rejects.toMatchObject({ code: 'AI_RESPONSE_INVALID' });
  });
});

describe('buildCanonDigest', () => {
  it('renders linked-universe canon via the shared renderer and returns empty for unlinked looms', async () => {
    getUniverseMock.mockResolvedValue({
      characters: [{ name: 'Mara', description: 'silver-eyed courier' }],
      places: [{ name: 'The Hollow' }],
      objects: [],
    });
    const digest = await buildCanonDigest({ universeId: 'uni-1' });
    expect(digest).toContain('characters:');
    expect(digest).toContain('- Mara');
    expect(digest).toContain('places:');
    expect(digest).not.toContain('objects:');

    expect(await buildCanonDigest({ universeId: null })).toBe('');
  });
});

describe('series plan AI', () => {
  it('drafts and persists a complete scaffold while preserving episode records', async () => {
    const { loomId, episodeId } = await setup();
    getUniverseMock.mockResolvedValueOnce({
      characters: [{ name: 'Mara', description: 'a courier who fears command' }],
    });
    runStagedLLM.mockResolvedValueOnce({
      content: {
        storyArc: 'Mara accepts responsibility for the city she once fled.',
        plotPoints: [
          { title: 'The summons', description: 'The crown chooses Mara.', episodeId },
          { title: 'The false road', description: 'A tempting escape closes.', episodeId: 'invented-episode' },
        ],
        sideQuests: [{
          title: 'The missing map', description: 'A rival becomes an ally.', status: 'planned',
          startEpisodeId: episodeId, endEpisodeId: null,
        }],
      },
      runId: 'run-draft',
    });

    const result = await generateSeriesPlan(loomId, {
      providerId: 'writer', model: 'large', effort: 'high',
    });

    expect(result.runId).toBe('run-draft');
    expect(result.loom.seriesPlan.storyArc).toContain('accepts responsibility');
    expect(result.loom.seriesPlan.plotPoints).toHaveLength(2);
    expect(result.loom.seriesPlan.plotPoints.every((item) => item.id.startsWith('plot-'))).toBe(true);
    expect(result.loom.seriesPlan.plotPoints[1].episodeId).toBeNull();
    expect(result.loom.seriesPlan.sideQuests[0]).toMatchObject({
      title: 'The missing map', startEpisodeId: episodeId,
    });
    expect(result.loom.episodes).toHaveLength(1);
    expect(result.loom.episodes[0]).toMatchObject({ id: episodeId, title: 'Pilot', synopsis: 'A crown wakes.' });
    expect(runStagedLLM).toHaveBeenCalledWith('fableloom-generate-series-plan', expect.objectContaining({
      storyContext: expect.stringContaining('The Hollow Crown'),
      canonDigest: expect.stringContaining('Mara'),
      seriesPlanJson: expect.stringContaining(episodeId),
    }), expect.objectContaining({
      providerOverride: 'writer', modelOverride: 'large', effortOverride: 'high',
    }));
  });

  it('rejects an incomplete generated scaffold without replacing the saved plan', async () => {
    const { loomId } = await setup();
    await updateLoom(loomId, { seriesPlan: {
      storyArc: 'Saved arc', plotPoints: [], sideQuests: [],
    } });
    runStagedLLM.mockResolvedValueOnce({
      content: { storyArc: 'Partial arc', plotPoints: [{ title: 'A beat' }], sideQuests: [] },
    });

    await expect(generateSeriesPlan(loomId)).rejects.toMatchObject({ code: 'AI_RESPONSE_INVALID' });
    expect((await getLoom(loomId)).seriesPlan.storyArc).toBe('Saved arc');
  });

  it('does not overwrite story inputs saved while the provider call is in flight', async () => {
    const { loomId } = await setup();
    let finishDraft;
    runStagedLLM.mockImplementationOnce(() => new Promise((resolve) => { finishDraft = resolve; }));
    const generation = generateSeriesPlan(loomId);
    await vi.waitFor(() => expect(runStagedLLM).toHaveBeenCalledOnce());
    await updateLoom(loomId, { premise: 'A newer premise saved during the draft.' });
    finishDraft({
      content: {
        storyArc: 'A stale arc.',
        plotPoints: [{ title: 'Old beat', description: 'Based on stale context.' }],
        sideQuests: [{ title: 'Old thread', description: 'Also stale.' }],
      },
    });

    await expect(generation).rejects.toMatchObject({ code: 'LOOM_CHANGED_DURING_GENERATION' });
    const current = await getLoom(loomId);
    expect(current.premise).toBe('A newer premise saved during the draft.');
    expect(current.seriesPlan.storyArc).toBe('');
  });

  it('returns normalized holistic analysis without mutating the loom', async () => {
    const { loomId } = await setup();
    runStagedLLM.mockResolvedValueOnce({
      content: { summary: 'Strong spine.', strengths: ['Clear goal'], risks: ['Late turn'], recommendations: ['Move the turn'] },
      runId: 'run-review',
    });
    const result = await reviewSeriesPlan(loomId, { providerId: 'writer' });
    expect(result).toEqual({
      analysis: { summary: 'Strong spine.', strengths: ['Clear goal'], risks: ['Late turn'], recommendations: ['Move the turn'] },
      runId: 'run-review',
    });
    expect(runStagedLLM).toHaveBeenCalledWith('fableloom-review-series-plan', expect.objectContaining({
      seriesPlanJson: expect.stringContaining('episodes'),
    }), expect.objectContaining({ providerOverride: 'writer' }));
  });

  it('applies sparse series-plan feedback and preserves omitted collections', async () => {
    const { loomId, episodeId } = await setup();
    await updateLoom(loomId, { seriesPlan: {
      storyArc: 'Old arc',
      plotPoints: [{ id: 'plot-1', title: 'Turn', description: 'Old', episodeId }],
      sideQuests: [],
    } });
    runStagedLLM.mockResolvedValueOnce({
      content: { storyArc: 'New arc', changes: ['Raised the stakes'] },
      runId: 'run-feedback',
    });
    const result = await feedbackSeriesPlan(loomId, { feedback: 'Raise the stakes.' });
    expect(result.loom.seriesPlan.storyArc).toBe('New arc');
    expect(result.loom.seriesPlan.plotPoints).toHaveLength(1);
    expect(result.changes).toEqual(['Raised the stakes']);
  });

  it('preserves plan items outside the AI digest and patches existing items by id', async () => {
    const { loomId, episodeId } = await setup();
    const plotPoints = Array.from({ length: 35 }, (_, index) => ({
      id: `plot-${index + 1}`, title: `Beat ${index + 1}`, description: `Purpose ${index + 1}`, episodeId,
    }));
    await updateLoom(loomId, { seriesPlan: { storyArc: 'Arc', plotPoints, sideQuests: [] } });
    runStagedLLM.mockResolvedValueOnce({
      content: { plotPointEdits: [{ id: 'plot-1', description: 'A sharper purpose.' }] },
      runId: 'run-feedback',
    });
    const result = await feedbackSeriesPlan(loomId, { feedback: 'Sharpen the opening beat.' });
    expect(result.loom.seriesPlan.plotPoints).toHaveLength(35);
    expect(result.loom.seriesPlan.plotPoints[0].description).toBe('A sharper purpose.');
    expect(result.loom.seriesPlan.plotPoints[34].title).toBe('Beat 35');
  });

  it('annotates and prioritizes episode-assigned plan beats in episode AI context', async () => {
    const { loomId, episodeId } = await setup();
    const manyBeats = Array.from({ length: 13 }, (_, index) => ({
      id: `plot-${index}`, title: `Beat ${index}`, description: '', episodeId: null,
    }));
    manyBeats.push({ id: 'plot-relevant', title: 'Episode turn', description: '', episodeId });
    await updateLoom(loomId, { seriesPlan: { storyArc: '', plotPoints: manyBeats, sideQuests: [] } });
    runStagedLLM.mockResolvedValueOnce({ content: generatedGraph(), runId: 'run-weave' });
    await weaveEpisode(loomId, episodeId, { replace: true });
    expect(runStagedLLM).toHaveBeenCalledWith('fableloom-weave-episode', expect.objectContaining({
      storyContext: expect.stringContaining('Plot point 1 [planned for Episode 1: Pilot]: Episode turn'),
    }), expect.anything());
  });

  it('carries enabled series delivery beats into episode context and preserves them during plan drafting', async () => {
    const { loomId, episodeId } = await setup();
    const delivery = {
      deliveryOptions: { overnightVoicemails: true, nextSeasonTeaser: true },
      interEpisodeVoicemails: [{
        id: 'vm-1', fromEpisodeId: episodeId, toEpisodeId: null,
        title: 'Night call', transcript: 'Keep the receiver warm.',
      }],
      nextSeasonTeaser: { title: 'Beyond', transcript: 'Something answers.' },
    };
    await updateLoom(loomId, { seriesPlan: {
      storyArc: 'A courier learns to listen.', plotPoints: [], sideQuests: [], ...delivery,
    } });
    runStagedLLM.mockResolvedValueOnce({ content: generatedGraph(), runId: 'run-weave-delivery' });
    await weaveEpisode(loomId, episodeId, {});
    expect(runStagedLLM.mock.calls[0][1].storyContext).toContain('authored overnight voicemail');
    expect(runStagedLLM.mock.calls[0][1].storyContext).toContain('Keep the receiver warm.');
  });

  it('tells episode expansion to frame unseen obstacles for off-screen helper scenes', async () => {
    const { loomId, episodeId } = await setup();
    runStagedLLM.mockResolvedValueOnce({ content: generatedGraph(), runId: 'run-offscreen-framing' });

    await weaveEpisode(loomId, episodeId, {});

    expect(runStagedLLM.mock.calls[0][1].storyContext)
      .toContain('frame the obstacle or space the protagonist cannot see');
    expect(runStagedLLM.mock.calls[0][1].storyContext)
      .toContain('never make a standalone comms device the subject');
  });
});
