import { afterAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/paths.js', async original => makePathsProxy(await original(), {
  dataRoot: () => lazyTempDataRoot('portos-photo-sequence-'),
}));
const { PATHS } = await import('../../lib/paths.js');
const projects = await import('./projectsFile.js');
const { applySceneUpdate, replaceScenes, splitScene } = await import('./projectsLogic.js');
const { resolveSceneClips, buildMusicVideoFfmpegArgs } = await import('./render.js');
const { resolveSceneMedia, buildDocumentData } = await import('./documentRender.js');
const { scenePhotoSequence, photoSequenceIndex } = await import('../../lib/musicVideoImageEffects.js');
const { captureMusicVideoEvidence } = await import('../../lib/musicVideoDependencies.js');
const { importDocumentTemplate, readDocumentFiles } = await import('./compositionDocument.js');
const { findFfmpeg } = await import('../../lib/ffmpeg.js');
const ffmpeg = await findFfmpeg();
afterAll(cleanupTempDataRoots);

const ids = ['photo-a.png', 'photo-b.png', 'photo-c.png', 'photo-d.png', 'photo-e.png'];
const sequence = { enabled: true, imageIds: ids, intervalFrames: 6, rate: 'frames' };
const scene = { sceneId: 'photos', order: 0, startSec: 0, endSec: 2, visualLayer: 'still', stillMove: 'hold', photoSequence: sequence };

// Catches fields lost by persistence/replanning/splitting, or stale render evidence
// surviving a different photo order or cadence.
it('saves/reopens the ordered sequence, preserves edits and restores an ordinary still when disabled', async () => {
  const created = await projects.createProject({ name: 'Synthetic photo sequence' });
  const { sceneId: _sceneId, order: _order, ...input } = scene;
  const added = await projects.addProjectScene(created.id, input);
  const reopened = await projects.getProject(created.id);
  expect(reopened.scenes[0].photoSequence).toEqual(sequence);
  expect(replaceScenes(reopened, [{ startSec: 0, endSec: 2, prompt: 'Replanned' }]).scenes[0].photoSequence).toEqual(sequence);
  expect(splitScene(reopened, added.sceneId, { atSec: 1 }).project.scenes.map(s => s.photoSequence)).toEqual([sequence, sequence]);
  const before = captureMusicVideoEvidence(reopened);
  const reordered = applySceneUpdate(reopened, added.sceneId, { photoSequence: { ...sequence, imageIds: [...ids].reverse() } }).project;
  expect(captureMusicVideoEvidence(reordered)).not.toEqual(before);
  expect(captureMusicVideoEvidence(applySceneUpdate(reopened, added.sceneId, { photoSequence: { ...sequence, intervalFrames: 3 } }).project)).not.toEqual(before);
  await projects.updateScene(created.id, added.sceneId, { photoSequence: { ...sequence, enabled: false } });
  const disabled = (await projects.getProject(created.id)).scenes[0];
  expect(disabled.photoSequence.imageIds).toEqual(ids);
  expect(scenePhotoSequence(disabled)).toBeNull();
  for (const bad of [{ intervalFrames: 0 }, { intervalFrames: 1.5 }, { imageIds: ['../private.png'] }, { imageIds: Array(17).fill('photo.png') }]) {
    expect(() => applySceneUpdate(reopened, added.sceneId, { photoSequence: { ...sequence, ...bad } })).toThrow();
  }
  expect(() => applySceneUpdate({ ...reopened, mediaMode: 'code-only' }, added.sceneId, { photoSequence: sequence })).toThrow(/does not allow/);
});

// Catches dropping missing photos or quietly substituting a scene's reference still.
it('refuses missing selected media in both render paths and exposes every document photo', async () => {
  const project = { scenes: [scene] };
  await expect(resolveSceneClips(project, { layered: true })).rejects.toMatchObject({ code: 'MISSING_SEQUENCE_PHOTOS' });
  await expect(resolveSceneMedia(project)).rejects.toMatchObject({ code: 'MISSING_SEQUENCE_PHOTOS' });
  await mkdir(PATHS.images, { recursive: true });
  await Promise.all(ids.map(id => writeFile(join(PATHS.images, id), 'synthetic')));
  const media = await resolveSceneMedia(project);
  const data = buildDocumentData(project, { media, frame: { width: 96, height: 64 }, clock: { fps: 24, frames: 48, durationSec: 2 }, songDurationSec: 2 });
  expect(data.scenes[0].media.photos).toHaveLength(5);
  expect(data.scenes[0].photoSequence.imageIds).toEqual(ids);
  expect(data.scenes[0].photoSequence.startFrame).toBe(0);
});

