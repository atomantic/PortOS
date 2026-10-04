import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
vi.mock('../../lib/paths.js', async (original) => makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('mv-media-policy-') }));
vi.mock('./devArtifactStore.js', async (original) => {
  const store = await original();
  return { ...store, writeDevArtifactFile: vi.fn(store.writeDevArtifactFile) };
});
const projects = await import('./projects.js');
const { importDocumentDirectory } = await import('./compositionDocument.js');
const { PATHS } = await import('../../lib/paths.js');
const { acquireBackupSnapshotCut } = await import('../../lib/backupSnapshotBoundary.js');
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
    await writeFile(join(dir, 'scene.js'), '/** @type {Array<Image>} */ const objects = [];');
    const imported = await importDocumentDirectory(project.id, 'candidate');
    expect(imported.project.composition.mode).toBe('document');
    await writeFile(join(dir, 'scene.js'), 'const svg = `<image href="photo.png"/>`;');
    await expect(importDocumentDirectory(project.id, 'candidate')).rejects.toMatchObject({ code: 'MUSIC_VIDEO_MEDIA_POLICY' });
    await writeFile(join(dir, 'scene.js'), 'const objects = [];');
    // Renaming a raster to an allowed local-font extension must not bypass admission.
    await writeFile(join(dir, 'example.woff2'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await expect(importDocumentDirectory(project.id, 'candidate')).rejects.toMatchObject({ code: 'MUSIC_VIDEO_MEDIA_POLICY' });
    await writeFile(join(dir, 'example.woff2'), 'synthetic font');
    await writeFile(join(dir, 'photo.png'), 'synthetic raster');
    await expect(importDocumentDirectory(project.id, 'candidate')).rejects.toMatchObject({ code: 'MUSIC_VIDEO_MEDIA_POLICY' });
  });
});

it('rejects embedded raster planning guides through the same policy as final documents', async () => {
  const { saveGeneratedDevArtifact } = await import('./devArtifactService.js');
  const project = await projects.createProject({ name: 'Guide example', mediaMode: 'code-only' });
  await expect(saveGeneratedDevArtifact(project.id, { kind: 'cast-sets', title: 'Guide', html: '<img src="/api/images/example.png">' })).rejects.toMatchObject({ code: 'MUSIC_VIDEO_MEDIA_POLICY' });
});

it('allows AVIF document images only in a mode that permits images', async () => {
  const project = await projects.createProject({ name: 'AVIF document', mediaMode: 'code-images' });
  const dir = join(PATHS.data, 'avif-candidate');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.html'), '<canvas></canvas>');
  await writeFile(join(dir, 'photo.avif'), Buffer.from([0, 0, 0, 24, ...Buffer.from('ftypavif'), 0, 0, 0, 0]));
  await expect(importDocumentDirectory(project.id, 'avif-candidate')).resolves.toHaveProperty('project.composition.mode', 'document');
  await projects.updateProject(project.id, { mediaMode: 'code-only' });
  await expect(importDocumentDirectory(project.id, 'avif-candidate')).rejects.toMatchObject({ code: 'MUSIC_VIDEO_MEDIA_POLICY' });
});

