import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, utimes, writeFile } from 'fs/promises';
import { join } from 'path';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

describe('browserService config persistence', () => {
  let tempRoot;

  beforeEach(() => {
    vi.resetModules();
    tempRoot = createTempDataRoot('portos-browser-service-');
  });

  afterEach(async () => {
    vi.doUnmock('../lib/fileUtils.js');
    await rm(tempRoot, { recursive: true, force: true });
  });

  async function importService() {
    vi.doMock('../lib/fileUtils.js', async (importOriginal) => {
      const actual = await importOriginal();
      return makePathsProxy(actual, {
        dataRoot: tempRoot,
        extraOverrides: (root) => ({
          browserProfile: join(root, 'browser-profile'),
          browserDownloads: join(root, 'downloads'),
        }),
      });
    });
    return import('./browserService.js');
  }

  it('atomically saves normalized config with a derived macOS app bundle', async () => {
    const service = await importService();
    const saved = await service.saveConfig({
      chromePath: '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    });

    expect(saved.macAppBundle).toBe('/Applications/Google Chrome Canary.app');
    const onDisk = JSON.parse(await readFile(join(tempRoot, 'browser-config.json'), 'utf-8'));
    expect(onDisk.macAppBundle).toBe('/Applications/Google Chrome Canary.app');
  });

  it('reloads config after the setup script writes browser-config.json directly', async () => {
    const service = await importService();
    await service.saveConfig({ cdpPort: 5556 });
    await mkdir(tempRoot, { recursive: true });
    const configPath = join(tempRoot, 'browser-config.json');
    await writeFile(configPath, JSON.stringify({ cdpPort: 6000, headless: false }));
    const later = new Date(Date.now() + 1000);
    await utimes(configPath, later, later);

    const reloaded = await service.getConfig();
    expect(reloaded.cdpPort).toBe(6000);
    expect(reloaded.headless).toBe(false);
  });
});
