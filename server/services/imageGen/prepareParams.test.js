/**
 * prepareGenerateParams — record render-target resolution (#3231 Phase 4).
 *
 * Scene reference-frame renders (`musicVideo` tag) and universe canon renders
 * (`universeRun` tag) can arrive with NO mode, so the mode must come from the
 * render-target ladder (record pin → renderDefaults[target] → install default)
 * and the layered model must land on `data.cloudModel`, which is what the
 * route's dispatch resolution reads. Only the ladder inputs are mocked; the
 * resolver itself runs for real.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../../lib/paths.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-greybox-image-') }));
afterAll(cleanupTempDataRoots);

const greyboxCatalog = vi.hoisted(() => ({ getIngredient: vi.fn(), listMediaForIngredient: vi.fn() }));
vi.mock('../catalogDB.js', () => greyboxCatalog);

const getSettings = vi.fn(async () => ({}));
vi.mock('../settings.js', () => ({ getSettings: (...a) => getSettings(...a) }));

const getProject = vi.fn(async () => null);
vi.mock('../musicVideo/projects.js', () => ({ getProject: (...a) => getProject(...a) }));

const getUniverseRenderPin = vi.fn(async () => null);
const getUniverseVisualProfile = vi.fn(async () => null);
vi.mock('../universeBuilder/crud.js', () => ({ getUniverseRenderPin: (...a) => getUniverseRenderPin(...a), getUniverseVisualProfile: (...a) => getUniverseVisualProfile(...a) }));

const getStoryboard = vi.fn(async () => null);
vi.mock('../storyboards/index.js', () => ({ getStoryboard: (...a) => getStoryboard(...a) }));

const { prepareGenerateParams, selectLocalImageModel, selectLocalImageModelFromSettings } = await import('./prepareParams.js');
const { AGY_IMAGEGEN_DEFAULT_MODEL } = await import('./modes.js');

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const MODEL_PIN_READ = /\bimageGen\s*\??\.\s*local\s*\??\.\s*modelId\b/;
const ALLOWED_PIN_READERS = new Set([
  'services/imageGen/prepareParams.js',
  'routes/settings.js',
  'lib/validation.js',
]);

function findDirectLocalModelPinReads(root = SERVER_ROOT) {
  const violations = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ['.git', 'build', 'data', 'dist', 'node_modules'].includes(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile() || !/\.(?:js|mjs)$/.test(entry.name) || /\.test\.(?:js|mjs)$/.test(entry.name)) continue;
      const file = relative(SERVER_ROOT, absolutePath).replaceAll('\\', '/');
      if (ALLOWED_PIN_READERS.has(file)) continue;
      const source = readFileSync(absolutePath, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      if (MODEL_PIN_READ.test(source)) violations.push(file);
    }
  };
  walk(root);
  return violations.sort();
}

const CODEX_ON = { codex: { enabled: true, codexPath: '/bin/codex' } };
const run = (data) => prepareGenerateParams({ data, files: undefined, referenceImageFields: [] });

describe('selectLocalImageModel', () => {
  it('keeps an explicit model pin', () => {
    const models = [
      { id: 'dev', hardwareCompatibility: { state: 'unavailable' } },
      { id: 'custom', hardwareCompatibility: { state: 'available' } },
    ];
    expect(selectLocalImageModel('custom', models).id).toBe('custom');
  });

  it('uses Qwen-Image 2.1 as the shipped default when it is available', () => {
    const models = [
      { id: 'other-model', hardwareCompatibility: { state: 'available' } },
      { id: 'qwen-image-2.1', hardwareCompatibility: { state: 'available' } },
    ];
    expect(selectLocalImageModel(undefined, models).id).toBe('qwen-image-2.1');
  });

  it('falls back from an unavailable shipped default to a compatible model', () => {
    const models = [
      { id: 'qwen-image-2.1', hardwareCompatibility: { state: 'unavailable' } },
      { id: 'custom', hardwareCompatibility: { state: 'available' } },
    ];
    expect(selectLocalImageModel(undefined, models).id).toBe('custom');
  });

  // The install-wide pin (settings.imageGen.local.modelId, Settings → Media →
  // Local). Without this rung the setting is a control that silently does
  // nothing for any render whose body omits modelId.
  it('prefers the install pin when the caller omits a model', () => {
    const models = [
      { id: 'dev', hardwareCompatibility: { state: 'available' } },
      { id: 'klein', hardwareCompatibility: { state: 'available' } },
    ];
    expect(selectLocalImageModel(undefined, models, 'klein').id).toBe('klein');
  });

  it('lets the caller\'s own model outrank the install pin', () => {
    const models = [
      { id: 'dev', hardwareCompatibility: { state: 'available' } },
      { id: 'klein', hardwareCompatibility: { state: 'available' } },
    ];
    expect(selectLocalImageModel('dev', models, 'klein').id).toBe('dev');
  });

  it('skips an install pin this host cannot run rather than rejecting the render', () => {
    // The user who saved the pin is not the caller of this render, so a stale
    // or incompatible pin must degrade, never 400.
    const models = [
      { id: 'dev', hardwareCompatibility: { state: 'available' } },
      { id: 'klein', hardwareCompatibility: { state: 'unavailable' } },
    ];
    expect(selectLocalImageModel(undefined, models, 'klein').id).toBe('dev');
    expect(selectLocalImageModel(undefined, models, 'retired-model').id).toBe('dev');
  });

  it('treats a record pin as a hardware-filtered preference before the install pin', () => {
    const models = [
      { id: 'dev', hardwareCompatibility: { state: 'available' } },
      { id: 'record-pin', hardwareCompatibility: { state: 'unavailable' } },
      { id: 'install-pin', hardwareCompatibility: { state: 'available' } },
    ];
    const settings = { imageGen: { local: { modelId: 'install-pin' } } };
    expect(selectLocalImageModelFromSettings(settings, undefined, models, 'record-pin').id).toBe('install-pin');
    expect(selectLocalImageModelFromSettings(settings, undefined, models, 'dev').id).toBe('dev');
  });
});

describe('local model pin ownership', () => {
  it('allows direct install-pin reads only in its resolver and settings writers', () => {
    expect(findDirectLocalModelPinReads()).toEqual([]);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue({});
  getProject.mockResolvedValue(null);
  getUniverseRenderPin.mockResolvedValue(null);
  getUniverseVisualProfile.mockResolvedValue(null);
});

describe('music-video render-target resolution (#3231 Phase 4)', () => {
  it('resolves the owning project record pin and stamps its model onto cloudModel', async () => {
    getSettings.mockResolvedValue({ imageGen: { mode: 'local', ...CODEX_ON } });
    getProject.mockResolvedValue({ id: 'mv-1', imageMode: 'codex', imageModelId: 'record-model' });
    const { data, mode } = await run({ prompt: 'p', musicVideo: { projectId: 'mv-1', sceneId: 's1' } });
    expect(getProject).toHaveBeenCalledWith('mv-1');
    expect(mode).toBe('codex');
    expect(data.cloudModel).toBe('record-model');
  });

  it("resolves renderDefaults['music-video'] when the record has no pin", async () => {
    getSettings.mockResolvedValue({
      imageGen: { mode: 'local', ...CODEX_ON },
      renderDefaults: { 'music-video': { imageMode: 'codex', imageModel: 'target-model' } },
    });
    getProject.mockResolvedValue({ id: 'mv-1' });
    const { data, mode } = await run({ prompt: 'p', musicVideo: { projectId: 'mv-1', sceneId: 's1' } });
    expect(mode).toBe('codex');
    expect(data.cloudModel).toBe('target-model');
  });

  it('an explicit request mode outranks the record pin (and its model does not leak)', async () => {
    getSettings.mockResolvedValue({ imageGen: { mode: 'external', ...CODEX_ON } });
    getProject.mockResolvedValue({ id: 'mv-1', imageMode: 'codex', imageModelId: 'record-model' });
    const { data, mode } = await run({ prompt: 'p', mode: 'local', musicVideo: { projectId: 'mv-1', sceneId: 's1' } });
    expect(mode).toBe('local');
    expect(data.cloudModel).toBeUndefined();
    // The project is read for style references, but its renderer pin cannot override the explicit mode.
    expect(getProject).toHaveBeenCalledOnce();
  });

  it('falls through to the install default with no pins, and a missing project is harmless', async () => {
    getSettings.mockResolvedValue({ imageGen: { mode: 'external' } });
    getProject.mockRejectedValue(new Error('gone'));
    const { mode } = await run({ prompt: 'p', musicVideo: { projectId: 'mv-x', sceneId: 's1' } });
    expect(mode).toBe('external');
  });

  it('renders without a musicVideo tag never touch the project store', async () => {
    getSettings.mockResolvedValue({ imageGen: { mode: 'external' } });
    const { mode } = await run({ prompt: 'p' });
    expect(mode).toBe('external');
    expect(getProject).not.toHaveBeenCalled();
  });
});

describe('universe render-target resolution', () => {
  const AGY_ON = { agy: { enabled: true, agyPath: '/bin/agy' } };
  const tag = { universeId: 'uni-1', universeName: 'Example Universe', category: 'characters' };

  it("resolves the owning universe's record pin for a mode-less canon render", async () => {
    getSettings.mockResolvedValue({ imageGen: { mode: 'local', ...AGY_ON } });
    getUniverseRenderPin.mockResolvedValue({ id: 'uni-1', imageMode: 'agy', imageModelId: 'record-model' });
    const { data, mode } = await run({ prompt: 'p', universeRun: tag });
    expect(getUniverseRenderPin).toHaveBeenCalledWith('uni-1');
    expect(mode).toBe('agy');
    expect(data.cloudModel).toBe('record-model');
  });

  it("resolves renderDefaults['universe-bible'] when the universe has no pin", async () => {
    getSettings.mockResolvedValue({
      imageGen: { mode: 'local', ...AGY_ON },
      renderDefaults: { 'universe-bible': { imageMode: 'agy', imageModel: 'target-model' } },
    });
    getUniverseRenderPin.mockResolvedValue({ id: 'uni-1' });
    const { data, mode } = await run({ prompt: 'p', universeRun: tag });
    expect(mode).toBe('agy');
    expect(data.cloudModel).toBe('target-model');
  });

  it('an explicit request mode outranks the universe pin (and its model does not leak)', async () => {
    getSettings.mockResolvedValue({ imageGen: { mode: 'external', ...AGY_ON } });
    getUniverseRenderPin.mockResolvedValue({ id: 'uni-1', imageMode: 'agy', imageModelId: 'record-model' });
    const { data, mode } = await run({ prompt: 'p', mode: 'local', universeRun: tag });
    expect(mode).toBe('local');
    expect(data.cloudModel).toBeUndefined();
    expect(getUniverseRenderPin).not.toHaveBeenCalled();
  });

  it('falls through to the install default when the universe is gone', async () => {
    getSettings.mockResolvedValue({ imageGen: { mode: 'external' } });
    getUniverseRenderPin.mockRejectedValue(new Error('gone'));
    const { mode } = await run({ prompt: 'p', universeRun: { ...tag, universeId: 'uni-x' } });
    expect(mode).toBe('external');
  });

  it('renders without a universeRun tag never touch the universe store', async () => {
    getSettings.mockResolvedValue({ imageGen: { mode: 'external' } });
    await run({ prompt: 'p' });
    expect(getUniverseRenderPin).not.toHaveBeenCalled();
  });

  // Two tags on one payload used to run BOTH branches: the second overwrote the
  // first's mode while inheriting the model it had just stamped, producing a
  // mismatched mode/model pair and a wasted record read.
  it('resolves the first matching tag only when a payload carries two', async () => {
    getSettings.mockResolvedValue({ imageGen: { mode: 'local', ...AGY_ON, codex: { enabled: true } } });
    getProject.mockResolvedValue({ id: 'mv-1', imageMode: 'codex', imageModelId: 'mv-model' });
    getUniverseRenderPin.mockResolvedValue({ imageMode: 'agy', imageModelId: 'uni-model' });
    const { data, mode } = await run({
      prompt: 'p', musicVideo: { projectId: 'mv-1', sceneId: 's1' }, universeRun: tag,
    });
    expect(mode).toBe('codex');
    expect(data.cloudModel).toBe('mv-model');
    expect(getUniverseRenderPin).not.toHaveBeenCalled();
  });

  // #7366 — stamping the resolved id erases where it came from, and the route's
  // dispatch re-resolves from that id alone. Without the provenance riding
  // beside it, a shipped default materialized here reads as a deliberate choice
  // downstream and the agy retired-default re-point never runs — on exactly the
  // unattended surfaces (Music Video, Universe Bible) it exists to protect.
  it('stamps the shipped-default provenance beside the model it materialized', async () => {
    getSettings.mockResolvedValue({ imageGen: { mode: 'local', ...AGY_ON } });
    getUniverseRenderPin.mockResolvedValue({ imageMode: 'agy', imageModelId: null });
    const { data, mode } = await run({ prompt: 'p', universeRun: tag });
    expect(mode).toBe('agy');
    expect(data.cloudModel).toBe(AGY_IMAGEGEN_DEFAULT_MODEL);
    expect(data.cloudModelIsShippedDefault).toBe(true);
  });

  it('stamps provenance FALSE for a model the record itself pinned', async () => {
    getSettings.mockResolvedValue({ imageGen: { mode: 'local', ...AGY_ON } });
    // The record pins the shipped id by hand — a choice, so it must never be
    // re-pointed out from under the render.
    getUniverseRenderPin.mockResolvedValue({
      imageMode: 'agy', imageModelId: AGY_IMAGEGEN_DEFAULT_MODEL,
    });
    const { data } = await run({ prompt: 'p', universeRun: tag });
    expect(data.cloudModel).toBe(AGY_IMAGEGEN_DEFAULT_MODEL);
    expect(data.cloudModelIsShippedDefault).toBe(false);
  });
});

it('uses moodboard caption text on a backend without image-reference support', async () => {
  getSettings.mockResolvedValue({ imageGen: { mode: 'external' } });
  getProject.mockResolvedValue({ styleReferences: [{ imageId: 'style.png', caption: 'fine silver grain' }] });
  const { data, mode } = await run({ prompt: 'a lighthouse', musicVideo: { projectId: 'mv-1', sceneId: 's1' } });
  expect(mode).toBe('external');
  expect(data.prompt).toContain('fine silver grain');
  expect(data.referenceImagePaths).toBeUndefined();
});

// The renderer limit must not erase inputs before the existing capability gates see them.
it('refuses music-video references on renderers that cannot consume them', async () => {
  getProject.mockResolvedValue({ scenes: [{ sceneId: 's1' }] });
  const request = { prompt: 'a lighthouse', referenceImageFiles: ['lead.png'], musicVideo: { projectId: 'mv-1', sceneId: 's1', compose: true } };
  getSettings.mockResolvedValue({ imageGen: { mode: 'external' } });
  await expect(run({ ...request })).rejects.toMatchObject({ code: 'IMAGE_EDIT_UNSUPPORTED_MODE' });
  getSettings.mockResolvedValue({ imageGen: { mode: 'local' } });
  await expect(run({ ...request, modelId: 'schnell' })).rejects.toMatchObject({ code: 'REFERENCE_IMAGES_FLUX2_ONLY' });
});

// Catches a dropped panel or a take snapshot claiming an identity removed by the renderer cap.
it('retains automatic panel art within the renderer cap and records only the sent cast inputs', async () => {
  const { PATHS } = await import('../../lib/paths.js');
  mkdirSync(PATHS.images, { recursive: true });
  for (const file of ['start.png', 'a.png', 'b.png', 'c.png', 'd.png', 'panel.png']) writeFileSync(join(PATHS.images, file), 'fixture');
  const sheets = ['a', 'b', 'c', 'd'].map((id) => ({ id: `mvr-cs-cast-${id}`, imageId: `${id}.png` }));
  getSettings.mockResolvedValue({ imageGen: { mode: 'codex', ...CODEX_ON } });
  getProject.mockResolvedValue({ visualSpec: { references: sheets }, scenes: [{ sceneId: 's1', panelArt: 'panel.png' }] });
  const { data } = await run({ prompt: 'Raise the hand', referenceImageFiles: ['start.png', 'a.png', 'b.png', 'c.png', 'd.png', 'panel.png'],
    referenceStrengths: [1, 0.8, 0.7, 0.6, 0.5, 0.4],
    musicVideo: { projectId: 'mv-1', sceneId: 's1', compose: true, refine: true, castInputs: { ingredientId: null, guides: [], sheets } } });
  expect(data.referenceImagePaths.map((p) => p.split(/[\\/]/).at(-1))).toEqual(['start.png', 'a.png', 'b.png', 'c.png', 'panel.png']);
  expect(data.referenceImageStrengths).toEqual([1, 0.8, 0.7, 0.6, 0.4]);
  expect(data.musicVideo.castInputs.sheets).toEqual(sheets.slice(0, 3));
});

it('names a retained overflow face sheet in the composed board prompt', async () => {
  const { PATHS } = await import('../../lib/paths.js');
  mkdirSync(PATHS.images, { recursive: true });
  writeFileSync(join(PATHS.images, 'face.png'), 'fixture');
  getSettings.mockResolvedValue({ imageGen: { mode: 'codex', ...CODEX_ON } });
  getProject.mockResolvedValue({ visualSpec: { references: [] }, castAndSets: { status: 'approved', overflowFaceReferences: [
    { id: 'mvr-cs-face-example', imageId: 'face.png', role: 'character', label: 'Example face sheet' },
  ] }, scenes: [{ sceneId: 's1' }] });
  const { data } = await run({ prompt: 'Close-up', referenceImageFiles: ['face.png'], musicVideo: { projectId: 'mv-1', sceneId: 's1', compose: true } });
  expect(data.prompt).toContain('Reference image 1 is Example face sheet');
});

it('keeps FLUX.3 music-video references instead of treating the model as text-only', async () => {
  const { PATHS } = await import('../../lib/paths.js');
  mkdirSync(PATHS.images, { recursive: true });
  const files = Array.from({ length: 6 }, (_, i) => `flux3-${i}.png`);
  for (const file of files) writeFileSync(join(PATHS.images, file), 'fixture');
  getSettings.mockResolvedValue({ imageGen: { mode: 'local' } });
  getProject.mockResolvedValue({ scenes: [{ sceneId: 's1' }] });
  const { data } = await run({ prompt: 'a lighthouse', modelId: 'flux3-klein-q4', width: 1536, height: 864,
    referenceImageFiles: files, musicVideo: { projectId: 'mv-1', sceneId: 's1', compose: true } });
  expect(data.referenceImagePaths.map((p) => p.split(/[\\/]/).at(-1))).toEqual(files);
  expect(data).toMatchObject({ width: 1024, height: 576 });
});

it('uses the configured cloud model limit and the request limit when a provider declares no maximum', async () => {
  const { PATHS } = await import('../../lib/paths.js');
  mkdirSync(PATHS.images, { recursive: true });
  const files = Array.from({ length: 11 }, (_, i) => `cloud-${i}.png`);
  for (const file of files) writeFileSync(join(PATHS.images, file), 'fixture');
  getProject.mockResolvedValue({ scenes: [{ sceneId: 's1' }] });
  for (const [mode, config] of [['fal', { enabled: true, model: 'fal-ai/nano-banana-pro' }], ['grok', { enabled: true }]]) {
    getSettings.mockResolvedValue({ imageGen: { mode, [mode]: config } });
    const { data } = await run({ prompt: 'a lighthouse', mode, referenceImageFiles: files,
      musicVideo: { projectId: 'mv-1', sceneId: 's1', compose: true } });
    expect(data.referenceImagePaths.map((p) => p.split(/[\\/]/).at(-1))).toEqual(files);
  }
});

// Uniquely catches a board still sent with the director's text but without the
// server's composed look, or with the look and no chips for it (#11317).
it('composes a board still from the director\'s text and lists what it adds', async () => {
  getSettings.mockResolvedValue({ imageGen: { mode: 'external' } });
  getProject.mockResolvedValue({ concept: { style: 'grainy 16mm' }, styleReferences: [{ imageId: 'style.png', caption: 'fine silver grain' }],
    scenes: [{ sceneId: 's1', framePrompt: 'harbor at dawn' }] });
  const { data } = await run({ prompt: 'harbor at dawn', musicVideo: { projectId: 'mv-1', sceneId: 's1', compose: true, fromFrame: true } });
  expect(data.prompt).toMatch(/^harbor at dawn, grainy 16mm\nStart from the first reference image.*\. Moodboard style only/s);
  expect(data.promptAdditions.map((item) => item.id)).toEqual(['project-style', 'rework-frame', 'mood-board-style']);
});

// The preview and submission share this preparation path: a Casting guide must
// keep its identity and position even when an init image leads the inputs.
it('names Casting guides and project references in the order the backend receives them', async () => {
  const { PATHS } = await import('../../lib/paths.js');
  mkdirSync(PATHS.images, { recursive: true });
  for (const file of ['init.png', 'guide.png', 'set.png']) writeFileSync(join(PATHS.images, file), 'fixture');
  getSettings.mockResolvedValue({ imageGen: { mode: 'codex', ...CODEX_ON } });
  getProject.mockResolvedValue({
    concept: { subjects: [{ ingredientId: 'cat-example', name: 'Example lead' }] },
    visualSpec: { references: [{ imageId: 'set.png', role: 'set', label: 'Example set' }] },
    scenes: [{ sceneId: 's1', characterVariant: { ingredientId: 'cat-example', age: 7 } }],
  });
  greyboxCatalog.listMediaForIngredient.mockResolvedValue([{ mediaKey: 'guide.png', kind: 'reference', library: { guide: true, variant: { age: 7 } } }]);
  const tag = { projectId: 'mv-1', sceneId: 's1', compose: true };
  const { data } = await run({ prompt: 'A crowd gathers', initImageFile: 'init.png', referenceImageFiles: ['guide.png', 'set.png'], musicVideo: tag });
  expect(data.referenceImagePaths.map((p) => p.split(/[\\/]/).at(-1))).toEqual(['guide.png', 'set.png']);
  expect(data.prompt).toContain('Reference image 2 is Example lead · age 7: this exact person.');
  expect(data.prompt).toContain('Reference image 3 is the set reference "Example set"');
  expect(data.prompt).not.toContain('Reference image 1 is');
  expect(data.prompt).not.toContain('add nobody else');
  expect(data.promptAdditions.find((item) => item.id === 'reference-map').text).toContain('Reference image 2');

  // Without a separate init image, the explicitly picked frame keeps slot 1,
  // even when that file also appears in the project's reference catalog.
  const picked = await run({ prompt: 'A crowd gathers', referenceImageFiles: ['set.png', 'guide.png'], musicVideo: { ...tag, fromFrame: true } });
  expect(picked.data.prompt).not.toContain('Reference image 1 is');
  expect(picked.data.prompt).toContain('Reference image 2 is Example lead · age 7');

  // A missing catalog read leaves the project's own reference usable.
  greyboxCatalog.listMediaForIngredient.mockResolvedValue(null);
  const fallback = await run({ prompt: 'A crowd gathers', referenceImageFiles: ['guide.png', 'set.png'], musicVideo: tag });
  expect(fallback.data.prompt).not.toContain('Reference image 1 is');
  expect(fallback.data.prompt).toContain('Reference image 2 is the set reference "Example set"');

  const peer = await prepareGenerateParams({ data: { prompt: 'A crowd gathers', initImageFile: 'init.png', referenceImageFiles: ['set.png'], musicVideo: tag, mediaProviderPeerId: '00000000-0000-4000-8000-000000000001' }, referenceImageFields: [], preview: true });
  expect((peer.data.promptAdditions || []).map((item) => item.id)).not.toContain('reference-map');
});

// Composition must not describe the reduced inputs of a degraded render.
it('refuses incompatible composed FLUX.2 inputs and preserves supported reference positions', async () => {
  const { PATHS } = await import('../../lib/paths.js');
  mkdirSync(PATHS.images, { recursive: true });
  writeFileSync(join(PATHS.images, 'lead.png'), 'fixture');
  getSettings.mockResolvedValue({ imageGen: { mode: 'local' } });
  getProject.mockResolvedValue({ visualSpec: { references: [{ imageId: 'lead.png', role: 'character', label: 'Example lead' }] }, scenes: [{ sceneId: 's1' }] });
  const request = { prompt: 'A crowd gathers', modelId: 'flux2-klein-9b', referenceImageFiles: ['lead.png'], musicVideo: { projectId: 'mv-1', sceneId: 's1', compose: true } };
  const supported = await run({ ...request });
  expect(supported.data.prompt).toContain('Reference image 1 is Example lead');
  for (const extra of [{ initImageFile: 'init.png' }, { loraFilenames: ['example.safetensors'] }, { loraPaths: ['example.safetensors'] }]) {
    await expect(run({ ...request, ...extra })).rejects.toMatchObject({ status: 400, code: 'IMAGE_GEN_FLUX2_INPUTS_INCOMPATIBLE' });
  }
});

// Uniquely catches a panel-linked still sent without its live panel's picks, or naming the wrong reference as the sketch.
it('directs a panel-linked still by its live storyboard panel and names the sketch\'s reference slot', async () => {
  const { PATHS } = await import('../../lib/paths.js');
  mkdirSync(PATHS.images, { recursive: true });
  for (const file of ['sheet.png', 'sketch.png', 'init.png']) writeFileSync(join(PATHS.images, file), 'fixture');
  getSettings.mockResolvedValue({ imageGen: { mode: 'codex', ...CODEX_ON } });
  getProject.mockResolvedValue({ storyboardId: 'sb-1', scenes: [{ sceneId: 's1', panelId: 'panel-1', panelArt: 'sketch.png' }] });
  getStoryboard.mockResolvedValue({ id: 'sb-1', beats: [{ panels: [{ id: 'panel-1', action: 'She laces her skates alone', framing: 'wide', facing: 'front' }] }] });
  const { data } = await run({ prompt: '', referenceImageFiles: ['sheet.png', 'sketch.png'], musicVideo: { projectId: 'mv-1', sceneId: 's1', compose: true } });
  expect(getStoryboard).toHaveBeenCalledWith('sb-1');
  expect(data.prompt).toContain('She laces her skates alone\nFraming: wide establishing shot.');
  expect(data.prompt).toContain('Reference image 2 is the storyboard sketch');
  expect(data.promptAdditions.map((item) => item.id).slice(0, 3)).toEqual(['storyboard-action', 'storyboard-shot', 'storyboard-sketch']);
  const withInit = await run({ prompt: '', initImageFile: 'init.png', referenceImageFiles: ['sheet.png', 'sketch.png'], musicVideo: { projectId: 'mv-1', sceneId: 's1', compose: true } });
  expect(withInit.data.prompt).toContain('Reference image 3 is the storyboard sketch');
});

// Pins cleaner precedence where requests are prepared, without loading a backend.
describe('prepared image cleaner policy', () => {
  it('inherits saved per-mode flags and accepts explicit boolean overrides', async () => {
    getSettings.mockResolvedValue({ imageGen: { mode: 'external', external: { cleanC2PA: true, denoise: false } } });
    expect((await run({ prompt: 'p' })).data).toMatchObject({ cleanC2PA: true, denoise: false });
    expect((await run({ prompt: 'p', cleanC2PA: false, denoise: true })).data).toMatchObject({ cleanC2PA: false, denoise: true });
    expect((await run({ prompt: 'p', cleanC2PA: 'false', denoise: null })).data).toMatchObject({ cleanC2PA: true, denoise: false });
  });

  it('defaults cleanup on only for emitting modes and never opts into denoise', async () => {
    for (const mode of ['external', 'codex', 'grok']) {
      getSettings.mockResolvedValue({ imageGen: { mode, codex: { enabled: true }, grok: { enabled: true } } });
      expect((await run({ prompt: 'p' })).data).toMatchObject({ cleanC2PA: mode !== 'grok', denoise: false });
    }
  });
});

// Catches a board render whose preview includes the layout but whose actual image inputs omit it.
it('sends the live greybox capture before set plates, retains the edited frame first, and refuses a removed capture', async () => {
  const { PATHS } = await import('../../lib/paths.js');
  mkdirSync(PATHS.images, { recursive: true });
  for (const file of ['layout.png', 'old-layout.png', 'plate.png', 'edit.png']) writeFileSync(join(PATHS.images, file), 'fixture');
  const setReference = { subjectId: 'rink', greyboxShotId: 'wide' };
  getSettings.mockResolvedValue({ imageGen: { mode: 'codex', ...CODEX_ON } });
  getProject.mockResolvedValue({ concept: { subjects: [{ id: 'rink', kind: 'place', ingredientId: 'cat-rink', name: 'Example Rink' }] }, scenes: [{ sceneId: 's1', setReference }] });
  greyboxCatalog.getIngredient.mockResolvedValue({ type: 'place', payload: { greybox: { anchors: [{ id: 'rail', label: 'Singer' }], shots: [{ id: 'wide', figures: [{ anchorId: 'rail', pose: 'waving' }] }] } } });
  greyboxCatalog.listMediaForIngredient.mockResolvedValue([{ kind: 'reference', role: 'greybox-shot:wide', mediaKey: 'layout.png' }]);
  const tag = { projectId: 'mv-1', sceneId: 's1', compose: true };
  const rendered = await run({ prompt: 'A wide shot', referenceImageFiles: ['plate.png'], musicVideo: tag });
  expect(rendered.data.referenceImagePaths.map((p) => p.split(/[\\/]/).at(-1))).toEqual(['layout.png', 'plate.png']);
  expect(rendered.data.promptAdditions.filter((item) => item.id === 'greybox-figure-0')).toHaveLength(1);
  expect(rendered.data.prompt).toContain('Reference image 1 is the set reference');
  expect(rendered.data.prompt).not.toContain('it shows no people');
  // Without the composer, the greybox blocking text is appended to the authored prompt once.
  const uncomposed = await run({ prompt: 'A wide shot', referenceImageFiles: ['plate.png'], musicVideo: { projectId: 'mv-1', sceneId: 's1' } });
  expect(uncomposed.data.prompt).toMatch(/^A wide shot\n.*Singer stands at the "rail" mark, waving/s);
  expect(uncomposed.data.promptAdditions.filter((item) => item.id === 'greybox-figure-0')).toHaveLength(1);
  const refined = await run({ prompt: 'Raise the hand', referenceImageFiles: ['edit.png', 'plate.png'], musicVideo: { ...tag, refine: true } });
  expect(refined.data.referenceImagePaths.map((p) => p.split(/[\\/]/).at(-1))).toEqual(['edit.png', 'layout.png', 'plate.png']);
  expect(refined.data.prompt).toContain('Singer stands at the "rail" mark, waving');
  const refreshed = await run({ prompt: 'A wide shot', referenceImageFiles: ['old-layout.png', 'plate.png'], musicVideo: { ...tag, greyboxImageId: 'old-layout.png' } });
  expect(refreshed.data.referenceImagePaths.map((p) => p.split(/[\\/]/).at(-1))).toEqual(['layout.png', 'plate.png']);
  const editedOldCapture = await run({ prompt: 'Raise the hand', referenceImageFiles: ['old-layout.png', 'plate.png'], musicVideo: { ...tag, greyboxImageId: 'old-layout.png', refine: true } });
  expect(editedOldCapture.data.referenceImagePaths.map((p) => p.split(/[\\/]/).at(-1))).toEqual(['old-layout.png', 'layout.png', 'plate.png']);
  greyboxCatalog.listMediaForIngredient.mockResolvedValue([]);
  await expect(run({ prompt: 'A wide shot', musicVideo: tag })).rejects.toMatchObject({ code: 'MUSIC_VIDEO_GREYBOX_UNAVAILABLE' });
});

// Public preparation path used by prompt preview and actual submission.
it('snapshots universe photography for rendering and respects an explicit disabled override', async () => {
  const { naturalUniverseVisualProfile } = await import('../../lib/universeVisualProfile.js');
  const profile = naturalUniverseVisualProfile();
  getUniverseVisualProfile.mockResolvedValue(profile);
  getSettings.mockResolvedValue({ imageGen: { mode: 'codex', ...CODEX_ON } });
  const body = { prompt: 'A person beside a window', mode: 'codex', universeRun: { universeId: 'example-universe' } };
  const prepared = await run(body);
  expect(prepared.data.prompt).toContain(profile.generation.lighting);
  expect(prepared.data.visualProfile).toEqual(profile);
  expect(prepared.data.visualProfileRevision).toMatch(/^[a-f0-9]{64}$/);
  const disabled = await run({ ...body, visualProfileOverride: null });
  expect(disabled.data.prompt).toBe(body.prompt);
  expect(disabled.data.visualProfile).toBeUndefined();
});

it('leaves FableLoom authored intent for its compiler instead of composing photography twice', async () => {
  const { naturalUniverseVisualProfile } = await import('../../lib/universeVisualProfile.js');
  getSettings.mockResolvedValue({ imageGen: { mode: 'codex', ...CODEX_ON } });
  const result = await run({ prompt: 'A cautious arrival', negativePrompt: 'authored avoid', visualProfileOverride: naturalUniverseVisualProfile(), fableLoom: { loomId: 'loom-1', episodeId: 'ep-1', nodeId: 'node-1' } });
  expect(result.data.prompt).toBe('A cautious arrival');
  expect(result.data.negativePrompt).toBe('authored avoid');
  expect(result.data.visualProfile).toBeUndefined();
  expect(result.data.visualProfileOverride).toBeDefined();
});
