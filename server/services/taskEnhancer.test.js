import { beforeEach, describe, expect, it, vi } from 'vitest';

const deps = vi.hoisted(() => ({
  getActiveProvider: vi.fn(), getProviderById: vi.fn(), getStage: vi.fn(), buildPrompt: vi.fn(), run: vi.fn(),
}));
vi.mock('./provider/providers.js', () => ({ getActiveProvider: deps.getActiveProvider, getProviderById: deps.getProviderById }));
vi.mock('./promptService.js', () => ({ getStage: deps.getStage, buildPrompt: deps.buildPrompt }));
vi.mock('./promptRunner.js', async (importOriginal) => ({ ...(await importOriginal()), runPromptThroughProvider: deps.run }));

import { enhanceTaskPrompt } from './taskEnhancer.js';

const ACTIVE = { id: 'active', name: 'Active', defaultModel: 'active-default' };
const STAGED = { id: 'staged', name: 'Staged', defaultModel: 'staged-default', heavyModel: 'staged-heavy' };
const sent = () => deps.run.mock.calls[0][0];

describe('enhanceTaskPrompt', () => {
  beforeEach(() => {
    deps.getActiveProvider.mockResolvedValue(ACTIVE);
    deps.getProviderById.mockImplementation(async id => (id === 'staged' ? STAGED : null));
    deps.getStage.mockReturnValue({ provider: 'staged', model: 'heavy' });
    deps.buildPrompt.mockResolvedValue('stage prompt');
    deps.run.mockResolvedValue({ text: 'Enhanced text', model: null });
  });

  it('runs the stage provider with its tier resolved to a model id', async () => {
    const result = await enhanceTaskPrompt('Fix it');

    expect(sent()).toMatchObject({ provider: STAGED, model: 'staged-heavy', prompt: 'stage prompt' });
    expect(result).toEqual({ enhancedDescription: 'Enhanced text', originalDescription: 'Fix it', model: 'staged-heavy', provider: 'staged' });
  });

  it('falls back to the active provider when the pinned stage provider is gone', async () => {
    deps.getStage.mockReturnValue({ provider: 'removed', model: 'default' });

    const result = await enhanceTaskPrompt('Fix it');

    expect(sent()).toMatchObject({ provider: ACTIVE, model: 'active-default' });
    expect(result.provider).toBe('active');
  });

  it('sends the description and context verbatim through the built-in template', async () => {
    deps.buildPrompt.mockRejectedValue(new Error('no template'));

    await enhanceTaskPrompt("Match $& and $' and {contextSection} for $$5", 'Costs $$10 in {description}');

    expect(sent().prompt).toContain("## Original Task Description\nMatch $& and $' and {contextSection} for $$5\n");
    expect(sent().prompt).toContain('## Additional Context\nCosts $$10 in {description}\n');
  });

  it('strips a conversational preamble and keeps the original when nothing is left', async () => {
    deps.run.mockResolvedValueOnce({ text: "Certainly! Here's the enhanced version:\nDo the work", model: 'm' })
      .mockResolvedValueOnce({ text: ' Sure! ', model: 'm' });

    expect((await enhanceTaskPrompt('Fix it')).enhancedDescription).toBe("Here's the enhanced version:\nDo the work");
    expect(await enhanceTaskPrompt('Fix it')).toMatchObject({ enhancedDescription: 'Fix it', fallback: true });
  });

  it('refuses when no provider is available', async () => {
    deps.getStage.mockReturnValue(null);
    deps.getActiveProvider.mockResolvedValue(null);

    await expect(enhanceTaskPrompt('Fix it')).rejects.toThrow('No AI provider available');
    expect(deps.run).not.toHaveBeenCalled();
  });
});
