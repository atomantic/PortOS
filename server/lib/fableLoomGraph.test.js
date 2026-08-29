import { describe, it, expect } from 'vitest';
import {
  GRAPH_ISSUE_CODES,
  analyzeEpisodeGraph,
  computeGraphLayers,
  describeGraphForPrompt,
} from './fableLoomGraph.js';

const tr = (id, targetNodeId, intent, triggers = []) => ({ id, targetNodeId, intent, triggers });

// A small sound graph: start branches into two paths, one loops back once,
// both reach distinct endings.
const soundEpisode = () => ({
  id: 'ep-1',
  startNodeId: 'n1',
  nodes: [
    { id: 'n1', title: 'The Gate', prose: 'You stand before the gate.', transitions: [tr('t1', 'n2', 'enter the gate'), tr('t2', 'n3', 'walk away')] },
    { id: 'n2', title: 'Inside', prose: 'Torchlight.', transitions: [tr('t3', 'n4', 'press on'), tr('t4', 'n1', 'retreat')] },
    { id: 'n3', title: 'The Road Home', prose: 'Dust and regret.', isEnding: true, endingLabel: 'Turned back', transitions: [] },
    { id: 'n4', title: 'The Vault', prose: 'Gold everywhere.', isEnding: true, endingLabel: 'Treasure found', transitions: [] },
  ],
});

const issueCodes = (episode) => analyzeEpisodeGraph(episode).issues.map((i) => i.code);

describe('computeGraphLayers', () => {
  it('layers nodes by BFS depth from the start node', () => {
    const { layers, depthById } = computeGraphLayers(soundEpisode());
    expect(layers[0]).toEqual(['n1']);
    expect(layers[1]).toEqual(['n2', 'n3']);
    expect(layers[2]).toEqual(['n4']);
    expect(depthById.get('n4')).toBe(2);
  });

  it('returns empty layers when the start node is missing', () => {
    const ep = soundEpisode();
    ep.startNodeId = 'nope';
    const { layers, depthById } = computeGraphLayers(ep);
    expect(layers).toEqual([]);
    expect(depthById.size).toBe(0);
  });

  it('omits unreachable nodes', () => {
    const ep = soundEpisode();
    ep.nodes.push({ id: 'n9', title: 'Orphan', isEnding: true, transitions: [] });
    const { depthById } = computeGraphLayers(ep);
    expect(depthById.has('n9')).toBe(false);
  });
});

