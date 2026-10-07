import { describe, expect, it } from 'vitest';
import { assertFootageVideoModelsCapable, assertPoolEligible } from './productionPool.js';

// Blank local-video pins are the install default. The renderer already resolves
// that omission; Start must accept the same route instead of demanding an id.
const envFor = (resolveVideoModel) => ({
  settings: { imageGen: { local: { pythonPath: '/opt/example/python' } } },
  imageModels: [],
  isVideoModeUsable: () => true,
  resolveVideoModel,
});

describe('local video pool eligibility', () => {
  it('accepts a blank model pin when the install default resolves', async () => {
    const resolveVideoModel = async (id) => (
      id ? { model: null, modelId: id } : { model: { id: 'example-default' }, modelId: 'example-default' }
    );
    await expect(assertPoolEligible([{ kind: 'video', mode: 'local' }], envFor(resolveVideoModel))).resolves.toBeUndefined();
  });

  it('refuses an install default this machine cannot run', async () => {
    const resolveVideoModel = async () => ({
      model: { id: 'example-default', hardwareCompatibility: { state: 'unavailable', reasons: ['needs a GPU'] } },
      modelId: 'example-default',
    });
    await expect(assertPoolEligible([{ kind: 'video', mode: 'local' }], envFor(resolveVideoModel)))
      .rejects.toThrow(/example-default.*cannot run on this hardware/);
  });
});

describe('text-only local video models (footage needs image-to-video)', () => {
  const textOnly = async (id) => ({ model: { id, name: 'Example Text Model', supportedModes: ['text'] }, modelId: id });
  const route = { kind: 'video', mode: 'local', model: 'example-text' };
  it('refuses a text-only pin at Start, naming the model and the missing capability', async () => {
    await expect(assertPoolEligible([route], envFor(textOnly))).rejects.toThrow(/Example Text Model.*image-to-video/);
  });
  it('refuses it for an autopilot start with a 400, but ignores unpinned and image-capable routes', async () => {
    await expect(assertFootageVideoModelsCapable([route], envFor(textOnly)))
      .rejects.toMatchObject({ status: 400, code: 'VIDEO_MODEL_TEXT_ONLY', message: expect.stringMatching(/Example Text Model.*image-to-video/) });
    const capable = async (id) => ({ model: { id, supportedModes: ['text', 'image'] }, modelId: id });
    await expect(assertFootageVideoModelsCapable([route], envFor(capable))).resolves.toBeUndefined();
    await expect(assertFootageVideoModelsCapable([{ kind: 'video', mode: 'local' }], envFor(textOnly))).resolves.toBeUndefined();
  });
});

describe('local image pool eligibility', () => {
  const route = { kind: 'image', mode: 'local' };
  const imageEnv = (models, pin) => ({
    ...envFor(() => {}), imageModels: models,
    settings: { imageGen: { local: { pythonPath: '/opt/example/python', modelId: pin } } },
  });
  it('resolves a blank pin and checks reference conditioning against the same installed model', async () => {
    const env = imageEnv([{ id: 'example-image', pipelineClass: 'QwenImage21Pipeline' }], 'example-image');
    await expect(assertPoolEligible([route], env)).resolves.toBeUndefined();
    const { chooseProductionRoute } = await import('./productionPool.js');
    await expect(chooseProductionRoute({ pool: [route] }, { kind: 'image', conditioning: 1 }, env))
      .resolves.toMatchObject({ route });
    env.imageModels[0].pipelineClass = 'ExamplePipeline';
    await expect(chooseProductionRoute({ pool: [route] }, { kind: 'image', conditioning: 1 }, env))
      .resolves.toMatchObject({ route: null, reasons: [expect.stringContaining('example-image')] });
  });
  it('never falls back for an unavailable named pin, or accepts an incompatible default', async () => {
    const env = imageEnv([{ id: 'example-image' }]);
    await expect(assertPoolEligible([{ ...route, model: 'missing-image' }], env)).rejects.toThrow(/missing-image.*not installed/);
    env.imageModels[0].hardwareCompatibility = { state: 'unavailable', reasons: ['needs a GPU'] };
    await expect(assertPoolEligible([route], env)).rejects.toThrow(/example-image.*cannot run/);
    await expect(assertPoolEligible([route], imageEnv([]))).rejects.toThrow(/not installed/);
  });
});