// Catches a saved old engine silently ignoring the sequence; ordinary old projects
// remain usable.
it('requires sequence support in an existing composition document', async () => {
  const created = await projects.createProject({ name: 'Synthetic old document' });
  const imported = await importDocumentTemplate(created.id);
  const engine = join(PATHS.data, imported.document.directory, 'engine.js');
  await writeFile(engine, (await readFile(engine, 'utf8')).replace('// portos-photo-sequence: 1', '// older engine'));
  const project = await projects.getProject(created.id);
  await expect(readDocumentFiles(project)).resolves.toBeInstanceOf(Map);
  await expect(readDocumentFiles({ ...project, scenes: [scene] })).rejects.toMatchObject({ code: 'DOCUMENT_PHOTO_SEQUENCE_UNSUPPORTED' });
});

describe.skipIf(!ffmpeg)('photo sequences through real ffmpeg', () => {
  // Catches off-by-one switching, non-repeating order, beat subdivision drift,
  // or excerpt-relative phase resets by reading the actual encoded pixels.
  it.each(['frames', 'beat', 'half'])('matches the shared selector on every frame and excerpt boundary (%s)', async rate => {
    await mkdir(PATHS.images, { recursive: true });
    const colors = [[230, 30, 30], [30, 230, 30], [30, 30, 230], [230, 230, 30], [230, 30, 230]];
    await Promise.all(ids.map((id, i) => sharp({ create: { width: 96, height: 64, channels: 3, background: { r: colors[i][0], g: colors[i][1], b: colors[i][2] } } }).png().toFile(join(PATHS.images, id))));
    const beats = [0, 0.5, 1, 1.5, 2];
    const shot = { ...scene, photoSequence: { ...sequence, rate, intervalFrames: rate === 'frames' ? 6 : 5 } };
    const project = { scenes: [shot] };
    const clips = await resolveSceneClips(project, { layered: true });
    const audio = join(PATHS.data, `sequence-${rate}.wav`);
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', '-y', audio]);
    const encode = (name, excerpt = null) => {
      const output = join(PATHS.data, name);
      const plan = buildMusicVideoFfmpegArgs(clips, audio, output, { beats, excerpt, audioDurationSec: 2, canvas: { width: 96, height: 64, fps: 24 } });
      execFileSync(ffmpeg, ['-v', 'error', ...plan.args.filter((arg, i) => !(arg === '-progress' || plan.args[i - 1] === '-progress'))], { stdio: 'pipe' });
      return execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 8 * 1024 * 1024 });
    };
    const full = encode(`sequence-${rate}.mp4`);
    const excerpt = encode(`sequence-${rate}-excerpt.mp4`, { startSec: 9 / 24, endSec: 33 / 24 });
    const bytes = 96 * 64 * 3;
    expect(full.length).toBe(48 * bytes);
    expect(excerpt.length).toBe(24 * bytes);
    const compiled = scenePhotoSequence(shot, { beats });
    for (let f = 0; f < 48; f++) {
      const expected = Math.floor(f / (rate === 'beat' ? 12 : 6)) % 5;
      expect(photoSequenceIndex(compiled, f / 24)).toBe(expected);
      const pixel = [...full.subarray(f * bytes + (32 * 96 + 48) * 3, f * bytes + (32 * 96 + 48) * 3 + 3)];
      pixel.forEach((v, i) => expect(Math.abs(v - colors[expected][i])).toBeLessThan(18));
      if (f >= 9 && f < 33) {
        const at = (f - 9) * bytes + (32 * 96 + 48) * 3;
        [...excerpt.subarray(at, at + 3)].forEach((v, i) => expect(Math.abs(v - pixel[i])).toBeLessThan(12));
      }
    }
  });
});
