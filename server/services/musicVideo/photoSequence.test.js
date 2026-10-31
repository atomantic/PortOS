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
  await writeFile(engine, (await readFile(engine, 'utf8')).replace('// portos-photo-sequence: 2', '// older engine'));
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

describe.skipIf(!ffmpeg)('timed film events across a photo sequence', () => {
  // Catches repeated events drifting off the song clock (an excerpt that does
  // not reproduce the full render's frames), adding time, painting outside
  // their frames, or a half-strength shutter closing all the way.
  it('repeats gate jumps and a half shutter over the sequence, and an excerpt reproduces those frames', async () => {
    await mkdir(PATHS.images, { recursive: true });
    const colors = [[230, 30, 30], [30, 230, 30], [30, 30, 230], [230, 230, 30], [230, 30, 230]];
    await Promise.all(ids.map((id, i) => sharp({ create: { width: 96, height: 64, channels: 3, background: { r: colors[i][0], g: colors[i][1], b: colors[i][2] } } }).png().toFile(join(PATHS.images, id))));
    const glitches = [
      { atSec: 0.25, style: 'gate-jump', count: 3, everySec: 0.5 },
      { atSec: 0.5, style: 'shutter', strength: 0.5, count: 2, everySec: 1 },
    ];
    const audio = join(PATHS.data, 'events.wav');
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', '-y', audio]);
    const encode = async (name, shot, excerpt = null) => {
      const clips = await resolveSceneClips({ scenes: [shot] }, { layered: true });
      const output = join(PATHS.data, name);
      const plan = buildMusicVideoFfmpegArgs(clips, audio, output, { excerpt, audioDurationSec: 2, canvas: { width: 96, height: 64, fps: 24 } });
      execFileSync(ffmpeg, ['-v', 'error', ...plan.args.filter((arg, i) => !(arg === '-progress' || plan.args[i - 1] === '-progress'))], { stdio: 'pipe' });
      return execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 8 * 1024 * 1024 });
    };
    const clean = await encode('events-clean.mp4', scene);
    const full = await encode('events.mp4', { ...scene, glitches });
    const excerpt = await encode('events-excerpt.mp4', { ...scene, glitches }, { startSec: 9 / 24, endSec: 33 / 24 });
    const bytes = 96 * 64 * 3;
    expect(full.length).toBe(48 * bytes);
    expect(excerpt.length).toBe(24 * bytes);
    const differs = (a, b) => a.some((v, i) => Math.abs(v - b[i]) > 24);
    const frame = (raw, f) => raw.subarray(f * bytes, (f + 1) * bytes);
    const changed = Array.from({ length: 48 }, (_, f) => f).filter((f) => differs(frame(full, f), frame(clean, f)));
    // Gate jumps from frames 6, 18 and 30 (five frames each); shutters from 12 and 36 (six each).
    const windows = [[6, 11], [18, 23], [30, 35], [12, 18], [36, 42]];
    expect(changed.every((f) => windows.some(([a, b]) => f >= a && f < b))).toBe(true);
    for (const [a, b] of windows) expect(changed.some((f) => f >= a && f < b), `${a}-${b}`).toBe(true);
    // The shutter's widest frame at half strength blacks a quarter from each edge, not half.
    const row = (f, y) => [...full.subarray(f * bytes + (y * 96 + 48) * 3, f * bytes + (y * 96 + 48) * 3 + 3)];
    expect(Math.max(...row(14, 4))).toBeLessThan(40);
    expect(Math.max(...row(14, 24))).toBeGreaterThan(150);
    for (let f = 9; f < 33; f++) expect(differs(frame(excerpt, f - 9), frame(full, f)), `frame ${f}`).toBe(false);
  });
});

// #14277: overlapping, laid-out photographs. Prints sit side by side (no two
// boxes touch) so each one's centre pixel says whether that photo is showing.
const prints = [-0.36, -0.18, 0, 0.18, 0.36].map((x, i) => ({ x, y: 0, scale: 0.3, rotation: i === 4 ? 8 : 0, opacity: i === 4 ? 0.5 : 1 }));
const stacked = { ...sequence, overlapFrames: 12, layouts: prints };

