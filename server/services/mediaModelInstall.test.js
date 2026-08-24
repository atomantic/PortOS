import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pinPlatform } from '../lib/testHelper.js';

vi.mock('./hfToken.js', () => ({ getHfToken: vi.fn(async () => '') }));
vi.mock('../lib/mediaModels.js', () => ({ addUserModelEntry: vi.fn((entry) => entry) }));

const { addModelFromHuggingface } = await import('./mediaModelInstall.js');
const { addUserModelEntry } = await import('../lib/mediaModels.js');

// Minimal fetch mock returning an HF `/api/models/{repo}` body.
const mockFetch = (body) => vi.fn(async () => ({
  ok: true,
  text: async () => JSON.stringify(body),
}));

// addModelFromHuggingface reads process.platform per call and REFUSES a video
// add on Windows (the Windows render path loads a fixed built-in model and
// cannot use a custom HF repo). These cases assert the non-Windows contract,
// so pin the platform rather than letting the host decide — otherwise the
// suite fails on a Windows runner for a reason it is not testing. The refusal
// itself gets its own case below.
let restorePlatform = () => {};

beforeEach(() => {
  vi.clearAllMocks();
  restorePlatform = pinPlatform('darwin');
});

afterEach(() => {
  restorePlatform();
});

describe('addModelFromHuggingface', () => {
  it('classifies an LTX safetensors repo, builds a video entry, and registers it', async () => {
    const fetchImpl = mockFetch({
      id: 'notapalindrome/ltx23-mlx-av-q4',
      siblings: [{ rfilename: 'model.safetensors' }],
      tags: ['ltx-video'],
    });
    const result = await addModelFromHuggingface(
      { url: 'notapalindrome/ltx23-mlx-av-q4' },
      { fetchImpl },
    );
    expect(result.kind).toBe('video');
    expect(result.entry).toMatchObject({
      id: 'hf-notapalindrome-ltx23-mlx-av-q4',
      runtime: 'mlx_video',
      source: 'user',
    });
    expect(addUserModelEntry).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'hf-notapalindrome-ltx23-mlx-av-q4' }),
      { kind: 'video' },
    );
  });

  it('refuses a GGUF-only repo before registering anything', async () => {
    const fetchImpl = mockFetch({
      id: 'unsloth/LTX-2.3-GGUF',
      siblings: [{ rfilename: 'ltx-2.3-Q4_K_M.gguf' }],
      tags: ['ltx'],
    });
    await expect(
      addModelFromHuggingface({ url: 'unsloth/LTX-2.3-GGUF' }, { fetchImpl }),
    ).rejects.toThrow(/GGUF/);
    expect(addUserModelEntry).not.toHaveBeenCalled();
  });

  it('refuses a pinned revision (render path only pulls the default branch)', async () => {
    const fetchImpl = mockFetch({ id: 'org/x', siblings: [{ rfilename: 'model.safetensors' }], tags: ['ltx'] });
    await expect(
      addModelFromHuggingface({ url: 'org/x@v2.0' }, { fetchImpl }),
    ).rejects.toThrow(/pinned revision/);
    expect(addUserModelEntry).not.toHaveBeenCalled();
  });

  it('honors explicit kind + runner overrides', async () => {
    const fetchImpl = mockFetch({
      id: 'someone/custom',
      siblings: [{ rfilename: 'model.safetensors' }],
    });
    const result = await addModelFromHuggingface(
      { url: 'someone/custom', kind: 'image', runner: 'qwen' },
      { fetchImpl },
    );
    expect(result.entry).toMatchObject({ runner: 'qwen', source: 'user' });
  });

  describe('on Windows', () => {
    beforeEach(() => pinPlatform('win32'));

    it('refuses a custom VIDEO model, naming image adds as the supported path', async () => {
      const fetchImpl = mockFetch({
        id: 'notapalindrome/ltx23-mlx-av-q4',
        siblings: [{ rfilename: 'model.safetensors' }],
        tags: ['ltx-video'],
      });
      await expect(addModelFromHuggingface(
        { url: 'notapalindrome/ltx23-mlx-av-q4' },
        { fetchImpl },
      )).rejects.toThrow(/can't be added on Windows/);
      expect(addUserModelEntry).not.toHaveBeenCalled();
    });

    it('still allows a custom IMAGE model', async () => {
      const fetchImpl = mockFetch({
        id: 'someone/custom',
        siblings: [{ rfilename: 'model.safetensors' }],
        tags: [],
      });
      const result = await addModelFromHuggingface(
        { url: 'someone/custom', kind: 'image', runner: 'qwen' },
        { fetchImpl },
      );
      expect(result.kind).toBe('image');
      expect(addUserModelEntry).toHaveBeenCalled();
    });
  });
});
