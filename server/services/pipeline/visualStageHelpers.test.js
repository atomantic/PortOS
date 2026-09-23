import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  selectLocalImageModelFromSettings: vi.fn(),
  enqueueJob: vi.fn(),
  loraCompatKey: vi.fn(),
  resolveCharacterLoras: vi.fn(),
}));

vi.mock('../imageGen/prepareParams.js', () => ({
  selectLocalImageModelFromSettings: (...args) => mocks.selectLocalImageModelFromSettings(...args),
}));
vi.mock('../mediaJobQueue/index.js', () => ({
  enqueueJob: (...args) => mocks.enqueueJob(...args),
  cancelJob: vi.fn(),
}));
vi.mock('../../lib/runners.js', () => ({ loraCompatKey: (...args) => mocks.loraCompatKey(...args) }));
vi.mock('../characterLoraResolver.js', () => ({
  resolveCharacterLoras: (...args) => mocks.resolveCharacterLoras(...args),
}));
vi.mock('../imageGen/index.js', () => ({
  resolveImageCleaners: vi.fn(() => ({ cleanC2PA: false, denoise: false })),
}));

import { applyCharacterLorasToRender, enqueueImageJob, loraRenderOptions } from './visualStageHelpers.js';
import { IMAGE_GEN_MODE } from '../imageGen/modes.js';

const settings = { imageGen: { local: { pythonPath: '/python', modelId: 'install-pin' } } };
const selectedModel = { id: 'resolved-model' };
const characterLora = {
  filename: 'character.safetensors',
  scale: 0.8,
  triggerWord: 'sampleword',
  character: { entryId: 'entry-1' },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.selectLocalImageModelFromSettings.mockReturnValue(selectedModel);
  mocks.enqueueJob.mockReturnValue({ jobId: 'job-1' });
  mocks.loraCompatKey.mockReturnValue('compat:resolved-model');
  mocks.resolveCharacterLoras.mockResolvedValue([characterLora]);
});

describe('pipeline local model selection', () => {
  it('uses one resolved model for LoRA compatibility and the queued job', async () => {
    const settingsInUse = { ...settings };
    const options = {};
    const loraResult = await applyCharacterLorasToRender({
      matchedCharacters: [{ entryId: 'entry-1' }],
      mode: IMAGE_GEN_MODE.LOCAL,
      options,
      settings: settingsInUse,
    });

    enqueueImageJob({
      prompt: 'pipeline render',
      world: null,
      settings: settingsInUse,
      options: { ...options, ...loraRenderOptions(loraResult.loras) },
      mode: IMAGE_GEN_MODE.LOCAL,
      owner: 'pipeline-test',
      logLine: 'pipeline test',
      selectedModel: loraResult.selectedModel,
    });

    expect(mocks.selectLocalImageModelFromSettings).toHaveBeenCalledOnce();
    expect(mocks.selectLocalImageModelFromSettings).toHaveBeenCalledWith(settingsInUse, undefined);
    expect(mocks.loraCompatKey).toHaveBeenCalledWith(selectedModel);
    expect(mocks.resolveCharacterLoras).toHaveBeenCalledWith(
      [{ entryId: 'entry-1' }],
      { compatKey: 'compat:resolved-model' },
    );
    expect(mocks.enqueueJob.mock.calls[0][0].params).toMatchObject({
      modelId: 'resolved-model',
      loraFilenames: ['character.safetensors'],
      loraScales: [0.8],
    });
  });
});
