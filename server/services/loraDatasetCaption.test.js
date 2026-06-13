import { describe, it, expect, vi } from 'vitest';

// resolveCaptionModel takes an injectable `listVision`, so the resolution
// branches are testable without touching the network/DB. The module still
// pulls in localLlm transitively at import; that's import-only (no calls fire
// until resolveCaptionModel runs with our stub), so no mocks are needed.
const { resolveCaptionModel } = await import('./loraDatasetCaption.js');

const VISION = [
  { providerId: 'lmstudio', backend: 'lmstudio', id: 'qwen2.5-vl-7b', name: 'Qwen2.5-VL 7B', vision: true },
  { providerId: 'ollama', backend: 'ollama', id: 'opaque-vlm-id', name: 'Opaque VLM', vision: true },
];

describe('resolveCaptionModel', () => {
  it('short-circuits an explicit regex-recognized vision model WITHOUT scanning', async () => {
    const listVision = vi.fn(async () => VISION);
    const out = await resolveCaptionModel({ providerId: 'ollama', model: 'llava:latest', listVision });
    expect(out).toEqual({ providerId: 'ollama', model: 'llava:latest' });
    expect(listVision).not.toHaveBeenCalled(); // heuristic-first fast path
  });

  it('accepts an explicit opaque id that the live scan confirms is vision-capable', async () => {
    const listVision = vi.fn(async () => VISION);
    const out = await resolveCaptionModel({ providerId: 'ollama', model: 'opaque-vlm-id', listVision });
    expect(out).toEqual({ providerId: 'ollama', model: 'opaque-vlm-id' });
    expect(listVision).toHaveBeenCalledOnce();
  });

  it('rejects an explicit non-vision model the scan does not know with a 409', async () => {
    const listVision = vi.fn(async () => VISION);
    await expect(resolveCaptionModel({ model: 'llama3.1:8b', listVision }))
      .rejects.toMatchObject({ status: 409, code: 'LORA_CAPTION_NOT_VISION' });
  });

  it('reads the explicit model/provider from settings when not passed directly', async () => {
    const listVision = vi.fn(async () => VISION);
    const settings = { loraTraining: { captionProviderId: 'lmstudio', captionModel: 'qwen2.5-vl-7b' } };
    const out = await resolveCaptionModel({ settings, listVision });
    expect(out).toEqual({ providerId: 'lmstudio', model: 'qwen2.5-vl-7b' });
  });

  it('auto-picks the first vision model when nothing is configured', async () => {
    const listVision = vi.fn(async () => VISION);
    const out = await resolveCaptionModel({ listVision });
    expect(out).toEqual({ providerId: 'lmstudio', model: 'qwen2.5-vl-7b' });
  });

  it('auto-pick prefers a model from the chosen provider over the list head', async () => {
    const listVision = vi.fn(async () => VISION);
    const out = await resolveCaptionModel({ providerId: 'ollama', listVision });
    expect(out).toEqual({ providerId: 'ollama', model: 'opaque-vlm-id' });
  });

  it('throws a 409 when no vision model is installed', async () => {
    const listVision = vi.fn(async () => []);
    await expect(resolveCaptionModel({ listVision }))
      .rejects.toMatchObject({ status: 409, code: 'LORA_CAPTION_NO_VISION_MODEL' });
  });

  it('treats a failed vision scan as no models installed (409, not a crash)', async () => {
    const listVision = vi.fn(async () => { throw new Error('backend down'); });
    await expect(resolveCaptionModel({ listVision }))
      .rejects.toMatchObject({ status: 409, code: 'LORA_CAPTION_NO_VISION_MODEL' });
  });
});
