import { describe, it, expect } from 'vitest';
import { PIPELINE_IMAGE_DEFAULTS, readPipelineImageSettings, pipelineImageCfgToRenderOpts } from './pipelineImageDefaults';
import { IMAGE_GEN_MODE } from './imageGenBackends';

describe('readPipelineImageSettings', () => {
  it('prefers an enabled cloud backend over local, codex first', () => {
    expect(readPipelineImageSettings({ imageGen: { codex: { enabled: true }, agy: { enabled: true } } }).mode)
      .toBe(IMAGE_GEN_MODE.CODEX);
    expect(readPipelineImageSettings({ imageGen: { agy: { enabled: true } } }).mode)
      .toBe(IMAGE_GEN_MODE.AGY);
    expect(readPipelineImageSettings({}).mode).toBe(PIPELINE_IMAGE_DEFAULTS.mode);
  });

  it("lets a stored settings.pipeline.imageGen mode win over the cloud preference", () => {
    expect(readPipelineImageSettings({
      imageGen: { codex: { enabled: true } },
      pipeline: { imageGen: { mode: 'local' } },
    }).mode).toBe(IMAGE_GEN_MODE.LOCAL);
  });
});

describe('pipelineImageCfgToRenderOpts', () => {
  it('sends modelId only for local', () => {
    const local = pipelineImageCfgToRenderOpts({ mode: 'local', modelId: 'flux-1', width: 512 });
    expect(local.modelId).toBe('flux-1');
    const cloud = pipelineImageCfgToRenderOpts({ mode: 'agy', modelId: 'flux-1', width: 512 });
    expect(cloud.modelId).toBeUndefined();
  });

  // `Number('')` is 0 — an unset seed used to ride out as a HARD `seed: 0`,
  // which the local runner honors as a fixed seed, so every render of the same
  // prompt came back identical. Unset must mean absent.
  it('omits unset numeric knobs instead of coercing the blank to zero', () => {
    const opts = pipelineImageCfgToRenderOpts({
      ...PIPELINE_IMAGE_DEFAULTS, mode: 'local', modelId: 'flux-1', width: 512, height: 512,
    });
    expect(opts).toEqual({ mode: 'local', modelId: 'flux-1', width: 512, height: 512 });
    expect(pipelineImageCfgToRenderOpts({ mode: 'local', seed: '  ' }).seed).toBeUndefined();
    expect(pipelineImageCfgToRenderOpts({ mode: 'local' }).guidance).toBeUndefined();
  });

  it('still sends an explicit zero the user actually typed', () => {
    const opts = pipelineImageCfgToRenderOpts({ mode: 'local', seed: '0', guidance: '0' });
    expect(opts.seed).toBe(0);
    expect(opts.guidance).toBe(0);
  });

  it('forwards a cloud-CLI model as cloudModel, which is the knob the dispatcher reads', () => {
    expect(pipelineImageCfgToRenderOpts({ mode: 'agy', cloudModel: 'gemini-3.5-pro' }).cloudModel)
      .toBe('gemini-3.5-pro');
    // Local reads modelId instead — a cloudModel here would be dead weight.
    expect(pipelineImageCfgToRenderOpts({ mode: 'local', cloudModel: 'gemini-3.5-pro' }).cloudModel)
      .toBeUndefined();
  });
});
// @vitest-environment node
