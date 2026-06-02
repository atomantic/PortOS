import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const generateImage = vi.fn();
vi.mock('../services/api', () => ({
  generateImage: (...args) => generateImage(...args),
}));
// pipelineImageCfgToRenderOpts is exercised for real (pure); pass a minimal cfg.

import useSingleImageRender from './useSingleImageRender.js';

const IMG_CFG = { mode: 'local', modelId: 'm', width: 512, height: 512, steps: '', guidance: '', seed: '', negativePrompt: 'lowres', extraStyle: '' };

beforeEach(() => {
  generateImage.mockReset();
});

describe('useSingleImageRender', () => {
  it('builds the prompt, POSTs generateImage, and exposes the queued jobId (single-target)', async () => {
    generateImage.mockResolvedValue({ jobId: 'job-1' });
    const buildPrompt = vi.fn(() => ({ prompt: 'a hero', negativePrompt: 'blur' }));
    const onComplete = vi.fn();
    const { result } = renderHook(() => useSingleImageRender({ buildPrompt, onComplete }));

    let returned;
    await act(async () => { returned = await result.current.render(IMG_CFG); });
    expect(returned).toBe('job-1');
    expect(result.current.jobId).toBe('job-1');
    // The render opts came from imageCfg, the prompt from buildPrompt.
    const body = generateImage.mock.calls[0][0];
    expect(body.prompt).toBe('a hero');
    expect(body.negativePrompt).toBe('blur');
    expect(generateImage.mock.calls[0][1]).toEqual({ silent: true });
  });

  it('aborts without POSTing when buildPrompt returns null', async () => {
    const buildPrompt = vi.fn(() => null);
    const { result } = renderHook(() => useSingleImageRender({ buildPrompt, onComplete: vi.fn() }));
    let returned;
    await act(async () => { returned = await result.current.render(IMG_CFG); });
    expect(returned).toBeNull();
    expect(generateImage).not.toHaveBeenCalled();
  });

  it('calls onError and returns null when the queue POST fails', async () => {
    generateImage.mockRejectedValue(new Error('boom'));
    const onError = vi.fn();
    const { result } = renderHook(() => useSingleImageRender({ buildPrompt: () => ({ prompt: 'p' }), onComplete: vi.fn(), onError }));
    let returned;
    await act(async () => { returned = await result.current.render(IMG_CFG); });
    expect(returned).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(result.current.jobId).toBeNull();
  });

  it('clears the job and runs onComplete exactly once per (key, filename) on completion', async () => {
    generateImage.mockResolvedValue({ jobId: 'job-1' });
    const onComplete = vi.fn();
    const { result } = renderHook(() => useSingleImageRender({ buildPrompt: () => ({ prompt: 'p' }), onComplete }));
    await act(async () => { await result.current.render(IMG_CFG); });
    expect(result.current.jobId).toBe('job-1');

    await act(async () => { await result.current.handleComplete('out.png'); });
    expect(result.current.jobId).toBeNull();
    // Re-fire the same completion (StrictMode / unstable onComplete arrow).
    await act(async () => { await result.current.handleComplete('out.png'); });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith('out.png', '__single__');
  });

  it('tracks per-key jobs for multi-target callers and dedupes per key', async () => {
    generateImage.mockResolvedValueOnce({ jobId: 'job-a' }).mockResolvedValueOnce({ jobId: 'job-b' });
    const onComplete = vi.fn();
    const buildPrompt = vi.fn((key) => ({ prompt: `prompt-${key}` }));
    const { result } = renderHook(() => useSingleImageRender({ buildPrompt, onComplete }));

    await act(async () => { await result.current.render(IMG_CFG, 'char-a'); });
    await act(async () => { await result.current.render(IMG_CFG, 'char-b'); });
    expect(result.current.renderingJobs).toEqual({ 'char-a': 'job-a', 'char-b': 'job-b' });
    expect(buildPrompt).toHaveBeenCalledWith('char-a');
    expect(buildPrompt).toHaveBeenCalledWith('char-b');

    await act(async () => { await result.current.handleComplete('a.png', 'char-a'); });
    expect(result.current.renderingJobs).toEqual({ 'char-b': 'job-b' });
    expect(onComplete).toHaveBeenCalledWith('a.png', 'char-a');

    // The same filename under a DIFFERENT key is a distinct render — not deduped.
    await act(async () => { await result.current.handleComplete('a.png', 'char-b'); });
    expect(onComplete).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenLastCalledWith('a.png', 'char-b');
  });

  it('ignores a completion with no filename but still clears the job', async () => {
    generateImage.mockResolvedValue({ jobId: 'job-1' });
    const onComplete = vi.fn();
    const { result } = renderHook(() => useSingleImageRender({ buildPrompt: () => ({ prompt: 'p' }), onComplete }));
    await act(async () => { await result.current.render(IMG_CFG); });
    await act(async () => { await result.current.handleComplete(null); });
    expect(result.current.jobId).toBeNull();
    expect(onComplete).not.toHaveBeenCalled();
  });
});
