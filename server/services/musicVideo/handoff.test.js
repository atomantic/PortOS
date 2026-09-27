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
const { buildHandoffBundle } = await import('./handoff.js');

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
