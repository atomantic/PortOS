import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./providers.js', () => ({
  getProviderById: vi.fn(),
}));

vi.mock('./runner.js', () => ({
  createRun: vi.fn().mockResolvedValue({ runId: 'test-run' }),
  executeApiRun: vi.fn(),
  executeCliRun: vi.fn(),
}));

const providers = await import('./providers.js');
const runner = await import('./runner.js');
const { buildMediaPromptRefinePrompt, refineMediaPrompt } = await import('./mediaPromptRefiner.js');

beforeEach(() => {
  vi.clearAllMocks();
  runner.createRun.mockResolvedValue({ runId: 'test-run' });
});

// executeCliRun and executeApiRun have different signatures — onData/onComplete
// sit at different positions. Find the two trailing function args dynamically.
function mockRunnerSuccess(target, payload) {
  target.mockImplementation((...args) => {
    const fns = args.filter((a) => typeof a === 'function');
    const [onData, onComplete] = fns;
    onData(payload);
    onComplete({ success: true });
    return Promise.resolve();
  });
}

describe('mediaPromptRefiner', () => {
  it('builds a prompt with the original prompt config and user feedback', () => {
    const prompt = buildMediaPromptRefinePrompt({
      kind: 'image',
      prompt: 'a painted wizard',
      negativePrompt: 'blurry',
      feedback: 'less painted',
      renderConfig: { width: 1024, height: 1024 },
    });

    expect(prompt).toContain('a painted wizard');
    expect(prompt).toContain('blurry');
    expect(prompt).toContain('less painted');
    expect(prompt).toContain('"width": 1024');
  });

  it('returns sanitized prompt refinement JSON from an API provider', async () => {
    providers.getProviderById.mockResolvedValue({
      id: 'openai',
      name: 'OpenAI',
      type: 'api',
      enabled: true,
      defaultModel: 'gpt-test',
    });
    mockRunnerSuccess(runner.executeApiRun, JSON.stringify({
      prompt: 'modern animated series still',
      negativePrompt: 'painterly, ornate',
      rationale: 'Adjusted toward clean animated styling.',
      changes: ['Reduced painterly detail', 'Added clean animation direction'],
    }));

    const result = await refineMediaPrompt({
      kind: 'image',
      prompt: 'ornate painted scene',
      negativePrompt: '',
      feedback: 'more modern animated series',
      providerId: 'openai',
    });

    expect(runner.executeApiRun).toHaveBeenCalled();
    expect(runner.executeCliRun).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      prompt: 'modern animated series still',
      negativePrompt: 'painterly, ornate',
      providerId: 'openai',
      model: 'gpt-test',
    }));
  });

  it('runs refinement through CLI providers without requiring a model', async () => {
    providers.getProviderById.mockResolvedValue({
      id: 'codex',
      name: 'Codex',
      type: 'cli',
      enabled: true,
    });
    mockRunnerSuccess(runner.executeCliRun, JSON.stringify({
      prompt: 'cleaner fox portrait',
      negativePrompt: '',
      rationale: '',
      changes: [],
    }));

    const result = await refineMediaPrompt({
      kind: 'image',
      prompt: 'a fox',
      feedback: 'cleaner',
      providerId: 'codex',
    });

    expect(runner.executeCliRun).toHaveBeenCalled();
    expect(runner.executeApiRun).not.toHaveBeenCalled();
    expect(result.providerId).toBe('codex');
    expect(result.prompt).toBe('cleaner fox portrait');
  });

  it('skips Codex bracketed metadata (e.g. [workdir, /…]) and finds the JSON object', async () => {
    providers.getProviderById.mockResolvedValue({
      id: 'codex', type: 'cli', enabled: true,
    });
    const codexOutput = `OpenAI Codex CLI v2.1.0
[workdir, /Users/antic/github.com/atomantic/PortOS]
[model, gpt-5]
[session, abc-123]

${JSON.stringify({ prompt: 'painted owl portrait', negativePrompt: 'blurry', rationale: 'r', changes: ['c1'] })}

[finished]
`;
    mockRunnerSuccess(runner.executeCliRun, codexOutput);

    const result = await refineMediaPrompt({
      kind: 'image',
      prompt: 'an owl',
      feedback: 'painted style',
      providerId: 'codex',
    });

    expect(result.prompt).toBe('painted owl portrait');
    expect(result.negativePrompt).toBe('blurry');
  });

  it('lifts JSON out of CLI banner noise (codex)', async () => {
    providers.getProviderById.mockResolvedValue({
      id: 'codex', type: 'cli', enabled: true,
    });
    mockRunnerSuccess(runner.executeCliRun, `OpenAI Codex CLI v2.1.0\nsession: abc-123\n${JSON.stringify({ prompt: 'sunny fox portrait', negativePrompt: '', rationale: '', changes: [] })}\n--- done ---\n`);

    const result = await refineMediaPrompt({
      kind: 'image',
      prompt: 'a fox',
      feedback: 'sunnier',
      providerId: 'codex',
    });

    expect(result.prompt).toBe('sunny fox portrait');
  });

  it('requires a model for API providers', async () => {
    providers.getProviderById.mockResolvedValue({
      id: 'openai', type: 'api', enabled: true,
    });
    await expect(refineMediaPrompt({
      kind: 'image',
      prompt: 'x',
      feedback: 'y',
      providerId: 'openai',
    })).rejects.toMatchObject({ code: 'MODEL_REQUIRED', status: 400 });
  });

  it('rejects disabled providers', async () => {
    providers.getProviderById.mockResolvedValue({
      id: 'openai', type: 'api', enabled: false, defaultModel: 'gpt-test',
    });
    await expect(refineMediaPrompt({
      kind: 'image',
      prompt: 'x',
      feedback: 'y',
      providerId: 'openai',
    })).rejects.toMatchObject({ code: 'PROVIDER_DISABLED', status: 400 });
  });

  it('ignores per-call model override for non-Codex CLIs since the runner cannot apply it', async () => {
    // runner.js#buildCliArgs only translates defaultModel into a --model flag
    // for codex. For claude-code / gemini-cli the per-call override would be
    // silently dropped, so the response model must reflect what'll actually
    // run (the provider's configured default), not the user's selection.
    providers.getProviderById.mockResolvedValue({
      id: 'claude-code',
      type: 'cli',
      enabled: true,
      defaultModel: 'claude-baked-in',
    });
    mockRunnerSuccess(runner.executeCliRun, JSON.stringify({
      prompt: 'x', negativePrompt: '', rationale: '', changes: [],
    }));

    const result = await refineMediaPrompt({
      kind: 'image',
      prompt: 'p',
      feedback: 'f',
      providerId: 'claude-code',
      model: 'user-selected-model-the-runner-will-ignore',
    });

    expect(result.model).toBe('claude-baked-in');
  });

  it('falls back to provider.models[0] when defaultModel is absent (API provider)', async () => {
    providers.getProviderById.mockResolvedValue({
      id: 'openai', type: 'api', enabled: true, models: ['gpt-from-list'],
    });
    mockRunnerSuccess(runner.executeApiRun, JSON.stringify({
      prompt: 'x', negativePrompt: '', rationale: '', changes: [],
    }));

    const result = await refineMediaPrompt({
      kind: 'image',
      prompt: 'p',
      feedback: 'f',
      providerId: 'openai',
    });

    expect(result.model).toBe('gpt-from-list');
  });

  it('throws when the provider is unknown', async () => {
    providers.getProviderById.mockResolvedValue(null);
    await expect(refineMediaPrompt({
      kind: 'image',
      prompt: 'x',
      feedback: 'y',
      providerId: 'missing',
    })).rejects.toMatchObject({ code: 'PROVIDER_NOT_FOUND', status: 404 });
  });

  it('skips the echoed schema example and returns the real refinement', async () => {
    providers.getProviderById.mockResolvedValue({
      id: 'codex', type: 'cli', enabled: true,
    });
    // Codex echoes the prompt to stdout (which contains the schema example
    // {"prompt": "<full rewritten positive prompt>"}) then emits the real result.
    const echoedSchema = JSON.stringify({
      prompt: '<the full rewritten positive prompt, ready to send to the renderer>',
      negativePrompt: '<the full rewritten negative prompt, or an empty string if none>',
      rationale: '<one concise sentence explaining the edit>',
      changes: ['<short bullet of what changed>'],
    });
    const realResult = JSON.stringify({
      prompt: 'a calm watercolor portrait of a fox, soft morning light',
      negativePrompt: 'harsh shadows, oversaturation',
      rationale: 'Shifted from oil-painted toward watercolor.',
      changes: ['Changed medium to watercolor', 'Softened lighting'],
    });
    mockRunnerSuccess(runner.executeCliRun, `Codex CLI banner\n${echoedSchema}\n\n${realResult}\n`);

    const result = await refineMediaPrompt({
      kind: 'image',
      prompt: 'a fox in oil',
      feedback: 'watercolor instead',
      providerId: 'codex',
    });

    expect(result.prompt).toBe('a calm watercolor portrait of a fox, soft morning light');
  });

  it('reports a helpful error when the model only returns the schema placeholder', async () => {
    providers.getProviderById.mockResolvedValue({
      id: 'codex', type: 'cli', enabled: true,
    });
    const onlyPlaceholder = JSON.stringify({
      prompt: '<the full rewritten positive prompt, ready to send to the renderer>',
      negativePrompt: '<the full rewritten negative prompt, or an empty string if none>',
      rationale: 'r',
      changes: ['c'],
    });
    mockRunnerSuccess(runner.executeCliRun, onlyPlaceholder);

    await expect(refineMediaPrompt({
      kind: 'image',
      prompt: 'a fox',
      feedback: 'better',
      providerId: 'codex',
    })).rejects.toMatchObject({
      code: 'PROMPT_REFINE_BAD_JSON',
      message: expect.stringContaining('schema placeholder'),
    });
  });

  it('throws PROMPT_REFINE_FAILED when the runner reports an error', async () => {
    providers.getProviderById.mockResolvedValue({
      id: 'openai', type: 'api', enabled: true, defaultModel: 'gpt-test',
    });
    runner.executeApiRun.mockImplementation((runId, provider, model, prompt, cwd, ctx, onData, onComplete) => {
      onComplete({ error: 'upstream down' });
      return Promise.resolve();
    });

    await expect(refineMediaPrompt({
      kind: 'image',
      prompt: 'x',
      feedback: 'y',
      providerId: 'openai',
    })).rejects.toMatchObject({ code: 'PROMPT_REFINE_FAILED', status: 502 });
  });
});
