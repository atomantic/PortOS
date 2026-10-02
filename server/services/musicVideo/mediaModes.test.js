import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
vi.mock('../../lib/paths.js', async (original) => makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('mv-media-policy-') }));
const projects = await import('./projects.js');
const { importDocumentDirectory } = await import('./compositionDocument.js');
const { PATHS } = await import('../../lib/paths.js');
const { assertMusicVideoMedia, musicVideoMediaMode } = await import('../../lib/musicVideoMediaPolicy.js');
const { castAndSetsAllowsImages, castAndSetsMedium } = await import('./castAndSetsDirection.js');
const { migrateMediaMode } = await import('../../../scripts/migrations/421-music-video-media-modes.js');
afterAll(() => cleanupTempDataRoots());

describe('whole-workflow media modes', () => {
  it('preserves legacy code-only intent and every historical asset without enabling a provider', () => {
    const legacy = { automation: { tools: ['code:render'] }, scenes: [{ sceneId: 's', referenceImageId: 'historical.png' }] };
    const migrated = migrateMediaMode(legacy);
    expect(migrated).toEqual({ ...legacy, mediaMode: 'code-only' });
    expect(migrateMediaMode(migrated)).toBe(migrated);
    expect(musicVideoMediaMode(legacy)).toBe('code-only');
    expect(() => assertMusicVideoMedia(migrated, 'image', 'guide generation')).toThrow(/planning guides/);
    expect(castAndSetsMedium(migrated)).toBe('procedural');
    expect(castAndSetsAllowsImages({ ...migrated, automation: { tools: ['image:local'] } })).toBe(false);
    expect(migrateMediaMode({ scenes: legacy.scenes })).toEqual({ scenes: legacy.scenes, mediaMode: 'code-images-video' });
  });

  it('enforces project and take selection, handoff imports and narrowing without deleting selected data', async () => {
    const project = await projects.createProject({ name: 'Example', mediaMode: 'code-images' });
    const scene = await projects.addProjectScene(project.id, { label: 'Scene' });
    await expect(projects.updateScene(project.id, scene.sceneId, { videoHistoryId: 'video-example' })).rejects.toMatchObject({ code: 'MUSIC_VIDEO_MEDIA_POLICY' });
    await projects.updateScene(project.id, scene.sceneId, { referenceImageId: 'example.png' });
    await expect(projects.updateProject(project.id, { mediaMode: 'code-only' })).rejects.toMatchObject({ code: 'MUSIC_VIDEO_MEDIA_POLICY' });
    expect((await projects.getProject(project.id)).scenes[0].referenceImageId).toBe('example.png');
    await projects.updateScene(project.id, scene.sceneId, { referenceImageId: null });
    await projects.updateProject(project.id, { mediaMode: 'code-only' });
    await expect(projects.selectSceneTake(project.id, scene.sceneId, (await projects.getProject(project.id)).scenes[0].takes[0].takeId)).rejects.toMatchObject({ code: 'MUSIC_VIDEO_MEDIA_POLICY' });
    const fork = await projects.cloneProject(project.id);
    expect(fork.mediaMode).toBe('code-only');
    expect(fork.scenes[0].takes).toHaveLength(1); // retained history is never destroyed by narrowing/forking
    await expect(projects.createProject({ name: 'Invalid', mediaMode: 'code-only', visualSpec: { references: [{ imageId: 'example.png' }] } })).rejects.toMatchObject({ code: 'MUSIC_VIDEO_MEDIA_POLICY' });
  });

  it('refuses raster and embedded image documents before activation, accepts code+local fonts', async () => {
    const project = await projects.createProject({ name: 'Document', mediaMode: 'code-only' });
    const dir = join(PATHS.data, 'candidate'); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.html'), '<img src="data:image/png;base64,AAAA">');
    await expect(importDocumentDirectory(project.id, 'candidate')).rejects.toMatchObject({ code: 'MUSIC_VIDEO_MEDIA_POLICY' });
    expect((await projects.getProject(project.id)).composition.document).toBeUndefined();
    await writeFile(join(dir, 'index.html'), '<canvas></canvas>');
    await writeFile(join(dir, 'example.woff2'), 'synthetic font');
    const imported = await importDocumentDirectory(project.id, 'candidate');
    expect(imported.project.composition.mode).toBe('document');
    await writeFile(join(dir, 'photo.png'), 'synthetic raster');
    await expect(importDocumentDirectory(project.id, 'candidate')).rejects.toMatchObject({ code: 'MUSIC_VIDEO_MEDIA_POLICY' });
  });
});

it('rejects embedded raster planning guides through the same policy as final documents', async () => {
  const { saveGeneratedDevArtifact } = await import('./devArtifactService.js');
  const project = await projects.createProject({ name: 'Guide example', mediaMode: 'code-only' });
  await expect(saveGeneratedDevArtifact(project.id, { kind: 'art-guide', title: 'Guide', html: '<img src="/api/images/example.png">' })).rejects.toMatchObject({ code: 'MUSIC_VIDEO_MEDIA_POLICY' });
});
