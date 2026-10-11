import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/promptRunner.js', () => ({ runPromptThroughProvider: vi.fn() }));
vi.mock('../../services/untrustedContent.js', () => ({ runUntrustedContentAnalysis: vi.fn() }));
vi.mock('../../services/providers.js', () => ({
  getProviderById: vi.fn(),
}));

import { runPromptThroughProvider } from '../../services/promptRunner.js';
import { runUntrustedContentAnalysis } from '../../services/untrustedContent.js';
import { getProviderById } from '../../services/providers.js';
import { solveChallenge } from './challengeSolver.js';

const apiProvider = {
  id: 'api-1',
  type: 'api',
  enabled: true,
  endpoint: 'https://api.example.com/v1',
  defaultModel: 'example-text',
};
const cliProvider = { id: 'cli-1', type: 'cli', enabled: true, command: 'example-cli' };

beforeEach(() => {
  vi.clearAllMocks();
  getProviderById.mockResolvedValue(null);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('solveChallenge — numeric contract', () => {
  it('returns the screened two-decimal answer', async () => {
    runUntrustedContentAnalysis.mockResolvedValue({ ok: true, value: '47.00' });
    expect(await solveChallenge('garbled 40 + 7')).toBe('47.00');
  });

  it('returns null when screening rejects the challenge', async () => {
    runUntrustedContentAnalysis.mockResolvedValue({ ok: false, code: 'untrusted-content-rejected' });
    expect(await solveChallenge('secret challenge text')).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('untrusted-content-rejected'));
    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn.mock.calls.join(' ')).not.toContain('secret challenge text');
    expect(console.error.mock.calls.join(' ')).not.toContain('secret challenge text');
  });

  it('returns null when the screened value is not the numeric string', async () => {
    runUntrustedContentAnalysis.mockResolvedValue({ ok: true, value: { answer: '12.50' } });
    expect(await solveChallenge('x')).toBeNull();
  });
});

describe('solveChallenge — provider selection', () => {
  it('sends an unpinned challenge through the moltbook boundary without an active provider', async () => {
    runUntrustedContentAnalysis.mockResolvedValue({ ok: true, value: '8.00' });

    expect(await solveChallenge('obfuscated 3 + 5')).toBe('8.00');

    expect(runPromptThroughProvider).not.toHaveBeenCalled();
    expect(getProviderById).not.toHaveBeenCalled();
    const call = runUntrustedContentAnalysis.mock.calls[0][0];
    expect(call.provider).toBeUndefined();
    expect(call.source).toBe('moltbook');
    expect(call.content).toBe('obfuscated 3 + 5');
    expect(call.prompt).not.toContain('obfuscated 3 + 5');
    expect(call.responseSchema.safeParse('8.00').success).toBe(true);
    expect(call.responseSchema.safeParse('8').success).toBe(false);
    expect(call.responseSchema.safeParse('8.0').success).toBe(false);
  });

  it('passes a pinned text API provider through and never calls the tool runner', async () => {
    getProviderById.mockResolvedValue(apiProvider);
    runUntrustedContentAnalysis.mockResolvedValue({ ok: true, value: '5.00' });

    await solveChallenge('x', { providerId: 'api-1', model: 'custom-model' });

    expect(getProviderById).toHaveBeenCalledWith('api-1');
    expect(runPromptThroughProvider).not.toHaveBeenCalled();
    expect(runUntrustedContentAnalysis).toHaveBeenCalledWith(expect.objectContaining({
      provider: apiProvider,
      model: 'custom-model',
      source: 'moltbook',
    }));
  });

  it('returns null for a pinned CLI provider without calling either runner', async () => {
    getProviderById.mockResolvedValue(cliProvider);

    expect(await solveChallenge('challenge body', { providerId: 'cli-1' })).toBeNull();

    expect(runPromptThroughProvider).not.toHaveBeenCalled();
    expect(runUntrustedContentAnalysis).not.toHaveBeenCalled();
    expect(console.warn.mock.calls.join(' ')).not.toContain('challenge body');
  });

  it('fails closed when the pinned provider cannot be loaded', async () => {
    getProviderById.mockRejectedValue(new Error('boom'));

    expect(await solveChallenge('x', { providerId: 'missing' })).toBeNull();
    expect(runUntrustedContentAnalysis).not.toHaveBeenCalled();
    expect(runPromptThroughProvider).not.toHaveBeenCalled();
  });

  it('swallows an analysis error and returns null', async () => {
    runUntrustedContentAnalysis.mockRejectedValue(new Error('LLM down'));
    expect(await solveChallenge('x')).toBeNull();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('LLM down'));
  });
});
