import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const getSettings = vi.fn();
vi.mock('../services/api', () => ({
  getSettings: (...args) => getSettings(...args),
}));

import useImageRenderSettings from './useImageRenderSettings.js';
import { PIPELINE_IMAGE_DEFAULTS } from '../lib/pipelineImageDefaults.js';

beforeEach(() => {
  getSettings.mockReset();
});

describe('useImageRenderSettings', () => {
  it('starts at the pipeline defaults before settings resolve', () => {
    getSettings.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useImageRenderSettings());
    expect(result.current.imageCfg).toEqual(PIPELINE_IMAGE_DEFAULTS);
  });

  it('reads the stored pipeline image config and fetches silently', async () => {
    getSettings.mockResolvedValue({ pipeline: { imageGen: { modelId: 'custom-model', width: 768 } } });
    const { result } = renderHook(() => useImageRenderSettings());
    await waitFor(() => expect(result.current.imageCfg.modelId).toBe('custom-model'));
    expect(result.current.imageCfg.width).toBe(768);
    expect(getSettings).toHaveBeenCalledWith({ silent: true });
  });

  it('fails open to the defaults when the settings fetch rejects', async () => {
    getSettings.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useImageRenderSettings());
    // No throw; cfg stays at the defaults.
    await waitFor(() => expect(getSettings).toHaveBeenCalled());
    expect(result.current.imageCfg).toEqual(PIPELINE_IMAGE_DEFAULTS);
  });
});
