import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/pathSafety.js', () => ({
  resolveGalleryImage: vi.fn((f) => `/fake/data/images/${f}`),
}));

vi.mock('./imageGen/local.js', () => ({
  assertGalleryFilename: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
}));

vi.mock('./settings.js', () => {
  let settingsState = {
    imageVerification: {
      enabledForGeneration: true,
      enabledForImport: true,
      defaultProfileId: 'strict_anatomy',
      maxRerolls: 2,
      customProfiles: [],
    },
  };
  return {
    getSettings: vi.fn(async () => settingsState),
    saveSettings: vi.fn(async (s) => { settingsState = s; }),
  };
});

vi.mock('./imageGen/sidecarStore.js', () => ({
  editImageSidecar: vi.fn(async (filename, mutate) => {
    const meta = {};
    return mutate(meta);
  }),
}));

vi.mock('./musicVideo/plateReview.js', () => ({
  resolvePlateReviewer: vi.fn(async () => ({
    provider: { id: 'mock-vision', name: 'Mock Vision' },
    model: 'mock-model-1',
  })),
}));

vi.mock('./provider/providers.js', () => ({
  getAllProviders: vi.fn(async () => ({
    providers: [
      { id: 'antigravity-cli', name: 'Antigravity CLI', enabled: true, models: ['antigravity-configured-default', 'gemini-4-argon-medium', 'gemini-4-argon-high'] },
      { id: 'ollama-local', name: 'Ollama', enabled: true, type: 'ollama', ollamaBacked: true, models: ['qwen3.8:27b', 'llama3'] },
    ],
  })),
  getProviderById: vi.fn(async (id) => {
    if (id === 'antigravity-cli') {
      return { id: 'antigravity-cli', name: 'Antigravity CLI', enabled: true, models: ['antigravity-configured-default', 'gemini-4-argon-medium', 'gemini-4-argon-high'] };
    }
    return null;
  }),
}));

vi.mock('./promptRunner.js', () => ({
  resolveEffectiveModel: vi.fn((provider, model) => model || provider.defaultModel || provider.models?.[0]),
  runPromptThroughProvider: vi.fn(async ({ prompt }) => {
    if (prompt.includes('Automated first looks frequently hallucinate')) {
      // Pass 2 confirmation reply
      return {
        text: JSON.stringify({ verdicts: [{ index: 0, confirmed: true, region: 'lower-right', note: 'Polydactyly confirmed' }] }),
        model: 'mock-model-1',
      };
    }
    // Pass 1 multi-aspect reply
    return {
      text: JSON.stringify({
        hands: [
          { location: 'right hand', visibleDigits: 6, anomalies: 'extra finger', status: 'fail' },
        ],
        checks: [
          { dimension: 'hands_and_fingers', status: 'fail', severity: 'critical', claim: '6 digits', region: 'lower-right' },
          { dimension: 'spurious_limbs', status: 'pass', severity: 'critical' },
        ],
        overallVerdict: 'fail',
        summary: 'Detected 6 fingers on right hand',
      }),
      model: 'mock-model-1',
    };
  }),
  assertVisionRunUsedImages: vi.fn(),
}));

import {
  getVerifierSettings,
  getVerificationProfiles,
  getVerificationProfile,
  verifyImage,
  overrideVerification,
} from './imageVerifier.js';
import { runPromptThroughProvider } from './promptRunner.js';
import { getSettings, saveSettings } from './settings.js';
import { MAX_CONFIRMATION_DEFECTS } from '../lib/imageVerification.js';

describe('imageVerifier service settings and profiles', () => {
  it('reads verifier settings with defaults', async () => {
    const s = await getVerifierSettings();
    expect(s.enabledForGeneration).toBe(true);
    expect(s.enabledForImport).toBe(true);
    expect(s.defaultProfileId).toBe('strict_anatomy');
    expect(s.maxRerolls).toBe(2);
  });

  it('lists built-in verification profiles', async () => {
    const profiles = await getVerificationProfiles();
    expect(profiles).toHaveProperty('strict_anatomy');
    expect(profiles).toHaveProperty('composition_and_text');
    expect(profiles).toHaveProperty('full_audit');
    expect(profiles).toHaveProperty('quick_screen');
  });

  it('resolves a custom profile stored in settings by an earlier install', async () => {
    const before = await getSettings();
    await saveSettings({ ...before, imageVerification: { ...before.imageVerification, customProfiles: [{ id: 'custom_portrait', name: 'Custom Portrait' }] } });
    try {
      expect((await getVerificationProfile('custom_portrait')).name).toBe('Custom Portrait');
      expect(await getVerificationProfile('unknown_profile')).toMatchObject({ id: 'strict_anatomy' });
    } finally {
      await saveSettings(before);
    }
  });
});

