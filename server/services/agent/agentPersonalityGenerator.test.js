import { beforeEach, describe, expect, it, vi } from 'vitest';

const run = vi.hoisted(() => vi.fn());
vi.mock('../promptRunner.js', () => ({
  assertProvider: () => {},
  resolveProviderAndModel: async () => ({ provider: { id: 'p', name: 'Example', defaultModel: 'example-default' } }),
  runPromptThroughProvider: run,
}));

import { generateAgentPersonality } from './agentPersonalityGenerator.js';

const generated = {
  name: 'Generated Name', description: 'd', personality: { style: 'witty', tone: 'dry' },
};

describe('generateAgentPersonality', () => {
  beforeEach(() => {
    run.mockResolvedValue({ text: JSON.stringify(generated), model: null });
  });

  it('keeps the requested name, fills optional fields and records the model that ran', async () => {
    const result = await generateAgentPersonality({ name: '  Kept Name ' });

    expect(result).toMatchObject({
      name: 'Kept Name',
      personality: { style: 'witty', tone: 'dry', topics: [], quirks: [], promptPrefix: '' },
      avatar: { emoji: expect.any(String), color: '#3b82f6' },
      _meta: { generatedBy: 'Example', model: 'example-default' },
    });
  });

  it("sends the user's seed text verbatim", async () => {
    await generateAgentPersonality({ name: 'Seed', description: "Earns $$5, quotes $& and $'" });

    expect(run.mock.calls[0][0].prompt).toContain("Description: Earns $$5, quotes $& and $'\n");
  });

  it('reads the answer, not the schema example, when a CLI echoes the prompt', async () => {
    run.mockImplementation(async ({ prompt }) => ({ text: `${prompt}\n${JSON.stringify(generated)}` }));
    expect((await generateAgentPersonality({})).name).toBe('Generated Name');

    // A re-wrapped echo no longer matches the prompt byte for byte.
    run.mockImplementation(async ({ prompt }) => ({ text: `> ${prompt.slice(40)}\n${JSON.stringify(generated)}` }));
    expect((await generateAgentPersonality({})).name).toBe('Generated Name');

    run.mockImplementation(async ({ prompt }) => ({ text: prompt.slice(40) }));
    await expect(generateAgentPersonality({})).rejects.toThrow(/Failed to parse/);
  });

  it.each([
    ['an empty answer', '   ', /empty response/],
    ['prose', 'I cannot do that', /Failed to parse/],
    ['a personality without a tone', '{"personality":{"style":"witty"}}', /missing required fields/],
  ])('refuses %s', async (_label, text, message) => {
    run.mockResolvedValue({ text });
    await expect(generateAgentPersonality({})).rejects.toThrow(message);
  });
});
