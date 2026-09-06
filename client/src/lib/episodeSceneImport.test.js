import { describe, it, expect } from 'vitest';
import { parseNodeTextToLines, loomEpisodeToDraftScenes } from './episodeSceneImport.js';

describe('parseNodeTextToLines', () => {
  it('imports prose as a single action line', () => {
    expect(parseNodeTextToLines('You step into the hall. It is dark.', { format: 'prose' })).toEqual([
      { type: 'action', text: 'You step into the hall. It is dark.' },
    ]);
  });

  it('returns an empty array for blank/missing text', () => {
    expect(parseNodeTextToLines('', { format: 'prose' })).toEqual([]);
    expect(parseNodeTextToLines(undefined, { format: 'prose' })).toEqual([]);
  });

  it('extracts teleplay cues + dialogue and drops sluglines', () => {
    const text = [
      'INT. HOLDING CELL - NIGHT',
      'Mara paces the cell.',
      'MARA',
      "We're out of time.",
      'She looks at the door.',
    ].join('\n');
    expect(parseNodeTextToLines(text, { format: 'teleplay' })).toEqual([
      { type: 'action', text: 'Mara paces the cell.' },
      { type: 'dialogue', speaker: 'MARA', text: "We're out of time." },
      { type: 'action', text: 'She looks at the door.' },
    ]);
  });
});

describe('loomEpisodeToDraftScenes', () => {
  it('maps each node to a scene and skips nodes with no importable lines', () => {
    const episode = {
      nodes: [
        { id: 'n1', title: 'Cell Block', prose: 'You wake up.' },
        { id: 'n2', title: 'Empty', prose: '' },
      ],
    };
    expect(loomEpisodeToDraftScenes(episode)).toEqual([
      { sceneId: 'n1', location: 'Cell Block', lines: [{ type: 'action', text: 'You wake up.' }] },
    ]);
  });

  it('handles a missing/empty node list', () => {
    expect(loomEpisodeToDraftScenes(null)).toEqual([]);
    expect(loomEpisodeToDraftScenes({ nodes: [] })).toEqual([]);
  });
});
