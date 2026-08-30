import { describe, expect, it } from 'vitest';

import { applyFableLoomEditorialPatch } from './editorial.js';
import { sanitizeLoom } from './records.js';

const transition = (id, targetNodeId, intent) => ({ id, targetNodeId, intent, triggers: [] });

const makeLoom = () => sanitizeLoom({
  id: 'loom-example',
  name: 'Example Story',
  participationMode: 'protagonist',
  seriesPlan: { storyArc: 'A traveler follows a divided signal.', plotPoints: [], sideQuests: [] },
  episodes: [{
    id: 'episode-example',
    number: 1,
    title: 'The Divided Signal',
    synopsis: 'Two routes reveal one source.',
    startNodeId: 'opening',
    nodes: [
      {
        id: 'opening', title: 'The Split', prose: 'The signal forks.',
        playbackMode: 'decision', audienceConnection: 'connected', isEnding: false,
        transitions: [
          transition('take-left', 'left', 'Take the glass bridge'),
          transition('take-right', 'right', 'Follow the buried wire'),
        ],
      },
      {
        id: 'left', title: 'Glass Bridge', prose: 'The bridge remembers every footstep.',
        playbackMode: 'cut', audienceConnection: 'disconnected', isEnding: false,
        transitions: [transition('left-end', 'ending', 'Reach the beacon')],
      },
      {
        id: 'right', title: 'Buried Wire', prose: 'The wire hums below the frost.',
        playbackMode: 'cut', audienceConnection: 'disconnected', isEnding: false,
        transitions: [transition('right-end', 'ending', 'Reach the beacon')],
      },
      {
        id: 'ending', title: 'The Beacon', prose: 'Both routes reveal the same call.',
        playbackMode: 'decision', audienceConnection: 'connected', isEnding: true,
        endingLabel: 'Signal found', transitions: [],
      },
    ],
  }],
});

const completeOutline = () => ({
  startKey: 'opening',
  scenes: [
    {
      key: 'opening', title: 'The Split', summary: 'The traveler must choose how to follow the signal.',
      playbackMode: 'decision', audienceConnection: 'connected', protagonistPresence: 'onscreen',
      transitions: [
        { targetKey: 'left', intent: 'Take the glass bridge' },
        { targetKey: 'right', intent: 'Follow the buried wire' },
      ],
    },
    {
      key: 'left', title: 'Glass Bridge', summary: 'The exposed route tests the traveler’s nerve.',
      playbackMode: 'cut', audienceConnection: 'disconnected', protagonistPresence: 'onscreen',
      transitions: [{ targetKey: 'ending', intent: 'Reach the beacon' }],
    },
    {
      key: 'right', title: 'Buried Wire', summary: 'The hidden route reveals who buried the signal.',
      playbackMode: 'cut', audienceConnection: 'disconnected', protagonistPresence: 'onscreen',
      transitions: [{ targetKey: 'ending', intent: 'Reach the beacon' }],
    },
    {
      key: 'ending', title: 'The Beacon', summary: 'The beacon answers with a costly invitation.',
      playbackMode: 'decision', audienceConnection: 'connected', protagonistPresence: 'onscreen',
      isEnding: true, endingLabel: 'Signal found', transitions: [],
    },
  ],
});

describe('applyFableLoomEditorialPatch', () => {
  it('repairs a missing outline and selects a valid convergence source without changing membership', () => {
    const loom = makeLoom();
    const originalNodeIds = loom.episodes[0].nodes.map((node) => node.id);
    const originalTransitionIds = loom.episodes[0].nodes.flatMap((node) => (
      node.transitions.map((item) => item.id)
    ));

    const result = applyFableLoomEditorialPatch(loom, {
      episodes: [{
        id: 'episode-example',
        storyOutline: completeOutline(),
        scenes: [{ id: 'ending', visualCanon: { continuitySourceNodeId: 'left' } }],
      }],
    });

    expect(result.changed).toBe(true);
    expect(result.before.outlineErrors).toBeGreaterThan(0);
    expect(result.after.outlineErrors).toBe(0);
    expect(result.loom.episodes[0].storyOutline.validation.status).toBe('valid');
    expect(result.loom.episodes[0].nodes.find((node) => node.id === 'ending')
      .visualCanon.continuitySourceNodeId).toBe('left');
    expect(result.loom.episodes[0].nodes.map((node) => node.id)).toEqual(originalNodeIds);
    expect(result.loom.episodes[0].nodes.flatMap((node) => node.transitions.map((item) => item.id)))
      .toEqual(originalTransitionIds);
  });

  it('validates continuity sources against transition rewires in the same patch', () => {
    const result = applyFableLoomEditorialPatch(makeLoom(), {
      episodes: [{
        id: 'episode-example',
        scenes: [
          { id: 'left', transitions: [{ id: 'left-end', targetNodeId: 'right' }] },
          { id: 'ending', visualCanon: { continuitySourceNodeId: 'right' } },
        ],
      }],
    });

    expect(result.loom.episodes[0].nodes.find((node) => node.id === 'left')
      .transitions[0].targetNodeId).toBe('right');
    expect(result.loom.episodes[0].nodes.find((node) => node.id === 'ending')
      .visualCanon.continuitySourceNodeId).toBe('right');
  });

  it('rejects a continuity source that is not a direct incoming predecessor', () => {
    expect(() => applyFableLoomEditorialPatch(makeLoom(), {
      episodes: [{
        id: 'episode-example',
        scenes: [{ id: 'ending', visualCanon: { continuitySourceNodeId: 'opening' } }],
      }],
    })).toThrow(/invalid continuity predecessor/i);
  });

  it('rejects a patch that introduces a new deterministic graph error', () => {
    expect(() => applyFableLoomEditorialPatch(makeLoom(), {
      episodes: [{
        id: 'episode-example',
        scenes: [{ id: 'opening', playbackMode: 'cut' }],
      }],
    })).toThrow(/introduced new episode graph errors/i);
  });
});
