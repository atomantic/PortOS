import { describe, it, expect, vi } from 'vitest';

// resolveCaptionModel takes an injectable `listVision`, so the resolution
// branches are testable without touching the network/DB. The module still
// pulls in localLlm transitively at import; that's import-only (no calls fire
// until resolveCaptionModel runs with our stub), so no mocks are needed.
const { resolveCaptionModel, buildCaption, withCaptionVisionLock } = await import('./loraDatasetCaption.js');

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

  it('accepts a CLI provider/model the scan reports (codex / claude vision)', async () => {
    // CLI model ids (e.g. claude-opus-4-8) aren't matched by the VLM id regex,
    // so the resolver scans — and listVisionModels now surfaces vision-capable
    // CLI providers, so the explicit pick is confirmed rather than rejected.
    const listVision = vi.fn(async () => [
      ...VISION,
      { providerId: 'claude-code', backend: 'cli', id: 'claude-opus-4-8', name: 'Claude Code / claude-opus-4-8', vision: true },
    ]);
    const out = await resolveCaptionModel({ providerId: 'claude-code', model: 'claude-opus-4-8', listVision });
    expect(out).toEqual({ providerId: 'claude-code', model: 'claude-opus-4-8' });
    expect(listVision).toHaveBeenCalledOnce();
  });

  it('auto-picks a CLI vision provider when it is the only one available', async () => {
    const listVision = vi.fn(async () => [
      { providerId: 'codex', backend: 'cli', id: 'gpt-5', name: 'Codex / gpt-5', vision: true },
    ]);
    const out = await resolveCaptionModel({ listVision });
    expect(out).toEqual({ providerId: 'codex', model: 'gpt-5' });
  });
});

describe('buildCaption', () => {
  it('prefixes a real description with the trigger word', () => {
    expect(buildCaption('tamsin_reed', 'close-up bust, neutral expression'))
      .toBe('tamsin_reed, close-up bust, neutral expression');
  });

  it('throws on an empty reply instead of returning a trigger-word-only caption', () => {
    // The regression: a blank vision reply must NOT degrade to just the trigger
    // word (which the loop would persist as a bogus "success"). It must fail so
    // the image is surfaced and re-attemptable.
    expect(() => buildCaption('tamsin_reed', '')).toThrow(/empty description/);
    expect(() => buildCaption('tamsin_reed', '   \n  ')).toThrow(/empty description/);
    expect(() => buildCaption('tamsin_reed', null)).toThrow(/empty description/);
  });

  it('names the model in the error so the user knows which to swap', () => {
    expect(() => buildCaption('tamsin_reed', '', 'vision model "llava:7b"'))
      .toThrow(/llava:7b/);
  });

  it('blames a reasoning model (not a refusal) when it burned the budget thinking', () => {
    // Qwen3/thinking-Gemma symptom: hidden reasoning + finish_reason 'length'.
    // The message must point at picking a real VLM, not "it refused".
    const meta = { finishReason: 'length', usage: { completion_tokens: 600 }, reasoning: 'Let me analyze…' };
    expect(() => buildCaption('tamsin_reed', '', 'vision model "qwen3:35b"', meta))
      .toThrow(/hidden reasoning.*600 completion tokens.*reasoning model.*VLM/s);
  });

  it('calls out plain truncation when cut off with no reasoning trace', () => {
    const meta = { finishReason: 'length', usage: { completion_tokens: 600 }, reasoning: '' };
    expect(() => buildCaption('tamsin_reed', '', 'vision model "llava:7b"', meta))
      .toThrow(/cut off at the token budget.*raise the caption token budget/s);
  });

  it('falls back to the refusal wording when there is no diagnostic signal', () => {
    expect(() => buildCaption('tamsin_reed', '', 'vision model "llava:7b"', { finishReason: 'stop' }))
      .toThrow(/may have refused this image/);
    // and with no meta at all (back-compat 3-arg callers)
    expect(() => buildCaption('tamsin_reed', '')).toThrow(/may have refused this image/);
  });
});

describe('withCaptionVisionLock', () => {
  it('serializes overlapping vision calls so concurrent runs never overlap at the backend', async () => {
    // Two caption runs firing at once must NOT produce two in-flight vision
    // requests — on a single-GPU Ollama that doubles KV-cache VRAM. The lock
    // forces concurrency 1: while one "vision call" is mid-await, a second
    // call kicked off in parallel must wait for it to finish.
    let inFlight = 0;
    let maxInFlight = 0;
    const visionCall = () => withCaptionVisionLock(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5)); // simulate a backend round-trip
      inFlight -= 1;
    });

    await Promise.all([visionCall(), visionCall(), visionCall()]);

    expect(maxInFlight).toBe(1);
  });

  it('runs calls in submission order (FIFO)', async () => {
    const order = [];
    await Promise.all([1, 2, 3].map((n) => withCaptionVisionLock(async () => {
      await new Promise((r) => setTimeout(r, 1));
      order.push(n);
    })));
    expect(order).toEqual([1, 2, 3]);
  });
});
