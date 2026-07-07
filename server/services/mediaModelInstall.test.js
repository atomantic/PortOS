import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/hfToken.js', () => ({ getHfToken: vi.fn(async () => '') }));
vi.mock('../lib/mediaModels.js', () => ({ addUserModelEntry: vi.fn((entry) => entry) }));

const { addModelFromHuggingface } = await import('./mediaModelInstall.js');
const { addUserModelEntry } = await import('../lib/mediaModels.js');

// Minimal fetch mock returning an HF `/api/models/{repo}` body.
const mockFetch = (body) => vi.fn(async () => ({
  ok: true,
  text: async () => JSON.stringify(body),
}));

beforeEach(() => { vi.clearAllMocks(); });

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

  it('honors explicit kind + runner overrides', async () => {
    const fetchImpl = mockFetch({
      id: 'someone/custom',
      siblings: [{ rfilename: 'model.safetensors' }],
    });
    const result = await addModelFromHuggingface(
      { url: 'someone/custom', kind: 'image', runner: 'mflux' },
      { fetchImpl },
    );
    expect(result.entry).toMatchObject({ runner: 'mflux', source: 'user' });
  });
});
