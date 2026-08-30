import { describe, expect, it } from 'vitest';
import {
  analyzeSeriesStoryOutlines,
  analyzeStoryOutline,
  analyzeStoryOutlineTeleplaySync,
  describeStoryOutlineForPrompt,
  sanitizeStoryOutline,
} from './fableLoomOutline.js';

const validOutline = {
  startKey: 's1',
  scenes: [
    {
      key: 's1',
      title: 'Signal',
      summary: 'The protagonist catches a signal that proves the missing ship is still alive.',
      playbackMode: 'cut',
      audienceConnection: 'disconnected',
      transitions: [{ targetKey: 's2', intent: 'follow the signal' }],
    },
    {
      key: 's2',
      title: 'The choice',
      summary: 'The signal offers two routes, each demanding a different sacrifice.',
      playbackMode: 'decision',
      audienceConnection: 'connected',
      transitions: [
        { targetKey: 's3', intent: 'protect the survivors' },
        { targetKey: 's4', intent: 'take the shortcut' },
      ],
    },
    {
      key: 's3',
      title: 'A costly rescue',
      summary: 'The rescue succeeds but strands the protagonist beyond the safe corridor.',
      playbackMode: 'cut',
      audienceConnection: 'connected',
      isEnding: true,
      endingLabel: 'The long way home',
      transitions: [],
    },
    {
      key: 's4',
      title: 'The shortcut',
      summary: 'The shortcut opens the corridor while leaving one unanswered voice behind.',
      playbackMode: 'cut',
      audienceConnection: 'connected',
      isEnding: true,
      endingLabel: 'The open door',
      transitions: [],
    },
  ],
};

describe('FableLoom story beat outlines', () => {
  it('accepts a reachable arc with real choices and distinct endings', () => {
    const outline = sanitizeStoryOutline(validOutline);
    const result = analyzeStoryOutline(outline, { participationMode: 'helper', requireAudienceIntroduction: true });

    expect(result.issues).toEqual([]);
    expect(result.stats).toMatchObject({
      sceneCount: 4,
      automaticCutCount: 1,
      decisionCount: 1,
      endingCount: 2,
      reachableCount: 4,
      reachableEndingCount: 2,
      errorCount: 0,
    });
  });

  it('surfaces missing summaries, unreachable beats, invalid paths, and disconnected choices', () => {
    const outline = sanitizeStoryOutline({
      startKey: 's1',
      scenes: [
        { key: 's1', title: 'Opening', playbackMode: 'cut', audienceConnection: 'disconnected', transitions: [{ targetKey: 's2', intent: 'continue' }] },
        { key: 's2', title: 'Choice', summary: 'A choice.', playbackMode: 'decision', audienceConnection: 'disconnected', transitions: [{ targetKey: 'missing', intent: '' }] },
        { key: 's3', title: 'Lost', summary: 'Never reached.', playbackMode: 'cut', isEnding: true },
      ],
    });
    const result = analyzeStoryOutline(outline, { participationMode: 'helper', requireAudienceIntroduction: true });
    const codes = result.issues.map((issue) => issue.code);

    expect(codes).toEqual(expect.arrayContaining([
      'EMPTY_SUMMARY', 'DECISION_TRANSITION_COUNT', 'DISCONNECTED_DECISION',
      'EMPTY_INTENT', 'DANGLING_TRANSITION', 'UNREACHABLE_SCENE', 'NO_AUDIENCE_CONNECTION',
    ]));
    expect(result.stats.errorCount).toBeGreaterThan(0);
  });

  it('keeps outline rendering compact for the AI prompt', () => {
    const outline = sanitizeStoryOutline(validOutline);
    const digest = describeStoryOutlineForPrompt(outline);

    expect(digest).toContain('[s1] Signal (START) (AUTO CUT)');
    expect(digest).toContain('-> [s2] follow the signal (The choice)');
    expect(digest).toContain('The shortcut opens the corridor');
  });

  it('defaults connected decision beats off-screen only for helper stories', () => {
    const protagonistOutline = sanitizeStoryOutline(validOutline, { participationMode: 'protagonist' });
    const helperOutline = sanitizeStoryOutline(validOutline, { participationMode: 'helper' });

    expect(protagonistOutline.scenes.find((scene) => scene.key === 's2').protagonistPresence)
      .toBe('onscreen');
    expect(helperOutline.scenes.find((scene) => scene.key === 's2').protagonistPresence)
      .toBe('offscreen');
  });

  it('requires every episode outline and configured delivery handoff before the series is ready', () => {
    const loom = {
      participationMode: 'protagonist',
      episodes: [
        { id: 'ep-1', number: 1, storyOutline: { ...sanitizeStoryOutline(validOutline), validation: { status: 'valid', issues: [] } } },
        { id: 'ep-2', number: 2 },
      ],
      seriesPlan: {
        deliveryOptions: { overnightVoicemails: true, nextSeasonTeaser: true },
        interEpisodeVoicemails: [{ fromEpisodeId: 'ep-1', toEpisodeId: 'ep-2', transcript: '' }],
        nextSeasonTeaser: { title: 'Beyond', transcript: '' },
      },
    };
    const result = analyzeSeriesStoryOutlines(loom);
    const codes = result.issues.map((issue) => issue.code);

    expect(codes).toEqual(expect.arrayContaining([
      'MISSING_EPISODE_OUTLINE', 'EMPTY_OVERNIGHT_VOICEMAIL', 'MISSING_NEXT_SEASON_TEASER',
    ]));
    expect(result.stats.ready).toBe(false);
  });

  it('does not count a claimed-valid outline as ready when the expanded teleplay has drifted', () => {
    const storyOutline = {
      ...sanitizeStoryOutline(validOutline),
      validation: { status: 'valid', issues: [] },
    };
    const episode = {
      id: 'ep-1',
      number: 1,
      startNodeId: 's1',
      storyOutline,
      nodes: storyOutline.scenes.map((scene) => ({
        id: scene.key,
        title: scene.title,
        playbackMode: scene.playbackMode,
        audienceConnection: scene.audienceConnection,
        protagonistPresence: scene.protagonistPresence,
        isEnding: scene.isEnding,
        endingLabel: scene.endingLabel,
        transitions: scene.transitions.map((item) => ({
          targetNodeId: item.targetKey,
          intent: item.intent,
        })),
      })),
    };
    episode.nodes.push({
      id: 'new-scene', title: 'New scene', playbackMode: 'decision',
      audienceConnection: 'connected', protagonistPresence: 'onscreen',
      isEnding: true, endingLabel: 'New ending', transitions: [],
    });

    const sync = analyzeStoryOutlineTeleplaySync(episode, storyOutline);
    const series = analyzeSeriesStoryOutlines({
      participationMode: 'protagonist', episodes: [episode], seriesPlan: {},
    });

    expect(sync.stats.matches).toBe(false);
    expect(sync.issues).toContainEqual(expect.objectContaining({
      code: 'TELEPLAY_SCENE_MEMBERSHIP_MISMATCH',
    }));
    expect(series.stats).toMatchObject({ ready: false, readyEpisodeCount: 0 });
  });
});
