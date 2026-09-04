// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  fableLoomEpisodeOrderReadiness, fableLoomMediaReadiness,
  fableLoomProductionWorkflow, fableLoomStoryReadiness,
} from './fableLoomReadiness.js';

const outline = { validation: { status: 'valid' } };

describe('FableLoom story-first readiness', () => {
  it('blocks media until every episode outline is validated', () => {
    const loom = {
      episodes: [
        { id: 'ep-1', number: 1, storyOutline: outline },
        { id: 'ep-2', number: 2 },
      ],
    };

    expect(fableLoomStoryReadiness(loom)).toMatchObject({
      ready: false,
      reason: expect.stringContaining('Episode 2'),
    });
  });

  it('requires configured delivery handoffs before media generation', () => {
    const loom = {
      episodes: [
        { id: 'ep-1', number: 1, storyOutline: outline },
        { id: 'ep-2', number: 2, storyOutline: outline },
      ],
      seriesPlan: {
        deliveryOptions: { overnightVoicemails: true, nextSeasonTeaser: true },
        interEpisodeVoicemails: [{ fromEpisodeId: 'ep-1', toEpisodeId: 'ep-2', transcript: '' }],
        nextSeasonTeaser: { title: 'Beyond', transcript: '' },
      },
    };

    expect(fableLoomStoryReadiness(loom).reason).toContain('overnight voicemail');
  });

  it('does not block an empty episode because there is nothing to render yet', () => {
    const loom = { episodes: [{ id: 'ep-1', number: 1 }] };
    expect(fableLoomMediaReadiness(loom, { id: 'ep-1', nodes: [] })).toEqual({ ready: true, reason: '' });
  });

  it('blocks direct image generation for a later episode until prior reachable scenes have images', () => {
    const loom = {
      episodes: [
        {
          id: 'ep-1', number: 1, startNodeId: 'prior-start',
          nodes: [{ id: 'prior-start', image: '', transitions: [] }],
        },
        {
          id: 'ep-2', number: 2, startNodeId: 'later-start',
          nodes: [{ id: 'later-start', transitions: [] }],
        },
      ],
    };

    expect(fableLoomEpisodeOrderReadiness(loom, loom.episodes[1])).toMatchObject({
      ready: false,
      reason: 'Finish storyboard images for Episode 1 before generating Episode 2.',
      blockedBy: { missingScenes: 1 },
    });
    expect(fableLoomMediaReadiness(loom, loom.episodes[1]).ready).toBe(false);
  });

  it('orders manual and AI work into one twelve-stage production sequence', () => {
    const loom = {
      name: 'Example Story', premise: 'A courier follows a dangerous signal.',
      seriesPlan: {
        storyArc: 'Suspicion becomes trust.',
        plotPoints: [{
          id: 'plot-1', title: 'Challenge — Locked gate', description: 'Setup and costly outcomes.', episodeId: 'ep-1',
        }],
      },
      episodes: [{ id: 'ep-1', number: 1, storyOutline: outline, nodes: [] }],
    };

    const workflow = fableLoomProductionWorkflow(loom, loom.episodes[0]);

    expect(workflow).toMatchObject({ currentStep: 5, totalSteps: 12, completedCount: 4 });
    expect(workflow.stages[2]).toMatchObject({
      id: 'challenges', status: 'complete', detail: expect.stringContaining('1 playable challenge'),
    });
    expect(workflow.stages[4]).toMatchObject({ id: 'teleplays', status: 'current' });
    expect(workflow.stages[5]).toMatchObject({ id: 'structure', status: 'blocked' });
  });

  it('keeps challenge planning current until the story names a playable challenge', () => {
    const episode = { id: 'ep-1', number: 1, storyOutline: outline, nodes: [] };
    const workflow = fableLoomProductionWorkflow({
      name: 'Example Story', premise: 'A courier follows a dangerous signal.',
      seriesPlan: {
        storyArc: 'Suspicion becomes trust.',
        plotPoints: [{ id: 'plot-1', title: 'Arrival', description: 'The courier lands.', episodeId: 'ep-1' }],
      },
      episodes: [episode],
    }, episode);

    expect(workflow.currentStep).toBe(3);
    expect(workflow.stages[2]).toMatchObject({
      id: 'challenges', status: 'current', detail: expect.stringContaining('Add at least one playable challenge'),
    });
  });

  it('advances through review and media stages from saved production evidence', () => {
    const motion = {
      entryVideoHistoryId: 'video-entry',
      holdLoopVideoHistoryIds: ['video-hold'],
      exitByTransition: { 'path-1': 'video-exit' },
    };
    const episode = {
      id: 'ep-1', number: 1, startNodeId: 'scene-1', storyOutline: outline,
      nodes: [{
        id: 'scene-1', image: 'scene.png', playbackMode: 'decision', isEnding: false,
        transitions: [{ id: 'path-1', targetNodeId: 'ending' }], playbackAssets: motion,
      }, {
        id: 'ending', image: 'ending.png', videoHistoryId: 'video-ending', isEnding: true, transitions: [],
      }],
    };
    const loom = {
      name: 'Example Story', logline: 'A choice opens the way.',
      seriesPlan: {
        storyArc: 'The way opens.',
        plotPoints: [{ id: 'plot-1', title: 'Challenge — The gate', description: 'A costly choice.', episodeId: 'ep-1' }],
      },
      episodes: [episode],
    };

    const workflow = fableLoomProductionWorkflow(loom, episode, {
      structural: { stats: { errorCount: 0 }, productionReadiness: { ready: true } },
      editorialRun: { status: 'completed' },
      continuityReview: { passed: true, summary: { errors: 0, warnings: 0 } },
    });

    expect(workflow.currentStep).toBe(12);
    expect(workflow.stages.slice(0, 11).every((stage) => stage.status === 'complete')).toBe(true);
    expect(workflow.stages[11]).toMatchObject({ id: 'delivery', status: 'current' });
  });

  it('requires series-wide structure and continuity evidence, not only the selected episode', () => {
    const episodes = [
      { id: 'ep-1', number: 1, storyOutline: outline, nodes: [{ id: 'one', isEnding: true, transitions: [] }] },
      { id: 'ep-2', number: 2, storyOutline: outline, nodes: [{ id: 'two', isEnding: true, transitions: [] }] },
    ];
    const base = {
      name: 'Example Story', premise: 'Two routes must both hold.',
      seriesPlan: {
        storyArc: 'Both episodes resolve one pursuit.',
        plotPoints: [{
          id: 'challenge-1', kind: 'challenge', title: 'Cross the gate',
          description: 'A setup, decision, outcome, and recovery.', episodeId: 'ep-1',
        }],
      },
      episodes,
    };
    const workflow = fableLoomProductionWorkflow(base, episodes[0], {
      structuralByEpisode: {
        'ep-1': { stats: { errorCount: 0 } },
        'ep-2': { stats: { errorCount: 1 } },
      },
      continuityByEpisode: {
        'ep-1': { passed: true },
        'ep-2': { passed: false },
      },
    });

    expect(workflow.stages[5]).toMatchObject({
      id: 'structure', status: 'current', detail: expect.stringContaining('1/2 episode graphs pass'),
    });
    expect(workflow.stages[7]).toMatchObject({
      id: 'continuity', detail: expect.stringContaining('1/2 episodes pass'),
    });
  });

  it('reaches twelve of twelve after durable final-delivery approval', () => {
    const episode = {
      id: 'ep-1', number: 1, storyOutline: outline, startNodeId: 'ending',
      nodes: [{
        id: 'ending', image: 'ending.png', videoHistoryId: 'ending-video',
        isEnding: true, transitions: [],
      }],
    };
    const loom = {
      name: 'Example Story', premise: 'A route reaches its ending.',
      seriesPlan: {
        storyArc: 'The route resolves.',
        plotPoints: [{
          id: 'challenge-1', kind: 'challenge', title: 'Cross the gate',
          description: 'A complete playable challenge.', episodeId: 'ep-1',
        }],
      },
      productionStatus: {
        editorialApprovedAt: '2026-08-30T12:00:00.000Z',
        editorialApprovalSource: 'manual',
        deliveryApprovedAt: '2026-08-30T13:00:00.000Z',
      },
      episodes: [episode],
    };
    const workflow = fableLoomProductionWorkflow(loom, episode, {
      structuralByEpisode: { 'ep-1': { stats: { errorCount: 0 }, productionReadiness: { ready: true } } },
      continuityByEpisode: { 'ep-1': { passed: true } },
    });

    expect(workflow).toMatchObject({ currentIndex: -1, currentStep: 12, completedCount: 12 });
    expect(workflow.stages.every((stage) => stage.status === 'complete')).toBe(true);
  });
});
