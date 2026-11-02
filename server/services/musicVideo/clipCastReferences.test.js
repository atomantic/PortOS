import { describe, it, expect, vi, beforeEach } from 'vitest';

const getProject = vi.fn();
const loadSceneCastMedia = vi.fn();
vi.mock('./projects.js', () => ({ getProject: (...args) => getProject(...args) }));
vi.mock('./castGuideMedia.js', () => ({ loadSceneCastMedia: (...args) => loadSceneCastMedia(...args) }));
vi.mock('../../lib/pathSafety.js', () => ({
  resolveGalleryImage: (file) => (['gone.png', 'guide-refs.png'].includes(file) ? null : `/gallery/${file}`),
  resolveImageInputPath: (file) => (file === 'gone.png' ? null : file === 'guide-refs.png' ? `/inputs/${file}` : `/gallery/${file}`),
}));

const { musicVideoClipCastReferences, musicVideoLocalReferencePaths } = await import('./clipCastReferences.js');

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
  beforeEach(() => { getProject.mockReset(); loadSceneCastMedia.mockReset().mockResolvedValue(null); });

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

// Uniquely catches a local reference-to-video clip (FastH3 Omni) losing the shot's cast sheets, or sending more than the model takes.
describe('musicVideoLocalReferencePaths', () => {
  beforeEach(() => { getProject.mockReset(); loadSceneCastMedia.mockReset().mockResolvedValue(null); });

  it('names the cast sheets as gallery files, never the set plate, within the limit', async () => {
    const scene = { sceneId: 'shot-example', sectionIndex: 0, prompt: 'Guest steps into view' };
    getProject.mockResolvedValue(project(scene, REFS));
    expect(await musicVideoLocalReferencePaths({ projectId: 'mv-1', sceneId: 'shot-example' }, 8)).toEqual(['/gallery/lead.png', '/gallery/guest.png']);
    expect(await musicVideoLocalReferencePaths({ projectId: 'mv-1', sceneId: 'shot-example' }, 1)).toEqual(['/gallery/lead.png']);
    expect(await musicVideoLocalReferencePaths({ projectId: 'mv-1', sceneId: 'shot-example' }, 0)).toEqual([]);
  });

  it('excludes the source path before filling the remaining reference slots', async () => {
    const scene = { sceneId: 'shot-example', sectionIndex: 0, prompt: 'Guest steps into view' };
    getProject.mockResolvedValue(project(scene, REFS));
    expect(await musicVideoLocalReferencePaths({ projectId: 'mv-1', sceneId: 'shot-example' }, 1,
      { excludePath: '/gallery/lead.png' })).toEqual(['/gallery/guest.png']);
    expect(await musicVideoLocalReferencePaths({ projectId: 'mv-1', sceneId: 'shot-example' }, 1,
      { excludePath: '/uploads/lead.png' })).toEqual(['/gallery/lead.png']);
  });

  it('keeps a selected cast guide when the guide is available in the gallery', async () => {
    const scene = { sceneId: 'shot-example', sectionIndex: 0, characterVariant: { ingredientId: 'cast-example', age: 7 } };
    getProject.mockResolvedValue(project(scene, REFS));
    loadSceneCastMedia.mockResolvedValue({ 'cast-example': [{
      mediaKey: 'guide.png', kind: 'reference', createdAt: '2026-01-01T00:00:00.000Z',
      library: { guide: true, variant: { age: 7 } },
    }] });
    expect(await musicVideoLocalReferencePaths({ projectId: 'mv-1', sceneId: 'shot-example' }, 1)).toEqual(['/gallery/guide.png']);
    loadSceneCastMedia.mockResolvedValue({ 'cast-example': [{
      mediaKey: 'guide-refs.png', kind: 'reference', createdAt: '2026-01-01T00:00:00.000Z',
      library: { guide: true, variant: { age: 7 } },
    }] });
    expect(await musicVideoLocalReferencePaths({ projectId: 'mv-1', sceneId: 'shot-example' }, 1)).toEqual(['/inputs/guide-refs.png']);
    loadSceneCastMedia.mockResolvedValue({ 'cast-example': [{
      mediaKey: 'gone.png', kind: 'reference', createdAt: '2026-01-01T00:00:00.000Z',
      library: { guide: true, variant: { age: 7 } },
    }] });
    expect(await musicVideoLocalReferencePaths({ projectId: 'mv-1', sceneId: 'shot-example' }, 1)).toEqual(['/gallery/lead.png']);
  });
});