describe('analyzeEpisodeGraph', () => {
  it('reports a sound graph clean with accurate stats', () => {
    const { issues, stats } = analyzeEpisodeGraph(soundEpisode());
    expect(issues).toEqual([]);
    expect(stats).toMatchObject({
      nodeCount: 4,
      automaticCutCount: 0,
      decisionCount: 2,
      endingCount: 2,
      reachableCount: 4,
      reachableEndingCount: 2,
      maxDepth: 2,
      errorCount: 0,
      warningCount: 0,
    });
  });

  it('flags an empty episode', () => {
    expect(issueCodes({ id: 'ep', nodes: [] })).toContain(GRAPH_ISSUE_CODES.NO_NODES);
  });

  it('flags a missing start pointer and a start pointing at a deleted node', () => {
    const noStart = soundEpisode();
    delete noStart.startNodeId;
    expect(issueCodes(noStart)).toContain(GRAPH_ISSUE_CODES.MISSING_START);

    const badStart = soundEpisode();
    badStart.startNodeId = 'gone';
    expect(issueCodes(badStart)).toContain(GRAPH_ISSUE_CODES.START_NOT_FOUND);
  });

  it('flags a graph with no endings as an error', () => {
    const ep = soundEpisode();
    for (const n of ep.nodes) n.isEnding = false;
    ep.nodes[2].transitions = [tr('t9', 'n1', 'go back')];
    ep.nodes[3].transitions = [tr('t10', 'n1', 'go back')];
    expect(issueCodes(ep)).toContain(GRAPH_ISSUE_CODES.NO_ENDINGS);
  });

  it('flags a non-ending node with no way out as a dead end', () => {
    const ep = soundEpisode();
    ep.nodes[3].isEnding = false;
    const { issues } = analyzeEpisodeGraph(ep);
    const deadEnd = issues.find((i) => i.code === GRAPH_ISSUE_CODES.DEAD_END);
    expect(deadEnd).toMatchObject({ severity: 'error', nodeId: 'n4' });
  });

  it('requires an automatic cut to have exactly one next path', () => {
    const none = soundEpisode();
    none.nodes[0].playbackMode = 'cut';
    none.nodes[0].transitions = [];
    expect(issueCodes(none)).toContain(GRAPH_ISSUE_CODES.CUT_TRANSITION_COUNT);

    const many = soundEpisode();
    many.nodes[0].playbackMode = 'cut';
    expect(issueCodes(many)).toContain(GRAPH_ISSUE_CODES.CUT_TRANSITION_COUNT);

    const one = soundEpisode();
    one.nodes[0].playbackMode = 'cut';
    one.nodes[0].transitions = [tr('t1', 'n2', 'Continue')];
    expect(issueCodes(one)).not.toContain(GRAPH_ISSUE_CODES.CUT_TRANSITION_COUNT);
  });

  it('requires helper stories to connect near the opening and blocks disconnected decisions', () => {
    const neverConnected = soundEpisode();
    neverConnected.nodes[0].playbackMode = 'cut';
    neverConnected.nodes[0].transitions = [tr('t1', 'n2', 'Continue')];
    const disconnectedCodes = analyzeEpisodeGraph(neverConnected, {
      participationMode: 'helper', requireAudienceIntroduction: true,
    })
      .issues.map((issue) => issue.code);
    expect(disconnectedCodes).toContain(GRAPH_ISSUE_CODES.NO_AUDIENCE_CONNECTION);
    expect(disconnectedCodes).toContain(GRAPH_ISSUE_CODES.DISCONNECTED_DECISION);

    const connected = soundEpisode();
    connected.nodes[0].playbackMode = 'cut';
    connected.nodes[0].transitions = [tr('t1', 'n2', 'Continue')];
    connected.nodes[1].audienceConnection = 'connected';
    connected.nodes[1].playbackMode = 'decision';
    const connectedCodes = analyzeEpisodeGraph(connected, {
      participationMode: 'helper', requireAudienceIntroduction: true,
    })
      .issues.map((issue) => issue.code);
    expect(connectedCodes).not.toContain(GRAPH_ISSUE_CODES.NO_AUDIENCE_CONNECTION);
    expect(connectedCodes).not.toContain(GRAPH_ISSUE_CODES.DISCONNECTED_DECISION);
  });

  it('warns when a helper audience is not connected until after the opening sequence', () => {
    const nodes = Array.from({ length: 6 }, (_, index) => ({
      id: `n${index}`,
      title: `Scene ${index}`,
      playbackMode: index < 4 ? 'cut' : 'decision',
      audienceConnection: index === 4 ? 'connected' : 'disconnected',
      isEnding: index === 5,
      transitions: index === 5 ? [] : [tr(`t${index}`, `n${index + 1}`, 'Continue')],
    }));
    const { issues } = analyzeEpisodeGraph({ startNodeId: 'n0', nodes }, {
      participationMode: 'helper', requireAudienceIntroduction: true,
    });
    expect(issues).toContainEqual(expect.objectContaining({
      code: GRAPH_ISSUE_CODES.LATE_AUDIENCE_CONNECTION,
      severity: 'warning',
      nodeId: 'n4',
    }));
  });

  it('warns on unreachable nodes and errors when no ending is reachable', () => {
    const ep = soundEpisode();
    ep.nodes.push({ id: 'n9', title: 'Orphan', transitions: [tr('t9', 'n4', 'onward')] });
    const codes = issueCodes(ep);
    expect(codes).toContain(GRAPH_ISSUE_CODES.UNREACHABLE_NODE);

    // Cut both endings off from the start: n1 only reaches n2, which only loops back.
    const cut = soundEpisode();
    cut.nodes[0].transitions = [tr('t1', 'n2', 'enter')];
    cut.nodes[1].transitions = [tr('t4', 'n1', 'retreat')];
    expect(issueCodes(cut)).toContain(GRAPH_ISSUE_CODES.ENDING_UNREACHABLE);
  });

  it('errors on transitions pointing at deleted nodes and empty intents', () => {
    const ep = soundEpisode();
    ep.nodes[0].transitions.push(tr('t9', 'gone', 'leap into the void'));
    ep.nodes[1].transitions.push(tr('t10', 'n4', '   '));
    const codes = issueCodes(ep);
    expect(codes).toContain(GRAPH_ISSUE_CODES.DANGLING_TRANSITION);
    expect(codes).toContain(GRAPH_ISSUE_CODES.EMPTY_INTENT);
  });

  it('warns on duplicate intents, self-loops, and endings with outgoing paths', () => {
    const ep = soundEpisode();
    ep.nodes[0].transitions.push(tr('t9', 'n2', 'Enter The Gate')); // dup of t1, case-insensitive
    ep.nodes[1].transitions.push(tr('t10', 'n2', 'linger'));        // self-loop
    ep.nodes[2].transitions = [tr('t11', 'n1', 'change of heart')]; // ending with a way out
    const codes = issueCodes(ep);
    expect(codes).toContain(GRAPH_ISSUE_CODES.DUPLICATE_INTENT);
    expect(codes).toContain(GRAPH_ISSUE_CODES.SELF_LOOP);
    expect(codes).toContain(GRAPH_ISSUE_CODES.ENDING_WITH_TRANSITIONS);
    const { stats } = analyzeEpisodeGraph(ep);
    expect(stats.errorCount).toBe(0);
    expect(stats.warningCount).toBe(3);
  });
});