// Catches lost or misaligned layouts on save/replan/split, layouts surviving the
// photos they belong to, and stale render evidence after a layout change.
it('saves, validates and fingerprints overlap and per-photo layouts', async () => {
  const created = await projects.createProject({ name: 'Synthetic photo stack' });
  const { sceneId: _sceneId, order: _order, ...input } = { ...scene, photoSequence: stacked };
  const added = await projects.addProjectScene(created.id, input);
  const reopened = await projects.getProject(created.id);
  expect(reopened.scenes[0].photoSequence).toEqual(stacked);
  expect(splitScene(reopened, added.sceneId, { atSec: 1 }).project.scenes.map(s => s.photoSequence)).toEqual([stacked, stacked]);
  const before = captureMusicVideoEvidence(reopened);
  const moved = { ...stacked, layouts: prints.map((layout, i) => i ? layout : { ...layout, x: 0.1 }) };
  expect(captureMusicVideoEvidence(applySceneUpdate(reopened, added.sceneId, { photoSequence: moved }).project)).not.toEqual(before);
  expect(captureMusicVideoEvidence(applySceneUpdate(reopened, added.sceneId, { photoSequence: { ...stacked, overlapFrames: 6 } }).project)).not.toEqual(before);
  for (const bad of [{ overlapFrames: -1 }, { overlapFrames: 241 }, { overlapFrames: 2.5 }, { layouts: [...prints, null] },
    { layouts: [{ ...prints[0], scale: 3 }] }, { layouts: [{ ...prints[0], opacity: 0 }] }, { layouts: [{ ...prints[0], blend: 'screen' }] }]) {
    expect(() => applySceneUpdate(reopened, added.sceneId, { photoSequence: { ...stacked, ...bad } }), JSON.stringify(bad)).toThrow();
  }
  expect(scenePhotoSequence(reopened.scenes[0]).stacked).toBe(true);
  expect(scenePhotoSequence({ ...scene, photoSequence: { ...sequence, overlapFrames: 0, layouts: [] } }).stacked).toBe(false);
});

// Catches an unbounded filter graph: a stack too deep to render is refused with
// its count instead of silently dropping photos.
it('refuses a stacked shot with more arrivals than the render supports', async () => {
  await mkdir(PATHS.images, { recursive: true });
  await Promise.all(ids.map(id => writeFile(join(PATHS.images, id), 'synthetic')));
  const shot = { ...scene, endSec: 11, photoSequence: { ...sequence, intervalFrames: 1, overlapFrames: 1 } };
  const clips = await resolveSceneClips({ scenes: [shot] }, { layered: true });
  expect(() => buildMusicVideoFfmpegArgs(clips, '/tmp/a.wav', '/tmp/out.mp4', { audioDurationSec: 11, canvas: { width: 96, height: 64, fps: 24 } }))
    .toThrow(expect.objectContaining({ code: 'PHOTO_STACK_TOO_DEEP' }));
});

// Catches a document engine that predates stacks silently showing one photo at a time.
it('requires the stacked-layer engine for a stacked sequence document', async () => {
  const created = await projects.createProject({ name: 'Synthetic plain-sequence document' });
  const imported = await importDocumentTemplate(created.id);
  const engine = join(PATHS.data, imported.document.directory, 'engine.js');
  await writeFile(engine, (await readFile(engine, 'utf8')).replace('// portos-photo-sequence: 2', '// portos-photo-sequence: 1'));
  const project = await projects.getProject(created.id);
  await expect(readDocumentFiles({ ...project, scenes: [scene] })).resolves.toBeInstanceOf(Map);
  await expect(readDocumentFiles({ ...project, scenes: [{ ...scene, photoSequence: stacked }] })).rejects.toMatchObject({ code: 'DOCUMENT_PHOTO_SEQUENCE_UNSUPPORTED' });
});

