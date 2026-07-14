import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isBrowserLlmApiPresent, nanoAvailability, isNanoReady, promptNano,
  destroyNanoSession, warmNano, NANO_AVAILABILITY,
} from './browserLlm';

// jsdom exposes `self` (=== window). We stub the Prompt API on it per test.
const clearApi = () => {
  delete self.LanguageModel;
  if (self.ai) delete self.ai;
};

beforeEach(() => { destroyNanoSession(); clearApi(); });
afterEach(() => { destroyNanoSession(); clearApi(); vi.restoreAllMocks(); });

describe('detection', () => {
  it('reports no-api when neither shape is present', async () => {
    expect(isBrowserLlmApiPresent()).toBe(false);
    expect(await nanoAvailability()).toBe(NANO_AVAILABILITY.NO_API);
    expect(await isNanoReady()).toBe(false);
  });

  it('detects the modern global LanguageModel', async () => {
    self.LanguageModel = { availability: vi.fn().mockResolvedValue('available') };
    expect(isBrowserLlmApiPresent()).toBe(true);
    expect(await nanoAvailability()).toBe('available');
    expect(await isNanoReady()).toBe(true);
  });

  it('falls back to the bare availability() call on older builds', async () => {
    const availability = vi.fn()
      .mockRejectedValueOnce(new Error('opts not supported'))
      .mockResolvedValueOnce('downloadable');
    self.LanguageModel = { availability };
    expect(await nanoAvailability()).toBe('downloadable');
    expect(availability).toHaveBeenCalledTimes(2);
  });

  it('maps the legacy capabilities() shape onto the enum', async () => {
    self.ai = { languageModel: { capabilities: vi.fn().mockResolvedValue({ available: 'readily' }) } };
    expect(await nanoAvailability()).toBe('available');
  });

  it('returns unavailable when the availability probe throws', async () => {
    self.LanguageModel = { availability: vi.fn().mockRejectedValue(new Error('boom')) };
    expect(await nanoAvailability()).toBe(NANO_AVAILABILITY.UNAVAILABLE);
  });
});

describe('promptNano', () => {
  it('creates a session (global shape) and returns the reply', async () => {
    const prompt = vi.fn().mockResolvedValue('hello there');
    const create = vi.fn().mockResolvedValue({ prompt, destroy: vi.fn() });
    self.LanguageModel = { availability: vi.fn().mockResolvedValue('available'), create };
    const out = await promptNano('hi', { systemPrompt: 'be nice', temperature: 0.5, topK: 2 });
    expect(out).toBe('hello there');
    expect(create).toHaveBeenCalledOnce();
    // System prompt is passed as an initial system message on the global API.
    expect(create.mock.calls[0][0].initialPrompts[0]).toMatchObject({ role: 'system', content: 'be nice' });
    // Reuses the warm session on a second call with the same params.
    await promptNano('again', { systemPrompt: 'be nice', temperature: 0.5, topK: 2 });
    expect(create).toHaveBeenCalledOnce();
  });

  it('retries bare when the per-request options arg is rejected', async () => {
    const prompt = vi.fn()
      .mockImplementationOnce((_t, opts) => (opts ? Promise.reject(new Error('no opts')) : Promise.resolve('x')))
      .mockResolvedValue('bare-ok');
    self.LanguageModel = { availability: vi.fn().mockResolvedValue('available'), create: vi.fn().mockResolvedValue({ prompt }) };
    const out = await promptNano('hi');
    expect(out).toBe('bare-ok');
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('rejects on timeout when the model stalls', async () => {
    const prompt = vi.fn().mockImplementation(() => new Promise(() => {})); // never resolves
    self.LanguageModel = { availability: vi.fn().mockResolvedValue('available'), create: vi.fn().mockResolvedValue({ prompt }) };
    await expect(promptNano('hi', { timeoutMs: 20 })).rejects.toThrow(/timeout/i);
  });

  it('tears down the (single-in-flight) session after a timeout so the next turn rebuilds', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ prompt: vi.fn().mockImplementation(() => new Promise(() => {})), destroy: vi.fn() }) // stalls → timeout
      .mockResolvedValueOnce({ prompt: vi.fn().mockResolvedValue('ok'), destroy: vi.fn() });
    self.LanguageModel = { availability: vi.fn().mockResolvedValue('available'), create };
    await expect(promptNano('hi', { timeoutMs: 20 })).rejects.toThrow(/timeout/i);
    // A wedged session would make this reject too; instead it builds a fresh one.
    await expect(promptNano('again', { timeoutMs: 500 })).resolves.toBe('ok');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('uses the legacy top-level systemPrompt shape', async () => {
    const create = vi.fn().mockResolvedValue({ prompt: vi.fn().mockResolvedValue('ok') });
    self.ai = { languageModel: { capabilities: vi.fn().mockResolvedValue({ available: 'readily' }), create } };
    await promptNano('hi', { systemPrompt: 'persona' });
    expect(create.mock.calls[0][0]).toMatchObject({ systemPrompt: 'persona' });
  });
});

describe('warmNano', () => {
  it('no-ops (false) unless the model is fully available', async () => {
    self.LanguageModel = { availability: vi.fn().mockResolvedValue('downloadable'), create: vi.fn() };
    expect(await warmNano()).toBe(false);
  });

  it('builds a session when available', async () => {
    self.LanguageModel = { availability: vi.fn().mockResolvedValue('available'), create: vi.fn().mockResolvedValue({ prompt: vi.fn(), destroy: vi.fn() }) };
    expect(await warmNano({ systemPrompt: 'x' })).toBe(true);
  });
});
