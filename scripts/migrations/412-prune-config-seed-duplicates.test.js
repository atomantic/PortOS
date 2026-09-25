import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './412-prune-config-seed-duplicates.js';

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : null);

describe('migration 412 — prune config seeds that duplicate DEFAULT_CONFIG', () => {
  let rootDir;
  let dataDir;
  let memoryConfigPath;
  let browserConfigPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-412-'));
    dataDir = join(rootDir, 'data');
    mkdirSync(dataDir, { recursive: true });
    memoryConfigPath = join(dataDir, 'memory-classifier-config.json');
    browserConfigPath = join(dataDir, 'browser-config.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  describe('memory-classifier-config.json', () => {
    it('removes the file if it contains only seed defaults', async () => {
      writeJson(memoryConfigPath, {
        enabled: true,
        provider: 'lmstudio',
        endpoint: 'http://localhost:1234/v1/chat/completions',
        model: 'gptoss-20b',
        timeout: 60000,
        maxOutputLength: 10000,
        minConfidence: 0.6,
        fallbackToPatterns: true,
      });

      const result = await migration.up({ rootDir });

      expect(result.memoryClassifier).toBe('removed');
      expect(existsSync(memoryConfigPath)).toBe(false);
    });

    it('keeps only customized keys', async () => {
      writeJson(memoryConfigPath, {
        enabled: true,
        provider: 'lmstudio',
        endpoint: 'http://localhost:1234/v1/chat/completions',
        model: 'custom-model', // User changed this
        timeout: 60000,
        maxOutputLength: 10000,
        minConfidence: 0.6,
        fallbackToPatterns: true,
      });

      const result = await migration.up({ rootDir });

      expect(result.memoryClassifier).toContain('pruned');
      expect(readJson(memoryConfigPath)).toEqual({ model: 'custom-model' });
    });

    it('keeps multiple user customizations', async () => {
      writeJson(memoryConfigPath, {
        enabled: false, // User disabled it
        provider: 'ollama', // User changed provider
        endpoint: 'http://localhost:1234/v1/chat/completions',
        model: 'gptoss-20b',
        timeout: 30000, // User reduced timeout
        maxOutputLength: 10000,
        minConfidence: 0.6,
        fallbackToPatterns: false, // User disabled fallback
      });

      const result = await migration.up({ rootDir });

      expect(result.memoryClassifier).toContain('pruned');
      expect(readJson(memoryConfigPath)).toEqual({
        enabled: false,
        provider: 'ollama',
        timeout: 30000,
        fallbackToPatterns: false,
      });
    });

    it('does nothing if file does not exist', async () => {
      const result = await migration.up({ rootDir });

      expect(result.memoryClassifier).toBeNull();
      expect(existsSync(memoryConfigPath)).toBe(false);
    });
  });

  describe('browser-config.json', () => {
    it('removes the file if it contains only seed defaults', async () => {
      writeJson(browserConfigPath, {
        cdpPort: 5556,
        cdpHost: '127.0.0.1',
        healthPort: 5557,
        autoConnect: true,
        headless: false,
        userDataDir: '',
      });

      const result = await migration.up({ rootDir });

      expect(result.browser).toBe('removed');
      expect(existsSync(browserConfigPath)).toBe(false);
    });

    it('keeps only customized keys', async () => {
      writeJson(browserConfigPath, {
        cdpPort: 5556,
        cdpHost: '192.168.1.100', // User changed this
        healthPort: 5557,
        autoConnect: true,
        headless: false,
        userDataDir: '',
      });

      const result = await migration.up({ rootDir });

      expect(result.browser).toContain('pruned');
      expect(readJson(browserConfigPath)).toEqual({ cdpHost: '192.168.1.100' });
    });

    it('keeps multiple user customizations', async () => {
      writeJson(browserConfigPath, {
        cdpPort: 5556,
        cdpHost: '0.0.0.0', // User changed host
        healthPort: 5558, // User changed health port
        autoConnect: false, // User disabled autoConnect
        headless: true, // User enabled headless
        userDataDir: '',
      });

      const result = await migration.up({ rootDir });

      expect(result.browser).toContain('pruned');
      expect(readJson(browserConfigPath)).toEqual({
        cdpHost: '0.0.0.0',
        healthPort: 5558,
        autoConnect: false,
        headless: true,
      });
    });

    it('does nothing if file does not exist', async () => {
      const result = await migration.up({ rootDir });

      expect(result.browser).toBeNull();
      expect(existsSync(browserConfigPath)).toBe(false);
    });
  });

  it('handles both files in the same run', async () => {
    // Both files with seed values + one user change each
    writeJson(memoryConfigPath, {
      enabled: true,
      provider: 'lmstudio',
      endpoint: 'http://localhost:1234/v1/chat/completions',
      model: 'custom-llm',
      timeout: 60000,
      maxOutputLength: 10000,
      minConfidence: 0.6,
      fallbackToPatterns: true,
    });

    writeJson(browserConfigPath, {
      cdpPort: 5556,
      cdpHost: 'custom-host',
      healthPort: 5557,
      autoConnect: true,
      headless: false,
      userDataDir: '',
    });

    const result = await migration.up({ rootDir });

    expect(result.memoryClassifier).toContain('pruned');
    expect(result.browser).toContain('pruned');
    expect(readJson(memoryConfigPath)).toEqual({ model: 'custom-llm' });
    expect(readJson(browserConfigPath)).toEqual({ cdpHost: 'custom-host' });
  });
});