describe('describeGraphForPrompt', () => {
  it('renders nodes with flags, prose, and intent lines', () => {
    const text = describeGraphForPrompt(soundEpisode());
    expect(text).toContain('[n1] The Gate (START)');
    expect(text).toContain('[n4] The Vault (ENDING: Treasure found)');
    expect(text).not.toContain('The Vault (ENDING: Treasure found) (DECISION LOOP)');
    expect(text).toContain('-> [n2] intent "enter the gate"');
  });

  it('truncates long prose and video direction at proseLimit', () => {
    const ep = soundEpisode();
    ep.nodes[0].prose = 'x'.repeat(500);
    ep.nodes[0].videoPrompt = 'y'.repeat(500);
    const text = describeGraphForPrompt(ep, { proseLimit: 100 });
    expect(text).toContain(`${'x'.repeat(100)}…`);
    expect(text).toContain(`Video: ${'y'.repeat(100)}…`);
    expect(text).not.toContain('x'.repeat(101));
    expect(text).not.toContain('y'.repeat(101));
  });

  it('includes trigger examples', () => {
    const ep = soundEpisode();
    ep.nodes[0].transitions[0].triggers = ['go in', 'open the gate'];
    expect(describeGraphForPrompt(ep)).toContain('(triggers: go in; open the gate)');
  });

  it('renders connection flags only for helper stories', () => {
    const ep = soundEpisode();
    ep.nodes[0].audienceConnection = 'connected';
    expect(describeGraphForPrompt(ep, { participationMode: 'helper' }))
      .toContain('(START) (DECISION LOOP) (AUDIENCE CONNECTED)');
    expect(describeGraphForPrompt(ep)).not.toContain('AUDIENCE CONNECTED');
    expect(describeGraphForPrompt(ep)).not.toContain('AUDIENCE DISCONNECTED');
  });
});
