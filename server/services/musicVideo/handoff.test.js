/**
 * Handoff ZIP bundle (#8978) — buildHandoffBundle exercised against the real
 * file-backed project store and the real gallery image directory, so the
 * archive-content and missing-file reporting are proven against actual bytes
 * on disk rather than a mocked resolver.
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../../lib/mockPathsDataRoot.js';
import { collectZipEntries } from '../../lib/zipStream.js';

const ROOT = () => lazyTempDataRoot('mv-handoff-bundle-test-');
vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));

const projects = await import('./projects.js');
const { buildHandoffBundle, buildHandoffManifest } = await import('./handoff.js');

afterAll(cleanupTempDataRoots);

function seedImage(name) {
  mkdirSync(join(ROOT(), 'images'), { recursive: true });
  writeFileSync(join(ROOT(), 'images', name), `bytes-for-${name}`);
}

// Read every entry out of a zip Buffer via a temp file (collectZipEntries
// streams from disk) and return them as { path: string }.
async function readZipEntries(zipBuf) {
  const zipPath = join(ROOT(), `bundle-${Date.now()}.zip`);
  writeFileSync(zipPath, zipBuf);
  const entries = {};
  await collectZipEntries(zipPath, {
    match: () => true,
    onMatch: (buf, entryPath) => { entries[entryPath] = buf; },
  });
  return entries;
}

describe('buildHandoffBundle', () => {
  it('bundles the manifest, every reference image and each scene\'s selected frame, reporting a missing file rather than failing', async () => {
    seedImage('ref-mood.png');
    seedImage('scene-frame.png');
    // 'ref-deleted.png' is referenced but never written to disk.

    const project = await projects.createProject({ name: 'Bundle Test' });
    const scene = await projects.addProjectScene(project.id, { prompt: 'a lighthouse at dusk' });
    await projects.updateProject(project.id, {
      visualSpec: {
        references: [
          { imageId: 'ref-mood.png', role: 'mood', condition: false },
          { imageId: 'ref-deleted.png', role: 'style', condition: false },
        ],
      },
    });
    await projects.updateScene(project.id, scene.sceneId, { referenceImageId: 'scene-frame.png' });
    const stored = await projects.getProject(project.id);

    const { manifest, zip } = await buildHandoffBundle(stored);

    // Missing file reported, not thrown.
    expect(manifest.missing).toEqual([{ filename: 'ref-deleted.png', path: 'references/ref-deleted.png' }]);

    const entries = await readZipEntries(zip);
    expect(Object.keys(entries).sort()).toEqual([
      'manifest.json',
      'references/ref-mood.png',
      `scenes/${manifest.scenes[0].fileTag}-scene-frame.png`,
    ].sort());

    expect(entries['references/ref-mood.png'].toString()).toBe('bytes-for-ref-mood.png');
    expect(entries[`scenes/${manifest.scenes[0].fileTag}-scene-frame.png`].toString()).toBe('bytes-for-scene-frame.png');

    // manifest.json inside the zip is the same object buildHandoffBundle returned.
    const manifestInZip = JSON.parse(entries['manifest.json'].toString());
    expect(manifestInZip).toEqual(manifest);
    expect(manifestInZip.format).toBe('portos.music-video.handoff');
  });

  it('never fails for a project with no references or selected frames', async () => {
    const project = await projects.createProject({ name: 'Empty Bundle Test' });
    const { manifest, zip } = await buildHandoffBundle(project);
    expect(manifest.missing).toEqual([]);
    const entries = await readZipEntries(zip);
    expect(Object.keys(entries)).toEqual(['manifest.json']);
  });
});

describe('buildHandoffManifest typography (#8992)', () => {
  it('keeps typography prose out of the exported frame/shot prompts but leaves it in visualSpec', () => {
    const project = {
      id: 'mv-typo', name: 'Typo Project', version: 1,
      // The song's Suno style shapes planning only; it never reaches a generation prompt.
      concept: { prompt: '', style: 'grainy 16mm', songStyle: 'synth-pop, -metal' },
      visualSpec: {
        palette: ['#112233'],
        cameraRules: 'locked-off wides',
        typography: 'condensed sans, all caps, lower-third titles',
        references: [],
      },
      scenes: [{ sceneId: 's1', prompt: 'waves', framePrompt: 'harbor at dawn' }],
    };

    const manifest = buildHandoffManifest(project);

    expect(manifest.visualSpec.typography).toBe('condensed sans, all caps, lower-third titles');
    expect(manifest.scenes[0].framePrompt).toBe('harbor at dawn, grainy 16mm, color palette #112233; camera: locked-off wides');
    expect(manifest.scenes[0].shotPrompt).toBe("waves, grainy 16mm, color palette #112233; camera: locked-off wides, hold the reference frame's lighting, time of day and palette for the whole shot");
    expect(manifest.scenes[0].framePrompt).not.toMatch(/typography/i);
    expect(manifest.scenes[0].shotPrompt).not.toMatch(/typography/i);
  });
});

 it('preserves the authored bible through save, partial edit, clone and handoff', async () => {
   const concept = { universeId: 'u1', universeStyle: 'Ink silhouettes', moodBoardStyle: 'Watercolor', subjects: [
     { id: 'lead', kind: 'character', role: 'protagonist', name: 'Example singer', description: 'Silver coat' },
   ] };
   const p = await projects.createProject({ name: 'Example production', concept });
   await projects.updateProject(p.id, { concept: { style: 'Monochrome' } });
   const saved = await projects.getProject(p.id);
   expect(saved.concept).toEqual({ ...concept, style: 'Monochrome' });
   const clone = await projects.cloneProject(p.id, {});
   expect(clone.concept).toEqual(saved.concept);
   await projects.addProjectScene(p.id, { framePrompt: 'A close-up', prompt: 'Slow push in' });
   const manifest = buildHandoffManifest(await projects.getProject(p.id));
   expect(manifest.concept.subjects).toEqual(concept.subjects);
   expect(manifest.scenes[0].framePrompt).toContain('Example singer — Silver coat');
   expect(manifest.scenes[0].framePrompt).toContain('Mood board look (palette, lighting and texture only; never its locations, objects or poses): Watercolor');
   // The motion prompt starts from the frame, which already carries the look.
   expect(manifest.scenes[0].shotPrompt).not.toContain('Watercolor');
   expect(manifest.scenes[0].shotPrompt).toContain("hold the reference frame's lighting, time of day and palette for the whole shot");
   expect(manifest.scenes[0].framePrompt).not.toContain('hold the reference frame');
   expect(manifest.scenes[0].shotPrompt).toContain('Universe style: Ink silhouettes');
 });

describe('sceneShotPrompt camera block (#10589)', () => {
  it('appends the four-part camera block for a planned shot, and nothing otherwise', async () => {
    const { sceneShotPrompt } = await import('./handoff.js');
    const { shotCameraPrompt } = await import('../../lib/cameraMovements.js');
    const project = { concept: { prompt: 'Example concept', style: 'ink' } };
    const scene = { sceneId: 's1', prompt: 'a courier leaps between rooftops' };
    const plain = sceneShotPrompt(project, scene);
    const planned = sceneShotPrompt(project, { ...scene, camera: { move: 'crash-zoom', onBeat: true } });
    const block = shotCameraPrompt({ move: 'crash-zoom', onBeat: true });
    expect(plain).not.toContain('Camera movement:');
    expect(planned).toContain(`\n${block}`);
    expect(planned.startsWith(plain.split('\n')[0])).toBe(true);
    expect(sceneShotPrompt(project, { ...scene, camera: { move: 'teleport' } })).toBe(plain);
  });
});
