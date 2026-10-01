import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

const h = vi.hoisted(() => ({ calls: 0, prompt: '', response: '', onSubmit: null }));
vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-document-author-'),
}));
vi.mock('../promptRunner.js', () => ({
  assertProvider: () => {},
  resolveProviderAndModel: async () => ({ provider: { id: 'stub-provider' }, selectedModel: 'fixture-model' }),
  runPromptThroughProvider: async ({ prompt, beforeExecute }) => {
    if (beforeExecute) await beforeExecute({ provider: { id: 'stub-provider' }, model: 'fixture-model' });
    h.calls += 1; h.prompt = prompt;
    if (h.onSubmit) await h.onSubmit();
    return { text: h.response };
  },
}));

const { PATHS } = await import('../../lib/paths.js');
const projects = await import('./projects.js');
const { importDocumentTemplate } = await import('./compositionDocument.js');
const { generateMixedMediaDocument, regenerateMixedMediaSection, acceptMixedMediaDocument } = await import('./documentGeneration.js');

const source = (color) => `function render(ctx, env) { ctx.fillStyle = '${color}'; ctx.fillRect(0, 0, env.width, env.height); }`;
const response = (colors) => JSON.stringify({ sections: Object.entries(colors).map(([id, color]) => ({ id, source: source(color) })) });
const manifestAt = async (document) => JSON.parse(await readFile(join(PATHS.data, document.directory, 'manifest.json'), 'utf8'));

afterAll(() => cleanupTempDataRoots());
beforeEach(() => { h.onSubmit = null; h.calls = 0; h.prompt = ''; h.response = response({ intro: '#112233', still: '#445566', clip: '#778899' }); });

async function fixture() {
  await mkdir(PATHS.images, { recursive: true });
  await mkdir(PATHS.videos, { recursive: true });
  await writeFile(join(PATHS.images, 'still.png'), 'selected still');
  await writeFile(join(PATHS.videos, 'clip.webm'), 'selected clip');
  await writeFile(join(PATHS.data, 'video-history.json'), JSON.stringify([{ id: 'vh-clip', filename: 'clip.webm', numFrames: 240, fps: 24, width: 640, height: 360 }]));
  const created = await projects.createProject({ name: 'Example Song' });
  await projects.mutateProjectRecord(created.id, (current) => ({ project: {
    ...current,
    audioAnalysis: { durationSec: 30, beats: [0, 10, 20], downbeats: [0, 10, 20], features: { brightness: [0.2] }, sections: [
      { id: 'intro', label: 'Intro', startSec: 0, endSec: 10 },
      { id: 'still', label: 'Verse', startSec: 10, endSec: 20 },
      { id: 'clip', label: 'Hook', startSec: 20, endSec: 30 },
    ] },
    lyricCues: [{ id: 'l1', text: 'Example words', startSec: 19.8, endSec: 21, words: [{ w: 'Example', startSec: 20 }] }],
    visualSpec: { palette: ['#112233', '#ffffff', '#ff7700'], cameraRules: 'Low angle' },
    productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: 0 },
    treatment: { revision: 1, brief: { premise: 'A paper kite crosses the city', graphicLanguage: 'Ink and cut paper' }, arc: { motifs: [{ name: 'Kite', evolution: 'Fold to flight' }] }, shotDirections: [
      { sceneId: 's-intro', medium: 'procedural', mediumRationale: 'Open with graphics' },
      { sceneId: 's-still', medium: 'still', mediumRationale: 'Hold the selected image' },
      { sceneId: 's-clip', medium: 'existing-footage', mediumRationale: 'Use the selected take', framing: 'Tight', transitionIn: 'Hard cut' },
    ] },
    scenes: [
      { sceneId: 's-intro', order: 0, startSec: 0, endSec: 10 },
      { sceneId: 's-still', order: 1, startSec: 10, endSec: 20, referenceImageId: 'still.png' },
      { sceneId: 's-clip', order: 2, startSec: 20, endSec: 30, shotMode: 'performance', videoHistoryId: 'vh-clip', takes: [
        { kind: 'video', assetId: 'vh-clip', shotInstruction: { shotMode: 'performance', edit: { inSec: 1, outSec: 8 } } },
      ] },
    ],
  } }));
  return created.id;
}

