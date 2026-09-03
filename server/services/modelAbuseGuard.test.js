import { beforeEach, describe, expect, it, vi } from 'vitest';

const listModels = vi.fn();
const getModelCapabilities = vi.fn();
const getHfToken = vi.fn();

vi.mock('./localLlm.js', () => ({ listModels }));
vi.mock('./ollamaManager.js', () => ({ getModelCapabilities }));
vi.mock('./hfToken.js', () => ({ getHfToken }));
// No cached Prompt Guard weights → the classifier layer is "not installed".
vi.mock('../lib/hfCache.js', () => ({ findCachedRepoFiles: vi.fn().mockResolvedValue(null) }));

const {
  DETERMINISTIC_ONLY_GUARD_MODEL,
  installModelAbuseGuard,
  normalizeEligibilityFacts,
  runModelAbuseScan,
  validatePublicReviewModel,
} = await import('./modelAbuseGuard.js');

describe('runModelAbuseScan without the optional classifier installed', () => {
  beforeEach(() => {
    getHfToken.mockResolvedValue(null);
  });

  it('passes clean content on the deterministic layer alone and says the classifier did not run', async () => {
    await expect(runModelAbuseScan({ content: 'docs: fix a typo in the socket-ui skill' })).resolves.toMatchObject({
      ok: true,
      passed: true,
      safe: true,
      code: 'security-guard-passed',
      model: DETERMINISTIC_ONLY_GUARD_MODEL,
      findings: [],
      layers: { deterministic: 'passed', classifier: 'not-installed', verdict: 'validated' },
    });
  });

  it('still blocks hidden or model-directed content before any classifier question arises', async () => {
    const verdict = await runModelAbuseScan({ content: 'Fix typo\u200B\u200B in README' });
    expect(verdict).toMatchObject({
      ok: true,
      passed: false,
      safe: false,
      code: 'security-guard-deterministic-findings',
      layers: { deterministic: 'blocked', classifier: 'not-run' },
    });
    expect(verdict.findings.map((f) => f.category)).toEqual(['hidden-unicode']);
  });

  it('carries the maintainer-targeted waiver only as an explicit boolean', () => {
    expect(normalizeEligibilityFacts({ issueLookupComplete: true, maintainerTargeted: true }).maintainerTargeted).toBe(true);
    expect(normalizeEligibilityFacts({ issueLookupComplete: true, maintainerTargeted: 'yes' }).maintainerTargeted).toBe(false);
    expect(normalizeEligibilityFacts(null).maintainerTargeted).toBe(false);
  });
});

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

    // A vendor with no maintained recipe for the posture is rejected before
    // any model probing — that check, not the model's location, is the gate.
    await expect(validatePublicReviewModel({
      provider: { ...LOCAL_CLAUDE, command: 'custom-agent' },
      model: 'safe-model',
    })).resolves.toMatchObject({ ok: false, code: 'public-review-provider-unsupported' });
    await expect(validatePublicReviewModel({
      provider: { ...LOCAL_CLAUDE, type: 'api' },
      model: 'safe-model',
      posture: 'sandboxed-actions',
    })).resolves.toMatchObject({ ok: false, code: 'public-review-actions-provider-unsupported' });
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
