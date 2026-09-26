import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const getSettings = vi.fn();
vi.mock('../services/api', () => ({
  getSettings: (...args) => getSettings(...args),
}));

import useImageRenderSettings from './useImageRenderSettings.js';
import { IMAGE_RENDER_KNOB_DEFAULTS } from '../lib/pipelineImageDefaults.js';
import { LOCAL_IMAGEGEN_DEFAULT_MODEL } from '../lib/imageGenModes.js';

// What the hook reports with no settings blob to resolve against.
const UNRESOLVED = {
  ...IMAGE_RENDER_KNOB_DEFAULTS,
  mode: 'local',
  modelId: LOCAL_IMAGEGEN_DEFAULT_MODEL,
  inheritedBackend: true,
  cloudModel: null,
};

beforeEach(() => {
  getSettings.mockReset();
});

describe('useImageRenderSettings', () => {
  it('starts on the always-usable backend before settings resolve', () => {
    getSettings.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useImageRenderSettings());
    expect(result.current.imageCfg).toEqual(UNRESOLVED);
  });

  it('fails open to the same defaults when the settings fetch rejects', async () => {
    getSettings.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useImageRenderSettings());
    // No throw; cfg stays at the defaults.
    await waitFor(() => expect(getSettings).toHaveBeenCalled());
    expect(result.current.imageCfg).toEqual(UNRESOLVED);
    expect(getSettings).toHaveBeenCalledWith({ silent: true });
  });

  // The bug this hook shipped with: `settings.pipeline.imageGen` is the
  // Pipeline visual FORM's sticky state, so a backend, model, seed or negative
  // prompt set once on a comic page became every deck's and every universe's —
  // while the server resolved those from the install ladder the whole time.
  describe('never inherits the Pipeline form state', () => {
    const PIPELINE_FORM = {
      pipeline: {
        imageGen: {
          mode: 'codex', modelId: 'qwen-image', width: 768, seed: '42', negativePrompt: 'no hands',
        },
      },
    };

    it('retains the install preference for legacy runtime probes', async () => {
      getSettings.mockResolvedValue({ ...PIPELINE_FORM, imageGen: { local: { modelId: 'flux2-klein-9b' } } });
      const { result } = renderHook(() => useImageRenderSettings({ target: 'deck' }));
      await waitFor(() => expect(result.current.imageCfg.modelId).toBe('flux2-klein-9b'));
    });

    it('marks the shipped fallback as inherited', async () => {
      getSettings.mockResolvedValue(PIPELINE_FORM);
      const { result } = renderHook(() => useImageRenderSettings({ target: 'deck' }));
      await waitFor(() => expect(result.current.imageCfg.modelId).toBe(LOCAL_IMAGEGEN_DEFAULT_MODEL));
      expect(result.current.imageCfg.inheritedBackend).toBe(true);
    });

    it('takes the backend from the install-wide mode, not the pipeline form', async () => {
      getSettings.mockResolvedValue({
        ...PIPELINE_FORM,
        imageGen: { mode: 'agy', agy: { enabled: true }, codex: { enabled: true } },
      });
      const { result } = renderHook(() => useImageRenderSettings({ target: 'deck' }));
      await waitFor(() => expect(result.current.imageCfg.mode).toBe('agy'));
    });

    it('leaves the geometry and prompt knobs at the shipped defaults', async () => {
      getSettings.mockResolvedValue(PIPELINE_FORM);
      const { result } = renderHook(() => useImageRenderSettings({ target: 'deck' }));
      await waitFor(() => expect(result.current.imageCfg.width).toBe(IMAGE_RENDER_KNOB_DEFAULTS.width));
      expect(result.current.imageCfg.seed).toBe('');
      expect(result.current.imageCfg.negativePrompt).toBe('');
    });
  });

  // Wiring only — the ladder's own matrix is covered by `renderPinLadder`'s
  // unit tests.
  describe('render pin ladder', () => {
    const CLOUD_ON = { mode: 'codex', codex: { enabled: true }, agy: { enabled: true } };

    it('resolves the record pin, then the target pin, then the install default', async () => {
      getSettings.mockResolvedValue({ imageGen: CLOUD_ON });
      const { result, rerender } = renderHook(
        (props) => useImageRenderSettings(props),
        { initialProps: { record: { imageMode: 'agy' }, target: 'universe-bible' } },
      );
      await waitFor(() => expect(result.current.imageCfg.mode).toBe('agy'));

      getSettings.mockResolvedValue({
        imageGen: CLOUD_ON, renderDefaults: { 'universe-bible': { imageMode: 'agy' } },
      });
      const target = renderHook(() => useImageRenderSettings({ record: {}, target: 'universe-bible' }));
      await waitFor(() => expect(target.result.current.imageCfg.mode).toBe('agy'));

      rerender({ record: {}, target: 'universe-bible' });
      expect(result.current.imageCfg.mode).toBe('codex');
    });

    // The two model knobs are mutually exclusive: whichever one the resolved
    // backend does NOT read is null, so a UI that shows "the model" can't
    // advertise a local model beside a cloud backend.
    it('routes a cloud pin to cloudModel and leaves the local model unset', async () => {
      getSettings.mockResolvedValue({
        imageGen: { ...CLOUD_ON, local: { modelId: 'flux2-klein-9b' } },
      });
      const { result } = renderHook(() => useImageRenderSettings({
        record: { imageMode: 'agy', imageModelId: 'gemini-3.8-flash' }, target: 'deck',
      }));
      await waitFor(() => expect(result.current.imageCfg.cloudModel).toBe('gemini-3.8-flash'));
      expect(result.current.imageCfg.modelId).toBeNull();
    });

    it('leaves both model knobs unset when an unpinned install defaults to a cloud backend', async () => {
      getSettings.mockResolvedValue({ imageGen: { ...CLOUD_ON, local: { modelId: 'flux2-klein-9b' } } });
      const { result } = renderHook(() => useImageRenderSettings({ target: 'deck' }));
      await waitFor(() => expect(result.current.imageCfg.mode).toBe('codex'));
      expect(result.current.imageCfg.modelId).toBeNull();
      expect(result.current.imageCfg.cloudModel).toBeNull();
    });

    it('drops a record pin naming a backend this install does not have enabled', async () => {
      getSettings.mockResolvedValue({ imageGen: CLOUD_ON });
      const { result } = renderHook(() => useImageRenderSettings({
        record: { imageMode: 'grok' }, target: 'deck',
      }));
      await waitFor(() => expect(result.current.imageCfg.mode).toBe('codex'));
    });
  });
});
