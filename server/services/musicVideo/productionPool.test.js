import { describe, expect, it } from 'vitest';
import { assertPoolEligible } from './productionPool.js';

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
