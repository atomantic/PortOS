import { describe, expect, it } from 'vitest';
import {
  analyzeLoomPlaythroughs,
  buildLoomPlaythroughPromptDigest,
  describeLoomPlaythroughsForPrompt,
  enumerateEpisodePlaythroughs,
  PLAYTEST_ISSUE_CODES,
  PLAYTEST_PROMPT_TRUNCATION_MARKER,
} from './fableLoomPlaytest.js';

const transition = (id, targetNodeId, intent) => ({ id, targetNodeId, intent, triggers: [] });

const branchingEpisode = () => ({
  id: 'episode-1',
  number: 1,
  title: 'Example Episode',
  startNodeId: 'opening',
  nodes: [
    {
      id: 'opening', title: 'Opening', prose: 'The signal splits in two.', playbackMode: 'decision',
      audienceConnection: 'connected', isEnding: false,
      transitions: [
        transition('take-left', 'left', 'Take the left route'),
        transition('take-right', 'right', 'Take the right route'),
      ],
    },
    {
      id: 'left', title: 'Left Route', prose: 'The traveler crosses the glass bridge.', playbackMode: 'cut',
      audienceConnection: 'disconnected', isEnding: false,
      transitions: [transition('left-end', 'ending', 'Continue')],
    },
    {
      id: 'right', title: 'Right Route', prose: 'The traveler follows the buried wire.', playbackMode: 'cut',
      audienceConnection: 'disconnected', isEnding: false,
      transitions: [transition('right-end', 'ending', 'Continue')],
    },
    {
      id: 'ending', title: 'Shared Ending', prose: 'Both routes reveal the same beacon.',
      playbackMode: 'decision', audienceConnection: 'connected', isEnding: true,
      endingLabel: 'Beacon found', transitions: [],
    },
  ],
});

describe('enumerateEpisodePlaythroughs', () => {
  it('exercises every branch through convergence and records ending coverage', () => {
    const report = enumerateEpisodePlaythroughs(branchingEpisode());

    expect(report.stats).toMatchObject({
      variationCount: 2,
      endingVariationCount: 2,
      nonEndingVariationCount: 0,
      visitedNodeCount: 4,
      visitedTransitionCount: 4,
      transitionCount: 4,
      enumerationComplete: true,
      passed: true,
    });
    expect(report.paths.map((path) => path.transitionIds)).toEqual([
      ['take-left', 'left-end'],
      ['take-right', 'right-end'],
    ]);
    expect(report.stats.endingCounts).toEqual({ ending: 2 });
  });

  it('reports a repeatable graph cycle while still testing the exit variation', () => {
    const episode = branchingEpisode();
    episode.nodes = [
      {
        id: 'opening', title: 'Looping Choice', prose: 'The relay asks again.',
        playbackMode: 'decision', audienceConnection: 'connected', isEnding: false,
        transitions: [
          transition('again', 'opening', 'Ask again'),
          transition('finish', 'ending', 'Finish'),
        ],
      },
      episode.nodes.at(-1),
    ];
    const report = enumerateEpisodePlaythroughs(episode);

    expect(report.paths.some((path) => path.termination === 'cycle')).toBe(true);
    expect(report.paths.some((path) => path.termination === 'ending')).toBe(true);
    expect(report.issues.some((issue) => issue.code === PLAYTEST_ISSUE_CODES.NON_TERMINATING_CYCLE)).toBe(true);
    expect(report.stats.passed).toBe(false);
  });

  it('makes a variation cap explicit and marks untested paths as warnings', () => {
    const episode = branchingEpisode();
    episode.nodes[0].transitions = [
      transition('to-a', 'a', 'A'),
      transition('to-b', 'b', 'B'),
      transition('to-c', 'c', 'C'),
    ];
    episode.nodes = [
      episode.nodes[0],
      ...['a', 'b', 'c'].map((id) => ({
        id, title: id.toUpperCase(), prose: `${id} ending`, playbackMode: 'decision',
        audienceConnection: 'connected', isEnding: true, endingLabel: id, transitions: [],
      })),
    ];

    const report = enumerateEpisodePlaythroughs(episode, { maxPaths: 2 });

    expect(report.stats.variationCount).toBe(2);
    expect(report.stats.enumerationComplete).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: PLAYTEST_ISSUE_CODES.VARIATION_LIMIT, severity: 'warning' }),
      expect.objectContaining({ code: PLAYTEST_ISSUE_CODES.UNCOVERED_TRANSITION, severity: 'warning' }),
    ]));
  });

  it('fails an exhaustive run when an authored scene and ending are unreachable', () => {
    const episode = branchingEpisode();
    episode.nodes.push({
      id: 'orphan', title: 'Orphan Ending', prose: 'No route reaches this ending.',
      playbackMode: 'decision', audienceConnection: 'connected', isEnding: true,
      endingLabel: 'Unreachable', transitions: [],
    });

    const report = enumerateEpisodePlaythroughs(episode);

    expect(report.stats).toMatchObject({
      nodeCount: 5,
      visitedNodeCount: 4,
      passed: false,
      endingCounts: { ending: 2, orphan: 0 },
    });
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: PLAYTEST_ISSUE_CODES.UNCOVERED_NODE,
      severity: 'error',
      nodeId: 'orphan',
    }));
  });

  it('counts transition records by owning scene even when ids repeat', () => {
    const episode = branchingEpisode();
    episode.nodes[0].transitions[0].id = 'branch';
    episode.nodes[0].transitions[1].id = 'branch';
    episode.nodes[1].transitions[0].id = 'finish';
    episode.nodes[2].transitions[0].id = 'finish';

    const report = enumerateEpisodePlaythroughs(episode);

    expect(report.stats).toMatchObject({
      transitionCount: 4,
      visitedTransitionCount: 4,
      passed: true,
    });
    expect(report.issues.some((issue) => issue.code === PLAYTEST_ISSUE_CODES.UNCOVERED_TRANSITION)).toBe(false);
    expect(report.paths.map((path) => path.transitionIds)).toEqual([
      ['branch', 'finish'],
      ['branch', 'finish'],
    ]);
  });
});