describe('treatment-driven mixed-media document authoring', () => {
  it('preflights selected media before a provider call and stages a reviewable 30-second document', async () => {
    const id = await fixture();
    const original = await projects.getProject(id);
    await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, scenes: current.scenes.map((s) => s.sceneId === 's-still' ? { ...s, referenceImageId: 'missing.png' } : s) } }));
    await expect(generateMixedMediaDocument(id)).rejects.toMatchObject({ code: 'COMPOSITION_MEDIA_MISSING' });
    expect(h.calls).toBe(0);
    await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, scenes: original.scenes } }));
    const active = (await importDocumentTemplate(id)).document;
    const { document: candidate } = await generateMixedMediaDocument(id, { providerId: 'stub-provider', model: 'fixture-model' });
    const project = await projects.getProject(id);
    expect(project.composition.document.directory).toBe(active.directory);
    expect(project.composition.documentDraft.directory).toBe(candidate.directory);
    const manifest = await manifestAt(candidate);
    expect(manifest.song.durationSec).toBe(30);
    expect(manifest.scenes.map((s) => [s.visualLayer, s.assetId])).toEqual([
      ['card', null], ['still', 'still.png'], ['footage', 'vh-clip'],
    ]);
    expect(manifest.scenes[2].inSec).toBe(1);
    expect(h.prompt).toContain('A paper kite crosses the city');
    expect(h.prompt).toContain('Fold to flight');
    expect(h.prompt).toContain('brightness');
    expect(h.prompt).toContain('still.png');
    expect(h.prompt).toContain('vh-clip');
    expect(h.calls).toBe(1); // no image or video provider
    expect(await readFile(join(PATHS.data, candidate.directory, 'generated.js'), 'utf8')).toContain('function render(ctx, env)');
  });

  it('revises one section, preserves the other functions, and refuses a stale acceptance', async () => {
    const id = await fixture();
    const first = (await generateMixedMediaDocument(id)).document;
    const before = await manifestAt(first);
    h.response = response({ still: '#00ff00' });
    const second = (await regenerateMixedMediaSection(id, 'still', { expectedDraft: first.directory })).document;
    const after = await manifestAt(second);
    expect(after.sections.map((s) => s.source)).toEqual([before.sections[0].source, source('#00ff00'), before.sections[2].source]);
    await expect(regenerateMixedMediaSection(id, 'still', { expectedDraft: first.directory })).rejects.toMatchObject({ code: 'COMPOSITION_DRAFT_STALE' });
    await projects.mutateProjectRecord(id, (current) => ({ project: {
      ...current, scenes: current.scenes.map((scene) => scene.sceneId === 's-clip'
        ? { ...scene, takes: [{ ...scene.takes[0], shotInstruction: { shotMode: 'performance', edit: { inSec: 2, outSec: 8 } } }] }
        : scene),
    } }));
    await expect(acceptMixedMediaDocument(id, second.directory)).rejects.toMatchObject({ code: 'COMPOSITION_DRAFT_STALE' });
    expect((await projects.getProject(id)).composition.documentDraft.directory).toBe(second.directory);
  });

  it('refuses a candidate after the uploaded master song changes without changing its analysis shape', async () => {
    const id = await fixture();
    const candidate = (await generateMixedMediaDocument(id)).document;
    await projects.mutateProjectRecord(id, (current) => ({ project: {
      ...current, uploadedAudioFilename: 'replacement-master.wav',
    } }));
    await expect(acceptMixedMediaDocument(id, candidate.directory)).rejects.toMatchObject({ code: 'COMPOSITION_DRAFT_STALE' });
  });
});


it('checks production authorization before provider submission and again before candidate publication/acceptance', async () => {
  const id = await fixture();
  const blocked = () => { throw Object.assign(new Error('Production canceled'), { code: 'PRODUCTION_STEP_CLOSED' }); };
  await expect(generateMixedMediaDocument(id, { beforeSubmit: blocked })).rejects.toMatchObject({ code: 'PRODUCTION_STEP_CLOSED' });
  expect(h.calls).toBe(0);
  let active = true;
  h.onSubmit = () => { active = false; };
  await expect(generateMixedMediaDocument(id, { verifyCurrent: () => { if (!active) blocked(); } })).rejects.toMatchObject({ code: 'PRODUCTION_STEP_CLOSED' });
  expect(h.calls).toBe(1);
  expect((await projects.getProject(id)).composition?.documentDraft).toBeUndefined();
  h.onSubmit = null;
  const staged = (await generateMixedMediaDocument(id)).document;
  await expect(acceptMixedMediaDocument(id, staged.directory, { verifyCurrent: blocked })).rejects.toMatchObject({ code: 'PRODUCTION_STEP_CLOSED' });
  expect((await projects.getProject(id)).composition.documentDraft.directory).toBe(staged.directory);
});
