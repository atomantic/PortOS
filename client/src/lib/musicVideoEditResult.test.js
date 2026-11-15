import { describe, it, expect } from 'vitest';
import { applyMusicVideoEdit } from './musicVideoEditResult.js';

const project = {
  id: 'mv-1', updatedAt: '2026-01-01T00:00:01.000Z', productionReadiness: { storyboard: { approved: true } }, songAudioChange: { changed: true },
  scenes: [{ sceneId: 'a', prompt: 'A', startSec: 0, endSec: 5 }, { sceneId: 'b', prompt: 'B', startSec: 5, endSec: 10 }],
};
const edit = (patch = {}) => ({ updatedAt: '2026-01-01T00:00:02.000Z', sceneIds: ['a', 'b'], scenes: [], project: {}, removed: [], ...patch });

describe('applyMusicVideoEdit', () => {
  it('replaces the changed shots in the new order, merges changed fields and drops removed ones', () => {
    const next = applyMusicVideoEdit(project, edit({
      sceneIds: ['b', 'a', 'c'],
      scenes: [{ sceneId: 'a', prompt: 'A', startSec: 0, endSec: 6 }, { sceneId: 'c', prompt: 'C', startSec: 10, endSec: 12 }],
      project: { productionReadiness: { storyboard: { approved: false } } },
      removed: ['songAudioChange'],
    }));
    expect(next.scenes.map((scene) => [scene.sceneId, scene.endSec])).toEqual([['b', 10], ['a', 6], ['c', 12]]);
    expect(next.scenes[0]).toBe(project.scenes[1]);
    expect(next.productionReadiness.storyboard.approved).toBe(false);
    expect(next).not.toHaveProperty('songAudioChange');
    expect(next.updatedAt).toBe('2026-01-01T00:00:02.000Z');
  });

  it('drops a shot the order no longer names', () => {
    expect(applyMusicVideoEdit(project, edit({ sceneIds: ['b'] })).scenes.map((scene) => scene.sceneId)).toEqual(['b']);
  });

  it('keeps text typed and not yet saved', () => {
    const typed = { ...project, scenes: [{ ...project.scenes[0], prompt: 'Typing…' }, project.scenes[1]] };
    const next = applyMusicVideoEdit(typed, edit({ scenes: [{ sceneId: 'a', prompt: 'A', startSec: 0, endSec: 6 }] }), { keep: new Map([['a', new Set(['prompt'])]]) });
    expect(next.scenes[0]).toMatchObject({ prompt: 'Typing…', endSec: 6 });
  });

  // Uniquely catches a diff applied over a record newer than its base, which would undo the newer change.
  it('refuses a reply older than the record, a shot it neither sent nor the board has, and a malformed reply', () => {
    expect(applyMusicVideoEdit(project, edit({ updatedAt: '2026-01-01T00:00:00.000Z' }))).toBeNull();
    expect(applyMusicVideoEdit(project, edit({ sceneIds: ['a', 'b', 'unknown'] }))).toBeNull();
    expect(applyMusicVideoEdit(project, { updatedAt: project.updatedAt })).toBeNull();
    expect(applyMusicVideoEdit(project, edit({ updatedAt: project.updatedAt }))).not.toBeNull();
  });
});
