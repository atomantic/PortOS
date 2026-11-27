import { describe, expect, it } from 'vitest';
import { mirrorBlenderScenes, scenesConflict, unmirroredScenes } from './sceneMirror.js';

const shots = [
  { id: 'intro-a', start: -3, end: -1, label: ' First opening ', summary: 'A silhouette' },
  { id: 'intro-b', start: -1, end: 0, label: 'Second opening' },
  { id: 'verse', start: 0, end: 4, label: 'Verse', action: 'Walks in', summary: 'A figure in a hall', staging: 'Wide shot' },
];
const project = { id: 'project-1', scenes: [],
  lyricCues: [{ id: 'line-1', text: 'Sing the line', startSec: 0, endSec: 3 }] };
const withMap = ({ project: board, sceneMap }) => ({ ...board, blender: { sceneMap } });

describe('Blender scene mirroring', () => {
  it('orders the lead-in before song shots and assigns song lyrics only within song time', () => {
    const mirrored = mirrorBlenderScenes(project, shots);
    const { sceneMap } = mirrored;
    expect(mirrored.project.scenes).toMatchObject([
      { sceneId: sceneMap['intro-a'], order: 0, label: 'First opening', startSec: null, endSec: null, lyricText: null, preMusic: { durationSec: 2 } },
      { sceneId: sceneMap['intro-b'], order: 1, startSec: null, endSec: null, lyricText: null, preMusic: { durationSec: 1 } },
      { sceneId: sceneMap.verse, order: 2, startSec: 0, endSec: 4, lyricText: 'Sing the line', visualLayer: 'code',
        visualIntent: 'Walks in', prompt: 'A figure in a hall', framePrompt: 'Wide shot', beatAligned: true },
    ]);
    expect(new Set(Object.values(sceneMap)).size).toBe(3);
    expect(project.scenes).toEqual([]);
  });

  it('leaves an unchanged Board intact, then keeps surviving ids and clears a retimed cold open', () => {
    const original = withMap(mirrorBlenderScenes(project, shots));

    expect(mirrorBlenderScenes(original, shots)).toEqual({ project: original, sceneMap: original.blender.sceneMap });
    expect(mirrorBlenderScenes(original, shots).project).toBe(original);

    const next = mirrorBlenderScenes(original, [
      { ...shots[1], start: 0, end: 1 },
      { ...shots[2], start: 1, label: 'Revised verse' },
      { id: 'chorus', start: 4, end: 8 },
    ]);
    const { sceneMap } = next;
    expect(sceneMap).toEqual({ 'intro-b': original.blender.sceneMap['intro-b'], verse: original.blender.sceneMap.verse, chorus: expect.any(String) });
    expect(next.project.scenes).toMatchObject([
      { sceneId: sceneMap['intro-b'], order: 0, startSec: 0, endSec: 1, preMusic: null },
      { sceneId: sceneMap.verse, order: 1, label: 'Revised verse', startSec: 1 },
      { sceneId: sceneMap.chorus, order: 2, label: 'chorus', startSec: 4 },
    ]);
  });

  it('reports unmapped Board scenes and requires explicit replacement', () => {
    const existing = withMap(mirrorBlenderScenes(project, [shots[2]]));
    const handMade = { sceneId: 'hand-made', label: 'Manual shot', order: 1 };
    const mixed = { ...existing, scenes: [...existing.scenes, handMade],
      blender: { sceneMap: { ...existing.blender.sceneMap, missing: 'deleted' } } };

    expect(unmirroredScenes(mixed)).toEqual([handMade]);
    expect(() => mirrorBlenderScenes(mixed, [shots[2]])).toThrow(expect.objectContaining({
      status: 409, code: 'MUSIC_VIDEO_BLENDER_SCENES_CONFLICT',
      context: { count: 1, scenes: [{ sceneId: handMade.sceneId, label: handMade.label }] },
    }));
    const replaced = mirrorBlenderScenes(mixed, [shots[2]], { replaceScenes: true });
    expect(replaced.sceneMap).toEqual(existing.blender.sceneMap);
    expect(replaced.project.scenes).toEqual(existing.scenes);
  });

  it('caps returned conflict details while keeping the total count', () => {
    const conflicts = Array.from({ length: 51 }, (_, index) => ({ sceneId: `scene-${index}`, order: index }));
    const error = scenesConflict(conflicts);
    expect(error.message).toMatch(/51 shots/);
    expect(error.context).toEqual({ count: 51, scenes: conflicts.slice(0, 50).map(({ sceneId }) => ({ sceneId, label: '' })) });
  });
});
