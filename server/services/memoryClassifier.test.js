import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as path from 'path';

describe('memoryClassifier — config env-derived defaults', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'memory-classifier-test-'));
    // Mock PATHS.data to point to our temp directory
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('honors LM_STUDIO_URL env var when no config file exists', async () => {
    const customLmStudioUrl = 'http://192.168.1.100:1234';
    const oldLmStudioUrl = process.env.LM_STUDIO_URL;

    try {
      process.env.LM_STUDIO_URL = customLmStudioUrl;

      // Dynamically import with the env var set
      const module = await import('./memoryClassifier.js');
      const DEFAULT_CONFIG = module.DEFAULT_CONFIG;

      // The endpoint should be derived from LM_STUDIO_URL
      const expectedEndpoint = `${customLmStudioUrl}/v1/chat/completions`;
      expect(DEFAULT_CONFIG.endpoint).toBe(expectedEndpoint);
    } finally {
      if (oldLmStudioUrl) {
        process.env.LM_STUDIO_URL = oldLmStudioUrl;
      } else {
        delete process.env.LM_STUDIO_URL;
      }
    }
  });

  it('uses default endpoint when LM_STUDIO_URL is not set', async () => {
    const oldLmStudioUrl = process.env.LM_STUDIO_URL;

    try {
      delete process.env.LM_STUDIO_URL;

      // Dynamically import with no env var
      const module = await import('./memoryClassifier.js');
      const DEFAULT_CONFIG = module.DEFAULT_CONFIG;

      expect(DEFAULT_CONFIG.endpoint).toBe('http://localhost:1234/v1/chat/completions');
    } finally {
      if (oldLmStudioUrl) {
        process.env.LM_STUDIO_URL = oldLmStudioUrl;
      }
    }
  });

  it('strips trailing slashes and /v1 from LM_STUDIO_URL', async () => {
    const oldLmStudioUrl = process.env.LM_STUDIO_URL;

    try {
      process.env.LM_STUDIO_URL = 'http://192.168.1.100:1234/v1/';

      // Force re-evaluation by dynamic import
      const module = await import('./memoryClassifier.js');
      const DEFAULT_CONFIG = module.DEFAULT_CONFIG;

      expect(DEFAULT_CONFIG.endpoint).toBe('http://192.168.1.100:1234/v1/chat/completions');
    } finally {
      if (oldLmStudioUrl) {
        process.env.LM_STUDIO_URL = oldLmStudioUrl;
      } else {
        delete process.env.LM_STUDIO_URL;
      }
    }
  });
});