describe('analyzeLoomPlaythroughs', () => {
  it('aggregates episode coverage and renders compact story traces', () => {
    const episode = branchingEpisode();
    const loom = { participationMode: 'helper', episodes: [episode] };
    const report = analyzeLoomPlaythroughs(loom);
    const digest = describeLoomPlaythroughsForPrompt(loom, report);

    expect(report).toMatchObject({
      passed: true,
      complete: true,
      stats: { episodeCount: 1, variationCount: 2, visitedTransitionCount: 4 },
    });
    expect(digest).toContain('## Episode 1: Example Episode');
    expect(digest).toContain('C1 = [take-left] N1 -> N2; choice; intent: Take the left route');
    expect(digest).toContain('[path-1] N1 -C1-> N2');
    expect(digest).toContain('END N3');
  });

  it('bounds maximal authored labels and reports when every trace cannot fit', () => {
    const sharedNodes = Array.from({ length: 103 }, (_, index) => ({
      id: `node-${index + 1}`,
      title: 'T'.repeat(300),
      prose: 'The route continues.',
      playbackMode: index === 102 ? 'decision' : 'cut',
      audienceConnection: 'connected',
      isEnding: false,
      transitions: index === 102 ? [] : [transition(
        `transition-${index + 1}`,
        `node-${index + 2}`,
        'I'.repeat(120),
      )],
    }));
    const endings = Array.from({ length: 96 }, (_, index) => ({
      id: `ending-${index + 1}`,
      title: 'E'.repeat(300),
      prose: 'The route resolves.',
      playbackMode: 'decision',
      audienceConnection: 'connected',
      isEnding: true,
      endingLabel: `Ending ${index + 1}`,
      transitions: [],
    }));
    sharedNodes.at(-1).transitions = endings.map((ending, index) => transition(
      `ending-transition-${index + 1}`,
      ending.id,
      'I'.repeat(120),
    ));
    const episode = {
      id: 'maximal-episode',
      number: 1,
      title: 'Maximal Episode',
      startNodeId: 'node-1',
      nodes: [...sharedNodes, ...endings],
    };
    const loom = { participationMode: 'protagonist', episodes: [episode] };
    const report = analyzeLoomPlaythroughs(loom);
    const complete = buildLoomPlaythroughPromptDigest(loom, report, { maxChars: 400_000 });
    const bounded = buildLoomPlaythroughPromptDigest(loom, report, { maxChars: 20_000 });

    expect(complete.complete).toBe(true);
    expect(complete.text.length).toBeLessThanOrEqual(400_000);
    expect(complete.includedVariationCount).toBe(96);
    expect(bounded.complete).toBe(false);
    expect(bounded.text.length).toBeLessThanOrEqual(20_000);
    expect(bounded.text).toContain(PLAYTEST_PROMPT_TRUNCATION_MARKER);
  });

  it('enforces one variation budget across a branch-heavy series', () => {
    const episodes = Array.from({ length: 30 }, (_, episodeIndex) => {
      const id = `episode-${episodeIndex + 1}`;
      const endNodes = Array.from({ length: 12 }, (_, pathIndex) => ({
        id: `${id}-end-${pathIndex + 1}`,
        title: `Ending ${pathIndex + 1}`,
        prose: 'The route resolves.',
        playbackMode: 'decision',
        audienceConnection: 'connected',
        isEnding: true,
        endingLabel: `Ending ${pathIndex + 1}`,
        transitions: [],
      }));
      return {
        id,
        number: episodeIndex + 1,
        title: `Episode ${episodeIndex + 1}`,
        startNodeId: `${id}-opening`,
        nodes: [{
          id: `${id}-opening`,
          title: 'Opening',
          prose: 'Twelve routes open.',
          playbackMode: 'decision',
          audienceConnection: 'connected',
          isEnding: false,
          transitions: endNodes.map((node, pathIndex) => transition(
            `${id}-path-${pathIndex + 1}`,
            node.id,
            `Choose route ${pathIndex + 1}`,
          )),
        }, ...endNodes],
      };
    });

    const report = analyzeLoomPlaythroughs({ participationMode: 'protagonist', episodes }, {
      maxPaths: 256,
    });

    expect(report.stats.variationCount).toBeLessThanOrEqual(256);
    expect(report.episodes.every((episode) => episode.stats.variationCount >= 1)).toBe(true);
    expect(report.complete).toBe(false);
    expect(report.episodes.some((episode) => (
      episode.issues.some((issue) => issue.code === PLAYTEST_ISSUE_CODES.VARIATION_LIMIT)
    ))).toBe(true);
  });
});
