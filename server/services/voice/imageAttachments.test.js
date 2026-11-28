import { describe, it, expect } from 'vitest';
import { framesMatch, parseImageAttachment, attachImage, removeImage, takePendingImages, resolveVoiceVisionTarget, MAX_PENDING_IMAGES } from './imageAttachments.js';

const sig = (v) => Array(256).fill(v);
const DATA = 'data:image/png;base64,AAAA';

describe('framesMatch', () => {
  it('treats small changes as the same screen and missing signatures as different', () => {
    expect(framesMatch(sig(100), sig(102))).toBe(true);
    expect(framesMatch(sig(100), sig(140))).toBe(false);
    expect(framesMatch(null, sig(100))).toBe(false);
    expect(framesMatch([1, 2, 3], [1, 2, 3])).toBe(false);
  });
});

describe('parseImageAttachment', () => {
  it('accepts a base64 image and names it by source', () => {
    expect(parseImageAttachment({ id: 'img_1', dataUrl: DATA, source: 'tab' }, { maxBytes: 100 }))
      .toEqual({ id: 'img_1', dataUrl: DATA, source: 'tab', name: 'Shared tab' });
  });

  it('refuses bad ids, sources, non-images and oversized payloads', () => {
    expect(parseImageAttachment({ id: 'bad id', dataUrl: DATA, source: 'upload' }, { maxBytes: 100 }).error).toBeTruthy();
    expect(parseImageAttachment({ id: 'a', dataUrl: DATA, source: 'disk' }, { maxBytes: 100 }).error).toBeTruthy();
    expect(parseImageAttachment({ id: 'a', dataUrl: 'data:text/html;base64,AA', source: 'upload' }, { maxBytes: 100 }).error).toBeTruthy();
    expect(parseImageAttachment({ id: 'a', dataUrl: DATA, source: 'upload' }, { maxBytes: 5 }).error).toMatch(/too large/);
  });
});

describe('the pending image queue', () => {
  const describeOk = async () => ({ text: 'desc', model: 'm' });

  it('drops the oldest image past the cap and removes on request', async () => {
    const state = {};
    const events = [];
    const emit = (_e, d) => events.push(d);
    for (let i = 0; i <= MAX_PENDING_IMAGES; i++) attachImage(state, { id: `i${i}`, dataUrl: DATA, source: 'upload', name: 'n' }, { describe: describeOk, emit });
    expect(events.find((e) => e.status === 'dropped')).toMatchObject({ id: 'i0' });
    removeImage(state, 'i1', emit);
    const blocks = await takePendingImages(state, { emit });
    expect(blocks).toHaveLength(MAX_PENDING_IMAGES - 1);
    expect(state.images.pending).toEqual([]);
  });

  it('returns nothing and keeps the queue when the turn is aborted while waiting', async () => {
    const state = {};
    const ctrl = new AbortController();
    attachImage(state, { id: 'slow', dataUrl: DATA, source: 'upload', name: 'n' }, { describe: () => new Promise(() => {}), emit: () => {} });
    const taking = takePendingImages(state, { emit: () => {}, signal: ctrl.signal });
    ctrl.abort();
    expect(await taking).toEqual([]);
    expect(state.images.pending).toHaveLength(1);
  });
});

describe('resolveVoiceVisionTarget', () => {
  const list = async () => [
    { providerId: 'lmstudio', backend: 'lmstudio', id: 'lm-vision' },
    { providerId: 'codex', backend: 'cli', id: 'gpt' },
  ];

  it('prefers an explicit vision model', async () => {
    expect(await resolveVoiceVisionTarget({ llm: { provider: 'ollama', model: 'x', visionModel: 'pinned' } }, { listVisionModels: list }))
      .toEqual({ providerId: 'ollama', model: 'pinned' });
  });

  it('falls back to another local backend but never to a CLI provider', async () => {
    expect(await resolveVoiceVisionTarget({ llm: { provider: 'ollama', model: 'text-only' } }, { listVisionModels: list }))
      .toEqual({ providerId: 'lmstudio', model: 'lm-vision' });
    expect(await resolveVoiceVisionTarget({ llm: { provider: 'ollama', model: 'text-only' } }, { listVisionModels: async () => [{ providerId: 'codex', backend: 'cli', id: 'gpt' }] }))
      .toEqual({ providerId: 'ollama', model: undefined });
  });
});