it('refuses a guide upload when the media mode narrows before its record commit and removes its file', async () => {
  const { importDevArtifact } = await import('./devArtifactService.js');
  const store = await import('./devArtifactStore.js');
  const original = await vi.importActual('./devArtifactStore.js');
  const project = await projects.createProject({ name: 'Concurrent guide', mediaMode: 'code-images' });
  const tempPath = join(PATHS.data, 'uploaded-guide.png');
  await writeFile(tempPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  let storedFile;
  store.writeDevArtifactFile.mockImplementationOnce(async (input) => {
    const written = await original.writeDevArtifactFile(input);
    storedFile = store.resolveDevArtifactFile(written.file);
    await projects.updateProject(project.id, { mediaMode: 'code-only' });
    return written;
  });
  await expect(importDevArtifact(project.id, { tempPath, originalName: 'guide.png', kind: 'cast-sets' }))
    .rejects.toMatchObject({ code: 'DEV_ARTIFACT_CONFLICT' });
  expect((await projects.getProject(project.id)).devArtifacts || []).toEqual([]);
  await expect(stat(storedFile)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(tempPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('drains development artifact bytes and their project record before a backup cut', async () => {
  const { saveGeneratedDevArtifact } = await import('./devArtifactService.js');
  const store = await import('./devArtifactStore.js');
  const original = await vi.importActual('./devArtifactStore.js');
  const project = await projects.createProject({ name: 'Backup artifact', mediaMode: 'code-images' });
  let reachFile;
  let finishFile;
  const atFile = new Promise(resolve => { reachFile = resolve; });
  const fileGate = new Promise(resolve => { finishFile = resolve; });
  store.writeDevArtifactFile.mockImplementationOnce(async input => {
    const written = await original.writeDevArtifactFile(input);
    reachFile();
    await fileGate;
    return written;
  });
  const saving = saveGeneratedDevArtifact(project.id, {
    kind: 'storyboard', title: 'Example', html: '<svg>example</svg>',
  });
  await atFile;
  expect((await projects.getProject(project.id)).devArtifacts || []).toEqual([]);
  let cutAcquired = false;
  const cut = acquireBackupSnapshotCut().then(release => {
    cutAcquired = true;
    return release;
  });
  await Promise.resolve();
  expect(cutAcquired).toBe(false);
  finishFile();
  const { artifact } = await saving;
  const release = await cut;
  try {
    const recorded = (await projects.getProject(project.id)).devArtifacts[0].versions[0];
    expect(recorded.file).toBe(artifact.versions[0].file);
    expect(await readFile(store.resolveDevArtifactFile(recorded.file), 'utf8')).toBe('<svg>example</svg>');
  } finally {
    release();
  }
});

it('blocks reselecting or approving retained raster guides, including embedded HTML, after narrowing', async () => {
  const { importDevArtifact, saveGeneratedDevArtifact } = await import('./devArtifactService.js');
  const { saveProductionDraft, approveProductionReview } = await import('./productionReviewService.js');
  const { productionReadiness, productionReviewBasis } = await import('./productionReview.js');
  const project = await projects.createProject({ name: 'Retained guide', mediaMode: 'code-images' });
  const tempPath = join(PATHS.data, 'retained-guide.png');
  await writeFile(tempPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const { artifact: raster } = await importDevArtifact(project.id, { tempPath, originalName: 'guide.png', kind: 'cast-sets' });
  const { artifact: embedded } = await saveGeneratedDevArtifact(project.id, { kind: 'cast-sets', title: 'Embedded guide', html: '<img src="data:image/png;base64,AAAA">' });
  const draft = { cast: 'Robot', environments: 'City', visualLanguage: 'Orange silhouettes', motionLanguage: 'Walk cycle', guideArtifactId: raster.id };
  await saveProductionDraft(project.id, draft);
  await projects.updateProject(project.id, { mediaMode: 'code-only' });
  expect(productionReadiness(await projects.getProject(project.id)).art.problems).toContain('Code only requires a code-authored visual guide; select a compatible Development artifact.');
  for (const guide of [raster, embedded]) {
    await expect(saveProductionDraft(project.id, { ...draft, guideArtifactId: guide.id })).rejects.toMatchObject({ code: 'MUSIC_VIDEO_MEDIA_POLICY' });
    // A legacy row may already select either guide before migration/narrowing.
    await projects.mutateProjectRecord(project.id, current => ({ project: { ...current, productionReview: { ...current.productionReview, draft: { ...draft, guideArtifactId: guide.id } } } }));
    await expect(approveProductionReview(project.id, { stage: 'art', basis: productionReviewBasis(await projects.getProject(project.id)).art })).rejects.toMatchObject({ code: 'MUSIC_VIDEO_MEDIA_POLICY' });
  }
  const { artifact: authored } = await saveGeneratedDevArtifact(project.id, { kind: 'cast-sets', title: 'Authored guide', html: '<svg><circle r="20" fill="orange"/></svg>' });
  await saveProductionDraft(project.id, { ...draft, guideArtifactId: authored.id });
  const approved = await approveProductionReview(project.id, { stage: 'art', basis: productionReviewBasis(await projects.getProject(project.id)).art });
  expect(approved.readiness.art.approved).toBe(true);
  expect(approved.project.devArtifacts.map(artifact => artifact.id)).toEqual(expect.arrayContaining([raster.id, embedded.id]));
});
