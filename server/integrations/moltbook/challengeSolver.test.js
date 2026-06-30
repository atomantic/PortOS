import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/promptRunner.js', () => ({ runPromptThroughProvider: vi.fn() }));
vi.mock('../../services/providers.js', () => ({
  getActiveProvider: vi.fn(),
  getProviderById: vi.fn(),
}));

import { runPromptThroughProvider } from '../../lib/promptRunner.js';
import { getActiveProvider, getProviderById } from '../../services/providers.js';
import { solveChallenge } from './challengeSolver.js';

const provider = { id: 'p1', defaultModel: 'm', models: ['m'] };

beforeEach(() => {
  vi.clearAllMocks();
  getActiveProvider.mockResolvedValue(provider);
  getProviderById.mockResolvedValue(null);
});

describe('solveChallenge — number extraction + formatting', () => {
  it('returns a clean 2-decimal answer for a well-formed numeric reply', async () => {
    runPromptThroughProvider.mockResolvedValue({ text: '47.00' });
    expect(await solveChallenge('garbled 40 + 7')).toBe('47.00');
  });

  it('extracts the first number embedded in surrounding prose', async () => {
    runPromptThroughProvider.mockResolvedValue({ text: 'The answer is 12.5 exactly.' });
    expect(await solveChallenge('x')).toBe('12.50');
  });

  it('formats a bare integer reply to two decimals', async () => {
    runPromptThroughProvider.mockResolvedValue({ text: '100' });
    expect(await solveChallenge('x')).toBe('100.00');
  });

  it('trims leading whitespace before matching', async () => {
    runPromptThroughProvider.mockResolvedValue({ text: '   8.0' });
    expect(await solveChallenge('x')).toBe('8.00');
  });

  it('returns null when the AI reply contains no number', async () => {
    runPromptThroughProvider.mockResolvedValue({ text: 'I cannot solve this.' });
    expect(await solveChallenge('x')).toBeNull();
  });

  it('returns null when the AI reply text is missing', async () => {
    runPromptThroughProvider.mockResolvedValue({ text: undefined });
    expect(await solveChallenge('x')).toBeNull();
  });
});

describe('solveChallenge — provider selection and failure handling', () => {
  it('returns null and never calls the runner when no provider is available', async () => {
    getActiveProvider.mockResolvedValue(null);
    expect(await solveChallenge('x')).toBeNull();
    expect(runPromptThroughProvider).not.toHaveBeenCalled();
  });

  it('prefers an explicit providerId over the active provider', async () => {
    const explicit = { id: 'explicit', defaultModel: 'em' };
    getProviderById.mockResolvedValue(explicit);
    runPromptThroughProvider.mockResolvedValue({ text: '5.00' });

    await solveChallenge('x', { providerId: 'explicit' });

    expect(getProviderById).toHaveBeenCalledWith('explicit');
    expect(getActiveProvider).not.toHaveBeenCalled();
    expect(runPromptThroughProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: explicit, model: 'em' }),
    );
  });

  it('falls back to the active provider when getProviderById rejects', async () => {
    getProviderById.mockRejectedValue(new Error('boom'));
    runPromptThroughProvider.mockResolvedValue({ text: '3.00' });

    expect(await solveChallenge('x', { providerId: 'missing' })).toBe('3.00');
    expect(getActiveProvider).toHaveBeenCalled();
  });

  it('swallows a runner error and returns null', async () => {
    runPromptThroughProvider.mockRejectedValue(new Error('LLM down'));
    expect(await solveChallenge('x')).toBeNull();
  });

  it('uses an explicit model override when provided', async () => {
    runPromptThroughProvider.mockResolvedValue({ text: '1.00' });
    await solveChallenge('x', { model: 'custom-model' });
    expect(runPromptThroughProvider).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'custom-model' }),
    );
  });
});