describe.skipIf(!ffmpeg)('overlapping photo stacks through real ffmpeg', () => {
  // Catches lost prior photos during the overlap, wrong layer order, ignored
  // position/opacity, and an excerpt that does not reproduce the full render.
  it('keeps earlier prints visible for the overlap, in place, and an excerpt matches the full render', async () => {
    await mkdir(PATHS.images, { recursive: true });
    const colors = [[230, 30, 30], [30, 230, 30], [30, 30, 230], [230, 230, 30], [230, 30, 230]];
    await Promise.all(ids.map((id, i) => sharp({ create: { width: 96, height: 64, channels: 3, background: { r: colors[i][0], g: colors[i][1], b: colors[i][2] } } }).png().toFile(join(PATHS.images, id))));
    const shot = { ...scene, photoSequence: stacked };
    const clips = await resolveSceneClips({ scenes: [shot] }, { layered: true });
    const audio = join(PATHS.data, 'stack.wav');
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', '-y', audio]);
    const W = 192; const H = 64;
    const encode = (name, excerpt = null) => {
      const output = join(PATHS.data, name);
      const plan = buildMusicVideoFfmpegArgs(clips, audio, output, { excerpt, audioDurationSec: 2, canvas: { width: W, height: H, fps: 24 } });
      execFileSync(ffmpeg, ['-v', 'error', ...plan.args.filter((arg, i) => !(arg === '-progress' || plan.args[i - 1] === '-progress'))], { stdio: 'pipe' });
      return execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 16 * 1024 * 1024 });
    };
    const full = encode('stack.mp4');
    const excerpt = encode('stack-excerpt.mp4', { startSec: 9 / 24, endSec: 33 / 24 });
    const bytes = W * H * 3;
    expect(full.length).toBe(48 * bytes);
    const pixel = (raw, f, i) => { const at = f * bytes + (32 * W + Math.round(W / 2 + prints[i].x * W)) * 3; return [...raw.subarray(at, at + 3)]; };
    for (let f = 0; f < 48; f++) {
      // Independent of the shared selector: photo step k shows from 6k until 6(k+1) + 12.
      const visible = new Set(Array.from({ length: 8 }, (_, k) => k).filter(k => f >= 6 * k && f < 6 * (k + 1) + 12).map(k => k % 5));
      expect(visible.size).toBe(Math.min(3, Math.floor(f / 6) + 1));
      for (let i = 0; i < 5; i++) {
        const expected = visible.has(i) ? colors[i].map(v => v * prints[i].opacity) : [0, 0, 0];
        pixel(full, f, i).forEach((v, c) => expect(Math.abs(v - expected[c]), `frame ${f} photo ${i}`).toBeLessThan(24));
        if (f >= 9 && f < 33) pixel(excerpt, f - 9, i).forEach((v, c) => expect(Math.abs(v - pixel(full, f, i)[c])).toBeLessThan(12));
      }
    }
  });

  // Catches a newer full-frame photo landing beneath an older one.
  it('lays a newer photo over the older one it overlaps', async () => {
    const colors = [[230, 30, 30], [30, 230, 30], [30, 30, 230], [230, 230, 30], [230, 30, 230]];
    await Promise.all(ids.map((id, i) => sharp({ create: { width: 96, height: 64, channels: 3, background: { r: colors[i][0], g: colors[i][1], b: colors[i][2] } } }).png().toFile(join(PATHS.images, id))));
    // The first photo is a small print; every later one fills the frame over it.
    const shot = { ...scene, photoSequence: { ...sequence, overlapFrames: 12, layouts: [prints[2]] } };
    const clips = await resolveSceneClips({ scenes: [shot] }, { layered: true });
    const audio = join(PATHS.data, 'order.wav');
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1', '-y', audio]);
    const output = join(PATHS.data, 'order.mp4');
    const plan = buildMusicVideoFfmpegArgs(clips, audio, output, { audioDurationSec: 1, canvas: { width: 96, height: 64, fps: 24 } });
    execFileSync(ffmpeg, ['-v', 'error', ...plan.args.filter((arg, i) => !(arg === '-progress' || plan.args[i - 1] === '-progress'))], { stdio: 'pipe' });
    const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 8 * 1024 * 1024 });
    const centre = f => [...raw.subarray(f * 96 * 64 * 3 + (32 * 96 + 48) * 3, f * 96 * 64 * 3 + (32 * 96 + 48) * 3 + 3)];
    const corner = f => [...raw.subarray(f * 96 * 64 * 3 + (4 * 96 + 4) * 3, f * 96 * 64 * 3 + (4 * 96 + 4) * 3 + 3)];
    expect(Math.max(...corner(2))).toBeLessThan(24);
    centre(2).forEach((v, c) => expect(Math.abs(v - colors[0][c])).toBeLessThan(24));
    // Frame 8: photo 0 is still inside its overlap, but photo 1 lies on top of it.
    centre(8).forEach((v, c) => expect(Math.abs(v - colors[1][c])).toBeLessThan(24));
    corner(8).forEach((v, c) => expect(Math.abs(v - colors[1][c])).toBeLessThan(24));
  });
});
