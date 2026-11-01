import { describe, it, expect, vi, beforeEach } from 'vitest';

const getProject = vi.fn();
vi.mock('./projects.js', () => ({ getProject: (...args) => getProject(...args) }));
vi.mock('./castGuideMedia.js', () => ({ loadSceneCastMedia: async () => null }));
vi.mock('../../lib/pathSafety.js', () => ({
  resolveGalleryImage: (file) => (file === 'gone.png' ? null : `/gallery/${file}`),
  resolveImageInputPath: (file) => `/inputs/${file}`,
}));

const { musicVideoClipCastReferences } = await import('./clipCastReferences.js');

const project = (scene, references) => ({
  id: 'mv-1',
  castAndSets: { status: 'approved', direction: { cast: [{ id: 'guest', name: 'Guest', role: 'friend' }], songMap: [{ section: 0, setId: 'plaza' }] } },
  visualSpec: { references },
  scenes: [scene],
});

const REFS = [
  { id: 'mvr-cs-character', imageId: 'lead.png', role: 'character', label: 'Lead — character sheet' },
  { id: 'mvr-cs-set-plaza', imageId: 'plaza.png', role: 'set', label: 'Plaza' },
  { id: 'mvr-cs-cast-guest', imageId: 'guest.png', role: 'character', label: 'Guest — cast sheet' },
];

describe('musicVideoClipCastReferences', () => {
  beforeEach(() => getProject.mockReset());

  it('returns the lead and the named cast sheets, never the set plate', async () => {
    const scene = { sceneId: 'shot-example', sectionIndex: 0, prompt: 'Guest steps into view' };
    getProject.mockResolvedValue(project(scene, REFS));
    expect(await musicVideoClipCastReferences({ projectId: 'mv-1', sceneId: 'shot-example' })).toEqual([
      { path: '/gallery/lead.png', label: 'Lead — character sheet' },
      { path: '/gallery/guest.png', label: 'Guest — cast sheet' },
    ]);
  });

  it('drops a sheet whose file is gone', async () => {
    const scene = { sceneId: 's1', sectionIndex: 0, prompt: 'Guest walks past' };
    getProject.mockResolvedValue(project(scene, REFS.map((ref) => (ref.id === 'mvr-cs-cast-guest' ? { ...ref, imageId: 'gone.png' } : ref))));
    expect((await musicVideoClipCastReferences({ projectId: 'mv-1', sceneId: 's1' })).map((ref) => ref.label)).toEqual(['Lead — character sheet']);
  });

  it('returns none for an untagged clip or a scene that is gone', async () => {
    expect(await musicVideoClipCastReferences({})).toEqual([]);
    getProject.mockResolvedValue(project({ sceneId: 'other' }, REFS));
    expect(await musicVideoClipCastReferences({ projectId: 'mv-1', sceneId: 'shot-example' })).toEqual([]);
  });
});
