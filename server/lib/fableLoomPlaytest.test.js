import { describe, expect, it } from 'vitest';
import {
  analyzeLoomPlaythroughs,
  describeLoomPlaythroughsForPrompt,
  enumerateEpisodePlaythroughs,
  PLAYTEST_ISSUE_CODES,
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
    expect(digest).toContain('Opening --choice: Take the left route-->');
    expect(digest).toContain('END: Beacon found');
  });
});