describe('verifyImage execution', () => {
  beforeEach(() => { runPromptThroughProvider.mockClear(); });

  it('batches all confirmation work into one call and reconciles claims by index', async () => {
    const checks = Array.from({ length: MAX_CONFIRMATION_DEFECTS + 1 }, (_, index) => ({
      dimension: 'hands_and_fingers',
      status: 'fail',
      severity: 'critical',
      claim: `Claim ${index}`,
      region: 'lower-left',
    }));
    runPromptThroughProvider
      .mockResolvedValueOnce({ text: JSON.stringify({ checks }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ verdicts: [
        { index: 2, confirmed: false },
        { index: 0, confirmed: true, region: 'upper right', note: 'Extra digit visible' },
        { index: 3, confirmed: 'true' },
        { index: MAX_CONFIRMATION_DEFECTS, confirmed: true },
      ] }) });
    const beforeExecute = vi.fn();
    const result = await verifyImage({ filename: 'sample.png', prompt: 'A person waving', beforeExecute });

    expect(runPromptThroughProvider).toHaveBeenCalledTimes(2);
    expect(runPromptThroughProvider).toHaveBeenNthCalledWith(2, expect.objectContaining({
      screenshots: ['/fake/data/images/sample.png'],
      source: 'image-verifier-confirmation',
      allowFallback: false,
      beforeExecute,
    }));
    expect(result.verdict).toBe('fail');
    expect(result.defects).toMatchObject([
      { claim: 'Claim 0', confirmed: true, region: 'upper right', confirmationNote: 'Extra digit visible' },
    ]);
    expect(result.checks.map(({ status }) => status)).toEqual([
      'fail', ...Array(MAX_CONFIRMATION_DEFECTS).fill('unverified'),
    ]);
  });

  it('skips confirmation when the initial scan passes', async () => {
    runPromptThroughProvider.mockResolvedValueOnce({ text: '{"overallVerdict":"pass"}' });
    const result = await verifyImage({ filename: 'sample.png' });
    expect(runPromptThroughProvider).toHaveBeenCalledTimes(1);
    expect(result.verdict).toBe('pass');
    expect(result.defects).toEqual([]);
  });

  it('demotes a critical claim when the confirmation response is malformed', async () => {
    runPromptThroughProvider.mockResolvedValueOnce({
      text: JSON.stringify({ checks: [{ dimension: 'hands_and_fingers', status: 'fail', claim: 'Extra finger' }] }),
    }).mockResolvedValueOnce({ text: 'No structured verdict' });
    const result = await verifyImage({ filename: 'sample.png' });
    expect(result.verdict).toBe('pass');
    expect(result.defects).toEqual([]);
    expect(result.checks).toMatchObject([{ status: 'unverified', note: 'Unconfirmed defect claim: Extra finger' }]);
  });

  it.each([
    ['the default reviewer', undefined, 1],
    ['an advisory reviewer', { model: 'qwen-27b' }, 0],
  ])('preserves the provider failure fallback for %s', async (_name, reviewer, remainingDefects) => {
    runPromptThroughProvider.mockResolvedValueOnce({
      text: JSON.stringify({ checks: [{ dimension: 'hands_and_fingers', status: 'fail', claim: 'Extra finger' }] }),
    }).mockRejectedValueOnce(new Error('reviewer failed'));
    const result = await verifyImage({ filename: 'sample.png', reviewer });
    expect(runPromptThroughProvider).toHaveBeenCalledTimes(2);
    expect(result.verdict).toBe('fail');
    expect(result.defects).toHaveLength(remainingDefects);
    expect(result.checks).toMatchObject([{ status: 'fail' }]);
  });

  it('supports operator override', async () => {
    const overridden = await overrideVerification({
      filename: 'sample.png',
      verdict: 'pass',
      notes: 'Stylized glove, not polydactyly',
      operator: 'admin',
    });

    expect(overridden.verdict).toBe('pass');
    expect(overridden.overridden).toBe(true);
    expect(overridden.overrideNotes).toBe('Stylized glove, not polydactyly');
  });
});

describe('verifyImage model routing', () => {
  beforeEach(() => { runPromptThroughProvider.mockClear(); });

  it('routes gemini-4-argon to antigravity-cli provider', async () => {
    await verifyImage({ filename: 'sample.png', reviewer: { model: 'gemini-4-argon' } });
    expect(runPromptThroughProvider).toHaveBeenCalledWith(expect.objectContaining({
      provider: expect.objectContaining({ id: 'antigravity-cli' }),
      model: 'gemini-4-argon-medium',
    }));
  });

  it('routes qwen-27b to matching Ollama provider', async () => {
    await verifyImage({ filename: 'sample.png', reviewer: { model: 'qwen-27b' } });
    expect(runPromptThroughProvider).toHaveBeenCalledWith(expect.objectContaining({
      provider: expect.objectContaining({ id: 'ollama-local' }),
      model: 'qwen3.8:27b',
    }));
  });
});
