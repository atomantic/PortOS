import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetSettings, mockTryReadFile } = vi.hoisted(() => ({
  mockGetSettings: vi.fn(),
  mockTryReadFile: vi.fn(),
}));

vi.mock('../services/settings.js', () => ({ getSettings: mockGetSettings }));
vi.mock('./fileUtils.js', () => ({ tryReadFile: mockTryReadFile }));

import { hfChildEnv } from './hfToken.js';

const TOKEN_ENV_KEYS = ['HF_TOKEN', 'HUGGINGFACE_HUB_TOKEN', 'HUGGINGFACEHUB_API_TOKEN'];

describe('hfChildEnv', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = Object.fromEntries(['PATH', ...TOKEN_ENV_KEYS].map((key) => [key, process.env[key]]));
    process.env.PATH = '/portos/test-path';
    for (const key of TOKEN_ENV_KEYS) delete process.env[key];
    mockGetSettings.mockResolvedValue({ imageGen: {} });
    mockTryReadFile.mockResolvedValue(null);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('preserves PATH when no Hugging Face token resolves', async () => {
    const env = await hfChildEnv();

    expect(env.PATH).toBe('/portos/test-path');
    for (const key of TOKEN_ENV_KEYS) expect(env[key]).toBeUndefined();
  });

  it('merges explicit child overrides after the resolved token environment', async () => {
    const env = await hfChildEnv({ PYTHONUNBUFFERED: '1' });

    expect(env.PATH).toBe('/portos/test-path');
    expect(env.PYTHONUNBUFFERED).toBe('1');
  });
});
