import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// With no shipped seed (#8444), an install without data/memory-classifier-config.json
// must get the endpoint derived from LM_STUDIO_URL rather than a hard-coded localhost.
describe('memoryClassifier getConfig — env-derived endpoint', () => {
  let tempDir;
  let oldLmStudioUrl;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'memory-classifier-test-'));
    oldLmStudioUrl = process.env.LM_STUDIO_URL;
    vi.resetModules();
    vi.doMock('../lib/fileUtils.js', async () => {
      const actual = await vi.importActual('../lib/fileUtils.js');
      return { ...actual, PATHS: { ...actual.PATHS, data: tempDir } };
    });
  });

  afterEach(() => {
    vi.doUnmock('../lib/fileUtils.js');
    vi.resetModules();
    if (oldLmStudioUrl === undefined) delete process.env.LM_STUDIO_URL;
    else process.env.LM_STUDIO_URL = oldLmStudioUrl;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses LM_STUDIO_URL when no config file exists', async () => {
    process.env.LM_STUDIO_URL = 'http://192.0.2.10:1234/v1/';
    const { getConfig } = await import('./memoryClassifier.js');
    const config = await getConfig();
    expect(config.endpoint).toBe('http://192.0.2.10:1234/v1/chat/completions');
  });

  it('falls back to localhost when LM_STUDIO_URL is unset', async () => {
    delete process.env.LM_STUDIO_URL;
    const { getConfig } = await import('./memoryClassifier.js');
    const config = await getConfig();
    expect(config.endpoint).toBe('http://localhost:1234/v1/chat/completions');
  });
});
