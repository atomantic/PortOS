import { beforeEach, describe, expect, it, vi } from 'vitest';

const listModels = vi.fn();
const getModelCapabilities = vi.fn();
const getHfToken = vi.fn();

vi.mock('./localLlm.js', () => ({ listModels }));
vi.mock('./ollamaManager.js', () => ({ getModelCapabilities }));
vi.mock('./hfToken.js', () => ({ getHfToken }));

const { installModelAbuseGuard, validatePublicReviewModel } = await import('./modelAbuseGuard.js');

const LOCAL_CLAUDE = {
  id: 'claude-ollama',
  type: 'cli',
  command: 'claude',
  ollamaBacked: true,
  envVars: { ANTHROPIC_BASE_URL: 'http://localhost:11434' },
};

describe('validatePublicReviewModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHfToken.mockResolvedValue('hf_test_token');
    listModels.mockResolvedValue([{ id: 'safe-model' }]);
    getModelCapabilities.mockResolvedValue(['completion']);
  });

  it('accepts only an installed model with explicit tool-free text capability', async () => {
    await expect(validatePublicReviewModel({ provider: LOCAL_CLAUDE, model: 'safe-model' }))
      .resolves.toMatchObject({ ok: true, model: 'safe-model', runtime: 'ollama' });
    expect(listModels).toHaveBeenCalledWith('ollama', true);
    expect(getModelCapabilities).toHaveBeenCalledWith('safe-model');
  });

  it('rejects a model that is not installed or whose capability probe is unknown', async () => {
    await expect(validatePublicReviewModel({ provider: LOCAL_CLAUDE, model: 'missing-model' }))
      .resolves.toMatchObject({ ok: false, code: 'public-review-model-not-installed' });

    listModels.mockResolvedValue([{ id: 'safe-model' }]);
    getModelCapabilities.mockResolvedValue([]);
    await expect(validatePublicReviewModel({ provider: LOCAL_CLAUDE, model: 'safe-model' }))
      .resolves.toMatchObject({ ok: false, code: 'public-review-model-not-tool-free' });
  });

  it('rejects native tool use and non-local or non-maintained providers', async () => {
    getModelCapabilities.mockResolvedValue(['completion', 'tools']);
    await expect(validatePublicReviewModel({ provider: LOCAL_CLAUDE, model: 'safe-model' }))
      .resolves.toMatchObject({ ok: false, code: 'public-review-model-not-tool-free' });

    await expect(validatePublicReviewModel({
      provider: { ...LOCAL_CLAUDE, envVars: { ANTHROPIC_BASE_URL: 'https://api.example.com' } },
      model: 'safe-model',
    })).resolves.toMatchObject({ ok: false, code: 'public-review-provider-unsupported' });
  });

  it('rejects missing model selection and an unavailable catalog', async () => {
    await expect(validatePublicReviewModel({ provider: LOCAL_CLAUDE, model: '' }))
      .resolves.toMatchObject({ ok: false, code: 'public-review-model-required' });
    expect(listModels).not.toHaveBeenCalled();

    listModels.mockResolvedValue(null);
    await expect(validatePublicReviewModel({ provider: LOCAL_CLAUDE, model: 'safe-model' }))
      .resolves.toMatchObject({ ok: false, code: 'public-review-model-catalog-unavailable' });
  });

  it('requires the Hugging Face token before preparing the guard runtime', async () => {
    getHfToken.mockResolvedValue(null);

    await expect(installModelAbuseGuard()).resolves.toMatchObject({
      ok: false,
      code: 'security-guard-huggingface-token-required',
    });
  });
});
