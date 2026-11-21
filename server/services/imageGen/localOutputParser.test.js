import { describe, expect, it, vi } from 'vitest';
import { classifyLocalRenderFailure, createLocalOutputParser } from './localOutputParser.js';

function parser() {
  const onActivity = vi.fn();
  const onExecution = vi.fn();
  const onFrame = vi.fn();
  const onInferenceProgress = vi.fn();
  const handleLine = createLocalOutputParser({ onActivity, onExecution, onFrame, onInferenceProgress });
  return { handleLine, onActivity, onExecution, onFrame, onInferenceProgress };
}

describe('createLocalOutputParser', () => {
  it('keeps download progress separate from inference steps', () => {
    const { handleLine, onActivity, onFrame, onInferenceProgress } = parser();

    expect(handleLine(' STAGE:download-pipeline:org/model:revision ')).toBe(true);
    expect(onFrame).toHaveBeenLastCalledWith({ type: 'stage', stage: 'download-pipeline', detail: 'org/model:revision' });
    expect(handleLine('50%|██ | 1/2 [1MiB/2MiB]')).toBe(true);
    expect(onFrame).toHaveBeenLastCalledWith({
      type: 'progress', progress: 0.5, phase: 'download-pipeline',
      message: expect.stringContaining('Downloading model'), downloadedBytes: 1024 ** 2, totalBytes: 2 * 1024 ** 2,
    });
    expect(handleLine('DOWNLOAD:2MiB/4MiB')).toBe(true);
    expect(onFrame).toHaveBeenLastCalledWith({
      type: 'status', phase: 'download', message: expect.stringContaining('Downloading model'),
      downloadedBytes: 2 * 1024 ** 2, totalBytes: 4 * 1024 ** 2,
    });
    expect(onInferenceProgress).not.toHaveBeenCalled();

    expect(handleLine('STAGE:inference')).toBe(true);
    expect(onFrame).toHaveBeenLastCalledWith({ type: 'stage', stage: 'inference', detail: '' });
    expect(handleLine('25%|█ | 2/8')).toBe(true);
    expect(onFrame).toHaveBeenLastCalledWith({
      type: 'progress', progress: 0.25, phase: 'inference', message: '25%|█ | 2/8',
    });
    expect(onInferenceProgress).toHaveBeenCalledExactlyOnceWith({ progress: 0.25, step: 2, totalSteps: 8 });
    expect(onActivity).toHaveBeenCalledTimes(5);
  });

  it('routes execution markers and status text independently, ignoring empty lines', () => {
    const { handleLine, onActivity, onExecution, onFrame } = parser();
    expect(handleLine('  ')).toBe(true);
    expect(onActivity).not.toHaveBeenCalled();
    expect(handleLine('IMAGE_EXECUTION:{invalid')).toBe(true);
    expect(onExecution).toHaveBeenCalledExactlyOnceWith({ state: 'malformed' });
    expect(onFrame).not.toHaveBeenCalled();
    expect(handleLine(' Loading weights ')).toBe(false);
    expect(onFrame).toHaveBeenCalledExactlyOnceWith({ type: 'status', message: 'Loading weights' });
  });
});

describe('classifyLocalRenderFailure', () => {
  it('uses the first structured marker and its following prose ahead of heuristics', () => {
    expect(classifyLocalRenderFailure({
      lines: ['❌ Other context', 'USER_ERROR:custom:org/model:revision', 'ImportError: cannot import name X', '❌ Friendly detail'],
      usesTorchVenv: true,
    })).toEqual({
      userKind: 'custom', userRepo: 'org/model:revision', userMessage: 'Friendly detail', invalidateTorchHealth: false,
    });
  });

  it('recognizes the mflux entry point corruption signature before generic import errors', () => {
    expect(classifyLocalRenderFailure({
      lines: ["ModuleNotFoundError: No module named 'mflux.models.flux.cli'"], usesTorchVenv: true,
    })).toEqual({
      userKind: 'mflux_install_corrupted', userRepo: null,
      userMessage: expect.stringContaining('pip uninstall -y mflux'), invalidateTorchHealth: false,
    });
  });

  it('requests health invalidation for explicit and inferred torch runtime failures', () => {
    expect(classifyLocalRenderFailure({
      lines: ['USER_ERROR:torch_runtime_broken', '❌ Reinstall the runtime.'], usesTorchVenv: true,
    })).toEqual({
      userKind: 'torch_runtime_broken', userRepo: null, userMessage: 'Reinstall the runtime.', invalidateTorchHealth: true,
    });
    const lines = ['ImportError: cannot import name Pipeline from diffusers'];
    expect(classifyLocalRenderFailure({ lines, usesTorchVenv: true })).toEqual({
      userKind: 'torch_runtime_broken', userRepo: null,
      userMessage: expect.stringContaining('Reinstall it from Settings'), invalidateTorchHealth: true,
    });
    expect(classifyLocalRenderFailure({ lines, usesTorchVenv: false })).toEqual({
      userKind: null, userRepo: null, userMessage: null, invalidateTorchHealth: false,
    });
  });

  it('extracts the repo for a gated error and leaves ordinary Hugging Face errors unclassified', () => {
    const url = 'https://huggingface.co/example-org/example-model/resolve/main/config.json';
    expect(classifyLocalRenderFailure({
      lines: [`GatedRepoError: Cannot access gated repo for url ${url}`], usesTorchVenv: false,
    })).toEqual({
      userKind: 'gated_repo', userRepo: 'example-org/example-model',
      userMessage: expect.stringContaining('Accept the license at https://huggingface.co/example-org/example-model'),
      invalidateTorchHealth: false,
    });
    expect(classifyLocalRenderFailure({ lines: [`404 Client Error: ${url}`], usesTorchVenv: false })).toEqual({
      userKind: null, userRepo: null, userMessage: null, invalidateTorchHealth: false,
    });
  });
});
