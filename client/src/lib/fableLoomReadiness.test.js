import { describe, expect, it } from 'vitest';
import {
  fableLoomEpisodeOrderReadiness, fableLoomMediaReadiness, fableLoomStoryReadiness,
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
});
