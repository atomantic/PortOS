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

vi.mock('./providers.js', () => ({
  getAllProviders: vi.fn(async () => ({
    providers: [
      { id: 'antigravity-cli', name: 'Antigravity CLI', enabled: true, models: ['antigravity-configured-default', 'gemini-4-argon-medium', 'gemini-4-argon-high'] },
      { id: 'ollama-local', name: 'Ollama', enabled: true, type: 'ollama', models: ['qwen3.8:27b', 'llama3'] },
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
        text: JSON.stringify({ confirmed: true, region: 'lower-right', note: 'Polydactyly confirmed' }),
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
  updateVerifierSettings,
  getVerificationProfiles,
  getVerificationProfile,
  saveCustomProfile,
  deleteCustomProfile,
  verifyImage,
  overrideVerification,
  resolveVisionReviewer,
} from './imageVerifier.js';

describe('imageVerifier service settings and profiles', () => {
  it('reads verifier settings with defaults', async () => {
    const s = await getVerifierSettings();
    expect(s.enabledForGeneration).toBe(true);
    expect(s.enabledForImport).toBe(true);
    expect(s.defaultProfileId).toBe('strict_anatomy');
    expect(s.maxRerolls).toBe(2);
  });

  it('updates verifier settings', async () => {
    const updated = await updateVerifierSettings({ maxRerolls: 3 });
    expect(updated.maxRerolls).toBe(3);
  });

  it('lists built-in verification profiles', async () => {
    const profiles = await getVerificationProfiles();
    expect(profiles).toHaveProperty('strict_anatomy');
    expect(profiles).toHaveProperty('composition_and_text');
    expect(profiles).toHaveProperty('full_audit');
    expect(profiles).toHaveProperty('quick_screen');
  });

  it('saves and deletes custom profiles', async () => {
    const custom = {
      id: 'custom_portrait',
      name: 'Custom Portrait',
      description: 'My custom profile',
      dimensions: {
        hands_and_fingers: { enabled: true, severity: 'critical' },
      },
      generationPolicy: { actionOnFail: 'reroll', maxRerolls: 1 },
      importPolicy: { actionOnFail: 'flag' },
    };

    const saved = await saveCustomProfile(custom);
    expect(saved.id).toBe('custom_portrait');

    const fetched = await getVerificationProfile('custom_portrait');
    expect(fetched.name).toBe('Custom Portrait');

    const del = await deleteCustomProfile('custom_portrait');
    expect(del.deleted).toBe(true);
  });

  it('refuses to delete built-in profile', async () => {
    await expect(deleteCustomProfile('strict_anatomy')).rejects.toThrow('Cannot delete built-in profile');
  });
});

describe('verifyImage execution', () => {
  it('runs Pass 1 and Pass 2 confirmation to evaluate defects', async () => {
    const result = await verifyImage({
      filename: 'sample.png',
      prompt: 'A man waving hand',
    });

    expect(result.verdict).toBe('fail');
    expect(result.defects).toHaveLength(1);
    expect(result.defects[0].dimension).toBe('hands_and_fingers');
    expect(result.defects[0].confirmed).toBe(true);
    expect(result.reviewer.providerId).toBe('mock-vision');
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

describe('resolveVisionReviewer model routing', () => {
  it('routes gemini-4-argon to antigravity-cli provider', async () => {
    const reviewer = await resolveVisionReviewer({ model: 'gemini-4-argon' });
    expect(reviewer.provider.id).toBe('antigravity-cli');
    expect(reviewer.model).toBe('gemini-4-argon-medium');
  });

  it('routes qwen-27b to matching Ollama provider', async () => {
    const reviewer = await resolveVisionReviewer({ model: 'qwen-27b' });
    expect(reviewer.provider.id).toBe('ollama-local');
    expect(reviewer.model).toBe('qwen3.8:27b');
  });
});
