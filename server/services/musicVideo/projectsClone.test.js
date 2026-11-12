import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/paths.js', async original => makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('mv-clone-test-') }));
vi.mock('./catalogLinks.js', () => ({ queueProjectCatalogLinkSync: vi.fn() }));
vi.mock('./blender/song.js', async original => {
  const actual = await original();
  return { ...actual, writeBlenderSong: vi.fn(actual.writeBlenderSong) };
});
vi.mock('../sharing/recordEvents.js', () => ({ emitRecordUpdated: vi.fn(), emitRecordDeleted: vi.fn(), autoSubscribeRecordToAllPeers: vi.fn(async () => {}) }));

const projects = await import('./projects.js');
const file = await import('./projectsFile.js');
const { writeBlenderSong } = await import('./blender/song.js');
const { blenderSrcDir, blenderSongFile, blenderWorkspaceDir } = await import('./blender/workspace.js');
const { emitRecordUpdated } = await import('../sharing/recordEvents.js');
afterAll(cleanupTempDataRoots);
beforeEach(() => vi.clearAllMocks());

async function sourceProject({ film = true } = {}) {
  const source = await projects.createProject({ name: 'Example film' });
  const scene = await projects.addProjectScene(source.id, { prompt: 'Example shot' });
  await file.mutateProjectRecord(source.id, current => ({ project: { ...current, blender: {
    settings: { fps: 24 }, sceneMap: { example: scene.sceneId }, syncedAt: '2026-01-01T00:00:00.000Z', manifestHash: 'example-manifest',
  } } }));
  if (film) {
    await mkdir(blenderSrcDir(source.id), { recursive: true });
    await writeFile(join(blenderSrcDir(source.id), 'film.py'), '# Example film source');
    await writeFile(blenderSongFile(source.id), JSON.stringify({ projectId: source.id }));
  }
  return projects.getProject(source.id);
}

describe('project clone film transaction', () => {
  it('copies a film and rewrites song context for the new project before announcing it', async () => {
    const source = await sourceProject();
    const clone = await projects.cloneProject(source.id);
    expect(clone.id).not.toBe(source.id);
    expect(await readFile(join(blenderSrcDir(clone.id), 'film.py'), 'utf8')).toBe('# Example film source');
    expect(JSON.parse(await readFile(blenderSongFile(clone.id), 'utf8'))).toMatchObject({ projectId: clone.id, title: clone.name });
    expect(clone.blender.sceneMap.example).toBe(clone.scenes[0].sceneId);
    expect(clone.blender.sceneMap.example).not.toBe(source.scenes[0].sceneId);
    expect(emitRecordUpdated).toHaveBeenLastCalledWith('musicVideoProject', clone.id);
  });

  it('rejects and removes the copied film and live clone when rewriting its song fails', async () => {
    const source = await sourceProject();
    emitRecordUpdated.mockClear();
    writeBlenderSong.mockRejectedValueOnce(new Error('Synthetic song write failure'));
    await expect(projects.cloneProject(source.id)).rejects.toThrow('Synthetic song write failure');
    const clone = writeBlenderSong.mock.calls[0][0];
    expect(await projects.getProject(clone.id)).toBeNull();
    expect(await stat(blenderWorkspaceDir(clone.id)).catch(error => error.code)).toBe('ENOENT');
    expect(await readFile(join(blenderSrcDir(source.id), 'film.py'), 'utf8')).toBe('# Example film source');
    expect(JSON.parse(await readFile(blenderSongFile(source.id), 'utf8'))).toEqual({ projectId: source.id });
    expect(emitRecordUpdated).not.toHaveBeenCalled();
  });

  it('ignores caller-supplied clone ids and film-copy metadata when no film was copied', async () => {
    const source = await sourceProject({ film: false });
    const clone = await projects.cloneProject(source.id, { id: source.id, blenderFilm: true });
    expect(clone.id).not.toBe(source.id);
    expect(clone.blender).toEqual({ settings: source.blender.settings });
    expect((await projects.getProject(source.id)).blender.sceneMap).toEqual(source.blender.sceneMap);
  });
});
