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
vi.mock('../../lib/stageRunner.js', () => ({ runStagedLLM }));

const getUniverseMock = vi.hoisted(() => vi.fn(async () => null));
vi.mock('../universeBuilder.js', () => ({ getUniverse: getUniverseMock }));
// records.js validates soft refs at write time through these services.
const getSeriesMock = vi.hoisted(() => vi.fn(async () => null));
vi.mock('../pipeline/series.js', () => ({ getSeries: getSeriesMock }));

const { createLoom, addEpisode, addNode, mutateLoom, updateLoom, updateNode, getLoom } = await import('./records.js');
const { _resetFableLoomBackend } = await import('./store.js');
const {
  branchNode, buildCanonDigest, mapGeneratedGraph, playTurn, reformatLoom, reviewEpisode, weaveEpisode,
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
    expect(source.transitions.map((t) => t.intent)).toEqual(['scale the wall', 'bribe the guard']);
    const ending = ep.nodes.find((n) => n.title === 'A Deal');
    expect(ending).toMatchObject({ isEnding: true, endingLabel: 'Bought passage' });
  });

  it('rejects when the model returns no usable branches', async () => {
    const { loomId, episodeId } = await setup();
    const withNode = await addNode(loomId, episodeId, { title: 'A' });
    runStagedLLM.mockResolvedValue({ content: { branches: [] }, runId: 'r' });
    await expect(branchNode(loomId, episodeId, withNode.episodes[0].nodes[0].id, {}))
      .rejects.toMatchObject({ code: 'AI_RESPONSE_INVALID' });
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

describe('reformatLoom', () => {
  const proseSetup = async () => {
    const { loomId, episodeId } = await setup();
    let updated = await addNode(loomId, episodeId, { title: 'The Gate', prose: 'You stand before it.' });
    const gateId = updated.episodes[0].nodes[0].id;
    updated = await addNode(loomId, episodeId, { title: 'Inside', prose: 'Torchlight.', fromNodeId: gateId, fromIntent: 'enter' });
    const insideId = updated.episodes[0].nodes.find((n) => n.title === 'Inside').id;
    return { loomId, episodeId, gateId, insideId };
  };

  it('rewrites every returned scene, pins the format, and leaves the graph alone', async () => {
    const { loomId, gateId, insideId } = await proseSetup();
    runStagedLLM.mockImplementation(async (stage, variables) => ({
      content: {
        scenes: JSON.parse(variables.scenesJson).map((sc) => ({ id: sc.id, prose: `INT. GATE - NIGHT\n\n${sc.prose}` })),
      },
      runId: 'run-1',
    }));

    const result = await reformatLoom(loomId, { format: 'teleplay' });
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
    const { loomId, gateId, insideId } = await proseSetup();
    // Ids that are not in the batch: invented, or from another episode. The
    // write applies none of them, so neither may be counted as rewritten.
    runStagedLLM.mockResolvedValue({
      content: { scenes: [{ id: 'node-invented', prose: 'INT. NOWHERE' }, { id: gateId, prose: 'INT. GATE' }] },
    });
    const result = await reformatLoom(loomId, { format: 'teleplay' });
    expect(result.rewritten).toBe(1);
    const nodes = result.loom.episodes[0].nodes;
    expect(nodes.find((n) => n.id === gateId).prose).toBe('INT. GATE');
    expect(nodes.find((n) => n.id === insideId).prose).toBe('Torchlight.');
  });

  it('leaves the format pin alone when the rewrite never landed a scene', async () => {
    const { loomId } = await proseSetup();
    runStagedLLM.mockRejectedValue(new Error('provider unreachable'));
    await expect(reformatLoom(loomId, { format: 'teleplay' })).rejects.toThrow('provider unreachable');
    // Pinning before the rewrite would leave every later weave/branch/play
    // generating teleplay against a story still written as prose.
    expect((await getLoom(loomId)).format).toBe('prose');

    runStagedLLM.mockReset().mockResolvedValue({ content: { scenes: [] } });
    await expect(reformatLoom(loomId, { format: 'teleplay' })).rejects.toMatchObject({ code: 'AI_RESPONSE_INVALID' });
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
    await expect(reformatLoom(loomId, { format: 'teleplay' })).rejects.toThrow('provider died mid-run');

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

    const result = await reformatLoom(loomId, { format: 'teleplay' });
    expect(result.rewritten).toBe(1);
    const sent = JSON.parse(runStagedLLM.mock.calls[0][1].scenesJson);
    expect(sent).toHaveLength(1);
    expect(result.loom.episodes[0].nodes.find((n) => n.title.startsWith('Placeholder')).prose).toBe('');
  });

  it('stops at the per-request ceiling and genuinely finishes on the next run', async () => {
    const { loomId, episodeId } = await setup();
    // The ceiling is 40 chunks x 5 scenes = 200, and NODES_MAX caps ONE episode
    // at 200 — so only a multi-episode loom can reach it. Two episodes of 105
    // scenes = 42 chunks: the first run stops 2 chunks short.
    const withEp2 = await addEpisode(loomId, { title: 'Two' });
    const episode2Id = withEp2.episodes[1].id;
    await mutateLoom(loomId, (current) => {
      for (const [index, epId] of [episodeId, episode2Id].entries()) {
        const ep = current.episodes.find((e) => e.id === epId);
        ep.nodes = Array.from({ length: 105 }, (_, i) => ({
          id: `node-ceiling-${index}-${i}`, title: `Scene ${i}`, prose: `Prose ${index}-${i}.`, transitions: [],
        }));
      }
      return current;
    });
    runStagedLLM.mockImplementation(async (stage, variables) => ({
      content: { scenes: JSON.parse(variables.scenesJson).map((sc) => ({ id: sc.id, prose: `INT. ${sc.prose}` })) },
    }));

    const first = await reformatLoom(loomId, { format: 'teleplay' });
    expect(first).toMatchObject({ rewritten: 200, remaining: 10 });
    // The loom is NOT pinned yet — 5 scenes are still prose.
    expect(first.loom.format).toBe('prose');

    const callsAfterFirst = runStagedLLM.mock.calls.length;
    const second = await reformatLoom(loomId, { format: 'teleplay' });
    // Only the 2 leftover chunks are re-sent; the 200 already converted are skipped.
    expect(runStagedLLM.mock.calls.length - callsAfterFirst).toBe(2);
    expect(second).toMatchObject({ rewritten: 10, remaining: 0 });
    expect(second.loom.format).toBe('teleplay');
    const allNodes = second.loom.episodes.flatMap((e) => e.nodes);
    expect(allNodes).toHaveLength(210);
    expect(allNodes.every((n) => n.prose.startsWith('INT. '))).toBe(true);
    expect(allNodes.every((n) => n.format === 'teleplay')).toBe(true);
  });

  it('asks the model for the TARGET format, not the one the loom still holds', async () => {
    const { loomId } = await proseSetup();
    runStagedLLM.mockImplementation(async (stage, variables) => ({
      content: { scenes: JSON.parse(variables.scenesJson).map((sc) => ({ id: sc.id, prose: 'INT. GATE' })) },
    }));
    await reformatLoom(loomId, { format: 'teleplay' });
    const [, variables] = runStagedLLM.mock.calls[0];
    // Asserting the source format here as fact would contradict the template's
    // own "Target format" heading in the same prompt.
    expect(variables.storyContext).toContain('teleplay');
    expect(variables.storyContext).not.toContain('narrated prose');
  });

  it('ignores scenes the model dropped or blanked, and fails when it returns none', async () => {
    const { loomId, gateId, insideId } = await proseSetup();
    runStagedLLM.mockResolvedValue({ content: { scenes: [{ id: gateId, prose: 'INT. GATE' }, { id: insideId, prose: '   ' }] } });
    const kept = await reformatLoom(loomId, { format: 'teleplay' });
    expect(kept.rewritten).toBe(1);
    expect(kept.loom.episodes[0].nodes.find((n) => n.id === insideId).prose).toBe('Torchlight.');

    runStagedLLM.mockResolvedValue({ content: { scenes: [] } });
    await expect(reformatLoom(loomId, { format: 'prose' }))
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
