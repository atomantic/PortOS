import { describe, expect, it } from 'vitest';
import { fableLoomBoardPath, fableLoomBoardPick } from './fableLoomBoard.js';

const scene = (id, transitions = [], extra = {}) => ({
  id, title: id.toUpperCase(), transitions: transitions.map(([tid, target, intent = '']) => ({ id: tid, targetNodeId: target, intent })), ...extra,
});
// a → b (fork: c or d); c → a loops; d is an ending. a and b share a dramatic scene.
const episode = {
  startNodeId: 'a',
  nodes: [
    scene('a', [['t-ab', 'b']], { shot: { dramaticSceneId: 'ds-1', dramaticSceneTitle: 'Arrival', durationSeconds: 6 } }),
    scene('b', [['t-bc', 'c', 'Run'], ['t-bd', 'd', 'Stay'], ['t-bx', 'missing']], { shot: { dramaticSceneId: 'ds-1', durationSeconds: 8 } }),
    scene('c', [['t-ca', 'a']]),
    scene('d', [], { isEnding: true }),
  ],
};
const ids = (path) => path.beats.flatMap((beat) => beat.panels.map((panel) => panel.node.id));

describe('fableLoomBoardPath', () => {
  it('follows the first choice, groups a dramatic scene into one beat, and stops where it would loop', () => {
    const path = fableLoomBoardPath(episode);
    expect(ids(path)).toEqual(['a', 'b', 'c']);
    expect(path.beats.map((beat) => [beat.title, beat.panels.length])).toEqual([['Arrival', 2], ['C', 1]]);
    expect(path.beats[0].panels[1].choices.map((c) => [c.intent, c.picked])).toEqual([['Run', true], ['Stay', false]]);
    expect(path.beats[1].panels[0].loopsTo).toBe('a');
    expect([path.end, path.totalSeconds]).toEqual(['loop', 14]);
  });

  it('takes a picked choice to an ending, and one pick per fork', () => {
    const via = fableLoomBoardPick(episode, ['t-bc'], 't-bd');
    expect(via).toEqual(['t-bd']);
    const path = fableLoomBoardPath(episode, via);
    expect(ids(path)).toEqual(['a', 'b', 'd']);
    expect(path.end).toBe('ending');
  });

  it('reports an episode with no start scene as empty', () => {
    expect(fableLoomBoardPath({ nodes: [] })).toMatchObject({ beats: [], end: 'empty' });
  });
});
